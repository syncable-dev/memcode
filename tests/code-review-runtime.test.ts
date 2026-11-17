import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppState, WorkItem } from "../src/shared";
import type { StoryReviewRun } from "../src/code-review";
import type { StoryReviewCapture } from "../runtime/code-review-snapshot";
import { initialState } from "../src/seed";
import { CodeReviewManager } from "../runtime/code-review";

// Shapes follow the released MCP code_review.rs, temporal.rs and quality.rs
// responses. The native engine's detector correctness is tested separately.
const meta = {
  graph_revision: {
    token: "publication",
    publication_unchanged_during_call: true,
  },
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memcode-story-review-")),
    root = join(directory, "source");
  const state: AppState = initialState();
  const task: WorkItem = {
    id: "t",
    projectId: "p",
    identifier: "MC-1",
    title: "Implement a change",
    description: "",
    stage: "review",
    priority: "medium",
    category: "Work",
    harness: "cursor",
    checklist: [],
    messages: [],
    changesRevision: "changes-1",
    createdAt: "2026-11-17T12:00:00Z",
    updatedAt: "2026-11-17T12:00:00Z",
    run: {
      state: "finished",
      workspace: root,
      branch: "epic/a",
      changeRunId: "implementation",
      finishedSourceBinding: "source-1",
      checks: {
        runId: "implementation",
        revision: "changes-1",
        sessionId: "check",
        passed: 4,
        failed: 0,
        exitCode: 0,
        source: "memcode_check",
        startedAt: "2026-11-17T12:00:00Z",
        finishedAt: "2026-11-17T12:01:00Z",
        linked: true,
        timedOut: false,
      },
    },
  };
  state.tasks = [task];
  state.projects = [
    {
      id: "p",
      name: "Project",
      description: "",
      path: root,
      branch: "epic/a",
      repoId: "repo",
      analysis: "ready",
      createdAt: task.createdAt,
    },
  ];
  let binding = "source-1",
    captureCount = 0,
    accepted = 0,
    notices = 0;
  const requests: Array<{ name: string; args: any }> = [],
    fixes: string[] = [];
  const capture: StoryReviewCapture = {
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
          beforeHash: "before",
          afterHash: "after",
          attribution: "reservation",
        },
      ],
      additions: 1,
      deletions: 1,
    },
    patch:
      "diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-return false;\n+return true;\n",
    baseFiles: { "src/main.ts": "return false;\n" },
    implementationRunIds: ["implementation"],
    limitations: [],
    sourceBinding: "source-1",
  };
  const answers: Record<string, any> = {
    get_query_revision: {
      ready: true,
      repo_id: "repo",
      branch: "epic/a",
      worktree: root,
      token: "query",
      source_revision: "source-1",
      source_unchanged_during_observation: true,
      _meta: meta,
    },
    find_code_review_issues: {
      _workflow: "deterministic_code_review",
      _policy: "memtrace_review_confidence_v1",
      _review_mode: "online",
      _graph_state: "ready",
      issues: [],
      _meta: meta,
    },
    detect_changes: {
      changed_files: [
        {
          file_path: "src/main.ts",
          matched: true,
          affected_symbols: [
            {
              id: "function-1",
              name: "main",
              kind: "Function",
              start_line: 1,
              end_line: 2,
            },
          ],
        },
      ],
      _meta: meta,
    },
    get_function_quality_metrics: {
      matches: 1,
      function: {
        name: "main",
        file_path: "src/main.ts",
        start_line: 1,
        complexity: 2,
        cognitive_complexity: 1,
        max_nesting: 1,
        complexity_source: "ast",
        quality_metrics_v: 1,
        maintainability_index: 80.5,
        halstead_volume: 120.25,
        risk_level: "low",
      },
      _meta: meta,
    },
    get_impact: {
      found: true,
      risk: "LOW",
      truncated: false,
      total_affected: 1,
      by_depth: {
        "1": [
          { node_id: "caller", name: "caller", file_path: "src/caller.ts" },
        ],
      },
      affected_files: ["src/caller.ts"],
      affected_processes: [{ id: "flow" }],
      _meta: meta,
    },
  };
  let intercept: ((name: string, args: any) => Promise<any> | any) | undefined;
  const engine = {
    call: async (_project: any, name: string, args: any) => {
      requests.push({ name, args });
      return (await intercept?.(name, args)) ?? structuredClone(answers[name]);
    },
  };
  const hooks = {
    queueFixes: async (_taskId: string, text: string) => {
      fixes.push(text);
    },
    accept: async () => {
      accepted++;
    },
    engineVersion: () => "1.2.21",
  };
  const deps = {
    capture: async () => {
      captureCount++;
      return structuredClone(capture);
    },
    sourceBinding: async () => binding,
  };
  const manager = (
    extra: Partial<ConstructorParameters<typeof CodeReviewManager>[4]> = {},
  ) =>
    new CodeReviewManager(
      directory,
      () => state,
      engine,
      () => {
        notices++;
      },
      { ...hooks, ...extra },
      deps,
    );
  const instance = manager();
  const settled = async (client = instance): Promise<StoryReviewRun> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await client.get(task.id);
      if (value && !["queued", "running"].includes(value.state)) return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error("Review did not settle");
  };
  return {
    directory,
    state,
    task,
    capture,
    answers,
    requests,
    fixes,
    manager,
    instance,
    settled,
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
    setBinding: (next: string) => {
      binding = next;
    },
    captureCount: () => captureCount,
    accepted: () => accepted,
    notices: () => notices,
    close: async () => {
      await instance.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("review uses the story patch, true AST measurements and deduplicated graph reach, with separate explicit acceptance", async () => {
  const f = await fixture();
  try {
    const originalHarness = f.task.harness,
      queued = await f.instance.start("t");
    assert.equal(queued.state, "queued");
    const run = await f.settled();
    assert.equal(run.state, "completed");
    assert.equal(run.outcome, "ready");
    assert.equal(run.coverage.complete, true);
    assert.deepEqual(run.coverage.limitations, []);
    assert.equal(run.metrics[0].cognitive, 1);
    assert.equal(run.metrics[0].source, "ast");
    assert.equal(run.metrics[0].maintainabilityIndex, 80.5);
    assert.equal(run.metrics[0].halsteadVolume, 120.25);
    assert.equal(run.metrics[0].riskLevel, "low");
    assert.deepEqual(run.impact, {
      symbols: 1,
      files: 1,
      processes: 1,
      complete: true,
    });
    assert.equal(run.checks[0].state, "passed");
    const review = f.requests.find(
      (item) => item.name === "find_code_review_issues",
    )!;
    assert.equal(review.args.diff, f.capture.patch);
    assert.equal(review.args.review_mode, "online");
    assert.equal(review.args.graph_mode, "strict");
    assert.deepEqual(review.args.base_sha_files, f.capture.baseFiles);
    assert.ok(
      f.requests.every((item) => /^(get_|find_|detect_)/.test(item.name)),
    );
    assert.equal(f.task.stage, "review");
    assert.equal(f.accepted(), 0);
    await f.instance.accept("t", run.id);
    assert.equal(f.accepted(), 1);
    assert.equal(f.task.harness, originalHarness);
    assert.equal(f.task.run.changeRunId, "implementation");
    assert.ok(f.notices() >= 7);
    assert.equal(f.task.codeReview?.runId, run.id);
    const restarted = f.manager();
    assert.equal((await restarted.get("t"))?.snapshot.id, "snapshot");
    await restarted.close();
  } finally {
    await f.close();
  }
});

test("duplicate callers across changed functions are counted once, not summed", async () => {
  const f = await fixture();
  try {
    f.answers.detect_changes.changed_files[0].affected_symbols.push({
      id: "function-2",
      name: "second",
      kind: "Function",
      start_line: 3,
    });
    f.intercept((name, args) =>
      name === "get_function_quality_metrics"
        ? {
            ...f.answers[name],
            function: { ...f.answers[name].function, name: args.function_name },
          }
        : undefined,
    );
    await f.instance.start("t");
    const run = await f.settled();
    assert.equal(run.metrics.length, 2);
    assert.equal(run.impact.symbols, 1);
    assert.equal(run.impact.files, 1);
  } finally {
    await f.close();
  }
});

test("real detector issues are attributed to captured paths and fixes return to the original worker only on explicit action", async () => {
  const f = await fixture();
  try {
    f.answers.find_code_review_issues.issues = [
      {
        pattern_id: "unsafe_return",
        _source: "ast",
        severity: "High",
        path: "src/main.ts",
        line: 1,
        message: "The changed return skips validation.",
        evidence: { callee: "validate" },
      },
    ];
    await f.instance.start("t");
    const run = await f.settled();
    assert.equal(run.outcome, "changes-requested");
    assert.equal(run.findings[0].severity, "high");
    await assert.rejects(f.instance.accept("t", run.id), /Resolve/);
    assert.equal(f.fixes.length, 0);
    await assert.rejects(
      f.instance.requestFixes("t", run.id, ["not-a-finding"]),
      /not part/,
    );
    await f.instance.requestFixes(
      "t",
      run.id,
      [run.findings[0].id],
      "Preserve the public API.",
    );
    assert.equal(f.fixes.length, 1);
    assert.match(f.fixes[0], /src\/main.ts:1/);
    assert.match(f.fixes[0], /Preserve the public API/);
    assert.equal((await f.instance.get("t"))?.state, "stale");
  } finally {
    await f.close();
  }
});

test("native review provenance, live mode, source counts and structured detector evidence survive persistence", async () => {
  const f = await fixture();
  const versions: string[] = [];
  const client = f.manager({
    engineVersion: (project) => {
      assert.equal(project.id, "p");
      assert.equal(project.repoId, "repo");
      assert.equal(project.branch, "epic/a");
      assert.equal(project.path, f.state.projects[0].path);
      versions.push(project.id);
      return versions.length > 1 ? "native-server-1.2.21" : "";
    },
  });
  try {
    Object.assign(f.answers.find_code_review_issues, {
      _raw_count: 6,
      _filtered_count: 4,
      _max_candidates: 100,
      _source_counts: { ast: 3, yaml: 1, cross_module: 1, online: 1 },
      _detectors: {
        type_consumption: {
          status: "evaluated",
          candidate_fields: 2,
          supported: ["located readers"],
        },
      },
      issues: [
        {
          pattern_id: "unsafe_return",
          _source: "ast",
          severity: "High",
          path: "src/main.ts",
          line: 1,
          message: "The return skips validation.",
          evidence: { callee: "validate", located: true },
        },
        {
          pattern_id: "doc_code_count_drift",
          _source: "online",
          severity: "Medium",
          path: "src/main.ts",
          line: 2,
          message: "The stated tool count disagrees with the source.",
          evidence: { stated_count: 2, inferred_count: 3 },
        },
      ],
    });
    await client.start("t");
    const run = await f.settled(client);
    assert.equal(
      f.requests.find((row) => row.name === "find_code_review_issues")!.args
        .review_mode,
      "online",
    );
    assert.equal(run.engine.version, "native-server-1.2.21");
    assert.equal(
      run.engine.rulesVersion,
      undefined,
      "policy identity is not a YAML rules version",
    );
    assert.deepEqual(run.engine.audit, {
      reviewMode: "online",
      policy: "memtrace_review_confidence_v1",
      rawCount: 6,
      filteredCount: 4,
      maxCandidates: 100,
      sourceCounts: { ast: 3, yaml: 1, cross_module: 1, online: 1 },
      detectors: {
        type_consumption: {
          status: "evaluated",
          details: { candidate_fields: 2, supported: ["located readers"] },
        },
      },
    });
    assert.deepEqual(
      run.findings.map((row) => row.provenance),
      ["ast", "online"],
    );
    assert.deepEqual(run.findings[0].evidenceData, {
      callee: "validate",
      located: true,
    });
    assert.equal(run.findings[0].evidence, undefined);
    assert.equal(
      run.outcome,
      "changes-requested",
      "online findings retain native severity and the existing explicit review decision policy",
    );
    await client.close();
    const restarted = f.manager();
    const restored = await restarted.get("t");
    assert.deepEqual(restored?.engine.audit, run.engine.audit);
    assert.deepEqual(restored?.findings[1].evidenceData, {
      stated_count: 2,
      inferred_count: 3,
    });
    await restarted.close();
  } finally {
    await client.close();
    await f.close();
  }
});

test("malformed review metadata and forged provenance stay explicit, while structured evidence is bounded", async () => {
  const f = await fixture();
  try {
    Object.assign(f.answers.find_code_review_issues, {
      _review_mode: "fabricated",
      _policy: { version: "trusted" },
      _raw_count: "100",
      _filtered_count: -1,
      _max_candidates: 101,
      _source_counts: { ast: 1, online: -1, fabricated: 42 },
      _detectors: {
        unknown: { status: "future_mode", reason: "Not understood" },
        malformed: { status: 1 },
      },
      issues: [
        {
          pattern_id: "unsafe_return",
          _source: { name: "ast" },
          provenance: "ast",
          confidence: 1,
          severity: "High",
          path: "src/main.ts",
          line: 1,
          message: "Needs attention.",
          evidence: JSON.parse(
            JSON.stringify({
              large: "x".repeat(100000),
              sites: Array.from({ length: 200 }, (_, index) => ({
                line: index,
                text: '\\"'.repeat(3000),
              })),
              nested: {
                a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } },
              },
            }).replace('"large":', '"__proto__":{"injected":true},"large":'),
          ),
        },
      ],
    });
    await f.instance.start("t");
    const run = await f.settled();
    assert.equal(run.coverage.complete, false);
    assert.equal(run.engine.audit?.reviewMode, undefined);
    assert.equal(run.engine.audit?.policy, undefined);
    assert.equal(run.engine.audit?.rawCount, undefined);
    assert.equal(run.engine.audit?.filteredCount, undefined);
    assert.equal(run.engine.audit?.maxCandidates, undefined);
    assert.deepEqual(run.engine.audit?.sourceCounts, { ast: 1 });
    assert.deepEqual(run.engine.audit?.detectors?.unknown, {
      status: "future_mode",
      reason: "Not understood",
      details: {},
    });
    assert.equal(run.engine.audit?.detectors?.malformed, undefined);
    const finding = run.findings[0];
    assert.equal(finding.provenance, undefined);
    assert.equal("confidence" in finding, false);
    assert.equal(finding.evidenceTruncated, true);
    assert.ok(finding.evidenceData && typeof finding.evidenceData === "object");
    assert.ok(Buffer.byteLength(JSON.stringify(finding.evidenceData)) <= 12000);
    assert.equal(Object.hasOwn(finding.evidenceData, "__proto__"), false);
    assert.ok(
      run.coverage.limitations.some((note) =>
        /recognized native detector source/.test(note),
      ),
    );
    assert.ok(
      run.coverage.limitations.some((note) =>
        /recognized review mode/.test(note),
      ),
    );
    assert.ok(
      run.coverage.limitations.some((note) => /Malformed detector/.test(note)),
    );
    await assert.rejects(f.instance.accept("t", run.id), /Resolve/);
  } finally {
    await f.close();
  }
});

