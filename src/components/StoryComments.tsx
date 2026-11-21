import { lazy, Suspense, useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  MessageSquare,
  Pencil,
  Reply,
  Trash2,
  X,
} from "lucide-react";
import type { StoryAuthor, StoryComment } from "../story-comments";
import { loadCardDraft, saveCardDraft } from "../card-drafts";
import { Time } from "./UI";
const Markdown = lazy(() => import("./MessageMarkdown"));
export function StoryComments({
  taskId,
  comments,
  notify,
  onFollowup,
  onOpenLink,
}: {
  taskId: string;
  comments: StoryComment[];
  notify: (text: string) => void;
  onFollowup?: (text: string) => void;
  onOpenLink: (href: string) => void;
}) {
  const draftKey = "memcode-story-comment:" + taskId;
  const [draft, setDraft] = useState(() => {
      const stored = loadCardDraft(draftKey);
      return typeof stored === "string" ? stored : "";
    }),
    [reply, setReply] = useState<StoryComment>(),
    [editing, setEditing] = useState<string>(),
    [edit, setEdit] = useState(""),
    [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<StoryAuthor>();
  useEffect(
    () => saveCardDraft(draftKey, draft || undefined),
    [draftKey, draft],
  );
  useEffect(() => {
    let active = true;
    void window.memcode
      .storyCommentIdentity()
      .then((value) => {
        if (active) setIdentity(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [comments]);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const render = (comment: StoryComment) => (
    <article
      key={comment.id}
      className={"story-comment " + (comment.parentId ? "reply" : "")}
      data-story-comment-id={comment.id}
    >
      <header>
        <span className="story-comment-avatar">
          {comment.author.name.slice(0, 1).toUpperCase()}
        </span>
        <strong>{comment.author.name}</strong>
        <Time at={comment.createdAt} />
        {comment.updatedAt !== comment.createdAt && !comment.deletedAt && (
          <small>edited</small>
        )}
        {!comment.deletedAt &&
          identity?.id === comment.author.id &&
          identity.source === comment.author.source && (
            <div className="story-comment-actions">
              <button
                aria-label="Edit task comment"
                title="Edit comment"
                onClick={() => {
                  setEditing(comment.id);
                  setEdit(comment.text);
                }}
              >
                <Pencil size={12} />
              </button>
              <button
                aria-label="Delete task comment"
                title="Delete comment"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    window.memcode.deleteStoryComment(taskId, comment.id),
                  )
                }
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}
      </header>
      {comment.deletedAt ? (
        <p className="story-comment-deleted">Comment deleted.</p>
      ) : editing === comment.id ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await window.memcode.editStoryComment(taskId, comment.id, edit);
              setEditing(undefined);
            });
          }}
        >
          <textarea
            aria-label="Edit task comment text"
            value={edit}
            onChange={(event) => setEdit(event.target.value)}
            autoFocus
          />
          <footer>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setEditing(undefined)}
            >
              Cancel
            </button>
            <button className="primary-button" disabled={busy || !edit.trim()}>
              <Check size={12} />
              Save
            </button>
          </footer>
        </form>
      ) : (
        <>
          <Suspense fallback={<p>{comment.text}</p>}>
            <Markdown text={comment.text} onOpenLink={onOpenLink} />
          </Suspense>
          <footer>
            {!comment.parentId && (
              <button
                onClick={() => {
                  setReply(comment);
                  document
                    .querySelector<HTMLTextAreaElement>(
                      'textarea[aria-label="Task comment"]',
                    )
                    ?.focus();
                }}
              >
                <Reply size={12} />
                Reply
              </button>
            )}
            {onFollowup && <button
              onClick={() =>
                onFollowup(
                  "Please consider this task comment from " +
                    comment.author.name +
                    ":\n\n" +
                    comment.text
                      .split("\n")
                      .map((line) => "> " + line)
                      .join("\n"),
                )
              }
            >
              <ArrowUpRight size={12} />
              Use in follow-up
            </button>}
          </footer>
        </>
      )}
    </article>
  );
  return (
    <section className="story-comments-view" aria-label="Task discussion">
      <header>
        <span className="eyebrow">
          <span />
          DISCUSS THE TASK
        </span>
        <h3>A place for the conversation around the work.</h3>
        <p>
          Comments stay with this task. They do not prompt or start a worker.
        </p>
      </header>
      <div className="story-comments-list">
        {!comments.length && (
          <div className="card-discussion-empty">
            <MessageSquare size={22} />
            <strong>Start the discussion.</strong>
            <p>Leave a decision, question or update for this task.</p>
          </div>
        )}
        {comments
          .filter((comment) => !comment.parentId)
          .map((comment) => (
            <div className="story-comment-thread" key={comment.id}>
              {render(comment)}
              {comments
                .filter((reply) => reply.parentId === comment.id)
                .map(render)}
            </div>
          ))}
      </div>
      <form
        className="story-comment-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await window.memcode.addStoryComment(taskId, draft, reply?.id);
            setDraft("");
            setReply(undefined);
          });
        }}
      >
        {reply && (
          <div className="story-comment-replying">
            Replying to {reply.author.name}
            <button
              type="button"
              aria-label="Cancel reply"
              onClick={() => setReply(undefined)}
            >
              <X size={12} />
            </button>
          </div>
        )}
        <textarea
          aria-label="Task comment"
          placeholder="Add a comment, decision or question…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <footer>
          <small>Markdown supported · Discussion only</small>
          <button className="primary-button" disabled={busy || !draft.trim()}>
            {reply ? "Post reply" : "Post comment"}
          </button>
        </footer>
      </form>
    </section>
  );
}
