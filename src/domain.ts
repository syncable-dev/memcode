import type { AppState, Stage, WorkItem } from "./shared";

export function tasksForProject(
  state: AppState,
  projectId: string,
): WorkItem[] {
  return state.tasks.filter((task) => task.projectId === projectId);
}

export function canMoveTask(task: WorkItem, stage: Stage): boolean {
  return (
    !["preparing", "running", "stopping"].includes(task.run.state) ||
    stage === task.stage
  );
}

export function progress(task: WorkItem): number {
  if (!task.checklist.length) return task.stage === "done" ? 100 : 0;
  return Math.round(
    (task.checklist.filter((item) => item.done).length /
      task.checklist.length) *
      100,
  );
}

export const quickChangesSource = "quick-changes";
const legacyDefaultSource = "project-work";

/** Small tasks without a goal share one short-lived batch that ships as one PR. */
export function isQuickChanges(epic: { sourceKey?: string }): boolean {
  return (
    epic.sourceKey === quickChangesSource ||
    epic.sourceKey === legacyDefaultSource
  );
}

/** A closed goal shipped; a goal needing an update takes no new small tasks. */
export function acceptsQuickChanges(epic: {
  closedAt?: string;
  updateNeeded?: unknown;
}): boolean {
  return !epic.closedAt && !epic.updateNeeded;
}

export function isActive(task: WorkItem): boolean {
  return (
    task.run.state === "running" ||
    task.run.state === "preparing" ||
    task.run.state === "stopping"
  );
}

export function pendingPrerequisites(
  task: WorkItem,
  tasks: readonly WorkItem[],
): Array<{ id: string; story?: WorkItem }> {
  return (task.dependsOn ?? [])
    .map((id) => ({
      id,
      story: tasks.find((item) => item.id === id && item.projectId === task.projectId),
    }))
    .filter(({ story }) => story?.stage !== "done");
}

export function validateDependencies(
  tasks: WorkItem[],
  owner: WorkItem,
  dependencies: string[],
): void {
  const seen = new Set<string>();
  const pending = [...dependencies];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === owner.id)
      throw new Error("This dependency would create a cycle between tasks.");
    if (seen.has(id)) continue;
    seen.add(id);
    const task = tasks.find(
      (t) => t.id === id && t.projectId === owner.projectId,
    );
    if (!task)
      throw new Error("Prerequisite tasks must belong to the same project.");
    pending.push(...(task.dependsOn ?? []));
  }
}

export function stageLabel(stage: Stage): string {
  return {
    planned: "Planned",
    working: "In progress",
    review: "Ready for acceptance",
    done: "Done",
  }[stage];
}

export function restartSafeState(state: AppState): AppState {
  return {
    ...state,
    workerInputs: (state.workerInputs ?? []).map((input) =>
      input.status === "pending"
        ? {
            ...input,
            status: "cancelled",
            answeredAt: new Date().toISOString(),
            response: { cancelled: true },
          }
        : input,
    ),
    projects: state.projects.map((project) =>
      ["connecting", "indexing"].includes(project.analysis)
        ? {
            ...project,
            analysis: "idle",
            analysisNote: "Analysis was interrupted. Reconnect to continue.",
          }
        : project,
    ),
    tasks: state.tasks.map((original) => {
      const task = {
        ...original,
        messages: original.messages.map((message) => {
          if (message.promptedAt || !message.pickedUpAt) return message;
          const { pickedUpAt, ...rest } = message;
          return rest;
        }),
      };
      // The worker it waited for is not running any more either.
      const waited = !!task.run.waitingOnCode;
      return !task.example && (isActive(task) || waited)
        ? {
            ...task,
            stage: "review",
            messages: task.messages.map((message) =>
              message.followupState === "queued" && !message.promptedAt
                ? { ...message, followupState: "paused" }
                : message,
            ),
            run: {
              ...task.run,
              state: "stopped",
              activity: undefined,
              waitingOnCode: undefined,
              error:
                "MemCode restarted. The goal may contain unfinished changes.",
            },
          }
        : task;
    }),
  };
}
