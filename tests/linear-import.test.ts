import test from "node:test";
import assert from "node:assert/strict";
import { taskStatus, workflowFor } from "../src/planning/workflow";
import { longestDescription } from "../runtime/trackers/linear/fields";
import { linearWorld, type LinearWorld } from "./support/linear-world";

const using = async (run: (w: LinearWorld) => Promise<void>) => {
  const w = await linearWorld();
  try {
    await run(w);
  } finally {
    await w.end();
  }
};
const laneOf = (w: LinearWorld, task: Parameters<typeof taskStatus>[0]) =>
  taskStatus(task, workflowFor(w.state, w.projectId)).id;

test("connecting says who it is and keeps the key out of the workspace", () =>
  using(async (w) => {
    const connection = await w.service.connect(w.projectId, " key-good ");
    assert.equal(connection.workspace.name, "Acme");
    assert.equal(connection.viewer.name, "Alex Berg");
    assert.doesNotMatch(JSON.stringify(w.state), /key-good/);
    assert.equal(w.kept.get(connection.id)?.access, "key-good");
    await assert.rejects(
      (await linearWorld({ linear: w.linear })).service.connect("p1", "key-bad"),
      /did not accept this API key/,
    );
    assert.equal(w.state.trackers!.length, 1);
  }));

test("a key that does not work leaves the connection as it was", () =>
  using(async (w) => {
    const { connection } = await w.connect();
    await assert.rejects(w.service.connect(w.projectId, "key-bad"));
    assert.equal(w.kept.get(connection.id)?.access, "key-good");
    assert.equal(w.state.trackers!.length, 1);
  }));

test("the preview counts what each choice brings, and suggests a lane for every status", () =>
  using(async (w) => {
    const { linear } = w;
    const cycle = linear.cycle("Cycle 5", "2026-11-23T00:00:00.000Z", "2026-12-07T00:00:00.000Z", { isActive: true });
    for (let n = 0; n < 9; n++) linear.issue();
    linear.issue({ cycle: cycle.id, state: linear.states.progress.id });
    linear.issue({ state: linear.states.done.id });
    linear.issue({ state: linear.states.triage.id });
    linear.issue({ team: linear.otherTeam.id });
    linear.project("Export", ["First version", "Second version"]);
    const { preview } = await w.connect();
    assert.deepEqual(preview.counts, { open: 10, cycle: 1, all: 11 });
    assert.deepEqual([preview.goals.projects, preview.goals.milestones], [1, 2]);
    const name = (key: string) => preview.suggested.lanes[linear.states[key].id];
    assert.equal(name("backlog"), w.lane("backlog"));
    assert.equal(name("todo"), w.lane("planned"));
    assert.equal(name("ready"), w.lane("planned"));
    assert.equal(name("progress"), w.lane("working"));
    assert.equal(name("review"), w.lane("review"), "Ready for acceptance, never Code review");
    assert.equal(name("done"), w.lane("done"));
    assert.equal(preview.suggested.send.working, linear.states.progress.id);
    assert.equal(preview.suggested.send.review, linear.states.review.id);
    assert.equal(w.state.tasks.length, 0, "nothing is changed by looking");
    assert.equal(linear.countOf("UpdateIssue") + linear.countOf("CreateIssue"), 0);
  }));

