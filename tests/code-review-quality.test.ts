import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { compareCapturedQuality as captureQuality } from "../runtime/code-review-quality";
import type { StoryReviewCapture } from "../runtime/code-review-snapshot";
import type { CodeReviewMetric } from "../src/code-review";
import type { Project } from "../src/shared";
import { analyzeStoryReview } from "../runtime/code-review-analysis";
const compareCapturedQuality = async (
  ...args: Parameters<typeof captureQuality>
) => (await captureQuality(...args)).metrics;

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function capture(before: string, after: string): StoryReviewCapture {
  return {
    snapshot: {
      id: "snapshot",
      patchHash: "patch",
      journalRevision: "journal",
      branch: "epic/a",
      commit: "commit",
      sourceRevision: null,
      graphRevision: null,
      files: [
        {
          path: "src/main.ts",
          beforeHash: hash(before),
          afterHash: hash(after),
          attribution: "reservation",
        },
      ],
      additions: 1,
      deletions: 1,
    },
    patch: createTwoFilesPatch("a/src/main.ts", "b/src/main.ts", before, after),
    baseFiles: { "src/main.ts": before },
    implementationRunIds: ["worker"],
    limitations: [],
    sourceBinding: "binding",
  };
}
const metric = (symbol = "main"): CodeReviewMetric => ({
  symbol,
  path: "src/main.ts",
  line: 1,
  cognitive: 8,
  cyclomatic: 4,
  nesting: 3,
  maintainabilityIndex: 50,
  halsteadVolume: 100,
  source: "ast",
});
const row = (name: string, start: number, end: number, overrides = {}) => ({
  name,
  scope_path: name,
  kind: "Function",
  start_line: start,
  end_line: end,
  complexity: 1,
  cognitive_complexity: 0,
  max_nesting: 0,
  maintainability_index: 100,
  halstead_volume: 0,
  metrics_v: 3,
  quality_metrics_v: 1,
  complexity_source: "ast",
  ...overrides,
});
function engine(
  before: string,
  beforeRows: ReturnType<typeof row>[],
  afterRows: ReturnType<typeof row>[],
  alter?: (answer: any, args: any) => void,
) {
  const calls: any[] = [];
  return {
    calls,
    call: async (name: string, args: any) => {
      calls.push({ name, ...args });
      const answer = {
        _workflow: "immutable_source_quality_v1",
        source_sha256: hash(args.source_content),
        source_bytes: Buffer.byteLength(args.source_content),
        file_path: args.file_path,
        metrics_version: 3,
        quality_metrics_version: 1,
        truncated: false,
        functions: (args.source_content === before
          ? beforeRows
          : afterRows
        ).map((row) => ({ ...row, file_path: args.file_path })),
        matches:
          args.source_content === before ? beforeRows.length : afterRows.length,
      };
      alter?.(answer, args);
      return answer;
    },
  };
}
test("compares exact immutable before and after with genuine zero values", async () => {
  const before = "function main() {\n if (true) { return 1; }\n}\n",
    after = "function main() {\n return 2;\n}\n";
  const native = engine(
    before,
    [
      row("main", 1, 3, {
        cognitive_complexity: 1,
        complexity: 2,
        max_nesting: 1,
        maintainability_index: 55,
      }),
    ],
    [row("main", 1, 3, { maintainability_index: 0 })],
  );
  const [value] = await compareCapturedQuality(
    capture(before, after),
    [metric()],
    native.call,
    { repo_id: "repo", branch: "epic/a" },
  );
  assert.equal(value.comparison?.status, "matched");
  assert.equal(value.before?.cognitive, 1);
  assert.equal(value.before?.maintainabilityIndex, 55);
  assert.equal(value.cognitive, 0);
  assert.equal(value.maintainabilityIndex, 0);
  assert.equal(value.comparison?.beforeSourceHash, hash(before));
  assert.equal(value.comparison?.afterSourceHash, hash(after));
  assert.deepEqual(
    native.calls.map((call) => call.source_content),
    [before, after],
  );
  assert(
    native.calls.every(
      (call) =>
        call.name === "get_function_quality_metrics" &&
        call.function_name === "*",
    ),
  );
});
test("uses projected baseline hashes and preserves disjoint peer code on both sides", async () => {
  const peer = "function peer() { return 42; }\n\n\n\n";
  const before = peer + "function main() { return 1; }\n",
    after = peer + "function main() { return 2; }\n";
  const snapshot = capture(before, after);
  snapshot.snapshot.files[0].beforeHash = hash("original own baseline");
  snapshot.snapshot.files[0].afterHash = hash("original own result");
  snapshot.snapshot.files[0].projection = {
    method: "unique-exact-context",
    baselineHash: hash(before),
    currentHash: hash(after),
    hunks: 1,
    journalSegments: 2,
  };
  const native = engine(
    before,
    [row("peer", 1, 1), row("main", 5, 5)],
    [row("peer", 1, 1), row("main", 5, 5)],
  );
  const values = await compareCapturedQuality(
    snapshot,
    [metric()],
    native.call,
    {},
  );
  assert.equal(values.length, 1);
  assert.equal(values[0].comparison?.status, "matched");
  assert(native.calls.every((call) => call.source_content.includes(peer)));
});

