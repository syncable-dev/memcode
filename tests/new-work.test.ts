import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksSmall,
  placementQuery,
  startsNow,
  suggestedPlaces,
  suggestedTimings,
  startEach,
  goalDescription,
  startsWithinLimit,
  thinkingSteps,
  type Place,
} from "../src/new-work.ts";
import { requestAsPlan, type WorkPlan } from "../src/goal-plan.ts";

const placement = (goals: Array<{ epicId: string; title: string; shared: string[] }>) => ({
  files: goals.flatMap((goal) => goal.shared),
  goals,
});
const nothing = placement([]);
const sessions = placement([{ epicId: "g1", title: "Sessions", shared: ["a.ts"] }]);
const plannedBy = (...goals: string[][]): WorkPlan => ({
  goals: goals.map((titles, index) => ({
    title: `Goal ${index + 1}`,
    tasks: titles.map((title) => ({ title, brief: "", files: [], steps: [] })),
  })),
  harness: "codex",
  model: "",
});
const longRequest =
  "Build a CSV export for every report, with filters, scheduling and email delivery to admins.";

test("a short single-line request looks like a quick change", () => {
  assert.equal(looksSmall("Fix the typo in the login banner"), true);
  assert.equal(looksSmall("Add dark mode to the dashboard and remember each person's choice. ".repeat(3)), false);
  assert.equal(looksSmall("Fix typo\nand also refactor the settings page"), false);
  assert.equal(
    looksSmall("Add dark mode to the dashboard and remember each person's choice"),
    false,
    "two asks joined by 'and' are a goal",
  );
});

test("a plan of one task is a quick change and a plan of several is a goal", () => {
  assert.deepEqual(
    suggestedPlaces({ placements: [nothing], draft: plannedBy(["Fix it"]), request: longRequest }),
    [{ kind: "quick" }],
  );
  assert.deepEqual(
    suggestedPlaces({ placements: [nothing], draft: plannedBy(["Export", "Schedule"]), request: "Fix it" }),
    [{ kind: "new" }],
  );
});

test("each planned goal is placed on its own", () => {
  assert.deepEqual(
    suggestedPlaces({
      placements: [nothing, nothing, sessions],
      draft: plannedBy(["Invoices", "Refunds"], ["Fix the footer link"], ["Refresh tokens"]),
      request: longRequest,
    }),
    [{ kind: "new" }, { kind: "quick" }, { kind: "goal", epicId: "g1" }],
  );
});

test("a goal already changing the same code wins over the plan's size", () => {
  assert.deepEqual(
    suggestedPlaces({
      placements: [sessions],
      draft: plannedBy(["Rate-limit refresh"]),
      request: "Rate-limit refresh",
    }),
    [{ kind: "goal", epicId: "g1" }],
  );
});

test("a goal chosen from its own card takes every planned goal", () => {
  assert.deepEqual(
    suggestedPlaces({
      placements: [sessions, nothing],
      draft: plannedBy(["One", "Two"], ["Three"]),
      request: "Anything",
      fixedEpicId: "g2",
    }),
    [
      { kind: "goal", epicId: "g2" },
      { kind: "goal", epicId: "g2" },
    ],
  );
});

test("when no worker planned it, the request's size decides", () => {
  const unplanned = (request: string) =>
    suggestedPlaces({ placements: [nothing], draft: requestAsPlan(request), request });
  assert.deepEqual(unplanned("Fix the typo in the banner"), [{ kind: "quick" }]);
  assert.deepEqual(unplanned(longRequest), [{ kind: "new" }]);
  assert.deepEqual(
    suggestedPlaces({
      placements: [nothing],
      draft: { ...plannedBy([longRequest]), fallback: true },
      request: longRequest,
    }),
    [{ kind: "new" }],
    "an unreadable plan is not the worker saying it's one task",
  );
});

test("work nobody planned starts as the request written as one task", () => {
  assert.deepEqual(requestAsPlan("  Add CSV export\n  for reports "), {
    goals: [
      {
        title: "Add CSV export for reports",
        tasks: [
          { title: "Add CSV export for reports", brief: "Add CSV export\n  for reports", files: [], steps: [] },
        ],
      },
    ],
  });
});