test("an import brings every field, goal, cycle, parent and comment", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export", ["First version"]);
    const loose = linear.project("Billing", [], "planned");
    const cycle = linear.cycle("Cycle 5", "2026-11-22T23:00:00.000Z", "2026-12-06T23:00:00.000Z", { isActive: true, description: "Ship the export" });
    linear.cycle("Cycle 4", "2026-11-08T23:00:00.000Z", "2026-11-22T23:00:00.000Z", { completedAt: "2026-11-22T23:00:00.000Z" });
    const bug = linear.label("Bug"), area = linear.label("export");
    const parent = linear.issue({
      title: "Export reports",
      description: "As *CSV*.",
      priority: 1,
      estimate: 5,
      dueDate: "2026-12-01",
      state: linear.states.progress.id,
      assignee: linear.users.dana.id,
      cycle: cycle.id,
      project: project.id,
      milestone: project.milestones[0].id,
      labels: [bug.id, area.id],
    });
    const child = linear.issue({ title: "Pick the columns", parent: parent.id, project: project.id, milestone: project.milestones[0].id });
    const billing = linear.issue({ title: "Show invoices", project: loose.id, state: linear.states.backlog.id });
    const alone = linear.issue({ title: "Fix the footer", state: linear.states.review.id });
    const root = linear.comment(parent, "Excel too?");
    linear.comment(parent, "Later.", { parent: root.id, user: linear.users.alex.id });
    linear.comment(alone, "Deployed", { user: null });
    const { result } = await w.imported();
    assert.deepEqual(result, { tasks: 4, goals: 2, comments: 3 });

    const task = w.task(parent);
    assert.equal(task.id, parent.id, "the same id on every computer");
    assert.equal(task.identifier, "MC-001");
    assert.equal(task.tracker?.key, "WEB-1");
    assert.equal(task.title, "Export reports");
    assert.equal(task.description, "As *CSV*.");
    assert.equal(task.messages[0].text, "As *CSV*.", "a worker starts from the description");
    assert.equal(task.priority, "urgent");
    assert.equal(task.estimate, 5);
    assert.equal(task.dueDate, "2026-12-01");
    assert.equal(task.assignee?.name, "Dana Ito");
    assert.deepEqual(task.labels, ["Bug", "export"]);
    assert.equal(task.kind, "fix");
    assert.equal(laneOf(w, task), w.lane("working"));
    assert.equal(task.run.state, "idle", "nothing outside starts a worker");

    const [milestone, billingGoal] = w.state.epics;
    assert.equal(milestone.title, "First version · Export");
    assert.deepEqual([milestone.phase, billingGoal.phase], ["now", "next"]);
    assert.equal(task.epicId, milestone.id);
    assert.equal(w.task(billing).epicId, billingGoal.id);
    assert.equal(w.task(alone).epicId, null, "loose until someone starts it");
    assert.equal(w.task(child).parentId, task.id);
    assert.equal(laneOf(w, w.task(billing)), w.lane("backlog"));
    assert.equal(laneOf(w, w.task(alone)), w.lane("review"));

    const [active, ...others] = w.state.cycles;
    assert.equal(others.length, 0, "a past cycle nobody saw here is not brought in");
    assert.deepEqual(
      [active.name, active.goal, active.startDate, active.endDate, active.state],
      ["Cycle 5", "Ship the export", "2026-11-23", "2026-12-06", "active"],
    );
    assert.equal(task.cycleId, active.id);

    const comments = w.state.storyComments!;
    assert.deepEqual(
      comments.map((item) => [item.text, item.author.name, item.author.source]),
      [
        ["Excel too?", "Dana Ito", "linear"],
        ["Later.", "Alex Berg", "linear"],
        ["Deployed", "GitHub", "linear"],
      ],
    );
    assert.equal(comments[1].parentId, comments[0].id);
    assert.ok(w.state.tasks.every((item) => item.tracker?.standing === "synced"));
    assert.equal(linear.countOf("UpdateIssue"), 0, "nothing was written there");
  }));

test("an import run twice adds nothing, and one that was cut off carries on", () =>
  using(async (w) => {
    const { linear } = w;
    for (let n = 0; n < 20; n++) linear.issue({ title: `Number ${n}` });
    const { connection, choices } = await w.connect();
    linear.before = (operation) => (operation === "Comments" ? "offline" : undefined);
    await assert.rejects(w.service.import(connection.id, choices), /cannot be reached/);
    linear.before = undefined;
    await w.service.import(connection.id, choices);
    assert.equal(w.state.tasks.length, 20);
    const again = await w.service.import(connection.id, choices);
    assert.deepEqual(again, { tasks: 0, goals: 0, comments: 0 });
    assert.equal(new Set(w.state.tasks.map((task) => task.id)).size, 20);
    assert.deepEqual(
      w.state.tasks.map((task) => task.identifier),
      Array.from({ length: 20 }, (_, n) => `MC-${String(n + 1).padStart(3, "0")}`),
    );
  }));

test("after an import the first look finds nothing to do on either side", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export", ["First version"]);
    for (const state of Object.values(linear.states))
      linear.issue({ state: state.id, project: project.id, milestone: project.milestones[0].id, description: "- one\n- two  " });
    await w.imported({ scope: "all" });
    const before = JSON.stringify(w.state.tasks);
    await w.sync();
    await w.sync();
    assert.equal(linear.countOf("UpdateIssue"), 0);
    assert.equal(JSON.stringify(w.state.tasks), before);
  }));

