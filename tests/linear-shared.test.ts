import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shipBranch } from "../runtime/goal-branch";
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
      boardState: () => at.sync?.status().state,
      boardIsNow: async () => (await at.sync?.isNow()) ?? false,
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

/** What beta.24 does with the files it finds: it keeps what it knows, and drops the rest. */
async function keptByAnOlderOne(folder: string) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const path = join(folder, "board", "sync.json");
  const file = JSON.parse(await readFile(path, "utf8"));
  delete file.newer;
  delete file.seen.trackers;
  await writeFile(path, JSON.stringify(file));
}

test("a MemCode that was older when the project was connected learns everything when it is updated", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const project = linear.project("Export", ["First"]);
  const cycle = linear.cycle("Week 48", "2026-11-19T00:00:00.000Z", "2026-11-26T00:00:00.000Z", { isActive: true });
  const one = linear.issue({ title: "one", priority: 1, assignee: linear.users.dana.id, project: project.id, milestone: project.milestones[0].id, cycle: cycle.id });
  linear.comment(one, "Seen it too");
  linear.issue({ title: "two", priority: 0 });
  await a.import();
  await agree();
  await b.at.quit();
  await keptByAnOlderOne(b.at.folder);
  // The older one had the cards without what it does not know.
  const times = new Map<string, string>();
  for (const task of b.tasks()) {
    if (task.priority === "urgent") task.priority = "high";
    if (task.priority === "none") task.priority = "low";
    task.assignee = undefined;
    task.tracker = undefined;
    times.set(task.id, task.updatedAt);
  }
  for (const goal of b.goals()) delete goal.tracker;
  for (const item of b.at.state.cycles) delete item.tracker;
  for (const comment of b.at.state.storyComments ?? []) {
    delete comment.tracker;
    comment.author = { id: "acct-alex", name: "Alex Berg", source: "memtrace" };
  }
  b.at.state.trackerKeepers = undefined;
  // And its person changed something in it.
  const two = b.tasks().find((task) => task.title === "two")!;
  Object.assign(two, { title: "two, by the older one" });
  await b.at.save();
  b.at.reopen();
  await agree();
  const theirs = b.task(one);
  assert.equal(theirs.priority, "urgent");
  assert.equal(theirs.assignee?.name, "Dana Ito");
  assert.equal(theirs.updatedAt, times.get(theirs.id), "it is no newer for that");
  assert.equal(b.tasks().find((task) => task.title.startsWith("two"))?.priority, "none");
  assert.equal(b.goals()[0].tracker?.kind, "milestone");
  assert.equal(b.at.state.storyComments!.find((comment) => comment.text === "Seen it too")?.author.source, "linear");
  assert.equal(keptElsewhere(b.at.state, b.at.projectId)?.by, "Alex Berg");
  await assert.rejects(b.import(), /Alex Berg keeps this project in step/);
  assert.equal(a.tasks().find((task) => task.title.startsWith("two"))?.title, "two, by the older one");
  await a.sync();
  await agree();
  assert.equal(a.goals().length, 1);
  assert.equal(b.at.state.cycles.filter((item) => item.projectId === b.at.projectId).length, 1);
  assert.equal(linear.issues.get(one.id)!.assignee, linear.users.dana.id);
  assert.equal(linear.issues.get(one.id)!.priority, 1);
});

test("a MemCode that was an older one for a while takes nobody's work back", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const one = linear.issue({ title: "one", priority: 1, assignee: linear.users.dana.id });
  await a.import();
  await agree();
  await b.at.quit();
  await keptByAnOlderOne(b.at.folder);
  // Meanwhile it changes there, and here everything is as it was left.
  linear.edit(one, { assignee: linear.users.alex.id, priority: 0 });
  await a.sync();
  b.at.reopen();
  await agree();
  assert.equal(b.task(one).assignee?.name, "Alex Berg");
  assert.equal(b.task(one).priority, "none");
  await a.sync();
  assert.equal(linear.issues.get(one.id)!.assignee, linear.users.alex.id);
});