test("a planned goal is matched against open goals by its title and tasks", () => {
  assert.equal(
    placementQuery({
      title: "Billing",
      tasks: [
        { title: "Invoices", brief: "Send a PDF", files: [], steps: [] },
        { title: "Refunds", brief: "", files: [], steps: [] },
      ],
    }),
    "Billing\nInvoices. Send a PDF\nRefunds",
  );
});

test("the first new goal is for now and the other new goals wait until next", () => {
  const places: Place[] = [
    { kind: "new" },
    { kind: "quick" },
    { kind: "new" },
    { kind: "goal", epicId: "g1" },
    { kind: "new" },
  ];
  assert.deepEqual(suggestedTimings(places), ["now", "now", "next", "now", "next"]);
});

test("only goals for now start; quick changes and existing goals start with them", () => {
  const cases: Array<[Place, "now" | "next" | "later", boolean]> = [
    [{ kind: "new" }, "now", true],
    [{ kind: "new" }, "next", false],
    [{ kind: "new" }, "later", false],
    [{ kind: "quick" }, "later", true],
    [{ kind: "goal", epicId: "g1" }, "next", true],
  ];
  for (const [place, timing, starts] of cases)
    assert.equal(startsNow(place, timing), starts, `${place.kind} · ${timing}`);
});

test("planning shows its steps for any worker: finding code, planning, then checking open goals", () => {
  assert.deepEqual(
    thinkingSteps({ planner: "Codex", planned: false }).map((step) => [step.label, step.state]),
    [
      ["Finding the code this touches", "active"],
      ["Codex is planning the tasks", "active"],
      ["Checking your open goals", "waiting"],
    ],
  );
  const found = thinkingSteps({
    planner: "Claude Code",
    files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
    planned: false,
  });
  assert.deepEqual(found[0], {
    label: "Found 4 related files",
    state: "done",
    detail: "src/a.ts · src/b.ts · src/c.ts and 1 more",
  });
  assert.deepEqual(
    thinkingSteps({ planner: "Cursor", files: [], planned: true }).map((step) => [step.label, step.state]),
    [
      ["No related code found, so the plan uses your words", "done"],
      ["Cursor planned the work", "done"],
      ["Checking your open goals", "active"],
    ],
  );
});

test("without a worker, planning skips straight from code to open goals", () => {
  assert.deepEqual(
    thinkingSteps({ files: ["src/a.ts"], planned: true }).map((step) => [step.label, step.state]),
    [
      ["Found 1 related file", "done"],
      ["Checking your open goals", "active"],
    ],
  );
});

test("workers start a few at a time, and one that can't start doesn't stop the rest", async () => {
  let running = 0;
  let most = 0;
  const started: string[] = [];
  const start = async (id: string) => {
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    if (id === "t3") throw new Error("Connect Codex in Workers.");
    started.push(id);
  };
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    id: `t${index + 1}`,
    identifier: `MC-${index + 1}`,
  }));
  const failed = await startEach(tasks, start, 3);
  assert.equal(most, 3, "never more than three starting at once");
  assert.deepEqual(started.sort(), ["t1", "t2", "t4", "t5", "t6", "t7", "t8"]);
  assert.deepEqual(failed, ["MC-3: Connect Codex in Workers."]);
});

test("only as many workers start as there are free slots; the rest stay ready to start", () => {
  assert.deepEqual(startsWithinLimit({ startable: 3, freeSlots: 2 }), { now: 2, waiting: 1 });
  assert.deepEqual(startsWithinLimit({ startable: 2, freeSlots: 5 }), { now: 2, waiting: 0 });
  assert.deepEqual(startsWithinLimit({ startable: 4, freeSlots: 0 }), { now: 0, waiting: 4 });
  assert.deepEqual(startsWithinLimit({ startable: 0, freeSlots: 3 }), { now: 0, waiting: 0 });
});

test("a split goal is described by its own tasks, and a single goal by what the person asked", () => {
  const billing = {
    title: "Billing",
    tasks: [
      { title: "Invoices", brief: "Send a PDF invoice.", files: [], steps: [] },
      { title: "Refunds", brief: "", files: [], steps: [] },
    ],
  };
  assert.equal(goalDescription(billing, "Billing and onboarding, please.", true), "Send a PDF invoice.\n\nRefunds");
  assert.equal(goalDescription(billing, "  Billing, please.  ", false), "Billing, please.");
});
