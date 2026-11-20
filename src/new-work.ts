import type { Placement } from "./goal-plan";

/** Where a new request goes: an existing goal, the Quick changes batch, or a new goal. */
export type Place =
  | { kind: "goal"; epicId: string }
  | { kind: "quick" }
  | { kind: "new" };

const quickChangeLength = 120;
const quickChangeParts = 1;

/** One short line that doesn't list several things usually means one small change. */
export function looksSmall(request: string): boolean {
  const text = request.trim();
  const parts = text.split(/,|;|\band\b/i).filter((part) => part.trim()).length;
  return (
    !text.includes("\n") &&
    text.length <= quickChangeLength &&
    parts <= quickChangeParts
  );
}

/** A goal picked from its card wins; then shared code; then the request's size. */
export function suggestedPlace(
  placement: Placement,
  request: string,
  fixedEpicId?: string,
): Place {
  if (fixedEpicId) return { kind: "goal", epicId: fixedEpicId };
  const match = placement.goals[0];
  if (match) return { kind: "goal", epicId: match.epicId };
  return looksSmall(request) ? { kind: "quick" } : { kind: "new" };
}
