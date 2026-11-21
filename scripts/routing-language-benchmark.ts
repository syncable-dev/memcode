import { readFile, stat } from "node:fs/promises";
import { release } from "node:os";
import { performance } from "node:perf_hooks";
import { analyzeRoutingIntent } from "../runtime/routing-intent";
import {
  createRoutingLanguageSnapshot,
  extractRoutingLanguageFeatures,
  loadRoutingLanguageModel,
  MAX_ROUTING_LANGUAGE_SNAPSHOT_BYTES,
  MAX_ROUTING_LANGUAGE_WEIGHTS,
  RUNTIME_LANGUAGE_FEATURE_COUNT,
  routingLanguageKinds,
  scoreRoutingLanguageFeatures,
} from "../runtime/routing-language-model";

const brief = [
  {
    title: "Preserve the list selection on refresh",
    description:
      "When I refresh the board, my selected item disappears. Keep the public API unchanged. Add a regression test around `src/components/List.tsx:20`.",
  },
  {
    title: "Where is the request cancellation handled?",
    description:
      "Walk through the worker lifecycle and explain the timeouts. Do not change any files.",
  },
  {
    title: "Pull request validation in the background",
    description:
      "Refactor the status check so it can run without blocking. Rename the private helper `resolveStatus` to make it clearer.",
  },
  {
    title: "Setup stalls",
    description:
      "On a clean install the first connection says `socket timeout`. Research how long the handshake should take and propose acceptance criteria.",
  },
];
const adjectives = [
  "isolated",
  "parallel",
  "initial",
  "updated",
  "archived",
  "concurrent",
  "visible",
  "periodic",
  "stale",
  "persisted",
  "readable",
  "restored",
  "focused",
  "ephemeral",
  "bounded",
  "synthesized",
  "aggregated",
  "selected",
  "historical",
  "nested",
  "scheduled",
  "versioned",
];
const nouns = [
  "session",
  "workspace",
  "checkout",
  "story",
  "terminal",
  "snapshot",
  "reference",
  "plan",
  "handoff",
  "report",
  "conversation",
  "metadata",
  "transcript",
  "worker",
  "artifact",
  "fallback",
  "request",
  "task",
  "dependency",
  "module",
];
const longBrief = {
  title: "Reconcile worker and project state across desktop restart",
  description: adjectives
    .flatMap((adjective) =>
      nouns.map((noun) => `verify the ${adjective} ${noun}`),
    )
    .join(". ")
    .slice(0, 6000),
};

function syntheticSnapshot() {
  // Populate the size limit and force representative matching lookups.
  // These artificial parameters are for timing only.
  const used = new Set(
    [...brief, longBrief].flatMap(({ title, description }) =>
      extractRoutingLanguageFeatures(title, description),
    ),
  );
  const features = [...used].slice(0, MAX_ROUTING_LANGUAGE_WEIGHTS);
  for (
    let index = 0;
    features.length < MAX_ROUTING_LANGUAGE_WEIGHTS &&
    index < RUNTIME_LANGUAGE_FEATURE_COUNT;
    index++
  )
    if (!used.has(index)) features.push(index);
  return createRoutingLanguageSnapshot(
    routingLanguageKinds.map((kind, label) => ({
      kind,
      threshold: 0.8,
      minFeatures: 2,
      bias: (label - 3) / 12,
      weights: features.map((feature, index) => [
        feature,
        (((index + label) % 2 ? 1 : -1) * ((index % 7) + 1)) / 100,
      ]),
    })),
  );
}

function collectGarbage() {
  if (global.gc) for (let i = 0; i < 3; i++) global.gc();
}

function latency(samples: number[]) {
  samples.sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    Number(samples[Math.ceil(samples.length * fraction) - 1].toFixed(4));
  return {
    iterations: samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

if (process.argv.length > 3)
  throw Error(
    "Usage: node --expose-gc --import tsx scripts/routing-language-benchmark.ts [model.json]",
  );
const path = process.argv[2];
if (path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_ROUTING_LANGUAGE_SNAPSHOT_BYTES)
    throw Error(
      `Use a model snapshot of at most ${MAX_ROUTING_LANGUAGE_SNAPSHOT_BYTES / 1024} KiB.`,
    );
}
const archive = path
  ? await readFile(path, "utf8")
  : JSON.stringify(syntheticSnapshot());
collectGarbage();
const before = process.memoryUsage();
const start = performance.now();
const model = loadRoutingLanguageModel(JSON.parse(archive));
const loadMs = Number((performance.now() - start).toFixed(3));
if (!model)
  throw Error("The routing language snapshot did not pass runtime validation.");
collectGarbage();
const after = process.memoryUsage();

function sample(inputs: typeof brief, rounds: number) {
  const rules: number[] = [],
    featuresOnly: number[] = [],
    inference: number[] = [];
  const scoredFeatures = inputs.map(({ title, description }) =>
    extractRoutingLanguageFeatures(title, description),
  );
  function measure<T>(fn: () => T, samples: number[], collecting: boolean) {
    const start = performance.now();
    const result = fn();
    if (collecting) samples.push(performance.now() - start);
    return result;
  }
  for (let index = 0; index < 500 + rounds; index++) {
    const input = inputs[index % inputs.length];
    const collecting = index >= 500;
    measure(() => analyzeRoutingIntent(input), rules, collecting);
    measure(
      () => extractRoutingLanguageFeatures(input.title, input.description),
      featuresOnly,
      collecting,
    );
    measure(
      () =>
        scoreRoutingLanguageFeatures(
          model!,
          scoredFeatures[index % inputs.length],
        ),
      inference,
      collecting,
    );
  }
  const perPass = featuresOnly.map(
    (duration, index) => duration + inference[index],
  );
  return {
    rules: latency(rules),
    additionalFeatures: latency(featuresOnly),
    additionalScoring: latency(inference),
    additionalClassifier: latency(perPass),
    maxObservedFeatures: Math.max(
      ...scoredFeatures.map((features) => features.length),
    ),
  };
}

const deltaKiB = (key: keyof NodeJS.MemoryUsage) =>
  Number(((after[key] - before[key]) / 1024).toFixed(1));
console.log(
  JSON.stringify(
    {
      platform: `${process.platform} ${process.arch} ${release()}`,
      node: process.version,
      architecture: path
        ? "provided snapshot"
        : "synthetic maximum-size weights",
      snapshotBytes: Buffer.byteLength(archive),
      parseAndValidateMs: loadMs,
      retainedMemoryKiB: global.gc
        ? {
            heapUsed: deltaKiB("heapUsed"),
            arrayBuffers: deltaKiB("arrayBuffers"),
            rss: deltaKiB("rss"),
          }
        : null,
      brief: sample(brief, 3000),
      longBrief: sample([longBrief], 1500),
    },
    null,
    2,
  ),
);
