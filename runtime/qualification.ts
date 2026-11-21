import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isActive } from "../src/domain";
import type { Evidence, Project, WorkItem } from "../src/shared";
import { git, now, within } from "./local";
import { verifiedIndexRevision } from "./memtrace-peer-index";

interface GraphClient {
  call(
    project: Project,
    name: string,
    args: Record<string, unknown>,
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
  HASHED_BYTES = 2 * 1024 * 1024;
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
  if (!value || value === ".." || value.startsWith("../")) return null;
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
  evidence?: Pick<Evidence, "symbols">,
): string[] {
  if (!project.path) return [];
  const files = new Map<string, string>();
  for (const raw of [
    ...(task.scope ?? []),
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
  let directory = false;
  try {
    directory = (await stat(path)).isDirectory();
  } catch {
    /* fileHash reports a missing file. */
  }
  if (!directory) return fileHash(path);
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
  for (const member of members)
    digest
      .update(member + "\0")
      .update(((await fileHash(resolve(root, member))) ?? "?") + "\0");
  return digest.digest("hex").slice(0, 32);
}
/** Ask the engine once whether its index matches the working source. */
export async function observeIndex(
  client: GraphClient,
  project: Project,
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
    });
  } catch {
    return unobserved;
  }
  if (typeof revision?.ready !== "boolean") return unobserved;
  if (
    project.analysisCheckout === "owned-worktree-v1" &&
    !verifiedIndexRevision(revision, project, project.repoId)
  )
    return {
      ...unobserved,
      known: true,
      branch: revision.branch,
      reason: "This goal's exact worktree graph has not been certified.",
    };
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
    ready: revision.ready,
    ...(typeof revision.branch === "string" ? { branch: revision.branch } : {}),
    ...(typeof revision.reason === "string" ? { reason: revision.reason } : {}),
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
  if (index.reason) return binding("stale", { indexReason: index.reason });
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
  const rows = new Map<string, any>();
  let incomplete = false,
    graphRevision: string | undefined;
  if (task.scope?.length) {
    const scopedRows: any[][] = [];
    for (const file of task.scope.slice(0, 3)) {
      const context = await client.call(project, "get_symbol_context", {
        repo_id: project.repoId,
        branch: project.branch,
        symbol: basename(file),
        file_path: file,
        limit: 64,
      });
      graphRevision = context._meta?.graph_revision?.token ?? graphRevision;
      const callables = (context.contains ?? []).filter(
        (row: any) => row.kind === "Function" || row.kind === "Method",
      );
      callables.sort(
        (a: any, b: any) =>
          Number(b.kind === "Function") - Number(a.kind === "Function"),
      );
      scopedRows.push(callables);
      incomplete ||=
        !context.found || !!context.truncated || !!context.graph_truncated;
    }
    // Sample each declared file before taking more symbols from any one file.
    for (let index = 0; index < 8; index++)
      for (const group of scopedRows) {
        const row = group[index];
        if (row)
          rows.set(row.file_path + "::" + (row.node_id ?? row.name), row);
      }
  } else {
    const result = await client.call(project, "find_code", {
      repo_id: project.repoId,
      branch: project.branch,
      query: (task.title + " " + task.description).slice(0, 1000),
      limit: 6,
      include_context: true,
    });
    incomplete ||=
      result.status !== "complete" ||
      !!result.context?.incomplete_reasons?.length;
    graphRevision = result._meta?.graph_revision?.token ?? graphRevision;
    for (const row of result.results ?? [])
      rows.set(row.file_path + "::" + row.name, row);
  }
  const selected = [...rows.values()]
    .filter((row) => row.kind === "Function" || row.kind === "Method")
    .slice(0, 8);
  const symbols: Evidence["symbols"] = [];
  for (const row of selected) {
    symbols.push({
      name: row.name,
      file: row.file_path,
      line: row.symbol_start_line ?? row.start_line,
    });
  }
  const measureSymbol = async (symbol: Evidence["symbols"][number]) => {
    try {
      const context = await client.call(project, "get_symbol_context", {
        repo_id: project.repoId,
        branch: project.branch,
        symbol: symbol.name,
        file_path: symbol.file,
        limit: 3,
      });
      if (context.found) {
        symbol.nodeId = context.symbol.node_id;
        symbol.file = context.symbol.file_path;
        symbol.line = context.symbol.start_line;
      }
      const result = await client.call(
        project,
        "get_function_quality_metrics",
        {
          repo_id: project.repoId,
          branch: project.branch,
          function_name: symbol.name,
          file_path: symbol.file,
        },
      );
      const m = result.function;
      if (!m) {
        incomplete = true;
        return;
      }
      symbol.metricSource = m.complexity_source === "ast" ? "ast" : "estimated";
      if (typeof m.cognitive_complexity === "number")
        symbol.cognitive = m.cognitive_complexity;
      if (typeof m.complexity === "number") symbol.cyclomatic = m.complexity;
      if (typeof m.max_nesting === "number") symbol.nesting = m.max_nesting;
      if (symbol.metricSource !== "ast") incomplete = true;
    } catch {
      incomplete = true;
    }
  };
  const measured = symbols.slice(0, 5);
  for (let offset = 0; offset < measured.length; offset += 3)
    await Promise.all(measured.slice(offset, offset + 3).map(measureSymbol));
  if (symbols.length > 5) incomplete = true;
  let affected: number | undefined,
    affectedProcesses: number | undefined,
    affectedFiles: number | undefined;
  if (symbols[0])
    try {
      const impact = await client.call(project, "get_impact", {
        repo_id: project.repoId,
        branch: project.branch,
        target: symbols[0].nodeId ?? symbols[0].name,
        file_path: symbols[0].file,
        direction: "upstream",
        depth: 3,
      });
      if (typeof impact.total_affected === "number")
        affected = impact.total_affected;
      affectedProcesses =
        impact.affected_processes_count ??
        (Array.isArray(impact.affected_processes)
          ? impact.affected_processes.length
          : undefined);
      affectedFiles =
        impact.affected_files_count ??
        (Array.isArray(impact.affected_files)
          ? impact.affected_files.length
          : undefined);
      incomplete ||=
        !impact.found ||
        !!impact.graph_incomplete ||
        !!impact.truncated ||
        impact.risk === "UNKNOWN" ||
        !!impact.total_affected_is_lower_bound;
    } catch {
      incomplete = true;
    }
  let sourceRevision: string | undefined, binding: EvidenceBinding | undefined;
  if (project.path)
    try {
      sourceRevision = await git(project.path, ["rev-parse", "HEAD"]);
      const index = observed ?? (await observeIndex(client, project));
      binding = await observeBinding(
        project,
        boundFiles(project, task, { symbols }),
        index,
      );
      // The engine compares its index with the working files, so uncommitted
      // saves it has published count as measured. Without its answer a dirty
      // tree cannot be shown to be indexed.
      if (!index.known)
        incomplete ||= !!(await git(project.path, ["status", "--porcelain"]));
      else if (!index.ready || binding.index !== "current") incomplete = true;
    } catch {
      incomplete = true;
    }
  if (!symbols.length) incomplete = true;
  return {
    state: incomplete ? "partial" : "measured",
    symbols,
    affected,
    affectedFiles,
    affectedProcesses,
    incomplete,
    sourceRevision,
    graphRevision,
    measuredAt,
    note:
      (binding && staleNote(binding)) ??
      (!symbols.length
        ? "No source anchors matched. The route remains provisional and starts above the fast tier."
        : incomplete
          ? "Source measurements are available, with incomplete scope or dependency coverage. Impact refers to the primary source anchor."
          : "AST measurements and observed primary-anchor impact are attached. Envelope thresholds remain provisional policy."),
    ...(binding ? { binding } : {}),
  };
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
              note: freshness.reason,
              binding: current,
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