test("declaration changes retain linked native affected-consumer findings without attributing those files to the story", async () => {
  const f = await fixture();
  try {
    f.answers.find_code_review_issues.issues = [
      {
        pattern_id: "inconsistent_type_consumption",
        _source: "cross_module",
        severity: "High",
        path: "src/caller.ts",
        line: 15,
        message:
          "The changed declaration narrows the contract used by a caller.",
        evidence: {
          declared_in: "src/main.ts",
          symbol: "amount",
          consuming_sites: [
            { path: "src/caller.ts", line: 15, form: "Narrowing" },
          ],
        },
      },
    ];
    await f.instance.start("t");
    const run = await f.settled();
    assert.equal(run.findings.length, 1);
    assert.equal(run.findings[0].path, "src/caller.ts");
    assert.equal(run.findings[0].locationScope, "affected-code");
    assert.deepEqual(run.findings[0].relatedCapturedPaths, ["src/main.ts"]);
    assert.deepEqual(
      run.snapshot.files.map((file) => file.path),
      ["src/main.ts"],
    );
    assert.equal(run.outcome, "changes-requested");
    await f.instance.requestFixes("t", run.id, [run.findings[0].id]);
    assert.match(
      f.fixes[0],
      /Affected consumer evidence, linked to src\/main.ts/,
    );
    assert.match(f.fixes[0], /not an authored change of this story/);
    assert.match(
      f.fixes[0],
      /requalify and coordinate any additional edit scope/,
    );
  } finally {
    await f.close();
  }
});

