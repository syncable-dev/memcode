import { z } from "zod";
import type { AppState } from "../../src/shared";
import { keptElsewhere, trackedFields } from "../../src/tracker";
import type { LinearService } from "./linear/service";

type Register = (
  method: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;

const id = z.string().min(1).max(200);
const idMap = z.record(id, id).refine((map) => Object.keys(map).length <= 200, "Too many.");
export const choicesSchema = z
  .object({
    teamId: id,
    scope: z.enum(["open", "cycle", "all"]),
    goals: z.enum(["milestones", "parents", "none"]),
    direction: z.enum(["both", "in"]),
    createIssues: z.boolean(),
    lanes: idMap,
    send: z
      .object({
        backlog: id.optional(),
        planned: id.optional(),
        working: id.optional(),
        review: id.optional(),
        done: id.optional(),
        canceled: id.optional(),
      })
      .strict(),
  })
  .strict();

/** What the window may ask of a tracker. It never sees a sign-in. */
export function registerTrackers(
  register: Register,
  state: () => AppState,
  changed: () => Promise<void>,
  linear: LinearService,
  open: (url: string) => Promise<void>,
) {
  const connection = z.object({ id }).strict();
  const task = z.object({ taskId: id }).strict();
  register(
    "tracker:connect",
    z.object({ projectId: id, key: z.string().trim().min(10).max(500).optional() }).strict(),
    (input) => linear.connect(input.projectId, input.key),
  );
  register("tracker:cancel", z.undefined(), () => linear.cancelConnecting());
  register("tracker:disconnect", connection, (input) => linear.disconnect(input.id));
  register(
    "tracker:pause",
    z.object({ id, paused: z.boolean() }).strict(),
    (input) => linear.pause(input.id, input.paused),
  );
  register("tracker:take-over", connection, (input) => linear.takeOver(input.id));
  register("tracker:teams", connection, (input) => linear.teams(input.id));
  register("tracker:preview", z.object({ id, teamId: id }).strict(), (input) =>
    linear.preview(input.id, input.teamId),
  );
  register("tracker:import", z.object({ id, choices: choicesSchema }).strict(), (input) =>
    linear.import(input.id, input.choices),
  );
  register("tracker:undo-preview", connection, (input) => linear.undoPreview(input.id));
  register("tracker:undo-import", connection, (input) => linear.undoImport(input.id));
  register("tracker:sync", connection, (input) => linear.look(input.id));
  register(
    "tracker:restore",
    z.object({ taskId: id, field: z.enum(trackedFields) }).strict(),
    (input) => linear.restore(input.taskId, input.field),
  );
  register("tracker:retry", task, (input) => linear.retry(input.taskId));
  register("tracker:unlink", task, (input) => linear.unlink(input.taskId));
  register(
    "tracker:keep-here",
    z.object({ taskId: id, keep: z.boolean() }).strict(),
    async (input) => {
      const item = state().tasks.find((one) => one.id === input.taskId);
      if (!item) throw new Error("Work item not found.");
      if (item.tracker) throw new Error("This task is an issue in Linear already.");
      item.keepHere = input.keep || undefined;
      await changed();
    },
  );
  register("tracker:open", task, async (input) => {
    const all = [...state().tasks, ...state().epics];
    const url = all.find((item) => item.id === input.taskId)?.tracker?.url;
    if (!url) throw new Error("There is no address for this in Linear.");
    await open(url);
  });
}

/** Linear starts and ends its own cycles; what MemCode changed there would be changed back. */
export function assertOwnCycle(state: AppState, cycleId: string): void {
  const cycle = state.cycles.find((item) => item.id === cycleId);
  if (
    cycle?.tracker &&
    (state.trackers?.some((item) => item.projectId === cycle.projectId && item.importedAt) ||
      keptElsewhere(state, cycle.projectId))
  )
    throw new Error(
      "This cycle is Linear's. Linear starts and ends it by its dates, and its name and dates are changed there.",
    );
}