test("whoever takes over with a part of a long text leaves the whole of it in Linear", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const title = "T".repeat(253), text = "x".repeat(30_000) + " THE END";
  const issue = linear.issue({ title, description: text });
  const short = linear.issue({ title: "Short", description: "Text" });
  await a.import();
  await agree();
  assert.equal(b.task(issue).title.length, 240);
  const { connection, choices } = await b.connect();
  await b.service.takeOver(connection.id);
  await agree();
  linear.clock += 60_000;
  await b.service.import(connection.id, choices);
  await b.sync();
  await b.sync();
  const there = linear.issues.get(issue.id)!;
  assert.equal(there.title, title);
  assert.equal(there.description.length, text.length);
  assert.equal(b.task(issue).title, title, "it has the whole title now");
  assert.equal(b.task(issue).tracker?.kept, undefined);
  await b.edit(b.task(issue), { description: b.task(issue).description + " and more" });
  await b.sync();
  assert.equal(linear.issues.get(issue.id)!.description.length, text.length, "a part is never sent");
  await b.edit(b.task(short), { title: "Shorter" });
  await b.sync();
  assert.equal(linear.issues.get(short.id)!.title, "Shorter");
});

test("without the shared board nothing goes to or from Linear: somebody else may do it now", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const issue = linear.issue({ title: "Export", description: "Two lines." });
  await a.import();
  await agree();
  a.at.goOffline();
  await a.at.quit();
  const { connection, choices } = await b.connect();
  await b.service.takeOver(connection.id);
  linear.clock += 60_000;
  await b.service.import(connection.id, choices);
  linear.edit(issue, { description: "Two lines about import and more." });
  await b.sync();
  // It starts without the board: it would not know that it is not its turn.
  a.at.reopen();
  await a.sync();
  await assert.rejects(a.service.look(a.connection.id), /shared board is not connected/);
  assert.equal(a.task(issue).description, "Two lines.");
  a.at.comeBack();
  await agree();
  await a.sync();
  await b.sync();
  await agree();
  assert.equal(linear.issues.get(issue.id)!.description, "Two lines about import and more.");
  assert.equal(a.task(issue).description, "Two lines about import and more.");
  assert.equal(keptElsewhere(a.at.state, a.at.projectId)?.connection, b.connection.id);
});

test("a goal's branch another computer put on the board is that one's to change", async (context) => {
  const { a, b, agree } = await team(context);
  const of = (one: typeof a) => one.goals().find((goal) => goal.id === "goal")!;
  await b.at.edit((state) =>
    state.epics.push({ id: "goal", projectId: b.at.projectId, identifier: "EP-01", title: "Export", description: "", phase: "now", color: "mint", order: 1, branch: "feat/export", baseRevision: "a".repeat(40) }),
  );
  await agree();
  assert.equal(of(a).branch, "feat/export");
  // A starts a task on a branch of its own, and that one ships.
  await a.at.edit((state) => {
    of(a).branch = "feat/export-csv";
    state.tasks.push({ id: "ours", identifier: "MC-050", projectId: a.at.projectId, title: "CSV", description: "", stage: "working", priority: "medium", category: "Work", kind: "feature", harness: "claude", checklist: [], messages: [], epicId: "goal", run: { state: "running", branch: "feat/export-csv", sessionId: "s" }, createdAt: "2026-11-21T10:00:00.000Z", updatedAt: "2026-11-21T10:00:00.000Z" });
  });
  await agree();
  assert.equal(of(b).branch, "feat/export");
  await a.at.edit(() => {
    delete of(a).branch;
  });
  await agree();
  assert.equal(of(b).branch, "feat/export");
  // Its own computer takes it away, and everyone hears so.
  await b.at.edit(() => {
    delete of(b).branch;
  });
  await agree();
  assert.equal(of(a).branch, undefined);
  assert.equal(of(a).boardBranch, undefined);
});