test("unlinked, forged-source and traversal graph anchors cannot expand a story review", async () => {
  const f = await fixture();
  try {
    const issue = {
      pattern_id: "inconsistent_type_consumption",
      _source: "cross_module",
      severity: "High",
      line: 1,
      message: "Do not attribute unrelated source.",
      evidence: { declared_in: "src/main.ts" },
    };
    f.answers.find_code_review_issues.issues = [
      {
        ...issue,
        path: "src/unrelated.ts",
        evidence: { declared_in: "src/other.ts" },
      },
      {
        ...issue,
        path: "src/forged.ts",
        _source: "ast",
        provenance: "cross_module",
      },
      { ...issue, path: "src/forged2.ts", _source: "unknown" },
      { ...issue, path: "../outside.ts" },
      {
        ...issue,
        path: "src/no-link.ts",
        evidence: { declared_in: "../src/main.ts" },
      },
      {
        ...issue,
        path: "src/string-evidence.ts",
        evidence: '{"declared_in":"src/main.ts"}',
      },
    ];
    await f.instance.start("t");
    const run = await f.settled();
    assert.equal(run.findings.length, 0);
    assert.equal(run.coverage.complete, false);
    assert.equal(run.outcome, "incomplete");
    assert.ok(
      run.coverage.limitations.some((note) => /outside this story/.test(note)),
    );
    assert.deepEqual(
      run.snapshot.files.map((file) => file.path),
      ["src/main.ts"],
    );
  } finally {
    await f.close();
  }
});

