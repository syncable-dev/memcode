import type { Project } from "../src/shared";
import type { MemtraceEngine } from "./memtrace";
import { verifiedIndexRevision } from "./memtrace-peer-index";

type Engine = Pick<
  MemtraceEngine,
  "releaseEpic" | "analyze" | "watch" | "call"
>;
type Json = Record<string, any>;
const record = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2000;
const pathKey = (value: string) => {
  const key = value
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/$/, "");
  return process.platform === "win32" ? key.toLowerCase() : key;
};
function graph(value: Json): Json | undefined {
  const candidate =
    record(value._meta) && Object.hasOwn(value._meta, "graph_revision")
      ? value._meta.graph_revision
      : value.graph_revision;
  return record(candidate) ? candidate : undefined;
}
function exactSource(value: Json, project: Project, repoId: string): boolean {
  return (
    value.checkout_mode === "owned-worktree-v1" &&
    value.graph_scope === "owned_worktree_graph" &&
    value.repo_id === repoId &&
    text(value.worktree) &&
    pathKey(value.worktree) === pathKey(project.path!) &&
    value.branch === project.branch &&
    value.default_branch_matches === true &&
    value.source_unchanged_during_observation === true &&
    value.requested_revision_matches !== false &&
    value.requested_source_matches !== false &&
    value.retry_query_group === false &&
    text(value.source_revision) &&
    text(value.indexing_revision) &&
    text(value.token) &&
    value.mismatched_files === 0 &&
    Array.isArray(value.mismatched_paths) &&
    value.mismatched_paths.length === 0 &&
    value.ambiguous_indexed_files === false &&
    Number.isSafeInteger(value.source_file_count) &&
    value.source_file_count >= 0 &&
    value.indexed_file_count === value.source_file_count &&
    value.error === undefined &&
    value._error === undefined &&
    value.error_code === undefined &&
    value.message === undefined &&
    (value.reason === undefined || value.reason === "")
  );
}
function publication(value: Json, status: "published" | "partial"): boolean {
  const boundary = graph(value);
  return (
    record(value.publication) &&
    value.publication.status === status &&
    text(value.publication.token) &&
    boundary?.token === value.publication.token &&
    boundary.publication_unchanged_during_call === (status === "published") &&
    (boundary.status === undefined || boundary.status === status)
  );
}
function ready(value: Json, project: Project, repoId: string): boolean {
  return (
    verifiedIndexRevision(value, project, repoId) &&
    exactSource(value, project, repoId) &&
    value.status === "complete" &&
    publication(value, "published")
  );
}

/** A native before/after envelope is a reason to read again, never a certificate. */
function publicationTransition(value: Json): boolean {
  const boundary = graph(value);
  const observation = (part: unknown): part is Json =>
    record(part) &&
    Object.keys(part).every((key) => ["status", "token"].includes(key)) &&
    ["partial", "published"].includes(part.status) &&
    text(part.token);
  if (
    !boundary ||
    boundary.publication_unchanged_during_call !== false ||
    !Object.keys(boundary).every((key) =>
      ["before", "after", "publication_unchanged_during_call"].includes(key),
    ) ||
    !observation(boundary.before) ||
    !observation(boundary.after) ||
    boundary.before.token === boundary.after.token ||
    value._meta?.stale !== true ||
    !record(value.publication) ||
    !["partial", "published"].includes(value.publication.status) ||
    !text(value.publication.token)
  )
    return false;
  const bodyMatchesBoundary = [boundary.before, boundary.after].some(
    (part) =>
      part.token === value.publication.token &&
      part.status === value.publication.status,
  );
  return (
    bodyMatchesBoundary &&
    ((value.ready === true &&
      value.status === "complete" &&
      value.publication.status === "published") ||
      (value.ready === false && value.status === "partial"))
  );
}

