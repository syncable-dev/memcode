import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../src/shared.ts";
import { initialState } from "../src/seed.ts";
import {
  comparableSnapshots,
  compareFindings,
  findingFromRow,
  qualityValue,
} from "../src/intelligence.ts";
import {
  normalizeQualitySnapshot,
  registerIntelligence,
  ensureProjectWatch,
} from "../runtime/intelligence.ts";
import { MemtraceEngine } from "../runtime/memtrace.ts";

// These are isolated protocol fixtures, never imported into a user's workspace state.
const project: Project = {
  ...initialState().projects[0],
  id: "quality-fixture",
  example: false,
  path: "C:/quality-fixture",
  repoId: "fixture",
  branch: "main",
  analysis: "ready",
};
const metadata = () => ({
  graph_revision: { token: "graph-1", publication_unchanged_during_call: true },
});
const unexpectedAnalysis = async () => { throw new Error("An aligned checkout must reuse its graph"); };
const readyWatch = async () => ({
  state: "watching" as const,
  path: project.path!,
  repoId: project.repoId!,
  branch: project.branch,
  origin: "existing" as const,
  verifiedAt: "2026-11-15T00:00:00Z",
});
const finding = (name = "work", cognitive = 31) => ({
  node_id: name,
  name,
  scope_path: name,
  file_path: "C:/quality-fixture/src/work.ts",
  start_line: 5,
  complexity_source: "ast",
  cognitive_complexity: cognitive,
  complexity: 15,
  max_nesting: 3,
  metrics_v: 3,
  quality_metrics_v: 1,
});
function fixture() {
  const boundary = () => ({
    _meta: metadata(),
    publication: { token: "graph-1" },
    token: "query-1",
    source_revision: "source-1",
    source_commit: "head-1",
    branch: "main",
    ready: true,
    source_file_count: 12,
    mismatched_files: 0,
    source_unchanged_during_observation: true,
    requested_revision_matches: true,
    requested_source_matches: true,
    retry_query_group: false,
  });
  return {
    project,
    capturedAt: "2026-11-14T00:00:00Z",
    commit: "head-1",
    dirty: true,
    failures: [] as string[],
    results: {
      before: boundary(),
      after: boundary(),
      stats: {
        _meta: metadata(),
        repo_in_store: true,
        total_nodes: 180,
        total_edges: 250,
        symbol_node_count: 100,
        community_count: 4,
        nodes_by_kind: { File: 12, Process: 3 },
        indexing_incomplete: false,
      },
      complex: {
        _meta: metadata(),
        measured_distribution: {
          simple: 80,
          moderate: 15,
          high: 4,
          critical: 1,
        },
        measured_function_count: 100,
        estimated_function_count: 0,
        functions: [finding()],
      },
      dead: {
        _meta: metadata(),
        results: [],
        total_count: 0,
        truncated: false,
      },
      cycles: {
        _meta: metadata(),
        cycle_count: 0,
        enumeration: "complete",
        truncated: false,
      },
    } as Record<string, any>,
  };
}

test("checkpoint counts use the full AST distribution, not the bounded hotspot sample", () => {
  const snapshot = normalizeQualitySnapshot(fixture());
  assert.equal(snapshot.status, "current");
  assert.equal(snapshot.hotspots.length, 1);
  assert.equal(snapshot.metrics.measuredFunctions, 100);
  assert.equal(qualityValue(snapshot, "elevated"), 5);
  assert.equal(qualityValue(snapshot, "elevatedRate"), 5);
  assert.equal(snapshot.measurementVersion, "ast:3");
  assert.equal(snapshot.hotspots[0].file, "src/work.ts");
  assert.equal(snapshot.source.dirty, true);
  assert.equal(snapshot.source.revision, "source-1");
});

