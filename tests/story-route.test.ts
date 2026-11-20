import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime/app.ts";
import { MemtraceEngine } from "../runtime/memtrace.ts";
import { planDefinedStory } from "../runtime/story-route.ts";
import { initialState } from "../src/seed.ts";
import { harnessIds, type Evidence, type HarnessRuntime, type WorkItem } from "../src/shared.ts";

const measured: Evidence = {
  state: "measured",
  symbols: [
    {
      name: "render",
      file: "src/components/View.tsx",
      line: 1,
      cognitive: 4,
      cyclomatic: 3,
      nesting: 2,
      metricSource: "ast",
    },
  ],
  affected: 2,
  affectedProcesses: 1,
  incomplete: false,
  note: "Test fixture, not a production measurement",
  measuredAt: "2026-11-14T00:00:00.000Z",
};
const catalog: HarnessRuntime[] = ["codex", "claude", "cursor"].map((id) => ({
  id: id as HarnessRuntime["id"],
  name: id,
  available: true,
  path: "fixture",
  models: (["fast", "balanced", "frontier", "extreme"] as const).map(
    (tier) => ({ id: `${id}-${tier}`, label: tier, tier, source: "alias" }),
  ),
}));

function connectedState(ids = catalog.map(runtime => runtime.id)) {
  const state = initialState();
  state.workerConnections = Object.fromEntries(ids.map(id => [id, {
    harness: id, runtimePath: "fixture", approvedAt: "2026-11-20T00:00:00Z",
    auth: "authenticated", scopeVersion: 1,
  }]));
  return state;
}

test("every nonempty connection combination routes only within its approvals, independently of discovery order", () => {
  const all: HarnessRuntime[] = harnessIds.map(id => ({ id, name: id, available: true, path: "fixture", models: [{ id: id + "-default", label: id, source: "acp", isDefault: true, tier: "extreme" }] }));
  for (let mask = 1; mask < 1 << all.length; mask++) {
    const enabled = all.filter((_, index) => mask & (1 << index)).map(runtime => runtime.id);
    const state = connectedState(enabled);
    const task = { ...state.tasks[0], assignment: "auto" as const };
    for (const evidence of [measured, undefined, { ...measured, affected: 2000 }]) {
      const first = planDefinedStory(task, evidence, all, state);
      const reverse = planDefinedStory(task, evidence, [...all].reverse(), state);
      assert.ok(enabled.includes(first.harness));
      assert.equal(first.harness, reverse.harness);
      assert.equal(first.model, reverse.model);
      assert.equal(first.effort, reverse.effort);
    }
  }
});

test("a defined story names an approved harness and model without starting work", () => {
  const state = connectedState();
  const task = {
    ...state.tasks[0],
    assignment: "auto" as const,
    run: { state: "idle" as const },
  };
  const route = planDefinedStory(task, measured, catalog, state);
  assert.equal(route.mode, "automatic");
  assert.equal(route.status, "measured");
  assert.equal(route.harness, "cursor");
  assert.equal(route.model, "cursor-fast");
  assert.equal(task.run.state, "idle");
});

test("an uninstalled harness is not named for a defined story", () => {
  const state = initialState();
  const task = { ...state.tasks[0], assignment: "auto" as const };
  assert.throws(
    () =>
      planDefinedStory(
        task,
        measured,
        catalog.map((runtime) => ({ ...runtime, available: false })),
        state,
      ),
    /No eligible connected worker/,
  );
});

test("a manual harness stays selected while its model comes from the measurement", () => {
  const state = connectedState();
  const task = {
    ...state.tasks[0],
    assignment: "manual" as const,
    harness: "claude" as const,
  };
  const route = planDefinedStory(task, measured, catalog, state);
  assert.equal(route.harness, "claude");
  assert.equal(route.model, "claude-fast");
  assert.equal(route.mode, "manual");
});

