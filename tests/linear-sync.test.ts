import test from "node:test";
import assert from "node:assert/strict";
import { taskStatus, workflowFor } from "../src/planning/workflow";
import type { WorkItem } from "../src/shared";
import { rewritten, type FakeIssue } from "./support/fake-linear";
import { linearWorld, type LinearWorld } from "./support/linear-world";

const using = async (run: (w: LinearWorld) => Promise<void>) => {
  const w = await linearWorld();
  try {
    await run(w);
  } finally {
    await w.end();
  }
};
const laneOf = (w: LinearWorld, task: WorkItem) =>
  taskStatus(task, workflowFor(w.state, w.projectId)).id.slice(w.projectId.length + 1);
const there = (w: LinearWorld, issue: FakeIssue) => w.linear.issues.get(issue.id)!;

test("a change in Linear shows on the card, whatever field it is", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export", ["First", "Second"]);
    const cycle = linear.cycle("Cycle 5", "2026-11-22T23:00:00.000Z", "2026-12-06T23:00:00.000Z", { isActive: true });
    const label = linear.label("export");
    const parent = linear.issue({ title: "Parent" });
    const issue = linear.issue({ project: project.id, milestone: project.milestones[0].id });
    await w.imported();
    linear.edit(issue, {
      title: "New title",
      description: "New text",
      priority: 2,
      estimate: 8,
      dueDate: "2026-12-24",
      state: linear.states.progress.id,
      assignee: linear.users.alex.id,
      cycle: cycle.id,
      milestone: project.milestones[1].id,
      parent: parent.id,
      labels: [label.id],
    });
    await w.sync();
    const task = w.task(issue);
    assert.deepEqual(
      [task.title, task.description, task.priority, task.estimate, task.dueDate, task.assignee?.name, task.labels],
      ["New title", "New text", "high", 8, "2026-12-24", "Alex Berg", ["export"]],
    );
    assert.equal(laneOf(w, task), "working");
    assert.equal(w.state.cycles.find((item) => item.id === task.cycleId)?.name, "Cycle 5");
    assert.equal(w.state.epics.find((item) => item.id === task.epicId)?.title, "Second · Export");
    assert.equal(task.parentId, w.task(parent).id);
    assert.equal(task.messages[0].text, "New text", "its worker would start from what it says now");
    assert.equal(linear.countOf("UpdateIssue"), 0, "what came from there is not sent back");
    await w.sync();
    assert.equal(linear.countOf("UpdateIssue"), 0);
  }));

test("a change on the card goes to Linear, whatever field it is", () =>
  using(async (w) => {
    const { linear } = w;
    const first = linear.project("Export", ["First"]), second = linear.project("Billing", ["Invoices"]);
    const cycle = linear.cycle("Cycle 5", "2026-11-22T23:00:00.000Z", "2026-12-06T23:00:00.000Z", { isActive: true });
    const parent = linear.issue({ title: "Parent", project: second.id, milestone: second.milestones[0].id });
    const issue = linear.issue({ project: first.id, milestone: first.milestones[0].id, cycle: cycle.id });
    await w.imported();
    const task = w.task(issue);
    const goal = w.task(parent).epicId;
    w.edit(task, {
      title: "Title from here",
      description: "- one\n- two  ",
      priority: "urgent",
      estimate: 3,
      dueDate: "2026-12-24",
      assignee: { id: linear.users.dana.id, name: "Dana Ito" },
      labels: ["brand new"],
      epicId: goal,
      parentId: w.task(parent).id,
    });
    w.edit(task, { statusId: w.lane("done") });
    await w.sync();
    const now = there(w, issue);
    assert.equal(now.title, "Title from here");
    assert.equal(now.description, rewritten("- one\n- two  "));
    assert.deepEqual([now.priority, now.estimate, now.dueDate], [1, 3, "2026-12-24"]);
    assert.equal(now.assignee, linear.users.dana.id);
    assert.deepEqual(now.labels.map((id) => linear.labels.get(id)?.name), ["brand new"], "a label that was not there is made");
    assert.deepEqual([now.project, now.milestone], [second.id, second.milestones[0].id]);
    assert.equal(now.parent, parent.id);
    assert.equal(now.state, linear.states.done.id);
    assert.equal(w.task(issue).tracker?.standing, "synced");
    assert.equal(linear.countOf("UpdateIssue"), 1, "together, in one go");
    for (let n = 0; n < 3; n++) await w.sync();
    assert.equal(linear.countOf("UpdateIssue"), 1, "Linear's own way of writing it does not come back as a change");
    assert.equal(w.task(issue).description, "- one\n- two  ", "nor does it change what was written here");
  }));

test("clearing a value is a change like any other, both ways", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export");
    const cycle = linear.cycle("Cycle 5", "2026-11-22T23:00:00.000Z", "2026-12-06T23:00:00.000Z", { isActive: true });
    const all = {
      description: "Text",
      priority: 2,
      estimate: 3,
      dueDate: "2026-12-01",
      assignee: linear.users.dana.id,
      cycle: cycle.id,
      project: project.id,
      labels: [linear.label("export").id],
    };
    const mine = linear.issue(all), theirs = linear.issue(all);
    await w.imported();
    w.edit(w.task(mine), { description: "", priority: "none", estimate: null, dueDate: null, assignee: null, cycleId: null, labels: [], epicId: null });
    linear.edit(theirs, { description: "", priority: 0, estimate: null, dueDate: null, assignee: null, cycle: null, project: null, labels: [] });
    await w.sync();
    const issue = there(w, mine);
    assert.deepEqual(
      [issue.description, issue.priority, issue.estimate, issue.dueDate, issue.assignee, issue.cycle, issue.project, issue.labels],
      ["", 0, null, null, null, null, null, []],
    );
    const task = w.task(theirs);
    assert.deepEqual(
      [task.description, task.priority, task.estimate, task.dueDate, task.assignee, task.cycleId, task.epicId, task.labels],
      ["", "none", null, null, null, null, null, []],
    );
  }));