test("whoever takes over sends what was done on the board while the one before was away", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const issue = linear.issue({ title: "Export", description: "One line.", state: linear.states.todo.id });
  const other = linear.issue({ title: "Other" });
  await a.import();
  await agree();
  await a.edit(a.task(issue), { statusId: a.at.projectId + ":working" });
  await a.sync();
  await agree();
  await a.edit(a.task(issue), { title: "Export as CSV", description: "Two lines." });
  await a.sync();
  await agree();
  a.at.goOffline();
  linear.tick(3 * 86_400_000);
  await b.edit(b.task(issue), { statusId: b.at.projectId + ":done", title: "Export as CSV and PDF", description: "Three lines." });
  // And Linear goes on by itself, on another card.
  linear.edit(other, { title: "Other, by the team" });
  await b.edit(b.task(other), { estimate: 2 });
  linear.tick(60_000);
  const { connection, choices } = await b.connect();
  await b.service.takeOver(connection.id);
  linear.tick(60_000);
  await b.service.import(connection.id, choices);
  await b.sync();
  const there = linear.issues.get(issue.id)!;
  assert.deepEqual([there.state, there.title, there.description], [linear.states.done.id, "Export as CSV and PDF", "Three lines."]);
  assert.equal(b.task(issue).stage, "done");
  assert.equal(b.task(issue).tracker?.kept, undefined);
  assert.equal(b.task(other).title, "Other, by the team");
  assert.equal(linear.issues.get(other.id)!.title, "Other, by the team");
  assert.equal(linear.issues.get(other.id)!.estimate, 2);
  a.at.comeBack();
  await agree();
});

test("what a person unlinked or took out stays out, whoever keeps it in step", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const project = linear.project("Export", ["First"]);
  const gone = linear.issue({ title: "Deleted here" }), own = linear.issue({ title: "In Linear" });
  const inGoal = linear.issue({ title: "other", project: project.id, milestone: project.milestones[0].id });
  await a.import();
  await agree();
  await a.service.unlink(a.task(own).id);
  await a.edit(a.task(own), { title: "My own card now" });
  await a.at.edit((state) => {
    state.tasks = state.tasks.filter((task) => task.tracker?.id !== gone.id);
    state.epics = state.epics.filter((goal) => !goal.tracker);
    for (const task of state.tasks) if (task.tracker?.id === inGoal.id) task.epicId = null;
  });
  await a.sync();
  await agree();
  const { connection, choices } = await b.connect();
  await b.service.takeOver(connection.id);
  await agree();
  linear.tick(60_000);
  await b.service.import(connection.id, choices);
  linear.edit(inGoal, { title: "other, renamed" });
  await b.sync();
  await agree();
  assert.deepEqual(b.tasks().map((task) => task.title).sort(), ["My own card now", "other, renamed"]);
  assert.equal(linear.issues.get(own.id)!.title, "In Linear");
  assert.equal(b.task(own).tracker?.standing, "unlinked");
  assert.equal(b.goals().length, 0);
  assert.equal(linear.issues.get(inGoal.id)!.project, project.id);
});

test("a long title from Linear stays whole when a computer takes over again", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const issue = linear.issue({ title: "short" });
  const odd = linear.issue({ title: "odd" });
  await a.import();
  await agree();
  const { connection, choices } = await b.connect();
  await b.service.takeOver(connection.id);
  await agree();
  linear.tick(60_000);
  await b.service.import(connection.id, choices);
  await agree();
  const long = "t".repeat(250) + "END", halved = "u".repeat(239) + "😀" + "v".repeat(12);
  linear.edit(issue, { title: long });
  linear.edit(odd, { title: halved });
  linear.tick(60_000);
  await b.sync();
  await agree();
  await a.service.takeOver(a.connection.id);
  await agree();
  linear.tick(60_000);
  await a.sync();
  await agree();
  await a.sync();
  assert.equal(linear.issues.get(issue.id)!.title, long);
  assert.equal(linear.issues.get(odd.id)!.title, halved);
});

test("a board whose stream is silent is asked before anything goes to Linear", async (context) => {
  const { linear, a, b, agree } = await team(context);
  const issue = linear.issue({ title: "Export", description: "One line about export." });
  await a.import();
  await agree();
  // As after a sleep: the stream says nothing, and has not ended yet.
  const stream = a.at.sync as unknown as { arrive: () => undefined };
  const arrive = stream.arrive;
  stream.arrive = () => undefined;
  const { connection, choices } = await b.connect();
  await b.service.takeOver(connection.id);
  linear.tick(8 * 3_600_000);
  await b.service.import(connection.id, choices);
  linear.edit(issue, { description: "Two lines about import and more." });
  await b.sync();
  assert.equal(a.at.sync.status().state, "synced");
  await a.sync();
  stream.arrive = arrive;
  await a.at.quit();
  a.at.reopen();
  await agree();
  linear.tick(60_000);
  await b.sync();
  await agree();
  assert.equal(linear.issues.get(issue.id)!.description, "Two lines about import and more.");
  // A service that does not answer is no answer.
  a.at.isSilent = true;
  const asked = Date.now();
  assert.equal(await a.at.sync.isNow(), false);
  assert.ok(Date.now() - asked < 15_000);
  a.at.isSilent = false;
});

