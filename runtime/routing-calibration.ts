import { createHash } from "node:crypto";
import { z } from "zod";
import { harnessIds } from "../src/shared";

const modelId = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim());
const effort = z.enum(["low", "medium", "high", "xhigh"]);
const candidateSchema = z.strictObject({
  harness: z.enum(harnessIds),
  model: modelId,
  effort,
  resolvedModel: modelId.optional(),
});
const cohortSchema = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  tier: z.enum(["fast", "balanced", "frontier", "extreme"]),
  coverage: z.enum(["measured", "partial"]),
  languageModelDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  lowMaintainability: z.literal(true).optional(),
});
const nonnegative = z.int().nonnegative();
const estimateSchema = z.strictObject({
  candidate: candidateSchema,
  samples: nonnegative,
  repositories: nonnegative,
  accepted: nonnegative,
  unresolved: nonnegative,
  lowerBound: z.number().min(0).max(1),
  meanTotalCostMicros: z
    .number()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
});
const profileSchema = z.strictObject({
  version: z.literal("memcode-controlled-routing-v1"),
  cohorts: z.array(
    z.strictObject({
      cohort: cohortSchema,
      estimates: z.array(estimateSchema).min(1),
    }),
  ),
});
const calibrationSchema = profileSchema.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export type RoutingCandidate = z.infer<typeof candidateSchema>;
export type RoutingCohort = z.infer<typeof cohortSchema>;
export type RoutingEstimate = z.infer<typeof estimateSchema>;
export type RoutingCalibration = z.infer<typeof calibrationSchema>;

const frozenStory = {
  repoId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  storyId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
};
const check = z.enum(["passed", "failed", "unverified"]);
const outcomeSchema = z.strictObject({
  ...frozenStory,
  cohort: cohortSchema,
  candidate: candidateSchema,
  observedModel: modelId.nullable(),
  observedEffort: effort.nullable(),
  execution: z.enum(["completed", "failed", "running"]),
  checks: check,
  blindReview: check,
  acceptance: z.enum(["accepted", "rejected", "pending"]),
  totalCostMicros: nonnegative.nullable(),
  totalTokens: nonnegative.nullable(),
  totalDurationMs: nonnegative.nullable(),
});
export type RoutingOutcome = z.infer<typeof outcomeSchema>;
export const routingEvaluationPolicies = [
  "current",
  "wording",
  "graph",
  "combined",
] as const;
const policySchema = z.strictObject({
  ...frozenStory,
  routes: z.record(
    z.enum(routingEvaluationPolicies),
    candidateSchema.nullable(),
  ),
});
export const routingEvaluationSchema = z.strictObject({
  version: z.literal(1),
  heldOutRepoIds: z.array(frozenStory.repoId).min(1),
  outcomes: z.array(outcomeSchema),
  decisions: z.array(policySchema),
});
export type RoutingEvaluation = z.infer<typeof routingEvaluationSchema>;

const cohortKey = ({
  kind,
  tier,
  coverage,
  languageModelDigest,
  lowMaintainability,
}: RoutingCohort) =>
  JSON.stringify([
    kind,
    tier,
    coverage,
    languageModelDigest ?? null,
    lowMaintainability ?? false,
  ]);
const candidateKey = ({
  harness,
  model,
  effort,
  resolvedModel,
}: RoutingCandidate) =>
  JSON.stringify([harness, model, effort, resolvedModel ?? null]);
const storyKey = ({
  repoId,
  storyId,
  revision,
}: Pick<RoutingOutcome, "repoId" | "storyId" | "revision">) =>
  JSON.stringify([repoId, storyId, revision]);
const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const digest = (profile: z.infer<typeof profileSchema>) =>
  createHash("sha256").update(JSON.stringify(profile)).digest("hex");
const knownAlias =
  /^(?:.*[ -])?(?:auto|default|latest|haiku|sonnet|opus|fable)(?:\[.*\])?$/i;
function concreteModel(candidate: RoutingCandidate): string | undefined {
  const model = candidate.resolvedModel ?? candidate.model;
  // A family or an opaque, undated ID needs explicit provider resolution.
  if (
    !knownAlias.test(model) &&
    (candidate.resolvedModel || /\d/.test(model.split("[")[0]))
  )
    return model;
}

