import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronRight, Terminal } from "lucide-react";
import { harnessNames, type Message, type WorkItem } from "../shared";
import type { ReviewComment, ReviewReference } from "../review";
import { reviewLocation } from "../review-labels";
import {
  conversationPageSize,
  initialConversationSize,
  sameDisplayedMessage,
  toolMessageParts,
} from "../conversation-performance";
import { MessageFiles } from "./Attachments";
import { HarnessMark, Time } from "./UI";

const MessageMarkdown = lazy(() => import("./MessageMarkdown"));
interface Props {
  message: Message;
  harness: WorkItem["harness"];
  comments: ReviewComment[];
  onOpenLink: (href: string) => void;
  onOpenReference: (reference: ReviewReference, id?: string) => void;
}

function ToolMessage({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const parts = useMemo(
    () => toolMessageParts(text, expanded),
    [text, expanded],
  );
  return (
    <details
      className="tool-message"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="tool-icon">
          <Terminal size={12} />
        </span>
        <span>{parts.summary}</span>
        <ChevronRight size={12} />
      </summary>
      {expanded && <pre>{parts.body}</pre>}
    </details>
  );
}

const ConversationMessage = memo(
  function ConversationMessage({
    message,
    harness,
    onOpenLink,
    comments,
    onOpenReference,
  }: Props) {
    if (message.role === "tool") return <ToolMessage text={message.text} />;
    if (message.role === "system")
      return (
        <div className="system-message">
          <span />
          <p>{message.text}</p>
        </div>
      );
    return (
      <article className={"message-block " + message.role}>
        <header>
          {message.role === "user" ? (
            <span className="message-avatar">{message.actor?.name.slice(0, 1) ?? "A"}</span>
          ) : (
            <HarnessMark id={harness} small />
          )}
          <strong>
            {message.role === "user" ? message.actor?.name ?? "You" : harnessNames[harness]}
          </strong>
          {message.actor && <span className="message-origin" title={message.actor.name + " · " + message.actor.device}>{message.actor.device}</span>}
          <Time at={message.at} />
          {message.followupState && message.followupState !== "included" && (
            <span className="message-queue-state" role="status">
              {message.deliveryLine ??
                (message.followupState === "queued"
                  ? message.pickedUpAt
                    ? "Picked up"
                    : "Queued"
                  : message.followupState === "paused"
                    ? "Queue paused"
                    : "Queue cancelled")}
            </span>
          )}
          {message.role === "assistant" && (
            <span className="message-role">WORKER</span>
          )}
        </header>
        <div className="message-body">
          {message.references?.length ? (
            <>
              <p>
                {message.reviewText ??
                  message.text.split("\n\nReference 1:")[0]}
              </p>
              {message.references.map((reference, index) => {
                const note = comments.find(
                  (c) => c.id === message.commentIds?.[index],
                );
                return (
                  <button
                    key={index}
                    className="message-review-ref"
                    onClick={() => onOpenReference(reference, note?.id)}
                  >
                    <strong>{reference.name}</strong>
                    <small>{reviewLocation(reference)}</small>
                    {note &&
                      note.text !==
                        (message.reviewText ??
                          message.text.split("\n\nReference 1:")[0]) && (
                        <p>{note.text}</p>
                      )}
                    <blockquote>{reference.quote}</blockquote>
                  </button>
                );
              })}
            </>
          ) : message.role === "assistant" ? (
            <Suspense fallback={message.text}>
              <MessageMarkdown text={message.text} onOpenLink={onOpenLink} />
            </Suspense>
          ) : (
            message.text
          )}
          {!!message.attachments?.length && (
            <MessageFiles files={message.attachments} />
          )}
        </div>
      </article>
    );
  },
  (a, b) =>
    a.harness === b.harness &&
    sameDisplayedMessage(a.message, b.message) &&
    a.comments.length === b.comments.length &&
    a.comments.every(
      (comment, index) =>
        comment.id === b.comments[index]?.id &&
        comment.text === b.comments[index]?.text,
    ) &&
    a.onOpenLink === b.onOpenLink &&
    a.onOpenReference === b.onOpenReference,
);

/** Keep live callbacks current without invalidating unchanged transcript rows. */
export function ConversationMessages({
  messages,
  harness,
  comments,
  onOpenLink,
  onOpenReference,
}: Omit<Props, "message"> & { messages: Message[] }) {
  const actions = useRef({ onOpenLink, onOpenReference });
  actions.current = { onOpenLink, onOpenReference };
  const openLink = useCallback(
    (href: string) => actions.current.onOpenLink(href),
    [],
  );
  const openReference = useCallback(
    (reference: ReviewReference, id?: string) =>
      actions.current.onOpenReference(reference, id),
    [],
  );
  const [start, setStart] = useState(() =>
    Math.max(0, messages.length - initialConversationSize),
  );
  const anchor = useRef<
    { viewport: HTMLElement; height: number; top: number } | undefined
  >(undefined);
  useLayoutEffect(() => {
    const previous = anchor.current;
    if (!previous) return;
    previous.viewport.scrollTop =
      previous.top + previous.viewport.scrollHeight - previous.height;
    anchor.current = undefined;
  }, [start]);
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  return (
    <>
      {start > 0 && (
        <button
          className="button secondary conversation-history"
          onClick={(event) => {
            const viewport = event.currentTarget.closest<HTMLElement>(
              ".conversation-scroll",
            );
            if (viewport)
              anchor.current = {
                viewport,
                height: viewport.scrollHeight,
                top: viewport.scrollTop,
              };
            setStart((value) => Math.max(0, value - conversationPageSize));
          }}
        >
          Show {Math.min(start, conversationPageSize)} earlier messages
          <span> · {start} earlier</span>
        </button>
      )}
      {messages.slice(start).map((message) => (
        <ConversationMessage
          key={message.id}
          message={message}
          harness={harness}
          onOpenLink={openLink}
          onOpenReference={openReference}
          comments={(message.commentIds ?? [])
            .map((id) => byId.get(id))
            .filter((comment): comment is ReviewComment => !!comment)}
        />
      ))}
    </>
  );
}
