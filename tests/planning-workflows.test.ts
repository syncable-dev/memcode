import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed.ts";
import {
  initializePlanning,
  observePlanning,
} from "../src/planning/history.ts";
import { addCycle, beginCycle, finishCycle } from "../src/planning/cycles.ts";
import {
  cycleSeries,
  deliverySeries,
  projectForecast,
} from "../src/planning/analytics.ts";
import { addDays, dayAt, validDay } from "../src/planning/dates.ts";
import {
  defaultWorkflow,
  validateHierarchy,
  filterWork,
} from "../src/planning/workflow.ts";
import { defaultView } from "../src/planning/types.ts";
import { applyTaskPatch } from "../runtime/task-planning.ts";
import type { AppState } from "../src/shared.ts";

const at = "2026-11-02T10:00:00.000Z";
function fixture() {
  const state = initialState();
  state.planning = undefined as unknown as AppState["planning"];
  state.tasks = state.tasks.slice(0, 3);
  for (const task of state.tasks) {
    task.stage = "planned";
    task.run = { state: "idle" };
  }
  initializePlanning(state, at);
  const projectId = state.projects[0].id;
  const input = {
    projectId,
    name: "Focused cycle",
    goal: "Deliver the scope",
    startDate: "2026-11-02",
    endDate: "2026-11-13",
    timeZone: "Europe/Copenhagen",
    capacity: 13,
    calendar: "weekdays" as const,
  };
  return { state, projectId, input };
}

test("migration records a present-day baseline without inventing prior throughput", () => {
  const { state, projectId } = fixture();
  state.tasks[0].stage = "done";
  state.planning = undefined as unknown as AppState["planning"];
  initializePlanning(state, at);
  const points = deliverySeries(state, projectId, 7, at, "UTC");
  assert.ok(points.slice(0, -1).every((point) => point.issues === null));
  assert.equal(points.at(-1)?.issues, 0);
  assert.equal(projectForecast(state, projectId, at), null);
  assert.ok(state.planning.events.every((event) => event.kind === "baseline"));
});

test("cycle closing freezes scope before explicit carryover, and later edits keep it frozen", () => {
  const { state, input } = fixture();
  const cycle = addCycle(state, "first", input, at);
  addCycle(
    state,
    "next",
    { ...input, startDate: "2026-11-16", endDate: "2026-11-27" },
    at,
  );
  state.tasks[0].cycleId = cycle.id;
  state.tasks[0].estimate = 5;
  state.tasks[1].cycleId = cycle.id;
  state.tasks[1].estimate = 3;
  beginCycle(state, cycle.id, at);
  state.tasks[0].stage = "done";
  const result = finishCycle(
    state,
    cycle.id,
    "next",
    "2026-11-13T16:00:00.000Z",
  );
  assert.deepEqual(result, { moved: 1 });
  assert.equal(state.tasks[0].cycleId, "first");
  assert.equal(state.tasks[1].cycleId, "next");
  const closing = structuredClone(cycle.snapshots.at(-1)!);
  assert.deepEqual(
    [closing.total, closing.completed, closing.points, closing.completedPoints],
    [2, 1, 8, 5],
  );
  state.tasks[0].stage = "planned";
  state.tasks[0].estimate = 21;
  observePlanning(state, "2026-11-14T10:00:00.000Z");
  assert.deepEqual(cycle.snapshots.at(-1), closing);
});

test("carryover can explicitly return to backlog and active workers prevent closing", () => {
  const { state, input } = fixture();
  const cycle = addCycle(state, "first", input, at);
  state.tasks[0].cycleId = cycle.id;
  beginCycle(state, cycle.id, at);
  state.tasks[0].run.state = "running";
  assert.throws(() => finishCycle(state, cycle.id, null), /active workers/);
  assert.equal(cycle.state, "active");
  state.tasks[0].run.state = "stopped";
  assert.equal(finishCycle(state, cycle.id, null).moved, 1);
  assert.equal(state.tasks[0].cycleId, null);
});

test("only one cycle may be active per project and cross-project carryover is rejected", () => {
  const { state, input } = fixture();
  addCycle(state, "a", input, at);
  addCycle(state, "b", input, at);
  beginCycle(state, "a", at);
  assert.throws(() => beginCycle(state, "b", at), /current active cycle/);
  state.projects.push({ ...state.projects[0], id: "other" });
  addCycle(state, "foreign", { ...input, projectId: "other" }, at);
  assert.throws(() => finishCycle(state, "a", "foreign"), /in this project/);
});

