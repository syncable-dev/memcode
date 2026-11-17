import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../src/shared";
import type { StoryReviewCapture } from "../runtime/code-review-snapshot";
import { analyzeStoryReview } from "../runtime/code-review-analysis";

async function run(worktree?: string, nativeGraph?: unknown) {
  const path =
    process.platform === "win32" ? "C:/fixture/epic-a" : "/fixture/epic-a";
  const project: Project = {
    id: "a",
    name: "Epic A",
    description: "",
    path,
    branch: "epic/a",
    repoId: "repo",
    analysis: "ready",
    createdAt: "2026-11-17T12:00:00Z",
  };
  const graph = { token: "published", publication_unchanged_during_call: true };
  const envelope = arguments.length > 1 ? nativeGraph : graph;
  const meta = { _meta: { graph_revision: envelope }, graph_revision: graph };
  const capture: StoryReviewCapture = {
    snapshot: {
      id: "snapshot",
      branch: project.branch,
      commit: "commit",
      patchHash: "patch",
      journalRevision: "journal",
      sourceRevision: null,
      graphRevision: null,
      files: [{ path: "src/main.ts", attribution: "reservation" }],
      additions: 1,
      deletions: 1,
    },
    patch:
      "diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-return 1;\n+return 2;\n",
    baseFiles: { "src/main.ts": "return 1;\n" },
    implementationRunIds: ["worker"],
    limitations: [],
    sourceBinding: "source",
  };
  const responses: Record<string, unknown> = {
    get_query_revision: {
      ready: true,
      repo_id: project.repoId,
      branch: project.branch,
      worktree: worktree ?? path,
      source_revision: "source",
      token: "query",
      source_unchanged_during_observation: true,
      ...meta,
    },
    find_code_review_issues: {
      _workflow: "deterministic_code_review",
      _policy: "memtrace_review_confidence_v1",
      _review_mode: "online",
      _graph_state: "ready",
      issues: [],
      ...meta,
    },
    detect_changes: {
      changed_files: [
        {
          file_path: "src/main.ts",
          matched: true,
          affected_symbols: [
            { id: "fn", name: "main", kind: "Function", start_line: 1 },
          ],
        },
      ],
      ...meta,
    },
    get_function_quality_metrics: {
      matches: 1,
      function: {
        name: "main",
        file_path: "src/main.ts",
        start_line: 1,
        complexity: 1,
        cognitive_complexity: 0,
        max_nesting: 0,
        complexity_source: "ast",
        quality_metrics_v: 1,
        maintainability_index: 100,
        halstead_volume: 0,
        risk_level: "low",
      },
      ...meta,
    },
    get_impact: {
      found: true,
      risk: "LOW",
      total_affected: 0,
      by_depth: {},
      affected_files: [],
      affected_processes: [],
      ...meta,
    },
  };
  return analyzeStoryReview(
    { call: async (_project, name) => responses[name] },
    project,
    capture,
    async () => {},
    () => {},
  );
}

test(
  "review accepts native Windows extended checkout paths without losing zero measurements",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const result = await run("//?/C:/fixture/epic-a");
    assert.deepEqual(result.limitations, []);
    assert.equal(result.metrics[0].cognitive, 0);
    assert.equal(result.metrics[0].maintainabilityIndex, 100);
    assert.equal(result.impact.symbols, 0);
    assert.equal(result.impact.complete, true);
  },
);

test("a same-name repo in another epic never certifies this review", async () => {
  const result = await run(
    process.platform === "win32" ? "//?/C:/fixture/epic-b" : "/fixture/epic-b",
  );
  assert.ok(result.limitations.some((note) => note.includes("exact checkout")));
  assert.equal(result.impact.complete, false);
});

for (const value of [null, undefined, false, "invalid", 0]) {
  test(`review rejects explicit malformed native graph envelope (${String(value)}) despite older success metadata`, async () => {
    const result = await run(undefined, value);
    assert.ok(
      result.limitations.some((note) =>
        note.includes("could not be certified"),
      ),
    );
    assert.equal(result.impact.complete, false);
  });
}