test("several statuses there are one lane here, and stay what they were", () =>
  using(async (w) => {
    const { linear } = w;
    const ready = linear.issue({ state: linear.states.ready.id });
    const todo = linear.issue({ state: linear.states.todo.id });
    await w.imported();
    for (const issue of [ready, todo]) {
      assert.equal(laneOf(w, w.task(issue)), "planned");
      w.edit(w.task(issue), { title: w.task(issue).title + "!" });
    }
    await w.sync();
    assert.equal(there(w, ready).state, linear.states.ready.id, "a change of title is no change of status");
    linear.edit(todo, { state: linear.states.ready.id });
    await w.sync();
    assert.equal(laneOf(w, w.task(todo)), "planned");
    w.edit(w.task(ready), { statusId: w.lane("working") });
    await w.sync();
    assert.equal(there(w, ready).state, linear.states.progress.id);
    w.edit(w.task(ready), { statusId: w.lane("planned") });
    await w.sync();
    assert.equal(there(w, ready).state, linear.states.todo.id, "back in Planned is the status MemCode sends for it");
  }));

test("the steps of a worker are what Linear hears, not the lane a card stands in", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue();
    await w.imported();
    const task = w.task(issue);
    const runs = async (state: WorkItem["run"]["state"], stage: WorkItem["stage"], lane?: string) => {
      Object.assign(task.run, { state, startedAt: "2026-11-25T10:00:00.000Z" });
      task.stage = stage;
      if (lane) task.statusId = w.lane(lane);
      task.updatedAt = linear.tick();
      await w.sync();
      return Object.entries(linear.states).find(([, value]) => value.id === there(w, issue).state)![0];
    };
    assert.equal(await runs("preparing", "planned"), "progress");
    assert.equal(await runs("running", "working", "working"), "progress");
    assert.equal(await runs("failed", "review", "review"), "progress", "half-done work is not in review");
    assert.equal(await runs("stopped", "review", "review"), "progress");
    assert.equal(await runs("blocked", "working", "working"), "progress");
    assert.equal(await runs("finished", "review", "code-review"), "review");
    assert.equal(await runs("finished", "review", "review"), "review");
    assert.equal(await runs("running", "working", "working"), "progress", "fixes were sent back to it");
    assert.equal(await runs("finished", "done", "done"), "done");
  }));

test("with a worker running, what would move the card waits until it ends", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export"), other = linear.project("Billing");
    const issue = linear.issue({ project: project.id, state: linear.states.progress.id });
    linear.issue({ project: other.id });
    await w.imported();
    const task = w.task(issue);
    task.run.state = "running";
    linear.edit(issue, { title: "Renamed", state: linear.states.todo.id, project: other.id });
    await w.sync();
    assert.equal(task.title, "Renamed", "what does not touch its work comes through");
    assert.equal(laneOf(w, task), "working");
    assert.equal(w.state.epics.find((item) => item.id === task.epicId)?.title, "Export");
    assert.equal(task.tracker?.standing, "waiting");
    assert.match(task.tracker!.note!, /has a worker running/);
    assert.equal(there(w, issue).state, linear.states.todo.id, "and nothing is forced on Linear");
    task.run.state = "finished";
    await w.sync();
    assert.equal(w.state.epics.find((item) => item.id === task.epicId)?.title, "Billing");
    assert.equal(laneOf(w, task), "planned");
    assert.equal(w.task(issue).tracker?.standing, "synced");
  }));

test("work that has not shipped is never moved, canceled or taken away", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export"), other = linear.project("Billing");
    linear.issue({ project: other.id });
    const moved = linear.issue({ project: project.id }), canceled = linear.issue({ project: project.id }), deleted = linear.issue({ project: project.id });
    await w.imported();
    for (const issue of [moved, canceled, deleted]) {
      const task = w.task(issue);
      Object.assign(task.run, { state: "finished", startedAt: "2026-11-25T10:00:00.000Z", branch: "feat/export" });
      w.edit(task, { statusId: w.lane("review") });
    }
    await w.sync();
    linear.edit(moved, { project: other.id });
    linear.edit(canceled, { state: linear.states.canceled.id });
    linear.bin(deleted);
    await w.sync();
    assert.equal(w.state.epics.find((item) => item.id === w.task(moved).epicId)?.title, "Export");
    assert.match(w.task(moved).tracker!.note!, /moved to Billing in Linear\. It has changes here that are not shipped/);
    assert.equal(w.task(canceled).archivedAt ?? null, null);
    assert.match(w.task(canceled).tracker!.note!, /canceled in Linear/);
    assert.equal(w.task(deleted).archivedAt ?? null, null);
    assert.match(w.task(deleted).tracker!.note!, /Deleted in Linear/);
    for (const issue of [moved, canceled, deleted]) assert.equal(w.task(issue).tracker?.standing, "attention");
    // It ships: what was held up follows by itself.
    w.task(moved).run.shipped = true;
    w.task(canceled).run.shipped = true;
    await w.sync();
    assert.equal(w.state.epics.find((item) => item.id === w.task(moved).epicId)?.title, "Billing");
    assert.equal(w.task(canceled).closedAs, "canceled");
  }));

