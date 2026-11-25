import { initials, type Person } from "../people";
import { priorityLabels, type Priority } from "../planning/priority";
import {
  Check,
  Circle,
  CircleDashed,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import type { Harness, Stage, WorkItem } from "../shared";
import { harnessNames } from "../shared";
import { timeLabel } from "../planning/dates";

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={"brand-mark " + (small ? "small" : "")} aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none">
        <path
          d="M9 27V13l11 9 11-9v14M9 20l11 9 11-9"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="11" r="2.1" fill="var(--mint)" />
      </svg>
    </span>
  );
}

export function HarnessMark({
  id,
  small = false,
}: {
  id: Harness;
  small?: boolean;
}) {
  return (
    <span
      title={harnessNames[id]}
      className={`harness-mark ${id} ${small ? "small" : ""}`}
    >
      <img
        src={`./adapters/${id === "claude" ? "claude-code" : id}.svg`}
        alt=""
        draggable={false}
      />
    </span>
  );
}

export function WorkerMark({
  task,
  small = false,
}: {
  task: WorkItem;
  small?: boolean;
}) {
  return task.assignment === "auto" && !task.route && !task.sharedSession ? (
    <span
      title="Automatic assignment"
      className={"harness-mark auto " + (small ? "small" : "")}
    >
      <Sparkles size={small ? 12 : 17} />
    </span>
  ) : (
    <HarnessMark id={task.sharedSession?.harness ?? task.harness} small={small} />
  );
}

export function StageIcon({ stage }: { stage: Stage }) {
  return stage === "done" ? (
    <span className="done-check">
      <Check size={11} />
    </span>
  ) : stage === "working" ? (
    <CircleDashed size={14} className="status-working" />
  ) : stage === "review" ? (
    <span className="review-dot" />
  ) : (
    <Circle size={14} className="status-planned" />
  );
}

export function PriorityMark({ value }: { value: string }) {
  const label = priorityLabels[value as Priority] ?? value;
  return (
    <span className={`priority-mark ${value}`} title={label} aria-label={label}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** Whose task it is. */
export function PersonMark({ person }: { person: Person }) {
  return (
    <span className="person-mark" title={person.name} aria-label={person.name}>
      {initials(person.name)}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" />;
}
export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {typeof description === "string" ? <p>{description}</p> : description}
      {action}
    </div>
  );
}

export function Time({ at }: { at: string }) {
  return <time dateTime={at}>{timeLabel(at)}</time>;
}
