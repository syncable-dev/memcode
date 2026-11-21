import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRuntime } from "../runtime/app.ts";
import { startContextSession } from "../runtime/context/host.ts";
import { newRunbook, runbookBrief, runbookText, updateRunbook } from "../src/runbook.ts";
import type { WorkItem } from "../src/shared.ts";

/** Predictable ids: s1, s2, … */
const ids = () => {
  let next = 0;
  return () => `s${++next}`;
};
const look = (runbook: Array<{ text: string; done: boolean }>) =>
  runbook.map((step) => [step.text, step.done]);

test("a planned task starts with its own steps, and an unplanned one with the standard three", () => {
  assert.deepEqual(newRunbook(["  Add the export endpoint ", "", "Check the download"], ids()), [
    { id: "s1", text: "Add the export endpoint", done: false },
    { id: "s2", text: "Check the download", done: false },
  ]);
  for (const unplanned of [undefined, [], ["  "]])
    assert.deepEqual(
      newRunbook(unplanned, ids()).map((step) => step.text),
      [
        "Understand the relevant source and requirements",
        "Implement a focused change",
        "Review the result and checks",
      ],
    );
});

test("a worker ticks the steps it finished by number and adds a step it found", () => {
  const start = newRunbook(["Add the endpoint", "Add the button", "Check the download"], ids());
  const next = updateRunbook(start, { done: [1, 3], add: ["Handle an empty report"] }, () => "new");
  assert.deepEqual(look(next), [
    ["Add the endpoint", true],
    ["Add the button", false],
    ["Check the download", true],
    ["Handle an empty report", false],
  ]);
  assert.deepEqual(
    next.map((step) => step.id),
    ["s1", "s2", "s3", "new"],
    "existing steps keep their identity",
  );
  assert.deepEqual(look(start)[0], ["Add the endpoint", false], "the earlier runbook is untouched");
});

test("repeating an update changes nothing, and a worker never unticks a step", () => {
  const ticked = updateRunbook(newRunbook(["One", "Two"], ids()), { done: [2] }, ids());
  assert.equal(updateRunbook(ticked, { done: [2] }, ids()), ticked, "same runbook back when nothing changed");
  assert.equal(updateRunbook(ticked, {}, ids()), ticked);
  assert.equal(updateRunbook(ticked, { add: ["two", " ONE "] }, ids()), ticked, "a step already listed isn't added again");
});

test("a step number that isn't in the runbook is refused, saying how many steps there are", () => {
  const runbook = newRunbook(["One", "Two", "Three"], ids());
  assert.throws(() => updateRunbook(runbook, { done: [4] }, ids()), /Step 4 .* 3 steps/);
  assert.throws(() => updateRunbook(runbook, { done: [0] }, ids()), /Step 0 .* 3 steps/);
});

test("a worker can't flood the runbook", () => {
  const full = newRunbook(
    Array.from({ length: 100 }, (_, index) => `Step ${index + 1}`),
    ids(),
  );
  assert.throws(() => updateRunbook(full, { add: ["One more"] }, ids()), /100 steps/);
  const long = updateRunbook(newRunbook(["One"], ids()), { add: ["x".repeat(1500)] }, ids());
  assert.equal(long[1].text.length, 1000);
});

test("a worker reads the runbook as numbered lines with how far along it is", () => {
  const runbook = updateRunbook(newRunbook(["Add the endpoint", "Add the button"], ids()), { done: [1] }, ids());
  assert.equal(runbookText(runbook), "1. [x] Add the endpoint\n2. [ ] Add the button\n1 of 2 steps done.");
  assert.equal(runbookText([]), "This task has no runbook yet.");
});

test("a worker's brief numbers the runbook and says how to report progress on it", () => {
  const runbook = updateRunbook(newRunbook(["Add the endpoint", "Add the button"], ids()), { done: [1] }, ids());
  const withTool = runbookBrief(runbook, true);
  assert.match(withTool, /^Runbook \(the person follows your progress on these steps\):\n1\. \[x\] Add the endpoint\n2\. \[ \] Add the button\n/);
  assert.match(withTool, /memcode-context runbook/);
  assert.match(withTool, /done=\[its number\]/);
  assert.match(withTool, /not verification/);
  const withoutTool = runbookBrief(runbook, false);
  assert.doesNotMatch(withoutTool, /memcode-context/, "no tool is promised when the gateway isn't attached");
  assert.match(withoutTool, /final report/);
  assert.equal(runbookBrief([], true), "");
});

test("creating a task from a plan saves the planned runbook; a task made by hand gets the standard one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memcode-runbook-"));
  const runtime = await createRuntime(dir, dir, { call: async () => { throw Error("Unexpected native call"); } }, () => {});
  try {
    const projectId = runtime.store.state.projects[0].id;
    const create = (extra: object) =>
      runtime.request("task:create", {
        projectId,
        title: "Export reports",
        description: "Let customers export reports as CSV.",
        priority: "medium",
        harness: "codex",
        ...extra,
      }) as Promise<WorkItem>;
    const planned = await create({ runbook: ["Add the export endpoint", "Add the Export button"] });
    assert.deepEqual(look(planned.checklist), [
      ["Add the export endpoint", false],
      ["Add the Export button", false],
    ]);
    const byHand = await create({});
    assert.equal(byHand.checklist.length, 3);
    assert.equal(byHand.checklist[0].text, "Understand the relevant source and requirements");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("every worker gets a runbook tool through the gateway, and its updates reach the host", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-runbook-mcp-"));
  const received: unknown[] = [];
  const session = await startContextSession(
    { call: async () => ({}) },
    {
      project: {
        id: "one",
        name: "One",
        description: "Fixture",
        path: root,
        branch: "epic/one",
        repoId: "one",
        analysis: "ready",
        createdAt: new Date().toISOString(),
      },
      workerId: "bound-worker",
      branch: "epic/one",
      scope: [],
    },
    join(root, "worker"),
    {
      runbook: async (update) => {
        received.push(update);
        return "1. [x] Add the endpoint\n1 of 1 steps done.";
      },
    },
  );
  const client = new Client({ name: "runbook-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve("scripts/context-gateway.mjs"), session.configPath],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes("runbook"), `runbook tool is offered (${tools.join(", ")})`);
    const reply = await client.callTool({ name: "runbook", arguments: { done: [1], add: ["Handle an empty report"] } });
    assert.notEqual(reply.isError, true);
    assert.match((reply.content as any)[0].text, /1 of 1 steps done/);
    assert.deepEqual(received, [{ done: [1], add: ["Handle an empty report"] }]);
    const refused = await client.callTool({ name: "runbook", arguments: { done: ["first"] } }).catch((error) => ({ isError: true, error }));
    assert.equal(refused.isError, true, "a malformed update never reaches the host");
    assert.equal(received.length, 1);
  } finally {
    await client.close();
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
