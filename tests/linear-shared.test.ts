import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTaskPatch } from "../runtime/task-planning";
import { LinearAuth } from "../runtime/trackers/linear/auth";
import { LinearService } from "../runtime/trackers/linear/service";
import { keptElsewhere, type TrackerChoices } from "../src/tracker";
import type { WorkItem } from "../src/shared";
import { agree, computer, type Computer } from "./support/board-computers";
import { FakeLinear, type FakeIssue } from "./support/fake-linear";
import { keptTokens } from "./support/linear-world";
import { startStandInMemsync } from "./support/memsync-stand-in";
import { cast, signedInTo } from "./support/projects-api-scenarios";

/** Two people on one shared project, each with a MemCode, and the team's Linear. */
async function team(context: test.TestContext) {
  const memsync = await startStandInMemsync();
  const world = {
    address: memsync.address,
    tokenFor: (person: any) => memsync.tokenFor(person),
    close: () => memsync.close(),
  };
  const people = cast();
  const alex = signedInTo(world, people.alex);
  const shared = await alex.website.startProject("Website");
  const linear = new FakeLinear();
  // Before the time the stand-in's log gives what is new on the board.
  linear.clock = Date.parse("2026-11-21T10:00:00.000Z");
  const folders: string[] = [];
  /** MemCode on one computer, with board sync and a Linear connection of its own. */
  const open = async (name: string) => {
    const at = await computer(world, people.alex, name);
    const dataDir = await mkdtemp(join(tmpdir(), `memcode-${name}-linear-`));
    folders.push(dataDir);
    const { store } = keptTokens();
    const service = new LinearService({
      state: () => at.state,
      changed: async () => {
        await at.save();
        await at.sync.capture();
      },
      dataDir,
      auth: new LinearAuth({ store, clientId: "client", openExternal: async () => {}, fetch: linear.fetch, clock: () => linear.clock }),
      tokens: store,
      fetch: linear.fetch,
      clock: () => linear.clock,
      timers: false,
    });
    return {
      at,
      service,
      task: (issue: FakeIssue) => at.state.tasks.find((item) => item.tracker?.id === issue.id) as WorkItem,
      tasks: () => at.state.tasks.filter((item) => item.projectId === at.projectId),
      goals: () => at.state.epics.filter((item) => item.projectId === at.projectId),
      get connection() {
        return at.state.trackers!.find((item) => item.projectId === at.projectId)!;
      },
      async connect() {
        const connection = await service.connect(at.projectId, "key-good");
        const preview = await service.preview(connection.id, linear.team.id);
        return { connection, choices: preview.suggested };
      },
      async import(changes: Partial<TrackerChoices> = {}) {
        const { connection, choices } = await this.connect();
        return service.import(connection.id, { ...choices, ...changes });
      },
      sync: () => service.sync(at.state.trackers![0].id),
      edit: (task: WorkItem, patch: Parameters<typeof applyTaskPatch>[2]) =>
        at.edit((state) =>
          applyTaskPatch(state, state.tasks.find((item) => item.id === task.id)!, patch, linear.tick()),
        ),
    };
  };
  const a = await open("mac");
  const b = await open("pc");
  a.at.connect(shared);
  b.at.connect(shared);
  await agree(a.at, b.at);
  context.after(async () => {
    for (const one of [a, b]) {
      await one.service.stop();
      await one.at.close();
    }
    alex.close();
    await memsync.close();
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
  });
  return { linear, a, b, agree: () => agree(a.at as Computer, b.at as Computer) };
}

test("what one person brings in and edits, everyone on the project has", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const project = linear.project("Export", ["First"]);
  const issue = linear.issue({ title: "Export as CSV", description: "One line.", priority: 1, project: project.id, milestone: project.milestones[0].id, assignee: linear.users.dana.id });
  await a.import();
  await agree();
  const theirs = b.task(issue);
  assert.equal(theirs.title, "Export as CSV");
  assert.equal(theirs.priority, "urgent");
  assert.equal(theirs.assignee?.name, "Dana Ito");
  assert.equal(theirs.tracker?.key, linear.key(issue));
  assert.equal(b.goals().length, 1);
  // The other person, who is not connected to Linear, works on it.
  await b.edit(theirs, { title: "Export as CSV and TSV", priority: "low" });
  await agree();
  await a.sync();
  assert.equal(linear.issues.get(issue.id)!.title, "Export as CSV and TSV");
  assert.equal(linear.issues.get(issue.id)!.priority, 4);
  linear.edit(issue, { description: "Two lines." });
  await a.sync();
  await agree();
  assert.equal(b.task(issue).description, "Two lines.");
  // And makes a task, which becomes one issue.
  await b.at.edit((state) => {
    const at = linear.tick();
    state.tasks.push({ ...structuredClone(theirs), id: crypto.randomUUID(), identifier: "MC-900", title: "Made by the other", tracker: undefined, createdAt: at, updatedAt: at });
  });
  await agree();
  await a.sync();
  await agree();
  assert.equal([...linear.issues.values()].filter((item) => item.title === "Made by the other").length, 1);
  assert.ok(b.at.state.tasks.find((task) => task.title === "Made by the other")!.tracker?.key);
});

