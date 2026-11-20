import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileRoutingCalibration,
  estimateRoutingCandidates,
  evaluateRouting,
  loadRoutingCalibration,
  routingEvaluationSchema,
  selectCalibratedCandidate,
  type RoutingCandidate,
  type RoutingCohort,
  type RoutingEvaluation,
  type RoutingOutcome,
} from "../runtime/routing-calibration";

const cohort: RoutingCohort = {
  kind: "fix",
  tier: "balanced",
  coverage: "measured",
};
const expensive: RoutingCandidate = {
  harness: "codex",
  model: "codex-test-1",
  effort: "medium",
};
const cheap: RoutingCandidate = {
  harness: "claude",
  model: "sonnet",
  resolvedModel: "claude-sonnet-test-1",
  effort: "medium",
};
const revision = "1".repeat(40);

function run(
  repoId: string,
  candidate: RoutingCandidate,
  overrides: Partial<RoutingOutcome> = {},
): RoutingOutcome {
  return {
    repoId,
    storyId: "story-1",
    revision,
    cohort,
    candidate,
    observedModel: candidate.resolvedModel ?? candidate.model,
    observedEffort: candidate.effort,
    execution: "completed",
    blindReview: "passed",
    checks: "passed",
    acceptance: "accepted",
    totalCostMicros: candidate.harness === "codex" ? 200 : 100,
    totalTokens: 1000,
    totalDurationMs: 2000,
    ...overrides,
  };
}

const training = Array.from({ length: 250 }, (_, index) =>
  [expensive, cheap].map((candidate) => run(`train-${index}`, candidate)),
).flat();

test("calibration is input-order stable, excludes held-out repositories, and chooses the lowest verified cost", () => {
  const heldOut = run("holdout", cheap, {
    totalCostMicros: 999,
    acceptance: "rejected",
  });
  const calibration = compileRoutingCalibration(
    [...training, heldOut],
    ["holdout"],
  );
  const reversed = compileRoutingCalibration([...training].reverse(), [
    "holdout",
  ]);
  assert.equal(reversed.digest, calibration.digest);
  assert.deepEqual(
    loadRoutingCalibration(JSON.parse(JSON.stringify(calibration))),
    calibration,
  );
  const estimates = estimateRoutingCandidates(calibration, cohort, [
    expensive,
    cheap,
  ]);
  assert.equal(estimates.length, 2);
  assert.ok(
    estimates.every(
      (row) =>
        row.repositories === 250 && row.accepted === 250 && row.lowerBound < 1,
    ),
  );
  assert.deepEqual(
    selectCalibratedCandidate(estimates, [expensive, cheap], 0.9)?.candidate,
    cheap,
  );
  assert.deepEqual(
    selectCalibratedCandidate(estimates, [expensive], 0.9)?.candidate,
    expensive,
  );
  assert.equal(
    selectCalibratedCandidate(estimates, [expensive, cheap], 1),
    undefined,
  );
  assert.deepEqual(
    estimateRoutingCandidates(calibration, { ...cohort, coverage: "partial" }, [
      cheap,
    ]),
    [],
  );
});

test("missing proof and pending reviews remain unresolved, while failures and observed fallbacks count against first-pass acceptance", () => {
  const rows = [
    run("training-1", expensive, {
      observedEffort: null,
      blindReview: "unverified",
      acceptance: "pending",
      totalCostMicros: null,
    }),
    run("training-2", expensive, { observedModel: "provider-other-2" }),
    run("training-3", expensive, { checks: "failed" }),
    run("training-4", expensive),
  ];
  const [estimate] = compileRoutingCalibration(rows, ["holdout"]).cohorts[0]
    .estimates;
  assert.equal(estimate.samples, 4);
  assert.equal(estimate.accepted, 1);
  assert.equal(estimate.unresolved, 1);
  assert.equal(estimate.meanTotalCostMicros, null);
  assert.equal(
    selectCalibratedCandidate([estimate], [expensive], 0.5),
    undefined,
  );
});

test("duplicate and conflicting case inputs fail, and unmatched candidate rows cannot skew a comparison", () => {
  const row = run("shared", cheap);
  assert.throws(
    () => compileRoutingCalibration([row, row], ["holdout"]),
    /Duplicate first-pass/,
  );
  assert.throws(
    () =>
      compileRoutingCalibration(
        [row, run("shared", expensive, { revision: "2".repeat(40) })],
        ["holdout"],
      ),
    /one frozen revision/,
  );
  const calibration = compileRoutingCalibration(
    [row, run("shared", expensive), run("unmatched", cheap)],
    ["holdout"],
  );
  assert.ok(
    calibration.cohorts[0].estimates.every(
      (estimate) => estimate.samples === 1,
    ),
  );
});

test("persisted calibration rejects tampering, unresolved aliases and invalid cost fields", () => {
  const calibration = compileRoutingCalibration(training, ["holdout"]);
  assert.equal(
    loadRoutingCalibration({ ...calibration, version: "unknown" }),
    undefined,
  );
  const tampered = structuredClone(calibration);
  tampered.cohorts[0].estimates[0].meanTotalCostMicros = 1;
  assert.equal(loadRoutingCalibration(tampered), undefined);
  tampered.cohorts[0].estimates[0].meanTotalCostMicros = -1;
  assert.equal(loadRoutingCalibration(tampered), undefined);
  const staleAlias = { ...cheap, resolvedModel: "claude-sonnet-test-2" };
  assert.deepEqual(
    estimateRoutingCandidates(calibration, cohort, [
      staleAlias,
      { ...cheap, resolvedModel: undefined },
    ]),
    [],
  );
  assert.deepEqual(
    compileRoutingCalibration(
      [run("test", { ...cheap, resolvedModel: undefined })],
      ["holdout"],
    ).cohorts,
    [],
  );
});

test("held-out policy evaluation reports only paired stories and a common denominator for each cost metric", () => {
  const frozenStory = { repoId: "holdout", storyId: "story-1", revision };
  const routes = {
    current: expensive,
    wording: cheap,
    graph: expensive,
    combined: cheap,
  };
  const input: RoutingEvaluation = {
    version: 1,
    heldOutRepoIds: [frozenStory.repoId],
    outcomes: [
      run("train", cheap),
      run("holdout", expensive),
      run("holdout", cheap, { acceptance: "pending", totalCostMicros: null }),
      run("holdout", expensive, { storyId: "missing-variant" }),
    ],
    decisions: [
      { ...frozenStory, routes },
      { ...frozenStory, storyId: "missing-variant", routes },
    ],
  };
  const report = evaluateRouting(routingEvaluationSchema.parse(input));
  assert.equal(report.heldOutStories, 2);
  assert.equal(report.pairedStories, 1);
  assert.equal(
    report.policies.find((row) => row.policy === "current")?.observedStories,
    2,
  );
  assert.equal(
    report.policies.find((row) => row.policy === "combined")?.unresolved,
    1,
  );
  assert.ok(
    report.policies.every(
      (row) => row.costMicros.samples === 0 && row.costMicros.mean === null,
    ),
  );
  assert.ok(
    report.policies.every(
      (row) => row.tokens.samples === 1 && row.tokens.mean === 1000,
    ),
  );
});
