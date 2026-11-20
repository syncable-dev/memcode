import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isActive } from "../src/domain";
import type { Evidence, Project, WorkItem } from "../src/shared";
import { git, now, within } from "./local";
import {
  exactRevisionSource,
  pathKey as checkoutKey,
  verifiedIndexRevision,
} from "./memtrace-peer-index";
import { collectQualificationImpact } from "./qualification-impact";
import {
  isNearbyTest,
  resolveQualificationTargets,
} from "./qualification-targets";
import { analyzeRoutingIntent } from "./routing-intent";

interface GraphClient {
  call(
    project: Project,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any>;
}

/**
 * Where a story's evidence was measured: the checkout branch, the working
 * content of the story's own files, and whether the index had published that
 * content. It is the unit of scoped invalidation. An edit elsewhere in the
 * repository leaves it unchanged, so it does not refresh this story.
 */
export interface EvidenceBinding {
  /** Checkout branch when measured. Null when Git could not report one. */
  branch: string | null;
  /**
   * Declared scope and source anchors, repo-relative, each with a hash of its
   * working content. Null marks a file that could not be hashed.
   */
  sources: Record<string, string | null>;
  /** Whether the index had published the working content of those files. */
  index: "current" | "stale" | "unknown";
  /** Bound files the index was behind on. */
  staleFiles: string[];
  /** The branch the index answered for, when it is not the checkout branch. */
  indexBranch?: string;
  /** The engine's own reason for not being ready, when it gave one. */
  indexReason?: string;
  /** Re-evaluate when the request changed even if the source did not. */
  requestFingerprint?: string;
  resolvedFiles?: string[];
  checkedAt: string;
}
export interface BoundEvidence extends Evidence {
  binding?: EvidenceBinding;
}
/** One get_query_revision reading, shared by every story checked together. */
export interface IndexObservation {
  /** False when the engine did not report alignment. Silence is not "current". */
  known: boolean;
  ready: boolean;
  branch?: string;
  /** Why the engine is not ready, in its words (branch_publication_incomplete). */
  reason?: string;
  revision?: string;
  graphRevision?: string;
  sourceRevision?: string;
  sourceCommit?: string;
  changedDuringRead?: boolean;
  wrongCheckout?: boolean;
  /** Repo-relative files whose working content differs from the index. */
  mismatched: string[];
  /** The engine counted more mismatches than it listed. */
  truncated: boolean;
}
export type EvidenceFreshness =
  | { state: "fresh" }
  /**
   * changed: the index holds the new source, so measure again.
   * stale: the index is behind or unconfirmed, so keep the last measurements.
   * unknown: nothing to compare.
   */
  | { state: "changed" | "stale" | "unknown"; reason: string };
export interface EvidenceRefresh {
  taskId: string;
  /**
   * kept: the binding still matches and nothing was queried.
   * refreshed: re-measured against an index that has the current source.
   * stale: the index is behind or unconfirmed for this story. Surfaced, and
   *   the last measurements are kept instead of re-reading a lagging index.
   * skipped: an active run keeps its evidence, or there is nothing to compare.
   */
  action: "kept" | "refreshed" | "stale" | "skipped";
  reason: string;
  /** Replacement evidence, present only when the work item should change. */
  evidence?: BoundEvidence;
}

const BOUND_FILES = 64,
  DIRECTORY_MEMBERS = 200,
  HASHED_BYTES = 2 * 1024 * 1024,
  QUALIFICATION_READ_MS = 12_000;
export const qualificationRequestFingerprint = (task: WorkItem) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        task.title,
        task.description,
        task.kind ?? null,
        task.scope ?? [],
      ]),
    )
    .digest("hex");
const fileKey = (file: string) =>
  process.platform === "win32" ? file.toLowerCase() : file;