test("moved to Planned here while its cycle is taken away there, it stays in Planned", () =>
  using(async (w) => {
    const { linear } = w;
    const cycle = linear.cycle("Cycle 5", "2026-11-22T23:00:00.000Z", "2026-12-06T23:00:00.000Z", { isActive: true });
    const issue = linear.issue({ cycle: cycle.id, state: linear.states.progress.id });
    await w.imported();
    w.edit(w.task(issue), { statusId: w.lane("planned") });
    linear.edit(issue, { cycle: null });
    await w.sync();
    await w.sync();
    assert.equal(w.task(issue).cycleId ?? null, null);
    assert.equal(there(w, issue).state, linear.states.todo.id);
    assert.equal(laneOf(w, w.task(issue)), "planned");
  }));

test("Linear puts a started issue in the current cycle: the card follows while its worker runs", () =>
  using(async (w) => {
    const { linear } = w;
    const cycle = linear.cycle("Cycle 5", "2026-11-22T23:00:00.000Z", "2026-12-06T23:00:00.000Z", { isActive: true });
    const issue = linear.issue({ state: linear.states.todo.id });
    await w.imported();
    const task = w.task(issue);
    task.stage = "working";
    task.run.state = "running";
    task.run.startedAt = new Date(linear.clock).toISOString();
    await w.sync();
    assert.equal(there(w, issue).state, linear.states.progress.id);
    linear.edit(issue, { cycle: cycle.id });
    await w.sync();
    assert.equal(w.state.cycles.find((item) => item.id === w.task(issue).cycleId)?.tracker?.id, cycle.id);
    assert.equal(w.task(issue).tracker?.standing, "synced");
    linear.edit(issue, { cycle: null });
    await w.sync();
    assert.equal(w.task(issue).cycleId ?? null, null);
    assert.equal(w.task(issue).stage, "working");
    assert.equal(w.task(issue).run.state, "running");
    const sent = linear.countOf("UpdateIssue");
    for (let n = 0; n < 3; n++) await w.sync();
    assert.equal(linear.countOf("UpdateIssue"), sent, "nothing goes back");
  }));

test("what waited long for a worker follows when it fails, and nothing is asked meanwhile", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export"), other = linear.project("Billing");
    const issue = linear.issue({ project: project.id, state: linear.states.progress.id });
    linear.issue({ project: other.id });
    await w.imported();
    const task = w.task(issue);
    task.run.state = "running";
    linear.edit(issue, { state: linear.states.todo.id });
    await w.sync();
    assert.equal(w.task(issue).tracker?.standing, "waiting");
    // Long after Linear's change is out of the last look.
    linear.tick(5 * 60_000);
    linear.calls.length = 0;
    await w.service.sync(w.connection.id, "send");
    assert.deepEqual(linear.calls.map((call) => call.operation), [], "nothing has changed");
    w.task(issue).run.state = "failed";
    await w.service.sync(w.connection.id, "send");
    assert.equal(laneOf(w, w.task(issue)), "planned");
    assert.equal(w.task(issue).tracker?.standing, "synced");
  }));

test("canceled there while a worker is on it: the worker ending does not bring it back", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export");
    const kept = linear.issue({ project: project.id }), dropped = linear.issue({ project: project.id }), again = linear.issue({ project: project.id });
    await w.imported();
    for (const issue of [kept, dropped, again]) {
      const task = w.task(issue);
      w.edit(task, { statusId: w.lane("working") });
      Object.assign(task.run, { state: "running", startedAt: linear.tick(), branch: "feat/export" });
    }
    await w.sync();
    assert.equal(there(w, kept).state, linear.states.progress.id);
    for (const issue of [kept, dropped, again]) linear.edit(issue, { state: linear.states.canceled.id });
    await w.sync();
    assert.equal(w.task(kept).tracker?.standing, "waiting");
    for (const issue of [kept, dropped, again]) {
      const task = w.task(issue);
      task.run.state = "finished";
      w.edit(task, { statusId: w.lane("review") });
    }
    for (let n = 0; n < 2; n++) {
      linear.tick(60_000);
      await w.sync();
    }
    for (const issue of [kept, dropped, again]) {
      assert.equal(there(w, issue).state, linear.states.canceled.id, "it stays canceled there");
      assert.equal(laneOf(w, w.task(issue)), "review", "and the work stays here");
      assert.equal(w.task(issue).tracker?.standing, "attention");
      assert.match(w.task(issue).tracker!.note!, /canceled in Linear\. It has changes here/);
      assert.equal(w.task(issue).tracker!.kept, undefined);
    }
    // It merges after all: that is the answer, and Linear hears it.
    w.edit(w.task(kept), { statusId: w.lane("done") });
    w.task(kept).run.shipped = true;
    // Somebody throws the work away.
    w.edit(w.task(dropped), { archivedAt: linear.tick(), closedAs: "canceled" });
    // Somebody wants it: they say so by moving the card.
    w.edit(w.task(again), { statusId: w.lane("planned") });
    await w.sync();
    assert.equal(there(w, kept).state, linear.states.done.id);
    assert.equal(there(w, dropped).state, linear.states.canceled.id);
    assert.equal(there(w, again).state, linear.states.todo.id);
    await w.sync();
    for (const issue of [kept, dropped, again]) assert.equal(w.task(issue).tracker?.standing, "synced");
  }));

test("canceled, duplicate, deleted and restored there", () =>
  using(async (w) => {
    const { linear } = w;
    const a = linear.issue(), b = linear.issue(), c = linear.issue();
    await w.imported();
    linear.edit(a, { state: linear.states.canceled.id });
    linear.edit(b, { state: linear.states.duplicate.id });
    linear.bin(c);
    await w.sync();
    assert.deepEqual([w.task(a).closedAs, w.task(b).closedAs], ["canceled", "duplicate"]);
    assert.ok(w.task(a).archivedAt && w.task(b).archivedAt && w.task(c).archivedAt);
    assert.equal(w.task(c).closedAs ?? null, null);
    assert.equal(w.task(c).tracker?.standing, "unlinked");
    linear.edit(a, { state: linear.states.todo.id });
    linear.bin(c, false);
    linear.tick(3 * 60_000);
    await w.sync();
    assert.deepEqual([w.task(a).archivedAt, w.task(a).closedAs], [null, null]);
    assert.equal(w.task(c).archivedAt, null);
    assert.equal(w.task(c).tracker?.standing, "synced");
    assert.equal(linear.countOf("UpdateIssue"), 0);
  }));

