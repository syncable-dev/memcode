import { dateLabel } from "./planning/dates";
import type { SharedBoardStatus } from "./sharing";

/** How the board of a connected project stands, in words for the person. */
export interface BoardStanding {
  line: string;
  tone: "fine" | "working" | "trouble";
  /** Things worth knowing that stop nothing. */
  notes: string[];
}

/**
 * Why a project with work of its own is not connected to a shared project that
 * already has a board. Alex's rule: you share your own project, or you join
 * someone else's and get their board. Nothing is ever merged.
 */
export const twoBoards = (names: { local: string; shared: string }) =>
  `${names.local} already has work of its own, so it cannot join ${names.shared}: connect a project that has none yet.`;

const some = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function notesOf(status: SharedBoardStatus): string[] {
  const notes = status.leftOut.map(
    ({ by, on, count }) =>
      `${some(count, "change")} from ${by} on ${dateLabel(on, {
        day: "numeric",
        month: "long",
      })} could not be read and ${count === 1 ? "was" : "were"} left out.`,
  );
  if (status.setAside)
    notes.push("Some changes are set aside until one they build on arrives.");
  if (status.tooLarge)
    notes.push(
      `${some(status.tooLarge, "value")} ${
        status.tooLarge === 1 ? "is" : "are"
      } too large for the sharing service and ${
        status.tooLarge === 1 ? "stays" : "stay"
      } on this computer.`,
    );
  return notes;
}

/**
 * `status` is missing between connecting and the first word from board sync.
 * `names` are the local project and the shared one, for the question.
 */
export function boardStanding(
  status: SharedBoardStatus | undefined,
  names: { local: string; shared: string },
): BoardStanding {
  if (!status)
    return {
      line: "Getting the board ready to sync…",
      tone: "working",
      notes: [],
    };
  const standing = (
    line: string,
    tone: BoardStanding["tone"],
    more: string[] = [],
  ): BoardStanding => ({
    line,
    tone,
    notes: [...more, ...notesOf(status)],
  });
  const { waiting } = status;
  switch (status.state) {
    case "starting":
      return standing("Reading the shared board…", "working");
    case "synced":
      return standing("The board is in sync.", "fine");
    case "sending":
      return standing(
        `Sending ${some(waiting, "change")} to the shared board…`,
        "working",
      );
    case "offline":
      return standing(
        status.detail ?? "The sharing service cannot be reached right now.",
        "trouble",
        waiting
          ? [
              `${some(waiting, "change")} made here ${
                waiting === 1 ? "is" : "are"
              } kept on this computer and sent when it works again.`,
            ]
          : [],
      );
    case "apart":
      return standing(twoBoards(names), "trouble");
    default:
      return standing(
        status.detail ?? "The board is not syncing right now.",
        "trouble",
      );
  }
}