test("quality excludes verified untouched graph callers while keeping unresolved metric rows visible", async () => {
  const before =
    "function main(){return 1;}\nfunction caller(){return main();}\n";
  const after =
    "function main(){return 2;}\nfunction caller(){return main();}\n";
  const native = engine(
    before,
    [row("main", 1, 1), row("caller", 2, 2)],
    [row("main", 1, 1), row("caller", 2, 2)],
  );
  const values = await compareCapturedQuality(
    capture(before, after),
    [metric(), metric("caller"), metric("unresolved")],
    native.call,
    {},
  );
  assert.deepEqual(
    values.map((value) => value.symbol),
    ["main", "unresolved"],
  );
  assert.equal(values[0].comparison?.status, "matched");
  assert.equal(values[1].comparison?.status, "unavailable");
});

test("verified untouched context rows release the budget before changed-only rows are added", async () => {
  const unchanged = Array.from(
    { length: 24 },
    (_, i) => `function context${i}(){return ${i};}\n`,
  ).join("");
  const before = unchanged,
    after = unchanged + "function own(){return 42;}\n";
  const context = Array.from({ length: 24 }, (_, i) =>
    row(`context${i}`, i + 1, i + 1),
  );
  const native = engine(before, context, [...context, row("own", 25, 25)]);
  const result = await captureQuality(
    capture(before, after),
    Array.from({ length: 24 }, (_, i) => metric(`context${i}`)),
    native.call,
    {},
  );
  assert.deepEqual(
    result.metrics.map((value) => value.symbol),
    ["own"],
  );
  assert.equal(result.metrics[0].comparison?.status, "added");
  assert.equal(result.coverage.omittedFunctions, 0);
});
test("added and removed functions are measured separately without a zero baseline", async () => {
  const added = "function main() { return 1; }\n";
  const addEngine = engine("", [], [row("main", 1, 1)]);
  const [add] = await compareCapturedQuality(
    capture("", added),
    [],
    addEngine.call,
    {},
  );
  assert.equal(add.comparison?.status, "added");
  assert.equal(add.before, undefined);
  assert.equal(add.cognitive, 0);
  const removeEngine = engine(
    added,
    [row("main", 1, 1, { cognitive_complexity: 5 })],
    [],
  );
  const [remove] = await compareCapturedQuality(
    capture(added, ""),
    [],
    removeEngine.call,
    {},
  );
  assert.equal(remove.comparison?.status, "removed");
  assert.equal(remove.cognitive, null);
  assert.equal(remove.before?.cognitive, 5);
});
test("duplicate exact scopes and possible renames never become matched pairs", async () => {
  const before =
      "function main() { return 1; }\nfunction main() { return 3; }\n",
    after = "function main() { return 2; }\nfunction main() { return 3; }\n";
  const native = engine(
    before,
    [row("main", 1, 1), row("main", 2, 2)],
    [row("main", 1, 1), row("main", 2, 2)],
  );
  const duplicate = await compareCapturedQuality(
    capture(before, after),
    [metric()],
    native.call,
    {},
  );
  assert.equal(duplicate[0].comparison?.status, "ambiguous");
  assert.equal(duplicate[0].before, undefined);
  const old = "function oldName() { return 1; }\n",
    renamed = "function newName() { return 2; }\n";
  const renameEngine = engine(
    old,
    [row("oldName", 1, 1)],
    [row("newName", 1, 1)],
  );
  const values = await compareCapturedQuality(
    capture(old, renamed),
    [],
    renameEngine.call,
    {},
  );
  assert.equal(values.length, 2);
  assert(values.every((value) => value.comparison?.status === "ambiguous"));
});
test("mismatched hashes, definitions and incomplete native output remain unavailable", async () => {
  const before = "function main(){return 1;}\n",
    after = "function main(){return 2;}\n";
  for (const alter of [
    (answer: any) => {
      answer.source_sha256 = hash("foreign");
    },
    (answer: any, args: any) => {
      if (args.source_content === after) answer.metrics_version = 99;
    },
    (answer: any) => {
      answer.truncated = true;
    },
    (answer: any) => {
      answer.functions[0] = { ...answer.functions[0], start_line: 0 };
    },
  ]) {
    const native = engine(
      before,
      [row("main", 1, 1)],
      [row("main", 1, 1)],
      alter,
    );
    const [value] = await compareCapturedQuality(
      capture(before, after),
      [metric()],
      native.call,
      {},
    );
    assert.equal(value.comparison?.status, "unavailable");
    assert.equal(value.before, undefined);
    assert.equal(value.cognitive, 8);
  }
  const broken = capture(before, after);
  broken.snapshot.files[0].beforeHash = hash("tampered");
  const native = engine(before, [row("main", 1, 1)], [row("main", 1, 1)]);
  const [value] = await compareCapturedQuality(
    broken,
    [metric()],
    native.call,
    {},
  );
  assert.equal(value.comparison?.status, "unavailable");
  assert.equal(native.calls.length, 0);
});
test("old engines keep current measurements and report the missing capability", async () => {
  const before = "function main(){return 1;}\n",
    after = "function main(){return 2;}\n";
  const [value] = await compareCapturedQuality(
    capture(before, after),
    [metric()],
    async () => ({ function: row("main", 1, 1), matches: 1 }),
    {},
  );
  assert.equal(value.comparison?.status, "unavailable");
  assert.match(value.comparison!.reason!, /does not support immutable/);
  assert.equal(value.cognitive, 8);
  assert.equal(value.before, undefined);
});
test("missing AST measurements stay unknown even when the declaration matches", async () => {
  const before = "function main(){return 1;}\n",
    after = "function main(){return 2;}\n";
  const native = engine(
    before,
    [row("main", 1, 1, { complexity_source: "unavailable", complexity: null })],
    [row("main", 1, 1)],
  );
  const [value] = await compareCapturedQuality(
    capture(before, after),
    [metric()],
    native.call,
    {},
  );
  assert.equal(value.comparison?.status, "unavailable");
  assert.equal(value.before?.cyclomatic, null);
});

