import type { AppState, TaskPatch, WorkItem } from "../shared";
import type { WorkflowState, ViewConfig } from "./types";
import { reviewWorkflowStates } from "../code-review-workflow";
export const backlogStatusId = (projectId: string) => `${projectId}:backlog`;
export const isBacklogStatus = (id: string) => id.endsWith(":backlog");
// Legacy saves use the default Planned ID even for unscheduled ideas. Record
// deliberate planning outside a cycle without rewriting those stories' history.
export const plannedOutsideCycleId = (projectId: string) => `${projectId}:planned-without-cycle`;
function withBacklog(projectId: string, states: WorkflowState[]): WorkflowState[] {
  const backlog = states.find((state) => state.id === backlogStatusId(projectId)) ??
    { id: backlogStatusId(projectId), projectId, name: "Backlog", stage: "planned" as const, color: "#98a59d", order: 0 };
  return [backlog, ...states.filter((state) => state.id !== backlog.id).sort((a, b) => a.order - b.order)];
}
export function defaultWorkflow(projectId: string): WorkflowState[] {
  return withBacklog(projectId, reviewWorkflowStates(projectId));
}
export function workflowFor(
  state: AppState,
  projectId: string,
): WorkflowState[] {
  const states = state.workflowStates.filter(
    (status) => status.projectId === projectId,
  );
  return states.length ? withBacklog(projectId, states) : defaultWorkflow(projectId);
}
export function taskStatus(
  task: WorkItem,
  states: WorkflowState[],
): WorkflowState {
  if (task.stage === "planned") {
    const backlog = states.find((status) => status.id === backlogStatusId(task.projectId));
    const planned = states.filter((status) => status.stage === "planned" && !isBacklogStatus(status.id));
    const standard = planned.find((status) => status.id === `${task.projectId}:planned`);
    const selected = planned.find((status) => status.id === task.statusId);
    if (selected && selected !== standard) return selected;
    if (backlog && !task.cycleId && task.statusId !== plannedOutsideCycleId(task.projectId)) return backlog;
    if (standard || planned.length) return standard ?? planned[0];
  }
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

export function storedTaskStatus(task: WorkItem, states: WorkflowState[], intent: TaskPatch): string {
  if (task.stage === "planned" && !task.cycleId) {
    if (intent.statusId === `${task.projectId}:planned` || (!intent.statusId && task.statusId === plannedOutsideCycleId(task.projectId)))
      return plannedOutsideCycleId(task.projectId);
  }
  return taskStatus(task, states).id;
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