/** Repair the current owner only; never retire/reopen a graph inside a read group. */
export async function repairReviewPublication(
  engine: Engine,
  project: Project,
  update: (note: string) => void,
  assertActive: () => void = () => {},
  expectedSourceRevision?: string,
): Promise<Project> {
  if (project.analysisCheckout !== "owned-worktree-v1") return project;
  assertActive();
  let repoId = project.repoId;
  if (!text(repoId))
    throw Error(
      "Analyze this epic's exact source before repairing its review publication.",
    );
  let selected: Project = { ...project };
  let sourceRevision = expectedSourceRevision,
    freshReads = 0,
    repairStarted = false;
  const unverifiedAfterRepair =
    "The epic's graph publication is still unverified after one incremental refresh, or its source changed. Retry review after checking its code context.";
  const inspect = async (): Promise<Json> => {
    assertActive();
    const watch = await engine.watch(selected, repoId);
    assertActive();
    if (
      !watch ||
      watch.state !== "watching" ||
      watch.repoId !== repoId ||
      watch.branch !== selected.branch ||
      pathKey(watch.path) !== pathKey(selected.path!)
    )
      throw Error(
        "The epic's local watch could not be verified. Retry review after checking its code context.",
      );
    const read = async (): Promise<Json> => {
      assertActive();
      const value: unknown = await engine.call(selected, "get_query_revision", {
        repo_id: repoId,
        branch: selected.branch,
        wait_ms: 1000,
      });
      assertActive();
      if (!record(value))
        throw Error(
          "Memtrace returned an unrecognized review publication certificate.",
        );
      if (
        sourceRevision !== undefined &&
        value.source_revision !== sourceRevision
      )
        throw Error(
          repairStarted
            ? unverifiedAfterRepair
            : "The epic's source changed before publication recovery. Its result was not adopted.",
        );
      if (text(value.source_revision)) sourceRevision ??= value.source_revision;
      return value;
    };
    let value = await read();
    while (
      freshReads < 3 &&
      exactSource(value, selected, repoId) &&
      publicationTransition(value)
    ) {
      freshReads++;
      update("Waiting for one stable graph publication observation…");
      value = await read();
    }
    return value;
  };
  const before = await inspect();
  if (
    expectedSourceRevision !== undefined &&
    before.source_revision !== expectedSourceRevision
  )
    throw Error(
      "The epic's source changed before publication recovery. Its result was not adopted.",
    );
  if (ready(before, selected, repoId)) return selected;
  if (!(
    exactSource(before, selected, repoId) &&
    before.ready === false &&
    before.status === "partial" &&
    publication(before, "partial")
  ))
    throw Error(
      "Memtrace could not verify this epic's exact source and graph publication. No automatic repair was attempted; check its code context before reviewing.",
    );

  assertActive();
  update(
    "Completing this epic's graph publication with one incremental refresh…",
  );
  // This flag bypasses MemCode's cached-current shortcut. MemtraceEngine.index
  // still passes incremental: !!match and never asks to clear the existing store.
  repairStarted = true;
  repoId = await engine.analyze(selected, update, true);
  assertActive();
  if (repoId !== selected.repoId)
    throw Error(
      "Memtrace changed repository identity during publication repair. Its result was not adopted.",
    );
  selected = { ...selected, repoId };
  const after = await inspect();
  if (
    !ready(after, selected, repoId) ||
    after.source_revision !== before.source_revision
  )
    throw Error(unverifiedAfterRepair);
  return selected;
}

/** Reopen a private epic cache, then verify/repair its joined watch publication. */
export async function prepareReviewAnalysis(
  engine: Engine,
  project: Project,
  update: (note: string) => void,
  assertActive: () => void = () => {},
): Promise<Project> {
  if (project.analysisCheckout !== "owned-worktree-v1") return project;
  assertActive();
  await engine.releaseEpic(project);
  assertActive();
  const repoId = await engine.analyze(project, update);
  assertActive();
  return repairReviewPublication(
    engine,
    { ...project, repoId, analysis: "ready" },
    update,
    assertActive,
  );
}