test("pending repository summaries never present old graph counts as current", () => {
  const input = fixture();
  input.results.stats.summary_current = false;
  input.results.after.indexed_file_count = 12;
  const partial = normalizeQualitySnapshot(input);
  assert.equal(partial.status, "partial");
  assert.equal(partial.metrics.nodes, null);
  assert.equal(partial.metrics.edges, null);
  assert.equal(partial.metrics.files, 12);
  assert.equal(partial.metrics.measuredFunctions, 100);
  assert.match(partial.limitations.join(" "), /repository totals/);
  input.results.after.ready = false;
  assert.equal(normalizeQualitySnapshot(input).metrics.files, null);
});

test("optional Halstead metadata does not erase the declared AST complexity schema", () => {
  const input = fixture();
  const optional = finding("optional-quality", 20);
  delete (optional as Record<string, unknown>).quality_metrics_v;
  input.results.complex.functions.push(optional);
  const snapshot = normalizeQualitySnapshot(input);
  assert.equal(snapshot.measurementVersion, "ast:3");
  assert.equal(comparableSnapshots([snapshot], snapshot, "elevated").length, 1);
});

test("failed queries remain unknown while successful zero results remain zero", () => {
  const input = fixture();
  input.results.dead = undefined;
  input.results.cycles = undefined;
  input.failures = ["dead: engine unavailable", "cycles: engine unavailable"];
  const failed = normalizeQualitySnapshot(input);
  assert.equal(failed.metrics.deadCodeCandidates, null);
  assert.equal(failed.metrics.importCycles, null);
  assert.equal(failed.status, "partial");
  assert.equal(qualityValue(failed, "deadCode"), null);
  const empty = normalizeQualitySnapshot(fixture());
  assert.equal(empty.metrics.deadCodeCandidates, 0);
  assert.equal(empty.metrics.importCycles, 0);
  assert.equal(empty.deadCode.length, 0);
});

test("mixed estimates and unreconciled distributions cannot become measured repository totals", () => {
  const mixed = fixture();
  mixed.results.complex = {
    ...mixed.results.complex,
    measured_distribution: undefined,
    distribution: { simple: 90, moderate: 15, high: 4, critical: 1 },
    estimated_function_count: 10,
  };
  const snapshot = normalizeQualitySnapshot(mixed);
  assert.equal(snapshot.metrics.distribution, null);
  assert.equal(qualityValue(snapshot, "elevated"), null);
  assert.equal(snapshot.status, "partial");
  const broken = fixture();
  broken.results.complex.measured_distribution.critical = 9;
  assert.equal(normalizeQualitySnapshot(broken).metrics.distribution, null);
});

test("a publication or source change makes the capture ineligible for trends", () => {
  for (const mutate of [
    (input: ReturnType<typeof fixture>) => {
      input.results.complex._meta.graph_revision.token = "other-graph";
    },
    (input: ReturnType<typeof fixture>) => {
      input.results.dead._meta.graph_revision.publication_unchanged_during_call = false;
    },
    (input: ReturnType<typeof fixture>) => {
      input.results.after.source_revision = "edited-source";
    },
    (input: ReturnType<typeof fixture>) => {
      delete input.results.before.source_revision;
      delete input.results.after.source_revision;
    },
  ]) {
    const input = fixture();
    mutate(input);
    const snapshot = normalizeQualitySnapshot(input);
    assert.equal(snapshot.graph.stable, false);
    assert.equal(snapshot.source.dirty, null);
    assert.deepEqual(comparableSnapshots([snapshot], snapshot, "elevated"), []);
  }
});

test("stale indexes, another branch and changed HEAD are labelled rather than silently compared", () => {
  for (const mutate of [
    (input: ReturnType<typeof fixture>) => {
      input.results.after.ready = false;
      input.results.after.mismatched_files = 2;
    },
    (input: ReturnType<typeof fixture>) => {
      input.results.after.branch = "another-epic";
    },
    (input: ReturnType<typeof fixture>) => {
      input.results.after.worktree = "/some/other/checkout";
    },
    (input: ReturnType<typeof fixture>) => {
      input.results.before.repo_id = "another-repo";
    },
    (input: ReturnType<typeof fixture>) => {
      input.commit = "new-head";
    },
  ]) {
    const input = fixture();
    mutate(input);
    const snapshot = normalizeQualitySnapshot(input);
    assert.equal(snapshot.status, "stale");
    assert.equal(snapshot.source.indexReady, false);
    assert.deepEqual(comparableSnapshots([snapshot], snapshot, "elevated"), []);
  }
});

