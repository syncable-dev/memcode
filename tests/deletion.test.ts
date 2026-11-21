import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../src/seed";
import type { Epic } from "../src/shared";
import { defaultView } from "../src/planning/types";
import { addCycle } from "../src/planning/cycles";
import { initializePlanning } from "../src/planning/history";
import { registerDeletion } from "../runtime/deletion";

function fixture() {
  const state = initialState();
  state.tasks = state.tasks
    .slice(0, 3)
    .map((task, index) => ({
      ...task,
      id: `story-${index}`,
      example: false,
      run: { state: "idle" },
      messages: [],
    }));
  const routes = new Map<
    string,
    { schema: any; run: (input: any) => unknown }
  >();
  let saved = 0;
  registerDeletion(
    (name, schema, run) => routes.set(name, { schema, run }),
    () => state,
    async () => {
      saved++;
    },
  );
  initializePlanning(state);
  return {
    state,
    saved: () => saved,
    call: async (name: string, input: unknown) => {
      const route = routes.get(name)!;
      return await route.run(route.schema.parse(input));
    },
  };
}
const epic = (id: string, sourceKey?: string): Epic => ({
  id,
  projectId: "example",
  identifier: "EP-01",
  title: "A plan",
  description: "",
  phase: "now",
  color: "mint",
  order: 0,
  sourceKey,
  branch: "epic/preserved",
});
function cycle(f: ReturnType<typeof fixture>) {
  return addCycle(f.state, "cycle-1", {
    projectId: "example",
    name: "First cycle",
    goal: "Ship",
    startDate: "2026-11-10",
    endDate: "2026-11-20",
    timeZone: "Europe/Copenhagen",
    capacity: 5,
    calendar: "weekdays",
  });
}

