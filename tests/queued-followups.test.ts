import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initialState } from "../src/seed";
import { restartSafeState } from "../src/domain";
import type { Harness, Message, Project, WorkItem } from "../src/shared";
import { WorkerManager } from "../runtime/workers";
import { reviewContext } from "../runtime/review-context";
import { registerReview } from "../runtime/review";
import { git, within } from "../runtime/local";
import type { MemtraceEngine } from "../runtime/memtrace";
import { startPrintFixtureSession } from "./fixtures/print-session";

const providers: Harness[] = ["claude", "cursor", "codex"];
const note = (text: string): Message => ({
  id: randomUUID(),
  role: "user",
  text,
  at: new Date().toISOString(),
});
async function until(
  predicate: () => boolean | Promise<boolean>,
  label: string,
) {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw Error("Timed out: " + label);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function fixture(
  harnesses: Harness[] = ["codex"],
  options: {
    fail?: boolean;
    spawnFails?: boolean;
    preparationFails?: boolean;
    slots?: number;
    pickupGate?: boolean;
    settlementGate?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "memcode-queue-")),
    repo = join(root, "repo"),
    stub = join(root, "worker.mjs"),
    state = initialState();
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await writeFile(join(repo, "README.md"), "Queue fixture: no model runs.\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, [
    "-c",
    "user.name=Queue Fixture",
    "-c",
    "user.email=queue@local.invalid",
    "commit",
    "-m",
    "Fixture",
  ]);
  await writeFile(
    stub,
    `import{readFile,writeFile,mkdir,access,rename}from'node:fs/promises';import{join}from'node:path';const id=process.env.MEMCODE_TASK_ID,dir=join('.memcode','gates',id);await mkdir(dir,{recursive:true});const log=join(dir,'runs.json'),runs=JSON.parse(await readFile(log,'utf8').catch(()=>'[]'));let stdin='';for await(const data of process.stdin)stdin+=data;const prompt=stdin||await readFile(join('.memcode','workers',id,'brief.md'),'utf8');const index=runs.length+1;runs.push({index,prompt,at:Date.now()});await writeFile(log+'.tmp',JSON.stringify(runs));await rename(log+'.tmp',log);const release=join(dir,index+'.release');let ready=false;for(let n=0;n<1500;n++){try{await access(release);ready=true;break;}catch{}await new Promise(r=>setTimeout(r,10));}if(!ready)process.exit(8);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture pass '+index+' finished; no model ran.'}}));process.exit(${options.fail ? 7 : 0});`,
  );
  const project: Project = {
    id: "queue-project",
    name: "Queue fixture",
    description: "No model",
    path: repo,
    branch: "main",
    analysis: "ready",
    repoId: "fixture",
    createdAt: new Date().toISOString(),
  };
  state.projects = [project];
  state.tasks = [];
  state.epics = [];
  state.fleetConflicts = [];
  state.artifacts = [];
  state.settings.maxWorkers = options.slots ?? 3;
  const tasks = harnesses.map((harness, index): WorkItem => ({
    ...state.tasks[0],
    ...initialState().tasks[0],
    id: "queue-task-" + index,
    identifier: "Q-" + index,
    projectId: project.id,
    example: false,
    harness,
    assignment: "manual",
    modelOverride: "fixture-model",
    scope: ["scope-" + index + ".ts"],
    messages: [note("Initial pass for " + harness)],
    run: { state: "idle" },
    stage: "planned",
  }));
  state.tasks = tasks;
  const runtimePath = options.spawnFails
    ? join(root, "missing.exe")
    : process.execPath;
  state.workerConnections = Object.fromEntries(
    harnesses.map((harness) => [
      harness,
      {
        harness,
        runtimePath,
        approvedAt: new Date().toISOString(),
        auth: "authenticated",
        scopeVersion: 1,
      },
    ]),
  );
  let releases = 0;
  let releasePickup!: () => void,
    pickupHeld = false;
  const pickupGate = new Promise<void>((resolve) => {
    releasePickup = resolve;
  });
  let releaseSettlement!: () => void;
  const settlementGate = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  });
  const resumedSessions: (string | undefined)[] = [];
  const manager = new WorkerManager(
    () => state,
    async () => {
      if (options.settlementGate && tasks[0].run.state === "finished")
        await settlementGate;
      if (
        options.pickupGate &&
        !pickupHeld &&
        state.tasks.some((task) =>
          task.messages.some(
            (message) => message.pickedUpAt && !message.promptedAt,
          ),
        )
      ) {
        pickupHeld = true;
        await pickupGate;
      }
      manager.dispatchQueued();
    },
    {
      analyze: async () => "fixture",
      qualify: async () => {
        if (options.preparationFails) throw Error("Fixture preparation failed");
        return {
          state: "unavailable",
          symbols: [],
          incomplete: true,
          note: "Fixture",
          measuredAt: new Date().toISOString(),
        };
      },
      call: async (_project: unknown, name: string) => {
        if (name === "fleet_acquire_lease")
          return { state: "granted", lease_id: "queue-lease" };
        if (name === "fleet_release_lease") releases++;
        return {};
      },
    } as unknown as MemtraceEngine,
    join(root, "data"),
    async () => ({
      command: options.spawnFails
        ? join(root, "missing.exe")
        : process.execPath,
      prefix: [stub],
    }),
    async () =>
      providers.map((id) => ({
        id,
        name: id,
        available: true,
        path: runtimePath,
        models: [
          {
            id: "fixture-model",
            label: "Fixture",
            tier: "extreme",
            source: "alias",
          },
        ],
      })),
    undefined,
    undefined,
    (harness, session) => {
      resumedSessions.push(session.resumeSessionId);
      session.onEvent({ type: "session", sessionId: "fixture-provider-session" });
      return startPrintFixtureSession(harness, session);
    },
  );
  const runs = async (task: WorkItem) =>
    JSON.parse(
      await readFile(
        join(repo, ".memcode/gates", task.id, "runs.json"),
        "utf8",
      ).catch(() => "[]"),
    ) as Array<{ index: number; prompt: string; at: number }>;
  const release = async (task: WorkItem, index: number) => {
    await mkdir(join(repo, ".memcode/gates", task.id), { recursive: true });
    await writeFile(
      join(repo, ".memcode/gates", task.id, index + ".release"),
      "release",
    );
  };
  const enqueue = (task: WorkItem, text: string) => {
    const message = note(text);
    task.messages.push(message);
    manager.enqueue(task, message.id);
    manager.dispatchQueued();
    return message;
  };
  return {
    root,
    repo,
    state,
    project,
    tasks,
    manager,
    resumedSessions,
    runs,
    release,
    enqueue,
    releasePickup,
    releaseSettlement,
    releases: () => releases,
    async cleanup() {
      releasePickup();
      releaseSettlement();
      await manager.close();
      assert.ok(
        within(tmpdir(), root) && basename(root).startsWith("memcode-queue-"),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a follow-up can reuse a verified older save, but never an unverified provider or different checkout", async () => {
  for (const source of ["matching legacy", "changed provider", "unverified legacy", "different checkout"]) {
    const f = await fixture(["codex"]), task = f.tasks[0];
    try {
      task.run = {state: "finished", sessionId: "original-local-session", workspace: f.repo};
      if (source !== "unverified legacy")
        task.run.measurements = {modelIds: [], modelSource: source === "changed provider" ? "claude-assistant" : "codex-thread"};
      if (source === "different checkout") task.run.workspace = join(f.root, "previous-repo");
      f.enqueue(task, "Run the follow-up on the correct workspace.");
      await until(async () => (await f.runs(task)).length === 1, "queued pass started");
      assert.deepEqual(f.resumedSessions, [source === "matching legacy" ? "original-local-session" : undefined]);
      await f.release(task, 1);
      await until(() => task.run.state === "finished", "queued pass finished");
    } finally { await f.cleanup(); }
  }
});

test("a finished provider still occupies its slot until its final contribution has settled", async () => {
  const f = await fixture(["codex"], { settlementGate: true }),
    task = f.tasks[0];
  try {
    await f.manager.start(task, f.project);
    await until(
      async () => (await f.runs(task)).length === 1,
      "provider started",
    );
    await f.release(task, 1);
    await until(() => task.run.state === "finished", "provider exited");
    assert.equal(
      f.manager.implementationStarting(task.id),
      true,
      "Review capture must wait for the final journal and drain",
    );
    assert.equal(f.manager.implementationCount(), 1);
    f.releaseSettlement();
    await until(
      () => !f.manager.implementationStarting(task.id),
      "contribution settled",
    );
    assert.equal(f.manager.implementationCount(), 0);
  } finally {
    await f.cleanup();
  }
});

test("all three adapters automatically coalesce busy follow-ups after Fleet cleanup, without duplicate passes", async () => {
  for (const provider of providers) {
    const f = await fixture([provider]),
      task = f.tasks[0];
    try {
      await f.manager.start(task, f.project);
      await until(async () => (await f.runs(task)).length === 1, "first pass");
      const one = f.enqueue(
          task,
          "First queued review: exact quote and page 2",
        ),
        two = f.enqueue(task, "Second queued review: cells B4:C5");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal((await f.runs(task)).length, 1);
      assert.equal(one.promptedAt, undefined);
      await f.release(task, 1);
      await until(
        async () => (await f.runs(task)).length === 2,
        "automatic next pass",
      );
      assert.ok(
        f.releases() > 0,
        "previous Fleet lease released before next pass",
      );
      const prompt = (await f.runs(task))[1].prompt;
      assert.ok(prompt.includes(`Source checkout: ${task.run.workspace}`));
      assert.ok(prompt.includes(join(task.run.workspace!, task.scope![0])));
      assert.ok(prompt.includes(one.text));
      assert.ok(prompt.includes(two.text));
      const current = prompt.lastIndexOf("CURRENT REQUESTS");
      assert.ok(current > prompt.indexOf("Fixture pass 1 finished"));
      assert.ok(
        prompt.indexOf(one.text, current) < prompt.indexOf(two.text, current),
      );
      assert.ok(prompt.endsWith(two.text));
      assert.equal(prompt.split(one.text).length - 1, 1);
      assert.deepEqual(f.resumedSessions, [undefined, "fixture-provider-session"]);
      assert.equal(one.followupState, "included");
      assert.equal(two.followupState, "included");
      assert.ok(one.promptedAt);
      await f.release(task, 2);
      await until(() => task.run.state === "finished", "second pass complete");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await f.runs(task)).length, 2);
      assert.equal(task.harness, provider);
    } finally {
      await f.cleanup();
    }
  }
});

