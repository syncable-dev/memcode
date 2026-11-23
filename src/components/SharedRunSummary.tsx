import { lazy, Suspense } from "react";
import type { TeamSession } from "../team-session";
import { runElsewhereStanding } from "../sharing-cards";
import { Time } from "./UI";

const MessageMarkdown = lazy(() => import("./MessageMarkdown"));

/**
 * Someone else's run on a card, in place of its conversation, which only its owner
 * reads: how it stands, then the summary its worker ended with.
 */
export function SharedRunSummary({
  owner,
  session,
  onOpenLink,
}: {
  owner: { name: string; device: string };
  session: TeamSession;
  onOpenLink(href: string): void;
}) {
  const standing = runElsewhereStanding(owner, session);
  if (standing)
    return (
      <p className="shared-run-standing" role="status">
        {standing}
      </p>
    );
  const { text, at } = session.summary!;
  return (
    <section className="shared-run-summary" aria-label="Summary of the work">
      <div className="eyebrow">
        <span />
        SUMMARY
      </div>
      <p className="shared-run-summary-by">
        {owner.name} · {owner.device} · <Time at={at} />
      </p>
      <Suspense fallback={text}>
        <MessageMarkdown text={text} onOpenLink={onOpenLink} />
      </Suspense>
    </section>
  );
}