test("a changed publication, missing metric, incomplete impact or old check cannot yield a green review", async (t) => {
  for (const [label, mutate] of Object.entries({
    publication: (f: Awaited<ReturnType<typeof fixture>>) => {
      f.answers.detect_changes._meta = {
        graph_revision: { ...meta.graph_revision, token: "older" },
      };
    },
    quality: (f: Awaited<ReturnType<typeof fixture>>) => {
      f.answers.get_function_quality_metrics.function.cognitive_complexity =
        null;
    },
    impact: (f: Awaited<ReturnType<typeof fixture>>) => {
      f.answers.get_impact.truncated = true;
    },
    check: (f: Awaited<ReturnType<typeof fixture>>) => {
      f.task.run.checks!.revision = "old";
    },
    absent: (f: Awaited<ReturnType<typeof fixture>>) => {
      f.answers.detect_changes.changed_files = [];
    },
  }))
    await t.test(label, async () => {
      const f = await fixture();
      try {
        mutate(f);
        await f.instance.start("t");
        const run = await f.settled();
        assert.equal(run.outcome, "incomplete");
        assert.equal(run.coverage.complete, false);
        await assert.rejects(f.instance.accept("t", run.id), /Resolve/);
      } finally {
        await f.close();
      }
    });
});

test("source changes during or after review make evidence stale and prevent stale fixes or acceptance", async () => {
  const f = await fixture();
  try {
    await f.instance.start("t");
    const run = await f.settled();
    f.setBinding("source-2");
    assert.equal((await f.instance.get("t"))?.state, "stale");
    await assert.rejects(f.instance.accept("t", run.id), /Resolve|changed/);
    await assert.rejects(
      f.instance.requestFixes("t", run.id, [], "Fix this"),
      /changed/,
    );
    assert.equal(f.fixes.length, 0);
    f.setBinding("source-1");
    f.intercept((name) => {
      if (name === "get_impact") f.setBinding("changed-during-review");
    });
    await f.instance.start("t");
    assert.equal((await f.settled()).state, "stale");
  } finally {
    await f.close();
  }
});