test("only a team's open work, its cycle or everything comes in, as chosen", () =>
  using(async (w) => {
    const { linear } = w;
    const cycle = linear.cycle("Cycle 5", "2026-11-22T23:00:00.000Z", "2026-12-06T23:00:00.000Z", { isActive: true });
    linear.issue({ title: "in the cycle", cycle: cycle.id });
    linear.issue({ title: "open" });
    linear.issue({ title: "done", state: linear.states.done.id });
    linear.issue({ title: "canceled", state: linear.states.canceled.id });
    linear.issue({ title: "triage", state: linear.states.triage.id });
    linear.issue({ title: "other team", team: linear.otherTeam.id });
    const { connection, choices } = await w.connect();
    const titles = async (scope: "open" | "cycle" | "all") => {
      w.state.tasks = [];
      await w.service.disconnect(w.connection.id);
      const again = await w.connect({ ...choices, scope });
      await w.service.import(again.connection.id, again.choices);
      return w.state.tasks.map((task) => task.title).sort();
    };
    void connection;
    assert.deepEqual(await titles("cycle"), ["in the cycle"]);
    assert.deepEqual(await titles("open"), ["in the cycle", "open"]);
    assert.deepEqual(await titles("all"), ["canceled", "done", "in the cycle", "open"]);
    const canceled = w.state.tasks.find((task) => task.title === "canceled")!;
    assert.ok(canceled.archivedAt);
    assert.equal(canceled.closedAs, "canceled", "not delivered work");
    const done = w.state.tasks.find((task) => task.title === "done")!;
    assert.equal(done.stage, "done");
  }));

test("parent issues can be the goals", () =>
  using(async (w) => {
    const { linear } = w;
    const parent = linear.issue({ title: "Export reports", state: linear.states.progress.id });
    const child = linear.issue({ title: "Pick the columns", parent: parent.id });
    const grandchild = linear.issue({ title: "Remember them", parent: child.id });
    const alone = linear.issue({ title: "Fix the footer" });
    await w.imported({ goals: "parents" });
    assert.deepEqual(
      w.state.epics.map((epic) => [epic.title, epic.tracker?.key, epic.phase]),
      [["Export reports", "WEB-1", "now"]],
    );
    assert.equal(w.task(parent), undefined, "a goal is not also a task");
    assert.equal(w.task(child).epicId, w.state.epics[0].id);
    assert.equal(w.task(child).parentId ?? null, null);
    assert.equal(w.task(grandchild).parentId, w.task(child).id);
    assert.equal(w.task(alone).epicId, null);
  }));

test("a description longer than a task can hold is shown in part and never sent back", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue({ description: "x".repeat(longestDescription + 500) });
    await w.imported();
    const task = w.task(issue);
    assert.equal(task.description.length, longestDescription);
    assert.match(task.description, /The rest of this description is in Linear\.$/);
    w.edit(task, { description: "Shorter." });
    await w.sync();
    assert.equal(linear.issues.get(issue.id)!.description.length, longestDescription + 500);
  }));

test("an import can be taken back, except for what someone has touched", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export", []);
    const kept = linear.issue({ title: "worked on", project: project.id });
    const commented = linear.issue({ title: "commented" });
    const edited = linear.issue({ title: "edited" });
    const plain = linear.issue({ title: "plain", project: linear.project("Other").id });
    linear.comment(plain, "Theirs");
    const { connection } = await w.imported();
    w.task(kept).run.startedAt = "2026-11-25T10:00:00.000Z";
    w.edit(w.task(edited), { estimate: 3 });
    w.state.storyComments!.push({
      id: "mine",
      taskId: w.task(commented).id,
      text: "Mine",
      author: { id: "local-owner", name: "You", source: "local" },
      createdAt: linear.tick(),
      updatedAt: linear.tick(),
    });
    const before = JSON.stringify([...linear.issues.values()]);
    assert.deepEqual(await w.service.undoImport(connection.id), { removed: 1, kept: 3 });
    assert.deepEqual(w.state.tasks.map((task) => task.title).sort(), ["commented", "edited", "worked on"]);
    assert.deepEqual(w.state.epics.map((epic) => epic.title), ["Export"]);
    assert.deepEqual(w.state.storyComments!.map((item) => item.id), ["mine"]);
    assert.equal(JSON.stringify([...linear.issues.values()]), before, "Linear is not told");
    await assert.rejects(w.service.undoImport(connection.id), /for seven days/);
  }));

