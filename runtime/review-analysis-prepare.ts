import type { Project } from "../src/shared";
import type { MemtraceEngine } from "./memtrace";
import { exactRevisionSource, verifiedIndexRevision, verifyingSourceRevision } from "./memtrace-peer-index";

type Engine = Pick<
  MemtraceEngine,
  "releaseEpic" | "analyze" | "watch" | "call"
> &
  Partial<Pick<MemtraceEngine, "activateEpic">>;
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
function matchesSourceObservation(
  value: Json,
  project: Project,
  repoId: string,
  capturedPaths: readonly string[] = [],
): boolean {
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
    Array.isArray(value.mismatched_paths) &&
    value.mismatched_files === value.mismatched_paths.length &&
    new Set(value.mismatched_paths).size === value.mismatched_files &&
    value.mismatched_paths.every(
      (path: unknown) =>
        typeof path === "string" && capturedPaths.includes(path),
    ) &&
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
// The native branch overlay can report the checkout digest before it has an
// index token or file inventory. This is a recovery hint, never review evidence.
const pendingBranchFields = new Set([
  "_meta",
  "repo_id",
  "branch",
  "worktree",
  "checkout_mode",
  "graph_scope",
  "ready",
  "status",
  "reason",
  "source_commit",
  "source_revision",
  "token",
  "indexing_revision",
  "requested_source_matches",
  "requested_revision_matches",
  "retry_query_group",
]);
function pendingBranchSource(
  value: Json,
  project: Project,
  repoId: string,
): boolean {
  return (
    exactRevisionSource(value, project, repoId) &&
    value.ready === false &&
    value.status === "partial" &&
    value.reason === "branch_publication_incomplete" &&
    text(value.source_commit) &&
    text(value.source_revision) &&
    value.requested_source_matches === true &&
    value.requested_revision_matches === true &&
    value.retry_query_group === false &&
    value.indexing_revision === null &&
    value.token === null &&
    Object.keys(value).every((key) => pendingBranchFields.has(key))
  );
}
function pendingBranchBoundary(value: Json): boolean {
  const boundary = graph(value);
  return (
    !!boundary &&
    value._meta?.stale !== true &&
    boundary.status === "partial" &&
    text(boundary.token) &&
    boundary.publication_unchanged_during_call === false &&
    Object.keys(boundary).every((key) =>
      ["token", "status", "publication_unchanged_during_call"].includes(key),
    )
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
    matchesSourceObservation(value, project, repoId) &&
    value.status === "complete" &&
    publication(value, "published")
  );
}

/** A native before/after envelope is a reason to read again, never a certificate. */
function movingPublicationBoundary(value: Json): Json | undefined {
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
    value._meta?.stale !== true
  )
    return undefined;
  return boundary;
}