test("a branch that was brought here and shipped from here is nobody's on the board", async (context) => {
  const { a, b, agree } = await team(context);
  const of = (one: typeof a) => one.goals().find((goal) => goal.id === "goal")!;
  await a.at.edit((state) =>
    state.epics.push({ id: "goal", projectId: a.at.projectId, identifier: "EP-01", title: "Export", description: "", phase: "now", color: "mint", order: 1, branch: "feat/x" }),
  );
  await agree();
  const work = (id: string, changes: Partial<WorkItem>): WorkItem => ({ id, identifier: "MC-0" + id.length, projectId: b.at.projectId, title: id, description: "", stage: "review", priority: "medium", category: "Work", kind: "feature", harness: "claude", checklist: [], messages: [], epicId: "goal", run: { state: "finished", branch: "feat/x", sessionId: "s" }, createdAt: "2026-11-21T10:00:00.000Z", updatedAt: "2026-11-21T10:00:00.000Z", ...changes });
  await b.at.edit((state) => {
    state.tasks.push(work("done", {}), work("to do", { stage: "planned", run: { state: "idle" } }));
  });
  await agree();
  await b.at.edit((state) => void shipBranch(state, of(b), "feat/x", "2026-11-21T11:00:00.000Z"));
  await agree();
  assert.equal(of(b).branch, undefined);
  assert.equal(of(a).branch, undefined, "its next task does not start on a branch that merged");
});

/** B keeps it from now on, and has looked. */
async function handOver(
  { linear, agree }: Awaited<ReturnType<typeof team>>,
  to: Awaited<ReturnType<typeof team>>["a"],
  changes: Partial<TrackerChoices> = {},
) {
  if (!to.at.state.trackers?.length) await to.connect();
  await to.service.takeOver(to.connection.id);
  await agree();
  linear.tick(60_000);
  linear.calls.length = 0;
  if (!to.connection.importedAt) await to.import(changes);
  await to.sync();
  await agree();
  return linear.calls.filter((call) => call.operation === "UpdateIssue").map((call) => call.variables.input);
}

test("taking over again leaves what a colleague changed in Linear meanwhile", async (context) => {
  const t = await team(context);
  const { linear, a, b, agree } = t;
  const issue = linear.issue({ title: "v0", description: "text" });
  await a.import();
  await agree();
  await handOver(t, b);
  linear.edit(issue, { title: "vB" });
  linear.tick(40_000);
  await b.sync();
  await agree();
  linear.tick(3_600_000);
  linear.edit(issue, { title: "v1" });
  linear.tick(3_600_000);
  await a.edit(a.task(issue), { startDate: "2026-11-22" });
  await agree();
  assert.deepEqual(await handOver(t, a), []);
  assert.equal(linear.issues.get(issue.id)!.title, "v1");
  assert.equal(a.task(issue).title, "v1");
});

test("connecting again and taking over sends what was done on the board since", async (context) => {
  const t = await team(context);
  const { linear, a, b, agree } = t;
  const issue = linear.issue({ title: "v0", description: "text" });
  await b.import();
  await agree();
  await b.service.disconnect(b.connection.id);
  await agree();
  await a.import();
  await agree();
  linear.tick(3_600_000);
  await a.edit(a.task(issue), { title: "v1" });
  await a.sync();
  await agree();
  linear.tick(3_600_000);
  await b.edit(b.task(issue), { title: "v2" });
  await agree();
  assert.deepEqual(await handOver(t, b), [{ title: "v2" }]);
  assert.equal(a.task(issue).title, "v2");
});

