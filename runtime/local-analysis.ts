import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import type {
  DiagnosticMetadata,
  LocalAnalysisDiagnostics,
} from "../src/local-analysis";
import type { Project } from "../src/shared";
import type { MemtraceEngine } from "./memtrace";
import {
  certifiedPublication,
  exactRevisionSource,
} from "./memtrace-peer-index";
import { sourceChangedBeforePublication } from "../src/local-analysis";

type Engine = Pick<MemtraceEngine, "call" | "scopeFor"> & {
  certificateDiagnosticsFor?: (projectId: string) => string[];
  bindingStillCurrent?: (projectId: string) => () => boolean;
};
type Register = (
  name: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const rows = (value: unknown, keys: string[]): Row[] => {
  if (Array.isArray(value)) return value.slice(0, 1000).map(row);
  for (const key of keys)
    if (Array.isArray(row(value)[key]))
      return (row(value)[key] as unknown[]).slice(0, 1000).map(row);
  return [];
};

/** Metadata errors may include authorization headers or URLs: redact before display/copy. */
function text(value: unknown, maximum = 700): string | undefined {
  if (typeof value !== "string") return undefined;
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\b(Bearer|Basic)\s+[^\s"',;}]+/gi, "$1 [redacted]")
    .replace(/\b((?:set-)?cookie)\s*[:=]\s*[^\r\n]+/gi, "$1: [redacted]")
    .replace(
      /((?:authorization|api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|secret|license[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /([?#&](?:token|key|api_key|code|invite|secret|access_token)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted assertion]",
    )
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "[redacted]")
    .slice(0, maximum);
}
function failureText(error: unknown, depth = 0): string {
  if (typeof error === "string") return error;
  if (depth > 2 || !error || typeof error !== "object")
    return "Engine metadata could not be read.";
  const detail = row(error),
    parts = [detail.code, detail.message].filter(
      (value): value is string => typeof value === "string",
    );
  for (const key of ["reason", "cause"]) {
    if (typeof detail[key] === "string") parts.push(detail[key] as string);
    else if (detail[key] && typeof detail[key] === "object" && depth < 2)
      parts.push(failureText(detail[key], depth + 1));
  }
  return (
    [...new Set(parts)].join(" · ") || "Engine metadata could not be read."
  );
}
function metadata(
  value: unknown,
  keys: string[],
  maxString = 700,
): DiagnosticMetadata {
  const output: DiagnosticMetadata = {},
    source = row(value);
  for (const key of keys) {
    const item = source[key];
    if (typeof item === "string") output[key] = text(item, maxString)!;
    else if (typeof item === "boolean" || item === null) output[key] = item;
    else if (typeof item === "number" && Number.isFinite(item))
      output[key] = item;
  }
  return output;
}
const pathKey = (path: unknown): string | undefined => {
  if (typeof path !== "string" || !path) return undefined;
  const key = resolve(path.replace(/^\\\\\?\\/, ""))
    .replaceAll("\\", "/")
    .replace(/\/$/, "");
  return process.platform === "win32" ? key.toLowerCase() : key;
};
const repoKeys = [
  "repo_id",
  "repo_path",
  "path",
  "branch",
  "current_branch",
  "live_branch",
  "workspace_branch",
  "commit_sha",
  "live_head_sha",
  "graph_head_sha",
  "graph_head_at",
  "working_tree_sha",
  "index_state",
  "index_state_reason",
  "nodes",
  "edges",
  "last_indexed_at",
  "summary_current",
  "summary_error",
  "summary_refresh_in_progress",
];
const revisionKeys = [
  "status",
  "ready",
  "reason",
  "note",
  "branch",
  "repo_id",
  "worktree",
  "checkout_mode",
  "graph_scope",
  "source_commit",
  "source_revision",
  "indexing_revision",
  "source_type",
  "index_state",
  "token",
  "generation",
  "mismatched_files",
  "pending_files",
  "publication_incomplete",
  "indexed_file_count",
  "source_file_count",
  "ambiguous_indexed_files",
  "source_unchanged_during_observation",
  "default_query_branch",
  "default_branch_matches",
  "requested_source_matches",
  "requested_revision_matches",
  "retry_after_seconds",
  "retry_query_group",
];
const jobKeys = [
  "id",
  "job_id",
  "repo_id",
  "branch",
  "status",
  "stage",
  "message",
  "error",
  "warning",
  "created_at",
  "updated_at",
  "nodes_indexed",
  "edges_indexed",
  "alreadyUpToDate",
  "needs_replay",
];

/** Queries the exact engine bound to the card's project; never starts a watch/index/reset operation. */
export async function localAnalysisDiagnostics(
  project: Project,
  engine: Engine,
  options: {
    timeoutMs?: number;
    onRecovered?: (repoId: string) => Promise<void>;
  } = {},
): Promise<LocalAnalysisDiagnostics> {
  const result: LocalAnalysisDiagnostics = {
    sourcePublication: "unverified",
    platform: process.platform,
    project: {
      name: text(project.name, 240)!,
      path: text(project.path, 2000) ?? null,
      branch: text(project.branch, 250)!,
      analysis: project.analysis,
      ...(project.analysisNote ? { note: text(project.analysisNote) } : {}),
      ...(project.repoId ? { repoId: text(project.repoId, 250) } : {}),
    },
    scope: null,
    repoMetadata: null,
    indexRevision: null,
    watch: [],
    jobs: [],
    failures: [],
    capturedAt: new Date().toISOString(),
  };
  const deadline =
    Date.now() + Math.min(20_000, Math.max(1, options.timeoutMs ?? 20_000));
  const fail = (operation: string, error: unknown, timeout = false) =>
    result.failures.push({
      operation,
      reason: text(failureText(error)) ?? "Metadata unavailable.",
      timeout,
    });
  const query = async (
    operation: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      fail(
        operation,
        "The diagnostic capture reached its time limit; this state is unknown.",
        true,
      );
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("timeout");
    try {
      // A timeout relinquishes this observation, not another owner's MCP request.
      const answer = await Promise.race([
        engine.call(project, operation, args),
        new Promise<symbol>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), remaining);
        }),
      ]);
      if (answer === timedOut) {
        fail(
          operation,
          "The engine did not answer within the diagnostic time limit; this state is unknown.",
          true,
        );
        return undefined;
      }
      return answer;
    } catch (error) {
      fail(operation, error);
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  if (!project.path || project.example) {
    fail(
      "project_scope",
      "Connect this project's local repository before inspecting its code engine.",
    );
    return result;
  }
  const root = pathKey(project.path);
  const savedNote = project.analysisNote;
  const savedRepo = project.repoId;
  const savedCheckout = project.analysisCheckout;
  const [repositories, watches, jobs] = await Promise.all([
    query("list_indexed_repositories"),
    query("list_watched_paths"),
    query("list_jobs"),
  ]);
  const listed = (value: unknown, keys: string[], operation: string) => {
    if (
      value !== undefined &&
      !Array.isArray(value) &&
      !keys.some((key) => Array.isArray(row(value)[key]))
    )
      fail(
        operation,
        "The engine returned an unrecognized metadata list; this state is unknown.",
      );
    return rows(value, keys);
  };
  const matched = listed(
    repositories,
    ["repos", "repositories"],
    "list_indexed_repositories",
  ).filter((value) => pathKey(value.repo_path ?? value.path) === root);
  const repository =
    matched.find(
      (value) =>
        (value.live_branch ?? value.branch ?? value.current_branch) ===
        project.branch,
    ) ?? matched[0];
  if (repository) result.repoMetadata = metadata(repository, repoKeys);
  else if (repositories !== undefined)
    fail(
      "repository_scope",
      "The connected engine did not list this exact local project path.",
    );
  const repoId =
    typeof repository?.repo_id === "string"
      ? repository.repo_id
      : project.repoId;
  const bindingStillCurrent = engine.bindingStillCurrent?.(project.id);
  const sameCheckout = () =>
    root === pathKey(project.path) &&
    result.project.branch === project.branch &&
    savedRepo === project.repoId &&
    savedCheckout === project.analysisCheckout &&
    bindingStillCurrent?.() === true;
  if (
    repository?.repo_id &&
    project.repoId &&
    repository.repo_id !== project.repoId
  )
    fail(
      "repository_identity",
      "The engine's exact-path repository identity differs from this project's saved identity. Both values are retained in this capture.",
    );
  result.watch = listed(watches, ["watches", "paths"], "list_watched_paths")
    .filter((value) => pathKey(value.path ?? value.repo_path) === root)
    .slice(0, 8)
    .map((value) => {
      const output = metadata(value, [
        "path",
        "repo_path",
        "repo_id",
        "branch",
        "state",
        "status",
        "reason",
        "started_at",
        "last_event_at",
        "pending_files",
        "is_indexing",
        "origin",
        "answered_by",
      ]);
      const scope = metadata(value.index_scope, ["view"]);
      if (Object.keys(scope).length) output.index_scope = scope;
      return output;
    });
  result.jobs = listed(jobs, ["jobs"], "list_jobs")
    .filter((value) => {
      const context = row(value.runtime_context);
      const candidate =
        value.repo_path ??
        value.root ??
        value.path ??
        value.requested_path ??
        context.requested_path;
      const path =
        typeof candidate === "string" && candidate.trim()
          ? candidate
          : undefined;
      if (path !== undefined && pathKey(path) !== root) return false;
      if (repoId && value.repo_id !== undefined && value.repo_id !== repoId)
        return false;
      const branch = value.branch ?? value.branch_name ?? context.branch;
      if (branch !== undefined && branch !== project.branch) return false;
      return path !== undefined || (!!repoId && value.repo_id === repoId);
    })
    .sort((a, b) =>
      String(b.updated_at ?? b.created_at ?? "").localeCompare(
        String(a.updated_at ?? a.created_at ?? ""),
      ),
    )
    .slice(0, 10)
    .map((value) => {
      const output = metadata(value, jobKeys),
        context = metadata(value.runtime_context, [
          "captured_at",
          "process_id",
          "mode",
          "store_path",
          "requested_path",
        ]);
      if (Object.keys(context).length) output.runtime_context = context;
      const progress = metadata(value.progress, ["completed", "total", "unit"]);
      if (Object.keys(progress).length) output.progress = progress;
      if (!value.branch) output.branch_observation = "unknown";
      return output;
    });
  if (repoId) {
    const revision = await query("get_query_revision", {
      repo_id: repoId,
      branch: result.project.branch,
    });
    if (
      revision !== undefined &&
      !["ready", "status", "reason"].some((key) => key in row(revision))
    )
      fail(
        "get_query_revision",
        "The engine returned unrecognized index revision metadata; readiness is unknown.",
      );
    else if (revision !== undefined) {
      const exactOwner =
        sameCheckout() &&
        repository?.repo_id === repoId &&
        (!(repository.live_branch ?? repository.branch) ||
          (repository.live_branch ?? repository.branch) === project.branch) &&
        (!savedRepo || savedRepo === repoId) &&
        exactRevisionSource(row(revision), project, repoId);
      if (exactOwner) {
        if (certifiedPublication(row(revision), project, repoId))
          result.sourcePublication = "verified";
        else if (
          row(revision).ready === false &&
          row(revision).reason === "branch_publication_incomplete"
        )
          result.sourcePublication = "incomplete";
      }
      result.indexRevision = metadata(revision, revisionKeys);
      const paths = row(revision).mismatched_paths;
      if (Array.isArray(paths))
        result.indexRevision.mismatched_paths = paths
          .slice(0, 10)
          .flatMap((value) =>
            typeof value === "string" ? [text(value, 400)!] : [],
          );
      const graph = metadata(row(row(revision)._meta).graph_revision, [
        "token",
        "status",
        "publication_unchanged_during_call",
      ]);
      if (Object.keys(graph).length)
        result.indexRevision.graph_revision = graph;
      const publication = metadata(row(revision).publication, [
        "status",
        "generation",
        "token",
        "reason",
        "incarnation",
        "revision",
      ]);
      if (Object.keys(publication).length)
        result.indexRevision.publication = publication;
    }
  } else
    fail(
      "get_query_revision",
      "No repository identity is known for this exact local checkout; index revision is unknown.",
    );
  try {
    const scope = engine.scopeFor(project.id);
    if (scope)
      result.scope = {
        mode: scope.mode,
        dataDirectory: text(scope.dataDirectory, 2000)!,
        ...(scope.workspaceFile
          ? { workspaceFile: text(scope.workspaceFile, 2000) }
          : {}),
      };
  } catch (error) {
    fail("engine_scope", error);
  }
  if (engine.certificateDiagnosticsFor) {
    try {
      const lines = engine.certificateDiagnosticsFor(project.id);
      result.engineDiagnostics = lines
        .filter(
          (line) =>
            typeof line === "string" &&
            /owned branch index could not be certified|certificate|input changed|parsed files|stored files|no complete pre-index|hashing budget/i.test(
              line,
            ),
        )
        .slice(-8)
        .map((line) => text(line, 500)!);
    } catch (error) {
      fail("engine_certificate_diagnostics", error);
    }
  }
  // Keep copied diagnostics bounded even if an engine emits unusually long job messages.
  while (
    Buffer.byteLength(JSON.stringify(result)) > 32_768 &&
    result.jobs.length
  )
    result.jobs.pop();
  while (
    Buffer.byteLength(JSON.stringify(result)) > 32_768 &&
    result.watch.length
  )
    result.watch.pop();
  if (Buffer.byteLength(JSON.stringify(result)) > 32_768) {
    const shorten = (value: unknown): unknown =>
      typeof value === "string"
        ? value.slice(0, 256)
        : Array.isArray(value)
          ? value.map(shorten)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                  key,
                  shorten(item),
                ]),
              )
            : value;
    result.repoMetadata = shorten(
      result.repoMetadata,
    ) as DiagnosticMetadata | null;
    result.indexRevision = shorten(
      result.indexRevision,
    ) as DiagnosticMetadata | null;
    result.engineDiagnostics = result.engineDiagnostics?.map((line) =>
      line.slice(0, 256),
    );
    result.failures = result.failures.map((failure) => ({
      ...failure,
      reason: failure.reason.slice(0, 256),
    }));
  }
  if (
    result.sourcePublication === "verified" &&
    sameCheckout() &&
    options.onRecovered &&
    project.analysis === "error" &&
    project.analysisNote === savedNote &&
    sourceChangedBeforePublication(savedNote) &&
    typeof repoId === "string"
  ) {
    await options.onRecovered(repoId);
    result.project.analysis = project.analysis;
    result.project.note = text(project.analysisNote);
    result.project.repoId = text(project.repoId);
  }
  return result;
}

export function registerLocalAnalysis(
  register: Register,
  projectById: (id: string) => Project,
  engine: Engine,
  onRecovered?: (project: Project, repoId: string) => Promise<void>,
) {
  register(
    "project:local-diagnostics",
    z.object({ projectId: z.string().min(1).max(200) }).strict(),
    ({ projectId }) => {
      const item = projectById(projectId);
      return localAnalysisDiagnostics(item, engine, {
        onRecovered:
          onRecovered &&
          (async (repoId) => {
            if (projectById(projectId) === item)
              await onRecovered(item, repoId);
          }),
      });
    },
  );
}
