import { ArrowRight, ChevronDown, FileCode2 } from "lucide-react";
import type {
  CodeReviewComparisonCoverage,
  CodeReviewMetric,
} from "../code-review";
import {
  reviewMetricAxes,
  reviewMetricPair,
  reviewQualityComparison,
  type ReviewMetricAxis,
} from "../code-review-comparison";

const value = (number: number | null | undefined) =>
  number == null
    ? "—"
    : number.toLocaleString(undefined, { maximumFractionDigits: 1 });
const statusLabels = {
  matched: "Compared",
  added: "New function",
  removed: "Removed function",
  ambiguous: "Uncertain match",
  unavailable: "Before unavailable",
};

function PairChart({
  axis,
  before,
  after,
  delta,
  paired,
}: {
  axis: ReviewMetricAxis;
  before: number | null;
  after: number | null;
  delta: number | null;
  paired?: number;
}) {
  const maximum =
    axis.key === "maintainabilityIndex"
      ? 100
      : Math.max(before ?? 0, after ?? 0, 1);
  const improved =
    delta !== null && (axis.better === "higher" ? delta > 0 : delta < 0);
  return (
    <div className="review-pair-chart" role="group" aria-label={axis.label}>
      <div className="review-pair-label">
        <strong>{axis.label}</strong>
        <small>
          {axis.better === "higher" ? "Higher is better" : "Lower is better"}
        </small>
      </div>
      <div className="review-pair-values">
        <span>{value(before)}</span>
        <ArrowRight size={12} />
        <b>{value(after)}</b>
        {delta !== null && (
          <small
            className={
              delta === 0 ? "unchanged" : improved ? "improved" : "increased"
            }
          >
            {delta === 0
              ? "No change"
              : `${delta > 0 ? "+" : "−"}${value(Math.abs(delta))}`}
          </small>
        )}
      </div>
      <div className="review-pair-tracks" aria-hidden="true">
        <div className={before === null ? "unavailable" : ""}>
          <i
            style={{
              width: `${Math.min(100, ((before ?? 0) / maximum) * 100)}%`,
            }}
          />
        </div>
        <div className={`after ${after === null ? "unavailable" : ""}`}>
          <i
            style={{
              width: `${Math.min(100, ((after ?? 0) / maximum) * 100)}%`,
            }}
          />
        </div>
      </div>
      {paired !== undefined && (
        <small className="review-pair-count">
          {paired
            ? `${paired} matched ${paired === 1 ? "function" : "functions"} · mean${axis.unit ? ` ${axis.unit}` : ""}`
            : "No comparable measurements"}
        </small>
      )}
    </div>
  );
}

export default function ReviewQualityComparison({
  metrics,
  coverage,
  onOpenSource,
  onOpenChanges,
}: {
  metrics: CodeReviewMetric[];
  coverage?: CodeReviewComparisonCoverage;
  onOpenSource: (path: string, line?: number) => void;
  onOpenChanges: () => void;
}) {
  const comparison = reviewQualityComparison(metrics);
  const paired = Math.max(0, ...comparison.map((axis) => axis.paired));
  const current = metrics.filter(
    (metric) =>
      metric.comparison?.status !== "removed" &&
      !(metric.line == null && metric.before?.line != null),
  ).length;
  const notes = [
    ...new Set([
      ...(coverage?.notes ?? []),
      ...metrics
        .filter((metric) => metric.comparison?.status !== "matched")
        .map((metric) => metric.comparison?.reason)
        .filter(Boolean),
    ]),
  ];
  return (
    <div className="review-quality-comparison">
      <div className="review-comparison-heading">
        <strong>Before & after</strong>
        <span>
          <i /> Before <i className="after" /> After
        </span>
      </div>
      <p className="review-comparison-caption">
        Same matched functions, measured from this story’s captured source.{" "}
        {paired} compared · {current} current functions.
      </p>
      <div className="review-comparison-grid">
        {comparison.map((axis) => (
          <PairChart
            key={axis.key}
            axis={axis}
            before={axis.before}
            after={axis.after}
            delta={axis.delta}
            paired={axis.paired}
          />
        ))}
      </div>
      {!paired && (
        <p className="review-comparison-note">
          No comparable baseline is available. New, removed and unmatched
          functions stay separate; missing values are never counted as zero.
        </p>
      )}
      <details className="review-function-details">
        <summary>
          Measured functions <small>{metrics.length}</small>
          <ChevronDown size={13} />
        </summary>
        <div className="review-function-list">
          {metrics.map((metric, index) => {
            const removed = metric.comparison?.status === "removed";
            const baselineOnly =
              removed || (metric.line == null && metric.before?.line != null);
            return (
              <details
                key={`${metric.path}:${metric.symbol}:${metric.line}:${index}`}
              >
                <summary>
                  <span>
                    <strong>{metric.symbol}</strong>
                    <small>{metric.path}</small>
                  </span>
                  <em>
                    {statusLabels[metric.comparison?.status ?? "unavailable"]}
                  </em>
                  <ChevronDown size={12} />
                </summary>
                <div className="review-function-measurements">
                  <div className="review-comparison-grid">
                    {reviewMetricAxes.map((axis) => {
                      const pair = reviewMetricPair(metric, axis.key);
                      return (
                        <PairChart
                          key={axis.key}
                          axis={axis}
                          {...pair}
                          before={
                            removed
                              ? (metric.before?.[axis.key] ?? null)
                              : pair.before
                          }
                        />
                      );
                    })}
                  </div>
                  {metric.comparison?.reason && (
                    <p className="review-comparison-note">
                      {metric.comparison.reason}
                    </p>
                  )}
                  {baselineOnly ? (
                    <>
                      <p className="review-comparison-note">
                        {removed
                          ? "Removed from this snapshot. Its baseline measurements are kept here."
                          : "No current declaration was matched safely. Inspect the captured changes for context."}
                      </p>
                      <button className="text-button" onClick={onOpenChanges}>
                        View captured changes <ArrowRight size={12} />
                      </button>
                    </>
                  ) : (
                    <button
                      className="text-button"
                      onClick={() => onOpenSource(metric.path, metric.line)}
                    >
                      <FileCode2 size={12} /> Open current source{" "}
                      <ArrowRight size={12} />
                    </button>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </details>
      {notes.length > 0 && (
        <details className="review-comparison-coverage">
          <summary>
            Comparison coverage <ChevronDown size={12} />
          </summary>
          <ul>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="code-review-footnote">
        Native AST measurements. These describe the captured functions, not
        correctness or a project-wide quality grade.
      </p>
    </div>
  );
}
