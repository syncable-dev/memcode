import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed.ts";
import { git, within, exists } from "../runtime/local.ts";
import { WorkerManager } from "../runtime/workers.ts";
import { fleetEngine } from "./support/fleet-engine";
import type { HarnessRuntime, WorkItem } from "../src/shared.ts";
import { approveFixtureWorker } from "./fixtures/worker-consent";
import { startPrintFixtureSession } from "./fixtures/print-session";

/**
 * A worker that follows the loop for real, over the gateway: it declares the symbol it is
 * about to change, edits, pauses as a model would mid-thought, and records.
 */
function workerScript(symbol: (taskId: string) => string, editingMs: number) {
  return `import {writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';
for await (const chunk of process.stdin) {}
const id = process.env.MEMCODE_TASK_ID;
const session = JSON.parse(await readFile(join('.memcode','workers',id,'context-session.json'),'utf8'));
async function coordinate(input) {
  const r = await fetch(session.endpoint,{method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:JSON.stringify({capability:'coordinate',...input})});
  if (!r.ok) throw Error(await r.text());
  return r.json();
}
const declared = await coordinate({action:'declare',symbols:[(${symbol.toString()})(id)],kind:'change',plan:'Add the assigned worker output.'});
if (declared.canEdit !== true) throw Error('Told to wait: ' + JSON.stringify(declared));
await writeFile(id + '.txt', 'Shared branch change');
await writeFile(join(process.env.MEMCODE_ARTIFACT_DIR, 'report.html'), '<h1>' + id + '</h1>');
await new Promise((r) => setTimeout(r, ${editingMs}));
await coordinate({action:'record'});
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture done. No model called.'}}));`;
}
/**
 * A worker that gives the shared contract the shape its own task needs. Told to hold for a
 * decision, it ends its turn the way a model with nothing else to do would.
 */