function firstPass(
  run: RoutingOutcome,
): "accepted" | "rejected" | "unresolved" {
  const model = concreteModel(run.candidate);
  if (
    run.execution === "failed" ||
    run.checks === "failed" ||
    run.blindReview === "failed" ||
    run.acceptance === "rejected" ||
    (model && run.observedModel && run.observedModel !== model) ||
    (run.observedEffort && run.observedEffort !== run.candidate.effort)
  )
    return "rejected";
  if (
    run.execution === "completed" &&
    model &&
    run.observedModel === model &&
    run.observedEffort === run.candidate.effort &&
    run.checks === "passed" &&
    run.blindReview === "passed" &&
    run.acceptance === "accepted"
  )
    return "accepted";
  return "unresolved";
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce(
    (average, value, index) => average + (value - average) / (index + 1),
    0,
  );
}

function indexOutcomes(outcomes: readonly RoutingOutcome[]) {
  const stories = new Map<string, Map<string, RoutingOutcome>>();
  const frozen = new Map<string, { revision: string; cohort: string }>();
  for (const run of outcomes) {
    const story = storyKey(run);
    const identity = JSON.stringify([run.repoId, run.storyId]);
    const previous = frozen.get(identity);
    if (
      previous &&
      (previous.revision !== run.revision ||
        previous.cohort !== cohortKey(run.cohort))
    )
      throw Error(
        "Comparisons require one frozen revision and cohort per story.",
      );
    frozen.set(identity, {
      revision: run.revision,
      cohort: cohortKey(run.cohort),
    });
    const candidates = stories.get(story) ?? new Map();
    const candidate = candidateKey(run.candidate);
    if (candidates.has(candidate))
      throw Error(
        "Duplicate first-pass outcome for a story and configuration.",
      );
    candidates.set(candidate, run);
    stories.set(story, candidates);
  }
  return stories;
}

function estimate(
  runs: RoutingOutcome[],
  comparisons: number,
): RoutingEstimate {
  const repositories = new Map<string, RoutingOutcome[]>();
  for (const run of runs) {
    const rows = repositories.get(run.repoId) ?? [];
    rows.push(run);
    repositories.set(run.repoId, rows);
  }
  const repoSuccess = mean(
    [...repositories.values()].map(
      (rows) =>
        rows.filter((row) => firstPass(row) === "accepted").length /
        rows.length,
    ),
  )!;
  const repoCosts = [...repositories.values()].map((rows) =>
    rows.every((row) => row.totalCostMicros !== null)
      ? mean(rows.map((row) => row.totalCostMicros!))
      : null,
  );
  // Count each repository once. Separate stories in one codebase can share
  // their failure modes. Pending outcomes contribute zero to the floor.
  const margin = Math.sqrt(
    Math.log(comparisons / 0.05) / (2 * repositories.size),
  );
  return {
    candidate: runs[0].candidate,
    samples: runs.length,
    repositories: repositories.size,
    accepted: runs.filter((row) => firstPass(row) === "accepted").length,
    unresolved: runs.filter((row) => firstPass(row) === "unresolved").length,
    lowerBound: Math.max(0, repoSuccess - margin),
    meanTotalCostMicros: repoCosts.every((cost) => cost !== null)
      ? mean(repoCosts as number[])
      : null,
  };
}

export function compileRoutingCalibration(
  outcomes: readonly RoutingOutcome[],
  heldOutRepoIds: readonly string[],
): RoutingCalibration {
  if (!heldOutRepoIds.length)
    throw Error("Reserve whole repositories before calibrating the router.");
  const heldOut = new Set(heldOutRepoIds);
  const stories = indexOutcomes(
    outcomes.filter((run) => !heldOut.has(run.repoId)),
  );
  const groups = new Map<string, Map<string, RoutingOutcome>[]>();
  for (const [, story] of [...stories].sort(([a], [b]) => compare(a, b))) {
    const key = cohortKey(story.values().next().value!.cohort);
    const items = groups.get(key) ?? [];
    items.push(story);
    groups.set(key, items);
  }
  const cohorts: RoutingCalibration["cohorts"] = [];
  for (const [, group] of [...groups].sort(([a], [b]) => compare(a, b))) {
    const candidates = new Set(
      group.flatMap((story) =>
        [...story.values()]
          .filter((row) => concreteModel(row.candidate))
          .map((row) => candidateKey(row.candidate)),
      ),
    );
    const keys = [...candidates].sort(compare);
    if (!keys.length) continue;
    const matched = group.filter((story) =>
      keys.every((key) => story.has(key)),
    );
    if (!matched.length) continue;
    const cohort = matched[0].get(keys[0])!.cohort;
    cohorts.push({
      cohort,
      estimates: keys.map((key) =>
        estimate(
          matched.map((story) => story.get(key)!),
          keys.length,
        ),
      ),
    });
  }
  const profile = profileSchema.parse({
    version: "memcode-controlled-routing-v1",
    cohorts,
  });
  return { ...profile, digest: digest(profile) };
}

