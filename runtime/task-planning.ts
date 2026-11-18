import { z } from "zod";
import type { AppState, TaskPatch, WorkItem } from "../src/shared";
import { isActive, canMoveTask, validateDependencies } from "../src/domain";
import {
  backlogStatusId,
  storedTaskStatus,
  workflowFor,
  validateHierarchy,
} from "../src/planning/workflow";
import { validDay } from "../src/planning/dates";

const id = z.string().min(1).max(200),
  date = z.string().refine(validDay, "Use a real YYYY-MM-DD date.").nullable();
export const taskPlanningShape = {
  cycleId: id.nullable().optional(),
  estimate: z.number().finite().min(0).max(1000).nullable().optional(),
  startDate: date.optional(),
  dueDate: date.optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  parentId: id.nullable().optional(),
  relatedIds: z.array(id).max(100).optional(),
  duplicateOf: id.nullable().optional(),
  statusId: id.optional(),
  archivedAt: z.string().datetime().nullable().optional(),
  customFields: z
    .record(
      z.string(),
      z.union([z.string().max(5000), z.number().finite(), z.null()]),
    )
    .optional(),
};

export function applyTaskPatch(
  state: AppState,
  item: WorkItem,
  input: TaskPatch,
  at = new Date().toISOString(),
): void {
  const patch = { ...input };
  const statuses = workflowFor(state, item.projectId);
  if (patch.cycleId === null && item.cycleId && !patch.statusId && (patch.stage ?? item.stage) === "planned")
    patch.statusId = backlogStatusId(item.projectId);
  if (patch.statusId) {
    const status = statuses.find((status) => status.id === patch.statusId);
    if (!status) throw new Error("Choose a workflow state from this project.");
    if (patch.stage && patch.stage !== status.stage)
      throw new Error("Workflow state and stage must agree.");
    patch.stage = status.stage;
    if (status.id === backlogStatusId(item.projectId)) {
      if (patch.cycleId)
        throw Error("Move this story to Planned to assign it to a cycle.");
      patch.cycleId = null;
    }
  }
  if (patch.stage && !canMoveTask(item, patch.stage))
    throw new Error(
      "Stop or finish the active worker before moving this work item.",
    );
  if (patch.stage === "done") {
    if (
      state.fleetConflicts.some(
        (conflict) =>
          conflict.status === "open" &&
          conflict.projectId === item.projectId &&
          (conflict.epicId === item.epicId ||
            conflict.taskIds.includes(item.id)),
      )
    )
      throw new Error(
        "Resolve the Fleet decision before accepting this story.",
      );
    if (
      state.tasks.some(
        (task) =>
          task.parentId === item.id &&
          !task.archivedAt &&
          task.stage !== "done",
      )
    )
      throw new Error(
        "Complete the child stories before accepting their parent.",
      );
  }
  if (
    isActive(item) &&
    (patch.harness ||
      patch.assignment ||
      patch.modelOverride !== undefined ||
      patch.scope ||
      patch.kind ||
      patch.epicId !== undefined ||
      patch.cycleId !== undefined ||
      patch.archivedAt)
  )
    throw new Error(
      "Stop the active worker before changing its execution scope, epic, cycle or archive state.",
    );
  if (patch.dependsOn) validateDependencies(state.tasks, item, patch.dependsOn);
  if (
    patch.epicId &&
    !state.epics.some(
      (epic) => epic.id === patch.epicId && epic.projectId === item.projectId,
    )
  )
    throw new Error("Choose an epic from this project.");
  if (patch.cycleId) {
    const cycle = state.cycles.find(
      (cycle) =>
        cycle.id === patch.cycleId && cycle.projectId === item.projectId,
    );
    if (!cycle || (cycle.state === "completed" && item.cycleId !== cycle.id))
      throw new Error("Choose an unfinished cycle from this project.");
  }
  if (patch.parentId !== undefined)
    validateHierarchy(state.tasks, item, patch.parentId);
  const nextParentId =
    patch.parentId === undefined ? item.parentId : patch.parentId;
  if (
    (patch.parentId !== undefined || patch.stage !== undefined) &&
    nextParentId &&
    (patch.stage ?? item.stage) !== "done" &&
    !(patch.archivedAt === undefined ? item.archivedAt : patch.archivedAt)
  ) {
    const parent = state.tasks.find((task) => task.id === nextParentId);
    if (parent?.stage === "done")
      throw new Error(
        "Reopen the parent story before adding unfinished child work.",
      );
  }
  for (const target of [
    ...(patch.relatedIds ?? []),
    ...(patch.duplicateOf ? [patch.duplicateOf] : []),
  ]) {
    if (
      target === item.id ||
      !state.tasks.some(
        (task) => task.id === target && task.projectId === item.projectId,
      )
    )
      throw new Error(
        "Issue relationships must reference another story in this project.",
      );
  }
  const start =
      patch.startDate === undefined ? item.startDate : patch.startDate,
    due = patch.dueDate === undefined ? item.dueDate : patch.dueDate;
  if (start && due && start > due)
    throw new Error("The start date must be on or before the due date.");
  if (patch.customFields)
    for (const [id, value] of Object.entries(patch.customFields)) {
      if (item.customFields?.[id] === value) continue;
      const field = state.customFields.find(
        (field) => field.id === id && field.projectId === item.projectId,
      );
      if (!field) throw new Error("Custom field not found in this project.");
      if (value === null) continue;
      if (
        (field.type === "number" && typeof value !== "number") ||
        (field.type !== "number" && typeof value !== "string") ||
        (field.type === "select" && !field.options.includes(String(value)))
      )
        throw new Error(`Invalid value for ${field.name}.`);
    }
  if (patch.labels)
    patch.labels = [
      ...new Set(patch.labels.map((label) => label.trim()).filter(Boolean)),
    ];
  if (
    patch.assignment ||
    patch.harness ||
    patch.modelOverride !== undefined ||
    patch.scope ||
    patch.kind
  )
    item.route = undefined;
  Object.assign(item, patch, { updatedAt: at });
  item.statusId = storedTaskStatus(item, statuses, patch);
}