test("edited and cancelled queued requests reach the next actual process exactly as last saved", async () => {
  const f = await fixture(["codex", "claude"], { slots: 1 }),
    [first, next] = f.tasks,
    routes = new Map<string, { schema: any; run: (input: any) => unknown }>();
  registerReview(
    (name, schema, run) => routes.set(name, { schema, run }),
    () => f.state,
    async () => f.manager.dispatchQueued(),
    () => {},
  );
  const call = async (name: string, input: unknown) => {
    const route = routes.get(name)!;
    return route.run(route.schema.parse(input));
  };
  try {
    await f.manager.start(first, f.project);
    await until(
      async () => (await f.runs(first)).length === 1,
      "occupied fixture process",
    );
    const edit = f.enqueue(next, "Original queue wording"),
      cancel = f.enqueue(next, "Cancelled request must not reach process");
    await call("review:queue-update", {
      taskId: next.id,
      messageId: edit.id,
      text: "Final queued wording accepted",
    });
    await call("review:queue-cancel", {
      taskId: next.id,
      messageId: cancel.id,
    });
    await f.release(first, 1);
    await until(
      async () => (await f.runs(next)).length === 1,
      "edited automatic process",
    );
    const prompt = (await f.runs(next))[0].prompt;
    assert.match(prompt, /Final queued wording accepted/);
    assert.doesNotMatch(
      prompt,
      /Original queue wording|Cancelled request must not reach process/,
    );
    assert.equal(edit.followupState, "included");
    assert.equal(cancel.followupState, "cancelled");
    await f.release(next, 1);
    await until(() => next.run.state === "finished", "fixture complete");
  } finally {
    await f.cleanup();
  }
});

