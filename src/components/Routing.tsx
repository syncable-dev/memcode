import { Sparkles, ArrowRight, GitBranch } from "lucide-react";
import type { WorkItem } from "../shared";
import { harnessNames } from "../shared";
import { Spinner } from "./UI";

export function RoutingCard({
  task,
  busy,
  plan,
  disabled = false,
}: {
  task: WorkItem;
  busy: boolean;
  plan: () => void;
  disabled?: boolean;
}) {
  const route = task.route;
  if (!route)
    return (
      <div className="routing-empty">
        <span>
          <Sparkles size={14} />A model chosen for the work.
        </span>
        <p>
          {task.example
            ? "Example tasks stay unmeasured. Connect a project to name a real harness and model."
            : "Memtrace measures this task and names a harness, model and effort. Measuring does not start the worker."}
        </p>
        <button onClick={plan} disabled={busy || disabled || task.example}>
          {busy ? <Spinner size={12} /> : <GitBranch size={12} />}
          {busy ? "Measuring" : "Measure scope"}
          <ArrowRight size={12} />
        </button>
      </div>
    );
  return (
    <div className="routing-card">
      <div className="routing-card-head">
        <span>
          <Sparkles size={12} />
          {route.mode === "automatic" ? "Memtrace route" : "Assigned route"}
        </span>
        <span className={"tier-label " + route.tier}>{route.tier}</span>
      </div>
      <div className="routing-model">
        <strong>{route.modelLabel || route.model}</strong>
        <span>
          {harnessNames[route.harness]} · {route.effort} effort
        </span>
      </div>
      {route.inputs.cognitive === null && route.inputs.cyclomatic === null && (
        <p className="routing-scope-note" role="status">
          {task.evidence?.note ??
            "Source complexity has not been measured. This is a provisional route."}
        </p>
      )}
      <div className="routing-measures">
        <div>
          <strong>{route.inputs.cognitive ?? "—"}</strong>
          <span>Cognitive</span>
        </div>
        <div>
          <strong>{route.inputs.cyclomatic ?? "—"}</strong>
          <span>Cyclomatic</span>
        </div>
        <div>
          <strong>
            {route.inputs.affected === null
              ? "—"
              : `${route.inputs.affected}${route.inputs.incomplete ? "+" : ""}`}
          </strong>
          <span>Impact</span>
        </div>
      </div>
      <details className="routing-reasons">
        <summary>
          Why this model?
          <span>
            {route.status === "provisional" ? "Partial scope" : "Measured"}
          </span>
        </summary>
        <ul>
          {route.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <p>
          Prototype envelope policy · {route.policyVersion}. Structural
          measurements are deterministic; suitability thresholds are not
          calibrated.
        </p>
        {route.inputs.sourceRevision && (
          <code>Source {route.inputs.sourceRevision.slice(0, 10)}</code>
        )}
        {!!task.evidence?.symbols.length && (
          <ul className="routing-source-files">
            {[
              ...new Set(task.evidence.symbols.map((symbol) => symbol.file)),
            ].map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        )}
      </details>
      <button
        className="routing-remeasure"
        onClick={plan}
        disabled={busy || disabled || task.example}
      >
        {busy ? <Spinner size={12} /> : <GitBranch size={12} />}
        Measure again
        <ArrowRight size={12} />
      </button>
    </div>
  );
}
