import { useEffect, useState } from "react";
import { Check, Copy, LoaderCircle, RefreshCw, Sparkles, X } from "lucide-react";
import type { Project } from "../shared";
import {
  analysisSteps,
  clockLabel,
  elapsedLabel,
  readableDetail,
  stepIndex,
  stepLabel,
  type AnalysisProgress,
} from "../analysis-progress";
import { Modal } from "./Dialogs";
import "../styles-analysis.css";

export const isAnalyzing = (project: Project) =>
  project.analysis === "connecting" || project.analysis === "indexing";

/** The time now, again every second while `running`. */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

const elapsedOf = (progress: AnalysisProgress, now: number) =>
  Math.max(
    0,
    (progress.stoppedAt ? Date.parse(progress.stoppedAt) : now) -
      Date.parse(progress.startedAt),
  );

/** How far the current step is, when the engine measured it. */
const percentOf = (progress?: AnalysisProgress) =>
  progress?.percent !== undefined
    ? Math.max(0, Math.min(100, progress.percent))
    : undefined;

/** A thin bar: filled as far as the engine says, or moving when it does not say. */
export function AnalysisMeter({
  progress,
  stopped = false,
}: {
  progress?: AnalysisProgress;
  stopped?: boolean;
}) {
  const percent = percentOf(progress);
  return (
    <span
      className={`analysis-meter ${percent === undefined ? "unmeasured" : ""} ${stopped ? "stopped" : ""}`}
      role="progressbar"
      aria-label="Code analysis progress"
      {...(percent !== undefined ? { "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 } : {})}
    >
      <span style={percent !== undefined ? { width: `${percent}%` } : undefined} />
    </span>
  );
}

/** The sidebar's line under "Analyzing code": the step and how long it has run. */
export function analysisCardLine(project: Project, now: number): string {
  const progress = project.analysisProgress;
  if (!progress) return "Starting…";
  const step = analysisSteps[stepIndex(progress.step)]?.short ?? "Working";
  return `${step} · ${clockLabel(elapsedOf(progress, now))}`;
}

/**
 * Where a project's code analysis stands: each step, what the engine is doing
 * now, how long it has run, and, when it stopped, why and what to do next.
 */
export function AnalysisPanel({
  project,
  message,
  onClose,
  onRetry,
  onOpenInsights,
}: {
  project: Project;
  /** Why the analysis last asked for here could not run, when it did not start. */
  message?: string;
  onClose: () => void;
  onRetry: () => void;
  onOpenInsights: () => void;
}) {
  const running = isAnalyzing(project);
  const stopped = project.analysis === "error";
  // A refusal before the analysis began (a sign-in under way, no folder) is said
  // here too, though the project's own state did not change.
  const refused = !running && !stopped && !!message;
  const said = stopped ? project.analysisNote : refused ? message : undefined;
  const ready = project.analysis === "ready";
  const now = useNow(running);
  const progress = project.analysisProgress;
  const current = ready
    ? analysisSteps.length
    : progress
      ? stepIndex(progress.step)
      : running
        ? 0
        : -1;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const details = [
      `Project: ${project.name}`,
      `Folder: ${project.path ?? "none"}`,
      `Branch: ${project.branch}`,
      progress ? `Stopped at: ${stepLabel(progress.step)}` : "",
      `Memtrace said: ${said ?? "nothing"}`,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* The details stay on screen to select by hand. */
    }
  };
  const title = ready
    ? "Code context is ready"
    : stopped
      ? "Analysis stopped"
      : refused
        ? "Analysis could not start"
        : running
        ? `Analyzing ${project.name}`
        : "Not analyzed yet";
  const description = ready
    ? "Memtrace has mapped this project. Workers start every task with its context."
    : stopped
      ? `Memtrace could not finish${progress ? ` while ${stepLabel(progress.step).toLowerCase()}` : ""}. Nothing in your project was changed.`
      : refused
        ? "Nothing in your project was changed. When what is below is sorted, try again."
        : running
        ? "Memtrace is mapping your code on this computer. You can keep planning while it works."
        : "Memtrace maps your code on this computer, so every task starts with the right context.";
  return (
    <Modal
      title={title}
      kicker="CODE ANALYSIS"
      description={description}
      close={onClose}
    >
      <div className="modal-body analysis-panel">
        {(running || stopped) && progress && (
          <div className={`analysis-summary ${stopped ? "stopped" : ""}`}>
            <div className="analysis-clock">
              <strong>{elapsedLabel(elapsedOf(progress, now))}</strong>
              <span>{stopped ? "before it stopped" : "so far"}</span>
            </div>
            <div className="analysis-summary-meter">
              <AnalysisMeter progress={progress} stopped={stopped} />
              <span>
                {percentOf(progress) !== undefined ? `${percentOf(progress)}% · ` : ""}
                {stepLabel(progress.step)}
              </span>
            </div>
          </div>
        )}
        <ol className="analysis-steps">
          {analysisSteps.map((step, index) => {
            const state =
              index < current
                ? "done"
                : index === current
                  ? stopped
                    ? "stopped"
                    : running
                      ? "active"
                      : "upcoming"
                  : "upcoming";
            const live = state === "active" || state === "stopped";
            return (
              <li key={step.id} className={`analysis-step ${state}`}>
                <span className="analysis-step-mark" aria-hidden="true">
                  {state === "done" ? (
                    <Check size={12} strokeWidth={2.6} />
                  ) : state === "active" ? (
                    <LoaderCircle size={13} className="analysis-spin" />
                  ) : state === "stopped" ? (
                    <X size={12} strokeWidth={2.6} />
                  ) : (
                    <span className="analysis-step-dot" />
                  )}
                </span>
                <div className="analysis-step-text">
                  <strong>{step.label}</strong>
                  <p>{step.about}</p>
                  {live && progress && (progress.detail || progress.total !== undefined) && (
                    <p className="analysis-live">
                      {progress.done !== undefined && progress.total !== undefined && (
                        <b>
                          {progress.done.toLocaleString()} of{" "}
                          {progress.total.toLocaleString()}
                          {progress.unit ? ` ${progress.unit}` : ""}
                        </b>
                      )}
                      {progress.detail && <span>{readableDetail(progress.detail)}</span>}
                    </p>
                  )}
                </div>
                <span className="sr-only">
                  {state === "done" ? "done" : state === "active" ? "in progress" : state === "stopped" ? "stopped here" : "not started"}
                </span>
              </li>
            );
          })}
        </ol>
        {said && (
          <section className="analysis-said">
            <header>
              <span>What Memtrace said</span>
              <button type="button" onClick={() => void copy()}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy details"}
              </button>
            </header>
            <p>{said}</p>
          </section>
        )}
      </div>
      <footer className="modal-footer">
        <span>
          <Sparkles size={12} />
          Runs on this computer. Your code stays here.
        </span>
        <div className="analysis-actions">
          <button className="button secondary" onClick={onClose}>
            {running ? "Keep working" : "Close"}
          </button>
          {ready ? (
            <button className="button primary" onClick={onOpenInsights}>
              Open insights
            </button>
          ) : !running ? (
            <button className="button primary" onClick={onRetry}>
              <RefreshCw size={13} />
              {stopped || refused ? "Try again" : "Analyze now"}
            </button>
          ) : null}
        </div>
      </footer>
    </Modal>
  );
}