test("no recorded patch is incomplete; research with no source is explicitly not applicable", async () => {
  const f = await fixture();
  try {
    f.capture.patch = "";
    f.capture.snapshot.files = [];
    await f.instance.start("t");
    assert.equal((await f.settled()).outcome, "incomplete");
    assert.equal(f.requests.length, 0);
    f.task.kind = "research";
    await f.instance.start("t");
    const run = await f.settled();
    assert.equal(run.outcome, "not-applicable");
    assert.equal(run.coverage.complete, false);
    await f.instance.accept("t", run.id);
    assert.equal(f.accepted(), 1);
  } finally {
    await f.close();
  }
});

test("a busy implementation is rejected; duplicate review starts share a pass; cancel prevents late results", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    f.task.run.state = "running";
    await assert.rejects(f.instance.start("t"), /Finish/);
    f.task.run.state = "finished";
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.intercept(async (name) => {
      if (name === "get_query_revision") await gate;
    });
    const [first, second] = await Promise.all([
      f.instance.start("t"),
      f.instance.start("t"),
    ]);
    assert.equal(first.id, second.id);
    await f.instance.cancel("t", first.id);
    release();
    const run = await f.settled();
    assert.equal(run.state, "cancelled");
    assert.equal(f.captureCount(), 1);
  } finally {
    release?.();
    await f.close();
  }
});

