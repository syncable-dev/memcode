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
    'Here is the plan:\n```json\n{"goals":[{"title":"Dark mode","tasks":[{"title":"Theme tokens","brief":"Add tokens","files":["src/theme.ts"]},{"title":"Convert dashboard","brief":"Use tokens"}]}]}\n```',
    "Add dark mode",
  );
  assert.deepEqual(plan, {
    goals: [
      {
        title: "Dark mode",
        tasks: [
          { title: "Theme tokens", brief: "Add tokens", files: ["src/theme.ts"], steps: [] },
          { title: "Convert dashboard", brief: "Use tokens", files: [], steps: [] },
        ],
      },
    ],
  });
});

test("a big request can come back as several goals, and a single-goal answer still reads", () => {
  const several = readGoalPlan(
    JSON.stringify({
      goals: [
        { title: "Billing", tasks: [{ title: "Invoices" }, { title: "Refunds" }] },
        { title: "Onboarding", tasks: [{ title: "Welcome screen" }] },
      ],
    }),
    "Billing and onboarding",
  );
  assert.deepEqual(
    several.goals.map((goal) => [goal.title, goal.tasks.length]),
    [
      ["Billing", 2],
      ["Onboarding", 1],
    ],
  );
  const single = readGoalPlan('{"title":"Dark mode","tasks":[{"title":"Theme tokens"}]}', "Dark mode");
  assert.deepEqual(single.goals.map((goal) => goal.title), ["Dark mode"]);
});

test("the planner's steps become each task's runbook, tidied and kept short", () => {
  const plan = readGoalPlan(
    JSON.stringify({
      goals: [
        {
          title: "Export reports",
          tasks: [
            {
              title: "Add the export endpoint",
              steps: ["  Add GET /reports/export  ", "", "Stream rows as CSV", "x".repeat(400), ...Array.from({ length: 12 }, (_, i) => `Extra ${i}`)],
            },
            { title: "Add the Export button" },
          ],
        },
      ],
    }),
    "Export reports",
  );
  const [endpoint, button] = plan.goals[0].tasks;
  assert.deepEqual(endpoint.steps.slice(0, 2), ["Add GET /reports/export", "Stream rows as CSV"]);
  assert.equal(endpoint.steps[2].length, 200, "an overlong step is cut, not a reason to drop the plan");
  assert.equal(endpoint.steps.length, 8, "a runbook stays short");
  assert.deepEqual(button.steps, [], "a task without steps gets the standard runbook when created");
});

test("an unreadable answer falls back to the request as one task", () => {
  const fallback = readGoalPlan("I could not plan this.", "Fix the login banner typo");
  assert.deepEqual(fallback, {
    goals: [
      {
        title: "Fix the login banner typo",
        tasks: [{ title: "Fix the login banner typo", brief: "Fix the login banner typo", files: [], steps: [] }],
      },
    ],
    fallback: true,
  });
});

test("every task the worker planned is kept, even past the size it was asked for", () => {
  const many = readGoalPlan(
    JSON.stringify({
      goals: [{ title: "Big", tasks: Array.from({ length: 9 }, (_, i) => ({ title: `Task ${i}`, brief: "b" })) }],
    }),
    "Big",
  );
  assert.equal(many.goals[0].tasks.length, 9);
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
        text: '{"goals":[{"title":"Dark mode","tasks":[{"title":"Theme tokens","brief":"Add tokens"}]}]}',
      };
    },
  });
  const plan = await planner.plan({ projectId: "p1", request: "Add dark mode", harness: "claude" });
  assert.deepEqual(plan.goals.map((goal) => goal.title), ["Dark mode"]);
  assert.equal(plan.harness, "claude");
  assert.equal(plan.model, "sonnet");
  assert.equal(asked[0].harness, "claude");
  const policy = asked[0].policy ?? "";
  assert.match(policy, /read-only/);
  assert.match(policy, /One task is the default/, "a clear change stays one task");
  assert.match(policy, /don't need each other's result/, "tasks split on separate outcomes");
  assert.match(policy, /Two tasks may change the same file/, "sharing a file is no reason to merge tasks");
  assert.match(policy, /one task for each listed part/, "a request that lists its parts keeps them");
  assert.match(policy, /No standalone tasks for tests/, "no padding tasks");
  assert.match(policy, /its own pull request/, "separate goals only for separate outcomes");
  assert.match(policy, /Add nothing that wasn't asked for/);
  assert.match(policy, /"goals"/);
  assert.match(policy, /steps: the task's runbook/, "the planner writes each task's runbook");
  assert.match(policy, /No generic steps/);
  const context = JSON.parse(asked[0].context);
  assert.equal(context.request, "Add dark mode");
  assert.deepEqual(context.relevantFiles, ["src/theme.ts"]);
  assert.equal(context.project.name, "Acme");
});