test("two people who both connect do not write the same change twice", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const issue = linear.issue({ title: "Export as CSV", description: "One line." });
  const project = linear.project("Export", ["First"]);
  await a.import();
  await agree();
  assert.equal(keptElsewhere(b.at.state, b.at.projectId)?.by, "Alex Berg");
  await assert.rejects(b.import(), /Alex Berg keeps this project in step/);
  await agree();
  assert.equal(b.tasks().length, 1);
  for (let n = 0; n < 4; n++) {
    linear.edit(issue, { description: `One line.\n\nAnd number ${n}.`, title: `Title ${n}`, milestone: project.milestones[0].id, project: project.id });
    linear.comment(issue, `Comment ${n}`);
    // Both look before either has heard from the other.
    await Promise.all([a.sync(), b.sync()]);
    await agree();
    linear.tick(40_000);
    await Promise.all([a.sync(), b.sync()]);
    await agree();
    assert.equal(a.task(issue).description, `One line.\n\nAnd number ${n}.`);
    assert.equal(linear.issues.get(issue.id)!.description, `One line.\n\nAnd number ${n}.`);
    assert.equal(a.goals().length, 1);
    assert.deepEqual(
      (a.at.state.storyComments ?? []).map((item) => item.text).sort(),
      Array.from({ length: n + 1 }, (_, at) => `Comment ${at}`),
    );
  }
  await a.edit(a.task(issue), { description: "Written here." });
  await b.edit(b.task(issue), { title: "Named there" });
  await agree();
  await Promise.all([a.sync(), b.sync()]);
  await agree();
  assert.equal(linear.issues.get(issue.id)!.description, "Written here.");
  assert.equal(linear.issues.get(issue.id)!.title, "Named there");
});

test("another person takes over, and the first one stops by itself", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const issue = linear.issue({ title: "Export as CSV", description: "One line." });
  await a.import();
  await agree();
  const { connection } = await b.connect();
  await b.service.takeOver(connection.id);
  await agree();
  assert.equal(keptElsewhere(b.at.state, b.at.projectId), undefined);
  assert.equal(keptElsewhere(a.at.state, a.at.projectId)?.connection, connection.id);
  linear.tick(60_000);
  await b.import();
  await agree();
  assert.equal(b.tasks().length, 1);
  linear.calls.length = 0;
  await a.edit(a.task(issue), { title: "Edited by the first" });
  linear.edit(issue, { description: "Two lines." });
  await a.sync();
  assert.equal(linear.calls.length, 0, "the first one asks Linear nothing any more");
  await agree();
  await b.sync();
  await agree();
  assert.equal(linear.issues.get(issue.id)!.title, "Edited by the first");
  assert.equal(a.task(issue).description, "Two lines.");

  // And back, after a while in which both sides moved on without the first.
  linear.edit(issue, { title: "Third" });
  linear.tick(60_000);
  await b.sync();
  await agree();
  await a.service.takeOver(a.connection.id);
  await agree();
  linear.tick(60_000);
  linear.calls.length = 0;
  await Promise.all([a.sync(), b.sync()]);
  await agree();
  assert.equal(a.task(issue).title, "Third");
  assert.equal(linear.issues.get(issue.id)!.title, "Third");
  assert.deepEqual(linear.calls.map((call) => call.operation).filter((name) => /^(Update|Create)/.test(name)), []);
});

test("when the one that kept it disconnects, the other goes on, and nothing is doubled", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const issue = linear.issue({ title: "Export as CSV", description: "One line." });
  linear.comment(issue, "Which columns?");
  await a.import();
  await agree();
  await a.service.disconnect(a.connection.id);
  await agree();
  assert.equal(b.at.state.trackerKeepers?.length ?? 0, 0);
  await b.import();
  await agree();
  assert.equal(a.tasks().length, 1);
  assert.equal(a.at.state.storyComments!.length, 1);
  assert.equal(keptElsewhere(a.at.state, a.at.projectId)?.connection, b.connection.id);
  linear.edit(issue, { title: "From the second", description: "Two lines." });
  await b.sync();
  await agree();
  assert.equal(a.task(issue).title, "From the second");
  assert.equal(a.task(issue).description, "Two lines.");
});