const reshapingWorker = `import {writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';
for await (const chunk of process.stdin) {}
const id = process.env.MEMCODE_TASK_ID;
const session = JSON.parse(await readFile(join('.memcode','workers',id,'context-session.json'),'utf8'));
async function coordinate(input) {
  const r = await fetch(session.endpoint,{method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:JSON.stringify({capability:'coordinate',...input})});
  if (!r.ok) throw Error(await r.text());
  return r.json();
}
const say = (text) => console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
const declared = await coordinate({action:'declare',symbols:['shared.ts::contract'],kind:'signature',plan:'Give contract the shape ' + id + ' needs.'});
if (declared.canEdit !== true) { say('Waiting for the decision.'); process.exit(0); }
await writeFile(id + '.txt', 'Reshaped by ' + id);
await coordinate({action:'record'});
say('Fixture done. No model called.');`;
async function fixture(sharedScope = false, worker?: string) {
  const root = await mkdtemp(join(tmpdir(), "memcode-fleet-test-")),
    repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await writeFile(join(repo, "README.md"), "Fleet fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@local.invalid",
    "commit",
    "-m",
    "Fixture",
  ]);
  // Connecting a previously unconfigured project can create these stores
  // before its first epic is activated. They must not block that switch.
  for (const directory of [".memdb", ".memtrace"]) {
    await mkdir(join(repo, directory));
    await writeFile(join(repo, directory, "runtime.lock"), "Local engine data");
  }
  const state = initialState();
  approveFixtureWorker(state, "codex");
  state.tasks = [];
  state.epics = [];
  state.fleetConflicts = [];
  const project = {
    ...state.projects[0],
    id: "fixture",
    path: repo,
    repoId: "fixture",
    analysis: "ready" as const,
    example: false,
  };
  state.projects = [project];
  state.settings.maxWorkers = 4;
  const epic = {
    id: "fixture-epic",
    projectId: project.id,
    identifier: "EP-01",
    title: "Shared feature",
    description: "Fixture",
    phase: "now" as const,
    color: "mint" as const,
    order: 0,
  };
  state.epics = [epic];
  const tasks: WorkItem[] = ["one", "two"].map((id) => ({
    ...initialState().tasks[0],
    id,
    identifier: `MC-${id}`,
    projectId: project.id,
    epicId: epic.id,
    example: false,
    assignment: "auto" as const,
    scope: [sharedScope ? "shared.ts" : `${id}.ts`],
    stage: "planned" as const,
    run: { state: "idle" as const },
    messages: [],
    dependsOn: [],
  }));
  state.tasks = tasks;
  const script = join(root, "fixture.mjs");
  await writeFile(
    script,
    worker ??
      workerScript(
        sharedScope ? () => "shared.ts::contract" : (id) => id + ".ts::work",
        1400,
      ),
  );
  const fleet = fleetEngine();
  const catalog: HarnessRuntime[] = [
    {
      id: "codex",
      name: "Fixture Codex",
      available: true,
      path: process.execPath,
      models: [
        { id: "fixture", label: "Fixture", tier: "extreme", source: "alias" },
      ],
    },
  ];
  const manager = new WorkerManager(
    () => state,
    async () => {},
    fleet.engine,
    join(root, "data"),
    async () => ({ command: process.execPath, prefix: [script] }),
    async () => catalog,
    undefined,
    undefined,
    startPrintFixtureSession,
  );
  const cleanup = async () => {
    await manager.close();
    assert.ok(
      within(tmpdir(), root) &&
        basename(root).startsWith("memcode-fleet-test-"),
    );
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  };
  return { state, project, epic, tasks, manager, engine: fleet, repo, cleanup };
}
async function until(check: () => boolean) {
  const end = Date.now() + 8000;
  while (!check() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(check(), "Expected worker outcome before deadline");
}

test("a worker whose turn ends while the person still has to decide is paused, and carries on by itself once they have", async () => {
  const f = await fixture(true, reshapingWorker);
  try {
    const [first, second] = f.tasks;
    await f.manager.start(first, f.project);
    await until(() => first.run.state === "finished");
    await f.manager.start(second, f.project);
    await until(() => second.run.state === "blocked");
    const [decision] = f.state.fleetConflicts;
    assert.equal(decision.needs, "decide");
    assert.equal(second.run.waitingOnDecision, decision.id);
    assert.equal(second.stage, "working", "it is not handed to review half done");
    assert.match(second.messages.at(-1)!.text, /^Paused until you decide\./);
    assert.equal(await exists(join(f.repo, "two.txt")), false, "it did not reshape the code on its own");

    await f.manager.decide(decision.id, "Use the second shape.", second.id);
    await until(() => second.messages.some((message) => /^Worker finished/.test(message.text)));
    assert.equal(await readFile(join(f.repo, "two.txt"), "utf8"), "Reshaped by two");
    const told = second.messages.find((message) => message.role === "user")!;
    assert.match(told.text, /^Decision on contract: Use the second shape\./);
    assert.match(told.text, /Your change goes ahead/);
    assert.equal(second.run.waitingOnDecision, undefined);
    assert.equal(second.stage, "review");
  } finally {
    await f.cleanup();
  }
});

test("a paused worker the person decided against is told whose change stands and to rebuild on it", async () => {
  const f = await fixture(true, reshapingWorker);
  try {
    const [first, second] = f.tasks;
    await f.manager.start(first, f.project);
    await until(() => first.run.state === "finished");
    await f.manager.start(second, f.project);
    await until(() => second.run.state === "blocked");
    await f.manager.decide(f.state.fleetConflicts[0].id, "Keep the first shape.", first.id);
    await until(() => second.run.state === "finished");
    const told = second.messages.find((message) => message.role === "user")!;
    assert.match(told.text, /^Decision on contract: Keep the first shape\./);
    assert.match(told.text, /MC-one’s change stands\. Re-read it and rebuild your task on that version/);
  } finally {
    await f.cleanup();
  }
});

/** Held, it takes a while over its last message, as a model does. */
const slowToEnd = reshapingWorker.replace(
  "{ say('Waiting for the decision.'); process.exit(0); }",
  "{ await new Promise((r) => setTimeout(r, 1500)); say('Waiting for the decision.'); process.exit(0); }",
);

test("a decision made while the worker writes its last message still brings it back", async () => {
  const f = await fixture(true, slowToEnd);
  try {
    const [first, second] = f.tasks;
    await f.manager.start(first, f.project);
    await until(() => first.run.state === "finished");
    await f.manager.start(second, f.project);
    await until(() => f.state.fleetConflicts[0]?.needs === "decide");
    assert.equal(second.run.state, "running");
    await f.manager.decide(f.state.fleetConflicts[0].id, "Use the second shape.", second.id);
    await until(() => second.messages.some((message) => /^Worker finished/.test(message.text)));
    assert.equal(await readFile(join(f.repo, "two.txt"), "utf8"), "Reshaped by two");
    const told = second.messages.find((message) => message.role === "user")!;
    assert.match(told.text, /^Decision on contract: Use the second shape\. Your change goes ahead/);
    assert.equal(second.messages.filter((message) => message.role === "user").length, 1, "once");
    assert.equal(second.stage, "review");
  } finally {
    await f.cleanup();
  }
});

/** The stage each turn's wrap-up shows the board, while MemCode collects what the worker left. */
function stagesWhileTurnsWrapUp(manager: WorkerManager, task: WorkItem): string[] {
  const seen: string[] = [];
  const collect = (manager as any).collectArtifacts.bind(manager);
  (manager as any).collectArtifacts = async (item: WorkItem, project: unknown) => {
    if (item.id === task.id && item.run.activity?.phase === "finishing") seen.push(item.stage);
    return collect(item, project);
  };
  return seen;
}

test("a worker that carries on after a decision stays in working while its turn wraps up", async () => {
  const f = await fixture(true, slowToEnd);
  try {
    const [first, second] = f.tasks;
    const wrapUps = stagesWhileTurnsWrapUp(f.manager, second);
    await f.manager.start(first, f.project);
    await until(() => first.run.state === "finished");
    await f.manager.start(second, f.project);
    await until(() => f.state.fleetConflicts[0]?.needs === "decide");
    await f.manager.decide(f.state.fleetConflicts[0].id, "Use the second shape.", second.id);
    await until(() => second.messages.some((message) => /^Worker finished/.test(message.text)));
    assert.deepEqual(wrapUps, ["working", "working"]);
    assert.equal(second.stage, "review");
  } finally {
    await f.cleanup();
  }
});

/** The third worker only wants to edit what the other two disagree about. */
const bystander = slowToEnd.replace(
  "kind:'signature'",
  "kind: id === 'three' ? 'change' : 'signature'",
);
for (const when of ["while it waits", "while it writes its last message"])
  test(`a worker that a disagreement only held off carries on when it is settled ${when}`, async () => {
    const f = await fixture(true, bystander);
    try {
      const [first, second] = f.tasks;
      const third = { ...structuredClone(second), id: "three", identifier: "MC-three" };
      f.state.tasks.push(third);
      await f.manager.start(first, f.project);
      await until(() => first.run.state === "finished");
      await f.manager.start(second, f.project);
      await until(() => f.state.fleetConflicts[0]?.needs === "decide");
      const [decision] = f.state.fleetConflicts;
      await f.manager.start(third, f.project);
      if (when === "while it waits") {
        await until(() => third.run.state === "blocked");
        assert.equal(third.run.waitingOnDecision, decision.id);
        assert.equal(third.stage, "working", "it is not handed to review half done");
      } else await until(() => third.messages.some((message) => /canEdit": false/.test(message.text)));
      await f.manager.decide(decision.id, "Use the second shape.", second.id);
      await until(() => second.stage === "review" && third.stage === "review");
      assert.equal(await readFile(join(f.repo, "three.txt"), "utf8"), "Reshaped by three");
      const told = third.messages.find((message) => message.role === "user")!;
      assert.match(told.text, /Use the second shape\. That code is free again/);
      assert.equal(decision.taskIds.includes("three"), false, "it has no say in it");
    } finally {
      await f.cleanup();
    }
  });

test("a paused worker carries on when the others settle the disagreement themselves", async () => {
  const f = await fixture(true, reshapingWorker);
  try {
    const [first, second] = f.tasks;
    await f.manager.start(first, f.project);
    await until(() => first.run.state === "finished");
    await f.manager.start(second, f.project);
    await until(() => second.run.state === "blocked");
    (f.manager.fleet as any).settled(f.state.fleetConflicts[0], {
      by: "agents",
      winnerTaskId: second.id,
      resolution: "Both fit.",
    });
    await until(() => second.run.state === "finished");
    assert.equal(await readFile(join(f.repo, "two.txt"), "utf8"), "Reshaped by two");
  } finally {
    await f.cleanup();
  }
});

test("a worker in two disagreements carries on once both are settled, and hears both", async () => {
  const f = await fixture(true, reshapingWorker);
  try {
    const [first, second] = f.tasks;
    await f.manager.start(first, f.project);
    await until(() => first.run.state === "finished");
    await f.manager.start(second, f.project);
    await until(() => second.run.state === "blocked");
    const [decision] = f.state.fleetConflicts;
    const other = {
      ...structuredClone(decision),
      id: "other",
      escalationId: undefined,
      scope: ["shared.ts::format"],
    };
    f.state.fleetConflicts.push(other);
    await f.manager.decide(decision.id, "Use the second shape.", second.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(second.run.state, "blocked");
    assert.equal(second.run.waitingOnDecision, "other");
    await f.manager.decide("other", "And the second format.", second.id);
    await until(() => second.run.state === "finished");
    const told = second.messages.filter((message) => message.role === "user");
    assert.equal(told.length, 1);
    assert.match(told[0].text, /Use the second shape\.[\s\S]*And the second format\./);
    assert.equal(second.run.decidedMeanwhile, undefined);
  } finally {
    await f.cleanup();
  }
});

/** Told that a peer is reshaping its code right now, it gives up instead of waiting. */
const impatient = reshapingWorker
  .replace("kind:'signature'", "kind: id === 'one' ? 'signature' : 'change'")
  .replace(
    "await writeFile(id + '.txt'",
    "if (id === 'one') await new Promise((r) => setTimeout(r, 2500));\nawait writeFile(id + '.txt'",
  );
test("a worker that ended while a peer was reshaping its code comes back when it is free", async () => {
  const f = await fixture(true, impatient);
  try {
    const [first, second] = f.tasks;
    await f.manager.start(first, f.project);
    await until(() => f.state.fleetDeclarations?.some((item) => item.taskId === "one") ?? false);
    await f.manager.start(second, f.project);
    await until(() => !!second.run.waitingOnCode);
    assert.equal(first.run.state, "running");
    assert.equal(second.stage, "working", "it is not handed to review half done");
    await until(() => first.stage === "review" && second.stage === "review");
    assert.equal(await readFile(join(f.repo, "two.txt"), "utf8"), "Reshaped by two");
    assert.equal(second.run.waitingOnCode, undefined);
    assert.match(
      second.messages.find((message) => message.role === "user")!.text,
      /contract is free again: the change you waited for is in/,
    );
  } finally {
    await f.cleanup();
  }
});

test("two story processes collaborate on one epic branch and one checkout", async () => {
  const f = await fixture();
  try {
    f.tasks[0].description =
      "A detailed source task. ".repeat(180) +
      "PRESERVE_FINAL_ACCEPTANCE_CRITERION";
    await f.manager.start(f.tasks[0], f.project);
    assert.match(
      await readFile(
        join(f.repo, ".memcode", "workers", f.tasks[0].id, "brief.md"),
        "utf8",
      ),
      /PRESERVE_FINAL_ACCEPTANCE_CRITERION/,
    );
    assert.ok(
      f.engine.calls
        .filter((call) => call.name === "find_code")
        .every((call) => call.args.query.length <= 1000),
    );
    await f.manager.fleet.heartbeat(f.project, f.tasks[0]);
    assert.equal(
      f.state.fleetConflicts.length,
      0,
      "Renewing one's own intent is not a peer conflict",
    );
    await f.manager.start(f.tasks[1], f.project);
    assert.equal(f.tasks[0].run.workspace, f.repo);
    await until(() => f.state.artifacts.length === 2);
    assert.ok(
      f.tasks.some((task) => task.run.state === "running"),
      "Published artifacts appear before the worker exits",
    );
    assert.equal(f.tasks[1].run.workspace, f.repo);
    assert.equal(f.tasks[0].run.branch, f.tasks[1].run.branch);
    assert.equal(
      (await git(f.repo, ["worktree", "list", "--porcelain"]))
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
      1,
    );
    await until(() =>
      f.tasks.every((task) =>
        task.messages.some((message) =>
          message.text.startsWith("Worker finished."),
        ),
      ),
    );
    for (const task of f.tasks) {
      assert.equal(task.stage, "review");
      assert.equal(task.run.state, "finished");
      assert.equal(task.run.worktree, undefined);
      assert.equal(
        await readFile(join(f.repo, task.id + ".txt"), "utf8"),
        "Shared branch change",
      );
    }
    assert.equal(f.state.artifacts.length, 2);
    assert.notEqual(f.state.artifacts[0].path, f.state.artifacts[1].path);
    const fleetCalls = f.engine.calls.filter((call) =>
      [
        "fleet_branch_context",
        "fleet_publish_intent",
        "fleet_record_episode",
      ].includes(call.name),
    );
    assert.ok(
      fleetCalls.every((call) => call.args.branch === f.tasks[0].run.branch),
    );
    assert.deepEqual(
      f.engine.calls
        .filter((call) => call.name === "fleet_publish_intent")
        .map((call) => call.args.touched)
        .sort(),
      [["one.ts::work"], ["two.ts::work"]],
      "each worker declares the symbol it changes, not a file list planned up front",
    );
    assert.equal(f.engine.counts().fleet_acquire_lease, undefined, "nothing is locked");
    assert.equal(
      (f.state.fleetDeclarations ?? []).filter((item) => !item.recordedAt).length,
      0,
      "every edit was recorded",
    );
    assert.equal(
      await git(f.repo, ["show", "main:README.md"]),
      "Fleet fixture",
    );
  } finally {
    await f.cleanup();
  }
});
test("two workers changing the same symbol edit at the same time: neither waits and nobody asks the person", async () => {
  const f = await fixture(true);
  try {
    await f.manager.start(f.tasks[0], f.project);
    await f.manager.start(f.tasks[1], f.project);
    await until(() => f.tasks.every((task) => task.run.state === "finished"));
    for (const task of f.tasks)
      assert.equal(await exists(join(f.repo, task.id + ".txt")), true);
    assert.equal(f.state.fleetConflicts.length, 0);
    assert.equal(f.engine.counts().fleet_acquire_lease, undefined);
    const activity = async (id: string) =>
      (
        await readFile(
          join(f.repo, ".memcode", "workers", id, "fleet-activity.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, any>);
    const [one, two] = await Promise.all(["one", "two"].map(activity));
    const declaredTwo = two.find((event) => event.action === "declare")!;
    const recordedOne = one.find((event) => event.action === "record")!;
    assert.equal(declaredTwo.canEdit, true);
    assert.ok(
      declaredTwo.at < recordedOne.at,
      "the second worker started editing while the first was still editing",
    );
    assert.deepEqual(
      [recordedOne.class, two.find((event) => event.action === "record")!.class],
      ["B", "B"],
      "both are told to re-read what the other changed",
    );
  } finally {
    await f.cleanup();
  }
});
