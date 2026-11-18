import type { AppState, Cycle, CreateCycle } from "../shared";
import { cycleSnapshot, observePlanning } from "./history";
import { dayAt, daysBetween, validDay } from "./dates";
import { isActive } from "../domain";
import { backlogStatusId } from "./workflow";

export function validateCycle(input: CreateCycle): void {
  if (
    !validDay(input.startDate) ||
    !validDay(input.endDate) ||
    input.startDate > input.endDate
  )
    throw new Error("Choose a valid cycle date range.");
  if (daysBetween(input.startDate, input.endDate) > 365)
    throw new Error("A cycle can span at most one year.");
  try {
    dayAt(undefined, input.timeZone);
  } catch {
    throw new Error("Choose a valid cycle time zone.");
  }
  if (
    input.capacity !== null &&
    (!Number.isFinite(input.capacity) || input.capacity < 0)
  )
    throw new Error("Cycle capacity must be a non-negative number.");
}
export function addCycle(
  state: AppState,
  id: string,
  input: CreateCycle,
  at = new Date().toISOString(),
): Cycle {
  validateCycle(input);
  if (!state.projects.some((project) => project.id === input.projectId))
    throw new Error("Project not found.");
  const cycle: Cycle = {
    ...input,
    id,
    state: "planned",
    createdAt: at,
    snapshots: [],
  };
  state.cycles.push(cycle);
  observePlanning(state, at);
  return cycle;
}
export function beginCycle(
  state: AppState,
  id: string,
  at = new Date().toISOString(),
): void {
  const cycle = state.cycles.find((cycle) => cycle.id === id);
  if (!cycle) throw new Error("Cycle not found.");
  if (cycle.state !== "planned")
    throw new Error("Only a planned cycle can be started.");
  if (
    state.cycles.some(
      (other) =>
        other.projectId === cycle.projectId && other.state === "active",
    )
  )
    throw new Error("Finish the current active cycle first.");
  observePlanning(state, at);
  cycle.state = "active";
  cycle.startedAt = at;
  cycle.baseline = cycleSnapshot(state, id, at);
}
export function finishCycle(
  state: AppState,
  id: string,
  targetCycleId?: string | null,
  at = new Date().toISOString(),
): { moved: number } {
  const cycle = state.cycles.find((cycle) => cycle.id === id);
  if (!cycle) throw new Error("Cycle not found.");
  if (cycle.state !== "active")
    throw new Error("Start the cycle before completing it.");
  if (state.tasks.some((task) => task.cycleId === id && isActive(task)))
    throw new Error(
      "Stop or finish the cycle’s active workers before closing it.",
    );
  if (targetCycleId) {
    const target = state.cycles.find(
      (other) =>
        other.id === targetCycleId && other.projectId === cycle.projectId,
    );
    if (!target || target.id === id || target.state === "completed")
      throw new Error(
        "Choose an unfinished cycle in this project for carryover.",
      );
  }
  observePlanning(state, at);
  cycle.snapshots.push(cycleSnapshot(state, id, at));
  cycle.state = "completed";
  cycle.completedAt = at;
  let moved = 0;
  if (targetCycleId !== undefined)
    for (const task of state.tasks) {
      if (task.cycleId === id && task.stage !== "done" && !task.archivedAt) {
        task.cycleId = targetCycleId;
        if (targetCycleId === null && task.stage === "planned")
          task.statusId = backlogStatusId(task.projectId);
        task.updatedAt = at;
        moved++;
      }
    }
  observePlanning(state, at);
  return { moved };
}
