import { useState } from "react";
import { RotateCcw, X } from "lucide-react";
import type {
  CodeReviewAPI,
  CodeReviewFinding,
  StoryReviewRun,
} from "../code-review";
import {
  codeReviewDismissalReasons,
  reviewFindingDisposition,
} from "../code-review";
import { Select } from "./Select";

type Reason = Parameters<CodeReviewAPI["dismissCodeReviewFinding"]>[3];
const reasons = codeReviewDismissalReasons;

export default function ReviewFindingDecision({
  run,
  finding,
  disabled,
  onDismiss,
  onReopen,
}: {
  run: StoryReviewRun;
  finding: CodeReviewFinding;
  disabled: boolean;
  onDismiss: (reason: Reason, explanation: string) => Promise<boolean>;
  onReopen: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false),
    [reason, setReason] = useState<Reason>("false-positive"),
    [explanation, setExplanation] = useState("");
  const disposition = reviewFindingDisposition(run, finding.id);
  if (disposition?.status === "dismissed")
    return (
      <div className="review-finding-decision saved">
        <div>
          <strong>
            Dismissed ·{" "}
            {reasons.find((item) => item.id === disposition.reason)?.label ??
              "Reviewed"}
          </strong>
          <small>
            {disposition.actor.name} ·{" "}
            <time dateTime={disposition.at}>
              {new Date(disposition.at).toLocaleString()}
            </time>
          </small>
        </div>
        <p>{disposition.explanation}</p>
        <div className="review-decision-actions">
          <small>
            Saved with this review. A new review evaluates the finding again.
          </small>
          <button
            className="text-button"
            disabled={disabled}
            onClick={() => void onReopen()}
          >
            <RotateCcw size={12} /> Reopen finding
          </button>
        </div>
      </div>
    );
  if (!editing)
    return (
      <button
        className="text-button review-dismiss-trigger"
        disabled={disabled}
        onClick={() => setEditing(true)}
      >
        Dismiss with reason <X size={12} />
      </button>
    );
  return (
    <form
      className="review-finding-decision"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !explanation.trim()) return;
        void onDismiss(reason, explanation.trim()).then((saved) => {
          if (saved) {
            setEditing(false);
            setExplanation("");
          }
        });
      }}
    >
      <div>
        <strong>Why dismiss this finding?</strong>
        <button
          className="icon-button"
          type="button"
          aria-label="Cancel dismissal"
          onClick={() => setEditing(false)}
        >
          <X size={13} />
        </button>
      </div>
      <Select
        aria-label="Dismissal reason"
        value={reason}
        onValueChange={(value) => setReason(value as Reason)}
        disabled={disabled}
      >
        {reasons.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </Select>
      <label htmlFor={`dismiss-reason-${finding.id}`}>Your explanation</label>
      <textarea
        id={`dismiss-reason-${finding.id}`}
        autoFocus
        value={explanation}
        maxLength={2000}
        placeholder="Explain why this concern can be set aside for this change…"
        onChange={(event) => setExplanation(event.target.value)}
        disabled={disabled}
      />
      <div className="review-decision-actions">
        <small>
          The evidence stays saved. This does not accept the task or mark
          checks as passed.
        </small>
        <button
          className="button secondary small"
          type="submit"
          disabled={disabled || !explanation.trim()}
        >
          Save dismissal
        </button>
      </div>
    </form>
  );
}