test("what was held back from Linear is not put back by the next one", async (context) => {
  const t = await team(context);
  const { linear, a, b, agree } = t;
  const [p, q] = ["Export", "Billing"].map((name) => linear.project(name));
  const issue = linear.issue({ title: "x", project: p.id });
  linear.issue({ title: "y", project: q.id });
  await a.import();
  await agree();
  const task = a.task(issue);
  await a.at.edit(() => {
    Object.assign(task.run, { state: "finished", startedAt: "2026-11-21T09:30:00.000Z", branch: "feat/x" });
    Object.assign(task, { stage: "review", statusId: a.at.projectId + ":review" });
  });
  await a.sync();
  await agree();
  linear.edit(issue, { project: q.id });
  linear.tick(40_000);
  await a.sync();
  assert.match(a.task(issue).tracker?.note ?? "", /stays in its goal/);
  await a.edit(a.task(issue), { title: "x, renamed" });
  await a.sync();
  await agree();
  linear.tick(3_600_000);
  await handOver(t, b);
  assert.equal(linear.issues.get(issue.id)!.project, q.id);
  assert.equal(linear.issues.get(issue.id)!.title, "x, renamed");
});

test("a hand-over moves no issue that nobody moved", async (context) => {
  const t = await team(context);
  const { linear, a, b, agree } = t;
  const ready = [1, 2, 3].map((n) => linear.issue({ title: "R" + n, state: linear.states.ready.id }));
  const failed = linear.issue({ title: "x" });
  const words = linear.issue({ title: "words", description: "old" });
  const { connection, choices } = await a.connect();
  await a.service.import(connection.id, { ...choices, lanes: { ...choices.lanes, [linear.states.ready.id]: a.at.projectId + ":working" } });
  await agree();
  await a.at.edit(() => {
    const task = a.task(failed);
    Object.assign(task.run, { state: "failed", startedAt: "2026-11-21T09:30:00.000Z", branch: "feat/x" });
    Object.assign(task, { stage: "review", statusId: a.at.projectId + ":review", updatedAt: linear.tick() });
  });
  await a.edit(a.task(words), { description: "- one\n- two" });
  await a.sync();
  await a.sync();
  await agree();
  assert.equal(linear.issues.get(failed.id)!.state, linear.states.progress.id);
  linear.tick(3_600_000);
  assert.deepEqual(await handOver(t, b), []);
  for (const issue of ready) assert.equal(linear.issues.get(issue.id)!.state, linear.states.ready.id);
  assert.equal(linear.issues.get(failed.id)!.state, linear.states.progress.id);
});

test("where only Linear was followed, what was done here meanwhile is nobody's to send", async (context) => {
  const t = await team(context);
  const { linear, a, b, agree } = t;
  const issue = linear.issue({ title: "A", description: "text" });
  await a.import({ direction: "in" });
  await agree();
  await b.edit(b.task(issue), { title: "note to self" });
  await a.sync();
  await agree();
  assert.deepEqual(await handOver(t, b), []);
  assert.equal(linear.issues.get(issue.id)!.title, "A");
  await b.edit(b.task(issue), { priority: "high" });
  await b.sync();
  assert.equal(linear.issues.get(issue.id)!.priority, 2);
  assert.equal(linear.issues.get(issue.id)!.title, "A");
});

