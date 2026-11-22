import { useEffect, useState } from "react";
import { loadCardDraft, saveCardDraft } from "../card-drafts";
import { Check, ChevronDown, Clock3, Pencil, X } from "lucide-react";
import type { Message, WorkItem } from "../shared";
import type { ReviewComment } from "../review";
import { reviewLocation } from "../review-labels";
import { Time } from "./UI";

export function pendingFollowups(task: WorkItem) {
  return task.messages.filter(
    (message) =>
      message.followupState &&
      !message.promptedAt &&
      ["queued", "paused"].includes(message.followupState),
  );
}
export function FollowupQueue({
  task,
  comments,
  notify,
  memberId,
}: {
  task: WorkItem;
  comments: ReviewComment[];
  notify: (text: string) => void;
  memberId?: string;
}) {
  const key = "memcode-queue-edit:" + task.id;
  const [stored] = useState(() => {
    const value = loadCardDraft(key) as {
      id?: unknown;
      text?: unknown;
      edits?: unknown;
    } | null;
    return value &&
      typeof value.id === "string" &&
      typeof value.text === "string" &&
      task.messages.some((message) => message.id === value.id)
      ? {
          id: value.id,
          text: value.text,
          edits:
            value.edits && typeof value.edits === "object"
              ? (Object.fromEntries(
                  Object.entries(value.edits).filter(
                    ([, text]) => typeof text === "string",
                  ),
                ) as Record<string, string>)
              : {},
        }
      : undefined;
  });
  const [editing, setEditing] = useState<string | undefined>(stored?.id),
    [text, setText] = useState(stored?.text ?? ""),
    [edits, setEdits] = useState<Record<string, string>>(stored?.edits ?? {}),
    [busy, setBusy] = useState(false);
  useEffect(
    () =>
      saveCardDraft(key, editing ? { id: editing, text, edits } : undefined),
    [key, editing, text, edits],
  );
  const pending = pendingFollowups(task),
    history = task.messages
      .filter((message) =>
        ["included", "cancelled"].includes(message.followupState ?? ""),
      )
      .slice(-8)
      .reverse();
  const notes = (message: Message) =>
    (message.commentIds ?? []).flatMap((id) => {
      const note = comments.find((note) => note.id === id);
      return note ? [note] : [];
    });
  const editingMessage = task.messages.find(
      (message) => message.id === editing,
    ),
    staleDraft =
      !!editingMessage &&
      (!!editingMessage.pickedUpAt ||
        !!editingMessage.promptedAt ||
        editingMessage.followupState === "cancelled");
  const save = async (message: Message) => {
    setBusy(true);
    try {
      await window.memcode.updateQueuedFollowup(
        task.id,
        message.id,
        text,
        Object.entries(edits).map(([id, text]) => ({ id, text })),
      );
      setEditing(undefined);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (message: Message) => {
    setBusy(true);
    try {
      await window.memcode.cancelQueuedFollowup(task.id, message.id);
      if (editing === message.id) setEditing(undefined);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="followup-queue-view" aria-label="Follow-up queue">
      <header>
        <span className="eyebrow">
          <span />
          NEXT FOR THIS WORKER
        </span>
        <h3>Keep the next move clear.</h3>
        <p>
          Sent follow-ups wait here. Edit or cancel until the worker picks them
          up.
        </p>
      </header>
      {staleDraft && editingMessage && (
        <section className="queue-stale-draft" role="status">
          <strong>
            {editingMessage.followupState === "cancelled"
              ? "This follow-up was cancelled before these edits were saved."
              : "The worker picked up this request before these edits were saved."}
          </strong>
          <p>
            Your unsaved draft is preserved here. Copy it into a new follow-up
            to make another change.
          </p>
          <textarea
            aria-label="Preserved follow-up draft"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <footer>
            <button
              className="secondary-button"
              onClick={() => setEditing(undefined)}
            >
              Discard draft
            </button>
            <button
              className="primary-button"
              onClick={() => {
                const attached = notes(editingMessage)
                  .map(
                    (note) =>
                      `${note.reference.path ?? note.reference.name} · ${reviewLocation(note.reference)}\n> ${note.reference.quote}\n${edits[note.id] ?? note.text}`,
                  )
                  .join("\n\n");
                void navigator.clipboard
                  .writeText([text, attached].filter(Boolean).join("\n\n"))
                  .then(() =>
                    notify("Draft copied. Paste it into a new follow-up."),
                  )
                  .catch((error) => notify((error as Error).message));
              }}
            >
              Copy draft
            </button>
          </footer>
        </section>
      )}
      {!pending.length && (
        <div className="card-discussion-empty">
          <Clock3 size={22} />
          <strong>The queue is clear.</strong>
          <p>
            Send a follow-up while the worker is busy. It will continue
            automatically when ready.
          </p>
        </div>
      )}
      <div className="followup-queue-list">
        {pending.map((message, index) => {
          const attached = notes(message),
            // Sent to a worker on another computer: it stands as that computer says.
            locked = !!message.pickedUpAt || !!message.deliveryLine;
          return (
            <article
              className="followup-queue-item"
              key={message.id}
              data-queue-id={message.id}
            >
              <header>
                <span className="queue-position">{index + 1}</span>
                <strong>
                  {message.deliveryLine
                    ? message.deliveryLine
                    : locked
                      ? "Picked up"
                      : message.followupState === "paused"
                        ? "Paused for attention"
                        : message.deliveryState === "received"
                          ? "Received on worker's device"
                          : "Queued for worker"}
                </strong>
                <Time at={message.queuedAt ?? message.at} />
                {message.actor && (
                  <span className="message-origin">
                    {message.actor.name} · {message.actor.device}
                  </span>
                )}
                {!locked &&
                  (!message.actor ||
                    !memberId ||
                    message.actor.memberId === memberId) &&
                  editing !== message.id && (
                    <div className="queue-actions">
                      <button
                        onClick={() => {
                          setEditing(message.id);
                          setText(message.reviewText ?? message.text);
                          setEdits(
                            Object.fromEntries(
                              attached.map((note) => [note.id, note.text]),
                            ),
                          );
                        }}
                        aria-label={"Edit queued follow-up " + (index + 1)}
                      >
                        <Pencil size={12} />
                        Edit
                      </button>
                      <button
                        onClick={() => void cancel(message)}
                        disabled={busy}
                        aria-label={"Cancel queued follow-up " + (index + 1)}
                      >
                        <X size={12} />
                        Cancel
                      </button>
                    </div>
                  )}
              </header>
              {editing === message.id && !locked ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(message);
                  }}
                >
                  <label>
                    Follow-up
                    <textarea
                      aria-label="Edit follow-up text"
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                      autoFocus
                    />
                  </label>
                  {attached.map((note, i) => (
                    <label key={note.id}>
                      <span>
                        {note.reference.name} · {reviewLocation(note.reference)}
                      </span>
                      <blockquote>{note.reference.quote}</blockquote>
                      <textarea
                        aria-label={"Edit attached review note " + (i + 1)}
                        value={edits[note.id] ?? note.text}
                        onChange={(event) =>
                          setEdits((values) => ({
                            ...values,
                            [note.id]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  ))}
                  <footer>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setEditing(undefined)}
                      disabled={busy}
                    >
                      Discard edits
                    </button>
                    <button
                      className="primary-button"
                      disabled={
                        busy ||
                        !text.trim() ||
                        Object.values(edits).some((text) => !text.trim())
                      }
                    >
                      <Check size={12} />
                      Save changes
                    </button>
                  </footer>
                </form>
              ) : (
                <>
                  <p className="queued-message-text">
                    {message.reviewText ?? message.text}
                  </p>
                  {attached.map((note) => (
                    <div className="queued-review-note" key={note.id}>
                      <strong>{note.reference.name}</strong>
                      <small>{reviewLocation(note.reference)}</small>
                      <blockquote>{note.reference.quote}</blockquote>
                      <p>{note.text}</p>
                    </div>
                  ))}
                </>
              )}
              {locked && (
                <small className="queue-note">
                  The next brief is being prepared. Send another follow-up for
                  further changes.
                </small>
              )}
              {message.followupState === "paused" && !locked && (
                <small className="queue-note">
                  {message.deliveryError ??
                    "The worker needs attention. Your request is preserved; resolve the issue before continuing."}
                </small>
              )}
            </article>
          );
        })}
      </div>
      {!!history.length && (
        <details className="followup-queue-history">
          <summary>
            <ChevronDown size={13} />
            Recent follow-ups <span>{history.length}</span>
          </summary>
          {history.map((message) => (
            <article key={message.id}>
              <header>
                <strong>
                  {message.followupState === "cancelled"
                    ? "Cancelled"
                    : "Picked up by worker"}
                </strong>
                <Time at={message.promptedAt ?? message.at} />
              </header>
              <p>{message.reviewText ?? message.text}</p>
            </article>
          ))}
        </details>
      )}
    </section>
  );
}