export function loadRoutingCalibration(
  value: unknown,
): RoutingCalibration | undefined {
  const parsed = calibrationSchema.safeParse(value);
  if (!parsed.success) return;
  const profile = profileSchema.parse({
    version: parsed.data.version,
    cohorts: parsed.data.cohorts,
  });
  if (
    digest(profile) !== parsed.data.digest ||
    new Set(profile.cohorts.map((row) => cohortKey(row.cohort))).size !==
      profile.cohorts.length
  )
    return;
  for (const { estimates } of profile.cohorts) {
    if (
      new Set(estimates.map((row) => candidateKey(row.candidate))).size !==
        estimates.length ||
      estimates.some(
        (row) =>
          !concreteModel(row.candidate) ||
          row.repositories === 0 ||
          row.repositories > row.samples ||
          row.accepted + row.unresolved > row.samples ||
          row.lowerBound >
            Math.max(
              0,
              1 -
                Math.sqrt(
                  Math.log(estimates.length / 0.05) / (2 * row.repositories),
                ),
            ),
      )
    )
      return;
  }
  return parsed.data;
}

export function estimateRoutingCandidates(
  calibration: RoutingCalibration,
  cohort: RoutingCohort,
  eligible: readonly RoutingCandidate[],
): RoutingEstimate[] {
  const keys = new Set(eligible.map(candidateKey));
  return (
    calibration.cohorts
      .find((row) => cohortKey(row.cohort) === cohortKey(cohort))
      ?.estimates.filter((row) => keys.has(candidateKey(row.candidate))) ?? []
  );
}

export function selectCalibratedCandidate(
  estimates: readonly RoutingEstimate[],
  eligible: readonly RoutingCandidate[],
  reliabilityTarget: number,
): RoutingEstimate | undefined {
  if (
    !Number.isFinite(reliabilityTarget) ||
    reliabilityTarget <= 0 ||
    reliabilityTarget > 1
  )
    return;
  const keys = new Set(eligible.map(candidateKey));
  return estimates
    .filter(
      (row) =>
        keys.has(candidateKey(row.candidate)) &&
        concreteModel(row.candidate) &&
        row.samples >= 30 &&
        row.repositories >= 8 &&
        row.lowerBound >= reliabilityTarget &&
        row.meanTotalCostMicros !== null &&
        Number.isFinite(row.meanTotalCostMicros) &&
        row.meanTotalCostMicros >= 0,
    )
    .sort(
      (a, b) =>
        a.meanTotalCostMicros! - b.meanTotalCostMicros! ||
        b.lowerBound - a.lowerBound ||
        compare(candidateKey(a.candidate), candidateKey(b.candidate)),
    )[0];
}

export function evaluateRouting(input: RoutingEvaluation) {
  const outcomes = indexOutcomes(input.outcomes);
  const heldOut = new Set(input.heldOutRepoIds);
  const decisions = input.decisions
    .filter((decision) => heldOut.has(decision.repoId))
    .sort((a, b) => compare(storyKey(a), storyKey(b)));
  if (new Set(decisions.map(storyKey)).size !== decisions.length)
    throw Error("Duplicate held-out policy decision for one frozen story.");
  const selected = decisions.map((decision) =>
    routingEvaluationPolicies.map((policy) => {
      const candidate = decision.routes[policy];
      return candidate
        ? outcomes.get(storyKey(decision))?.get(candidateKey(candidate))
        : undefined;
    }),
  );
  const paired = selected.filter((row): row is RoutingOutcome[] =>
    row.every((run) => run !== undefined),
  );
  const pairedMetric = (
    field: "totalCostMicros" | "totalTokens" | "totalDurationMs",
    index: number,
  ) => {
    const values = paired
      .filter((row) => row.every((run) => run[field] !== null))
      .map((row) => row[index][field]!);
    return { samples: values.length, mean: mean(values) };
  };
  return {
    heldOutRepositories: heldOut.size,
    heldOutStories: decisions.length,
    pairedStories: paired.length,
    policies: routingEvaluationPolicies.map((policy, index) => {
      const runs = paired.map((row) => row[index]);
      const status = runs.map(firstPass);
      return {
        policy,
        observedStories: selected.filter((row) => row[index] !== undefined)
          .length,
        accepted: status.filter((value) => value === "accepted").length,
        rejected: status.filter((value) => value === "rejected").length,
        unresolved: status.filter((value) => value === "unresolved").length,
        costMicros: pairedMetric("totalCostMicros", index),
        tokens: pairedMetric("totalTokens", index),
        durationMs: pairedMetric("totalDurationMs", index),
      };
    }),
    calibration: compileRoutingCalibration(
      input.outcomes,
      input.heldOutRepoIds,
    ),
  };
}
