import { dateLabel } from "./planning/dates";
import type { SharedBoardStatus } from "./sharing";

/** How the board of a connected project stands, in words for the person. */
export interface BoardStanding {
  line: string;
  tone: "fine" | "working" | "trouble";
  /** Things worth knowing that stop nothing. */
  notes: string[];
  /** The person has to say whether both boards are kept. */
  asksToKeepBoth: boolean;
}

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
      asksToKeepBoth: false,
    };
  const standing = (
    line: string,
    tone: BoardStanding["tone"],
    more: string[] = [],
  ): BoardStanding => ({
    line,
    tone,
    notes: [...more, ...notesOf(status)],
    asksToKeepBoth: status.state === "choose",
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
    case "choose": {
      const { shared = 0, added = 0 } = status.choice ?? {};
      return standing(
        `${names.shared} already has ${some(shared, "task")}, and ${names.local} has ${added} of its own. Keeping both adds them to ${names.shared}. Nothing is replaced.`,
        "working",
      );
    }
    default:
      return standing(
        status.detail ?? "The board is not syncing right now.",
        "trouble",
      );
  }
}
