import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reviewMetricPair,
  reviewQualityComparison,
} from "../src/code-review-comparison";
import { reviewQuality } from "../src/code-review-presentation";
import type { CodeReviewMetric } from "../src/code-review";

const measured = (symbol = "validate"): CodeReviewMetric => ({
  symbol,
  path: "src/auth.ts",
  line: 2,
  source: "ast",
  cognitive: 0,
  cyclomatic: 1,
  nesting: 0,
  maintainabilityIndex: 85,
  before: { cognitive: 8, cyclomatic: 5, nesting: 3, maintainabilityIndex: 60 },
  comparison: {
    status: "matched",
    beforeSourceHash: "a".repeat(64),
    afterSourceHash: "b".repeat(64),
    metricsVersion: 1,
    qualityMetricsVersion: 1,
  },
});

test("comparisons use identical paired declarations and preserve a genuine zero", () => {
  const axes = reviewQualityComparison([measured()]);
  assert.deepEqual(
    axes.map(({ key, before, after, delta, paired }) => ({
      key,
      before,
      after,
      delta,
      paired,
    })),
    [
      {
        key: "maintainabilityIndex",
        before: 60,
        after: 85,
        delta: 25,
        paired: 1,
      },
      { key: "cognitive", before: 8, after: 0, delta: -8, paired: 1 },
      { key: "cyclomatic", before: 5, after: 1, delta: -4, paired: 1 },
      { key: "nesting", before: 3, after: 0, delta: -3, paired: 1 },
    ],
  );
  assert.equal(axes[0].better, "higher");
  assert.equal(axes[1].better, "lower");
});

test("new, removed, renamed and uncertain declarations never enter the paired mean", () => {
  const first = measured();
  const extras = (
    ["added", "removed", "ambiguous", "unavailable"] as const
  ).map((status, i) => ({ ...measured(`extra${i}`), comparison: { status } }));
  const axes = reviewQualityComparison([
    first,
    ...extras,
    { ...measured("old"), comparison: undefined },
  ]);
  assert.ok(axes.every((axis) => axis.paired === 1));
  assert.equal(axes[0].before, 60);
  assert.equal(axes[0].after, 85);
});

test("each axis reports its own missing-pair count rather than coercing a missing baseline to zero", () => {
  const first = measured(),
    second = {
      ...measured("other"),
      before: {
        ...measured().before!,
        cognitive: null,
        maintainabilityIndex: null,
      },
    };
  const axes = reviewQualityComparison([first, second]);
  assert.equal(axes[0].paired, 1);
  assert.equal(axes[1].paired, 1);
  assert.equal(axes[2].paired, 2);
  assert.equal(
    reviewMetricPair({ ...first, before: undefined }, "cognitive").delta,
    null,
  );
});

test("invalid and estimated values never become native comparisons", () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(
      reviewMetricPair({ ...measured(), cognitive: invalid }, "cognitive")
        .delta,
      null,
    );
    assert.equal(
      reviewMetricPair(
        {
          ...measured(),
          before: { ...measured().before!, cognitive: invalid },
        },
        "cognitive",
      ).delta,
      null,
    );
  }
  assert.equal(
    reviewMetricPair(
      { ...measured(), maintainabilityIndex: 101 },
      "maintainabilityIndex",
    ).after,
    null,
  );
  assert.equal(
    reviewMetricPair({ ...measured(), source: "estimated" }, "cognitive").delta,
    null,
  );
});

test("duplicate records cannot overweight a mean or conceal contradictory measurements", () => {
  const first = measured(),
    other = { ...measured("other"), maintainabilityIndex: 55 };
  assert.equal(
    reviewQualityComparison([first, { ...first }, other])[0].after,
    70,
  );
  const conflict = { ...first, cognitive: 100 };
  assert.equal(reviewQualityComparison([first, conflict, other])[0].paired, 1);
  assert.equal(reviewQualityComparison([first, conflict, other])[0].after, 55);
});

test("removed functions retain their baseline but do not dilute the current maintainability score", () => {
  const removed: CodeReviewMetric = {
    ...measured("removed"),
    cognitive: null,
    cyclomatic: null,
    nesting: null,
    maintainabilityIndex: null,
    comparison: { status: "removed" },
  };
  assert.equal(reviewMetricPair(removed, "maintainabilityIndex").after, null);
  assert.equal(
    reviewQuality({
      state: "completed",
      coverage: { complete: true, limitations: [] },
      metrics: [measured(), removed],
    }).score,
    85,
  );
  assert.equal(
    reviewQuality({
      state: "completed",
      coverage: { complete: true, limitations: [] },
      metrics: [removed],
    }).score,
    null,
  );
});