test("what was changed here while the issue lay in Linear's bin is sent when it is put back", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue();
    await w.imported();
    linear.bin(issue);
    await w.sync();
    assert.ok(w.task(issue).archivedAt);
    w.edit(w.task(issue), { title: "Changed meanwhile" });
    await w.sync();
    assert.equal(there(w, issue).title, "Issue 1", "nothing is sent to a deleted issue");
    linear.bin(issue, false);
    // Linear cannot be reached the first time it would be noticed.
    linear.before = (operation) => (operation === "Standing" ? "offline" : undefined);
    linear.tick(3 * 60_000);
    await w.sync();
    linear.before = undefined;
    linear.tick(3 * 60_000);
    await w.sync();
    assert.equal(w.task(issue).archivedAt, null);
    assert.equal(there(w, issue).title, "Changed meanwhile");
    assert.equal(w.task(issue).tracker?.standing, "synced");
  }));

test("taken out of its cycle and put in Planned here, an issue of the backlog is planned there too", () =>
  using(async (w) => {
    const { linear } = w;
    const cycle = linear.cycle("Cycle 5", "2026-11-22T23:00:00.000Z", "2026-12-06T23:00:00.000Z", { isActive: true });
    const issue = linear.issue({ cycle: cycle.id, state: linear.states.backlog.id });
    await w.imported();
    assert.equal(laneOf(w, w.task(issue)), "planned", "what is in a cycle is planned here");
    w.edit(w.task(issue), { cycleId: null });
    w.edit(w.task(issue), { statusId: w.lane("planned") });
    await w.sync();
    assert.equal(there(w, issue).cycle, null);
    assert.equal(there(w, issue).state, linear.states.todo.id);
    const sent = linear.countOf("UpdateIssue");
    for (let n = 0; n < 3; n++) await w.sync();
    assert.equal(linear.countOf("UpdateIssue"), sent);
  }));

test("an issue moved to another team says so on the card, and follows again when it is back", () =>
  using(async (w) => {
    const { linear } = w;
    const moved = linear.issue(), stays = linear.issue();
    await w.imported();
    linear.edit(moved, { team: linear.otherTeam.id });
    linear.tick(3 * 60_000);
    await w.sync();
    assert.equal(w.task(moved).tracker?.note, "Moved to another team in Linear. It no longer follows.");
    assert.equal(w.task(stays).tracker?.standing, "synced");
    const asked = linear.countOf("Issues");
    linear.tick(3 * 60_000);
    await w.sync();
    assert.equal(linear.countOf("Issues"), asked + 1, "the look alone: it is said once");
    linear.edit(moved, { team: linear.team.id, title: "Back again" });
    linear.tick(3 * 60_000);
    await w.sync();
    assert.equal(w.task(moved).title, "Back again");
    assert.equal(w.task(moved).tracker?.standing, "synced");
    assert.equal(w.task(moved).tracker?.note, undefined);
  }));

test("an issue that can no longer be seen is let go of, but not for one short answer", () =>
  using(async (w) => {
    const { linear } = w;
    const hidden = linear.issue(), stays = linear.issue();
    await w.imported();
    linear.issues.delete(hidden.id);
    linear.tick(3 * 60_000);
    await w.sync();
    assert.equal(w.task(hidden).tracker?.standing, "synced", "once is no proof");
    linear.tick(3 * 60_000);
    await w.sync();
    assert.equal(w.task(hidden).tracker?.standing, "unlinked");
    assert.equal(w.task(hidden).archivedAt ?? null, null, "the card stays");
    assert.equal(w.task(stays).tracker?.standing, "synced");
    linear.issues.set(hidden.id, hidden);
    linear.tick(3 * 60_000);
    await w.sync();
    assert.equal(w.task(hidden).tracker?.standing, "synced", "and follows when it can be seen again");
  }));

test("a comment deleted there goes here, but not for one short answer", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue();
    const gone = linear.comment(issue, "Deleted later"), stays = linear.comment(issue, "Stays");
    await w.imported();
    const here = (id: string) => w.state.storyComments!.find((item) => item.tracker?.id === id)!;
    linear.comments.delete(gone.id);
    linear.tick(3 * 60_000);
    await w.sync();
    assert.equal(here(gone.id).deletedAt ?? null, null, "once is no proof");
    linear.tick(3 * 60_000);
    await w.sync();
    assert.ok(here(gone.id).deletedAt);
    assert.equal(here(stays.id).deletedAt ?? null, null);
    const asked = linear.calls.length;
    await w.sync();
    assert.equal(linear.calls.slice(asked).filter((call) => /^(Delete|Update|Create)/.test(call.operation)).length, 0);
  }));

test("a label renamed there is the same label here", () =>
  using(async (w) => {
    const { linear } = w;
    const bug = linear.label("Bug"), other = linear.label("Other");
    const issue = linear.issue({ labels: [bug.id] });
    await w.imported();
    linear.labels.get(bug.id)!.name = "Defect";
    linear.tick(3 * 60_000);
    await w.sync();
    assert.deepEqual(w.task(issue).labels, ["Defect"]);
    assert.equal(linear.countOf("UpdateIssue"), 0);
    w.edit(w.task(issue), { labels: ["Defect", "Other"] });
    await w.sync();
    assert.deepEqual([...there(w, issue).labels].sort(), [bug.id, other.id].sort());
    assert.equal(linear.countOf("CreateLabel"), 0, "the old name is not made again");
  }));

