import { lazy, Suspense } from "react";
import type { SharedSummary, TeamSession } from "../team-session";
import { runElsewhereStanding } from "../sharing-cards";
import { Time } from "./UI";

const MessageMarkdown = lazy(() => import("./MessageMarkdown"));

/**
 * Someone else's worker on a card, in place of its conversation, which only its owner
 * reads (MemSync ADR-0019): the request, the summary of each round of work, and how
 * it stands now.
 */
export function OthersRun({
  owner,
  request,
  session,
  onOpenLink,
}: {
  owner: { name: string; device: string };
  /** What the card asks for: its description, or its title when it has none. */
  request: string;
  session: TeamSession;
  onOpenLink(href: string): void;
}) {
  const standing = runElsewhereStanding(owner, session);
  return (
    <>
      <article className="message-block user shared-request">
        <header>
          <strong>Request</strong>
        </header>
        <div className="message-body">
          <Suspense fallback={request}>
            <MessageMarkdown text={request} onOpenLink={onOpenLink} />
          </Suspense>
        </div>
      </article>
      {session.summaries?.map((summary) => (
        <RoundSummary
          key={summary.at}
          summary={summary}
          onOpenLink={onOpenLink}
        />
      ))}
      {standing && (
        <p className="shared-run-standing" role="status">
          {standing}
        </p>
      )}
    </>
  );
}

function RoundSummary({
  summary,
  onOpenLink,
}: {
  summary: SharedSummary;
  onOpenLink(href: string): void;
}) {
  return (
    <section className="shared-run-summary" aria-label="Summary of the work">
      <div className="eyebrow">
        <span />
        SUMMARY
      </div>
      <p className="shared-run-summary-by">
        {summary.by} · {summary.device} · <Time at={summary.at} />
      </p>
      <Suspense fallback={summary.text}>
        <MessageMarkdown text={summary.text} onOpenLink={onOpenLink} />
      </Suspense>
    </section>
  );
}
