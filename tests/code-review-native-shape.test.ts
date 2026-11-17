import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../src/shared";
import type { StoryReviewCapture } from "../runtime/code-review-snapshot";
import { analyzeStoryReview } from "../runtime/code-review-analysis";

const stableGraph = {
  token: "published",
  publication_unchanged_during_call: true,
};
async function run(
  worktree?: string,
  nativeGraph?: unknown,
  alter?: (name: string, value: any) => any,
  recoverPublication?: (sourceRevision: string) => Promise<void>,
) {
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
    {
      call: async (_project, name) =>
        alter ? alter(name, structuredClone(responses[name])) : responses[name],
    },
    project,
    capture,
    async () => {},
    () => {},
    recoverPublication,
  );
}

const supportedDetector = {
  status: "evaluated_with_limitations",
  candidate_fields: 0,
  source_files_read: 0,
  source_files_unavailable: 0,
  source_file_limit: 64,
  source_budget_reached: false,
  requires:
    "indexed declared types and READS edges, current head source, at least two readers and a changed declaration or reader line",
  supported: [
    "qualified primitive casts",
    "numeric conversion methods",
    "direct field returns",
    "recognized faithful methods",
  ],
  unsupported: [
    "arbitrary dataflow or aliases",
    "multiline consumption expressions",
  ],
  empty_result_means:
    "no conflict established within these patterns and available evidence",
};

test("native detector's declared algorithm scope remains visible without misreporting an unavailable run", async () => {
  const result = await run(undefined, stableGraph, (name, value) => {
    if (name === "find_code_review_issues")
      value._detectors = { inconsistent_type_consumption: supportedDetector };
    return value;
  });
  assert.deepEqual(result.limitations, []);
  assert.equal(
    result.audit?.detectors?.inconsistent_type_consumption.status,
    "evaluated_with_limitations",
  );
  assert.deepEqual(
    (result.audit?.detectors?.inconsistent_type_consumption.details as any)
      .unsupported,
    supportedDetector.unsupported,
  );
});

for (const [label, override] of Object.entries({
  unavailable: { source_files_unavailable: 1 },
  budget: { source_budget_reached: true },
  invalid_counts: { source_files_read: -1 },
  exhausted: { source_files_read: 64 },
  missing_metadata: { source_budget_reached: undefined },
  unknown_scope: { unsupported: ["future limitation"] },
  extra_failure: { error: "Could not evaluate source" },
  unknown_detector: { detectorName: "future_detector" },
})) {
  test(`detector ${label} remains a coverage limitation`, async () => {
    const result = await run(undefined, stableGraph, (name, value) => {
      if (name === "find_code_review_issues") {
        const { detectorName, ...fields } = override as any;
        value._detectors = {
          [detectorName ?? "inconsistent_type_consumption"]: {
            ...supportedDetector,
            ...fields,
          },
        };
      }
      return value;
    });
    assert.ok(
      result.limitations.some(
        (note) =>
          note.includes("consumption") || note.includes("future detector"),
      ),
    );
  });
}

test("a reopened exact cache waits for a stable native publication before measuring", async () => {
  let queries = 0,
    measured = 0;
  const result = await run(undefined, stableGraph, (name, value) => {
    if (name === "get_query_revision" && ++queries === 1) {
      dirty(value);
    }
    if (name === "get_function_quality_metrics") measured++;
    return value;
  });
  assert.deepEqual(result.limitations, []);
  assert.equal(queries, 3);
  assert.equal(measured, 1);
});

test("publication rollover discards the entire first group and measures once more", async () => {
  let queries = 0,
    measured = 0,
    rolled = false;
  const result = await run(undefined, stableGraph, (name, value) => {
    if (name === "get_query_revision") {
      if (++queries === 2) rolled = true;
      value.token = rolled ? "query-2" : "query";
    }
    value._meta.graph_revision.token = rolled ? "published-2" : "published";
    if (name === "get_function_quality_metrics") measured++;
    return value;
  });
  assert.deepEqual(result.limitations, []);
  assert.equal(queries, 4);
  assert.equal(measured, 2);
  assert.equal(result.graphRevision, "published-2");
});

test("source edits never qualify for the graph-publication-only retry", async () => {
  let queries = 0,
    measured = 0;
  const result = await run(undefined, stableGraph, (name, value) => {
    if (name === "get_query_revision" && ++queries === 2) {
      value.source_revision = "different-source";
      value.token = "query-2";
    }
    if (name === "get_function_quality_metrics") measured++;
    return value;
  });
  assert.equal(queries, 2);
  assert.equal(measured, 1);
  assert.equal(result.impact.complete, false);
  assert.ok(result.limitations.some((note) => note.includes("cannot certify")));
});

