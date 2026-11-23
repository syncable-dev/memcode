import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AppState, WorkItem } from "../src/shared";
import { isActive } from "../src/domain";
import { backlogStatusId } from "../src/planning/workflow";
import {
  deleteEntitySchema,
  deleteStorySchema,
  type DeletionResult,
} from "../src/deletion";
import { ensureTaskEpic } from "./epic-workspace";

type Register = (
  name: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;

function requireStopped(tasks: WorkItem[]) {
  if (tasks.some(isActive))
    throw Error("Stop or finish the active workers before deleting this item.");
}

function deleteStories(
  state: AppState,
  id: string,
  cascade: boolean,
): DeletionResult {
  const task = state.tasks.find((task) => task.id === id);
  if (!task) throw Error("Task not found.");
  const ids = new Set([id]);
  for (const owner of ids) {
    const children = state.tasks.filter(
      (task) => task.parentId === owner && !ids.has(task.id),
    );
    if (children.length && !cascade)
      throw Error("This task has subtasks. Move or delete them first.");
    if (children.some((child) => child.projectId !== task.projectId))
      throw Error(
        "The task hierarchy crosses project boundaries. Repair it before deleting.",
      );
    for (const child of children) ids.add(child.id);
  }
  requireStopped(state.tasks.filter((task) => ids.has(task.id)));
  // All validation precedes mutation.
  removeStories(state, ids);
  return { deletedIds: [...ids], reassignedStoryIds: [] };
}

/**
 * Removes tasks and every record that names them. Source files, branches, output
 * files and Git history are deliberately outside this metadata-only operation.
 */
function removeStories(state: AppState, ids: Set<string>): void {
  const artifactIds = new Set(
    state.artifacts
      .filter((artifact) => ids.has(artifact.taskId))
      .map((artifact) => artifact.id),
  );
  const removedCommentIds = new Set(
    (state.reviewComments ?? [])
      .filter(
        (comment) =>
          ids.has(comment.taskId) ||
          ids.has(comment.reference.taskId) ||
          artifactIds.has(comment.reference.artifactId || ""),
      )
      .map((comment) => comment.id),
  );
  const at = new Date().toISOString();
  state.tasks = state.tasks.filter((task) => !ids.has(task.id));
  for (const other of state.tasks) {
    let changed = false;
    for (const key of ["dependsOn", "relatedIds"] as const) {
      if (other[key]?.some((id) => ids.has(id))) {
        other[key] = other[key]!.filter((id) => !ids.has(id));
        changed = true;
      }
    }
    if (other.duplicateOf && ids.has(other.duplicateOf)) {
      other.duplicateOf = null;
      changed = true;
    }
    if (other.parentId && ids.has(other.parentId)) {
      other.parentId = null;
      changed = true;
    }
    for (const message of other.messages) {
      if (
        message.references?.some(
          (ref) => ids.has(ref.taskId) || artifactIds.has(ref.artifactId || ""),
        )
      ) {
        message.references = message.references.filter(
          (ref) =>
            !ids.has(ref.taskId) && !artifactIds.has(ref.artifactId || ""),
        );
        changed = true;
      }
      if (message.commentIds?.some((id) => removedCommentIds.has(id))) {
        message.commentIds = message.commentIds.filter(
          (id) => !removedCommentIds.has(id),
        );
        changed = true;
      }
    }
    if (changed) other.updatedAt = at;
  }
  state.artifacts = state.artifacts.filter(
    (artifact) => !ids.has(artifact.taskId),
  );
  if (state.reviewComments)
    state.reviewComments = state.reviewComments.filter(
      (comment) => !removedCommentIds.has(comment.id),
    );
  if (state.storyComments)
    state.storyComments = state.storyComments.filter(
      (comment) => !ids.has(comment.taskId),
    );
  if (state.workerInputs)
    state.workerInputs = state.workerInputs.filter(
      (input) => !ids.has(input.taskId),
    );
  if (state.fleetPlans) {
    state.fleetPlans = state.fleetPlans.filter((plan) => !ids.has(plan.taskId));
    for (const plan of state.fleetPlans)
      if (plan.adoptedFrom && ids.has(plan.adoptedFrom))
        delete plan.adoptedFrom;
  }
  if (state.fleetDeclarations)
    state.fleetDeclarations = state.fleetDeclarations.filter(
      (declaration) => !ids.has(declaration.taskId),
    );
  if (state.fleetProposals)
    state.fleetProposals = state.fleetProposals.filter(
      (proposal) =>
        !ids.has(proposal.ownerTaskId) && !ids.has(proposal.proposerTaskId),
    );
  state.fleetConflicts = state.fleetConflicts.filter(
    (conflict) =>
      !conflict.taskIds.some((id) => ids.has(id)) &&
      !ids.has(conflict.winnerTaskId || ""),
  );
  state.planning.events = state.planning.events.filter(
    (event) => !ids.has(event.taskId),
  );
  for (const id of ids) delete state.planning.observations[id];
  if (state.onboarding?.storyId && ids.has(state.onboarding.storyId))
    delete state.onboarding.storyId;
}

function deleteEpic(state: AppState, id: string): DeletionResult {
  const epic = state.epics.find((epic) => epic.id === id);
  if (!epic) throw Error("Goal not found.");
  const stories = state.tasks.filter((task) => task.epicId === id);
  requireStopped(stories);
  if (stories.some((story) => story.projectId !== epic.projectId))
    throw Error(
      "The goal contains a task from another project. Repair its assignment before deleting.",
    );
  // Reuse the existing default epic where possible. If the default itself is
  // removed, its replacement receives a new identity rather than resurrecting it.
  state.epics = state.epics.filter((epic) => epic.id !== id);
  for (const story of stories) story.epicId = null;
  for (const story of stories) {
    const fallback = ensureTaskEpic(state, story);
    if (fallback.id === id) {
      fallback.id = randomUUID();
      story.epicId = fallback.id;
    }
    story.updatedAt = new Date().toISOString();
  }
  for (const view of state.savedViews)
    if (view.projectId === epic.projectId && view.filters.epicId === id)
      view.filters.epicId = "all";
  for (const conflict of state.fleetConflicts)
    if (conflict.epicId === id) delete conflict.epicId;
  if (state.onboarding?.epicId === id) delete state.onboarding.epicId;
  return {
    deletedIds: [id],
    reassignedStoryIds: stories.map((story) => story.id),
  };
}

function deleteCycle(state: AppState, id: string): DeletionResult {
  const cycle = state.cycles.find((cycle) => cycle.id === id);
  if (!cycle) throw Error("Cycle not found.");
  const stories = state.tasks.filter((task) => task.cycleId === id);
  requireStopped(stories);
  if (stories.some((story) => story.projectId !== cycle.projectId))
    throw Error(
      "The cycle contains a task from another project. Repair its assignment before deleting.",
    );
  state.cycles = state.cycles.filter((cycle) => cycle.id !== id);
  for (const story of stories) {
    story.cycleId = null;
    if (story.stage === "planned") story.statusId = backlogStatusId(story.projectId);
    story.updatedAt = new Date().toISOString();
  }
  for (const view of state.savedViews)
    if (view.projectId === cycle.projectId && view.filters.cycleId === id)
      view.filters.cycleId = "all";
  for (const event of state.planning.events) {
    if (event.before?.cycleId === id) event.before.cycleId = null;
    if (event.after.cycleId === id) event.after.cycleId = null;
  }
  for (const observation of Object.values(state.planning.observations))
    if (observation.cycleId === id) observation.cycleId = null;
  return {
    deletedIds: [id],
    reassignedStoryIds: stories.map((story) => story.id),
  };
}

export function registerDeletion(
  register: Register,
  state: () => AppState,
  changed: () => Promise<void>,
): void {
  register("story:delete", deleteStorySchema, async ({ id, cascade }) => {
    const result = deleteStories(state(), id, cascade);
    await changed();
    return result;
  });
  register("epic:delete", deleteEntitySchema, async ({ id }) => {
    const result = deleteEpic(state(), id);
    await changed();
    return result;
  });
  register("cycle:delete", deleteEntitySchema, async ({ id }) => {
    const result = deleteCycle(state(), id);
    await changed();
    return result;
  });
}
