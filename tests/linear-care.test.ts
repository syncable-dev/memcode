import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultWorkflow } from "../src/planning/workflow";
import { registerPlanningControls } from "../runtime/planning-controls";
import { applySharedSnapshot, projectSharedState } from "../runtime/team/projection";
import { linearWorld, type LinearWorld } from "./support/linear-world";

/** What must not happen to a team's Linear, or to work on a card here. */
const using = async (run: (w: LinearWorld) => Promise<void>) => {
  const w = await linearWorld();
  try {
    await run(w);
  } finally {
    await w.end();
  }
};
const said = (w: LinearWorld) =>
  w.linear.calls.filter((call) => /^(Update|Create|Delete|Link)/.test(call.operation));
const named = (w: LinearWorld, ids: string[]) =>
  ids.map((id) => w.linear.labels.get(id)!.name).sort();

test("connected again, newer values in Linear stay and what is here is kept on the card", () =>
  using(async (w) => {
    const { linear } = w;
    const one = linear.issue({ title: "Old title", description: "Old text", priority: 3 });
    const two = linear.issue({ title: "Footer" });
    const { connection, choices } = await w.imported();
    await w.service.disconnect(connection.id);
    linear.edit(one, { title: "New title", description: "New text", priority: 1, dueDate: "2026-12-24" });
    // Touched here later, in something Linear does not even hold.
    w.edit(w.task(one), { startDate: "2026-11-26" });
    w.edit(w.task(two), { title: "Footer here" });
    const again = await w.service.connect(w.projectId, "key-good");
    await w.service.import(again.id, choices);
    await w.sync();
    const issue = linear.issues.get(one.id)!;
    assert.deepEqual([issue.title, issue.description, issue.priority, issue.dueDate], ["New title", "New text", 1, "2026-12-24"]);
    assert.equal(w.task(one).title, "New title");
    assert.equal(w.task(one).startDate, "2026-11-26");
    assert.equal(linear.issues.get(two.id)!.title, "Footer here", "changed here only, so it is sent");
    assert.ok(w.state.tasks.every((task) => task.tracker?.standing === "synced"));
    assert.equal((await readdir(join(w.dataDir, "trackers"))).length, 1, "nothing is left of the one before");
  }));

test("connected again, also what is not brought in this time is as Linear has it", () =>
  using(async (w) => {
    const issue = w.linear.issue({ title: "Export" });
    const { connection, choices } = await w.imported();
    await w.service.disconnect(connection.id);
    w.linear.edit(issue, { state: w.linear.states.done.id });
    const again = await w.service.connect(w.projectId, "key-good");
    await w.service.import(again.id, choices);
    await w.sync();
    assert.equal(w.task(issue).stage, "done");
    assert.equal(w.task(issue).tracker?.standing, "synced");
    assert.equal(said(w).length, 0);
  }));

test("when what was agreed on is lost, Linear's newer value stays", () =>
  using(async (w) => {
    const { linear } = w;
    const there = linear.issue({ title: "Old" });
    const here = linear.issue({ title: "Footer" });
    await w.imported();
    await w.service.stop();
    linear.edit(there, { title: "Newer in Linear" });
    w.edit(w.task(there), { startDate: "2026-11-26" });
    w.edit(w.task(here), { title: "Footer here" });
    for (const file of await readdir(join(w.dataDir, "trackers")))
      await writeFile(join(w.dataDir, "trackers", file), "{ truncated");
    await w.restart();
    await w.sync();
    await w.sync();
    assert.equal(linear.issues.get(there.id)!.title, "Newer in Linear");
    assert.equal(w.task(there).title, "Newer in Linear");
    assert.equal(w.task(there).tracker?.kept?.[0].shown, "Old");
    assert.equal(linear.issues.get(here.id)!.title, "Footer here", "Linear has not changed it since");
  }));

