import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { AppState, Project } from "../src/shared";
import type {
  IntelligenceDetail,
  IntelligenceItem,
  IntelligenceSection,
  QualitySnapshot,
  ComplexityDistribution,
} from "../src/intelligence";
import {
  findingFromRow,
  numberOrNull,
  relativeFile,
} from "../src/intelligence";
import type { MemtraceEngine } from "./memtrace";
import { certifiedPublication, pathKey } from "./memtrace-peer-index";
import { git, within } from "./local";
import { styleProfile } from "../src/style-profile";

type Json = Record<string, any>;
type Register = (
  name: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
interface CaptureInput {
  project: Project;
  capturedAt: string;
  commit: string | null;
  dirty: boolean | null;
  results: Record<string, Json | undefined>;
  failures: string[];
  scope?: { mode: "workspace" | "project"; dataDirectory: string } | null;
  watch?: QualitySnapshot["graph"]["watch"];
}
/** Reattach the selected project's native watch after a restart, without reindexing. */
export async function ensureProjectWatch(
  engine: Pick<MemtraceEngine, "watch">,
  project: Project,
): Promise<NonNullable<QualitySnapshot["graph"]["watch"]>> {
  const unavailable = (reason: string) => ({
    state: "unavailable" as const,
    branch: project.branch,
    reason,
  });
  if (!project.path || !project.repoId || project.analysis !== "ready")
    return unavailable(
      "Connect the local checkout and finish analysis before verifying its live watch.",
    );
  if (typeof engine.watch !== "function")
    return unavailable(
      "This engine connection could not verify a live file watch.",
    );
  try {
    const watch = await engine.watch(project);
    if (!watch)
      return unavailable("The engine did not confirm a live file watch.");
    return {
      state: watch.state,
      branch: watch.branch,
      ...(watch.verifiedAt ? { verifiedAt: watch.verifiedAt } : {}),
      ...(watch.reason ? { reason: watch.reason } : {}),
    };
  } catch (error) {
    return unavailable(
      (error instanceof Error
        ? error.message
        : "The engine did not confirm a live file watch."
      ).slice(0, 400),
    );
  }
}
function n(value: unknown) {
  const valueNumber = numberOrNull(value);
  return valueNumber !== null && valueNumber >= 0 ? valueNumber : null;
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function rows(value: any, key: string): Json[] {
  return Array.isArray(value)
    ? value
    : Array.isArray(value?.[key])
      ? value[key]
      : [];
}
function revision(value: Json | undefined): string | null {
  return (
    text(value?.publication?.token) ||
    text(value?._meta?.graph_revision?.token) ||
    null
  );
}
function checkoutMatches(value: Json | undefined, project: Project): boolean {
  if (!value || !project.path) return false;
  return value.branch === project.branch &&
    (!value.repo_id || value.repo_id === project.repoId) &&
    (!value.worktree ||
      (typeof value.worktree === "string" && pathKey(value.worktree) === pathKey(project.path))) &&
    (project.analysisCheckout === "owned-worktree-v1"
      ? value.checkout_mode === project.analysisCheckout && value.graph_scope === "owned_worktree_graph"
      : value.checkout_mode !== "owned-worktree-v1" && value.graph_scope !== "owned_worktree_graph");
}

export function normalizeQualitySnapshot(input: CaptureInput): QualitySnapshot {
  const { project, capturedAt, commit, dirty, results, failures } = input;
  const stats = results.stats?.summary_current === false ? undefined : results.stats,
    complex = results.complex,
    dead = results.dead,
    cycles = results.cycles,
    before = results.before,
    after = results.after;
  const raw =
    complex?.measured_distribution ??
    (complex?.estimated_function_count === 0
      ? complex?.distribution
      : undefined);
  const measured = n(complex?.measured_function_count);
  let distribution: ComplexityDistribution | null =
    raw &&
    ["simple", "moderate", "high", "critical"].every(
      (key) => n(raw[key]) !== null,
    )
      ? {
          simple: raw.simple,
          moderate: raw.moderate,
          high: raw.high,
          critical: raw.critical,
        }
      : null;
  const limitations = [...failures];
  const summaryPending = results.stats?.summary_current === false;
  if (summaryPending)
    limitations.push("The engine has not verified its repository totals yet. Record another checkpoint once the summary is ready.");
  if (
    distribution &&
    measured !== null &&
    Object.values(distribution).reduce((sum, count) => sum + count, 0) !==
      measured
  ) {
    distribution = null;
    limitations.push(
      "The complexity distribution does not reconcile with its measured function count. It is excluded from comparisons.",
    );
  }
  const first = revision(before),
    last = revision(after);
  const observations = Object.values(results).filter(
    (value): value is Json => !!value,
  );
  const publicationsMatch = observations.every(
    (value) =>
      revision(value) === last &&
      value._meta?.graph_revision?.publication_unchanged_during_call === true,
  );
  const stable =
    !!first &&
    first === last &&
    !!before?.source_revision &&
    before.source_revision === after?.source_revision &&
    before?.source_unchanged_during_observation === true &&
    after?.source_unchanged_during_observation === true &&
    after?.requested_revision_matches !== false &&
    after?.requested_source_matches !== false &&
    after?.retry_query_group !== true &&
    publicationsMatch;
  const branchAligned =
    checkoutMatches(before, project) && checkoutMatches(after, project);
  const commitAligned =
    !commit || !after?.source_commit || commit === after.source_commit;
  const ready =
    typeof after?.ready === "boolean"
      ? after.ready && before?.ready === true && branchAligned && commitAligned
      : null;
  const mismatched = n(after?.mismatched_files);
  if (mismatched !== null && mismatched > 0)
    limitations.push(
      `${mismatched ?? "Some"} source files do not match the admitted index. Refresh analysis before evaluating improvements.`,
    );
  else if (ready === false)
    limitations.push(
      "Memtrace has not yet certified source/index readiness. Publication or source-proof metadata may still be settling.",
    );
  if (!stable)
    limitations.push(
      "Source/index bindings were not stable across this capture. Record another checkpoint before comparing quality.",
    );
  if (!branchAligned)
    limitations.push(
      "The source revision does not match the selected repository, checkout or branch. This checkpoint is excluded from comparisons.",
    );
  if (!commitAligned)
    limitations.push(
      "Git HEAD changed around the query boundary. Capture another aligned checkpoint before comparing.",
    );
  if (stats?.indexing_incomplete === true)
    limitations.push(
      "The repository graph reports incomplete indexing. Counts describe the admitted graph only.",
    );
  if (
    n(complex?.estimated_function_count) !== null &&
    complex!.estimated_function_count > 0
  )
    limitations.push(
      `${complex!.estimated_function_count} function metrics are estimated; the distribution uses AST-measured rows.`,
    );
  const rawFunctions = rows(complex, "functions");
  const versions = [
    ...new Set(
      rawFunctions
        .filter((row) => row.complexity_source === "ast")
        // metrics_v versions AST complexity; optional quality_metrics_v covers
        // separate Halstead/style fields and must not erase that AST basis.
        .map((row) =>
          row.metrics_v !== undefined ? `ast:${row.metrics_v}` : null,
        ),
    ),
  ];
  if (!distribution || measured === null)
    limitations.push(
      "An AST-only repository complexity distribution is unavailable. Unknown measurements remain unknown.",
    );
  const status =
    (mismatched !== null && mismatched > 0) ||
    !commitAligned ||
    (before?.branch && after?.branch && !branchAligned)
      ? "stale"
      : ready !== true ||
          failures.length ||
          summaryPending ||
          !stable ||
          !distribution ||
          measured === null ||
          stats?.indexing_incomplete === true
        ? "partial"
        : "current";
  return {
    id: randomUUID(),
    projectId: project.id,
    repoId: project.repoId!,
    branch: project.branch,
    capturedAt,
    basis: "memtrace-ast-distribution-v1",
    measurementVersion: versions.length === 1 ? versions[0] : null,
    status,
    source: {
      commit: text(after?.source_commit) || commit,
      revision: text(after?.source_revision) || null,
      dirty: stable && commitAligned ? dirty : null,
      indexReady: ready,
      files: n(after?.source_file_count),
      mismatchedFiles: mismatched,
    },
    graph: {
      revision: last,
      stable,
      indexedAt: text(stats?.last_indexed) || null,
      dataDirectory: input.scope?.dataDirectory ?? null,
      scope: input.scope?.mode ?? "unknown",
      ...(input.watch ? { watch: input.watch } : {}),
    },
    metrics: {
      nodes: n(stats?.total_nodes ?? stats?.queryable_node_count),
      edges: n(stats?.total_edges),
      symbols: n(stats?.symbol_node_count),
      files: n(stats?.nodes_by_kind?.File) ?? (ready && stable ? n(after?.indexed_file_count) : null),
      communities: n(stats?.community_count),
      processes: n(stats?.nodes_by_kind?.Process),
      measuredFunctions: measured,
      estimatedFunctions: n(complex?.estimated_function_count),
      distribution,
      deadCodeCandidates: n(dead?.total_count),
      importCycles:
        cycles?.enumeration === "complete" && cycles?.truncated !== true
          ? n(cycles.cycle_count)
          : null,
    },
    hotspots: rawFunctions
      .slice(0, 30)
      .map((row) =>
        findingFromRow(row, "complexity", project.path ?? undefined),
      ),
    deadCode: rows(dead, "results")
      .slice(0, 30)
      .map((row) =>
        findingFromRow(row, "unreachable", project.path ?? undefined),
      ),
    limitations,
    tools: Object.entries(results)
      .filter(([, value]) => !!value)
      .map(([name]) => name),
  };
}

const sections = [
  "architecture",
  "flows",
  "flow",
  "api",
  "history",
  "style",
  "governance",
  "impact",
] as const;
export function registerIntelligence(
  register: Register,
  state: () => AppState,
  projectById: (id: string) => Project,
  changed: () => Promise<void>,
  engine: MemtraceEngine,
  analyze: (projectId: string) => Promise<void>,
): void {
  const captures = new Map<string, Promise<QualitySnapshot>>();
  register(
    "intelligence:refresh",
    z.object({
      projectId: z.string().min(1).max(200),
      refreshIndex: z.boolean().optional(),
    }).strict(),
    async ({ projectId, refreshIndex }) => {
      const project = projectById(projectId);
      const key = JSON.stringify([projectId, project.path, project.branch, project.analysisCheckout]);
      const pending = captures.get(key);
      if (pending) return pending;
      const capture = captureSnapshot(
        project,
        !!refreshIndex,
        state,
        changed,
        engine,
        analyze,
      ).finally(() => captures.delete(key));
      captures.set(key, capture);
      return capture;
    },
  );
  register(
    "intelligence:query",
    z.object({
      projectId: z.string().min(1).max(200),
      section: z.enum(sections),
      input: z
        .object({
          process: z.string().max(200).optional(),
          file: z.string().max(2000).optional(),
          symbol: z.string().max(500).optional(),
        })
        .strict()
        .optional(),
    }).strict(),
    async ({ projectId, section, input }) => {
      const project = projectById(projectId);
      requireProject(project);
      return queryDetails(project, section, input ?? {}, engine);
    },
  );
}
function requireProject(project: Project) {
  if (project.example || !project.path)
    throw new Error(
      "Choose a real local project to measure its source. Example tasks are not quality evidence.",
    );
  if (!project.repoId || project.analysis !== "ready")
    throw new Error(
      "Connect this project to Memtrace before reading code intelligence.",
    );
}
async function captureSnapshot(
  project: Project,
  refreshIndex: boolean,
  state: () => AppState,
  changed: () => Promise<void>,
  engine: MemtraceEngine,
  analyze: (projectId: string) => Promise<void>,
): Promise<QualitySnapshot> {
  if (project.example || !project.path)
    throw new Error(
      "Choose a real local project before capturing a quality checkpoint.",
    );
  if (project.analysis !== "ready" || !project.repoId)
    await analyze(project.id);
  else if (refreshIndex) {
    const current = await engine.call(project, "get_query_revision", {
      repo_id: project.repoId,
      branch: project.branch,
    });
    if (!certifiedPublication(current, project, project.repoId))
      await analyze(project.id);
  }
  requireProject(project);
  const selected = project;
  project = { ...selected };
  const results: Record<string, Json | undefined> = {},
    failures: string[] = [];
  // Saved projects may still be Ready after restart while their process-local
  // watcher has stopped. Repair that lifecycle before binding this query group.
  const watch = await ensureProjectWatch(engine, project);
  if (watch.state === "unavailable")
    failures.push(
      `Live watch unavailable: ${watch.reason ?? "The engine did not confirm it."}`,
    );
  else if (watch.branch !== project.branch)
    failures.push(
      watch.reason ??
        `The live watch follows ${watch.branch}, rather than the recorded project branch ${project.branch}.`,
    );
  const call = async (key: string, name: string, args: Json) => {
    try {
      const value = await engine.call(project, name, args);
      if (value?.repo_in_store === false || value?.error)
        throw new Error(
          text(
            value?.message ?? value?.error,
            "Repository data is unavailable.",
          ),
        );
      results[key] = value;
    } catch (error) {
      failures.push(`${key}: ${(error as Error).message}`);
    }
  };
  const scope = { repo_id: project.repoId, branch: project.branch };
  await call("before", "get_query_revision", scope);
  if (results.before?.ready === false && results.before.source_revision) {
    await call("before", "get_query_revision", {
      ...scope,
      expected_source_revision: results.before.source_revision,
      wait_ms: 10000,
    });
    // Waiting can span a new graph publication. Begin the dependent group from
    // a separate, unchanged observation instead of treating that wait as stable.
    if (
      results.before?._meta?.graph_revision
        ?.publication_unchanged_during_call !== true
    )
      await call("before", "get_query_revision", {
        ...scope,
        wait_ms: 0,
      });
  }
  if (!results.before)
    throw new Error(
      failures.at(-1)?.replace(/^before: /, "") ??
        "Memtrace could not bind this report to the selected repository.",
    );
  await Promise.allSettled([
    call("stats", "get_repository_stats", scope),
    call("complex", "find_most_complex_functions", { ...scope, top_n: 30 }),
    call("dead", "find_dead_code", {
      ...scope,
      limit: 30,
      include_metadata: true,
      min_confidence: "medium",
    }),
    call("cycles", "find_import_cycles", scope),
  ]);
  // Native summaries are computed on demand. Give a cold summary a bounded
  // chance to finish alongside the source-backed quality measurements.
  for (const delay of [250, 750, 1500]) {
    const stats = results.stats;
    if (stats?.summary_current !== false || stats.summary_error) break;
    const wait = n(stats.summary_retry_after_ms);
    if (!stats.summary_refresh_in_progress && (wait === null || wait > delay)) break;
    await new Promise<void>((done) => setTimeout(done, delay));
    await call("stats", "get_repository_stats", scope);
  }
  if (!results.stats && !results.complex && !results.dead && !results.cycles)
    throw new Error(
      "Memtrace could not read source-backed quality data. Check the engine connection and try again.",
    );
  let commit: string | null = null,
    dirty: boolean | null = null;
  try {
    commit = await git(project.path!, ["rev-parse", "HEAD"]);
    dirty = !!(await git(project.path!, ["status", "--porcelain"]));
  } catch {
    failures.push(
      "Git provenance could not be read; the source fingerprint remains the primary binding.",
    );
  }
  await call("after", "get_query_revision", {
    ...scope,
    ...(results.before?.token
      ? { expected_revision: results.before.token }
      : {}),
    ...(results.before?.source_revision
      ? { expected_source_revision: results.before.source_revision }
      : {}),
    wait_ms: 0,
  });
  const snapshot = normalizeQualitySnapshot({
    project,
    capturedAt: new Date().toISOString(),
    commit,
    dirty,
    results,
    failures,
    watch,
    scope:
      typeof engine.scopeFor === "function"
        ? engine.scopeFor(project.id)
        : null,
  });
  if (Object.values(snapshot.metrics).every(value => value === null))
    throw new Error("Memtrace returned no measured quality data for this checkout. Retry the checkpoint once the graph is ready.");
  if (selected.path !== project.path || selected.branch !== project.branch ||
      selected.analysisCheckout !== project.analysisCheckout ||
      selected.repoId !== project.repoId || selected.analysis !== "ready" ||
      !state().projects.includes(selected))
    throw new Error("The local project changed during this checkpoint. Capture the current checkout again.");
  state().qualitySnapshots ??= [];
  state().qualitySnapshots.push(snapshot);
  await changed();
  return snapshot;
}

async function queryDetails(
  project: Project,
  section: IntelligenceSection,
  input: Json,
  engine: MemtraceEngine,
): Promise<IntelligenceDetail> {
  const scope = { repo_id: project.repoId, branch: project.branch },
    items: IntelligenceItem[] = [],
    notes: string[] = [],
    observations: Json[] = [];
  let graphRevision: string | null = null;
  const query = async (name: string, args: Json): Promise<Json | undefined> => {
    try {
      const value = await engine.call(project, name, args);
      graphRevision = revision(value) ?? graphRevision;
      if (value?.repo_in_store === false || value?.error)
        throw new Error(
          text(value?.message ?? value?.error, "Indexed data unavailable."),
        );
      if (value?.truncated)
        notes.push(
          `${name.replaceAll("_", " ")} is a bounded view; additional records may exist.`,
        );
      if (name !== "governing_rules") observations.push(value);
      return value;
    } catch (error) {
      notes.push(`${name.replaceAll("_", " ")}: ${(error as Error).message}`);
      return undefined;
    }
  };
  const before = await query("get_query_revision", scope);
  if (!before)
    throw new Error(
      notes.at(-1) ??
        "Memtrace could not bind this view to the selected repository.",
    );
  const source = (row: Json) => ({
    file: relativeFile(
      text(row.file_path ?? row.entry_file),
      project.path ?? undefined,
    ),
    line: n(row.start_line) ?? undefined,
  });
  const symbolItem = (row: Json, group: string): IntelligenceItem => ({
    id: text(row.node_id ?? row.id, row.name),
    title: text(row.name, "Unnamed symbol"),
    description:
      group === "Central symbols"
        ? `${row.fanin ?? "—"} inbound · ${row.fanout ?? "—"} outbound relationships`
        : text(row.kind, "Source symbol"),
    ...source(row),
    group,
    value:
      typeof row.rank_score === "number"
        ? row.rank_score.toFixed(4)
        : undefined,
  });

  const view = await {
    architecture: readArchitecture,
    flows: readFlows,
    flow: readFlow,
    api: readApi,
    history: readHistory,
    style: readStyle,
    governance: readGovernance,
    impact: readImpact,
  }[section]({
    scope,
    project,
    input,
    query,
    source,
    symbolItem,
    items,
    notes,
  });
  const after = await query("get_query_revision", {
    ...scope,
    ...(before?.token ? { expected_revision: before.token } : {}),
    ...(before?.source_revision
      ? { expected_source_revision: before.source_revision }
      : {}),
    wait_ms: 0,
  });
  const aligned =
    before?.ready === true &&
    after?.ready === true &&
    checkoutMatches(before, project) &&
    checkoutMatches(after, project) &&
    !!before?.source_revision &&
    before.source_revision === after.source_revision &&
    before?.source_unchanged_during_observation === true &&
    after?.source_unchanged_during_observation === true &&
    after?.requested_revision_matches !== false &&
    after?.requested_source_matches !== false &&
    after?.retry_query_group !== true;
  const publication = revision(after);
  if (
    !aligned ||
    !publication ||
    !observations.every(
      (value) =>
        revision(value) === publication &&
        value._meta?.graph_revision?.publication_unchanged_during_call === true,
    )
  )
    notes.unshift(
      "The source and index could not be verified as aligned throughout this view. Refresh analysis before acting on these records.",
    );
  if (!items.length)
    notes.push(
      "No source-backed rows were returned for this view. Coverage and tool limitations still apply.",
    );
  return {
    section,
    ...view,
    items,
    notes: [...new Set(notes)],
    capturedAt: new Date().toISOString(),
    graphRevision,
  };
}

interface ViewContext {
  project: Project;
  scope: Json;
  input: Json;
  items: IntelligenceItem[];
  notes: string[];
  query: (name: string, args: Json) => Promise<Json | undefined>;
  source: (row: Json) => { file: string; line: number | undefined };
  symbolItem: (row: Json, group: string) => IntelligenceItem;
}

async function readArchitecture({
  scope,
  query,
  symbolItem,
  items,
  notes,
}: ViewContext) {
  let title = "",
    summary = "";

  title = "The structure beneath the work";
  summary = "Source modules, central symbols and architectural bridges.";
  const [communities, central, bridges] = await Promise.all([
    query("list_communities", { ...scope, limit: 16 }),
    query("find_central_symbols", { ...scope, limit: 12 }),
    query("find_bridge_symbols", { ...scope, limit: 12 }),
  ]);
  for (const row of rows(communities, "communities"))
    items.push({
      id: text(row.id),
      title: text(row.name, "Module"),
      description: `${row.member_count ?? "—"} admitted symbols`,
      value:
        typeof row.cohesion === "number"
          ? `${Math.round(row.cohesion * 100)}% cohesion`
          : undefined,
      group: "Modules",
    });
  for (const row of rows(central, "results"))
    items.push(symbolItem(row, "Central symbols"));
  for (const row of rows(bridges, "results"))
    items.push(symbolItem(row, "Bridge symbols"));
  notes.push(
    "Graph centrality and cohesion describe indexed relationships. They are not a quality score.",
  );

  return { title, summary };
}

async function readFlows({ scope, query, source, items, notes }: ViewContext) {
  let title = "",
    summary = "";

  title = "How work moves through the code";
  summary = "Inferred entry points and their static call-graph neighborhoods.";
  const result = await query("list_processes", { ...scope, limit: 30 });
  for (const row of rows(result, "processes"))
    items.push({
      id: text(row.id),
      title: text(row.name ?? row.canonical_name),
      description: `${row.step_count ?? "—"} members · ${text(row.entry_point)}`,
      ...source(row),
      badge: text(row.process_type).replaceAll("_", " "),
      group: "Execution flows",
      action: "flow",
    });
  notes.push(
    "Membership and call edges are static evidence; execution order is not a runtime trace.",
  );

  return { title, summary };
}

async function readFlow({
  scope,
  input,
  query,
  source,
  items,
  notes,
}: ViewContext) {
  let title = "",
    summary = "";

  if (!input.process) throw new Error("Choose a flow to inspect.");
  const result = await query("get_process_flow", {
    ...scope,
    process: input.process,
    limit: 40,
  });
  title = text(result?.process_name, "Flow detail");
  summary = "A bounded source-backed flow neighborhood.";
  for (const row of rows(result, "steps"))
    items.push({
      id: text(row.node_id, String(row.step)),
      title: text(row.name),
      description: text(row.signature, row.kind),
      ...source(row),
      badge:
        typeof row.step === "number"
          ? String(row.step + 1).padStart(2, "0")
          : undefined,
      group: "Source members",
    });
  for (const [index, row] of rows(result?.flow_paths, "connections").entries())
    items.push({
      id: `edge-${index}`,
      title: `${row.from} → ${row.to}`,
      description: text(row.reason).replaceAll("-", " "),
      badge: text(row.rel),
      group: "Call relationships",
    });
  notes.push("The numbered member list is not a proven execution sequence.");

  return { title, summary };
}

async function readApi({ scope, query, source, items, notes }: ViewContext) {
  let title = "",
    summary = "";

  title = "The API surface";
  summary =
    "Detected endpoints and outbound calls in the selected source graph.";
  const [endpoints, calls] = await Promise.all([
    query("find_api_endpoints", { ...scope, limit: 40 }),
    query("find_api_calls", { ...scope, limit: 40 }),
  ]);
  for (const [value, key, group] of [
    [endpoints, "endpoints", "Inbound endpoints"],
    [calls, "calls", "Outbound calls"],
  ] as const)
    for (const row of rows(value, key))
      items.push({
        id: text(row.id, `${group}-${items.length}`),
        title: text(
          row.path ?? row.raw_path ?? row.url ?? row.signature,
          "Detected route",
        ),
        description: text(
          row.handler ?? row.calling_function ?? row.target_repo,
          "Static source detection",
        ),
        ...source(row),
        badge: text(row.method ?? row.http_method),
        group,
      });
  notes.push(
    "This is source-level API detection, not captured network traffic. Empty results do not prove the application has no API.",
  );

  return { title, summary };
}

async function readHistory({
  project,
  query,
  source,
  items,
  notes,
}: ViewContext) {
  let title = "",
    summary = "";

  title = "What the source remembers";
  summary = "Recent indexed changes and their measured complexity deltas.";
  const result = await query("get_daily_briefing", {
    repo_id: project.repoId,
    window_hours: 24,
  });
  for (const row of rows(result, "changed"))
    items.push({
      id: text(row.node_id, row.name),
      title: text(row.name),
      description: `Cognitive delta ${row.cognitive_delta ?? "—"} · cyclomatic delta ${row.cyclomatic_delta ?? "—"}`,
      ...source(row),
      group: "Changed functions",
    });
  for (const row of rows(result, "new_functions").slice(0, 20))
    items.push({
      id: text(row.node_id, row.name),
      title: text(row.name),
      description: `Cognitive ${row.cognitive ?? "—"} · cyclomatic ${row.cyclomatic ?? "—"}`,
      ...source(row),
      badge: "new",
      group: "New indexed functions",
    });
  for (const row of rows(result, "modules"))
    items.push({
      id: text(row.module),
      title: text(row.module),
      description: `${row.functions_touched ?? "—"} function records touched`,
      group: "Active modules",
    });
  notes.push(
    "History covers recorded indexing episodes. New or moved source can appear as additions; these are not accepted-work receipts.",
  );

  return { title, summary };
}

async function readStyle({ scope, query, source, items, notes }: ViewContext) {
  let title = "",
    summary = "";

  title = "The codebase’s own conventions";
  summary =
    "Empirical patterns observed in indexed source, without prescribing a style.";
  const result = await query("get_style_fingerprint", scope);
  for (const row of rows(result, "dominant_idioms"))
    items.push({
      id: text(row.dimension),
      title: text(row.interpretation),
      description: text(row.dimension).replaceAll("_", " "),
      value:
        typeof row.ratio === "number"
          ? `${Math.round(row.ratio * 100)}%`
          : undefined,
      group: "Dominant idioms",
    });
  for (const [language, data] of Object.entries(result?.by_language ?? {}))
    for (const row of rows(data, "dominant_idioms"))
      items.push({
        id: language + "-" + row.dimension,
        title: text(row.interpretation),
        description: `${(data as Json).function_count ?? "—"} function records`,
        value:
          typeof row.ratio === "number"
            ? `${Math.round(row.ratio * 100)}%`
            : undefined,
        group: language,
      });
  notes.push(
    "Style ratios describe available samples and are not enforced governance rules.",
  );

  return { title, summary, style: styleProfile(result) };
}

async function readGovernance({
  project,
  input,
  query,
  source,
  items,
  notes,
}: ViewContext) {
  let title = "",
    summary = "";

  const file = text(input.file, "src/shared.ts");
  if (project.path && !within(project.path, resolve(project.path, file)))
    throw new Error("Choose a source file inside this project.");
  title = "Recorded rules, close to the source";
  summary = `File-scoped decision and governance context for ${file}.`;
  const result = await query("governing_rules", {
    repo_id: project.repoId,
    file_path: file,
  });
  for (const row of rows(result, "rules"))
    items.push({
      id: text(row.id ?? row.decision_id, String(items.length)),
      title: text(row.title ?? row.name ?? row.rule, "Recorded rule"),
      description: text(row.description ?? row.rationale ?? row.content),
      badge: text(row.kind ?? row.status),
      group: "Governing rules",
    });
  if (result?.governed === false)
    notes.push(
      "No governing rule was returned for this file. That does not establish that no conventions apply.",
    );
  notes.push(
    "Decision memory has independent revisions. Source-graph publication does not certify the currency of governing rules.",
  );

  return { title, summary };
}

async function readImpact({
  scope,
  input,
  query,
  source,
  symbolItem,
  items,
  notes,
}: ViewContext) {
  let title = "",
    summary = "";

  if (!input.symbol) throw new Error("Choose a source symbol to inspect.");
  title = "Understand the blast radius";
  summary = "Observed transitive impact of the selected source symbol.";
  const result = await query("get_impact", {
    ...scope,
    target: input.symbol,
    file_path: input.file,
    direction: "upstream",
    depth: 3,
  });
  if (result?.found === false) {
    notes.push(
      "The selected declaration was not found unambiguously in the current source graph. Refresh the checkpoint before inspecting its impact.",
    );
    return { title, summary };
  }
  if (result) {
    items.push({
      id: "impact-total",
      title: `${n(result.total_affected) ?? "Unknown"} affected symbols`,
      description: text(result.risk, "Unknown risk"),
      badge:
        result.graph_incomplete || result.total_affected_is_lower_bound
          ? "lower bound"
          : "observed",
      group: "Impact summary",
    });
    const affected = Object.values(result.by_depth ?? {}).flatMap((value) =>
      rows(value, ""),
    );
    for (const row of affected.slice(0, 40))
      items.push(symbolItem(row, "Affected symbols"));
    if (
      result.graph_incomplete ||
      result.truncated ||
      result.total_affected_is_lower_bound
    )
      notes.push(
        "Reachability is incomplete; the observed impact is not a complete upper bound.",
      );
  }

  return { title, summary };
}