test("unproven call-degree values never masquerade as cognitive or cyclomatic complexity", () => {
  const row = findingFromRow(
    {
      name: "candidate",
      file_path: "src/a.ts",
      complexity: 200,
      score: 500,
      max_nesting: 4,
    },
    "complexity",
  );
  assert.equal(row.metricSource, "unknown");
  assert.equal(row.cognitive, null);
  assert.equal(row.cyclomatic, null);
  assert.equal(row.nesting, null);
});

test("compatible trend series isolate repository, branch, schema and missing metric values", () => {
  const baseline = normalizeQualitySnapshot(fixture());
  const latest = {
    ...structuredClone(baseline),
    id: "later",
    capturedAt: "2026-11-15T00:00:00Z",
  };
  const otherProject = { ...structuredClone(baseline), projectId: "other" };
  const otherBranch = { ...structuredClone(baseline), branch: "feature" };
  const otherRepo = { ...structuredClone(baseline), repoId: "other" };
  const otherSchema = {
    ...structuredClone(baseline),
    measurementVersion: "4:2",
  };
  const missing = structuredClone(baseline);
  missing.metrics.deadCodeCandidates = null;
  const points = comparableSnapshots(
    [
      latest,
      otherProject,
      otherBranch,
      otherRepo,
      otherSchema,
      missing,
      baseline,
    ],
    latest,
    "deadCode",
  );
  assert.deepEqual(
    points.map((point) => point.id),
    [baseline.id, latest.id],
  );
  const unknownSchema = {
    ...structuredClone(latest),
    measurementVersion: null,
  };
  assert.equal(
    comparableSnapshots([unknownSchema], unknownSchema, "elevated").length,
    0,
  );
});

test("growth is visible in measured scope and rate; a missing hotspot is never counted as repaired", () => {
  const beforeInput = fixture();
  beforeInput.results.complex.functions.push(finding("disappears", 50));
  const before = normalizeQualitySnapshot(beforeInput);
  const afterInput = fixture();
  afterInput.results.complex.functions = [finding("work", 20)];
  afterInput.results.complex.measured_function_count = 200;
  afterInput.results.complex.measured_distribution.simple = 180;
  const after = normalizeQualitySnapshot(afterInput);
  assert.equal(qualityValue(after, "elevated"), 5);
  assert.equal(qualityValue(after, "elevatedRate"), 2.5);
  const changes = compareFindings(before, after);
  assert.deepEqual(
    changes.map((change) => [change.finding.name, change.delta]),
    [["work", -11]],
  );
  assert.deepEqual(
    compareFindings(before, { ...after, repoId: "another" }),
    [],
  );
});

test("different aligned commits remain comparable, while a repeated observation reports zero change", () => {
  const first = normalizeQualitySnapshot(fixture());
  const nextInput = fixture();
  nextInput.commit = "head-2";
  nextInput.results.before.source_commit = "head-2";
  nextInput.results.after.source_commit = "head-2";
  nextInput.results.before.source_revision = "source-2";
  nextInput.results.after.source_revision = "source-2";
  nextInput.capturedAt = "2026-11-15T00:00:00Z";
  const next = normalizeQualitySnapshot(nextInput);
  assert.equal(next.status, "current");
  assert.equal(comparableSnapshots([first, next], next, "elevated").length, 2);
  assert.equal(
    qualityValue(next, "elevated")! - qualityValue(first, "elevated")!,
    0,
  );
  assert.deepEqual(
    compareFindings(first, next).map((change) => change.delta),
    [0],
  );
});