test("a file that cannot be read now is not taken for an empty one", () =>
  using(async (w) => {
    const issue = w.linear.issue({ title: "Old" });
    const { connection } = await w.imported();
    await w.service.stop();
    const path = join(w.dataDir, "trackers", connection.id + ".json");
    const { readFile } = await import("node:fs/promises");
    const was = await readFile(path, "utf8");
    await rm(path);
    await mkdir(path);
    w.linear.edit(issue, { title: "Newer in Linear" });
    w.edit(w.task(issue), { title: "Here" });
    await w.restart();
    w.service.noticed();
    await assert.rejects(w.sync());
    assert.equal(said(w).length, 0);
    await rm(path, { recursive: true });
    await writeFile(path, was);
    await w.sync();
    assert.equal(linear(w, issue.id).title, "Here", "the newest, once it can be read");
  }));
const linear = (w: LinearWorld, id: string) => w.linear.issues.get(id)!;

test("what a person took out stays out when work is brought in again", () =>
  using(async (w) => {
    const gone = w.linear.issue({ title: "Deleted here" });
    const own = w.linear.issue({ title: "Unlinked" });
    const { connection, choices } = await w.imported();
    await w.service.unlink(w.task(own).id);
    w.edit(w.task(own), { title: "My own way" });
    w.state.tasks = w.state.tasks.filter((task) => task.tracker!.id !== gone.id);
    await w.service.import(connection.id, choices);
    await w.sync();
    assert.deepEqual(w.state.tasks.map((task) => task.title), ["My own way"]);
    assert.equal(w.state.tasks[0].tracker?.standing, "unlinked");
    assert.equal(linear(w, own.id).title, "Unlinked");
    // Connecting anew is the way back for what was deleted; the unlinked card stays unlinked.
    await w.service.disconnect(connection.id);
    const again = await w.service.connect(w.projectId, "key-good");
    await w.service.import(again.id, choices);
    await w.sync();
    assert.deepEqual(w.state.tasks.map((task) => task.title).sort(), ["Deleted here", "My own way"]);
    assert.equal(w.task(own).tracker?.standing, "unlinked");
    assert.equal(linear(w, own.id).title, "Unlinked");
  }));

test("bringing work in again misses nothing that changed in Linear since the last look", () =>
  using(async (w) => {
    const { linear } = w;
    const open = linear.issue({ title: "Open" }), done = linear.issue({ title: "Done soon" });
    const { connection, choices } = await w.imported();
    linear.edit(open, { estimate: 3 });
    linear.edit(done, { state: linear.states.done.id });
    linear.comment(done, "Shipped");
    linear.tick(600_000);
    await w.service.import(connection.id, choices);
    assert.equal(w.task(open).estimate, 3);
    await w.sync();
    assert.equal(w.task(done).stage, "done");
    assert.equal(w.state.storyComments?.filter((comment) => comment.text === "Shipped").length, 1);
    assert.equal(said(w).length, 0);
  }));

test("new tasks become issues only from when that is chosen", () =>
  using(async (w) => {
    w.linear.issue({ title: "A" });
    const { connection, choices } = await w.imported({ createIssues: false });
    for (let n = 0; n < 3; n++) w.newTask({ title: "private " + n });
    await w.sync();
    await w.service.import(connection.id, { ...choices, createIssues: true });
    await w.sync();
    assert.equal(w.linear.issues.size, 1);
    const later = w.newTask({ title: "From now on" });
    await w.sync();
    assert.ok(w.linear.issues.has(later.id));
    // Chosen still, and brought in once more: nothing is forgotten.
    const one = w.newTask({ title: "Between" });
    await w.service.import(connection.id, { ...choices, createIssues: true });
    await w.sync();
    assert.ok(w.linear.issues.has(one.id));
    assert.equal(w.linear.issues.size, 3);
  }));

test("changes here are sent only from when that is chosen", () =>
  using(async (w) => {
    const issue = w.linear.issue({ title: "A", description: "text" });
    const { connection, choices } = await w.imported({ direction: "in" });
    const task = w.task(issue);
    const remark = (text: string) =>
      (w.state.storyComments ??= []).push({
        id: crypto.randomUUID(),
        taskId: task.id,
        text,
        author: { id: "x", name: "Alex Berg", source: "local" },
        createdAt: w.linear.tick(),
        updatedAt: w.linear.tick(),
      });
    w.edit(task, { title: "note to self", description: "" });
    remark("private remark");
    w.state.pullRequests = [
      { epicId: "g", branch: "feat/a", base: "dev", title: "PR", url: "https://github.com/acme/web/pull/1", createdAt: "", updatedAt: "" } as never,
    ];
    await w.sync();
    await w.service.import(connection.id, { ...choices, direction: "both" });
    await w.sync();
    assert.equal(said(w).length, 0);
    assert.equal(linear(w, issue.id).title, "A");
    w.edit(w.task(issue), { priority: "high" });
    remark("for everyone");
    await w.sync();
    assert.equal(linear(w, issue.id).priority, 2);
    assert.equal(linear(w, issue.id).title, "A");
    assert.deepEqual([...w.linear.comments.values()].map((comment) => comment.body), ["for everyone"]);
  }));

