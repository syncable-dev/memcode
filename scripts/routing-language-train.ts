import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { analyzeRoutingIntent } from "../runtime/routing-intent";
import {
  createRoutingLanguageSnapshot,
  extractRoutingLanguageFeatures,
  loadRoutingLanguageModel,
  MAX_ROUTING_LANGUAGE_WEIGHTS,
  RUNTIME_LANGUAGE_FEATURE_COUNT,
  routingLanguageKinds,
  scoreRoutingLanguageFeatures,
  type RoutingLanguageKind,
  type RoutingLanguageLabel,
  type RoutingLanguageModel,
} from "../runtime/routing-language-model";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const maxTrainingBytes = 32 * 1024 * 1024;
const minFeatures = 2;
const thresholdOptions = [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
const routingLanguageCorpusSchema = z.strictObject({
  version: z.literal(1),
  calibrationRepoIds: z.array(id).min(1).max(1000),
  heldOutRepoIds: z.array(id).min(1).max(1000),
  stories: z
    .array(
      z.strictObject({
        repoId: id,
        storyId: id,
        title: z.string().trim().min(1).max(500),
        description: z.string().max(6000),
        kinds: z
          .array(z.enum(routingLanguageKinds))
          .max(routingLanguageKinds.length),
      }),
    )
    .min(1)
    .max(10000),
});

type Story = z.infer<typeof routingLanguageCorpusSchema>["stories"][number];
type Example = Story & { features: number[] };

const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function splitCorpus(raw: unknown) {
  const parsed = routingLanguageCorpusSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .slice(0, 10)
      .map((issue) => issue.path.join("."));
    throw Error(
      `Invalid routing language corpus fields: ${fields.join(", ") || "input"}`,
    );
  }
  const { stories, calibrationRepoIds, heldOutRepoIds } = parsed.data;
  const calibrationRepos = new Set(calibrationRepoIds);
  const heldOutRepos = new Set(heldOutRepoIds);
  const repos = new Set(stories.map((story) => story.repoId));
  if (
    calibrationRepos.size !== calibrationRepoIds.length ||
    heldOutRepos.size !== heldOutRepoIds.length
  )
    throw Error("Duplicate repositories in the corpus partition list.");
  if (heldOutRepoIds.some((id) => calibrationRepos.has(id)))
    throw Error("Calibration and held-out repositories must be disjoint.");
  if ([...calibrationRepos, ...heldOutRepos].some((id) => !repos.has(id)))
    throw Error(
      "Every declared calibration and held-out repository needs labeled stories.",
    );

  const train: Example[] = [],
    calibration: Example[] = [],
    heldOut: Example[] = [];
  const known = new Set<string>();
  for (const story of stories.sort(
    (a, b) => compare(a.repoId, b.repoId) || compare(a.storyId, b.storyId),
  )) {
    const key = `${story.repoId}/${story.storyId}`;
    if (known.has(key)) throw Error("Duplicate labeled story.");
    if (new Set(story.kinds).size !== story.kinds.length)
      throw Error("Each intent label may appear only once per story.");
    known.add(key);
    const entry = {
      ...story,
      features: extractRoutingLanguageFeatures(story.title, story.description),
    };
    const split = calibrationRepos.has(story.repoId)
      ? calibration
      : heldOutRepos.has(story.repoId)
        ? heldOut
        : train;
    split.push(entry);
  }
  if (!train.length)
    throw Error(
      "The corpus needs training stories outside the calibration and held-out repositories.",
    );
  return { train, calibration, heldOut };
}

// One binary logistic regression per label permits independent requests in one
// brief. Full-batch AdaGrad plus a fixed story order makes the fit reproducible.
function fitLabel(
  kind: RoutingLanguageKind,
  examples: Example[],
): RoutingLanguageLabel | undefined {
  const positives = examples.reduce(
    (count, row) => count + Number(row.kinds.includes(kind)),
    0,
  );
  const negatives = examples.length - positives;
  if (positives < 2 || negatives < 2) return;

  const values = new Float64Array(RUNTIME_LANGUAGE_FEATURE_COUNT);
  const gradients = new Float64Array(values.length);
  const squaredGradients = new Float64Array(values.length);
  let bias = Math.log((positives + 1) / (negatives + 1));
  let squaredBiasGradient = 0;
  const target = examples.map((row) => Number(row.kinds.includes(kind)));
  const inverseCount = 1 / examples.length;
  for (let epoch = 0; epoch < 48; epoch++) {
    gradients.fill(0);
    let biasGradient = 0;
    for (const [index, row] of examples.entries()) {
      let logit = bias;
      for (const feature of row.features) logit += values[feature];
      const error = (1 / (1 + Math.exp(-logit)) - target[index]) * inverseCount;
      biasGradient += error;
      for (const feature of row.features) gradients[feature] += error;
    }
    squaredBiasGradient += biasGradient ** 2;
    bias -= (0.16 * biasGradient) / Math.sqrt(squaredBiasGradient + 1e-8);
    for (let index = 0; index < values.length; index++) {
      const gradient = gradients[index] + 0.002 * values[index];
      squaredGradients[index] += gradient ** 2;
      values[index] -=
        (0.16 * gradient) / Math.sqrt(squaredGradients[index] + 1e-8);
    }
  }

  const weights: RoutingLanguageLabel["weights"] = [];
  for (const [feature, weight] of values.entries())
    if (Math.abs(weight) >= 0.0001)
      weights.push([feature, Math.fround(weight)]);
  weights.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0] - b[0]);
  const retained = weights.slice(0, MAX_ROUTING_LANGUAGE_WEIGHTS);
  if (retained.length)
    return {
      kind,
      bias: Math.fround(bias),
      weights: retained,
      threshold: 0.55,
      minFeatures,
    };
}

