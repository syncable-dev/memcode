import { z } from "zod";

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

/** What deleting a project removes, and what stays, as its confirmation says it. */
export function projectDeletionNote(
  project: { name: string; path?: string | null; example?: boolean },
  shared: boolean,
): string {
  if (project.example)
    return "This removes the example project and its sample tasks from MemCode.";
  const removed = `This removes ${project.name} from MemCode: its board, tasks, goals, cycles, conversations and reviews.`;
  const folder = project.path
    ? ` The folder ${project.path} and everything in it stay on your computer.`
    : "";
  const others = shared
    ? " It stays shared for everyone else, and you can open it again from this menu. To delete it for everyone, go to memtrace.io."
    : "";
  return removed + folder + others;
}