test("unestimated work stays explicit and future cycle actuals remain unknown", () => {
  const { state, input } = fixture();
  const cycle = addCycle(state, "a", input, at);
  state.tasks[0].cycleId = "a";
  state.tasks[0].estimate = 0;
  state.tasks[1].cycleId = "a";
  state.tasks[1].estimate = null;
  beginCycle(state, "a", at);
  assert.equal(cycle.baseline?.unestimated, 1);
  const series = cycleSeries(cycle, "issues", at);
  assert.equal(series[0].scope, 2);
  assert.ok(
    series
      .slice(1)
      .every((point) => point.scope === null && point.completed === null),
  );
  assert.equal(series.at(-1)?.ideal, 0);
  assert.equal(cycleSeries(cycle, "points", at)[0].scope, 0);
});

test("reopened and accepted work records transitions without fabricating unique delivery", () => {
  const { state, projectId } = fixture();
  state.tasks[0].estimate = 3;
  state.tasks[0].stage = "done";
  observePlanning(state, at);
  state.tasks[0].stage = "review";
  observePlanning(state, at);
  state.tasks[0].stage = "done";
  observePlanning(state, at);
  const today = deliverySeries(state, projectId, 1, at, "UTC")[0];
  assert.equal(today.issues, 2);
  assert.equal(today.points, 6);
});

test("date-only arithmetic is stable across DST and rejects impossible calendar dates", () => {
  assert.equal(addDays("2026-03-28", 2), "2026-03-30");
  assert.equal(
    dayAt("2026-10-25T00:30:00.000Z", "Europe/Copenhagen"),
    "2026-10-25",
  );
  assert.equal(validDay("2026-02-29"), false);
  assert.equal(validDay("2028-02-29"), true);
});

test("hierarchy rejects cycles and parent acceptance requires completed child stories", () => {
  const { state } = fixture();
  const [parent, child] = state.tasks;
  applyTaskPatch(state, child, { parentId: parent.id });
  assert.throws(
    () => validateHierarchy(state.tasks, parent, child.id),
    /under one of its own subtasks/,
  );
  assert.throws(
    () => applyTaskPatch(state, parent, { stage: "done" }),
    /Complete the subtasks/,
  );
  applyTaskPatch(state, child, { stage: "done" });
  applyTaskPatch(state, parent, { stage: "done" });
  assert.equal(parent.stage, "done");
  assert.throws(
    () => applyTaskPatch(state, child, { stage: "review" }),
    /Reopen the parent/,
  );
  assert.throws(
    () => applyTaskPatch(state, state.tasks[2], { parentId: parent.id }),
    /Reopen the parent/,
  );
});

test("workflow names are independent of execution stages and mismatched updates fail", () => {
  const { state, projectId } = fixture();
  state.workflowStates = defaultWorkflow(projectId);
  state.workflowStates.push({
    id: "qa",
    projectId,
    name: "Quality review",
    stage: "review",
    color: "#c19c51",
    order: 4,
  });
  const task = state.tasks[0];
  applyTaskPatch(state, task, { statusId: "qa" });
  assert.equal(task.stage, "review");
  assert.equal(task.statusId, "qa");
  assert.throws(
    () => applyTaskPatch(state, task, { statusId: "qa", stage: "done" }),
    /must agree/,
  );
});

test("custom fields preserve existing removed choices while rejecting new invalid values", () => {
  const { state, projectId } = fixture();
  const task = state.tasks[0];
  state.customFields = [
    { id: "size", projectId, name: "Size", type: "select", options: ["small"] },
  ];
  task.customFields = { size: "retired", removed: "retained" };
  applyTaskPatch(state, task, { customFields: { ...task.customFields } });
  assert.throws(
    () => applyTaskPatch(state, task, { customFields: { size: "invented" } }),
    /Invalid value/,
  );
  applyTaskPatch(state, task, {
    customFields: { ...task.customFields, size: "small" },
  });
  assert.equal(task.customFields.removed, "retained");
});

test("archived items are excluded by default and explicit saved filters are composable", () => {
  const { state } = fixture();
  state.tasks[0].archivedAt = at;
  state.tasks[1].labels = ["frontend"];
  assert.equal(filterWork(state.tasks, defaultView).length, 2);
  const result = filterWork(state.tasks, {
    ...defaultView,
    filters: {
      ...defaultView.filters,
      label: "frontend",
      query: state.tasks[1].identifier,
    },
  });
  assert.deepEqual(
    result.map((task) => task.id),
    [state.tasks[1].id],
  );
});

test("changing a story's permission preference leaves its active session mode unchanged", () => {
  const { state } = fixture(),
    task = state.tasks[0];
  task.run = {
    state: "running",
    permissionMode: "review",
    sessionId: "native-session",
  };
  applyTaskPatch(state, task, { permissionMode: "auto" });
  assert.equal(task.permissionMode, "auto");
  assert.equal(task.run.permissionMode, "review");
  assert.equal(task.run.sessionId, "native-session");
  applyTaskPatch(state, task, { permissionMode: "full-access" });
  assert.equal(task.run.permissionMode, "review");
});