test("review conversations are clearly deterministic and never call an implementation harness or mutate source", async () => {
  const f = await fixture();
  try {
    await f.instance.start("t");
    const run = await f.settled(),
      before = f.requests.length;
    const reply = await f.instance.discuss(
      "t",
      run.id,
      "Explain the impact and change every source file now.",
    );
    assert.equal(reply.messages.at(-2)?.role, "user");
    assert.match(reply.messages.at(-1)!.text, /No model is connected/);
    assert.equal(f.requests.length, before);
    assert.equal(f.fixes.length, 0);
    assert.equal(f.task.messages.length, 0);
    await f.instance.start("t");
    await f.settled();
    const entries = await readdir(join(f.directory, "code-reviews"), {
      recursive: true,
    });
    assert.ok(
      entries.filter(
        (name) => name.endsWith(".json") && !name.endsWith("latest.json"),
      ).length >= 2,
      "earlier review runs remain stored",
    );
  } finally {
    await f.close();
  }
});

test("a separate real-model adapter supplies advisory conversation without changing measured findings or implementation assignment", async () => {
  const f = await fixture();
  let calls = 0;
  const client = f.manager({
    reviewer: {
      ask: async (input) => {
        calls++;
        input.onModel?.("actual-review-model");
        assert.equal(input.task.harness, "cursor");
        assert.equal(input.patch, f.capture.patch);
        return {
          harness: "cursor",
          model: "actual-review-model",
          text: "Model advice: consider naming. I think 17 checks passed.",
        };
      },
    },
  });
  try {
    await client.start("t");
    const run = await f.settled(client);
    assert.equal(calls, 1);
    assert.equal(run.reviewer?.model, "actual-review-model");
    assert.equal(run.messages.filter((m) => m.role === "assistant").length, 1);
    assert.equal(run.findings.length, 0);
    assert.equal(run.checks[0].detail, "4 passed · 0 failed");
    assert.equal(f.task.harness, "cursor");
    assert.equal(f.task.messages.length, 0);
    await client.discuss("t", run.id, "Why?");
    assert.equal(calls, 2);
  } finally {
    await client.close();
    await f.close();
  }
});

