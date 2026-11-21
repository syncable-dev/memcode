import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import { contextAssistantDefaults } from "../src/context-settings";
import { git, exists, within } from "../runtime/local";
import { WorkerManager } from "../runtime/workers";
import type { MemtraceEngine } from "../runtime/memtrace";
import type { WorkItem } from "../src/shared";
import { approveFixtureWorker } from "./fixtures/worker-consent";
import { startPrintFixtureSession } from "./fixtures/print-session";

async function preparingFixture() {
  const root = await mkdtemp(join(tmpdir(), "memcode-preparation-test-"));
  const repo = join(root, "repo"),
    packageDirectory = join(root, "fake-transformers");
  await mkdir(repo);
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await writeFile(
    join(packageDirectory, "dist", "transformers.node.mjs"),
    `import {writeFile} from 'node:fs/promises';export const env={};export async function pipeline(){await writeFile(new URL('../pid.txt',import.meta.url),String(process.pid));setInterval(()=>{},1000);return new Promise(()=>{});}`,
  );
  await writeFile(join(repo, "README.md"), "Preparation fixture\n");
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const state = initialState();
  approveFixtureWorker(state, "claude");
  const project = {
    ...state.projects[0],
    id: "preparation",
    path: repo,
    repoId: "fixture",
    branch: "main",
    analysis: "ready" as const,
    example: false,
  };
  const task: WorkItem = {
    ...state.tasks[0],
    id: "preparing",
    projectId: project.id,
    epicId: "preparation-epic",
    assignment: "auto",
    example: false,
    stage: "planned",
    run: { state: "idle" },
    messages: [],
    dependsOn: [],
    scope: ["README.md"],
  };
  state.projects = [project];
  state.tasks = [task];
  state.fleetConflicts = [];
  state.epics = [
    {
      id: "preparation-epic",
      projectId: project.id,
      identifier: "EP-01",
      title: "Preparation",
      description: "Fixture",
      phase: "now",
      color: "mint",
      order: 0,
    },
  ];
  state.settings.contextAssistant = {
    ...contextAssistantDefaults,
    enabled: true,
    packageDirectory,
  };
  const calls: string[] = [];
  const engine = {
    analyze: async () => "fixture",
    qualify: async () => ({
      state: "partial",
      symbols: [],
      incomplete: true,
      note: "Fixture",
      measuredAt: new Date().toISOString(),
    }),
    async call(_project: unknown, name: string) {
      calls.push(name);
      if (name === "get_query_revision")
        return { ready: true, token: "graph-1" };
      return {};
    },
  } as unknown as MemtraceEngine;
  const script = join(root, "worker.mjs");
  await writeFile(
    script,
    "import {writeFile} from 'node:fs/promises';await writeFile('launched.txt','unexpected worker');",
  );
  const manager = new WorkerManager(
    () => state,
    async () => {},
    engine,
    join(root, "data"),
    async () => ({ command: process.execPath, prefix: [script] }),
    async () => [
      {
        id: "claude",
        name: "Fixture Claude",
        available: true,
        path: process.execPath,
        models: [
          { id: "fixture", label: "Fixture", tier: "extreme", source: "alias" },
        ],
      },
    ],
    undefined,
    undefined,
    startPrintFixtureSession,
  );
  const running = manager.start(task, project).then(
    () => undefined,
    (error) => error as Error,
  );
  const pidPath = join(packageDirectory, "pid.txt"),
    until = Date.now() + 8000;
  while (
    !(await exists(pidPath)) &&
    task.run.state === "preparing" &&
    Date.now() < until
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (!(await exists(pidPath))) {
    await manager.close();
    assert.fail(
      `Optional helper did not start: ${task.run.error ?? task.run.state}`,
    );
  }
  const pid = Number(await readFile(pidPath, "utf8"));
  const session = JSON.parse(
    await readFile(
      join(repo, ".memcode", "workers", task.id, "context-session.json"),
      "utf8",
    ),
  );
  return {
    manager,
    task,
    calls,
    running,
    pid,
    session,
    repo,
    /** Edits the worker announced and has not recorded. */
    openDeclarations: () =>
      (state.fleetDeclarations ?? []).filter((item) => !item.recordedAt).length,
    async cleanup() {
      await manager.close();
      await running;
      assert.ok(
        within(tmpdir(), root) &&
          basename(root).startsWith("memcode-preparation-test-"),
      );
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** The helper is told to stop; give the operating system a moment to finish it. */
async function exited(pid: number) {
  for (let waited = 0; waited < 3000; waited += 20) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("stopping during slow context preparation closes the helper and the session, and leaves nothing declared", async () => {
  const f = await preparingFixture();
  try {
    assert.equal(f.task.run.state, "preparing");
    const declared = await fetch(f.session.endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + f.session.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        capability: "coordinate",
        action: "declare",
        symbols: ["README.md"],
        kind: "docs",
        plan: "Describe the fixture.",
      }),
    });
    assert.equal((await declared.json()).canEdit, true);
    assert.equal(f.openDeclarations(), 1);
    await f.manager.stop(f.task.id);
    assert.match((await f.running)!.message, /cancelled/);
    assert.equal(f.task.run.state, "stopped");
    assert.equal(f.openDeclarations(), 0, "peers are not left holding for a worker that is gone");
    assert.equal(f.calls.includes("fleet_acquire_lease"), false);
    await exited(f.pid);
    assert.throws(() => process.kill(f.pid, 0), { code: "ESRCH" });
    await assert.rejects(fetch(f.session.endpoint));
    assert.equal(await exists(join(f.repo, "launched.txt")), false);
  } finally {
    await f.cleanup();
  }
});

test("closing the manager cancels preparing context work and waits for optional helper exit", async () => {
  const f = await preparingFixture();
  try {
    await f.manager.close();
    assert.match((await f.running)!.message, /cancelled/);
    assert.equal(f.openDeclarations(), 0);
    assert.throws(() => process.kill(f.pid, 0), { code: "ESRCH" });
    await assert.rejects(fetch(f.session.endpoint));
    assert.equal(await exists(join(f.repo, "launched.txt")), false);
  } finally {
    await f.cleanup();
  }
});

test("a running worker's runbook tool ticks and extends the task the person is watching", async () => {
  const fixture = await preparingFixture();
  try {
    assert.equal(fixture.session.runbook, true, "the gateway is told to offer the runbook tool");
    const steps = fixture.task.checklist.length;
    assert.ok(steps > 0 && !fixture.task.checklist[0].done);
    const call = async (update: object) => {
      const response = await fetch(fixture.session.endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + fixture.session.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ capability: "runbook", ...update }),
      });
      return { ok: response.ok, body: await response.json() };
    };
    const ticked = await call({ done: [1], add: ["Check the empty state by hand"] });
    assert.equal(ticked.ok, true);
    assert.match(ticked.body, new RegExp(`1 of ${steps + 1} steps done`));
    assert.equal(fixture.task.checklist[0].done, true);
    assert.equal(fixture.task.checklist.at(-1)?.text, "Check the empty state by hand");
    const refused = await call({ done: [99] });
    assert.equal(refused.ok, false, "a step that doesn't exist is refused");
    assert.equal(fixture.task.checklist.length, steps + 1);
  } finally {
    await fixture.cleanup();
  }
});
