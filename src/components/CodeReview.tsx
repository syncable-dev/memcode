import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Circle,
  FileCode2,
  GitBranch,
  ListChecks,
  MessageSquare,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { WorkItem } from "../shared";
import { harnessNames } from "../shared";
import { reviewQuality } from "../code-review-presentation";
import {
  activeCodeReviewFindings,
  codeReviewPhases,
  codeReviewTitle,
  reviewIsBusy,
  reviewFindingDisposition,
  type CodeReviewAPI,
  type CodeReviewEvidence,
  type CodeReviewFinding,
  type CodeReviewSummary,
  type StoryReviewRun,
} from "../code-review";
import MessageMarkdown from "./MessageMarkdown";
import ReviewQualityComparison from "./ReviewQualityComparison";
import ReviewFindingDecision from "./ReviewFindingDecision";
import { Spinner } from "./UI";
import "../styles-code-review.css";

interface Props {
  task: WorkItem;
  canStartReview: boolean;
  remoteReview?: { host: string; waiting: boolean; error?: string };
  notify: (text: string) => void;
  onOpenSource: (path: string, line?: number) => void;
  onOpenChanges: (finding?: CodeReviewFinding) => void;
}
const measure = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : value.toLocaleString();
const provenanceLabel = {
  ast: "AST analysis",
  yaml: "Project rules",
  cross_module: "Cross-module analysis",
  online: "Live repository check",
};
function ReviewEvidence({ value }: { value: CodeReviewEvidence }) {
  if (Array.isArray(value))
    return (
      <ul>
        {value.map((item, index) => (
          <li key={index}>
            <ReviewEvidence value={item} />
          </li>
        ))}
      </ul>
    );
  if (value !== null && typeof value === "object")
    return (
      <dl>
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{key.replaceAll("_", " ")}</dt>
            <dd>
              <ReviewEvidence value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return (
    <span>
      {value === null
        ? "Not reported"
        : typeof value === "boolean"
          ? value
            ? "Yes"
            : "No"
          : String(value)}
    </span>
  );
}
const outcomeLabel = (run: StoryReviewRun | null) =>
  !run
    ? "Not reviewed"
    : run.state === "completed"
      ? {
          ready: "Ready for acceptance",
          "changes-requested": "Changes requested",
          incomplete: "Partial review",
          "not-applicable": "No code changes",
        }[run.outcome ?? "incomplete"]
      : ({
          queued: "Queued",
          running: "In progress",
          cancelled: "Stopped",
          failed: "Needs attention",
          stale: "Needs a new review",
        }[run.state] ?? run.state);

/** The implementation thread and review thread deliberately have separate lifecycles. */
export function CodeReview({
  task,
  canStartReview,
  remoteReview,
  notify,
  onOpenSource,
  onOpenChanges,
}: Props) {
  const api = window.memcode as typeof window.memcode & Partial<CodeReviewAPI>;
  const summary = (task as WorkItem & { codeReview?: CodeReviewSummary })
    .codeReview;
  const [run, setRun] = useState<StoryReviewRun | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [draft, setDraft] = useState(""),
    [acceptReason, setAcceptReason] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [expanded, setExpanded] = useState<string>(),
    [dismissedOpen, setDismissedOpen] = useState(false),
    [discussed, setDiscussed] = useState<string>();
  const thread = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const currentTask = useRef(task.id);
  const actionEpoch = useRef(0);
  const selectedRun = useRef<string | undefined>(undefined);
  currentTask.current = task.id;
  useEffect(() => {
    actionEpoch.current += 1;
    setBusy(false);
    setRun(null);
    setLoading(true);
    setDraft("");
    setAcceptReason("");
    setSelected([]);
    setExpanded(undefined);
    setDismissedOpen(false);
    setDiscussed(undefined);
  }, [task.id]);
  useEffect(() => {
    let alive = true;
    setError("");
    if (!api.getCodeReview) {
      setLoading(false);
      return;
    }
    const timeout = setTimeout(() => {
      if (alive) {
        setLoading(false);
        setError("The local review did not respond. Try loading it again.");
      }
    }, 12000);
    void api
      .getCodeReview(task.id)
      .then((value) => {
        if (alive) setRun(value);
      })
      .catch((failure: Error) => {
        if (alive) setError(failure.message);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      clearTimeout(timeout);
    };
  }, [task.id, summary?.runId, summary?.updatedAt]);
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [run?.messages.length, run?.messages.at(-1)?.text]);
  useEffect(() => {
    if (selectedRun.current !== run?.id) {
      selectedRun.current = run?.id;
      setSelected([]);
      setExpanded(undefined);
      setDismissedOpen(false);
      return;
    }
    const active = new Set(
      run ? activeCodeReviewFindings(run).map((finding) => finding.id) : [],
    );
    setSelected((ids) =>
      ids.every((id) => active.has(id))
        ? ids
        : ids.filter((id) => active.has(id)),
    );
  }, [run?.id, run?.findingDispositions]);
  const action = async (operation: () => Promise<unknown>) => {
    const taskId = task.id,
      epoch = ++actionEpoch.current;
    const current = () =>
      currentTask.current === taskId && actionEpoch.current === epoch;
    setBusy(true);
    setError("");
    try {
      await operation();
      if (!current()) return false;
      const updated = api.getCodeReview
        ? await api.getCodeReview(taskId)
        : undefined;
      if (!current()) return false;
      if (updated !== undefined) setRun(updated);
      return true;
    } catch (failure) {
      if (current()) setError((failure as Error).message);
      return false;
    } finally {
      if (current()) setBusy(false);
    }
  };
  const start = () => {
    if (!canStartReview && !remoteReview) return;
    void action(async () => {
      if (!api.startCodeReview)
        throw Error("The local review service is not connected yet.");
      await api.startCodeReview(task.id);
    });
  };
  const send = () => {
    if (!run || !draft.trim() || !api.sendCodeReviewMessage) return;
    const text = draft.trim();
    void action(() => api.sendCodeReviewMessage!(task.id, run.id, text)).then(
      (saved) => {
        if (saved) {
          setDraft("");
          setDiscussed(undefined);
        }
      },
    );
  };
  const working = reviewIsBusy(run) || run?.reviewer?.state === "running",
    findings = run ? activeCodeReviewFindings(run) : [],
    dismissedFindings =
      run?.findings.filter(
        (finding) =>
          reviewFindingDisposition(run, finding.id)?.status === "dismissed",
      ) ?? [],
    metrics = run?.metrics ?? [],
    quality = reviewQuality(run),
    discussionFinding = findings.find((finding) => finding.id === discussed),
    activeWorker = ["preparing", "running", "stopping"].includes(
      task.run.state,
    ),
    passed =
      run?.checks.filter((check) => check.state === "passed").length ?? 0;
  const dispositionDisabled =
    !canStartReview ||
    busy ||
    working ||
    run?.state !== "completed" ||
    activeWorker;
  const dismissFinding = async (
    finding: CodeReviewFinding,
    reason: Parameters<CodeReviewAPI["dismissCodeReviewFinding"]>[3],
    explanation: string,
  ) => {
    if (!run || !api.dismissCodeReviewFinding) return false;
    const saved = await action(() =>
      api.dismissCodeReviewFinding!(
        task.id,
        run.id,
        finding.id,
        reason,
        explanation,
      ),
    );
    if (saved) {
      setSelected((ids) => ids.filter((id) => id !== finding.id));
      setDismissedOpen(true);
      notify("Dismissal saved with this review.");
    }
    return saved;
  };
  const reopenFinding = async (finding: CodeReviewFinding) => {
    if (!run || !api.reopenCodeReviewFinding) return false;
    const saved = await action(() =>
      api.reopenCodeReviewFinding!(task.id, run.id, finding.id),
    );
    if (saved) {
      setExpanded(finding.id);
      notify("Finding reopened for review.");
    }
    return saved;
  };
  return (
    <section className="code-review-workspace" aria-label="Story code review">
      <div className="code-review-scroll">
        <header className="code-review-heading">
          <div className="code-review-eyebrow">
            <ShieldCheck size={13} /> THIS CHANGE, UNDERSTOOD
          </div>
          <div className="code-review-title-row">
            <h3>{codeReviewTitle(run)}</h3>
            <span className={`code-review-status ${run?.state ?? "idle"}`}>
              <i />
              {outcomeLabel(run)}
            </span>
          </div>
          <p>
            {run?.note ||
              (run
                ? "Findings, measured quality and verification for this story’s recorded changes."
                : "Bring the evidence together before accepting the work. Review this story’s changes, their quality and the code they affect.")}
          </p>
          <div className="code-review-heading-actions">
            <div className="code-review-provenance">
              <span>
                <FileCode2 size={12} />
                {run?.snapshot.id
                  ? `${run.snapshot.files.length} changed files`
                  : run
                    ? working
                      ? "Capturing story changes"
                      : "Story patch unavailable"
                    : "Story-scoped changes"}
              </span>
              <span>
                <GitBranch size={12} />
                {run?.snapshot.branch || task.run.branch || "Current epic"}
              </span>
            </div>
            {working ? (
              <button
                className="button secondary small"
                disabled={!!remoteReview || busy || !api.cancelCodeReview}
                onClick={() =>
                  void action(() => api.cancelCodeReview!(task.id, run!.id))
                }
              >
                <Square size={11} />
                Stop review
              </button>
            ) : (
              <button
                className="button primary small"
                disabled={
                  (!canStartReview && !remoteReview) || remoteReview?.waiting ||
                  busy ||
                  loading ||
                  activeWorker ||
                  task.example ||
                  !api.startCodeReview
                }
                onClick={start}
              >
                {busy ? (
                  <Spinner />
                ) : run ? (
                  <RefreshCw size={12} />
                ) : (
                  <Play size={12} />
                )}
                {remoteReview?.waiting ? "Review request queued" : remoteReview ? `Review on ${remoteReview.host}` : run ? "Review again" : "Run code review"}
              </button>
            )}
          </div>
          {(!canStartReview || remoteReview) && (
            <p className="code-review-run-hint">
              {remoteReview ? `This review runs on ${remoteReview.host}. Its progress, measurements and discussion appear here.` : "Move this story to Code review to run a new review."}
            </p>
          )}
          {remoteReview?.error && <p className="code-review-notice error" role="alert">{remoteReview.error}</p>}
        </header>
        {error && (
          <div className="code-review-notice error" role="alert">
            <ShieldCheck size={15} />
            <span>{error}</span>
            <button
              aria-label="Dismiss review error"
              onClick={() => setError("")}
            >
              <X size={13} />
            </button>
          </div>
        )}
        {activeWorker && (
          <div className="code-review-notice">
            <Circle size={13} />
            <span>
              Let the implementation worker finish before capturing its review.
            </span>
          </div>
        )}
        {reviewIsBusy(run) && (
          <ol className="code-review-phases" aria-label="Review progress">
            {codeReviewPhases.map((phase, index) => {
              const state = run?.phases.find((item) => item.id === phase.id);
              return (
                <li
                  key={phase.id}
                  className={state?.state ?? "idle"}
                  title={state?.note || phase.description}
                >
                  <span>
                    {state?.state === "complete" ? (
                      <Check size={12} />
                    ) : state?.state === "running" ? (
                      <Spinner />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <div>
                    <strong>{phase.label}</strong>
                    <small>
                      {state?.state === "running"
                        ? "Analyzing"
                        : state?.state === "complete"
                          ? "Complete"
                          : state?.state === "unavailable"
                            ? "Not available"
                            : state?.state === "failed"
                              ? "Needs attention"
                              : "Waiting"}
                    </small>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {loading ? (
          <div className="code-review-loading">
            <Spinner />
            Loading this story’s review…
          </div>
        ) : !run ? (
          <div className="code-review-empty">
            <div className="code-review-empty-mark">
              <ShieldCheck size={30} />
              <span />
              <i />
            </div>
            <h4>A review with the full picture.</h4>
            <p>
              Memtrace examines the recorded change and its context. You get a
              focused list of findings, clear quality measurements and the
              checks that actually ran.
            </p>
            <div className="code-review-preview-grid">
              <div>
                <ListChecks size={16} />
                <strong>Actionable findings</strong>
                <span>Rules, correctness and refactoring opportunities.</span>
              </div>
              <div>
                <Sparkles size={16} />
                <strong>Measured quality</strong>
                <span>
                  Measured complexity, nesting and maintainability for the
                  changed code.
                </span>
              </div>
              <div>
                <GitBranch size={16} />
                <strong>Impact in context</strong>
                <span>The callers, files and flows this change reaches.</span>
              </div>
            </div>
            <small>
              {task.example
                ? "Example stories do not produce live review evidence."
                : !api.startCodeReview
                  ? "Connecting the review experience to the local engine."
                  : "Start a review when the implementation is ready. No changes are accepted automatically."}
            </small>
          </div>
        ) : (
          <>
            <div className="code-review-summary" aria-label="Review summary">
              <div className="code-review-score">
                <span>Changed-function maintainability</span>
                <strong>
                  {measure(quality.score)}
                  {quality.score !== null && <small>/ 100</small>}
                </strong>
                <p>
                  {quality.score !== null
                    ? `Native MI · average of ${quality.measured} measured ${quality.measured === 1 ? "function" : "functions"}`
                    : `${quality.measured} ${quality.measured === 1 ? "function" : "functions"} measured`}
                </p>
                {quality.score !== null ? (
                  <span
                    className="code-review-score-bar"
                    role="meter"
                    aria-label="Changed-function maintainability"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={quality.score}
                  >
                    <i style={{ width: `${quality.score}%` }} />
                  </span>
                ) : (
                  <small className="code-review-score-reason">
                    {quality.reason}
                  </small>
                )}
                {quality.score !== null && (
                  <small className="code-review-score-reason">
                    Maintainability, not a correctness or acceptance grade.
                  </small>
                )}
              </div>
              <div className="code-review-summary-facts">
                <div>
                  <span>Findings to consider</span>
                  <strong>{findings.length}</strong>
                  <small>
                    {findings.some((finding) =>
                      ["critical", "high"].includes(finding.severity),
                    )
                      ? `${findings.filter((finding) => ["critical", "high"].includes(finding.severity)).length} high or critical priority`
                      : dismissedFindings.length
                        ? `${dismissedFindings.length} dismissed with a saved reason`
                        : "Inspect the evidence before deciding"}
                  </small>
                </div>
                <div>
                  <span>Recorded checks</span>
                  <strong>
                    {passed}
                    <small> / {run.checks.length}</small>
                  </strong>
                  <small>
                    {run.checks.some((check) => check.state === "failed")
                      ? "A recorded check failed"
                      : run.checks.some(
                            (check) => check.state === "unavailable",
                          ) || !run.checks.length
                        ? "Some verification is unavailable"
                        : "All recorded checks passed"}
                  </small>
                </div>
              </div>
            </div>
            <div className="code-review-evidence-line">
              <span>
                <ShieldCheck size={12} />
                {run.coverage.complete
                  ? "Recorded coverage complete"
                  : "Partial evidence"}
              </span>
              {run.snapshot.id && (
                <>
                  <span>Snapshot {run.snapshot.id.slice(0, 12)}</span>
                  <span>
                    +{run.snapshot.additions} −{run.snapshot.deletions}
                  </span>
                </>
              )}
            </div>
            <section className="code-review-panel">
              <header>
                <div>
                  <h4>
                    Findings <small>{findings.length}</small>
                  </h4>
                  <p>
                    Review the concern, inspect the code, then choose what to
                    fix.
                  </p>
                </div>
                {selected.length > 0 && (
                  <button
                    className="button secondary small"
                    disabled={
                      !canStartReview ||
                      busy ||
                      working ||
                      !api.requestCodeReviewFixes
                    }
                    onClick={() =>
                      void action(async () => {
                        await api.requestCodeReviewFixes!(
                          task.id,
                          run.id,
                          selected,
                        );
                        setSelected([]);
                        notify(
                          "Selected findings sent to the implementation worker.",
                        );
                      })
                    }
                  >
                    Request fixes <ArrowRight size={12} />
                  </button>
                )}
              </header>
              {!findings.length ? (
                <div className="code-review-clear">
                  <ShieldCheck size={22} />
                  <div>
                    <strong>
                      {working
                        ? "Checking the change…"
                        : dismissedFindings.length
                          ? `All ${dismissedFindings.length} findings have saved decisions.`
                          : run.coverage.complete
                            ? "No actionable findings reported."
                            : "No findings in the available evidence."}
                    </strong>
                    <p>
                      {working
                        ? "Results appear here as each step finishes."
                        : dismissedFindings.length
                          ? "Dismissed findings remain below. Checks and coverage still need your final look."
                          : run.coverage.complete
                            ? "Check the quality and verification evidence before accepting."
                            : "Review the coverage notes before drawing a conclusion."}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="code-review-findings">
                  {findings.map((finding) => (
                    <article
                      key={finding.id}
                      className={expanded === finding.id ? "expanded" : ""}
                    >
                      <div className="code-review-finding-line">
                        <input
                          type="checkbox"
                          aria-label={`Select finding: ${finding.title}`}
                          checked={selected.includes(finding.id)}
                          onChange={(event) =>
                            setSelected((ids) =>
                              event.target.checked
                                ? [...ids, finding.id]
                                : ids.filter((id) => id !== finding.id),
                            )
                          }
                        />
                        <button
                          className="code-review-finding-title"
                          aria-expanded={expanded === finding.id}
                          onClick={() =>
                            setExpanded(
                              expanded === finding.id ? undefined : finding.id,
                            )
                          }
                        >
                          <span
                            className={`code-review-severity ${finding.severity}`}
                          >
                            {finding.severity}
                          </span>
                          <strong>{finding.title}</strong>
                          <ChevronDown size={13} />
                        </button>
                      </div>
                      {finding.path && (
                        <button
                          className="code-review-file"
                          onClick={() =>
                            onOpenSource(finding.path!, finding.line)
                          }
                        >
                          <FileCode2 size={11} />
                          {finding.path}
                          {finding.line ? `:${finding.line}` : ""}
                          <ArrowRight size={11} />
                        </button>
                      )}
                      {expanded === finding.id && (
                        <div className="code-review-finding-detail">
                          <div className="code-review-finding-origin">
                            <ShieldCheck size={11} />
                            {finding.provenance
                              ? provenanceLabel[finding.provenance]
                              : "Review finding"}
                            {finding.locationScope === "affected-code" && (
                              <span>Affected consumer</span>
                            )}
                          </div>
                          <MessageMarkdown
                            text={finding.explanation}
                            onOpenLink={(href) => onOpenSource(href)}
                          />
                          {finding.evidenceData !== undefined ? (
                            <details className="code-review-structured-evidence">
                              <summary>
                                Recorded evidence <ChevronDown size={11} />
                              </summary>
                              <div>
                                <ReviewEvidence value={finding.evidenceData} />
                                {finding.evidenceTruncated && (
                                  <p>
                                    Evidence was limited at capture. Inspect the
                                    source for the full context.
                                  </p>
                                )}
                              </div>
                            </details>
                          ) : (
                            finding.evidence && (
                              <blockquote>{finding.evidence}</blockquote>
                            )
                          )}
                          {finding.locationScope === "affected-code" &&
                            !!finding.relatedCapturedPaths?.length && (
                              <p className="code-review-related-change">
                                Connected story changes:{" "}
                                {finding.relatedCapturedPaths.join(", ")}. This
                                consumer is affected code, not a file authored
                                by this story.
                              </p>
                            )}
                          {finding.recommendation && (
                            <p>
                              <strong>Next step</strong>{" "}
                              {finding.recommendation}
                            </p>
                          )}
                          <div className="code-review-finding-actions">
                            <button
                              className="text-button"
                              onClick={() => onOpenChanges(finding)}
                            >
                              See in changes <ArrowRight size={12} />
                            </button>
                            <button
                              className="text-button"
                              onClick={() => {
                                setDiscussed(finding.id);
                                setDraft(
                                  `Explain the finding “${finding.title}”${finding.path ? ` in ${finding.path}` : ""}.`,
                                );
                                composer.current?.focus();
                              }}
                            >
                              Discuss finding <MessageSquare size={12} />
                            </button>
                          </div>
                          <ReviewFindingDecision
                            run={run}
                            finding={finding}
                            disabled={
                              dispositionDisabled ||
                              !api.dismissCodeReviewFinding
                            }
                            onDismiss={(reason, explanation) =>
                              dismissFinding(finding, reason, explanation)
                            }
                            onReopen={() => reopenFinding(finding)}
                          />
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
              {dismissedFindings.length > 0 && (
                <details
                  className="review-dismissed-findings"
                  open={dismissedOpen}
                  onToggle={(event) =>
                    setDismissedOpen(event.currentTarget.open)
                  }
                >
                  <summary>
                    Dismissed findings <small>{dismissedFindings.length}</small>
                    <ChevronDown size={13} />
                  </summary>
                  <p>
                    Decisions for this captured review. The original findings
                    stay intact.
                  </p>
                  {dismissedFindings.map((finding) => (
                    <details
                      key={finding.id}
                      className="review-dismissed-finding"
                    >
                      <summary>
                        <span
                          className={`code-review-severity ${finding.severity}`}
                        >
                          {finding.severity}
                        </span>
                        <strong>{finding.title}</strong>
                        <ChevronDown size={12} />
                      </summary>
                      <div>
                        {finding.path && (
                          <button
                            className="code-review-file"
                            onClick={() =>
                              onOpenSource(finding.path!, finding.line)
                            }
                          >
                            <FileCode2 size={11} />
                            {finding.path}
                            {finding.line ? `:${finding.line}` : ""}
                          </button>
                        )}
                        <MessageMarkdown
                          text={finding.explanation}
                          onOpenLink={(href) => onOpenSource(href)}
                        />
                        {finding.evidenceData !== undefined ? (
                          <details className="code-review-structured-evidence">
                            <summary>
                              Recorded evidence <ChevronDown size={11} />
                            </summary>
                            <div>
                              <ReviewEvidence value={finding.evidenceData} />
                            </div>
                          </details>
                        ) : (
                          finding.evidence && (
                            <blockquote>{finding.evidence}</blockquote>
                          )
                        )}
                        <ReviewFindingDecision
                          run={run}
                          finding={finding}
                          disabled={
                            dispositionDisabled || !api.reopenCodeReviewFinding
                          }
                          onDismiss={(reason, explanation) =>
                            dismissFinding(finding, reason, explanation)
                          }
                          onReopen={() => reopenFinding(finding)}
                        />
                        {!canStartReview && (
                          <p className="review-comparison-note">
                            Move this story to Code review to change a saved
                            decision.
                          </p>
                        )}
                      </div>
                    </details>
                  ))}
                </details>
              )}
            </section>
            <div className="code-review-evidence-grid">
              <section className="code-review-panel">
                <header>
                  <div>
                    <h4>Quality of the change</h4>
                    <p>
                      Complexity and maintainability of the changed functions.
                    </p>
                  </div>
                  {quality.lowest !== null && (
                    <span className="code-review-lowest">
                      Lowest native MI <strong>{quality.lowest}</strong>
                    </span>
                  )}
                </header>
                {metrics.length ? (
                  <ReviewQualityComparison
                    metrics={metrics}
                    coverage={run.qualityComparison}
                    onOpenSource={onOpenSource}
                    onOpenChanges={() => onOpenChanges()}
                  />
                ) : (
                  <p className="code-review-unavailable">
                    {working
                      ? "Measuring the changed source…"
                      : run.qualityComparison?.notes[0] ||
                        "Function measurements are not available for this review."}
                  </p>
                )}
              </section>
              <section className="code-review-panel">
                <header>
                  <div>
                    <h4>Impact & verification</h4>
                    <p>What this change reaches and what was checked.</p>
                  </div>
                </header>
                <div className="code-review-impact">
                  <div>
                    <strong>{measure(run.impact.files)}</strong>
                    <span>Files</span>
                  </div>
                  <div>
                    <strong>{measure(run.impact.processes)}</strong>
                    <span>Flows</span>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => onOpenChanges()}
                  >
                    Explore changes <ArrowRight size={12} />
                  </button>
                </div>
                {run.impact.note && (
                  <p className="code-review-footnote">{run.impact.note}</p>
                )}
                <ul className="code-review-checks">
                  {run.checks.length ? (
                    run.checks.map((check, index) => (
                      <li
                        key={`${check.name}:${index}`}
                        className={check.state}
                      >
                        {check.state === "passed" ? (
                          <Check size={12} />
                        ) : check.state === "failed" ? (
                          <X size={12} />
                        ) : (
                          <Circle size={11} />
                        )}
                        <div>
                          <strong>{check.name}</strong>
                          {check.detail && <p>{check.detail}</p>}
                        </div>
                        <span>
                          {check.state === "unavailable"
                            ? "Not run"
                            : check.state}
                        </span>
                      </li>
                    ))
                  ) : (
                    <li className="unavailable">
                      <Circle size={11} />
                      <div>No linked verification has been recorded.</div>
                    </li>
                  )}
                </ul>
              </section>
            </div>
            <details className="code-review-coverage">
              <summary>
                <ShieldCheck size={13} />
                Evidence & coverage
                <span>
                  {run.coverage.complete ? "Source-bound" : "Partial evidence"}
                </span>
                <ChevronDown size={12} />
              </summary>
              <div>
                {run.coverage.limitations.length ? (
                  <ul>
                    {run.coverage.limitations.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p>The review completed with the recorded coverage.</p>
                )}
                <dl>
                  <div>
                    <dt>Snapshot</dt>
                    <dd>{run.snapshot.id.slice(0, 16) || "Pending"}</dd>
                  </div>
                  <div>
                    <dt>Engine</dt>
                    <dd>{run.engine.version || "Not reported"}</dd>
                  </div>
                  <div>
                    <dt>Captured</dt>
                    <dd>{new Date(run.createdAt).toLocaleString()}</dd>
                  </div>
                </dl>
                {run.engine.audit && (
                  <div className="code-review-method">
                    <h5>Review method</h5>
                    <dl>
                      {run.engine.audit.reviewMode && (
                        <div>
                          <dt>Mode</dt>
                          <dd>
                            {run.engine.audit.reviewMode === "online"
                              ? "Live repository check"
                              : "Strict review"}
                          </dd>
                        </div>
                      )}
                      {run.engine.audit.rawCount !== undefined && (
                        <div>
                          <dt>Before filtering</dt>
                          <dd>{run.engine.audit.rawCount}</dd>
                        </div>
                      )}
                      {run.engine.audit.filteredCount !== undefined && (
                        <div>
                          <dt>After filtering</dt>
                          <dd>{run.engine.audit.filteredCount}</dd>
                        </div>
                      )}
                    </dl>
                    {run.engine.audit.sourceCounts && (
                      <div className="code-review-source-counts">
                        {Object.entries(run.engine.audit.sourceCounts).map(
                          ([source, count]) => (
                            <span key={source}>
                              {
                                provenanceLabel[
                                  source as keyof typeof provenanceLabel
                                ]
                              }{" "}
                              <b>{count}</b>
                            </span>
                          ),
                        )}
                      </div>
                    )}
                    {run.engine.audit.detectors && (
                      <ul>
                        {Object.entries(run.engine.audit.detectors).map(
                          ([name, detector]) => (
                            <li key={name}>
                              <details>
                                <summary>
                                  <strong>{name.replaceAll("_", " ")}</strong> ·{" "}
                                  {detector.status ===
                                  "evaluated_with_limitations"
                                    ? "Evaluated within supported patterns"
                                    : detector.status.replaceAll("_", " ")}
                                </summary>
                                {detector.reason && (
                                  <span> — {detector.reason}</span>
                                )}
                                {detector.details !== undefined && (
                                  <div className="code-review-native-evidence">
                                    <ReviewEvidence value={detector.details} />
                                  </div>
                                )}
                                {detector.detailsTruncated && (
                                  <p>
                                    Coverage details were limited at capture.
                                  </p>
                                )}
                              </details>
                            </li>
                          ),
                        )}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </details>
            {run.state === "completed" &&
              !working &&
              ["ready", "not-applicable"].includes(run.outcome ?? "") && (
                <div className="code-review-next">
                  <div>
                    <ShieldCheck size={18} />
                    <span>
                      <strong>
                        {run.outcome === "not-applicable"
                          ? "Inspect the deliverables before accepting."
                          : "Ready for your final look."}
                      </strong>
                      <small>
                        Keep the evidence with the story as it moves forward.
                      </small>
                    </span>
                  </div>
                  <button
                    className="button primary small"
                    disabled={!canStartReview || busy || !api.acceptCodeReview}
                    onClick={() =>
                      void action(() => api.acceptCodeReview!(task.id, run.id))
                    }
                  >
                    Ready for acceptance <ArrowRight size={13} />
                  </button>
                </div>
              )}
            {run.state === "completed" &&
              !working &&
              run.outcome === "incomplete" && (
                <details className="code-review-coverage code-review-handoff">
                  <summary>
                    Continue with coverage notes <ArrowRight size={12} />
                  </summary>
                  <div>
                    <p>
                      Review the missing measurements above. Explain why this
                      story can move to your final acceptance; its review stays
                      incomplete.
                    </p>
                    <label htmlFor={`review-handoff-${task.id}`}>
                      Your decision
                    </label>
                    <textarea
                      id={`review-handoff-${task.id}`}
                      value={acceptReason}
                      maxLength={2000}
                      onChange={(event) => setAcceptReason(event.target.value)}
                      placeholder="For example, this is a documentation change with no function metrics to measure."
                    />
                    <button
                      className="button secondary small"
                      disabled={
                        !canStartReview ||
                        busy ||
                        !acceptReason.trim() ||
                        !api.acceptCodeReview
                      }
                      onClick={() =>
                        void action(() =>
                          api.acceptCodeReview!(
                            task.id,
                            run.id,
                            acceptReason.trim(),
                          ),
                        )
                      }
                    >
                      Move to acceptance <ArrowRight size={12} />
                    </button>
                  </div>
                </details>
              )}
          </>
        )}
      </div>
      <aside
        className="code-review-discussion"
        aria-label="Review conversation"
      >
        <header>
          <span className="code-review-agent-mark">
            <ShieldCheck size={17} />
          </span>
          <div>
            <strong>Review conversation</strong>
            <span>
              {run?.reviewer
                ? `${harnessNames[run.reviewer.harness]} · ${run.reviewer.model}`
                : "Stay close to the evidence"}
            </span>
          </div>
          {run?.reviewer?.state === "running" && <Spinner />}
        </header>
        <div className="code-review-thread" ref={thread} aria-live="polite">
          {run?.messages.length ? (
            run.messages
              .filter((message) => message.role !== "tool")
              .map((message) => (
                <article key={message.id} className={message.role}>
                  <div>
                    <strong>
                      {message.role === "user"
                        ? message.actor?.name ?? "You"
                        : message.role === "assistant"
                          ? "Reviewer"
                          : "MemCode"}
                    </strong>
                    {message.actor && <span className="message-origin">{message.actor.device}</span>}
                    <time>
                      {new Date(message.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <MessageMarkdown
                    text={message.text}
                    onOpenLink={(href) => onOpenSource(href)}
                  />
                </article>
              ))
          ) : (
            <div className="code-review-discussion-empty">
              <MessageSquare size={22} />
              <h4>Make sense of the review.</h4>
              <p>
                Ask why a finding matters, explore the impact or discuss a
                better approach.
              </p>
              <p>
                When you’re ready, send selected findings back to the
                implementation worker.
              </p>
            </div>
          )}
        </div>
        {run?.reviewer?.note && (
          <p className="code-review-conversation-note">{run.reviewer.note}</p>
        )}
        <div className="code-review-composer">
          {discussionFinding && (
            <div className="code-review-discussion-reference">
              <div>
                <small>Discussing finding</small>
                <strong>{discussionFinding.title}</strong>
              </div>
              <button
                aria-label="Remove finding reference"
                onClick={() => setDiscussed(undefined)}
              >
                <X size={12} />
              </button>
            </div>
          )}
          <textarea
            ref={composer}
            aria-label="Message the code reviewer"
            placeholder={
              run
                ? "Ask about this change or a finding…"
                : "Run a review to start the conversation…"
            }
            value={draft}
            disabled={!run || run.reviewer?.state === "unavailable"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                send();
              }
            }}
          />
          <div>
            <span>
              <ShieldCheck size={11} />
              Review thread
            </span>
            <button
              className="code-review-send"
              aria-label="Send to code reviewer"
              disabled={
                !run ||
                !draft.trim() ||
                busy ||
                run.reviewer?.state === "running" ||
                !api.sendCodeReviewMessage ||
                run.reviewer?.state === "unavailable"
              }
              onClick={send}
            >
              {busy ? <Spinner /> : <ArrowUp size={15} />}
            </button>
          </div>
        </div>
        <footer>Discuss here. Request fixes when you’re ready.</footer>
      </aside>
    </section>
  );
}