test("worker startup aborts and awaits an active reviewer, and invalidates its saved review", async () => {
  const f = await fixture();
  let entered!: () => void,
    closed = false;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const client = f.manager({
    reviewer: {
      ask: async (input) => {
        entered();
        await new Promise<void>((_, reject) =>
          input.signal!.addEventListener(
            "abort",
            () => {
              closed = true;
              reject(Error("Stopped"));
            },
            { once: true },
          ),
        );
        throw Error("unreachable");
      },
    },
  });
  try {
    await client.start("t");
    await started;
    await client.interruptForWorker("t");
    assert.equal(closed, true);
    assert.equal((await client.get("t"))?.state, "cancelled");
  } finally {
    await client.close();
    await f.close();
  }
});

test("missing optional old review files never block the next implementation pass", async () => {
  const f = await fixture();
  try {
    f.task.codeReview = {
      runId: "old",
      state: "completed",
      outcome: "ready",
      updatedAt: "old",
      findingCount: 0,
    };
    await f.instance.interruptForWorker("t");
    assert.equal(f.task.codeReview.state, "stale");
    assert.equal(f.task.run.state, "finished");
  } finally {
    await f.close();
  }
});

test("an explicit human reason permits partial-review handoff while preserving all coverage limitations", async () => {
  const f = await fixture();
  try {
    f.answers.detect_changes.changed_files[0].affected_symbols = [];
    await f.instance.start("t");
    const run = await f.settled();
    assert.equal(run.outcome, "incomplete");
    await assert.rejects(f.instance.accept("t", run.id), /Resolve/);
    await assert.rejects(f.instance.accept("t", run.id, "   "), /Resolve/);
    await f.instance.accept(
      "t",
      run.id,
      "This is a CSS-only layout update. I inspected the rendered screen and linked checks.",
    );
    const after = await f.instance.get("t");
    assert.equal(f.accepted(), 1);
    assert.equal(after?.outcome, "incomplete");
    assert.equal(after?.coverage.complete, false);
    assert.deepEqual(after?.coverage.limitations, run.coverage.limitations);
    assert.match(after!.messages.at(-1)!.text, /Human review decision/);
    f.setBinding("source-2");
    await assert.rejects(
      f.instance.accept("t", run.id, "Still accepting"),
      /source changed/,
    );
    assert.equal(f.accepted(), 1);
  } finally {
    await f.close();
  }
});

test("missing expected AST maintainability stays unknown and makes coverage partial; zero measurements are preserved", async () => {
  const f = await fixture();
  try {
    delete f.answers.get_function_quality_metrics.function
      .maintainability_index;
    delete f.answers.get_function_quality_metrics.function.halstead_volume;
    await f.instance.start("t");
    const missing = await f.settled();
    assert.equal(missing.metrics[0].maintainabilityIndex, null);
    assert.equal(missing.metrics[0].halsteadVolume, null);
    assert.equal(missing.outcome, "incomplete");
    assert.ok(
      missing.coverage.limitations.some((note) =>
        note.includes("maintainability index was not reported"),
      ),
    );
    f.answers.get_function_quality_metrics.function.maintainability_index = 0;
    f.answers.get_function_quality_metrics.function.halstead_volume = 0;
    await f.instance.start("t");
    const zero = await f.settled();
    assert.equal(zero.metrics[0].maintainabilityIndex, 0);
    assert.equal(zero.metrics[0].halsteadVolume, 0);
    assert.equal(zero.outcome, "ready");
  } finally {
    await f.close();
  }
});
