import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import { WorkerManager } from "../runtime/workers";
import type { MemtraceEngine } from "../runtime/memtrace";
import type { Harness, Project, WorkItem } from "../src/shared";

test("resuming implementation waits for review cancellation and prevents duplicate starts", async () => {
  const state = initialState();
  const project: Project = {
    id: "review-project",
    name: "Review fixture",
    path: process.cwd(),
    branch: "main",
    description: "",
    analysis: "ready",
    repoId: "fixture",
    createdAt: "2026-11-15",
  };
  const task: WorkItem = {
    ...state.tasks[0],
    id: "resume",
    projectId: project.id,
    harness: "codex",
    assignment: "auto",
    example: false,
    dependsOn: [],
    run: { state: "finished" },
    codeReview: {
      runId: "review",
      state: "running",
      updatedAt: "2026-11-15",
      findingCount: 0,
    },
  };
  state.projects = [project];
  state.tasks = [task];
  state.fleetConflicts = [];
  let release!: () => void,
    entered = 0,
    preparations = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = new WorkerManager(
    () => state,
    async () => {
      preparations++;
    },
    {} as MemtraceEngine,
    process.cwd(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (item) => {
      assert.equal(item, task);
      entered++;
      await gate;
    },
  );
  Object.assign(manager, {
    workspaces: {
      activate: async () => {
        throw Error("Fixture activation boundary");
      },
    },
  });
  try {
    const run = manager.start(task, project);
    assert.equal(entered, 1);
    assert.equal(task.run.state, "finished");
    assert.equal(task.codeReview!.state, "running");
    assert.equal(preparations, 0);
    await assert.rejects(manager.start(task, project), /already active/);
    release();
    await assert.rejects(run, /Fixture activation boundary/);
    assert.equal(task.codeReview!.state, "stale");
    assert.ok(preparations > 0);
  } finally {
    release();
    await manager.close();
  }
});

test("a failed review cancellation preserves the previous implementation state", async () => {
  const state = initialState();
  const project: Project = {
    id: "review-project",
    name: "Review fixture",
    path: process.cwd(),
    branch: "main",
    description: "",
    analysis: "ready",
    repoId: "fixture",
    createdAt: "2026-11-15",
  };
  const task: WorkItem = {
    ...state.tasks[0],
    id: "resume",
    projectId: project.id,
    harness: "codex",
    assignment: "auto",
    example: false,
    dependsOn: [],
    run: { state: "finished" },
  };
  state.projects = [project];
  state.tasks = [task];
  let calls = 0;
  const manager = new WorkerManager(
    () => state,
    async () => {
      throw Error("State must not change");
    },
    {} as MemtraceEngine,
    process.cwd(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      calls++;
      throw Error("Reviewer is still stopping");
    },
  );
  try {
    await assert.rejects(
      manager.start(task, project),
      /Reviewer is still stopping/,
    );
    await assert.rejects(
      manager.start(task, project),
      /Reviewer is still stopping/,
    );
    assert.equal(task.run.state, "finished");
    assert.equal(
      calls,
      2,
      "The failed cancellation releases its startup reservation",
    );
  } finally {
    await manager.close();
  }
});

for (const harness of ["claude", "codex", "cursor"] as Harness[]) {
  test(`${harness}: a shared project cannot switch a checkout used by its personal alias`, async () => {
    const state = initialState();
    const project: Project = {
      id: "shared",
      name: "Team project",
      path: process.cwd(),
      branch: "main",
      description: "",
      analysis: "ready",
      repoId: "fixture",
      createdAt: "2026-11-15",
    };
    const local: Project = {
      ...project,
      id: "personal",
      name: "Personal project",
    };
    const task: WorkItem = {
      ...state.tasks[0],
      id: "new-worker",
      projectId: project.id,
      harness,
      assignment: "auto",
      example: false,
      run: { state: "idle" },
      dependsOn: [],
    };
    state.projects = [project, local];
    state.tasks = [
      task,
      {
        ...task,
        id: "existing-worker",
        projectId: local.id,
        run: { state: "running" },
      },
    ];
    state.fleetConflicts = [];
    let preparations = 0;
    const manager = new WorkerManager(
      () => state,
      async () => {
        preparations++;
      },
      {} as MemtraceEngine,
      process.cwd(),
    );
    try {
      await assert.rejects(
        manager.start(task, project),
        /already in use.*Personal project/,
      );
      assert.equal(task.run.state, "idle");
      assert.equal(
        preparations,
        0,
        "No Fleet, claim or branch preparation should start",
      );
    } finally {
      state.tasks[1].run.state = "finished";
      await manager.close();
    }
  });
}