test("a real worker's persisted brief pickup rejects a stale edit and cancel before process spawn", async () => {
  const f = await fixture(["codex"], { pickupGate: true }),
    task = f.tasks[0],
    routes = new Map<string, { schema: any; run: (input: any) => unknown }>();
  registerReview(
    (name, schema, run) => routes.set(name, { schema, run }),
    () => f.state,
    async () => {},
    () => {},
  );
  const call = async (name: string, input: unknown) => {
    const route = routes.get(name)!;
    return route.run(route.schema.parse(input));
  };
  try {
    const message = f.enqueue(task, "Claimed wording is immutable");
    await until(() => !!message.pickedUpAt, "persisted claim");
    assert.equal((await f.runs(task)).length, 0);
    await assert.rejects(
      call("review:queue-update", {
        taskId: task.id,
        messageId: message.id,
        text: "Stale replacement",
      }),
      /picked up/,
    );
    await assert.rejects(
      call("review:queue-cancel", { taskId: task.id, messageId: message.id }),
      /picked up/,
    );
    f.releasePickup();
    await until(
      async () => (await f.runs(task)).length === 1,
      "spawn after claim release",
    );
    assert.match(
      (await f.runs(task))[0].prompt,
      /Claimed wording is immutable/,
    );
    assert.doesNotMatch((await f.runs(task))[0].prompt, /Stale replacement/);
    await f.release(task, 1);
    await until(
      () => task.run.state === "finished",
      "claimed fixture completes",
    );
  } finally {
    await f.cleanup();
  }
});

