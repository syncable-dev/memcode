import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRoutingLanguageSnapshot,
  extractRoutingLanguageFeatures,
  loadRoutingLanguageModel,
  MAX_ROUTING_LANGUAGE_FEATURES,
  predictRoutingLanguage,
  RUNTIME_LANGUAGE_FEATURE_COUNT,
  scoreRoutingLanguageFeatures,
  type RoutingLanguageLabel,
} from "../runtime/routing-language-model";

const label: RoutingLanguageLabel = {
  kind: "fix",
  bias: -1,
  threshold: 0.75,
  minFeatures: 2,
  weights: [
    [2, 1.25],
    [123, 1.25],
    [101, -3],
  ],
};

test("language features are normalized, content-masked and capped", () => {
  assert.deepEqual(
    extractRoutingLanguageFeatures(
      "Ａdd `CustomerId`",
      "Check src/internal.ts:55",
    ),
    extractRoutingLanguageFeatures(
      "add `OtherId`",
      "check resources\\private.py:24",
    ),
  );
  assert.deepEqual(
    extractRoutingLanguageFeatures(
      "Prep WORK",
      "open https://example.com/path",
    ),
    extractRoutingLanguageFeatures(
      "prep work",
      "open https://others.dev/local",
    ),
  );
  assert.deepEqual(
    extractRoutingLanguageFeatures(
      "Investigate",
      "line\n```\nlarge ignored span\n```",
    ),
    extractRoutingLanguageFeatures("investigate", "line"),
  );
  const varied = [
    "alternating generators become moderately expensive",
    "plausible compatibility diagnosis started linguistically",
    "normalization pipeline reproduces identifier structure",
  ].join(" ");
  const indices = extractRoutingLanguageFeatures(
    varied.repeat(500),
    varied.repeat(800),
  );
  assert.ok(indices.length <= MAX_ROUTING_LANGUAGE_FEATURES);
  assert.equal(new Set(indices).size, indices.length);
  assert.ok(
    indices.every(
      (index) => index >= 0 && index < RUNTIME_LANGUAGE_FEATURE_COUNT,
    ),
  );
  assert.ok(
    indices.every(
      (index, offset) => offset === 0 || index > indices[offset - 1],
    ),
  );
});

test("snapshot canonicalization is stable and packed weights reproduce the expected logits", () => {
  const another: RoutingLanguageLabel = {
    ...label,
    kind: "test",
    threshold: 0.9,
  };
  const snapshot = createRoutingLanguageSnapshot([label, another]);
  const reordered = createRoutingLanguageSnapshot([
    another,
    { ...label, weights: [...label.weights].reverse() },
  ]);
  assert.equal(reordered.digest, snapshot.digest);
  const model = loadRoutingLanguageModel(JSON.parse(JSON.stringify(snapshot)));
  assert.ok(model);
  assert.equal(
    model.labels.reduce((sum, item) => sum + item.weights.byteLength, 0),
    128 * 1024,
  );
  const result = scoreRoutingLanguageFeatures(model, [2, 123]);
  assert.deepEqual(result.accepted, ["fix"]);
  assert.deepEqual(
    result.scores.map(({ probability }) => probability),
    [1 / (1 + Math.exp(-1.5)), 1 / (1 + Math.exp(-1.5))],
  );
  assert.deepEqual(
    scoreRoutingLanguageFeatures(model, [2, 101, 123]).accepted,
    [],
  );
});

test("evidence limits abstain with sparse matches, negative-only matches or no words", () => {
  const model = loadRoutingLanguageModel(
    createRoutingLanguageSnapshot([
      {
        kind: "research",
        bias: 12,
        threshold: 0.75,
        minFeatures: 2,
        weights: [
          [2, -0.1],
          [123, -0.1],
          [127, 2],
        ],
      },
    ]),
  );
  assert.ok(model);
  assert.deepEqual(scoreRoutingLanguageFeatures(model, [2, 123]).accepted, []);
  assert.deepEqual(scoreRoutingLanguageFeatures(model, [127]).accepted, []);
  assert.deepEqual(predictRoutingLanguage(model, "", "").accepted, []);
  const matched = scoreRoutingLanguageFeatures(model, [2, 123, 127]);
  assert.deepEqual(matched.accepted, ["research"]);
  assert.equal(matched.scores[0].supportingFeatures, 1);
});

test("tampered, duplicate and malformed coefficients fail profile validation", () => {
  const snapshot = createRoutingLanguageSnapshot([label]);
  assert.equal(
    loadRoutingLanguageModel({ ...snapshot, runtime: "invalid" }),
    undefined,
  );
  assert.equal(
    loadRoutingLanguageModel({
      ...snapshot,
      labels: [{ ...label, threshold: 0.9 }],
    }),
    undefined,
  );
  assert.equal(
    loadRoutingLanguageModel({
      ...snapshot,
      labels: [
        { ...label, weights: [[RUNTIME_LANGUAGE_FEATURE_COUNT + 1, 3]] },
      ],
    }),
    undefined,
  );
  assert.throws(
    () => createRoutingLanguageSnapshot([label, label]),
    /only once/,
  );
  assert.throws(
    () =>
      createRoutingLanguageSnapshot([
        {
          ...label,
          weights: [
            [1, 1.5],
            [1, 2],
          ],
        },
      ]),
    /only once/,
  );
});
