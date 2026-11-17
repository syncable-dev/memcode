import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewQuality } from "../src/code-review-presentation.ts";
import type { CodeReviewMetric, StoryReviewRun } from "../src/code-review.ts";

const metric = (symbol: string, mi: number | null): CodeReviewMetric => ({
  symbol,
  path: "src/auth.ts",
  line: 10,
  source: "ast",
  cognitive: 3,
  cyclomatic: 2,
  nesting: 1,
  maintainabilityIndex: mi,
});
const run = (
  metrics: CodeReviewMetric[],
  overrides: Partial<
    Pick<StoryReviewRun, "state" | "outcome" | "coverage">
  > = {},
) => ({
  state: "completed" as const,
  coverage: { complete: true, limitations: [] },
  metrics,
  ...overrides,
});

test("native MI mean retains a weak function and genuine zero, independent of findings", () => {
  const result = reviewQuality(run([metric("a", 0), metric("b", 100)]));
  assert.deepEqual(result, { score: 50, measured: 2, lowest: 0, reason: null });
  assert.equal(
    reviewQuality(run([metric("a", 90)], { outcome: "changes-requested" }))
      .score,
    90,
  );
});

test("a partial report never presents its successful subset as the whole change", () => {
  const result = reviewQuality(
    run([metric("a", 90)], {
      coverage: { complete: false, limitations: ["another lookup failed"] },
    }),
  );
  assert.equal(result.score, null);
  assert.equal(result.measured, 1);
  assert.match(result.reason!, /Partial coverage/);
});

test("missing, estimated and invalid measurements suppress the aggregate", () => {
  for (const bad of [
    metric("b", null),
    metric("b", Number.NaN),
    metric("b", Number.POSITIVE_INFINITY),
    metric("b", 101),
    metric("b", -1),
    { ...metric("b", 85), source: "estimated" as const },
  ]) {
    assert.equal(reviewQuality(run([metric("a", 90), bad])).score, null);
  }
  assert.equal(reviewQuality(run([])).score, null);
  assert.equal(reviewQuality(null).score, null);
});

test("old or unfinished reports do not advertise a current score", () => {
  for (const state of [
    "queued",
    "running",
    "stale",
    "cancelled",
    "failed",
  ] as const)
    assert.equal(reviewQuality(run([metric("a", 90)], { state })).score, null);
});

test("deduplicating a function cannot overweight it or hide contradictory evidence", () => {
  const a = metric("a", 80);
  assert.equal(reviewQuality(run([a, { ...a }, metric("b", 20)])).score, 50);
  assert.equal(
    reviewQuality(run([a, { ...a, maintainabilityIndex: 90 }])).score,
    null,
  );
  assert.equal(reviewQuality(run([a, { ...a, symbol: "" }])).score, null);
  assert.equal(
    reviewQuality(
      run([a, { ...a, path: "src/Auth.ts", maintainabilityIndex: 20 }]),
    ).score,
    50,
  );
});
