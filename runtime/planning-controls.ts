import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AppState, Project } from "../src/shared";
import { stages } from "../src/shared";
import {
  addCycle,
  beginCycle,
  finishCycle,
  validateCycle,
} from "../src/planning/cycles";
import { isActive } from "../src/domain";
import { backlogStatusId, isBacklogStatus, storedTaskStatus, workflowFor, taskStatus } from "../src/planning/workflow";
type Register = (
  name: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
const id = z.string().min(1).max(200),
  title = z.string().trim().min(1).max(160);
const cycleFields = {
  name: title,
  goal: z.string().max(10000),
  startDate: z.string(),
  endDate: z.string(),
  timeZone: z.string().max(100),
  capacity: z.number().finite().min(0).max(100000).nullable(),
  calendar: z.enum(["weekdays", "calendar"]),
};
export function registerPlanningControls(
  register: Register,
  state: () => AppState,
  project: (id: string) => Project,
  changed: () => Promise<void>,
): void {
  register(
    "cycle:create",
    z.object({ projectId: id, ...cycleFields }),
    async (input) => {
      project(input.projectId);
      const result = addCycle(state(), randomUUID(), input);
      await changed();
      return result;
    },
  );
  register(
    "cycle:update",
    z.object({ id, patch: z.object(cycleFields).partial().strict() }),
    async ({ id, patch }) => {
      const cycle = state().cycles.find((cycle) => cycle.id === id);
      if (!cycle) throw new Error("Cycle not found.");
      if (cycle.state === "completed")
        throw new Error(
          "Completed cycles keep their recorded dates and scope.",
        );
      const next = { ...cycle, ...patch };
      validateCycle(next);
      Object.assign(cycle, patch);
      await changed();
    },
  );
  register("cycle:start", id, async (id) => {
    beginCycle(state(), id);
    await changed();
  });
  register(
    "cycle:complete",
    z.object({ id, targetCycleId: id.nullable().optional() }),
    async ({ id, targetCycleId }) => {
      const result = finishCycle(state(), id, targetCycleId);
      await changed();
      return result;
    },
  );
  const filters = z.object({
    query: z.string().max(500),
    priority: z.enum(["all", "high", "medium", "low"]),
    epicId: id,
    cycleId: id,
    label: z.string().max(100),
    kind: z.string().max(100),
    harness: z.enum(["all", "codex", "claude", "cursor"]),
    archived: z.boolean(),
  });
  register(
    "view:save",
    z.object({
      id: id.optional(),
      projectId: id,
      name: title,
      mode: z.enum(["board", "list", "timeline", "calendar"]),
      groupBy: z.enum([
        "status",
        "epic",
        "priority",
        "harness",
        "cycle",
        "none",
      ]),
      sortBy: z.enum(["priority", "updated", "created", "due", "estimate"]),
      filters,
    }),
    async (input) => {
      project(input.projectId);
      const existing = input.id
        ? state().savedViews.find(
            (view) =>
              view.id === input.id && view.projectId === input.projectId,
          )
        : undefined;
      if (input.id && !existing) throw new Error("Saved view not found.");
      const view = { ...input, id: existing?.id ?? randomUUID() };
      if (existing) Object.assign(existing, view);
      else state().savedViews.push(view);
      await changed();
      return view;
    },
  );
  register("view:delete", id, async (id) => {
    const index = state().savedViews.findIndex((view) => view.id === id);
    if (index < 0) throw new Error("Saved view not found.");
    state().savedViews.splice(index, 1);
    await changed();
  });
  const status = z.object({
    id,
    projectId: id,
    name: title,
    stage: z.enum(stages),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    order: z.number().int().min(0),
    wipLimit: z.number().int().min(1).max(10000).nullable().optional(),
  });
  register(
    "workflow:save",
    z.object({ projectId: id, states: z.array(status).min(4).max(17) }),
    async (input) => {
      project(input.projectId);
      if (
        new Set(input.states.map((s: any) => s.id)).size !==
          input.states.length ||
        input.states.some((s: any) => s.projectId !== input.projectId)
      )
        throw new Error(
          "Workflow state identifiers must be unique within this project.",
        );
      if (
        stages.some(
          (stage) => !input.states.some((s: any) => s.stage === stage && !isBacklogStatus(s.id)),
        )
      )
        throw new Error("Keep at least one state for each execution stage.");
      if (input.states.some((s: any) => isBacklogStatus(s.id) && (s.id !== backlogStatusId(input.projectId) || s.stage !== "planned")))
        throw Error("Backlog belongs to this project's planned stage.");
      for (const task of state().tasks.filter(
        (task) => task.projectId === input.projectId && isActive(task),
      )) {
        const prior = taskStatus(task, workflowFor(state(), input.projectId));
        const next = input.states.find((s: any) => s.id === prior.id);
        if (!next || next.stage !== prior.stage)
          throw new Error(
            "Keep active workers in their existing execution stage.",
          );
      }
      state().workflowStates = state()
        .workflowStates.filter((s) => s.projectId !== input.projectId)
        .concat(input.states);
      const saved = workflowFor(state(), input.projectId);
      for (const task of state().tasks.filter(
        (task) => task.projectId === input.projectId,
      ))
        task.statusId = storedTaskStatus(task, saved, {});
      await changed();
    },
  );
  const field = z.object({
    id,
    projectId: id,
    name: title,
    type: z.enum(["text", "number", "select"]),
    options: z.array(z.string().trim().min(1).max(100)).max(50),
  });
  register(
    "fields:save",
    z.object({ projectId: id, fields: z.array(field).max(30) }),
    async (input) => {
      project(input.projectId);
      if (
        input.fields.some(
          (field: any) => field.projectId !== input.projectId,
        ) ||
        new Set(input.fields.map((f: any) => f.id)).size !== input.fields.length
      )
        throw new Error(
          "Custom field identifiers must be unique within this project.",
        );
      if (
        input.fields.some(
          (field: any) => field.type === "select" && !field.options.length,
        )
      )
        throw new Error("Choice fields need at least one option.");
      state().customFields = state()
        .customFields.filter((field) => field.projectId !== input.projectId)
        .concat(input.fields);
      await changed();
    },
  );
}