const overlaps = (a: string, b: string) => {
  const left = fileKey(a),
    right = fileKey(b);
  return (
    left === right ||
    left.startsWith(right + "/") ||
    right.startsWith(left + "/")
  );
};
/** Repo-relative path with forward slashes. Null when outside the project. */
function repoFile(root: string, file: string): string | null {
  const clean = (value: string) =>
    value
      .replace(/^(\\\\\?\\|\/\/\?\/)/, "")
      .replaceAll("\\", "/")
      .replace(/\/+$/, "");
  const base = clean(root),
    value = clean(file).replace(/^\.\//, "");
  if (!value || value.split("/").includes("..")) return null;
  if (!/^([A-Za-z]:\/|\/)/.test(value)) return value;
  if (
    fileKey(value.slice(0, base.length)) !== fileKey(base) ||
    value[base.length] !== "/"
  )
    return null;
  return value.slice(base.length + 1) || null;
}
/** The files a story's evidence depends on: declared scope plus source anchors. */
export function boundFiles(
  project: Project,
  task: WorkItem,
  evidence?: Pick<BoundEvidence, "symbols"> & {
    binding?: Pick<EvidenceBinding, "resolvedFiles">;
  },
): string[] {
  if (!project.path) return [];
  const files = new Map<string, string>();
  for (const raw of [
    ...(task.scope ?? []),
    ...(evidence?.binding?.resolvedFiles ?? []),
    ...(evidence?.symbols ?? []).map((symbol) => symbol.file),
  ]) {
    const file = repoFile(project.path, raw);
    if (file && !files.has(fileKey(file))) files.set(fileKey(file), file);
  }
  return [...files.values()].sort().slice(0, BOUND_FILES);
}
async function fileHash(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    // A bounded stand-in keeps very large files comparable without reading them.
    if (info.size > HASHED_BYTES)
      return `size:${info.size}:${Math.trunc(info.mtimeMs)}`;
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex")
      .slice(0, 32);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : null;
  }
}
/** Hash one bound entry. A declared directory hashes its Git-visible members. */
async function sourceHash(root: string, file: string): Promise<string | null> {
  const path = resolve(root, file);
  if (!within(root, path)) return null;
  let canonicalRoot: string, absolute: string;
  try {
    [canonicalRoot, absolute] = await Promise.all([
      realpath(root),
      realpath(path),
    ]);
    if (!within(canonicalRoot, absolute)) return null;
    if (!(await stat(absolute)).isDirectory()) return fileHash(absolute);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : null;
  }
  let members: string[];
  try {
    members = (
      await git(root, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        file,
      ])
    )
      .split("\0")
      .filter(Boolean)
      .sort();
  } catch {
    return null;
  }
  if (members.length > DIRECTORY_MEMBERS) return null;
  const digest = createHash("sha256");
  for (const member of members) {
    const memberPath = await realpath(resolve(root, member)).catch(
      () => undefined,
    );
    const hash =
      memberPath && within(canonicalRoot, memberPath)
        ? await fileHash(memberPath)
        : null;
    digest.update(member + "\0").update((hash ?? "?") + "\0");
  }
  return digest.digest("hex").slice(0, 32);
}
/** Ask the engine once whether its index matches the working source. */
export async function observeIndex(
  client: GraphClient,
  project: Project,
  expectedRevision?: string,
): Promise<IndexObservation> {
  const unobserved: IndexObservation = {
    known: false,
    ready: false,
    mismatched: [],
    truncated: false,
  };
  if (!project.path || !project.repoId) return unobserved;
  let revision: any;
  try {
    revision = await client.call(project, "get_query_revision", {
      repo_id: project.repoId,
      ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
    });
  } catch {
    return unobserved;
  }
  if (typeof revision?.ready !== "boolean") return unobserved;
  const owned = project.analysisCheckout === "owned-worktree-v1";
  const wrongCheckout =
    (revision.repo_id && revision.repo_id !== project.repoId) ||
    (revision.branch && revision.branch !== project.branch) ||
    (typeof revision.worktree === "string" &&
      checkoutKey(revision.worktree) !== checkoutKey(project.path)) ||
    (owned
      ? !exactRevisionSource(revision, project, project.repoId)
      : revision.checkout_mode === "owned-worktree-v1" ||
        revision.graph_scope === "owned_worktree_graph");
  const ready = verifiedIndexRevision(revision, project, project.repoId);
  const graphRevision =
    revision._meta?.graph_revision ?? revision.graph_revision;
  const reason = wrongCheckout
    ? "The engine answered for a different checkout."
    : (revision.reason ??
      (owned && !ready
        ? "This goal's exact worktree graph has not been certified."
        : undefined));
  const listed: unknown[] = Array.isArray(revision.mismatched_paths)
    ? revision.mismatched_paths
    : [];
  const mismatched = listed.flatMap((entry) => {
    const file =
      typeof entry === "string" ? repoFile(project.path!, entry) : null;
    return file ? [file] : [];
  });
  return {
    known: true,
    ready,
    ...(typeof revision.branch === "string" ? { branch: revision.branch } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
    revision: revision.token || undefined,
    graphRevision: graphRevision?.token ?? revision.publication?.token,
    sourceRevision: revision.source_revision || undefined,
    sourceCommit: revision.source_commit || undefined,
    changedDuringRead:
      revision.requested_revision_matches === false ||
      revision.requested_source_matches === false ||
      revision.source_unchanged_during_observation === false ||
      graphRevision?.publication_unchanged_during_call === false,
    wrongCheckout,
    mismatched,
    truncated:
      mismatched.length < listed.length ||
      (typeof revision.mismatched_files === "number" &&
        revision.mismatched_files > mismatched.length),
  };
}
/** Bind a set of story files to the current checkout and index observation. */
export async function observeBinding(
  project: Project,
  files: string[],
  index: IndexObservation,
): Promise<EvidenceBinding> {
  const root = project.path!;
  let branch: string | null = null;
  try {
    branch = (await git(root, ["branch", "--show-current"])) || null;
  } catch {
    /* A detached or unreadable checkout stays unknown. */
  }
  const sources: Record<string, string | null> = {};
  for (const file of files) sources[file] = await sourceHash(root, file);
  const binding = (
    state: EvidenceBinding["index"],
    detail: Partial<EvidenceBinding> = {},
  ): EvidenceBinding => ({
    branch,
    sources,
    index: state,
    staleFiles: [],
    ...detail,
    checkedAt: now(),
  });
  if (!index.known) return binding("unknown");
  // Evidence is queried for project.branch; the engine reports its own branch.
  const indexBranch = [project.branch, index.branch].find(
    (value) => !!value && !!branch && value !== branch,
  );
  if (indexBranch) return binding("stale", { indexBranch });
  if (index.ready) return binding("current");
  const staleFiles = files.filter((file) =>
    index.mismatched.some((other) => overlaps(file, other)),
  );
  if (staleFiles.length) return binding("stale", { staleFiles });
  // The engine named why this checkout is not ready, such as a branch it has
  // not finished publishing. That holds for every file on the branch.
  if (index.reason || index.changedDuringRead)
    return binding("stale", {
      indexReason: index.reason ?? "The graph was changing.",
    });
  // A complete mismatch list that omits these files means they are published.
  return binding(
    index.mismatched.length && !index.truncated ? "current" : "unknown",
  );
}
function staleNote(binding: EvidenceBinding): string | null {
  if (binding.index !== "stale") return null;
  if (binding.indexBranch)
    return `Stale index binding: code context answers for branch ${binding.indexBranch}, but the checkout is on ${binding.branch}. Reconnect code context to measure this branch.`;
  const files = binding.staleFiles;
  if (!files.length)
    return `Stale index binding: code context is not ready for branch ${binding.branch ?? "this checkout"}${binding.indexReason ? ` (${binding.indexReason})` : ""}. Measurements are from the last indexed revision.`;
  const named =
    files.slice(0, 3).join(", ") +
    (files.length > 3 ? ` and ${files.length - 3} more` : "");
  return `Stale index binding: the code index is behind the working source for ${named}. Measurements are from the last indexed revision.`;
}
const unconfirmed = (change: string) =>
  `Stale source binding: ${change} Code context has not confirmed its index for this revision, so the last measurements are kept.`;

type QualityRow = Record<string, any>;

const measureNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

function withoutMaintainability(symbols: Evidence["symbols"]) {
  return symbols.map((symbol) => {
    if (symbol.maintainabilityIndex === undefined) return symbol;
    const { maintainabilityIndex: _, ...measurements } = symbol;
    return measurements;
  });
}

function qualityMatches(
  row: QualityRow,
  target: { name: string; file: string; line: number; scopePath?: string },
  root: string,
) {
  return (
    (!row.name || row.name === target.name) &&
    (!row.file_path ||
      fileKey(repoFile(root, row.file_path) ?? "") === fileKey(target.file)) &&
    (!row.start_line || !target.line || row.start_line === target.line) &&
    (!row.scope_path ||
      !target.scopePath ||
      row.scope_path === target.scopePath)
  );
}

export async function collectEvidence(
  client: GraphClient,
  project: Project,
  task: WorkItem,
  observed?: IndexObservation,
): Promise<BoundEvidence> {
  const measuredAt = now();
  if (!project.repoId || project.analysis !== "ready")
    return {
      state: "unavailable",
      symbols: [],
      incomplete: true,
      note: "Analyze this project to add measured code context.",
      measuredAt,
    };

  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), QUALIFICATION_READ_MS);
  const stopped = new Promise<undefined>((done) => {
    deadline.signal.addEventListener("abort", () => done(undefined), {
      once: true,
    });
  });
  const bounded: GraphClient = {
    call: (scope, name, args) =>
      deadline.signal.aborted
        ? Promise.resolve(undefined)
        : Promise.race([
            stopped,
            client.call(scope, name, args, deadline.signal),
          ]),
  };
  let changedPublication = false,
    missingPublication = false;
  const graphRevisions = new Set<string>();
  const read = async (
    name: string,
    args: QualityRow,
  ): Promise<QualityRow | undefined> => {
    try {
      const value = await bounded.call(project, name, {
        repo_id: project.repoId,
        branch: project.branch,
        ...args,
      });
      if (!value || typeof value !== "object") return;
      const revision = value._meta?.graph_revision;
      if (typeof revision?.token === "string" && revision.token)
        graphRevisions.add(revision.token);
      else missingPublication = true;
      if (
        revision?.publication_unchanged_during_call === false ||
        graphRevisions.size > 1
      ) {
        changedPublication = true;
        return;
      }
      if (revision?.status === "partial") missingPublication = true;
      return value;
    } catch {
      return undefined;
    }
  };

  try {
    const before = Promise.resolve(observed ?? observeIndex(bounded, project));
    const intent = analyzeRoutingIntent(task);
    const scope = await resolveQualificationTargets(
      project,
      task,
      intent,
      read,
    );
    const callable = scope.symbols.filter(
      (target) => target.kind === "Function" || target.kind === "Method",
    );
    const measurable = callable.slice(0, 5);
    const measuredMetrics = new Map<
      (typeof callable)[number],
      Partial<Evidence["symbols"][number]>
    >();
    const measurements = async () => {
      for (let offset = 0; offset < measurable.length; offset += 2) {
        await Promise.all(
          measurable.slice(offset, offset + 2).map(async (target) => {
            const result = await read("get_function_quality_metrics", {
              function_name: target.scopePath ?? target.name,
              file_path: target.file,
              kind: target.kind,
            });
            const matching = (
              result?.matches > 1 && Array.isArray(result?.candidates)
                ? result.candidates
                : [result?.function]
            ).filter(
              (row) => row && qualityMatches(row, target, project.path ?? ""),
            );
            if (matching.length !== 1) return;
            const row = matching[0];
            const ast = row.complexity_source === "ast";
            const maintainability = measureNumber(row.maintainability_index);
            measuredMetrics.set(target, {
              cognitive: measureNumber(row.cognitive_complexity),
              cyclomatic: measureNumber(row.complexity),
              nesting: measureNumber(row.max_nesting),
              metricSource: ast ? "ast" : "estimated",
              ...(ast &&
              row.quality_metrics_v === 1 &&
              row.name === target.name &&
              row.file_path &&
              row.kind === target.kind &&
              (!target.nodeId ||
                !row.node_id ||
                row.node_id === target.nodeId) &&
              maintainability !== undefined &&
              maintainability <= 100
                ? { maintainabilityIndex: maintainability }
                : {}),
            });
          }),
        );
      }
    };
    const [reach] = await Promise.all([
      collectQualificationImpact(
        scope.confirmed,
        scope.inferred,
        project.repoId,
        read,
        scope.incomplete,
      ),
      measurements(),
    ]);
    const firstIndex = await before;
    const index = firstIndex.revision
      ? await observeIndex(bounded, project, firstIndex.revision)
      : firstIndex;
    for (const value of [firstIndex.graphRevision, index.graphRevision]) {
      if (value) graphRevisions.add(value);
    }
    const incorrectCheckout =
      firstIndex.wrongCheckout === true || index.wrongCheckout === true;
    changedPublication ||=
      graphRevisions.size > 1 ||
      incorrectCheckout ||
      firstIndex.changedDuringRead === true ||
      index.changedDuringRead === true ||
      !!(
        firstIndex.revision &&
        index.revision &&
        firstIndex.revision !== index.revision
      );
    const { impact } = reach;
    const tests = reach.testPaths;
    for (const file of scope.sourceFiles.filter(isNearbyTest)) tests.add(file);
    for (const target of scope.confirmed.filter((entry) =>
      isNearbyTest(entry.file),
    ))
      tests.add(target.file);
    const completeMetrics = [...measuredMetrics.values()].filter(
      (metrics) =>
        metrics.metricSource === "ast" &&
        metrics.cognitive !== undefined &&
        metrics.cyclomatic !== undefined &&
        metrics.nesting !== undefined,
    ).length;
    const metricsComplete =
      callable.length > 0 && callable.length === completeMetrics;
    const symbols: Evidence["symbols"] = scope.symbols.map((target) => {
      const metrics = changedPublication
        ? undefined
        : measuredMetrics.get(target);
      return {
        name: target.name,
        file: target.file,
        line: target.line,
        nodeId: target.nodeId,
        ...metrics,
      };
    });
    let binding: EvidenceBinding | undefined;
    let sourceRevision = index.sourceRevision;
    let incomplete =
      scope.incomplete ||
      !scope.confirmed.length ||
      impact.incomplete ||
      !metricsComplete ||
      changedPublication ||
      missingPublication ||
      !firstIndex.revision ||
      !index.revision ||
      deadline.signal.aborted;
    if (project.path) {
      try {
        const sourceCommit = await git(project.path, ["rev-parse", "HEAD"]);
        const current = await observeBinding(
          project,
          boundFiles(project, task, {
            symbols,
            binding: { resolvedFiles: scope.sourceFiles },
          }),
          index,
        );
        binding = {
          ...current,
          resolvedFiles: scope.sourceFiles,
          requestFingerprint: qualificationRequestFingerprint(task),
        };
        sourceRevision ??= sourceCommit;
        incomplete ||= current.index !== "current" || !index.ready;
        if (index.sourceCommit && index.sourceCommit !== sourceCommit) {
          // The checkout moved after the question was answered.
          changedPublication = true;
          incomplete = true;
        }
      } catch {
        incomplete = true;
      }
    }
    const maintainabilityCurrent =
      firstIndex.ready &&
      !!firstIndex.revision &&
      index.ready &&
      !!index.revision &&
      binding?.index === "current" &&
      !missingPublication &&
      !deadline.signal.aborted;
    return {
      state: incomplete ? "partial" : "measured",
      symbols: changedPublication
        ? []
        : maintainabilityCurrent
          ? symbols
          : withoutMaintainability(symbols),
      // A union containing rows from two publications is not an observation.
      impact: changedPublication
        ? {
            basis: impact.basis,
            targetCount: impact.targetCount,
            observedTargets: 0,
            incomplete: true,
          }
        : impact,
      scopeCoverage: {
        confirmedTargets: changedPublication ? 0 : scope.confirmed.length,
        inferredTargets: changedPublication ? 0 : scope.inferred.length,
        unresolvedReferences: scope.unresolved,
        measuredTargets: changedPublication ? 0 : completeMetrics,
        incomplete,
        ...(changedPublication || !tests.size
          ? {}
          : { nearbyTests: tests.size }),
        ...(changedPublication
          ? {}
          : {
              publicContracts:
                scope.confirmed.filter((target) => target.exported).length ||
                undefined,
            }),
      },
      affected: changedPublication ? undefined : impact.affectedSymbols,
      affectedFiles: changedPublication ? undefined : impact.affectedFiles,
      affectedProcesses: changedPublication
        ? undefined
        : impact.affectedProcesses,
      sourceRevision,
      graphRevision: changedPublication
        ? undefined
        : graphRevisions.values().next().value,
      incomplete,
      measuredAt,
      note: incorrectCheckout
        ? "Memtrace answered for a different checkout. Measure again on this story's epic."
        : changedPublication
          ? "The source or graph changed while the task was measured. Measure again to use one revision."
          : ((binding && staleNote(binding)) ??
            (deadline.signal.aborted
              ? "The code context check reached its time limit. The route uses the evidence collected so far."
              : !symbols.length
                ? "No source anchors matched. The route remains provisional and starts above the fast tier."
                : incomplete
                  ? "Source measurements cover a bounded scope. Impact may be an observed lower bound."
                  : "AST measurements and observed upstream impact cover the confirmed source anchors.")),
      ...(binding ? { binding } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Compare the binding recorded with a story's evidence to the current one. */
export function evidenceFreshness(
  bound: EvidenceBinding | undefined,
  current: EvidenceBinding,
): EvidenceFreshness {
  // A lagging index would only repeat the old answer, so it is never re-read.
  const stale = staleNote(current);
  if (stale) return { state: "stale", reason: stale };
  if (!bound)
    return {
      state: "unknown",
      reason: "This evidence was measured before source bindings existed.",
    };
  const changed = [
    ...new Set([
      ...Object.keys(bound.sources),
      ...Object.keys(current.sources),
    ]),
  ].filter((file) => bound.sources[file] !== current.sources[file]);
  const change =
    bound.branch !== current.branch
      ? `The checkout moved from ${bound.branch ?? "an unknown branch"} to ${current.branch ?? "an unknown branch"}.`
      : changed.length
        ? `Bound source changed since measurement: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ` and ${changed.length - 3} more` : ""}.`
        : null;
  // Measuring against an unconfirmed index could replace good evidence with
  // an answer for some other revision, so that waits for a confirmed one.
  if (change)
    return current.index === "current"
      ? { state: "changed", reason: change }
      : { state: "stale", reason: unconfirmed(change) };
  if (Object.values(current.sources).some((hash) => hash === null))
    return {
      state: "unknown",
      reason: "Some bound source could not be read to compare it.",
    };
  if (current.index === "unknown")
    return {
      state: "unknown",
      reason:
        "Memtrace did not report whether its index matches the working source.",
    };
  if (bound.index !== "current")
    return {
      state: "changed",
      reason: "The index caught up with the working source.",
    };
  return { state: "fresh" };
}

/**
 * Scoped refresh. With `changed` (the files a worker just edited) only stories
 * whose bound files overlap them are considered. Without it every story with
 * evidence is compared, and still only those whose binding moved are measured
 * again, and only once the index is confirmed to hold their source. One index
 * observation serves the whole pass; an unchanged story costs a few file
 * hashes and no engine query.
 *
 * Bindings follow a story's own files. A new caller added in an unrelated file
 * changes that story's impact count without changing its binding, so impact is
 * next corrected when the story is qualified again.
 */
export async function refreshEvidence(
  client: GraphClient,
  project: Project,
  tasks: WorkItem[],
  changed?: string[],
): Promise<EvidenceRefresh[]> {
  if (!project.path || !project.repoId || project.analysis !== "ready")
    return [];
  const touched = changed?.flatMap((file) => {
    const relative = repoFile(project.path!, file);
    return relative ? [relative] : [];
  });
  const results: EvidenceRefresh[] = [];
  let index: IndexObservation | undefined;
  for (const task of tasks) {
    const evidence: BoundEvidence | undefined = task.evidence;
    if (
      task.projectId !== project.id ||
      task.example ||
      !evidence ||
      evidence.state === "unavailable"
    )
      continue;
    const files = boundFiles(project, task, evidence);
    if (
      touched &&
      !files.some((file) => touched.some((other) => overlaps(file, other)))
    )
      continue;
    const result = (
      action: EvidenceRefresh["action"],
      reason: string,
      replacement?: BoundEvidence,
    ) =>
      results.push({
        taskId: task.id,
        action,
        reason,
        ...(replacement ? { evidence: replacement } : {}),
      });
    if (isActive(task)) {
      result(
        "skipped",
        "The running attempt keeps the evidence it began with.",
      );
      continue;
    }
    if (!files.length) {
      result(
        "skipped",
        "No declared scope or source anchor ties it to a file.",
      );
      continue;
    }
    index ??= await observeIndex(client, project);
    const current = await observeBinding(project, files, index);
    let freshness = evidenceFreshness(evidence.binding, current);
    if (
      evidence.binding?.requestFingerprint &&
      evidence.binding.requestFingerprint !==
        qualificationRequestFingerprint(task)
    ) {
      const change = "The work request or its declared scope changed.";
      freshness =
        current.index === "current"
          ? { state: "changed", reason: change }
          : { state: "stale", reason: unconfirmed(change) };
    }
    // Unbound evidence has nothing to compare, but a worker's edit to its
    // files is a known change.
    if (freshness.state === "unknown" && touched && !evidence.binding) {
      const change = "A worker edited this task's files.";
      freshness =
        current.index === "current"
          ? { state: "changed", reason: change }
          : { state: "stale", reason: unconfirmed(change) };
    }
    if (freshness.state === "fresh") {
      result("kept", "The source and index binding still match.");
    } else if (freshness.state === "stale") {
      // Surface it once; an unchanged stale binding is not rewritten.
      const surfaced =
        !!evidence.binding &&
        evidence.note === freshness.reason &&
        JSON.stringify({ ...evidence.binding, checkedAt: "" }) ===
          JSON.stringify({ ...current, checkedAt: "" });
      result(
        "stale",
        freshness.reason,
        surfaced
          ? undefined
          : {
              ...evidence,
              state: "partial",
              incomplete: true,
              symbols: withoutMaintainability(evidence.symbols),
              note: freshness.reason,
              binding: {
                ...current,
                requestFingerprint: evidence.binding?.requestFingerprint,
                resolvedFiles: evidence.binding?.resolvedFiles,
              },
            },
      );
    } else if (freshness.state === "changed") {
      result(
        "refreshed",
        freshness.reason,
        await collectEvidence(client, project, task, index),
      );
    } else {
      result("skipped", freshness.reason);
    }
  }
  return results;
}
