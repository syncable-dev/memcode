import { useState } from "react";
import { LoaderCircle, MessageSquare } from "lucide-react";
import type { SharedAsk } from "../sharing";
import { Time } from "./UI";

/** Who wants what of a worker run here, in one line. */
export const askLine = (ask: SharedAsk) =>
  ask.kind === "answer"
    ? `${ask.from} on ${ask.device} answered the worker`
    : `${ask.from} on ${ask.device} wants to continue this worker`;

/**
 * Messages someone else sent to a worker run on this computer. Nothing runs
 * until this computer's person allows one (MemSync ADR-0006).
 */
export function WorkerAsks({
  taskId,
  asks,
  act,
}: {
  taskId: string;
  asks: SharedAsk[];
  act(action: () => Promise<unknown>): Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const decide = (ask: SharedAsk, allow: boolean) =>
    void act(async () => {
      setBusy(ask.id);
      try {
        await window.memcode.decideSharedMessage({
          taskId,
          messageId: ask.id,
          allow,
        });
      } finally {
        setBusy("");
      }
    });
  return (
    <div className="worker-asks">
      {asks.map((ask) => (
        <section
          key={ask.id}
          className="worker-ask"
          aria-label={askLine(ask)}
          data-ask-id={ask.id}
        >
          <header>
            <MessageSquare size={14} aria-hidden="true" />
            <strong>{askLine(ask)}</strong>
            <Time at={ask.sentAt} />
          </header>
          <blockquote>{ask.text}</blockquote>
          <footer>
            <span>Nothing runs until you allow it.</span>
            <div>
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => decide(ask, false)}
              >
                Decline
              </button>
              <button
                className="button primary"
                disabled={!!busy}
                onClick={() => decide(ask, true)}
              >
                {busy === ask.id && <LoaderCircle className="spin" size={13} />}
                Allow
              </button>
            </div>
          </footer>
        </section>
      ))}
    </div>
  );
}