test("archiving here hides the card; canceling here cancels the issue", () =>
  using(async (w) => {
    const { linear } = w;
    const hidden = linear.issue(), canceled = linear.issue();
    await w.imported();
    w.edit(w.task(hidden), { archivedAt: linear.tick() });
    w.edit(w.task(canceled), { archivedAt: linear.tick(), closedAs: "canceled" });
    await w.sync();
    assert.equal(there(w, hidden).state, linear.states.todo.id);
    assert.equal(there(w, canceled).state, linear.states.canceled.id);
    w.edit(w.task(canceled), { archivedAt: null });
    await w.sync();
    assert.equal(there(w, canceled).state, linear.states.todo.id, "and restoring it opens it again");
  }));

test("an issue Linear archives long after it was done stays done here", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue({ state: linear.states.done.id });
    await w.imported({ scope: "all" });
    linear.archive(issue);
    await w.sync();
    assert.equal(w.task(issue).stage, "done");
    assert.equal(w.task(issue).archivedAt ?? null, null);
    assert.equal(w.task(issue).tracker?.standing, "synced");
  }));

test("changed on both sides, the newer one wins and the other can be put back", () =>
  using(async (w) => {
    const { linear } = w;
    const mineLater = linear.issue({ title: "Start" }), theirsLater = linear.issue({ title: "Start" });
    await w.imported();
    linear.edit(mineLater, { title: "Theirs, earlier" });
    w.edit(w.task(mineLater), { title: "Mine, later" });
    w.edit(w.task(theirsLater), { title: "Mine, earlier", estimate: 5 });
    w.service.noticed();
    await new Promise((resolve) => setTimeout(resolve, 20));
    linear.edit(theirsLater, { title: "Theirs, later" });
    await w.sync();
    assert.equal(w.task(mineLater).title, "Mine, later");
    assert.equal(there(w, mineLater).title, "Mine, later");
    assert.equal(w.task(theirsLater).title, "Theirs, later");
    assert.equal(there(w, theirsLater).title, "Theirs, later");
    assert.equal(there(w, theirsLater).estimate, 5, "another field of the same card is no conflict");
    const kept = w.task(theirsLater).tracker!.kept![0];
    assert.deepEqual([kept.field, kept.value, kept.from], ["title", "Mine, earlier", "here"]);
    assert.equal(w.task(mineLater).tracker!.kept![0].value, "Theirs, earlier");

    await w.service.restore(w.task(theirsLater).id, "title");
    assert.equal(w.task(theirsLater).title, "Mine, earlier");
    assert.equal(there(w, theirsLater).title, "Mine, earlier");
    await w.service.restore(w.task(mineLater).id, "title");
    assert.equal(there(w, mineLater).title, "Theirs, earlier");
    assert.deepEqual(w.task(mineLater).tracker!.kept, []);
  }));

test("the same value on both sides is agreement, not a conflict", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue();
    await w.imported();
    linear.edit(issue, { priority: 1, state: linear.states.progress.id });
    w.edit(w.task(issue), { priority: "urgent", statusId: w.lane("working") });
    await w.sync();
    assert.equal(linear.countOf("UpdateIssue"), 0);
    assert.equal(w.task(issue).tracker?.kept, undefined);
    await w.sync();
    assert.equal(w.task(issue).tracker?.standing, "synced");
  }));

test("what Linear refuses is said on the card and asked again only when it changes", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue();
    await w.imported();
    linear.before = (operation, variables) =>
      operation === "UpdateIssue" && variables.input.title === "Forbidden"
        ? linear.json({ errors: [{ message: "x", extensions: { code: "FORBIDDEN", userPresentableMessage: "You cannot edit this issue." } }] }, 400)
        : undefined;
    w.edit(w.task(issue), { title: "Forbidden" });
    for (let n = 0; n < 4; n++) await w.sync();
    assert.equal(linear.countOf("UpdateIssue"), 1, "asked once");
    assert.equal(w.task(issue).tracker?.standing, "attention");
    assert.equal(w.task(issue).tracker?.note, "Linear refused this: You cannot edit this issue.");
    assert.equal(w.task(issue).title, "Forbidden", "nothing is dropped");
    await w.service.retry(w.task(issue).id);
    assert.equal(linear.countOf("UpdateIssue"), 2, "again when the person says so");
    w.edit(w.task(issue), { title: "Allowed" });
    await w.sync();
    assert.equal(there(w, issue).title, "Allowed");
    assert.equal(w.task(issue).tracker?.standing, "synced");
    assert.equal(w.task(issue).tracker?.note, undefined);
  }));

