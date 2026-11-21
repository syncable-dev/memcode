import test from "node:test";
import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppState, WorkItem } from "../src/shared";
import {
  activeCodeReviewFindings,
  reviewFindingDisposition,
  type StoryReviewRun,
} from "../src/code-review";
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
async function fixture(onSourceCheck?: () => void) {
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
    sourceBinding: async () => {
      onSourceCheck?.();
      return binding;
    },
  };
  const manager = (
    extra: Partial<ConstructorParameters<typeof CodeReviewManager>[4]> = {},
    onChanged?: () => unknown | Promise<unknown>,
  ) =>
    new CodeReviewManager(
      directory,
      () => state,
      engine,
      () => {
        notices++;
        return onChanged?.();
      },
      { ...hooks, ...extra },
      deps,
    );
  const instance = manager();
  const settled = async (client = instance): Promise<StoryReviewRun> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await client.get(task.id);
      if (
        value &&
        !["queued", "running"].includes(value.state) &&
        task.codeReview?.runId === value.id &&
        task.codeReview.state === value.state
      )
        return value;
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

test("a failed graph preparation preserves the verified story patch, linked checks and immutable AST comparison after reopening", async () => {
  const f = await fixture();
  const failure = "The epic graph could not be verified.";
  const client = f.manager({
    prepare: async () => {
      throw Error(failure);
    },
  });
  const reopened = f.manager();
  try {
    const path = "src/main.ts";
    const before =
      "export function main(value: number) {\n  return value;\n}\n";
    const after =
      "export function main(value: number) {\n  if (value < 0) return 0;\n  return Math.floor(value);\n}\n";
    const sha = (source: string) =>
      createHash("sha256").update(source).digest("hex");
    const patch = createTwoFilesPatch("a/" + path, "b/" + path, before, after);
    const limitation = "An earlier edit has no verified source contents.";
    f.capture.patch = patch;
    f.capture.baseFiles = { [path]: before };
    f.capture.limitations.push(limitation);
    Object.assign(f.capture.snapshot, {
      patchHash: sha(patch),
      files: [
        {
          path,
          beforeHash: sha(before),
          afterHash: sha(after),
          attribution: "native-edit",
        },
      ],
      additions: 2,
      deletions: 1,
    });
    f.intercept((name, args) => {
      if (name === "get_checkout_capabilities")
        return { source_quality_v1: true };
      if (name !== "get_function_quality_metrics")
        throw Error("Unexpected graph query: " + name);
      const src = args.source_content;
      assert.ok(src === before || src === after);
      return {
        _workflow: "immutable_source_quality_v1",
        source_sha256: sha(src),
        source_bytes: Buffer.byteLength(src),
        file_path: path,
        metrics_version: 3,
        quality_metrics_version: 1,
        matches: 1,
        truncated: false,
        functions: [
          {
            name: "main",
            scope_path: "main",
            kind: "Function",
            file_path: path,
            start_line: 1,
            end_line: src === before ? 3 : 4,
            metrics_v: 3,
            quality_metrics_v: 1,
            complexity_source: "ast",
            cognitive_complexity: src === before ? 0 : 1,
            complexity: src === before ? 1 : 2,
            max_nesting: src === before ? 0 : 1,
          },
        ],
      };
    });
    await client.start(f.task.id);
    const run = await f.settled(client);
    assert.equal(run.state, "failed");
    assert.equal(run.outcome, "incomplete");
    assert.equal(run.note, failure);
    assert.equal(run.coverage.complete, false);
    assert.ok(run.coverage.limitations.includes(limitation));
    assert.equal(run.impact.complete, false);
    assert.equal(run.engine.audit, undefined);
    assert.deepEqual(run.snapshot, f.capture.snapshot);
    assert.equal(run.checks[0].state, "passed");
    assert.equal(run.qualityComparison?.filesMeasured, 1);
    assert.deepEqual(
      f.requests
        .filter((r) => r.name === "get_function_quality_metrics")
        .map((r) => r.args.source_content)
        .sort(),
      [before, after].sort(),
    );
    assert.equal(run.metrics[0].symbol, "main");
    assert.equal(run.metrics[0].comparison?.status, "matched");
    assert.equal(run.metrics[0].comparison?.beforeSourceHash, sha(before));
    assert.equal(run.metrics[0].comparison?.afterSourceHash, sha(after));
    assert.equal(run.metrics[0].before?.cognitive, 0);
    assert.equal(run.metrics[0].cognitive, 1);
    assert.deepEqual(await reopened.get(f.task.id), run);
  } finally {
    await reopened.close();
    await client.close();
    await f.close();
  }
});

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
    assert.match(f.fixes[0], /not an authored change of this task/);
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
      run.coverage.limitations.some((note) => /outside this task/.test(note)),
    );
    assert.deepEqual(
      run.snapshot.files.map((file) => file.path),
      ["src/main.ts"],
    );
  } finally {
    await f.close();
  }
});

