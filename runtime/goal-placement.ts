import { z } from "zod";
import type { AppState, WorkItem } from "../src/shared";
import type { WorkerChanges } from "../src/changes";
import { isQuickChanges } from "../src/domain";
import type { GoalMatch, Placement } from "../src/goal-plan";
import { goalFiles } from "./goal-updates";

type Register = (
  method: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;

export interface PlacementDependencies {
  state: () => AppState;
  readChanges: (task: WorkItem) => Promise<WorkerChanges>;
  /** Repo-relative files Memtrace finds for a request; may fail when offline. */
  relatedFiles: (projectId: string, request: string) => Promise<string[]>;
}

export function registerGoalPlacement(
  register: Register,
  placement: GoalPlacement,
) {
  register(
    "goal:place",
    z
      .object({
        projectId: z.string().min(1).max(200),
        request: z.string().trim().min(1).max(20_000),
      })
      .strict(),
    (input) => placement.place(input.projectId, input.request),
  );
}

/** Where new work belongs: the open goals already changing the code it touches. */
export class GoalPlacement {
  constructor(private deps: PlacementDependencies) {}

  async place(projectId: string, request: string): Promise<Placement> {
    const files = await this.deps
      .relatedFiles(projectId, request)
      .catch(() => [] as string[]);
    if (!files.length) return { files: [], goals: [] };
    const wanted = new Set(files);
    const state = this.deps.state();
    const goals: GoalMatch[] = [];
    for (const epic of state.epics) {
      if (epic.projectId !== projectId || epic.closedAt || isQuickChanges(epic))
        continue;
      const shared = [
        ...(await goalFiles(state, epic.id, this.deps.readChanges, epic)),
      ]
        .filter((file) => wanted.has(file))
        .sort();
      if (shared.length)
        goals.push({ epicId: epic.id, title: epic.title, shared });
    }
    goals.sort((a, b) => b.shared.length - a.shared.length);
    return { files, goals };
  }
}