test("a value Linear refuses does not hold back the others", () =>
  using(async (w) => {
    const { linear } = w;
    linear.label("Chore", false, "Type");
    linear.label("Docs", false, "Type");
    const issue = linear.issue();
    await w.imported();
    w.edit(w.task(issue), { labels: ["Chore", "Docs"], title: "Goes on its own", priority: "high" });
    for (let n = 0; n < 4; n++) await w.sync();
    assert.equal(there(w, issue).title, "Goes on its own");
    assert.equal(there(w, issue).priority, 2);
    assert.deepEqual(there(w, issue).labels, []);
    assert.match(w.task(issue).tracker?.note ?? "", /Only one label in a group/);
    assert.equal(w.task(issue).tracker?.standing, "attention");
    const asked = linear.countOf("UpdateIssue");
    const read = linear.countOf("Issue");
    for (let n = 0; n < 5; n++) await w.sync();
    assert.equal(linear.countOf("Issue"), read, "a refused value costs no more calls");
    // A later change goes out alone, and the refused one is not asked again.
    w.edit(w.task(issue), { title: "And once more" });
    for (let n = 0; n < 3; n++) await w.sync();
    assert.equal(there(w, issue).title, "And once more");
    assert.equal(linear.countOf("UpdateIssue"), asked + 1);
    assert.equal(w.task(issue).tracker?.standing, "attention", "the card still says so");
    assert.deepEqual(w.task(issue).labels, ["Chore", "Docs"], "nothing is dropped");
    w.edit(w.task(issue), { labels: ["Docs"] });
    for (let n = 0; n < 2; n++) await w.sync();
    assert.equal(there(w, issue).labels.length, 1);
    assert.equal(w.task(issue).tracker?.standing, "synced");
    assert.equal(w.task(issue).tracker?.note, undefined);
  }));

test("a refused value that is set back here is no longer held against the card", () =>
  using(async (w) => {
    const { linear } = w;
    linear.label("Chore", false, "Type");
    linear.label("Docs", false, "Type");
    const issue = linear.issue();
    await w.imported();
    w.edit(w.task(issue), { labels: ["Chore", "Docs"] });
    await w.sync();
    assert.equal(w.task(issue).tracker?.standing, "attention");
    w.edit(w.task(issue), { labels: [] });
    for (let n = 0; n < 2; n++) await w.sync();
    assert.equal(w.task(issue).tracker?.standing, "synced");
    assert.equal(w.task(issue).tracker?.note, undefined);
  }));

test("a new task with a value Linear refuses is an issue all the same", () =>
  using(async (w) => {
    const { linear } = w;
    linear.label("Chore", false, "Type");
    linear.label("Docs", false, "Type");
    linear.issue();
    await w.imported();
    const task = w.newTask({ title: "From here", description: "Why", priority: "high", labels: ["Chore", "Docs"] });
    for (let n = 0; n < 4; n++) await w.sync();
    const made = [...linear.issues.values()].find((item) => item.title === "From here")!;
    assert.ok(made, "it is an issue");
    assert.equal(made.description, "Why");
    assert.equal(made.priority, 2, "what it does take is there");
    assert.deepEqual(made.labels, []);
    const here = w.state.tasks.find((item) => item.id === task.id)!;
    assert.match(here.tracker?.note ?? "", /Only one label in a group/);
    assert.deepEqual(here.labels, ["Chore", "Docs"]);
    assert.equal([...linear.issues.values()].filter((item) => item.title === "From here").length, 1);
    w.edit(here, { labels: ["Docs"] });
    for (let n = 0; n < 2; n++) await w.sync();
    assert.equal(linear.issues.get(made.id)!.labels.length, 1);
    assert.equal(here.tracker?.standing, "synced");
  }));

test("a refused field does not hold back a change that comes from Linear", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue();
    await w.imported();
    linear.before = (operation) =>
      operation === "UpdateIssue" ? linear.json({ errors: [{ message: "No", extensions: { code: "FORBIDDEN" } }] }, 400) : undefined;
    w.edit(w.task(issue), { title: "Refused" });
    await w.sync();
    linear.edit(issue, { estimate: 5 });
    await w.sync();
    assert.equal(w.task(issue).estimate, 5);
    assert.equal(w.task(issue).title, "Refused");
    assert.equal(w.task(issue).tracker?.standing, "attention");
  }));

test("a new task here becomes one issue, also when the answer gets lost", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export", ["First"]);
    linear.issue({ project: project.id, milestone: project.milestones[0].id });
    await w.imported();
    const goal = w.state.epics[0].id;
    const task = w.newTask({ title: "From here", description: "- why", priority: "high", labels: ["fresh"], epicId: goal, estimate: 2, statusId: w.lane("planned-without-cycle") });
    let lost = 2;
    linear.before = (operation) => (operation === "CreateIssue" && lost-- > 0 ? "lose" : undefined);
    for (let n = 0; n < 4; n++) {
      linear.tick(400_000);
      await w.sync();
    }
    const made = [...linear.issues.values()].filter((issue) => issue.title === "From here");
    assert.equal(made.length, 1);
    assert.equal(made[0].id, task.id);
    assert.deepEqual([made[0].priority, made[0].estimate, made[0].milestone, made[0].state], [2, 2, project.milestones[0].id, linear.states.todo.id]);
    assert.deepEqual(made[0].labels.map((id) => linear.labels.get(id)?.name), ["fresh"]);
    assert.equal(w.task(made[0]).tracker?.key, linear.key(made[0]));
    assert.equal(w.state.tasks.length, 2, "and it does not come back as a second card");
    linear.edit(made[0], { title: "Renamed there" });
    await w.sync();
    assert.equal(w.state.tasks.find((item) => item.id === task.id)!.title, "Renamed there");
  }));

test("a task can stay in MemCode, and older ones are not sent by surprise", () =>
  using(async (w) => {
    const { linear } = w;
    const older = w.newTask({ title: "Older" });
    linear.tick(60_000);
    await w.imported();
    w.newTask({ title: "Kept", keepHere: true });
    w.newTask({ title: "Archived", archivedAt: linear.tick() });
    const count = linear.issues.size;
    await w.sync();
    assert.equal(linear.issues.size, count);
    assert.equal(older.tracker, undefined);
    w.newTask({ title: "Sent" });
    await w.sync();
    assert.equal(linear.issues.size, count + 1);
  }));