test("defining a story records the assignee and leaves the worker idle", async () => {
  const qualify = mock.method(
    MemtraceEngine.prototype,
    "qualify",
    async () => measured,
  );
  const dir = await mkdtemp(join(tmpdir(), "memcode-story-route-"));
  const runtime = await createRuntime(
    dir,
    dir,
    { call: async () => { throw new Error("No native calls expected"); } },
    () => {},
    { discoverHarnesses: async () => catalog },
  );
  try {
    runtime.store.state.workerConnections = connectedState().workerConnections;
    const project = runtime.store.state.projects[0];
    project.example = false;
    project.analysis = "ready";
    project.repoId = "fixture";
    project.path = dir;
    const created = (await runtime.request("task:create", {
      projectId: project.id,
      title: "Name the harness",
      description: "Define who picks this up without starting work.",
      priority: "medium",
      harness: "codex",
      assignment: "auto",
    })) as WorkItem;
    const deadline = Date.now() + 2000;
    let stored = runtime.store.state.tasks.find((item) => item.id === created.id);
    while (!stored?.route && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      stored = runtime.store.state.tasks.find((item) => item.id === created.id);
    }
    assert.ok(stored?.route, "the defined story should name a harness and model");
    assert.equal(stored.route.mode, "automatic");
    assert.equal(stored.route.harness, "cursor");
    assert.equal(stored.route.model, "cursor-fast");
    assert.equal(stored.harness, "cursor");
    assert.equal(stored.run.state, "idle");
    assert.equal(stored.stage, "planned");
    assert.equal(qualify.mock.callCount(), 1);
  } finally {
    qualify.mock.restore();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("automatic planning excludes installed tools without a matching approval", () => {
  const state = connectedState(["codex"]);
  const task = { ...state.tasks[0], assignment: "auto" as const };
  for (const order of [catalog, [...catalog].reverse()]) {
    const route = planDefinedStory(task, measured, order, state);
    assert.equal(route.harness, "codex");
  }
  assert.throws(() => planDefinedStory(task, measured, catalog, initialState()), /No eligible connected worker/);
  const changed = catalog.map(runtime => ({ ...runtime, path: "different-provider-entry" }));
  assert.throws(() => planDefinedStory(task, measured, changed, state), /No eligible connected worker/);
});

test("a disconnected manual worker never silently switches to another provider", () => {
  const state = connectedState(["codex"]);
  const task = { ...state.tasks[0], assignment: "manual" as const, harness: "claude" as const };
  assert.throws(() => planDefinedStory(task, measured, catalog, state), /assigned worker is not connected/);
});

test("routing ties are stable when the provider changes catalog order", () => {
  const state = connectedState(["codex"]);
  const task = { ...state.tasks[0], assignment: "auto" as const };
  const runtime = { ...catalog[0], models: [
    { id: "z-fast", label: "Z", tier: "fast" as const, source: "cli" as const },
    { id: "a-fast", label: "A", tier: "fast" as const, source: "cli" as const },
  ] };
  const first = planDefinedStory(task, measured, [runtime], state);
  const second = planDefinedStory(task, measured, [{ ...runtime, models: [...runtime.models].reverse() }], state);
  assert.equal(first.model, second.model);
});

test("example stories stay unmeasured and idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memcode-story-route-example-"));
  const runtime = await createRuntime(
    dir,
    dir,
    { call: async () => { throw new Error("No native calls expected"); } },
    () => {},
  );
  try {
    const projectId = runtime.store.state.projects[0].id;
    const created = (await runtime.request("task:create", {
      projectId,
      title: "Example only",
      description: "Preview data",
      priority: "medium",
      harness: "codex",
      assignment: "auto",
    })) as WorkItem;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(created.example, true);
    assert.equal(created.route, undefined);
    assert.equal(created.run.state, "idle");
    await assert.rejects(
      runtime.request("task:qualify", created.id),
      /Example context is not measured/,
    );
    assert.equal(created.run.state, "idle");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