test("a malformed closing envelope cannot request publication recovery", async () => {
  let queries = 0,
    measured = 0;
  const result = await run(undefined, stableGraph, (name, value) => {
    if (name === "get_query_revision" && ++queries === 2) {
      value.token = "query-2";
      value._meta.graph_revision = null;
    }
    if (name === "get_function_quality_metrics") measured++;
    return value;
  });
  assert.equal(queries, 2);
  assert.equal(measured, 1);
  assert.equal(result.impact.complete, false);
});

test("publication recovery is bounded to one wholly new measurement group", async () => {
  let queries = 0,
    measured = 0;
  const result = await run(undefined, stableGraph, (name, value) => {
    if (name === "get_query_revision") value.token = `query-${++queries}`;
    if (name === "get_function_quality_metrics") measured++;
    return value;
  });
  assert.equal(queries, 4);
  assert.equal(measured, 2);
  assert.equal(result.impact.complete, false);
});

function dirty(value: any) {
  value.ready = false;
  value.status = "partial";
  value.publication = { status: "partial", token: "published" };
  value._meta.graph_revision = {
    status: "partial",
    token: "published",
    publication_unchanged_during_call: false,
  };
  return value;
}

function transitioning(value: any) {
  value.ready = true;
  value.status = "complete";
  value.publication = { status: "published", token: "published" };
  value._meta.stale = true;
  value._meta.graph_revision = {
    before: { status: "partial", token: "prior" },
    after: { status: "published", token: "published" },
    publication_unchanged_during_call: false,
  };
  return value;
}

test("a complete body with a mixed native opening boundary is reread before any measurements", async () => {
  let queries = 0,
    measured = 0;
  const result = await run(undefined, stableGraph, (name, value) => {
    if (name === "get_function_quality_metrics") measured++;
    return name === "get_query_revision" && ++queries === 1
      ? transitioning(value)
      : value;
  });
  assert.deepEqual(result.limitations, []);
  assert.equal(queries, 3);
  assert.equal(measured, 1);
});

test("a mixed closing boundary without a direct graph token discards the full group", async () => {
  let queries = 0,
    measured = 0,
    repairs = 0;
  const result = await run(
    undefined,
    stableGraph,
    (name, value) => {
      if (name === "get_function_quality_metrics") measured++;
      return name === "get_query_revision" && ++queries === 2
        ? transitioning(value)
        : value;
    },
    async (source) => {
      assert.equal(source, "source");
      repairs++;
    },
  );
  assert.deepEqual(result.limitations, []);
  assert.equal(queries, 4);
  assert.equal(measured, 2);
  assert.equal(repairs, 1);
});

test("unknown opening boundary shapes are never treated as a recognized transition", async () => {
  let queries = 0,
    repairs = 0;
  const result = await run(
    undefined,
    stableGraph,
    (name, value) => {
      if (name === "get_query_revision") {
        queries++;
        transitioning(value);
        value._meta.graph_revision.after.status = "future_state";
      }
      return value;
    },
    async () => {
      repairs++;
    },
  );
  assert.equal(queries, 2);
  assert.equal(repairs, 0);
  assert.equal(result.impact.complete, false);
});

test("an exact stranded opening publication invokes genuine recovery once before measurements", async () => {
  let repairs = 0,
    measured = 0;
  const result = await run(
    undefined,
    stableGraph,
    (name, value) => {
      if (name === "get_function_quality_metrics") measured++;
      return name === "get_query_revision" && !repairs ? dirty(value) : value;
    },
    async (source) => {
      assert.equal(source, "source");
      repairs++;
    },
  );
  assert.deepEqual(result.limitations, []);
  assert.equal(repairs, 1);
  assert.equal(measured, 1);
});

test("a late dirty publication repairs the current owner and discards all earlier measurements", async () => {
  let repairs = 0,
    queries = 0,
    measured = 0;
  const result = await run(
    undefined,
    stableGraph,
    (name, value) => {
      if (name === "get_function_quality_metrics") measured++;
      return name === "get_query_revision" && ++queries === 2
        ? dirty(value)
        : value;
    },
    async (source) => {
      assert.equal(source, "source");
      repairs++;
    },
  );
  assert.deepEqual(result.limitations, []);
  assert.equal(repairs, 1);
  assert.equal(measured, 2);
});

test("genuine recovery failure is visible and cannot become a certified result", async () => {
  await assert.rejects(
    run(
      undefined,
      stableGraph,
      (name, value) => (name === "get_query_revision" ? dirty(value) : value),
      async () => {
        throw Error("Publication remains unverified");
      },
    ),
    /remains unverified/,
  );
});

test("a still-dirty publication never launches a second recovery", async () => {
  let repairs = 0;
  const result = await run(
    undefined,
    stableGraph,
    (name, value) => (name === "get_query_revision" ? dirty(value) : value),
    async () => {
      repairs++;
    },
  );
  assert.equal(repairs, 1);
  assert.equal(result.impact.complete, false);
  assert.ok(result.limitations.length > 0);
});

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