test("an issue that cannot be made stays a task here and says why", () =>
  using(async (w) => {
    const { linear } = w;
    await w.imported();
    linear.before = (operation) =>
      operation === "CreateIssue" ? linear.json({ errors: [{ message: "No", extensions: { code: "FORBIDDEN", userPresentableMessage: "Issues are limited on your plan." } }] }, 400) : undefined;
    w.newTask({ title: "Refused" });
    for (let n = 0; n < 3; n++) await w.sync();
    assert.equal(linear.countOf("CreateIssue"), 2, "once, and once with its words alone");
    assert.equal(w.state.tasks.at(-1)!.tracker, undefined);
  }));

test("comments go both ways, with replies, edits and deletions", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue();
    const theirs = linear.comment(issue, "Excel too?");
    await w.imported();
    const task = w.task(issue);
    const mine = {
      id: crypto.randomUUID(),
      taskId: task.id,
      text: "Yes, - and PDF",
      author: { id: "local-owner", name: "You", source: "local" as const },
      parentId: w.state.storyComments![0].id,
      createdAt: linear.tick(),
      updatedAt: linear.tick(),
    };
    w.state.storyComments!.push(mine);
    w.state.storyComments!.push({ ...mine, id: crypto.randomUUID(), text: "From a teammate", parentId: undefined as never, author: { id: "acc", name: "Sam Rao", source: "memtrace" } });
    await w.sync();
    const sent = linear.comments.get(mine.id)!;
    assert.equal(sent.body, "Yes, - and PDF");
    assert.equal(sent.parent, theirs.id);
    assert.equal([...linear.comments.values()].at(-1)!.body, "**Sam Rao**, in MemCode:\n\nFrom a teammate");
    // Edited on either side.
    const live = w.state.storyComments!.find((item) => item.id === mine.id)!;
    live.text = "Yes, and PDF.";
    linear.comments.get(theirs.id)!.body = "Excel and Numbers?";
    linear.comments.get(theirs.id)!.updatedAt = linear.tick();
    await w.sync();
    assert.equal(linear.comments.get(mine.id)!.body, "Yes, and PDF.");
    assert.equal(w.state.storyComments![0].text, "Excel and Numbers?");
    // Answered there, deleted here.
    linear.comment(issue, "Good.", { parent: mine.id });
    live.deletedAt = linear.tick();
    live.text = "";
    await w.sync();
    assert.equal(linear.comments.has(mine.id), false);
    const answer = w.state.storyComments!.find((item) => item.text === "Good.")!;
    assert.equal(answer.parentId, theirs.id, "a thread has one level here");
    const before = linear.calls.length;
    await w.sync();
    assert.equal(linear.calls.slice(before).some((call) => /Comment$/.test(call.operation)), false, "nothing goes round in circles");
  }));

test("a comment whose answer got lost is not written twice", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue();
    await w.imported();
    w.state.storyComments!.push({ id: crypto.randomUUID(), taskId: w.task(issue).id, text: "Once", author: { id: "local-owner", name: "You", source: "local" }, createdAt: linear.tick(), updatedAt: linear.tick() });
    let lost = 1;
    linear.before = (operation) => (operation === "CreateComment" && lost-- > 0 ? "lose" : undefined);
    for (let n = 0; n < 3; n++) {
      linear.tick(400_000);
      await w.sync();
    }
    assert.deepEqual([...linear.comments.values()].map((item) => item.body), ["Once"]);
    assert.equal(w.state.storyComments!.length, 1);
  }));

test("a pull request is linked once on every issue that is in it", () =>
  using(async (w) => {
    const { linear } = w;
    const project = linear.project("Export");
    const a = linear.issue({ project: project.id }), b = linear.issue({ project: project.id }), c = linear.issue({ project: project.id });
    await w.imported();
    const epicId = w.state.epics[0].id;
    for (const issue of [a, b]) w.task(issue).run.branch = "feat/export";
    const url = "https://github.com/acme/app/pull/12";
    w.state.pullRequests = [
      { epicId, branch: "feat/export", base: "main", url, number: 12, state: "open", createdAt: linear.tick(), updatedAt: linear.tick() },
      { epicId, branch: "feat/draft", base: "main", url: "https://github.com/acme/app/compare/main...feat/draft", createdAt: linear.tick(), updatedAt: linear.tick() },
    ];
    for (let n = 0; n < 3; n++) await w.sync();
    assert.deepEqual([there(w, a).links, there(w, b).links, there(w, c).links], [[url], [url], []]);
    // Shipped, and moved to another goal in Linear before its pull request was linked.
    const elsewhere = linear.project("Billing");
    const d = linear.issue({ project: elsewhere.id });
    await w.sync();
    Object.assign(w.task(d).run, { branch: "feat/export", shipped: true, state: "finished" });
    await w.sync();
    assert.deepEqual(there(w, d).links, [url]);
  }));

test("only bringing in sends nothing", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue({ title: "Start" });
    await w.imported({ direction: "in" });
    w.edit(w.task(issue), { title: "Mine", estimate: 2 });
    w.newTask();
    await w.sync();
    linear.edit(issue, { title: "Theirs" });
    await w.sync();
    assert.equal(w.task(issue).title, "Theirs", "Linear is followed");
    assert.equal(w.task(issue).tracker!.kept![0].value, "Mine", "and what was here is kept");
    assert.equal(w.task(issue).estimate, 2);
    for (const operation of ["UpdateIssue", "CreateIssue", "CreateComment", "LinkUrl"]) assert.equal(linear.countOf(operation), 0, operation);
  }));