test("a settling publication is read again before opening the dependent capture group", async () => {
  const state = initialState();
  state.projects = [project];
  state.qualitySnapshots = [];
  const handlers = new Map<string, (input: unknown) => Promise<any>>(),
    input = fixture(),
    boundaries: Record<string, any>[] = [];
  delete input.results.before.source_commit;
  delete input.results.after.source_commit;
  const engine = {
    watch: readyWatch,
    call: async (
      _project: Project,
      name: string,
      args: Record<string, any>,
    ) => {
      if (name === "get_query_revision") {
        boundaries.push(args);
        const revision = structuredClone(input.results.after);
        if (boundaries.length === 1) revision.ready = false;
        if (boundaries.length === 2)
          revision._meta.graph_revision.publication_unchanged_during_call = false;
        return revision;
      }
      return structuredClone(
        name === "get_repository_stats"
          ? input.results.stats
          : name === "find_most_complex_functions"
            ? input.results.complex
            : name === "find_dead_code"
              ? input.results.dead
              : input.results.cycles,
      );
    },
  } as unknown as MemtraceEngine;
  registerIntelligence(
    (name, schema, handler) =>
      handlers.set(name, async (args) => handler(schema.parse(args))),
    () => state,
    () => project,
    async () => {},
    engine, unexpectedAnalysis,
  );
  const snapshot = await handlers.get("intelligence:refresh")!({
    projectId: project.id,
  });
  assert.equal(boundaries.length, 4);
  assert.equal(boundaries[1].wait_ms, 10000);
  assert.equal(boundaries[1].expected_source_revision, "source-1");
  assert.equal(boundaries[2].wait_ms, 0);
  assert.equal(snapshot.graph.stable, true);
  assert.equal(snapshot.source.indexReady, true);
});

test("Insights and Improve share one branch-bound capture and retry its cold summary without indexing", async () => {
  const selected = { ...project, path: process.cwd(), branch: "epic/review" };
  const state = initialState();
  state.projects = [selected];
  state.qualitySnapshots = [];
  const data = fixture().results;
  const revision = {
    ...data.after, repo_id: selected.repoId, worktree: selected.path,
    branch: selected.branch, source_commit: undefined, status: "complete",
    publication: { status: "published", token: "graph-1" },
  };
  let summaries = 0;
  const calls: string[] = [];
  const engine = {
    watch: async () => ({ ...await readyWatch(), branch: selected.branch }),
    call: async (_selected: Project, name: string, args: Record<string, unknown>) => {
      assert.equal(args.repo_id, selected.repoId);
      assert.equal(args.branch, selected.branch);
      calls.push(name);
      if (name === "get_query_revision") return revision;
      if (name === "get_repository_stats") {
        summaries++;
        return summaries === 1
          ? { ...data.stats, total_nodes: 999, summary_current: false, summary_refresh_in_progress: true }
          : { ...data.stats, summary_current: true };
      }
      if (name === "find_most_complex_functions") return data.complex;
      if (name === "find_dead_code") return data.dead;
      if (name === "find_import_cycles") return data.cycles;
      if (name === "get_style_fingerprint") return { _meta: metadata(), dominant_idioms: [] };
      throw new Error("Unexpected engine operation " + name);
    }
  } as unknown as MemtraceEngine;
  const handlers = new Map<string, (input: unknown) => Promise<any>>();
  registerIntelligence(
    (name, schema, handler) => handlers.set(name, async (input) => handler(schema.parse(input))),
    () => state, () => selected, async () => {}, engine, unexpectedAnalysis,
  );
  const capture = handlers.get("intelligence:refresh")!;
  const [insights, improve] = await Promise.all([
    capture({ projectId: selected.id, refreshIndex: true }), capture({ projectId: selected.id }),
  ]);
  assert.equal(summaries, 2);
  assert.equal(insights.id, improve.id);
  assert.equal(state.qualitySnapshots.length, 1);
  assert.equal(insights.status, "current");
  assert.equal(insights.metrics.nodes, 180);
  const view = await handlers.get("intelligence:query")!({ projectId: selected.id, section: "style" });
  assert.doesNotMatch(view.notes.join(" "), /could not be verified/);
  assert.deepEqual(calls.slice(-3), ["get_query_revision", "get_style_fingerprint", "get_query_revision"]);
  await assert.rejects(capture({ projectId: selected.id, branch: "wrong" }), /Unrecognized key/);
});