test("a read-only follow-up can verify the story's earlier edits without changing their attribution", async () => {
  const f = await fixture();
  try {
    f.task.run.changeRunId = "follow-up";
    f.task.run.checks!.runId = "follow-up";
    await f.instance.start("t");
    const run = await f.settled();
    assert.deepEqual(run.implementationRunIds, ["implementation"]);
    assert.equal(run.checks[0].state, "passed");
    assert.equal(run.checks[0].detail, "4 passed · 0 failed");
    assert.ok(
      !run.coverage.limitations.some((note) =>
        /Verification is missing/.test(note),
      ),
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
    "earlier pass": (f: Awaited<ReturnType<typeof fixture>>) => {
      f.task.run.changeRunId = "follow-up";
    },
    "different source": (f: Awaited<ReturnType<typeof fixture>>) => {
      f.task.run.finishedSourceBinding = "other-source";
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
      {
        id: "remote-question",
        actor: {
          memberId: "member-b",
          name: "Bob",
          deviceId: "device-b",
          device: "Mac",
        },
      },
    );
    assert.equal(reply.messages.at(-2)?.role, "user");
    assert.equal(reply.messages.at(-2)?.id, "remote-question");
    assert.equal(reply.messages.at(-2)?.actor?.name, "Bob");
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
        assert.equal(input.review.coverage.complete, true);
        assert.ok(
          input.review.phases.every((phase) => phase.state === "complete"),
        );
        assert.equal(input.review.checks[0].state, "passed");
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

test("reviewer progress replaces the connection message while its answer is pending", async () => {
  const f = await fixture();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const client = f.manager({
    reviewer: {
      ask: async (input) => {
        input.onModel?.("reported-model");
        input.onProgress?.(
          "Reading the captured patch, findings and function measurements.",
        );
        entered();
        await held;
        return {
          harness: "cursor",
          model: "reported-model",
          text: "Review advice.",
        };
      },
    },
  });
  try {
    await client.start("t");
    await started;
    const run = await client.get("t");
    assert.equal(run?.reviewer?.model, "reported-model");
    assert.equal(run?.reviewer?.state, "running");
    assert.match(run?.reviewer?.note ?? "", /Reading the captured patch/);
    finish();
    await f.settled(client);
  } finally {
    finish();
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

function addReviewFinding(f: Awaited<ReturnType<typeof fixture>>) {
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
}

test("dismissals persist evidence-bound human reasons and reopen without removing detector evidence", async () => {
  const f = await fixture(),
    client = f.manager({
      actor: () => ({
        id: "account-1",
        name: "Test reviewer",
        source: "memtrace",
      }),
    });
  let restored: CodeReviewManager | undefined;
  try {
    addReviewFinding(f);
    await client.start("t");
    const original = await f.settled(client),
      finding = original.findings[0];
    const dismissed = await client.dismissFinding(
      "t",
      original.id,
      finding.id,
      "false-positive",
      " The caller has already validated this value. ",
    );
    assert.deepEqual(
      dismissed.findings,
      original.findings,
      "detector evidence is immutable",
    );
    assert.deepEqual(dismissed.checks, original.checks);
    assert.deepEqual(dismissed.coverage, original.coverage);
    assert.equal(activeCodeReviewFindings(dismissed).length, 0);
    assert.equal(dismissed.outcome, "ready");
    assert.equal(f.task.codeReview?.findingCount, 0);
    assert.equal(
      f.accepted(),
      0,
      "triage never automatically accepts the story",
    );
    const decision = reviewFindingDisposition(dismissed, finding.id)!;
    assert.equal(
      decision.explanation,
      "The caller has already validated this value.",
    );
    assert.deepEqual(decision.actor, {
      id: "account-1",
      name: "Test reviewer",
      source: "memtrace",
    });
    assert.equal(decision.snapshotId, original.snapshot.id);
    assert.equal(decision.patchHash, original.snapshot.patchHash);
    assert.match(decision.evidenceHash, /^[a-f0-9]{64}$/);
    assert.equal(decision.evidenceHash, finding.evidenceHash);
    assert.ok(Number.isFinite(Date.parse(decision.at)));
    await assert.rejects(
      client.requestFixes("t", original.id, [finding.id]),
      /Reopen dismissed/,
    );
    assert.equal(f.fixes.length, 0);
    await assert.rejects(
      client.dismissFinding(
        "t",
        original.id,
        finding.id,
        "other",
        "Another explanation",
      ),
      /already dismissed/,
    );
    await client.close();
    restored = f.manager();
    assert.deepEqual(
      (await restored.get("t"))?.findingDispositions,
      dismissed.findingDispositions,
    );
    const reopened = await restored.reopenFinding("t", original.id, finding.id);
    assert.equal(activeCodeReviewFindings(reopened).length, 1);
    assert.equal(reopened.outcome, "changes-requested");
    assert.equal(f.task.codeReview?.findingCount, 1);
    assert.equal(reopened.findingDispositions!.length, 2);
    assert.equal(reopened.findingDispositions![0].status, "dismissed");
    assert.equal(reopened.findingDispositions![1].status, "reopened");
    assert.deepEqual(reopened.findingDispositions![1].actor, {
      id: "local-owner",
      name: "Local user",
      source: "local",
    });
    await assert.rejects(restored.accept("t", original.id), /Resolve active/);
    await assert.rejects(
      restored.reopenFinding("t", original.id, finding.id),
      /not dismissed/,
    );
    await restored.dismissFinding(
      "t",
      original.id,
      finding.id,
      "accepted-risk",
      "This risk is acceptable for the controlled prototype.",
    );
    await restored.accept("t", original.id);
    assert.equal(f.accepted(), 1);
  } finally {
    await restored?.close();
    await client.close();
    await f.close();
  }
});

test("dismissal input, current run, current source and review-lane guards are enforced", async () => {
  const f = await fixture();
  try {
    addReviewFinding(f);
    await f.instance.start("t");
    const run = await f.settled(),
      id = run.findings[0].id;
    for (const [reason, explanation] of [
      ["unknown", "Why"],
      ["other", "   "],
      ["other", "x".repeat(2001)],
    ])
      await assert.rejects(
        f.instance.dismissFinding("t", run.id, id, reason as any, explanation),
        /reason|2,000/,
      );
    await assert.rejects(
      f.instance.dismissFinding("t", "earlier-run", id, "other", "Why"),
      /current review/,
    );
    await assert.rejects(
      f.instance.dismissFinding("t", run.id, "unknown", "other", "Why"),
      /not part/,
    );
    f.task.stage = "done";
    const saved = await f.instance.get("t");
    assert.equal(
      saved?.id,
      run.id,
      "saved results remain readable after lane exit",
    );
    await assert.rejects(
      f.instance.dismissFinding("t", run.id, id, "other", "Why"),
      /Code review lane/,
    );
    f.task.stage = "review";
    f.task.run.state = "running";
    await assert.rejects(
      f.instance.dismissFinding("t", run.id, id, "other", "Why"),
      /current completed review/,
    );
    f.task.run.state = "finished";
    f.setBinding("new-source");
    await assert.rejects(
      f.instance.dismissFinding("t", run.id, id, "other", "Why"),
      /source changed/,
    );
    assert.equal(
      (await f.instance.get("t"))?.findingDispositions?.length ?? 0,
      0,
    );
  } finally {
    await f.close();
  }
});

test("a stale dismissal cannot be reopened against changed code", async () => {
  const f = await fixture();
  try {
    addReviewFinding(f);
    await f.instance.start("t");
    const run = await f.settled(),
      id = run.findings[0].id;
    await f.instance.dismissFinding(
      "t",
      run.id,
      id,
      "not-applicable",
      "This path is excluded by the public contract.",
    );
    f.setBinding("new-source");
    await assert.rejects(
      f.instance.reopenFinding("t", run.id, id),
      /source changed/,
    );
    assert.equal((await f.instance.get("t"))?.findingDispositions?.length, 1);
  } finally {
    await f.close();
  }
});

test("dismissing every finding cannot hide failed checks or incomplete coverage", async (t) => {
  for (const mode of ["failed-checks", "missing-quality"])
    await t.test(mode, async () => {
      const f = await fixture();
      try {
        addReviewFinding(f);
        if (mode === "failed-checks") f.task.run.checks!.failed = 1;
        else
          f.answers.get_function_quality_metrics.function.cognitive_complexity =
            null;
        await f.instance.start("t");
        const run = await f.settled();
        const after = await f.instance.dismissFinding(
          "t",
          run.id,
          run.findings[0].id,
          "false-positive",
          "The detector missed the caller's validation.",
        );
        assert.deepEqual(after.coverage, run.coverage);
        assert.deepEqual(after.checks, run.checks);
        assert.equal(activeCodeReviewFindings(after).length, 0);
        assert.equal(
          after.outcome,
          mode === "failed-checks" ? "changes-requested" : "incomplete",
        );
        await assert.rejects(f.instance.accept("t", run.id), /Resolve/);
        if (mode === "failed-checks")
          await assert.rejects(
            f.instance.accept("t", run.id, "I dismissed the finding"),
            /failed checks/,
          );
      } finally {
        await f.close();
      }
    });
});

test("a new review never inherits dismissed findings from an earlier snapshot", async () => {
  const f = await fixture();
  try {
    addReviewFinding(f);
    await f.instance.start("t");
    const run = await f.settled();
    await f.instance.dismissFinding(
      "t",
      run.id,
      run.findings[0].id,
      "other",
      "A deliberate tradeoff for this review only.",
    );
    await f.instance.start("t");
    const next = await f.settled();
    assert.notEqual(next.id, run.id);
    assert.equal(next.findingDispositions?.length ?? 0, 0);
    assert.equal(activeCodeReviewFindings(next).length, 1);
    assert.equal(next.outcome, "changes-requested");
    const entries = await readdir(join(f.directory, "code-reviews"), {
      recursive: true,
    });
    assert.ok(
      entries.some((path) => path.endsWith(run.id + ".json")),
      "earlier audit remains saved",
    );
  } finally {
    await f.close();
  }
});

test("changed saved detector evidence invalidates its dismissal; old reviews without dispositions still load", async () => {
  const f = await fixture();
  let restored: CodeReviewManager | undefined;
  try {
    addReviewFinding(f);
    await f.instance.start("t");
    const run = await f.settled();
    await f.instance.dismissFinding(
      "t",
      run.id,
      run.findings[0].id,
      "other",
      "A measured exception for this exact evidence.",
    );
    await f.instance.close();
    const entries = await readdir(join(f.directory, "code-reviews"), {
      recursive: true,
    });
    const savedPath = join(
      f.directory,
      "code-reviews",
      entries.find((path) => path.endsWith(run.id + ".json"))!,
    );
    const saved = JSON.parse(await readFile(savedPath, "utf8"));
    saved.run.findings[0].explanation += " New detector evidence.";
    await writeFile(savedPath, JSON.stringify(saved));
    restored = f.manager();
    const after = (await restored.get("t"))!;
    assert.equal(
      after.findingDispositions!.length,
      1,
      "audit is not silently deleted",
    );
    assert.equal(
      reviewFindingDisposition(after, after.findings[0].id),
      undefined,
    );
    assert.equal(activeCodeReviewFindings(after).length, 1);
    assert.equal(after.outcome, "changes-requested");
    await assert.rejects(restored.accept("t", run.id), /Resolve active/);
    await restored.close();
    delete saved.run.findingDispositions;
    delete saved.run.findings[0].evidenceHash;
    await writeFile(savedPath, JSON.stringify(saved));
    restored = f.manager();
    const legacy = (await restored.get("t"))!;
    assert.equal(activeCodeReviewFindings(legacy).length, 1);
    assert.match(legacy.findings[0].evidenceHash!, /^[a-f0-9]{64}$/);
  } finally {
    await restored?.close();
    await f.close();
  }
});

test("a reviewer answer and finding decisions cannot race one another", async () => {
  const f = await fixture();
  let answerCount = 0,
    entered!: () => void,
    release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const client = f.manager({
    reviewer: {
      ask: async () => {
        if (++answerCount > 1) {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return {
          harness: "cursor",
          model: "test-model",
          text: "The evidence is unchanged.",
        };
      },
    },
  });
  try {
    addReviewFinding(f);
    await client.start("t");
    const run = await f.settled(client),
      id = run.findings[0].id;
    const answer = client.discuss("t", run.id, "Explain this finding.");
    await started;
    await assert.rejects(
      client.dismissFinding(
        "t",
        run.id,
        id,
        "false-positive",
        "The call is already checked.",
      ),
      /reviewer's answer/,
    );
    assert.equal((await client.get("t"))?.findingDispositions?.length ?? 0, 0);
    release!();
    await answer;
    assert.equal(
      (
        await client.dismissFinding(
          "t",
          run.id,
          id,
          "false-positive",
          "The call is already checked.",
        )
      ).outcome,
      "ready",
    );
  } finally {
    release?.();
    await client.close();
    await f.close();
  }
});

test("a read queued at the final source check sees a committed review state", async () => {
  let observed: Promise<{ run?: string; summary?: string }> | undefined;
  const f = await fixture(() => {
    // Queue an ordinary UI read just before the review can commit completion.
    observed ??= f.instance.get("t").then((run) => ({
      run: run?.state,
      summary: f.task.codeReview?.state,
    }));
  });
  try {
    await f.instance.start("t");
    const completed = await f.settled();
    assert.equal(completed.state, "completed");
    const first = await observed;
    assert.ok(first);
    assert.equal(first.run, first.summary);
  } finally {
    await f.close();
  }
});

test("a real failed decision-file write cannot leave an unsaved dismissal active", async () => {
  const f = await fixture();
  let restored: CodeReviewManager | undefined;
  try {
    addReviewFinding(f);
    await f.instance.start("t");
    const before = await f.settled(),
      summary = structuredClone(f.task.codeReview);
    const entries = await readdir(join(f.directory, "code-reviews"), {
      recursive: true,
    });
    const path = join(
      f.directory,
      "code-reviews",
      entries.find((item) => item.endsWith(before.id + ".json"))!,
    );
    const diskBefore = await readFile(path, "utf8");
    // Real filesystem failure: opening the decision's prepared-file path as a
    // file fails because that exact path is occupied by a directory.
    await mkdir(path + ".next");
    await assert.rejects(
      f.instance.dismissFinding(
        "t",
        before.id,
        before.findings[0].id,
        "other",
        "A deliberate exception.",
      ),
      /EISDIR|EPERM|EACCES/,
    );
    assert.deepEqual(await f.instance.get("t"), before);
    assert.deepEqual(f.task.codeReview, summary);
    assert.equal(await readFile(path, "utf8"), diskBefore);
    await assert.rejects(f.instance.accept("t", before.id), /Resolve active/);
    await f.instance.close();
    restored = f.manager();
    const reloaded = (await restored.get("t"))!;
    assert.equal(activeCodeReviewFindings(reloaded).length, 1);
    assert.equal(reloaded.outcome, "changes-requested");
    assert.equal(reloaded.findingDispositions?.length ?? 0, 0);
    await assert.rejects(restored.accept("t", before.id), /Resolve active/);
  } finally {
    await restored?.close();
    await f.close();
  }
});

test("a failed summary callback rolls back triage before the authoritative report commits", async () => {
  const f = await fixture();
  let failNext = false,
    observedSummary: typeof f.task.codeReview;
  const client = f.manager({}, () => {
    observedSummary = structuredClone(f.task.codeReview);
    if (failNext) {
      failNext = false;
      throw Error("Workspace summary save failed");
    }
  });
  let restored: CodeReviewManager | undefined;
  try {
    addReviewFinding(f);
    await client.start("t");
    const before = await f.settled(client),
      summary = structuredClone(f.task.codeReview);
    failNext = true;
    await assert.rejects(
      client.dismissFinding(
        "t",
        before.id,
        before.findings[0].id,
        "false-positive",
        "The caller already validates it.",
      ),
      /Workspace summary save failed/,
    );
    assert.deepEqual(await client.get("t"), before);
    assert.deepEqual(f.task.codeReview, summary);
    assert.deepEqual(
      observedSummary,
      summary,
      "rollback callback sees the original summary",
    );
    await assert.rejects(client.accept("t", before.id), /Resolve active/);
    await client.close();
    restored = f.manager();
    assert.deepEqual(
      await restored.get("t"),
      JSON.parse(JSON.stringify(before)),
      "restart reads the original report",
    );
    // After the problem is corrected, a new explicit action commits normally.
    const committed = await restored.dismissFinding(
      "t",
      before.id,
      before.findings[0].id,
      "false-positive",
      "The caller already validates it.",
    );
    assert.equal(committed.outcome, "ready");
    assert.equal(committed.findingDispositions?.length, 1);
  } finally {
    await restored?.close();
    await client.close();
    await f.close();
  }
});
