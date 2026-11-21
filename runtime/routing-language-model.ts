import { createHash } from "node:crypto";
import { z } from "zod";
import type { RoutingRequestKind } from "../src/routing-signals";

export const routingLanguageKinds = [
  "explain",
  "research",
  "test",
  "fix",
  "implement",
  "refactor",
  "rename",
] as const satisfies readonly RoutingRequestKind[];

export type RoutingLanguageKind = (typeof routingLanguageKinds)[number];
export const RUNTIME_LANGUAGE_FEATURE_COUNT = 16_384;
export const MAX_ROUTING_LANGUAGE_FEATURES = 512;
export const MAX_ROUTING_LANGUAGE_WEIGHTS = 1_024;
export const MAX_ROUTING_LANGUAGE_SNAPSHOT_BYTES = 256 * 1_024;
const featuresPerFamily = RUNTIME_LANGUAGE_FEATURE_COUNT / 2;
const familyMask = featuresPerFamily - 1;
const hashOffset = 2_166_136_261;
const hashPrime = 16_777_619;
const version = "memcode-routing-language-v1";

// The trainer and desktop share these bounds and feature indices.
function lexicalWords(text: string, limit: number, wordCount: number) {
  return (
    text
      .slice(0, limit)
      .normalize("NFKC")
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
      .replace(/`[^`\r\n]*`/g, " reference ")
      .replace(/\b(?:[a-z][a-z0-9+.-]{1,15}:\/\/|www\.)\S+/gi, " reference ")
      .replace(
        /(?<![\p{L}\p{N}_.@+/\\-])(?:(?:[a-z]:)?[/\\]|[\p{L}\p{N}_.@+-]+[/\\])(?:[\p{L}\p{N}_.@+-]+[/\\])*[\p{L}\p{N}_.@+:-]+/giu,
        " reference ",
      )
      .replace(
        /\b[\w-]+\.(?:[cm]?[jt]sx?|rs|py|go|java|swift|tsx|json|ya?ml|toml|css|html|md)(?:[:#]\w+)?\b/gi,
        " reference ",
      )
      .replace(
        /\b(?:ERR_[A-Z0-9_]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[a-z_]+_[a-z0-9_]+)\b/g,
        " reference ",
      )
      .replaceAll("’", "'")
      .toLowerCase()
      .match(/\p{L}[\p{L}\p{M}\p{N}'-]*/gu) ?? []
  )
    .slice(0, wordCount)
    .map((word) => word.slice(0, 48));
}

function addHash(hash: number, text: string) {
  for (let index = 0; index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), hashPrime);
  return hash;
}

export function extractRoutingLanguageFeatures(
  title: string,
  description: string,
) {
  const documents = [
    lexicalWords(title, 256, 32),
    lexicalWords(description, 2_800, 96),
  ];
  const indices = new Set<number>();
  for (const words of documents) {
    let previous: string | undefined;
    for (const word of words) {
      indices.add(addHash(hashOffset, word) & familyMask);
      if (previous)
        indices.add(
          addHash(addHash(addHash(hashOffset, previous), " "), word) &
            familyMask,
        );
      previous = word;
    }
  }
  // Prefix and suffix markers retain useful spelling shapes at word boundaries.
  subwords: for (const word of documents.flat()) {
    if (indices.size >= MAX_ROUTING_LANGUAGE_FEATURES) break;
    const padded = "^" + word + "$";
    for (let start = 0; start <= padded.length - 3; start++) {
      let hash = hashOffset;
      for (let end = start; end < Math.min(start + 5, padded.length); end++) {
        hash = Math.imul(hash ^ padded.charCodeAt(end), hashPrime);
        if (end - start < 2) continue;
        indices.add(featuresPerFamily + (hash & familyMask));
        if (indices.size >= MAX_ROUTING_LANGUAGE_FEATURES) break subwords;
      }
    }
  }
  return [...indices].sort((left, right) => left - right);
}

const coefficient = z.number().min(-64).max(64);
const labelSchema = z.strictObject({
  kind: z.enum(routingLanguageKinds),
  bias: coefficient,
  threshold: z.number().min(0.5).max(1),
  minFeatures: z.int().min(1).max(16),
  weights: z
    .array(
      z.tuple([
        z.int().nonnegative().lt(RUNTIME_LANGUAGE_FEATURE_COUNT),
        coefficient.refine((value) => Math.fround(value) !== 0),
      ]),
    )
    .min(1)
    .max(MAX_ROUTING_LANGUAGE_WEIGHTS),
});
const profileSchema = z.strictObject({
  version: z.literal(version),
  labels: z.array(labelSchema).min(1).max(routingLanguageKinds.length),
});
const snapshotSchema = profileSchema.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export type RoutingLanguageLabel = z.infer<typeof labelSchema>;
export type RoutingLanguageSnapshot = z.infer<typeof snapshotSchema>;
export interface RoutingLanguageModel {
  readonly digest: string;
  readonly labels: readonly {
    kind: RoutingLanguageKind;
    bias: number;
    minFeatures: number;
    threshold: number;
    weights: Float32Array;
  }[];
}

function orderedProfile(
  labels: RoutingLanguageLabel[],
): z.infer<typeof profileSchema> {
  const ordered = [...labels].sort(
    (left, right) =>
      routingLanguageKinds.indexOf(left.kind) -
      routingLanguageKinds.indexOf(right.kind),
  );
  if (new Set(ordered.map(({ kind }) => kind)).size !== ordered.length)
    throw Error("Each intent can appear only once in the language profile.");
  return {
    version,
    labels: ordered.map(({ kind, bias, minFeatures, threshold, weights }) => {
      if (new Set(weights.map(([index]) => index)).size !== weights.length)
        throw Error("Each language feature can appear only once per intent.");
      return {
        kind,
        bias: Math.fround(bias),
        minFeatures,
        threshold,
        weights: weights
          .map(([index, value]): [number, number] => [
            index,
            Math.fround(value),
          ])
          .sort(([left], [right]) => left - right),
      };
    }),
  };
}

function profileDigest(profile: z.infer<typeof profileSchema>) {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

export function createRoutingLanguageSnapshot(
  labels: RoutingLanguageLabel[],
): RoutingLanguageSnapshot {
  const profile = orderedProfile(
    profileSchema.parse({ version, labels }).labels,
  );
  const snapshot = { ...profile, digest: profileDigest(profile) };
  if (JSON.stringify(snapshot).length > MAX_ROUTING_LANGUAGE_SNAPSHOT_BYTES)
    throw Error("The language profile exceeds the desktop size limit.");
  return snapshot;
}

export function loadRoutingLanguageModel(
  value: unknown,
): RoutingLanguageModel | undefined {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) return;
  try {
    const profile = orderedProfile(parsed.data.labels);
    if (profileDigest(profile) !== parsed.data.digest) return;
    return {
      digest: parsed.data.digest,
      labels: profile.labels.map(({ weights, ...label }) => {
        // A bounded packed table lets inference visit only the request's active features.
        const table = new Float32Array(RUNTIME_LANGUAGE_FEATURE_COUNT);
        for (const [index, value] of weights) table[index] = value;
        return { ...label, weights: table };
      }),
    };
  } catch {
    return;
  }
}

export function scoreRoutingLanguageFeatures(
  model: RoutingLanguageModel,
  features: readonly number[],
) {
  const accepted: RoutingLanguageKind[] = [];
  const scores = model.labels.map(
    ({ kind, bias, minFeatures, threshold, weights }) => {
      let logit = bias;
      let matchedFeatures = 0;
      let supportingFeatures = 0;
      for (
        let index = 0;
        index < Math.min(features.length, MAX_ROUTING_LANGUAGE_FEATURES);
        index++
      ) {
        const weight = weights[features[index]];
        if (!weight) continue;
        logit += weight;
        matchedFeatures++;
        if (weight > 0) supportingFeatures++;
      }
      const probability = 1 / (1 + Math.exp(-logit));
      if (
        supportingFeatures &&
        matchedFeatures >= minFeatures &&
        probability >= threshold
      )
        accepted.push(kind);
      return { kind, probability, matchedFeatures, supportingFeatures };
    },
  );
  return { scores, accepted };
}

export function predictRoutingLanguage(
  model: RoutingLanguageModel,
  title: string,
  description: string,
) {
  return scoreRoutingLanguageFeatures(
    model,
    extractRoutingLanguageFeatures(title, description),
  );
}