test("concurrent checkpoint captures coalesce and examples cannot produce quality evidence", async () => {
  const state = initialState();
  state.projects = [project];
  state.qualitySnapshots = [];
  const handlers = new Map<string, (input: unknown) => Promise<any>>();
  const data = fixture();
  delete data.results.before.source_commit;
  delete data.results.after.source_commit;
  let reads = 0;
  const engine = {
    watch: readyWatch,
    call: async (_project: Project, name: string) => {
      reads++;
      await new Promise((resolve) => setImmediate(resolve));
      return structuredClone(
        name === "get_query_revision"
          ? data.results.after
          : name === "get_repository_stats"
            ? data.results.stats
            : name === "find_most_complex_functions"
              ? data.results.complex
              : name === "find_dead_code"
                ? data.results.dead
                : data.results.cycles,
      );
    },
  } as unknown as MemtraceEngine;
  registerIntelligence(
    (name, schema, handler) =>
      handlers.set(name, async (input) => handler(schema.parse(input))),
    () => state,
    () => state.projects[0],
    async () => {},
    engine, unexpectedAnalysis,
  );
  const refresh = handlers.get("intelligence:refresh")!;
  const [first, second] = await Promise.all([
    refresh({ projectId: project.id }),
    refresh({ projectId: project.id }),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(state.qualitySnapshots.length, 1);
  assert.equal(reads, 6);
  state.projects[0] = { ...project, example: true };
  await assert.rejects(
    refresh({ projectId: project.id }),
    /real local project/,
  );
  assert.equal(state.qualitySnapshots.length, 1);
  await assert.rejects(
    handlers.get("intelligence:query")!({
      projectId: project.id,
      section: "impact",
      input: { arbitraryCommand: "anything" },
    }),
    /Unrecognized key/,
  );
});

test("a capture cannot save an empty report or a result for a checkout that changed while reading", async () => {
  for (const rebind of [false, true]) {
    const selected = { ...project, path: process.cwd() };
    const state = initialState();
    state.projects = [selected];
    state.qualitySnapshots = [];
    const data = fixture().results;
    delete data.after.source_commit;
    const engine = {
      watch: readyWatch,
      call: async (_project: Project, name: string) => {
        if (name === "get_query_revision") return data.after;
        if (rebind && name === "get_repository_stats") {
          selected.path = selected.path + "-replacement";
          return data.stats;
        }
        return {};
      },
    } as unknown as MemtraceEngine;
    const handlers = new Map<string, (input: unknown) => Promise<any>>();
    registerIntelligence(
      (name, schema, handler) => handlers.set(name, async (input) => handler(schema.parse(input))),
      () => state, () => selected, async () => {}, engine, unexpectedAnalysis,
    );
    await assert.rejects(
      handlers.get("intelligence:refresh")!({ projectId: selected.id }),
      rebind ? /project changed/ : /no measured quality data/,
    );
    assert.equal(state.qualitySnapshots.length, 0);
  }
});

test("a ready project after restart reattaches its native watch before checkpoint queries without reindexing", async (t) => {
  const selected = { ...project, path: process.cwd() },
    state = initialState(),
    data = fixture();
  state.projects = [selected];
  state.qualitySnapshots = [];
  delete data.results.before.source_commit;
  delete data.results.after.source_commit;
  const engine = new MemtraceEngine(() => "unused-protocol-fixture"),
    calls: string[] = [];
  let watching = false;
  engine.call = async (_project, name) => {
    calls.push(name);
    if (name === "list_watched_paths")
      return {
        watches: watching
          ? [
              {
                path: selected.path,
                repo_id: selected.repoId,
                branch: selected.branch,
              },
            ]
          : [],
      };
    if (name === "watch_directory") {
      watching = true;
      return { ok: true };
    }
    assert.equal(
      watching,
      true,
      "The native watch must be confirmed before the query group starts",
    );
    assert.notEqual(
      name,
      "index_directory",
      "A ready project's checkpoint does not force a full index",
    );
    return structuredClone(
      name === "get_query_revision"
        ? data.results.after
        : name === "get_repository_stats"
          ? data.results.stats
          : name === "find_most_complex_functions"
            ? data.results.complex
            : name === "find_dead_code"
              ? data.results.dead
              : data.results.cycles,
    );
  };
  engine.analyze = async () => {
    throw Error("Do not reindex a ready project to restore its watcher");
  };
  t.after(() => engine.close());
  const handlers = new Map<string, (input: unknown) => Promise<any>>();
  registerIntelligence(
    (name, schema, handler) =>
      handlers.set(name, async (input) => handler(schema.parse(input))),
    () => state,
    () => selected,
    async () => {},
    engine, unexpectedAnalysis,
  );
  const capture = handlers.get("intelligence:refresh")!;
  const snapshot = await capture({
    projectId: selected.id,
    refreshIndex: false,
  });
  assert.equal(snapshot.status, "current");
  assert.equal(snapshot.source.indexReady, true);
  assert.equal(snapshot.graph.stable, true);
  assert.equal(snapshot.graph.watch.state, "watching");
  assert.equal(snapshot.graph.watch.branch, "main");
  assert.ok(
    calls.indexOf("watch_directory") < calls.indexOf("get_query_revision"),
  );
  await capture({ projectId: selected.id, refreshIndex: false });
  assert.equal(
    calls.filter((name) => name === "watch_directory").length,
    1,
    "Existing native watches are reused",
  );
  assert.equal(calls.includes("index_directory"), false);
});

test("an unavailable native watcher remains visible while independently aligned source stays measured", async (t) => {
  const selected = { ...project, path: process.cwd() },
    state = initialState(),
    data = fixture();
  state.projects = [selected];
  state.qualitySnapshots = [];
  delete data.results.before.source_commit;
  delete data.results.after.source_commit;
  const engine = new MemtraceEngine(() => "unused-protocol-fixture");
  engine.call = async (_project, name) => {
    if (name === "list_watched_paths") return { watches: [] };
    if (name === "watch_directory")
      throw Error("This volume cannot provide file notifications");
    return structuredClone(
      name === "get_query_revision"
        ? data.results.after
        : name === "get_repository_stats"
          ? data.results.stats
          : name === "find_most_complex_functions"
            ? data.results.complex
            : name === "find_dead_code"
              ? data.results.dead
              : data.results.cycles,
    );
  };
  t.after(() => engine.close());
  const handlers = new Map<string, (input: unknown) => Promise<any>>();
  registerIntelligence(
    (name, schema, handler) =>
      handlers.set(name, async (input) => handler(schema.parse(input))),
    () => state,
    () => selected,
    async () => {},
    engine, unexpectedAnalysis,
  );
  const snapshot = await handlers.get("intelligence:refresh")!({
    projectId: selected.id,
  });
  assert.equal(snapshot.graph.watch.state, "unavailable");
  assert.match(snapshot.graph.watch.reason, /file notifications/);
  assert.equal(snapshot.source.indexReady, true);
  assert.equal(snapshot.graph.stable, true);
  assert.equal(snapshot.status, "partial");
  assert.ok(
    snapshot.limitations.some((note: string) =>
      note.includes("Live watch unavailable"),
    ),
  );
});

test("watch diagnostics preserve branch and old checkpoints do not invent a verified watcher", async () => {
  const observed = await ensureProjectWatch(
    {
      watch: async () => ({
        ...(await readyWatch()),
        branch: "epic/other",
        reason: "The checkout changed branches.",
      }),
    },
    project,
  );
  assert.equal(observed.branch, "epic/other");
  assert.match(observed.reason!, /changed branches/);
  const old = normalizeQualitySnapshot(fixture());
  assert.equal(old.graph.watch, undefined);
});