test("queued ready cards wait for capacity in durable FIFO order while each card remains single-flight", async () => {
  const f = await fixture(providers, { slots: 1 }),
    [first, second, third] = f.tasks;
  try {
    await f.manager.start(first, f.project);
    await until(
      async () => (await f.runs(first)).length === 1,
      "occupied slot",
    );
    const early = f.enqueue(third, "Third card queued first"),
      late = f.enqueue(second, "Second card queued later");
    early.queuedAt = late.queuedAt = "2026-11-14T19:00:00.000Z";
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await f.runs(third)).length, 0);
    await f.release(first, 1);
    await until(
      async () => (await f.runs(third)).length === 1,
      "oldest ready card",
    );
    assert.equal((await f.runs(second)).length, 0);
    assert.equal(late.followupState, "queued");
    await f.release(third, 1);
    await until(
      async () => (await f.runs(second)).length === 1,
      "next ready card",
    );
    await f.release(second, 1);
    await until(() => second.run.state === "finished", "last complete");
  } finally {
    await f.cleanup();
  }
});

test("user Stop cancels automatic delivery and preserves pending review text", async () => {
  const f = await fixture(),
    task = f.tasks[0];
  try {
    await f.manager.start(task, f.project);
    await until(async () => (await f.runs(task)).length === 1, "first pass");
    const queued = f.enqueue(task, "Retain this review after stop");
    await f.manager.stop(task.id);
    assert.equal(queued.followupState, "cancelled");
    assert.equal(queued.promptedAt, undefined);
    assert.ok(task.messages.includes(queued));
    assert.ok(
      !reviewContext(task.messages).some((message) => message.id === queued.id),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await f.runs(task)).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("process failure pauses a busy queue instead of retrying the failed worker", async () => {
  const f = await fixture(["codex"], { fail: true }),
    task = f.tasks[0];
  try {
    await f.manager.start(task, f.project);
    await until(async () => (await f.runs(task)).length === 1, "first pass");
    const queued = f.enqueue(task, "Pending when model fails");
    await f.release(task, 1);
    await until(
      () => task.run.state === "failed" && queued.followupState === "paused",
      "failure pause",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await f.runs(task)).length, 1);
    assert.equal(queued.promptedAt, undefined);
  } finally {
    await f.cleanup();
  }
});

test("preparation and spawn failures pause authorized input without marking it included", async () => {
  for (const options of [{ preparationFails: true }, { spawnFails: true }]) {
    const f = await fixture(["claude"], options),
      task = f.tasks[0];
    try {
      const queued = f.enqueue(task, "Keep for retry");
      await until(
        () => task.run.state === "failed" && queued.followupState === "paused",
        "failed launch",
      );
      assert.ok(task.run.finishedAt, "the failed preparation has a completion timestamp");
      assert.equal(queued.promptedAt, undefined);
      assert.equal((await f.runs(task)).length, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("shutdown and crash recovery pause interrupted queues while clean queued cards remain recoverable", async () => {
  const f = await fixture(),
    task = f.tasks[0];
  try {
    await f.manager.start(task, f.project);
    await until(async () => (await f.runs(task)).length === 1, "first pass");
    const queued = f.enqueue(task, "Keep on shutdown");
    await f.manager.close();
    assert.equal(queued.followupState, "paused");
    assert.equal(queued.promptedAt, undefined);
    const crash = structuredClone(f.state);
    crash.tasks[0].run.state = "running";
    crash.tasks[0].messages.at(-1)!.followupState = "queued";
    const restored = restartSafeState(crash);
    assert.equal(restored.tasks[0].messages.at(-1)!.followupState, "paused");
    const clean = structuredClone(f.state);
    clean.tasks[0].run.state = "finished";
    clean.tasks[0].messages.at(-1)!.followupState = "queued";
    assert.equal(
      restartSafeState(clean).tasks[0].messages.at(-1)!.followupState,
      "queued",
    );
  } finally {
    await f.cleanup();
  }
});

test("messages sent after a running brief snapshot queue a distinct subsequent pass", async () => {
  const f = await fixture(),
    task = f.tasks[0];
  try {
    const first = f.enqueue(task, "First explicit send");
    await until(
      async () => (await f.runs(task)).length === 1,
      "first queued launch",
    );
    assert.equal(first.followupState, "included");
    const later = f.enqueue(task, "Arrived after first brief snapshot");
    assert.equal(later.promptedAt, undefined);
    await f.release(task, 1);
    await until(async () => (await f.runs(task)).length === 2, "later pass");
    assert.equal(later.followupState, "included");
    await f.release(task, 2);
    await until(() => task.run.state === "finished", "complete");
  } finally {
    await f.cleanup();
  }
});