test("two that start at the same moment end with one keeper and one card each", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const issues = [1, 2, 3].map((n) => linear.issue({ title: `Issue ${n}`, description: `Line ${n}.` }));
  linear.comment(issues[0], "Which columns?");
  await Promise.all([a.import(), b.import()]);
  await agree();
  assert.equal(a.tasks().length, 3);
  assert.equal(a.at.state.storyComments!.length, 1);
  assert.equal(a.at.state.trackerKeepers![0].connection, b.at.state.trackerKeepers![0].connection);
  for (const issue of issues) linear.edit(issue, { description: issue.description + "\n\nMore." });
  await Promise.all([a.sync(), b.sync()]);
  await agree();
  for (const issue of issues) assert.equal(a.task(issue).description, linear.issues.get(issue.id)!.description);
  assert.ok(issues.every((issue) => /More\.$/.test(linear.issues.get(issue.id)!.description ?? "")));
  assert.equal(new Set(a.tasks().map((task) => task.identifier)).size, 3);
});

test("a board kept by a MemCode from before this is read as it is", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const issue = linear.issue({ title: "Export as CSV" });
  await a.import();
  await agree();
  a.at.goOffline();
  await a.edit(a.task(issue), { title: "Written offline" });
  await a.at.quit();
  a.at.comeBack();
  const { readFile, writeFile } = await import("node:fs/promises");
  const path = join(a.at.folder, "board", "sync.json");
  const kept = JSON.parse(await readFile(path, "utf8"));
  delete kept.seen.trackers;
  await writeFile(path, JSON.stringify(kept));
  a.at.reopen();
  await agree();
  assert.equal(b.task(issue).title, "Written offline");
});

test("whatever two people and Linear do, with hand-overs in between, all three end up the same", async (context) => {
  const runs = Number(process.env.LINEAR_SHARED_RUNS ?? 4);
  for (let seed = 1; seed <= runs; seed++) {
    const { linear, a, b, agree } = await team(context);
    let turn = seed * 7919;
    const roll = (sides: number) => {
      turn = (Math.imul(turn ^ (turn >>> 15), 1 | turn) + 0x6d2b79f5) | 0;
      const mixed = Math.imul(turn ^ (turn >>> 7), 61 | turn) ^ turn;
      return ((mixed ^ (mixed >>> 14)) >>> 0) % sides;
    };
    const project = linear.project("Export", ["First", "Second"]);
    const issues = [1, 2, 3].map((n) =>
      linear.issue({ title: `Issue ${n}`, description: `Start ${n}.`, project: project.id, milestone: project.milestones[n % 2].id }),
    );
    await a.import();
    await agree();
    await b.connect();
    let keeper = a;
    let words = 0;
    let trouble = true;
    linear.before = () => (trouble && roll(8) === 0 ? "offline" : undefined);
    const steps: string[] = [];
    for (let step = 0; step < 60; step++) {
      const issue = issues[roll(issues.length)];
      const word = `w${++words}.`;
      const what = roll(10);
      if (what < 3) {
        steps.push(`there ${word}`);
        linear.edit(issue, roll(2) ? { description: `Text ${word}` } : { title: `Title ${word}` });
        if (roll(4) === 0) linear.comment(issue, `Comment ${word}`);
      } else if (what < 6) {
        const who = roll(2) ? a : b;
        steps.push(`${who === a ? "a" : "b"} ${word}`);
        await who.edit(who.task(issue), roll(2) ? { description: `Text ${word}` } : { title: `Title ${word}` });
        await agree();
      } else if (what < 9) {
        linear.tick(roll(3) * 40_000);
        steps.push("look");
        // Both look, whoever keeps it.
        await Promise.all([a, b].map((one) => one.sync().catch(() => {})));
        await agree();
      } else if (roll(2)) {
        keeper = keeper === a ? b : a;
        steps.push(`${keeper === a ? "a" : "b"} takes over`);
        await keeper.service.takeOver(keeper.connection.id);
        await agree();
        linear.tick(60_000);
        trouble = false;
        if (!keeper.connection.importedAt) await keeper.import();
        trouble = true;
        await agree();
      }
    }
    trouble = false;
    for (let n = 0; n < 4; n++) {
      linear.tick(400_000);
      await Promise.all([a, b].map((one) => one.sync().catch(() => {})));
      await agree();
    }
    const told = `run ${seed}: ${steps.join(", ")}`;
    for (const issue of issues) {
      const there = linear.issues.get(issue.id)!;
      for (const one of [a, b]) {
        assert.equal(one.task(issue).title, there.title, told);
        assert.equal(one.task(issue).description, there.description, told);
      }
      assert.match(there.description ?? "", /^(Text w\d+\.|Start \d\.)$/, told);
    }
    assert.equal(a.tasks().length, 3, told);
    const texts = (a.at.state.storyComments ?? []).map((item) => item.text);
    assert.deepEqual([...new Set(texts)].sort(), [...texts].sort(), told);
    assert.equal(texts.length, linear.comments.size, told);
  }
});