test("deleting a lane here moves no issue, and its statuses show where they belong", () =>
  using(async (w) => {
    w.state.workflowStates = [
      ...defaultWorkflow(w.projectId),
      { id: "custom-ready", projectId: w.projectId, name: "Ready", stage: "planned", color: "#fff", order: 2 },
    ];
    const issues = [1, 2].map((n) => w.linear.issue({ title: "R" + n, state: w.linear.states.ready.id }));
    await w.imported();
    assert.equal(w.task(issues[0]).statusId, "custom-ready");
    const handlers: Record<string, (input: unknown) => Promise<unknown>> = {};
    registerPlanningControls(
      ((name: string, _schema: unknown, handler: (input: unknown) => Promise<unknown>) => (handlers[name] = handler)) as never,
      () => w.state,
      (async () => {}) as never,
      ((id: string) => w.state.projects.find((item) => item.id === id)) as never,
    );
    await handlers["workflow:save"]({
      projectId: w.projectId,
      states: w.state.workflowStates.filter((state) => state.id !== "custom-ready"),
    });
    await w.sync();
    assert.equal(said(w).length, 0);
    w.linear.edit(issues[0], { state: w.linear.states.progress.id });
    await w.sync();
    assert.equal(w.task(issues[0]).stage, "working");
    w.linear.edit(issues[0], { state: w.linear.states.ready.id });
    await w.sync();
    assert.equal(w.task(issues[0]).stage, "planned");
    // A move a person makes is sent as ever.
    w.edit(w.task(issues[1]), { statusId: w.lane("done") });
    await w.sync();
    assert.equal(linear(w, issues[1].id).state, w.linear.states.done.id);
  }));

test("undoing an import leaves what was worked on and what builds on it, and says so first", () =>
  using(async (w) => {
    const [planned, plain, parent, base] = ["planned", "plain", "parent", "base"].map((title) => w.linear.issue({ title }));
    const { connection } = await w.imported();
    const of = (issue: typeof planned) => w.task(issue);
    w.edit(of(planned), { checklist: [{ id: "s1", text: "A plan I wrote", done: false }] });
    of(parent);
    w.newTask({ title: "Mine", parentId: of(parent).id, dependsOn: [of(base).id] });
    await w.sync();
    assert.deepEqual(await w.service.undoPreview(connection.id), { removed: 1, kept: 4 });
    assert.equal(w.state.tasks.length, 5, "asking takes nothing out");
    w.state.trackerKeepers![0] = { ...w.state.trackerKeepers![0], connection: "another", by: "Dana" };
    await assert.rejects(w.service.undoImport(connection.id), /Dana keeps this project/);
    w.state.trackerKeepers![0] = { ...w.state.trackerKeepers![0], connection: connection.id };
    assert.deepEqual(await w.service.undoImport(connection.id), { removed: 1, kept: 4 });
    assert.equal(of(plain), undefined);
    assert.ok(of(planned) && of(parent) && of(base));
  }));

for (const [what, change] of [
  ["a message", (w: LinearWorld, id: string) => w.state.tasks.find((task) => task.id === id)!.messages.push({ id: "m", role: "user", text: "Draft", at: "" })],
  ["its files", (w: LinearWorld, id: string) => w.edit(w.state.tasks.find((task) => task.id === id)!, { scope: ["src/a.ts"] })],
  ["its kind", (w: LinearWorld, id: string) => w.edit(w.state.tasks.find((task) => task.id === id)!, { kind: "fix" })],
  ["a start date", (w: LinearWorld, id: string) => w.edit(w.state.tasks.find((task) => task.id === id)!, { startDate: "2026-11-26" })],
] as const)
  test(`a card with ${what} of somebody's is not taken out with the import`, () =>
    using(async (w) => {
      const issue = w.linear.issue({ title: "A" });
      const { connection } = await w.imported();
      change(w, w.task(issue).id);
      assert.deepEqual(await w.service.undoPreview(connection.id), { removed: 0, kept: 1 });
    }));

