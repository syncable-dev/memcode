import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRoutingLanguageModel } from "../runtime/routing-language-model";
import { trainRoutingLanguage } from "../scripts/routing-language-train";

function corpus() {
  const stories = [
    "train-a",
    "train-b",
    "calibrate-a",
    "calibrate-b",
    "held-a",
  ].flatMap((repoId) =>
    Array.from({ length: 24 }, (_, index) => ({
      repoId,
      storyId: `story-${index}`,
      title:
        index % 2
          ? "Scheduling helper cleanup"
          : "A walkthrough of retry ordering",
      description:
        index % 2
          ? "The scheduling code needs a cleanup of duplicated shared functions with the same behavior."
          : "I would appreciate a clear walkthrough of the sequence of retries.",
      kinds: index % 2 ? ["refactor"] : ["explain"],
    })),
  );
  return {
    version: 1,
    calibrationRepoIds: ["calibrate-a", "calibrate-b"],
    heldOutRepoIds: ["held-a"],
    stories,
  };
}

test("training is reproducible and held-out labels do not tune the snapshot", () => {
  const source = corpus();
  const first = trainRoutingLanguage(source);
  assert.ok(loadRoutingLanguageModel(first.snapshot));
  assert.deepEqual(first.report.train, { stories: 48, repositories: 2 });
  assert.equal(first.report.calibration.stories, 48);
  assert.equal(first.report.calibration.fallbackEligible, 48);
  assert.equal(first.report.heldOut.learnedOnFallback.stories, 24);
  assert.equal(first.report.heldOut.combined.exactStoryMatch, 1);
  assert.equal(first.report.heldOut.rules.abstained, 24);

  const reordered = trainRoutingLanguage({
    ...source,
    stories: [...source.stories].reverse(),
  });
  assert.deepEqual(first, reordered);
  const changed = trainRoutingLanguage({
    ...source,
    stories: source.stories.map((example) =>
      example.repoId === "held-a" ? { ...example, kinds: [] } : example,
    ),
  });
  assert.equal(changed.snapshot.digest, first.snapshot.digest);
  assert.equal(changed.report.heldOut.combined.exactStoryMatch, 0);
});

test("partitions are by repository, disjoint, and reject duplicate labels and stories", () => {
  const source = corpus();
  assert.throws(
    () => trainRoutingLanguage({ ...source, heldOutRepoIds: ["calibrate-a"] }),
    /disjoint/,
  );
  assert.throws(
    () => trainRoutingLanguage({ ...source, heldOutRepoIds: ["unknown"] }),
    /labeled stories/,
  );
  assert.throws(
    () =>
      trainRoutingLanguage({
        ...source,
        stories: [...source.stories, source.stories[0]],
      }),
    /Duplicate labeled story/,
  );
  assert.throws(
    () =>
      trainRoutingLanguage({
        ...source,
        stories: source.stories.map((story) => ({
          ...story,
          kinds: ["explain", "explain"],
        })),
      }),
    /once per story/,
  );
});
