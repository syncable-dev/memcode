import type { Message } from "./shared";

export const conversationPageSize = 40;
export const initialConversationSize = 60;

export function toolMessageParts(text: string, expanded: boolean) {
  const newline = text.indexOf("\n");
  return {
    summary: (newline < 0 ? text : text.slice(0, newline)).slice(0, 100),
    body: expanded
      ? (newline < 0 ? text : text.slice(newline + 1)) || text
      : undefined,
  };
}

/** Compare rendered fields, including snapshots received as fresh JSON objects. */
export function sameDisplayedMessage(a: Message, b: Message) {
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.text === b.text &&
    a.at === b.at &&
    a.followupState === b.followupState &&
    a.pickedUpAt === b.pickedUpAt &&
    a.reviewText === b.reviewText &&
    JSON.stringify(a.actor) === JSON.stringify(b.actor) &&
    JSON.stringify(a.commentIds) === JSON.stringify(b.commentIds) &&
    JSON.stringify(a.references) === JSON.stringify(b.references)
  );
}

export function followsConversationTail(viewport: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}) {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 64
  );
}