test("whatever was in step, a hand-over sends what was changed on the board since, and nothing else", async (context) => {
  const runs = Number(process.env.LINEAR_SHARED_RUNS ?? 4);
  for (let seed = 1; seed <= runs; seed++) {
    const t = await team(context);
    const { linear, a, b, agree } = t;
    let turn = seed * 104_729;
    const roll = (sides: number) => {
      turn = (Math.imul(turn ^ (turn >>> 15), 1 | turn) + 0x6d2b79f5) | 0;
      const mixed = Math.imul(turn ^ (turn >>> 7), 61 | turn) ^ turn;
      return ((mixed ^ (mixed >>> 14)) >>> 0) % sides;
    };
    const pick = <T>(list: readonly T[]): T => list[roll(list.length)];
    const labels = ["red", "green", "blue"].map((name) => linear.label(name));
    const states = [linear.states.backlog, linear.states.todo, linear.states.ready, linear.states.progress, linear.states.review, linear.states.done];
    const issues = Array.from({ length: 5 }, (_, n) => linear.issue({ title: "Issue " + n, description: "Start " + n, state: pick(states.slice(0, 5)).id, priority: roll(5) }));
    await a.import();
    await agree();
    let words = 0;
    const steps: string[] = [];
    const there = (issue: FakeIssue, field: string) =>
      linear.edit(issue, ({
        title: { title: "there " + ++words },
        description: { description: "there " + ++words },
        priority: { priority: (issue.priority + 1 + roll(4)) % 5 },
        dueDate: { dueDate: "2026-12-" + String(10 + (++words % 20)) },
        labels: { labels: labels.filter(() => roll(2)).map((label) => label.id) },
        status: { state: pick(states.filter((state) => state.id !== issue.state)).id },
        assignee: { assignee: issue.assignee === linear.users.dana.id ? linear.users.alex.id : linear.users.dana.id },
      } as Record<string, Partial<FakeIssue>>)[field]);
    const here = async (who: typeof a, issue: FakeIssue, field: string) => {
      const task = who.task(issue);
      const lanes = ["working", "done"].filter((lane) => task.statusId !== who.at.projectId + ":" + lane && task.stage !== lane);
      await who.edit(task, ({
        title: { title: "here " + ++words },
        description: { description: "here " + ++words + "\n- a\n- b" },
        priority: { priority: pick((["urgent", "high", "medium", "low", "none"] as const).filter((value) => value !== task.priority)) },
        dueDate: { dueDate: "2027-01-" + String(10 + (++words % 20)) },
        labels: { labels: [...(task.labels ?? []).filter((label) => !label.startsWith("new")), "new " + ++words] },
        status: { statusId: who.at.projectId + ":" + pick(lanes) },
        assignee: { assignee: task.assignee?.id === linear.users.dana.id ? null : { id: linear.users.dana.id, name: "Dana Ito" } },
      } as Record<string, Parameters<typeof applyTaskPatch>[2]>)[field]);
    };
    const fields = ["title", "description", "priority", "dueDate", "labels", "status", "assignee"];
    for (let n = 0; n < 25; n++) {
      const issue = pick(issues), field = pick(fields);
      linear.tick(5000);
      if (roll(2)) there(issue, field);
      else {
        await here(roll(2) ? a : b, issue, field);
        await agree();
      }
      if (roll(2)) {
        linear.tick(40_000);
        await a.sync();
        await agree();
      }
      if (roll(8) === 0)
        await a.at.edit(() => {
          const task = a.task(issue);
          Object.assign(task.run, { state: pick(["failed", "stopped", "finished"]), startedAt: "2026-11-21T09:30:00.000Z", branch: "feat/x" });
          Object.assign(task, { stage: "review", statusId: a.at.projectId + ":review", updatedAt: linear.tick() });
        });
    }
    linear.tick(400_000);
    await a.sync();
    linear.tick(400_000);
    await a.sync();
    await agree();
    // It is away, and both sides go on, each with fields of its own.
    const mine = new Set<string>(), theirs = new Set<string>();
    for (let n = 0; n < roll(8); n++) {
      const issue = pick(issues), field = pick(fields), key = issue.id + field;
      if (mine.has(key) || theirs.has(key)) continue;
      linear.tick(60_000);
      steps.push(linear.key(issue) + " " + field);
      if (roll(2)) {
        theirs.add(key);
        there(issue, field);
      } else {
        mine.add(key);
        await here(b, issue, field);
        await agree();
      }
    }
    const before = new Map(issues.map((issue) => [issue.id, structuredClone(linear.issues.get(issue.id)!)]));
    linear.tick(3_600_000);
    await handOver(t, b);
    linear.tick(400_000);
    await b.sync();
    const told = `run ${seed}: ${steps.join(", ")}`;
    const names: Record<string, keyof FakeIssue> = { title: "title", description: "description", priority: "priority", dueDate: "dueDate", labels: "labels", status: "state", assignee: "assignee" };
    for (const issue of issues) {
      const now = linear.issues.get(issue.id)!, was = before.get(issue.id)!;
      for (const field of fields) {
        const key = issue.id + field, of = `${told}: ${linear.key(issue)} ${field}`;
        if (!mine.has(key)) assert.deepEqual(now[names[field]], was[names[field]], of + " was nobody's to change");
        // A stopped worker's card had Linear say In Progress already.
        else if (field === "status")
          assert.equal(now.state, b.task(issue).stage === "done" ? linear.states.done.id : linear.states.progress.id, of);
        else assert.notDeepEqual(now[names[field]], was[names[field]], of + " was changed on the board");
      }
      assert.equal(b.task(issue).tracker?.kept, undefined, told);
      assert.equal(b.task(issue).title, now.title, told);
    }
  }
});
