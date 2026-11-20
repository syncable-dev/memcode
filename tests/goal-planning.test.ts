import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalPlacement } from "../runtime/goal-placement.ts";
import { GoalPlanner, readGoalPlan } from "../runtime/goal-planner.ts";
import type { AppState, Epic, WorkItem } from "../src/shared.ts";
import type { WorkerChanges } from "../src/changes.ts";

const goal = (id: string, extra: Partial<Epic> = {}) =>
  ({
    id,
    projectId: "p1",
    identifier: id.toUpperCase(),
    title: `Goal ${id}`,
    description: "",
    phase: "now",
    color: "mint",
    order: 1,
    ...extra,
  }) as Epic;
const task = (id: string, epicId: string) =>
  ({ id, projectId: "p1", epicId, title: id, run: { state: "finished" } }) as WorkItem;
const changes = (files: Record<string, string[]>) => async (item: WorkItem) =>
  ({
    taskId: item.id,
    checkpoints: [{ files: (files[item.id] ?? []).map((path) => ({ path })) }],
    files: (files[item.id] ?? []).length,
    additions: 0,
    deletions: 0,
  }) as unknown as WorkerChanges;

test("placement suggests the open goals already changing the code a request touches", async () => {
  const state = {
    epics: [
      goal("sessions", { title: "Keep people signed in" }),
      goal("reports"),
      goal("shipped", { closedAt: "2026-11-01T00:00:00.000Z" }),
      goal("batch", { sourceKey: "quick-changes", title: "Quick changes" }),
      goal("elsewhere", { projectId: "p2" }),
    ],
    tasks: [
      task("s1", "sessions"),
      task("s2", "sessions"),
      task("r1", "reports"),
      task("x1", "shipped"),
      task("b1", "batch"),
    ],
  } as unknown as AppState;
  const placement = new GoalPlacement({
    state: () => state,
    readChanges: changes({
      s1: ["src/api/refresh.ts"],
      s2: ["src/auth/session.ts"],
      r1: ["src/reports/export.ts"],
      x1: ["src/api/refresh.ts"],
      b1: ["src/api/refresh.ts"],
    }),
    relatedFiles: async () => ["src/api/refresh.ts", "src/auth/session.ts", "src/ui/a.ts"],
  });
  const result = await placement.place("p1", "Rate-limit the token refresh endpoint");
  assert.deepEqual(result.files, ["src/api/refresh.ts", "src/auth/session.ts", "src/ui/a.ts"]);
  assert.deepEqual(result.goals, [
    {
      epicId: "sessions",
      title: "Keep people signed in",
      shared: ["src/api/refresh.ts", "src/auth/session.ts"],
    },
  ]);
});

test("placement still works when Memtrace has nothing to say", async () => {
  const placement = new GoalPlacement({
    state: () => ({ epics: [goal("a")], tasks: [] }) as unknown as AppState,
    readChanges: changes({}),
    relatedFiles: async () => {
      throw Error("engine offline");
    },
  });
  assert.deepEqual(await placement.place("p1", "anything"), { files: [], goals: [] });
});

test("a harness answer becomes a goal plan, fenced or not", () => {
  const plan = readGoalPlan(
    'Here is the plan:\n```json\n{"title":"Dark mode","tasks":[{"title":"Theme tokens","brief":"Add tokens","files":["src/theme.ts"]},{"title":"Convert dashboard","brief":"Use tokens"}]}\n```',
    "Add dark mode",
  );
  assert.deepEqual(plan, {
    title: "Dark mode",
    tasks: [
      { title: "Theme tokens", brief: "Add tokens", files: ["src/theme.ts"] },
      { title: "Convert dashboard", brief: "Use tokens", files: [] },
    ],
  });
});

test("an unreadable or oversized answer falls back to the request as one task", () => {
  const fallback = readGoalPlan("I could not plan this.", "Fix the login banner typo");
  assert.deepEqual(fallback, {
    title: "Fix the login banner typo",
    tasks: [{ title: "Fix the login banner typo", brief: "Fix the login banner typo", files: [] }],
    fallback: true,
  });
  const many = readGoalPlan(
    JSON.stringify({
      title: "Big",
      tasks: Array.from({ length: 9 }, (_, i) => ({ title: `Task ${i}`, brief: "b" })),
    }),
    "Big",
  );
  assert.equal(many.tasks.length, 5, "a goal plan keeps at most five tasks");
});

test("the planner asks the chosen harness read-only, with the request and the relevant code", async () => {
  const asked: Array<{ harness: string; context: string; policy?: string }> = [];
  const planner = new GoalPlanner({
    dataDir: "/tmp/profile",
    state: () =>
      ({ projects: [{ id: "p1", name: "Acme", description: "Billing app" }] }) as unknown as AppState,
    resolveCommand: async () => ({ command: "claude", prefix: [] }),
    relatedFiles: async () => ["src/theme.ts"],
    ask: async (_dataDir, _state, question, options) => {
      asked.push({ harness: question.harness, context: question.context, policy: options?.policy });
      return {
        harness: question.harness,
        model: "sonnet",
        text: '{"title":"Dark mode","tasks":[{"title":"Theme tokens","brief":"Add tokens"}]}',
      };
    },
  });
  const plan = await planner.plan({ projectId: "p1", request: "Add dark mode", harness: "claude" });
  assert.equal(plan.title, "Dark mode");
  assert.equal(plan.harness, "claude");
  assert.equal(plan.model, "sonnet");
  assert.equal(asked[0].harness, "claude");
  assert.match(asked[0].policy ?? "", /read-only/);
  assert.match(asked[0].policy ?? "", /one task/);
  const context = JSON.parse(asked[0].context);
  assert.equal(context.request, "Add dark mode");
  assert.deepEqual(context.relevantFiles, ["src/theme.ts"]);
  assert.equal(context.project.name, "Acme");
});
