import { ArrowRight, ChevronDown, FileCode2, FileDiff } from "lucide-react";
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
  matched: "Matched",
  added: "Added",
  removed: "Removed",
  ambiguous: "Uncertain",
  unavailable: "Not compared",
};
type ComparisonStatus = keyof typeof statusLabels;

const functionAxes = [
  ...reviewMetricAxes,
  { key: "halsteadVolume", label: "Halstead volume" },
] as const;

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
  paired: number;
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
      <small className="review-pair-count">
        {paired
          ? `${paired} matched ${paired === 1 ? "function" : "functions"} · mean${axis.unit ? ` ${axis.unit}` : ""}`
          : "No comparable measurements"}
      </small>
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
  const hasPairs = comparison.some((axis) => axis.paired > 0);
  const axes = functionAxes.filter((axis) => {
    if (axis.key !== "halsteadVolume") return true;
    return metrics.some((metric) => {
      const pair = reviewMetricPair(metric, axis.key);
      return pair.before !== null || pair.after !== null;
    });
  });
  const counts: Record<ComparisonStatus, number> = {
    matched: 0,
    added: 0,
    removed: 0,
    ambiguous: 0,
    unavailable: 0,
  };
  for (const metric of metrics)
    counts[metric.comparison?.status ?? "unavailable"]++;
  const omitted = [
    coverage?.omittedFunctions &&
      `${coverage.omittedFunctions} additional ${coverage.omittedFunctions === 1 ? "function" : "functions"}`,
    coverage?.omittedFiles &&
      `${coverage.omittedFiles} additional ${coverage.omittedFiles === 1 ? "file" : "files"}`,
  ].filter(Boolean);
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
          {metrics.length} {metrics.length === 1 ? "function" : "functions"}
        </span>
      </div>
      <p className="review-comparison-caption">
        {(Object.keys(counts) as ComparisonStatus[])
          .filter((status) => counts[status] > 0)
          .map(
            (status) =>
              `${counts[status]} ${statusLabels[status].toLowerCase()}`,
          )
          .join(" · ")}
      </p>
      {omitted.length > 0 && (
        <p className="review-comparison-note">
          This review omitted {omitted.join(" and ")}.
        </p>
      )}
      <p className="review-function-key">
        Before → After <span>— Unavailable</span>
      </p>
      <div
        className="review-function-scroll"
        tabIndex={0}
        role="region"
        aria-label="Function measurements"
      >
        <table
          className="review-function-table"
          aria-label="Measurements by function"
        >
          <thead>
            <tr>
              <th scope="col">Function</th>
              {axes.map((axis) => (
                <th key={axis.key} scope="col">
                  {axis.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric, index) => {
              const status = metric.comparison?.status ?? "unavailable";
              const baselineOnly =
                status === "removed" ||
                (metric.line == null && metric.before?.line != null);
              const line = baselineOnly ? metric.before?.line : metric.line;
              const action = baselineOnly
                ? "View captured changes"
                : "Open current source";
              return (
                <tr key={`${metric.path}:${metric.symbol}:${line}:${index}`}>
                  <th scope="row">
                    <button
                      type="button"
                      title={action}
                      aria-label={`${action} for ${metric.symbol}`}
                      onClick={
                        baselineOnly
                          ? onOpenChanges
                          : () => onOpenSource(metric.path, metric.line)
                      }
                    >
                      {baselineOnly ? (
                        <FileDiff size={12} />
                      ) : (
                        <FileCode2 size={12} />
                      )}
                      {metric.symbol}
                    </button>
                    <small>
                      {metric.path}
                      {line != null && `:${line}`}
                    </small>
                    {metric.comparison?.reason ? (
                      <details className="review-function-status">
                        <summary>
                          {statusLabels[status]} <ChevronDown size={10} />
                        </summary>
                        <p>{metric.comparison.reason}</p>
                      </details>
                    ) : (
                      <span className="review-function-status">
                        {statusLabels[status]}
                      </span>
                    )}
                  </th>
                  {axes.map((axis) => {
                    const { before, after } = reviewMetricPair(
                      metric,
                      axis.key,
                    );
                    const description = `Before ${before == null ? "unavailable" : value(before)}, after ${after == null ? "unavailable" : value(after)}`;
                    return (
                      <td key={axis.key} title={description}>
                        <span className="sr-only">{description}</span>
                        <span
                          className="review-function-pair"
                          aria-hidden="true"
                        >
                          {value(before)} <ArrowRight size={10} />{" "}
                          <b>{value(after)}</b>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasPairs ? (
        <>
          <div className="review-comparison-heading review-means-heading">
            <strong>Matched function averages</strong>
            <span>
              <i /> Before <i className="after" /> After
            </span>
          </div>
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
        </>
      ) : (
        <p className="review-comparison-note">
          No matched functions have measurements on both sides.
        </p>
      )}
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
        Measurements come from Memtrace’s native AST analysis.
      </p>
    </div>
  );
}