test("a card deleted here is not brought in again, and one unlinked goes its own way", () =>
  using(async (w) => {
    const { linear } = w;
    const deleted = linear.issue(), unlinked = linear.issue({ title: "Start" });
    await w.imported();
    w.state.tasks = w.state.tasks.filter((task) => task.id !== w.task(deleted).id);
    await w.service.unlink(w.task(unlinked).id);
    linear.edit(deleted, { title: "Changed there" });
    linear.edit(unlinked, { title: "Changed there" });
    w.edit(w.task(unlinked), { estimate: 8 });
    await w.sync();
    assert.equal(w.task(deleted), undefined);
    assert.equal(linear.issues.has(deleted.id), true, "MemCode deletes nothing in Linear");
    assert.equal(w.task(unlinked).title, "Start");
    assert.equal(there(w, unlinked).estimate, null);
    assert.equal(w.state.tasks.length, 1);
  }));

test("new issues come in when they fit what was chosen", () =>
  using(async (w) => {
    const { linear } = w;
    await w.imported();
    const open = linear.issue({ title: "Open" });
    const triage = linear.issue({ title: "Triage", state: linear.states.triage.id });
    linear.issue({ title: "Done", state: linear.states.done.id });
    linear.issue({ title: "Elsewhere", team: linear.otherTeam.id });
    await w.sync();
    assert.deepEqual(w.state.tasks.map((task) => task.title), ["Open"]);
    assert.ok(w.task(open));
    linear.edit(triage, { state: linear.states.todo.id });
    await w.sync();
    assert.deepEqual(w.state.tasks.map((task) => task.title), ["Open", "Triage"], "once it is accepted there");
  }));

test("a status, label, person, cycle, milestone or project made after the import is understood", () =>
  using(async (w) => {
    const { linear } = w;
    const issue = linear.issue();
    await w.imported();
    const project = linear.project("New project", ["New milestone"]);
    const cycle = linear.cycle("Cycle 6", "2026-12-07T00:00:00.000Z", "2026-12-21T00:00:00.000Z");
    const label = linear.label("new label");
    linear.states.qa = { id: crypto.randomUUID(), name: "QA", type: "started", position: 5.5 };
    const person = { id: crypto.randomUUID(), name: "Sam Rao", email: "sam@example.invalid" };
    Object.assign(linear.users, { sam: person });
    linear.edit(issue, { project: project.id, milestone: project.milestones[0].id, cycle: cycle.id, labels: [label.id], assignee: person.id, state: linear.states.qa.id });
    await w.sync();
    const task = w.task(issue);
    assert.equal(w.state.epics.find((item) => item.id === task.epicId)?.title, "New milestone · New project");
    assert.equal(w.state.cycles.find((item) => item.id === task.cycleId)?.name, "Cycle 6");
    assert.deepEqual(task.labels, ["new label"]);
    assert.equal(task.assignee?.name, "Sam Rao");
    assert.equal(task.tracker?.status, "QA");
    assert.equal(linear.countOf("UpdateIssue"), 0);
  }));

test("a goal follows its name in Linear until it has one of its own", () =>
  using(async (w) => {
    const { linear } = w;
    const first = linear.project("Export"), second = linear.project("Billing");
    linear.issue({ project: first.id });
    linear.issue({ project: second.id });
    await w.imported();
    w.state.epics.find((item) => item.title === "Billing")!.title = "Invoices, mine";
    first.name = "Export reports";
    second.name = "Payments";
    linear.tick(11 * 60_000);
    await w.sync();
    assert.deepEqual(w.state.epics.map((item) => item.title).sort(), ["Export reports", "Invoices, mine"]);
  }));

test("a cycle that Linear starts, ends and rolls over is followed", () =>
  using(async (w) => {
    const { linear } = w;
    const five = linear.cycle("Cycle 5", "2026-11-22T23:00:00.000Z", "2026-12-06T23:00:00.000Z", { isActive: true });
    const six = linear.cycle("Cycle 6", "2026-12-06T23:00:00.000Z", "2026-12-20T23:00:00.000Z");
    const done = linear.issue({ cycle: five.id }), open = linear.issue({ cycle: five.id });
    await w.imported();
    const cycle = (name: string) => w.state.cycles.find((item) => item.name === name)!;
    assert.deepEqual([cycle("Cycle 5").state, cycle("Cycle 6").state], ["active", "planned"]);
    linear.edit(done, { state: linear.states.done.id });
    await w.sync();
    // Midnight, in Linear.
    Object.assign(five, { isActive: false, completedAt: "2026-12-06T23:00:00.000Z" });
    Object.assign(six, { isActive: true });
    linear.edit(open, { cycle: six.id });
    linear.tick(11 * 60_000);
    await w.sync();
    assert.deepEqual([cycle("Cycle 5").state, cycle("Cycle 6").state], ["completed", "active"]);
    assert.ok(cycle("Cycle 5").snapshots.length >= 1, "its closing count is kept");
    assert.equal(w.task(open).cycleId, cycle("Cycle 6").id);
    assert.equal(w.task(done).cycleId, cycle("Cycle 5").id);
    assert.equal(linear.countOf("UpdateIssue"), 0);
  }));

test("an issue that was moved away or taken from the person says so and is kept", () =>
  using(async (w) => {
    const { linear } = w;
    const moved = linear.issue(), hidden = linear.issue(), stays = linear.issue();
    await w.imported();
    linear.edit(moved, { team: linear.otherTeam.id });
    linear.issues.delete(hidden.id);
    linear.tick(13 * 3_600_000);
    await w.sync();
    const note = (issue: FakeIssue) => w.task(issue).tracker;
    assert.equal(note(moved)?.standing, "attention");
    assert.match(note(moved)!.note!, /Moved to another team/);
    assert.equal(note(hidden)?.standing, "unlinked");
    assert.equal(note(stays)?.standing, "synced");
    assert.equal(w.state.tasks.length, 3);
    w.edit(w.task(hidden), { title: "Goes on here" });
    await w.sync();
    assert.equal(linear.countOf("UpdateIssue"), 0);
  }));