test("taking an import back leaves what was made or changed here, and stays taken back", () =>
  using(async (w) => {
    const { linear } = w;
    const plain = linear.issue({ title: "plain" }), changed = linear.issue({ title: "changed" });
    const { connection } = await w.imported();
    w.newTask({ title: "made here" });
    w.edit(w.task(changed), { title: "changed here" });
    for (let n = 0; n < 2; n++) await w.sync();
    assert.equal(linear.issues.get(changed.id)!.title, "changed here", "Linear has heard");
    assert.ok([...linear.issues.values()].some((item) => item.title === "made here"));
    assert.deepEqual(await w.service.undoImport(connection.id), { removed: 1, kept: 2 });
    assert.deepEqual(w.state.tasks.map((task) => task.title).sort(), ["changed here", "made here"]);
    linear.edit(plain, { title: "plain, edited there" });
    for (let n = 0; n < 2; n++) await w.sync();
    assert.equal(w.state.tasks.length, 2, "an edit there does not bring it back");
    await w.service.import(connection.id, connection.choices!);
    assert.deepEqual(w.state.tasks.map((task) => task.title).sort(), ["changed here", "made here", "plain, edited there"]);
  }));

test("two projects can follow the same team without sharing cards", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue();
    await w.imported();
    w.state.projects.push({ ...w.state.projects[0], id: "p2", name: "Api" });
    const second = await w.service.connect("p2", "key-good");
    const preview = await w.service.preview(second.id, linear.team.id);
    await w.service.import(second.id, preview.suggested);
    assert.equal(w.state.tasks.length, 2);
    assert.equal(new Set(w.state.tasks.map((task) => task.id)).size, 2);
    assert.deepEqual(w.state.tasks.map((task) => task.tracker?.id), [issue.id, issue.id]);
    linear.edit(issue, { title: "Renamed" });
    await w.service.sync(w.state.trackers![0].id);
    await w.service.sync(second.id);
    assert.deepEqual(w.state.tasks.map((task) => task.title), ["Renamed", "Renamed"]);
  }));

test("disconnecting keeps the cards, and connecting again makes no doubles", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue({ title: "Export" }), other = linear.issue({ title: "Footer" });
    const { connection } = await w.imported();
    await w.service.disconnect(connection.id);
    assert.equal(w.state.trackers!.length, 0);
    assert.equal(w.kept.size, 0, "the sign-in is gone from this computer");
    assert.equal(w.state.tasks.length, 2);
    assert.ok(w.state.tasks.every((task) => task.tracker?.standing === "unlinked"));
    // Both sides go on: one changed here later, one there later.
    linear.edit(issue, { title: "Export as CSV" });
    w.edit(w.task(issue), { estimate: 2 });
    linear.edit(other, { title: "Footer there" });
    w.edit(w.task(other), { title: "Footer here" });
    const again = await w.connect();
    const result = await w.service.import(again.connection.id, again.choices);
    assert.equal(result.tasks, 0);
    await w.sync();
    assert.equal(w.state.tasks.length, 2);
    // Nobody can say when it was changed here: Linear's stays, and the other is not lost.
    assert.equal(w.task(other).title, "Footer there");
    assert.equal(linear.issues.get(other.id)!.title, "Footer there");
    assert.equal(w.task(other).tracker?.kept?.[0].shown, "Footer here");
    assert.equal(w.task(issue).title, "Export as CSV");
    assert.equal(linear.issues.get(issue.id)!.estimate, 2);
    assert.ok(w.state.tasks.every((task) => task.tracker?.standing === "synced"));
  }));

test("deleting the project ends its connection and forgets the sign-in", () =>
  using(async (w) => {
    w.linear.issue({ title: "One" });
    await w.imported();
    assert.equal(w.kept.size, 1);
    w.state.projects = [];
    w.state.tasks = [];
    w.linear.issue({ title: "Made after" });
    w.service.noticed();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(w.state.trackers!.length, 0);
    assert.equal(w.state.trackerKeepers!.length, 0);
    assert.equal(w.kept.size, 0);
    assert.equal(w.state.tasks.length, 0);
    assert.ok(!w.linear.calls.some((call) => call.operation === "Issues"));
  }));

test("another workspace is not mixed in by accident", () =>
  using(async (w) => {
    await w.imported();
    const id = w.linear.workspace.id;
    w.linear.workspace = { ...w.linear.workspace, id: crypto.randomUUID(), name: "Elsewhere" };
    await assert.rejects(w.service.connect(w.projectId, "key-good"), /in step with Acme/);
    w.linear.workspace = { ...w.linear.workspace, id };
    await w.sync();
    assert.equal(w.connection.problem, undefined);
  }));
