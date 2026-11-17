import type { CodeReviewMetric } from "./code-review";

export const reviewMetricAxes = [
  {
    key: "maintainabilityIndex",
    label: "Maintainability",
    better: "higher",
    unit: "/ 100",
  },
  {
    key: "cognitive",
    label: "Cognitive complexity",
    better: "lower",
    unit: "",
  },
  {
    key: "cyclomatic",
    label: "Cyclomatic complexity",
    better: "lower",
    unit: "",
  },
  { key: "nesting", label: "Nesting depth", better: "lower", unit: "" },
] as const;
export type ReviewMetricAxis = (typeof reviewMetricAxes)[number];
export type ReviewMetricKey = ReviewMetricAxis["key"];

function valid(value: unknown, key: ReviewMetricKey): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    (key !== "maintainabilityIndex" || value <= 100)
  );
}

/** Pair only native, explicitly matched declarations from the same captured change. */
export function reviewMetricPair(
  metric: CodeReviewMetric,
  key: ReviewMetricKey,
) {
  const matched =
    metric.source === "ast" && metric.comparison?.status === "matched";
  const before =
    matched && valid(metric.before?.[key], key) ? metric.before![key]! : null;
  const after =
    metric.source === "ast" &&
    metric.comparison?.status !== "removed" &&
    valid(metric[key], key)
      ? metric[key]!
      : null;
  return {
    before,
    after,
    delta: before !== null && after !== null ? after - before : null,
  };
}

/** Each axis uses exactly the same declarations on both sides, never a zero for a gap. */
export function reviewQualityComparison(metrics: CodeReviewMetric[]) {
  const identities = new Map<string, CodeReviewMetric | null>();
  for (const metric of metrics) {
    const id = JSON.stringify([
      metric.path.replaceAll("\\", "/"),
      metric.symbol,
      metric.line ?? null,
    ]);
    if (!metric.path.trim() || !metric.symbol.trim()) continue;
    if (identities.has(id)) {
      if (JSON.stringify(identities.get(id)) !== JSON.stringify(metric))
        identities.set(id, null);
    } else identities.set(id, metric);
  }
  const unique = [...identities.values()].filter(
    (metric): metric is CodeReviewMetric => metric !== null,
  );
  return reviewMetricAxes.map((axis) => {
    const pairs = unique
      .map((metric) => reviewMetricPair(metric, axis.key))
      .filter(
        (pair): pair is { before: number; after: number; delta: number } =>
          pair.delta !== null,
      );
    const before = pairs.length
      ? pairs.reduce((sum, pair) => sum + pair.before, 0) / pairs.length
      : null;
    const after = pairs.length
      ? pairs.reduce((sum, pair) => sum + pair.after, 0) / pairs.length
      : null;
    return {
      ...axis,
      before,
      after,
      paired: pairs.length,
      delta: before !== null && after !== null ? after - before : null,
    };
  });
}
