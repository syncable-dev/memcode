import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createRuntime } from "../runtime/app.ts";
import { LocalStore, within } from "../runtime/local.ts";
import type { Cycle, TaskPatch, WorkItem } from "../src/shared.ts";
import { backlogStatusId, taskStatus, workflowFor } from "../src/planning/workflow.ts";

test("Backlog and Planned persist independently of cycle membership, including atomic bulk moves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memcode-backlog-"));
  const runtime = await createRuntime(dir, dir, { call: async () => { throw Error("Unexpected native call"); } }, () => {});
  try {
    const state = runtime.store.state, projectId = state.projects[0].id;
    const create = (title: string, patch: TaskPatch = {}) =>
      runtime.request("task:create", { projectId, title, description: title, priority: "medium", harness: "codex", ...patch }) as Promise<WorkItem>;
    const lane = (task: WorkItem) => taskStatus(task, workflowFor(state, projectId)).name;
    const cycle = await runtime.request("cycle:create", {
      projectId, name: "Active cycle", goal: "", startDate: "2026-11-02", endDate: "2026-11-13",
      timeZone: "UTC", calendar: "weekdays", capacity: 10,
    }) as Cycle;
    await runtime.request("cycle:start", cycle.id);
    const backlog = backlogStatusId(projectId), planned = `${projectId}:planned`;
    const idea = await create("New idea");
    const outside = await create("Deliberately planned", { statusId: planned });
    const scheduled = await create("Scheduled", { cycleId: cycle.id });
    assert.deepEqual([idea, outside, scheduled].map(lane), ["Backlog", "Planned", "Planned"]);
    assert.equal(idea.cycleId ?? null, null);
    assert.equal(outside.cycleId ?? null, null);
    assert.equal(scheduled.cycleId, cycle.id);
    for (const status of workflowFor(state, projectId).filter((entry) => entry.stage !== "planned")) {
      const created = await create("Created in " + status.name, { statusId: status.id });
      assert.equal(lane(created), status.name);
      assert.equal(created.run.state, "idle");
    }
    const count = state.tasks.length;
    await assert.rejects(create("Invalid lane", { statusId: "other:working" }), /workflow state from this project/);
    assert.equal(state.tasks.length, count);
    const bulk = (ids: string[], patch: TaskPatch) => runtime.request("task:bulk-update", { ids, patch });
    const update = (task: WorkItem, patch: TaskPatch) => runtime.request("task:update", { id: task.id, patch });
    await assert.rejects(bulk([idea.id, scheduled.id], { statusId: backlog, cycleId: cycle.id }), /assign it to a cycle/);
    await assert.rejects(bulk([idea.id, "missing"], { statusId: planned, cycleId: cycle.id }), /no longer exists/);
    assert.equal(lane(idea), "Backlog");
    assert.equal(scheduled.cycleId, cycle.id);
    await bulk([idea.id, outside.id], { statusId: planned, cycleId: cycle.id });
    assert.deepEqual([idea, outside].map((task) => [lane(task), task.cycleId]), [["Planned", cycle.id], ["Planned", cycle.id]]);
    await bulk([idea.id, scheduled.id], { statusId: backlog });
    assert.deepEqual([idea, scheduled].map((task) => [lane(task), task.cycleId]), [["Backlog", null], ["Backlog", null]]);
    await update(scheduled, { statusId: planned, cycleId: null });
    await update(scheduled, { priority: "low" });
    await update(outside, { cycleId: null });
    assert.equal(lane(outside), "Backlog");
    const saved = new LocalStore(dir);
    await saved.load();
    assert.deepEqual([idea, outside, scheduled].map((task) =>
      taskStatus(saved.state.tasks.find((item) => item.id === task.id)!, workflowFor(saved.state, projectId)).name
    ), ["Backlog", "Backlog", "Planned"]);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime validates bulk updates atomically and accepts children before their parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memcode-runtime-test-"));
  const runtime = await createRuntime(
    dir,
    dir,
    {
      call: async () => {
        throw new Error("No native calls expected");
      },
    },
    () => {},
  );
  try {
    const projectId = runtime.store.state.projects[0].id;
    const create = (title: string, parentId?: string) =>
      runtime.request("task:create", {
        projectId,
        title,
        description: "A fixture",
        priority: "medium",
        harness: "codex",
        assignment: "auto",
        parentId,
      }) as Promise<WorkItem>;
    const parent = await create("Fixture parent"),
      child = await create("Fixture child", parent.id);
    await assert.rejects(
      runtime.request("task:bulk-update", {
        ids: [parent.id, "missing"],
        patch: { priority: "high" },
      }),
      /no longer exists/,
    );
    assert.equal(parent.priority, "medium");
    await runtime.request("task:bulk-update", {
      ids: [parent.id, child.id],
      patch: { statusId: `${projectId}:done` },
    });
    assert.equal(parent.stage, "done");
    assert.equal(child.stage, "done");
    child.run.state = "running";
    child.stage = "working";
    await assert.rejects(
      runtime.request("task:bulk-update", {
        ids: [parent.id, child.id],
        patch: { archivedAt: new Date().toISOString() },
      }),
      /active worker/,
    );
    assert.equal(parent.archivedAt, undefined);
    await assert.rejects(
      runtime.request("task:update", {
        id: child.id,
        patch: { madeUp: "field" },
      }),
      /Unrecognized/,
    );
    await assert.rejects(
      runtime.request("not:a:method"),
      /Unknown MemCode method/,
    );
    child.run.state = "stopped";
    await assert.rejects(
      runtime.request("settings:save", {
        ...runtime.store.state.settings,
        contextAssistant: {
          enabled: true,
          provider: "openai-compatible",
          packageDirectory: "",
          baseUrl: "https://remote.example/v1",
          model: "local-helper",
        },
      }),
    );
    assert.equal(runtime.store.state.settings.contextAssistant, undefined);
  } finally {
    await runtime.close();
    assert.ok(
      within(tmpdir(), dir) &&
        basename(dir).startsWith("memcode-runtime-test-"),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