test("comparison budgets report omitted files and removed functions explicitly", async () => {
  const before = "function main(){return 1;}\n",
    after = "function main(){return 2;}\n";
  const many = capture(before, after);
  many.snapshot.files = [];
  many.baseFiles = {};
  many.patch = "";
  for (let i = 0; i < 25; i++) {
    const path = `src/file${i}.ts`;
    many.snapshot.files.push({
      path,
      beforeHash: hash(before),
      afterHash: hash(after),
      attribution: "reservation",
    });
    many.baseFiles[path] = before;
    many.patch += createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after);
  }
  const fileEngine = engine(before, [row("main", 1, 1)], [row("main", 1, 1)]);
  const files = await captureQuality(many, [], fileEngine.call, {});
  assert.equal(files.coverage.omittedFiles, 1);
  assert.equal(files.coverage.filesMeasured, 24);
  assert.match(files.coverage.notes.join(" "), /24-file comparison budget/);
  const oldSource = Array.from(
    { length: 25 },
    (_, i) => `function f${i}(){return 1;}\n`,
  ).join("");
  const newSource = Array.from(
    { length: 24 },
    (_, i) => `function f${i}(){return 2;}\n`,
  ).join("");
  const native = engine(
    oldSource,
    Array.from({ length: 25 }, (_, i) => row(`f${i}`, i + 1, i + 1)),
    Array.from({ length: 24 }, (_, i) => row(`f${i}`, i + 1, i + 1)),
  );
  const functions = await captureQuality(
    capture(oldSource, newSource),
    Array.from({ length: 24 }, (_, i) => metric(`f${i}`)),
    native.call,
    {},
  );
  assert.equal(functions.coverage.omittedFunctions, 1);
  assert.match(
    functions.coverage.notes.join(" "),
    /24-function comparison budget/,
  );
  assert.equal(functions.metrics.length, 24);
});

