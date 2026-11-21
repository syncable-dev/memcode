import { useState } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  Check,
  GitBranch,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  TriangleAlert,
} from "lucide-react";
import type { QualityMetric, QualitySnapshot } from "../intelligence";
import {
  comparableSnapshots,
  compareFindings,
  qualityMetricLabels,
  qualityValue,
} from "../intelligence";
import { Spinner } from "./UI";
import { Select } from "./Select";
import {
  AnalysisError,
  CaptureButtons,
  checkpointLabel,
  countLabel,
  FindingList,
  MetricTile,
  scopedCheckpoints,
  SnapshotEvidence,
  useCapture,
  type IntelligenceProps,
} from "./IntelligenceUI";

const metricOptions: QualityMetric[] = [
  "elevated",
  "elevatedRate",
  "deadCode",
  "importCycles",
  "measuredFunctions",
];
function metricLabel(value: number | null, metric: QualityMetric): string {
  return value === null
    ? "—"
    : metric === "elevatedRate"
      ? `${value.toFixed(1)}%`
      : value.toLocaleString();
}

function QualityTrend({
  snapshots,
  metric,
}: {
  snapshots: QualitySnapshot[];
  metric: QualityMetric;
}) {
  const [active, setActive] = useState<number | null>(null);
  const values = snapshots.map((snapshot) => qualityValue(snapshot, metric)!);
  const max =
      metric === "elevatedRate"
        ? Math.max(1, ...values) * 1.12
        : Math.max(3, Math.ceil(Math.max(0, ...values) * 1.12)),
    w = 900,
    h = 215,
    pad = { left: 45, right: 20, top: 20, bottom: 36 };
  const times = snapshots.map((snapshot) => Date.parse(snapshot.capturedAt)),
    span = times.at(-1)! - times[0];
  const x = (i: number) =>
    snapshots.length === 1
      ? w / 2
      : pad.left +
        (span > 0 ? (times[i] - times[0]) / span : i / (snapshots.length - 1)) *
          (w - pad.left - pad.right);
  const y = (value: number) =>
    h - pad.bottom - (value / max) * (h - pad.top - pad.bottom);
  const index =
      active !== null && active < snapshots.length
        ? active
        : snapshots.length - 1,
    selected = snapshots[index];
  return (
    <div className="quality-trend">
      <div className="quality-trend-readout">
        <span>
          {selected
            ? checkpointLabel(selected.capturedAt)
            : "No eligible checkpoints"}
        </span>
        <strong>
          {selected ? metricLabel(qualityValue(selected, metric), metric) : "—"}
          <small>{qualityMetricLabels[metric]}</small>
        </strong>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="group"
        aria-label={`${qualityMetricLabels[metric]} across ${snapshots.length} verified checkpoints`}
      >
        {[0, 1, 2, 3].map((i) => {
          const value = (max * i) / 3;
          return (
            <g key={i}>
              <line
                x1={pad.left}
                x2={w - pad.right}
                y1={y(value)}
                y2={y(value)}
                className="quality-gridline"
              />
              <text
                x={pad.left - 12}
                y={y(value) + 4}
                textAnchor="end"
                className="quality-axis-label"
              >
                {metric === "elevatedRate"
                  ? `${value.toFixed(1)}%`
                  : Math.round(value)}
              </text>
            </g>
          );
        })}
        {snapshots.length > 1 && (
          <path
            d={values
              .map((value, i) => `${i ? "L" : "M"}${x(i)},${y(value)}`)
              .join(" ")}
            className="quality-trend-line"
          />
        )}
        {snapshots.map((snapshot, i) => (
          <g key={snapshot.id}>
            <circle
              cx={x(i)}
              cy={y(values[i])}
              r={index === i ? 6 : 4}
              className={"quality-trend-point " + (index === i ? "active" : "")}
              tabIndex={0}
              role="button"
              aria-label={`${checkpointLabel(snapshot.capturedAt)}: ${metricLabel(values[i], metric)}`}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onClick={() => setActive(i)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActive(i);
                }
              }}
            >
              <title>
                {checkpointLabel(snapshot.capturedAt)} ·{" "}
                {metricLabel(values[i], metric)}
              </title>
            </circle>
            {(i === 0 || i === snapshots.length - 1) && (
              <text
                x={x(i)}
                y={h - 9}
                textAnchor={
                  snapshots.length === 1 ? "middle" : i === 0 ? "start" : "end"
                }
                className="quality-axis-label"
              >
                {checkpointLabel(snapshot.capturedAt)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="quality-trend-caption">
        <span>
          <i />
          Recorded AST / graph observations
        </span>
        <span>
          {snapshots.length === 1
            ? "One checkpoint. Capture again after a change."
            : "No inferred points between recorded checkpoints."}
        </span>
      </div>
      <details className="quality-data-table">
        <summary>Inspect the measured values</summary>
        <table>
          <thead>
            <tr>
              <th>Checkpoint</th>
              <th>Source</th>
              <th>{qualityMetricLabels[metric]}</th>
              <th>Measured functions</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((snapshot) => (
              <tr key={snapshot.id}>
                <td>{checkpointLabel(snapshot.capturedAt)}</td>
                <td>
                  <code>
                    {snapshot.source.commit?.slice(0, 8) ??
                      snapshot.source.revision?.slice(0, 8) ??
                      "Unknown"}
                  </code>
                </td>
                <td>{metricLabel(qualityValue(snapshot, metric), metric)}</td>
                <td>{countLabel(snapshot.metrics.measuredFunctions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export function Improve(props: IntelligenceProps) {
  const { state, project, open, notify, onAnalyze } = props;
  const {
    busy,
    capture,
    latest: captured,
    error,
  } = useCapture(project, notify);
  const snapshots = scopedCheckpoints(state, project, captured);
  const latest = snapshots.at(-1);
  const [metric, setMetric] = useState<QualityMetric>("elevated"),
    [baselineId, setBaselineId] = useState("auto");
  const [setupPending, setSetupPending] = useState(false);
  const [setupError, setSetupError] = useState("");
  const indexing = ["connecting", "indexing"].includes(project.analysis);
  const points = latest ? comparableSnapshots(snapshots, latest, metric) : [];
  const startBaseline = async () => {
    setSetupError("");
    if (project.path || !onAnalyze) {
      await capture(false);
      return;
    }
    setSetupPending(true);
    try {
      await onAnalyze();
    } catch (reason) {
      setSetupError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSetupPending(false);
    }
  };
  const feedback = error || setupError;
  const feedbackLine = feedback && (
    <AnalysisError message={feedback} savedCheckpoint={!!latest} />
  );
  const current =
    latest && points.some((point) => point.id === latest.id)
      ? latest
      : undefined;
  const earlier = points.filter((point) => point.id !== current?.id);
  const baseline =
    earlier.find((point) => point.id === baselineId) ?? earlier[0];
  const delta =
    current && baseline
      ? qualityValue(current, metric)! - qualityValue(baseline, metric)!
      : null;
  const changes = current && baseline ? compareFindings(baseline, current) : [];
  const related = state.tasks.filter(
    (task) =>
      task.projectId === project.id &&
      !task.archivedAt &&
      task.kind === "refactor" &&
      task.stage !== "done",
  );
  if (!latest)
    return (
      <div className="improve-view">
        <section className="improve-intro">
          <span className="intelligence-kicker">
            <Target size={13} />
            IMPROVE WITH EVIDENCE
          </span>
          <h2>
            Make the next change
            <br />
            <em>a measurable one.</em>
          </h2>
          <p>
            A checkpoint saves the code’s quality measurements as they are now.
            After a change, record another to see what improved.
          </p>
          <button
            className="button primary"
            disabled={busy || setupPending || indexing || project.example}
            onClick={() => void startBaseline()}
          >
            {busy || indexing || setupPending ? (
              <Spinner size={14} />
            ) : (
              <Plus size={14} />
            )}
            {busy
              ? "Recording checkpoint…"
              : indexing || setupPending
                ? "Preparing code analysis…"
                : !project.path && !project.example
                  ? "Connect local code"
                  : "Capture the first checkpoint"}
          </button>
          {feedbackLine}
          {!feedback && indexing && (
            <p role="status">
              {project.analysisNote || "Memtrace is analyzing this project’s code."}
            </p>
          )}
        </section>
        {project.example && (
          <p className="intelligence-context-note">
            Choose a real local project to measure quality. The design preview
            does not invent code-quality history.
          </p>
        )}
        <div className="improvement-loop">
          {[
            {
              number: "01",
              title: "Understand",
              description:
                "Read AST complexity, relationships and the scope that is actually indexed.",
            },
            {
              number: "02",
              title: "Plan the work",
              description:
                "Turn a finding into a task with source scope and a reviewable outcome.",
            },
            {
              number: "03",
              title: "Measure again",
              description:
                "Compare compatible checkpoints and inspect the actual source change.",
            },
          ].map((item) => (
            <div key={item.number}>
              <span>{item.number}</span>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    );
  return (
    <div className="improve-view">
      <div className="intelligence-toolbar">
        <span className="intelligence-kicker">
          <Target size={12} />
          MEASURE / CHANGE / VERIFY
        </span>
        <CaptureButtons project={project} busy={busy} capture={capture} />
      </div>
      {feedbackLine}
      <section className="improvement-summary">
        <div>
          <span>SMALL CHANGES. VISIBLE PROGRESS.</span>
          <h2>
            Better code,
            <br />
            <em>with a record to show it.</em>
          </h2>
          <p>
            {points.length} compatible checkpoints on{" "}
            <strong>{latest.branch}</strong>. Each binds the observed source to
            its graph publication.
          </p>
        </div>
        <div className="improvement-summary-metrics">
          <MetricTile
            label="Elevated complexity"
            value={metricLabel(
              qualityValue(latest, "elevatedRate"),
              "elevatedRate",
            )}
            caption={`${countLabel(latest.metrics.measuredFunctions)} AST-measured functions`}
          />
          <MetricTile
            label="Refactoring work"
            value={related.length.toString()}
            caption="Open scoped improvement tasks"
            accent="cyan"
          />
          <MetricTile
            label="Recorded checkpoints"
            value={snapshots.length.toString()}
            caption="No historical backfill"
          />
        </div>
      </section>
      <SnapshotEvidence snapshot={latest} />
      <section className="intelligence-panel improvement-trend-panel">
        <header>
          <div>
            <h3>Quality over time</h3>
            <p>
              Compare measured source signals, with code growth and evidence
              limits visible.
            </p>
          </div>
          <ChartNoAxesCombined size={18} />
        </header>
        <div className="improvement-trend-controls">
          <Select
            aria-label="Quality trend metric"
            value={metric}
            onValueChange={(value) => {
              setMetric(value as QualityMetric);
              setBaselineId("auto");
            }}
          >
            {metricOptions.map((value) => (
              <option key={value} value={value}>
                {qualityMetricLabels[value]}
              </option>
            ))}
          </Select>
          <div
            className={
              "quality-delta " +
              (delta !== null && delta < 0 && metric !== "measuredFunctions"
                ? "improved"
                : "")
            }
          >
            <span>Change from baseline</span>
            <strong>
              {delta === null
                ? "—"
                : `${delta > 0 ? "+" : ""}${metric === "elevatedRate" ? delta.toFixed(1) + " pp" : delta.toLocaleString()}`}
              {delta !== null &&
                (delta < 0 ? (
                  <ArrowDownRight size={16} />
                ) : delta > 0 ? (
                  <ArrowUpRight size={16} />
                ) : (
                  <Check size={15} />
                ))}
            </strong>
          </div>
        </div>
        {points.length ? (
          <QualityTrend key={metric} snapshots={points} metric={metric} />
        ) : (
          <div className="intelligence-chart-empty">
            <ShieldCheck size={26} />
            <h3>Record an aligned checkpoint.</h3>
            <p>
              The current capture is excluded from trend comparisons because its
              source/index binding or selected metric is incomplete.
            </p>
          </div>
        )}
        {!current && (
          <p className="intelligence-context-note">
            <TriangleAlert size={13} />
            The latest capture is not eligible for this comparison. Refresh
            analysis to align the source and index.
          </p>
        )}
        <div className="improvement-baseline">
          <span>Compare the latest eligible source with</span>
          <Select
            aria-label="Quality comparison baseline"
            value={baselineId}
            onValueChange={setBaselineId}
            disabled={!earlier.length}
          >
            <option value="auto">Earliest compatible checkpoint</option>
            {earlier.map((snapshot) => (
              <option key={snapshot.id} value={snapshot.id}>
                {checkpointLabel(snapshot.capturedAt)} ·{" "}
                {snapshot.source.commit?.slice(0, 7) ?? "source snapshot"}
              </option>
            ))}
          </Select>
        </div>
        {current &&
          baseline &&
          current.metrics.measuredFunctions !==
            baseline.metrics.measuredFunctions && (
            <p className="intelligence-context-note">
              Measured function coverage changed from{" "}
              {countLabel(baseline.metrics.measuredFunctions)} to{" "}
              {countLabel(current.metrics.measuredFunctions)}. Counts reflect
              source growth and coverage as well as refactoring; inspect the
              rate and source changes together.
            </p>
          )}
      </section>
      <section className="intelligence-panel">
        <header>
          <div>
            <h3>What changed in the hotspots</h3>
            <p>
              Only exact source identities present in both bounded hotspot lists
              are compared.
            </p>
          </div>
          <CodeChangeIcon />
        </header>
        {changes.length ? (
          <div className="hotspot-comparisons">
            <div className="hotspot-comparison-head">
              <span>Source symbol</span>
              <span>Before</span>
              <span>Now</span>
              <span>Cognitive delta</span>
            </div>
            {changes.map(({ finding, before, delta }) => (
              <div className="hotspot-comparison" key={finding.key}>
                <div>
                  <strong>{finding.name}</strong>
                  <code>{finding.file}</code>
                </div>
                <span>{before.cognitive}</span>
                <span>{finding.cognitive}</span>
                <strong
                  className={
                    delta < 0 ? "improved" : delta > 0 ? "increased" : ""
                  }
                >
                  {delta > 0 ? "+" : ""}
                  {delta}
                </strong>
              </div>
            ))}
          </div>
        ) : (
          <div className="intelligence-small-empty">
            <GitBranch size={20} />
            <div>
              <strong>
                {baseline
                  ? "No comparable symbol pairs in these bounded lists."
                  : "A second compatible checkpoint will make change visible."}
              </strong>
              <p>
                A symbol leaving the hotspot list does not prove it was fixed.
                File moves and renamed identities require source review.
              </p>
            </div>
          </div>
        )}
      </section>
      {related.length > 0 && (
        <section className="intelligence-panel improvement-work">
          <header>
            <div>
              <h3>Improvement work, connected</h3>
              <p>Focused tasks already planned in this project.</p>
            </div>
            <Target size={17} />
          </header>
          {related.slice(0, 8).map((task) => (
            <button key={task.id} onClick={() => open(task)}>
              <span>{task.identifier}</span>
              <div>
                <strong>{task.title}</strong>
                <small>
                  {task.scope?.join(" · ") ?? "Source scope not attached"}
                </small>
              </div>
              <span className="detail-data-badge">{task.stage}</span>
              <ArrowUpRight size={14} />
            </button>
          ))}
        </section>
      )}
      <FindingList
        {...props}
        snapshot={latest}
        title="Choose the next focused improvement"
        description="Plan a source-backed task from a hotspot. A worker never starts just because you create the work."
        findings={latest.hotspots.slice(0, 8)}
      />
    </div>
  );
}
function CodeChangeIcon() {
  return <GitBranch size={17} />;
}
