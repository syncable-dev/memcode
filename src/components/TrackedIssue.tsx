import { ArrowUpRight } from "lucide-react";
import type { AppState, WorkItem } from "../shared";
import { keptElsewhere, trackedFieldNames, type TrackedField } from "../tracker";
import { IntegrationMark } from "./IntegrationMark";

const standings = {
  synced: "In step",
  sending: "Sending",
  waiting: "Waiting",
  attention: "Needs you",
  unlinked: "Unlinked",
} as const;

/** The issue a card is, by the name people there use. */
export function TrackedKey({ task }: { task: WorkItem }) {
  const { tracker } = task;
  if (!tracker?.key) return null;
  const standing = tracker.standing ?? "synced";
  return (
    <span
      className={"tracked-key " + standing}
      title={`${standings[standing]}${tracker.note ? `. ${tracker.note}` : ""}`}
    >
      <IntegrationMark id={tracker.provider} size={10} />
      {tracker.key}
      {standing === "attention" && <i aria-label="Needs you" />}
    </span>
  );
}

/** Where a task made in this project now becomes an issue, if it does. */
export function issuesGoTo(state: AppState, projectId: string): string | undefined {
  const elsewhere = keptElsewhere(state, projectId);
  if (elsewhere) return "Linear";
  const connection = state.trackers?.find((item) => item.projectId === projectId);
  return connection?.importedAt &&
    connection.choices?.createIssues &&
    connection.choices.direction === "both"
    ? (connection.team?.name ?? "Linear")
    : undefined;
}

/** Asked before a task is made: a moment later it is an issue already. */
export function KeepHere({
  place,
  keep,
  onChange,
}: {
  /** The team it would become an issue in. */
  place: string;
  keep: boolean;
  onChange: (keep: boolean) => void;
}) {
  return (
    <label className="tracked-keep tracked-keep-new">
      <input
        type="checkbox"
        checked={keep}
        onChange={(event) => onChange(event.target.checked)}
      />
      Keep in MemCode
      <small>{keep ? "No issue is made." : `Otherwise it becomes an issue in ${place}.`}</small>
    </label>
  );
}

/** A task's section about its issue: how the two stand, and what gave way. */
export function TrackedIssue({
  task,
  state,
  act,
}: {
  task: WorkItem;
  state: AppState;
  act: (job: () => Promise<unknown>) => Promise<unknown>;
}) {
  const elsewhere = keptElsewhere(state, task.projectId);
  const connection = elsewhere
    ? undefined
    : state.trackers?.find((item) => item.projectId === task.projectId);
  const { tracker } = task;
  if (!tracker) {
    const becomes = elsewhere
      ? task.createdAt > elsewhere.since
      : connection?.importedAt &&
        connection.choices?.createIssues &&
        task.createdAt > connection.importedAt;
    if (!becomes || task.archivedAt) return null;
    return (
      <section className="inspector-section tracked-issue">
        <div className="inspector-label">LINEAR</div>
        <label className="tracked-keep">
          <input
            type="checkbox"
            checked={!!task.keepHere}
            onChange={(event) =>
              void act(() => window.memcode.keepTaskHere(task.id, event.target.checked))
            }
          />
          Keep in MemCode
        </label>
        {!task.keepHere && connection && (
          <small>It becomes an issue in {connection.team?.name}.</small>
        )}
      </section>
    );
  }
  const standing = tracker.standing ?? "synced";
  return (
    <section className="inspector-section tracked-issue">
      <div className="inspector-label">LINEAR</div>
      <p>
        <button
          type="button"
          className="tracked-open"
          disabled={!tracker.url}
          onClick={() => void act(() => window.memcode.openTracked(task.id))}
        >
          {tracker.key ?? "Issue"}
          <ArrowUpRight size={11} />
        </button>
        {tracker.status && <span>{tracker.status}</span>}
        {!elsewhere && (
          <em className={"tracked-standing " + standing}>{standings[standing]}</em>
        )}
      </p>
      {elsewhere && <small>{elsewhere.by} keeps it in step.</small>}
      {tracker.note && <small>{tracker.note}</small>}
      {tracker.clipped && (
        <small>The description is longer than a task can hold. Edit it in Linear.</small>
      )}
      {!!tracker.kept?.length && (
        <ul className="tracked-kept">
          {tracker.kept.map((kept) => (
            <li key={kept.field}>
              <span>
                {trackedFieldNames[kept.field]} {kept.from === "here" ? "here" : "in Linear"} was{" "}
                <q>{kept.shown}</q>
              </span>
              <button
                type="button"
                className="integration-link"
                onClick={() =>
                  void act(() => window.memcode.restoreTracked(task.id, kept.field as TrackedField))
                }
              >
                Put it back
              </button>
            </li>
          ))}
        </ul>
      )}
      {connection && standing === "attention" && (
        <button
          type="button"
          className="integration-link"
          onClick={() => void act(() => window.memcode.retryTracked(task.id))}
        >
          Try again
        </button>
      )}
      {connection && standing !== "unlinked" && (
        <button
          type="button"
          className="integration-link"
          title="The card and the issue stay, and no longer follow each other."
          onClick={() => void act(() => window.memcode.unlinkTracked(task.id))}
        >
          Unlink
        </button>
      )}
    </section>
  );
}
