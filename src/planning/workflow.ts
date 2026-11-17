import type { AppState, Project, Stage, WorkItem } from "../shared";
import type { WorkflowState, ViewConfig } from "./types";
import { reviewWorkflowStates } from "../code-review-workflow";
export function defaultWorkflow(projectId: string): WorkflowState[] {
  return reviewWorkflowStates(projectId);
}
export function workflowFor(
  state: AppState,
  projectId: string,
): WorkflowState[] {
  const states = state.workflowStates.filter(
    (status) => status.projectId === projectId,
  );
  return (states.length ? states : defaultWorkflow(projectId)).sort(
    (a, b) => a.order - b.order,
  );
}
export function taskStatus(
  task: WorkItem,
  states: WorkflowState[],
): WorkflowState {
  return (
    states.find(
      (status) => status.id === task.statusId && status.stage === task.stage,
    ) ??
    states.find(
      (status) =>
        status.stage === task.stage && status.id === `${task.projectId}:review`,
    ) ??
    states.find((status) => status.stage === task.stage)!
  );
}
export function filterWork(tasks: WorkItem[], config: ViewConfig): WorkItem[] {
  const f = config.filters,
    q = f.query.toLowerCase().trim();
  const filtered = tasks.filter(
    (task) =>
      !!task.archivedAt === f.archived &&
      (f.priority === "all" || task.priority === f.priority) &&
      (f.epicId === "all" || task.epicId === f.epicId) &&
      (f.cycleId === "all" ||
        (f.cycleId === "none" ? !task.cycleId : task.cycleId === f.cycleId)) &&
      (f.label === "all" || task.labels?.includes(f.label)) &&
      (f.kind === "all" || task.kind === f.kind) &&
      (f.harness === "all" || task.harness === f.harness) &&
      (!q ||
        `${task.identifier} ${task.title} ${task.description} ${(task.labels ?? []).join(" ")}`
          .toLowerCase()
          .includes(q)),
  );
  return filtered.sort((a, b) =>
    config.sortBy === "priority"
      ? ["high", "medium", "low"].indexOf(a.priority) -
        ["high", "medium", "low"].indexOf(b.priority)
      : config.sortBy === "estimate"
        ? (b.estimate ?? -1) - (a.estimate ?? -1)
        : config.sortBy === "due"
          ? (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999")
          : config.sortBy === "created"
            ? b.createdAt.localeCompare(a.createdAt)
            : b.updatedAt.localeCompare(a.updatedAt),
  );
}
export function validateHierarchy(
  tasks: WorkItem[],
  owner: WorkItem,
  parentId: string | null | undefined,
): void {
  let id = parentId;
  const seen = new Set([owner.id]);
  while (id) {
    if (seen.has(id)) throw new Error("A story cannot be its own ancestor.");
    seen.add(id);
    const parent = tasks.find(
      (task) => task.id === id && task.projectId === owner.projectId,
    );
    if (!parent) throw new Error("Choose a parent story from this project.");
    id = parent.parentId;
  }
}
