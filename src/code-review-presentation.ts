import type { CodeReviewMetric, StoryReviewRun } from "./code-review";

export interface ReviewQualitySummary {
  /** Mean native normalized MI; never a correctness or acceptance score. */
  score: number | null;
  measured: number;
  lowest: number | null;
  reason: string | null;
}

const nativeMI = (metric: CodeReviewMetric): number | null =>
  metric.source === "ast" &&
  typeof metric.maintainabilityIndex === "number" &&
  Number.isFinite(metric.maintainabilityIndex) &&
  metric.maintainabilityIndex >= 0 &&
  metric.maintainabilityIndex <= 100
    ? metric.maintainabilityIndex
    : null;

/** Metrics may omit failed lookups; their length is not an expected-function count. */
export function reviewQuality(
  run: Pick<StoryReviewRun, "state" | "coverage" | "metrics"> | null,
): ReviewQualitySummary {
  const functions = new Map<string, number | null>();
  let ambiguous = false;
  for (const metric of run?.metrics ?? []) {
    if (metric.comparison?.status === "removed") continue;
    if (!metric.path.trim() || !metric.symbol.trim()) {
      ambiguous = true;
      continue;
    }
    // Case is significant on some supported filesystems. Never merge distinct paths.
    const identity = JSON.stringify([
      metric.path.replaceAll("\\", "/"),
      metric.symbol,
      metric.line ?? null,
    ]);
    const value = nativeMI(metric);
    if (functions.has(identity) && functions.get(identity) !== value)
      ambiguous = true;
    else functions.set(identity, value);
  }
  const values = [...functions.values()].filter(
    (value): value is number => value !== null,
  );
  const measured = values.length;
  const reason =
    !run || run.state !== "completed"
      ? "A current completed review is needed."
      : !run.coverage.complete
        ? "Partial coverage; no overall maintainability score."
        : ambiguous
          ? "Function measurements could not be resolved consistently."
          : !functions.size || measured !== functions.size
            ? "Native maintainability measurements are incomplete."
            : null;
  return {
    score: reason
      ? null
      : Math.round(values.reduce((sum, value) => sum + value, 0) / measured),
    measured,
    lowest: measured ? Math.min(...values) : null,
    reason,
  };
}