export function reviewPublicationTransition(value: Json): boolean {
  const boundary = movingPublicationBoundary(value);
  if (
    !boundary ||
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
  capturedPaths: readonly string[] = [],
  guard?: { signal: AbortSignal; beforeIndex: (repoId?: string) => Promise<void> },
): Promise<Project> {
  if (project.analysisCheckout !== "owned-worktree-v1") return project;
  assertActive();
  const repoId = project.repoId;
  if (!text(repoId))
    throw Error(
      "Analyze this epic's exact source before repairing its review publication.",
    );
  const selected: Project = { ...project };
  let sourceRevision = expectedSourceRevision,
    freshReads = 0,
    repairStarted = false;
  const unverifiedAfterRepair =
    "The epic's graph publication is still unverified after one incremental refresh, or its source changed. Retry review after checking its code context.";
  const inspect = async (confirmWorkerEdit = false): Promise<Json> => {
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
      }, guard?.signal);
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
    const deadline = Date.now() + 180000;
    let delay = 250;
    while (
      Date.now() < deadline &&
      value.repo_id === repoId &&
      value.branch === selected.branch &&
      text(value.worktree) &&
      pathKey(value.worktree) === pathKey(selected.path!) &&
      value.ready === false &&
      ([
        "index_write_in_progress",
        "indexing_in_progress",
        "graph_materialization_in_progress",
      ].includes(value.reason) ||
        (!!verifyingSourceRevision(value, selected, repoId) &&
          (value.reason !== "branch_publication_incomplete" || !capturedPaths.length)))
    ) {
      update(
        "Memtrace is verifying this epic's existing graph. Review will continue automatically…",
      );
      await new Promise((done) => setTimeout(done, delay));
      delay = Math.min(3000, delay * 2);
      value = await read();
    }
    while (
      freshReads < 3 &&
      ((matchesSourceObservation(value, selected, repoId, capturedPaths) &&
        reviewPublicationTransition(value)) ||
        (confirmWorkerEdit &&
          pendingBranchSource(value, selected, repoId) &&
          movingPublicationBoundary(value)))
    ) {
      freshReads++;
      update("Waiting for one stable graph publication observation…");
      // An active native writer can return several envelopes in milliseconds.
      // Space the three worker-edit observations by 1, 2 and 4 seconds.
      if (capturedPaths.length)
        await new Promise((done) => setTimeout(done, 1000 * 2 ** (freshReads - 1)));
      value = await read();
    }
    return value;
  };
  const capturedFilesLag = (value: Json) =>
    value.ready === false &&
    value.status === "partial" &&
    value.mismatched_files > 0 &&
    value.requested_source_matches === true &&
    value.requested_revision_matches === true &&
    value._meta?.stale !== true &&
    matchesSourceObservation(value, selected, repoId, capturedPaths) &&
    (publication(value, "partial") || publication(value, "published"));
  let before = await inspect();
  let confirmedWorkerEdit = false;
  if (
    capturedPaths.length &&
    (pendingBranchSource(before, selected, repoId) || capturedFilesLag(before))
  ) {
    // A pending branch view or a lagging file from the captured patch may
    // justify a refresh. Pin the source digest across independent reads.
    before = await inspect(true);
    confirmedWorkerEdit =
      capturedFilesLag(before) ||
      (pendingBranchSource(before, selected, repoId) &&
        pendingBranchBoundary(before));
  }
  if (
    expectedSourceRevision !== undefined &&
    before.source_revision !== expectedSourceRevision
  )
    throw Error(
      "The epic's source changed before publication recovery. Its result was not adopted.",
    );
  if (ready(before, selected, repoId)) return selected;
  if (
    !confirmedWorkerEdit &&
    !(
      matchesSourceObservation(before, selected, repoId) &&
      before.ready === false &&
      before.status === "partial" &&
      publication(before, "partial")
    )
  )
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
  const refreshedRepoId = await engine.analyze(selected, update, true, undefined, guard?.signal, guard?.beforeIndex);
  assertActive();
  if (refreshedRepoId !== repoId)
    throw Error(
      "Memtrace changed repository identity during publication repair. Its result was not adopted.",
    );
  const after = await inspect();
  if (
    !ready(after, selected, repoId) ||
    after.source_revision !== before.source_revision
  )
    throw Error(unverifiedAfterRepair);
  return selected;
}

/** Reuse the exact epic owner; reopening it creates an unnecessary publication race. */
export async function prepareReviewAnalysis(
  engine: Engine,
  project: Project,
  update: (note: string) => void,
  assertActive: () => void = () => {},
  capturedPaths: readonly string[] = [],
): Promise<Project> {
  if (project.analysisCheckout !== "owned-worktree-v1") return project;
  assertActive();
  await engine.activateEpic?.(project, update);
  assertActive();
  // A live checkout is already indexed by the implementation worker. Read its
  // certificate first. Only the known unfinished-publication path may refresh
  // incrementally; never tear down a healthy writer to start a review.
  if (project.repoId)
    return repairReviewPublication(
      engine,
      { ...project },
      update,
      assertActive,
      undefined,
      capturedPaths,
    );
  const repoId = await engine.analyze(project, update);
  assertActive();
  return repairReviewPublication(
    engine,
    { ...project, repoId, analysis: "ready" },
    update,
    assertActive,
    undefined,
    capturedPaths,
  );
}