test("a card stays in its goal when what a goal is changes, and others go into theirs", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export", ["First"]);
    const issue = linear.issue({ title: "A", project: project.id, milestone: project.milestones[0].id });
    const { connection, choices } = await w.imported();
    const goal = w.task(issue).epicId;
    assert.ok(goal);
    await w.service.import(connection.id, { ...choices, goals: "none" });
    linear.edit(issue, { title: "A2" });
    await w.sync();
    assert.equal(w.task(issue).epicId, goal);
    const other = linear.issue({ title: "B", project: project.id, milestone: project.milestones[0].id });
    await w.sync();
    assert.equal(w.task(other).epicId, null);
    await w.service.import(connection.id, choices);
    await w.sync();
    await w.sync();
    assert.equal(w.task(other).epicId, goal);
    assert.equal(w.task(issue).epicId, goal);
    assert.equal(said(w).length, 0);
  }));

test("a goal deleted here stays deleted and takes no issue out of its project", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export", ["First"]);
    const issue = linear.issue({ title: "A", project: project.id, milestone: project.milestones[0].id });
    const { connection, choices } = await w.imported();
    w.state.epics = w.state.epics.filter((goal) => !goal.tracker);
    w.edit(w.task(issue), { epicId: null });
    await w.sync();
    linear.edit(issue, { priority: 2 });
    await w.sync();
    assert.equal(w.state.epics.filter((goal) => goal.tracker).length, 0);
    assert.deepEqual([linear.issues.get(issue.id)!.project, linear.issues.get(issue.id)!.milestone], [project.id, project.milestones[0].id]);
    const other = linear.issue({ title: "B", project: project.id, milestone: project.milestones[0].id });
    await w.sync();
    assert.equal(w.task(other).epicId, null);
    // A person bringing work in again wants its goals too.
    await w.service.import(connection.id, choices);
    linear.edit(other, { title: "B2" });
    await w.sync();
    assert.equal(w.state.epics.filter((goal) => goal.tracker).length, 1);
    assert.equal(said(w).length, 0);
  }));

test("out of a goal that is a parent issue, an issue keeps its project and milestone", () =>
  using(async (w) => {
    const project = w.linear.project("Export", ["First"]);
    const parent = w.linear.issue({ title: "Parent" });
    const child = w.linear.issue({ title: "Child", parent: parent.id, project: project.id, milestone: project.milestones[0].id });
    await w.imported({ goals: "parents" });
    w.edit(w.task(child), { epicId: null });
    await w.sync();
    const issue = linear(w, child.id);
    assert.deepEqual([issue.parent, issue.project, issue.milestone], [null, project.id, project.milestones[0].id]);
    await w.sync();
    assert.equal(w.task(child).tracker?.standing, "synced");
    assert.equal(w.task(child).epicId, null);
  }));