test("missing source capability never issues expensive wildcard graph queries", async () => {
  const before = "function main(){return 1;}\n",
    after = "function main(){return 2;}\n";
  let called = false;
  const result = await captureQuality(
    capture(before, after),
    [metric()],
    async () => {
      called = true;
      throw Error("must not call");
    },
    {},
    false,
  );
  assert.equal(called, false);
  assert.equal(result.coverage.filesUnavailable, 1);
  assert.equal(result.metrics[0].comparison?.status, "unavailable");
});

test("source comparison integrates inside certified review boundaries while capability reads stay graph-free", async () => {
  const before = "function main(){if(true)return 1;return 0;}\n",
    after = "function main(){return 2;}\n";
  const path =
    process.platform === "win32" ? "C:/fixture/epic-a" : "/fixture/epic-a";
  const project: Project = {
    id: "p",
    name: "Epic A",
    description: "",
    path,
    repoId: "repo",
    branch: "epic/a",
    analysis: "ready",
    createdAt: "2026-11-17T12:00:00Z",
  };
  const meta = {
    _meta: {
      graph_revision: {
        token: "graph",
        publication_unchanged_during_call: true,
      },
    },
  };
  const native = engine(
    before,
    [
      row("main", 1, 1, {
        cognitive_complexity: 1,
        complexity: 2,
        max_nesting: 1,
      }),
    ],
    [row("main", 1, 1)],
  );
  const calls: string[] = [];
  const result = await analyzeStoryReview(
    {
      call: async (_project, name, args) => {
        calls.push(name);
        if (name === "get_checkout_capabilities")
          return { source_quality_v1: true };
        if (name === "get_query_revision")
          return {
            ready: true,
            repo_id: "repo",
            branch: "epic/a",
            worktree: path,
            source_revision: "revision",
            source_unchanged_during_observation: true,
            token: "query",
            ...meta,
          };
        if (name === "find_code_review_issues")
          return {
            _workflow: "deterministic_code_review",
            _policy: "memtrace_review_confidence_v1",
            _review_mode: "online",
            _graph_state: "ready",
            issues: [],
            ...meta,
          };
        if (name === "detect_changes")
          return {
            changed_files: [
              {
                file_path: "src/main.ts",
                matched: true,
                affected_symbols: [
                  { id: "main", name: "main", kind: "Function", start_line: 1 },
                ],
              },
            ],
            ...meta,
          };
        if (name === "get_function_quality_metrics")
          return args.source_content !== undefined
            ? { ...(await native.call(name, args)), ...meta }
            : {
                function: { ...row("main", 1, 1), file_path: "src/main.ts" },
                matches: 1,
                ...meta,
              };
        if (name === "get_impact")
          return {
            found: true,
            total_affected: 0,
            by_depth: {},
            affected_files: [],
            affected_processes: [],
            ...meta,
          };
        throw Error(`Unexpected tool ${name}`);
      },
    },
    project,
    capture(before, after),
    async () => {},
    () => {},
  );
  assert.deepEqual(result.limitations, []);
  assert.equal(result.metrics[0].comparison?.status, "matched");
  assert.equal(result.metrics[0].before?.cognitive, 1);
  assert.equal(result.metrics[0].cognitive, 0);
  assert.deepEqual(result.qualityComparison, {
    filesMeasured: 1,
    filesUnavailable: 0,
    omittedFiles: 0,
    omittedFunctions: 0,
    notes: [],
  });
  assert.equal(
    calls.filter((name) => name === "get_checkout_capabilities").length,
    1,
  );
  assert.equal(result.sourceRevision, "revision");
});
