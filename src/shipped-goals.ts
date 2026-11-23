import type { Epic } from "./shared";

/** One line per shipped goal whose checkout MemCode had to keep, saying why. */
export function keptCheckoutNotes(
  goals: Pick<Epic, "title" | "closedAt" | "checkoutKept">[],
): string[] {
  return goals
    .filter((goal) => goal.closedAt && goal.checkoutKept)
    .map((goal) => `“${goal.title}” keeps its checkout. ${goal.checkoutKept}`);
}