test("story deletion removes its metadata and stale relationships without touching source or saved files", async () => {
  const f = fixture(),
    [target, survivor, unrelated] = f.state.tasks;
  const dir = await mkdtemp(join(tmpdir(), "memcode-delete-preserve-"));
  const output = join(dir, "report.md"),
    source = join(dir, "index.ts");
  await writeFile(output, "# Saved output");
  await writeFile(source, "export const preserved = true;");
  try {
    f.state.artifacts.push({
      id: "output-1",
      taskId: target.id,
      projectId: target.projectId,
      path: output,
      name: "report.md",
      kind: "text",
      source: "codex",
      createdAt: target.createdAt,
    });
    survivor.dependsOn = [target.id, unrelated.id];
    survivor.relatedIds = [target.id];
    survivor.duplicateOf = target.id;
    f.state.reviewComments = [
      {
        id: "review-1",
        taskId: target.id,
        reference: {
          kind: "artifact",
          taskId: target.id,
          name: "report",
          quote: "Saved",
          artifactId: "output-1",
        },
        text: "Edit it",
        createdAt: target.createdAt,
        updatedAt: target.createdAt,
        status: "saved",
      },
    ];
    f.state.storyComments = [
      {
        id: "discussion-1",
        taskId: target.id,
        text: "Discuss",
        author: { id: "local", name: "You", source: "local" },
        createdAt: target.createdAt,
        updatedAt: target.createdAt,
      },
    ];
    f.state.workerInputs = [
      {
        id: "input-1",
        taskId: target.id,
        runId: "old-run",
        harness: "codex",
        createdAt: target.createdAt,
        kind: "approval",
        title: "Old approval",
        status: "answered",
      },
    ];
    f.state.fleetPlans = [
      {
        taskId: target.id,
        projectId: target.projectId,
        branch: "epic/preserved",
        scope: [],
        plan: "Plan",
        publishedAt: target.createdAt,
        active: false,
      },
    ];
    f.state.fleetDeclarations = [
      {
        id: "declaration-1",
        taskId: target.id,
        projectId: target.projectId,
        branch: "epic/preserved",
        symbols: ["src/cart.js::cartTotal"],
        kind: "fix",
        plan: "Plan",
        declaredAt: target.createdAt,
        opened: 1,
      },
    ];
    f.state.fleetProposals = [
      {
        id: "proposal-1",
        projectId: target.projectId,
        branch: "epic/preserved",
        proposerTaskId: target.id,
        ownerTaskId: survivor.id,
        alternative: "Other",
        reason: "Reason",
        state: "withdrawn",
        createdAt: target.createdAt,
      },
    ];
    f.state.onboarding = { version: 1, step: "ready", storyId: target.id };
    survivor.messages.push({
      id: "surviving-message",
      role: "user",
      text: "Keep the discussion",
      at: target.createdAt,
      references: [f.state.reviewComments[0].reference],
      commentIds: ["review-1"],
    });
    const result = await f.call("story:delete", { id: target.id });
    assert.deepEqual(result, {
      deletedIds: [target.id],
      reassignedStoryIds: [],
    });
    assert.deepEqual(survivor.dependsOn, [unrelated.id]);
    assert.deepEqual(survivor.relatedIds, []);
    assert.equal(survivor.duplicateOf, null);
    assert.deepEqual(survivor.messages[0].references, []);
    assert.deepEqual(survivor.messages[0].commentIds, []);
    for (const name of [
      "artifacts",
      "reviewComments",
      "storyComments",
      "workerInputs",
      "fleetPlans",
      "fleetProposals",
      "fleetDeclarations",
    ] as const)
      assert.equal(f.state[name]?.length, 0, name);
    assert.ok(
      !f.state.planning.events.some((event) => event.taskId === target.id),
    );
    assert.equal(f.state.planning.observations[target.id], undefined);
    assert.equal(f.state.onboarding.storyId, undefined);
    assert.equal(await readFile(output, "utf8"), "# Saved output");
    assert.equal(
      await readFile(source, "utf8"),
      "export const preserved = true;",
    );
    assert.equal(
      f.state.tasks[0],
      survivor,
      "unrelated live task objects retain their identity",
    );
    assert.equal(f.saved(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("story deletion is leaf-only unless cascade is explicit and validates every descendant before mutation", async () => {
  const f = fixture(),
    [parent, child, grandchild] = f.state.tasks;
  child.parentId = parent.id;
  grandchild.parentId = child.id;
  const before = structuredClone(f.state);
  await assert.rejects(
    f.call("story:delete", { id: parent.id }),
    /has subtasks/,
  );
  assert.deepEqual(f.state, before);
  grandchild.run.state = "preparing";
  const active = structuredClone(f.state);
  await assert.rejects(
    f.call("story:delete", { id: parent.id, cascade: true }),
    /active workers/,
  );
  assert.deepEqual(f.state, active);
  assert.equal(f.saved(), 0);
  grandchild.run.state = "stopped";
  assert.deepEqual(
    await f.call("story:delete", { id: parent.id, cascade: true }),
    {
      deletedIds: [parent.id, child.id, grandchild.id],
      reassignedStoryIds: [],
    },
  );
  assert.equal(f.state.tasks.length, 0);
});

test("every active worker phase blocks story, epic and cycle deletion without partial edits", async () => {
  for (const phase of ["preparing", "running", "stopping"] as const) {
    for (const entity of ["story", "epic", "cycle"]) {
      const f = fixture(),
        task = f.state.tasks[0];
      f.state.epics.push(epic("epic-1"));
      task.epicId = "epic-1";
      cycle(f);
      task.cycleId = "cycle-1";
      task.run.state = phase;
      const before = structuredClone(f.state);
      await assert.rejects(
        f.call(`${entity}:delete`, {
          id: entity === "story" ? task.id : `${entity}-1`,
        }),
        /active workers/,
      );
      assert.deepEqual(f.state, before);
      assert.equal(f.saved(), 0);
    }
  }
});

test("epic deletion reuses Project work, preserves story content and branch data, and repairs saved filters", async () => {
  const f = fixture(),
    [target, sibling] = f.state.tasks;
  f.state.epics.push(epic("epic-1"), epic("default", "project-work"));
  target.epicId = "epic-1";
  sibling.epicId = "default";
  target.run.branch = "epic/preserved";
  target.run.baseline = "commit-preserved";
  f.state.savedViews.push({
    ...structuredClone(defaultView),
    id: "view",
    projectId: "example",
    name: "Epic",
    filters: { ...defaultView.filters, epicId: "epic-1" },
  });
  const result = await f.call("epic:delete", { id: "epic-1" });
  assert.deepEqual(result, {
    deletedIds: ["epic-1"],
    reassignedStoryIds: [target.id],
  });
  assert.equal(target.epicId, "default");
  assert.equal(sibling.epicId, "default");
  assert.equal(target.run.branch, "epic/preserved");
  assert.equal(target.run.baseline, "commit-preserved");
  assert.equal(f.state.epics.length, 1);
  assert.equal(f.state.savedViews[0].filters.epicId, "all");
});

test("deleting the default epic never resurrects the deleted identity and keeps all stories", async () => {
  const f = fixture();
  f.state.epics.push(epic("example-project-work", "project-work"));
  for (const task of f.state.tasks) task.epicId = "example-project-work";
  await f.call("epic:delete", { id: "example-project-work" });
  assert.ok(!f.state.epics.some((epic) => epic.id === "example-project-work"));
  assert.equal(f.state.epics.length, 1);
  assert.ok(f.state.tasks.every((task) => task.epicId === f.state.epics[0].id));
  assert.equal(f.state.tasks.length, 3);
});

test("cycle deletion moves stories to backlog, preserves work, and removes filters and historical cycle references", async () => {
  const f = fixture(),
    task = f.state.tasks[0];
  cycle(f);
  task.cycleId = "cycle-1";
  task.estimate = 5;
  task.stage = "review";
  initializePlanning(f.state);
  f.state.savedViews.push({
    ...structuredClone(defaultView),
    id: "view",
    projectId: "example",
    name: "Cycle",
    filters: { ...defaultView.filters, cycleId: "cycle-1" },
  });
  const events = f.state.planning.events.length;
  assert.deepEqual(await f.call("cycle:delete", { id: "cycle-1" }), {
    deletedIds: ["cycle-1"],
    reassignedStoryIds: [task.id],
  });
  assert.equal(task.cycleId, null);
  assert.equal(task.estimate, 5);
  assert.equal(task.stage, "review");
  assert.equal(f.state.cycles.length, 0);
  assert.equal(
    f.state.planning.events.length,
    events,
    "delivery history remains available",
  );
  assert.ok(
    f.state.planning.events.every(
      (event) =>
        event.before?.cycleId !== "cycle-1" &&
        event.after.cycleId !== "cycle-1",
    ),
  );
  assert.equal(f.state.savedViews[0].filters.cycleId, "all");
});

test("deletion schemas reject unknown flags and missing entities without saving or mutating", async () => {
  const f = fixture(),
    before = structuredClone(f.state);
  await assert.rejects(f.call("story:delete", { id: "story-0", force: true }));
  await assert.rejects(
    f.call("epic:delete", { id: "unknown" }),
    /Goal not found/,
  );
  await assert.rejects(
    f.call("cycle:delete", { id: "unknown" }),
    /Cycle not found/,
  );
  await assert.rejects(
    f.call("story:delete", { id: "unknown" }),
    /Task not found/,
  );
  assert.deepEqual(f.state, before);
  assert.equal(f.saved(), 0);
});