test("labels go on and off on both sides, and one MemCode does not know stays on the issue", () =>
  using(async (w) => {
    const bug = w.linear.label("bug"), old = w.linear.label("old"), hidden = w.linear.label("hidden");
    const issue = w.linear.issue({ title: "A", labels: [bug.id, old.id, hidden.id] });
    w.linear.before = (operation) => {
      if (operation !== "Labels") return;
      const nodes = [...w.linear.labels.values()].filter((label) => label.id !== hidden.id).map((label) => ({ ...label, parent: null }));
      return w.linear.json({ data: { issueLabels: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    };
    await w.imported();
    // A colleague makes a label and puts it on; a moment later one is added here and one taken off.
    const fresh = w.linear.label("regression");
    w.linear.edit(issue, { labels: [bug.id, old.id, hidden.id, fresh.id] });
    w.edit(w.task(issue), { labels: ["bug", "ui"] });
    await w.service.sync(w.connection.id, "send");
    assert.deepEqual(named(w, linear(w, issue.id).labels), ["bug", "hidden", "regression", "ui"]);
    await w.sync();
    assert.deepEqual(w.task(issue).labels, ["bug", "regression", "ui"]);
    // Both sides between two looks, with labels both know.
    w.linear.edit(issue, { labels: [...linear(w, issue.id).labels.filter((id) => id !== bug.id), old.id] });
    w.edit(w.task(issue), { labels: ["bug", "regression", "ui", "web"] });
    await w.sync();
    assert.deepEqual(w.task(issue).labels, ["old", "regression", "ui", "web"]);
    assert.deepEqual(named(w, linear(w, issue.id).labels), ["hidden", "old", "regression", "ui", "web"]);
    assert.equal(w.task(issue).tracker?.kept, undefined, "nothing gave way");
    assert.equal(w.task(issue).tracker?.standing, "synced");
  }));

test("labels brought together and changed again before they were sent", () =>
  using(async (w) => {
    const [red, blue] = ["red", "blue"].map((name) => w.linear.label(name));
    const issue = w.linear.issue({ title: "A" });
    await w.imported();
    w.linear.edit(issue, { labels: [blue.id] });
    w.edit(w.task(issue), { labels: ["red"] });
    w.linear.before = (operation) => (operation === "UpdateIssue" ? "offline" : undefined);
    await w.sync();
    assert.deepEqual(w.task(issue).labels, ["blue", "red"]);
    w.linear.before = undefined;
    w.edit(w.task(issue), { labels: [] });
    w.linear.tick(400_000);
    await w.sync();
    assert.deepEqual(linear(w, issue.id).labels, []);
    assert.equal(w.task(issue).tracker?.standing, "synced");
    void red;
  }));

test("one issue whose history cannot be read stops no other", () =>
  using(async (w) => {
    const a = w.linear.issue({ title: "A" }), b = w.linear.issue({ title: "B" });
    await w.imported();
    w.linear.before = (operation, variables) =>
      operation === "History" && variables.id === a.id
        ? w.linear.json({ errors: [{ message: "Cannot read history", extensions: { code: "FORBIDDEN" } }] })
        : undefined;
    w.linear.edit(a, { title: "A there" });
    w.edit(w.task(a), { title: "A here" });
    w.edit(w.task(b), { title: "B here" });
    await w.sync();
    assert.equal(linear(w, b.id).title, "B here");
    assert.equal(linear(w, a.id).title, "A here");
    assert.equal(w.connection.problem, undefined);
  }));

test("a look that finds nothing new saves nothing", () =>
  using(async (w) => {
    for (let n = 0; n < 5; n++) w.linear.issue({ title: "Issue " + n, description: "Text" });
    const { connection } = await w.imported();
    await w.sync();
    const file = join(w.dataDir, "trackers", connection.id + ".json");
    const { stat } = await import("node:fs/promises");
    const saves = w.saves, written = (await stat(file)).mtimeMs;
    for (let n = 0; n < 8; n++) {
      w.linear.tick(150_000);
      await w.sync();
    }
    assert.equal(w.saves, saves);
    assert.equal((await stat(file)).mtimeMs, written);
    w.linear.edit([...w.linear.issues.values()][0], { title: "New" });
    await w.sync();
    assert.ok(w.saves > saves);
  }));

test("a team that knows three priorities does not change what they are here or in Linear", () =>
  using(async (w) => {
    const none = w.linear.issue({ title: "none", priority: 0 });
    const urgent = w.linear.issue({ title: "urgent", priority: 1 });
    await w.imported();
    const mine = projectSharedState(w.state, w.projectId);
    const echoed = (priority?: "low") =>
      ({
        stories: mine.stories.map((story) => ({ ...story, revision: 1, ...(priority ? { priority } : {}) })),
        epics: [],
        cycles: [],
        comments: [],
        members: [],
      }) as never;
    applySharedSnapshot(w.state, w.projectId, echoed(), mine);
    await w.sync();
    assert.deepEqual([w.task(none).priority, w.task(urgent).priority], ["none", "urgent"]);
    assert.equal(said(w).length, 0);
    // A teammate's own change is one.
    applySharedSnapshot(w.state, w.projectId, echoed("low"), mine);
    assert.deepEqual([w.task(none).priority, w.task(urgent).priority], ["none", "low"]);
  }));
