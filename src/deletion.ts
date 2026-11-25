import { z } from "zod";
import type { ProjectSharing } from "./sharing";

const id = z.string().trim().min(1).max(250);
export const deleteStorySchema = z
  .object({ id, cascade: z.boolean().optional().default(false) })
  .strict();
export const deleteEntitySchema = z.object({ id }).strict();
export type DeleteStoryInput = z.input<typeof deleteStorySchema>;
export interface DeletionResult {
  deletedIds: string[];
  reassignedStoryIds: string[];
}

/** A list of names as a sentence says it: "Anna", "Anna and Bo", "Anna, Bo and Cy". */
function namesTogether(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What deleting a project removes, who else it reaches, and what stays. */
export function projectDeletionNote(
  project: { name: string; path?: string | null; example?: boolean },
  sharing: ProjectSharing,
  /** The project is not shared and has an Inbox of its own on the sharing service. */
  hasInbox = false,
): string {
  if (project.example)
    return "This removes the example project and its sample tasks from MemCode.";
  const contents = `its board, tasks, goals, cycles, conversations and reviews${hasInbox ? ", and its Inbox with every report from Slack" : ""}.`;
  const folder = project.path
    ? ` The folder ${project.path} and everything in it stay on your computer.`
    : "";
  const kept = contents + folder;
  switch (sharing.kind) {
    case "connected": {
      const { shared } = sharing;
      if (!shared.youAreOwner)
        return `You leave ${project.name}, and ${shared.owner.name} and the others keep it. This removes from MemCode here ${kept}`;
      const others = shared.guests.filter((guest) => !guest.isYou).map((guest) => guest.name);
      const reach = others.length
        ? `${namesTogether(others)} ${others.length === 1 ? "loses" : "lose"} it too, on all their computers.`
        : "Nobody else has joined it yet, and its open invitations end.";
      return `This deletes ${project.name} for everyone: ${reach} It removes ${kept}`;
    }
    case "team":
      return `MemCode leaves ${project.name}'s Team Sync team first, and your teammates keep it. Then this removes from MemCode ${kept}`;
    case "remembered":
      return `${project.name} is shared, and Sharing can't be reached right now. Deleting it needs Sharing, to delete it for everyone or take you off it. Try again when you're online.`;
    default:
      return `This removes ${project.name} from MemCode: ${kept}`;
  }
}

/** The confirmation's heading line, its subtitle and its button, and whether it can go ahead now. */
export function projectDeletionLabels(sharing: ProjectSharing): {
  kicker: string;
  description: string;
  confirm: string;
  canConfirm: boolean;
} {
  const removing = { kicker: "REMOVE FROM MEMCODE", confirm: "Delete project", canConfirm: true };
  switch (sharing.kind) {
    case "connected": {
      const { shared } = sharing;
      if (!shared.youAreOwner)
        return { ...removing, kicker: "LEAVE AND REMOVE", description: `Shared by ${shared.owner.name}`, confirm: "Leave and delete" };
      const others = shared.guests.filter((guest) => !guest.isYou).map((guest) => guest.name);
      return {
        ...removing,
        kicker: "DELETE FOR EVERYONE",
        description: others.length ? `Shared with ${namesTogether(others)}` : "Shared by you",
        confirm: "Delete for everyone",
      };
    }
    case "team":
      return { ...removing, description: "Team Sync project", confirm: "Leave team and delete" };
    case "example":
      return { ...removing, description: "Example project" };
    case "free":
      return { ...removing, description: "Personal project" };
    case "gone":
      return { ...removing, description: "No longer shared with you" };
    case "elsewhere":
      return { ...removing, description: "Shared under another account" };
    case "remembered":
      // Deleting needs the sharing service: it decides between everyone and only you.
      return { ...removing, description: "Shared project", canConfirm: false };
  }
}