const counts = (rows: Example[]) => ({
  stories: rows.length,
  repositories: new Set(rows.map((row) => row.repoId)).size,
});

function predictedKinds(sample: Example, model?: RoutingLanguageModel) {
  return analyzeRoutingIntent(sample, model).signals.kinds.filter(
    (kind) => kind !== "unknown",
  );
}

function evaluate(
  examples: Example[],
  predict: (sample: Example) => readonly RoutingLanguageKind[],
) {
  const summary = routingLanguageKinds.map((kind) => ({
    kind,
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
  }));
  let abstained = 0,
    exact = 0;
  for (const example of examples) {
    const guesses = predict(example);
    if (!guesses.length) abstained++;
    if (
      guesses.length === example.kinds.length &&
      guesses.every((kind) => example.kinds.includes(kind))
    )
      exact++;
    for (const label of summary) {
      const picked = guesses.includes(label.kind);
      const desired = example.kinds.includes(label.kind);
      if (picked && desired) label.truePositive++;
      if (picked && !desired) label.falsePositive++;
      if (!picked && desired) label.falseNegative++;
    }
  }
  return {
    ...counts(examples),
    coverage: examples.length ? 1 - abstained / examples.length : null,
    abstained,
    exactStoryMatch: examples.length ? exact / examples.length : null,
    labels: summary.map((label) => {
      const picked = label.truePositive + label.falsePositive;
      const desired = label.truePositive + label.falseNegative;
      return {
        ...label,
        precision: picked ? label.truePositive / picked : null,
        recall: desired ? label.truePositive / desired : null,
      };
    }),
  };
}

export function trainRoutingLanguage(raw: unknown) {
  const { train, calibration, heldOut } = splitCorpus(raw);
  const fits = routingLanguageKinds
    .map((kind) => fitLabel(kind, train))
    .filter((label) => label !== undefined);
  const provisional = fits.length
    ? loadRoutingLanguageModel(createRoutingLanguageSnapshot(fits))
    : undefined;
  if (!provisional)
    throw Error(
      "No intent had enough positive and negative training examples.",
    );
  // At runtime the learned model is called only for briefs the rules leave
  // unclassified. Fit confidence thresholds on those briefs as well.
  const observed = calibration
    .filter((row) => !predictedKinds(row).length)
    .map((row) => ({
      row,
      scores: scoreRoutingLanguageFeatures(provisional, row.features).scores,
    }));
  const labels: RoutingLanguageLabel[] = [];
  const calibrationEvidence = [];
  for (const fit of fits) {
    // Select the broadest supported threshold, using calibration repositories
    // only. Held-out labels never influence weights or threshold selection.
    for (const threshold of thresholdOptions) {
      const selected = observed.filter(({ scores }) =>
        scores.some(
          (score) =>
            score.kind === fit.kind &&
            score.probability >= threshold &&
            score.matchedFeatures >= minFeatures &&
            score.supportingFeatures > 0,
        ),
      );
      if (selected.length < 12) continue;
      const repositories = new Set(selected.map(({ row }) => row.repoId)).size;
      const correct = selected.filter(({ row }) =>
        row.kinds.includes(fit.kind),
      ).length;
      if (repositories < 2 || correct / selected.length < 0.9) continue;
      labels.push({ ...fit, threshold });
      calibrationEvidence.push({
        kind: fit.kind,
        threshold,
        repositories,
        selected: selected.length,
        correct,
      });
      break;
    }
  }
  if (!labels.length)
    throw Error(
      "No intent met the calibration evidence threshold. No model was produced.",
    );
  const snapshot = createRoutingLanguageSnapshot(labels);
  const model = loadRoutingLanguageModel(snapshot);
  if (!model)
    throw Error("The trained language model did not pass runtime validation.");
  const heldOutFallback = heldOut.filter((row) => !predictedKinds(row).length);
  return {
    snapshot,
    report: {
      train: counts(train),
      calibration: {
        ...counts(calibration),
        fallbackEligible: observed.length,
        evidence: calibrationEvidence,
      },
      heldOut: {
        learnedOnFallback: evaluate(
          heldOutFallback,
          (sample) =>
            scoreRoutingLanguageFeatures(model, sample.features).accepted,
        ),
        combined: evaluate(heldOut, (sample) => predictedKinds(sample, model)),
        rules: evaluate(heldOut, (sample) => predictedKinds(sample)),
      },
      omittedLabels: routingLanguageKinds.filter(
        (kind) => !labels.some((label) => label.kind === kind),
      ),
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 4)
    throw Error(
      "Usage: node --import tsx scripts/routing-language-train.ts <labeled-stories.json> <model.json>",
    );
  const [input, output] = process.argv.slice(2);
  const inputFile = await stat(input);
  if (!inputFile.isFile() || inputFile.size > maxTrainingBytes)
    throw Error("Use a labeled-story corpus file of at most 32 MiB.");
  const { snapshot, report } = trainRoutingLanguage(
    JSON.parse(await readFile(input, "utf8")),
  );
  await writeFile(output, JSON.stringify(snapshot), {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(JSON.stringify({ digest: snapshot.digest, ...report }, null, 2));
}
