import test from "node:test";
import assert from "node:assert/strict";
import { hereOf, same, toThere, thereOf, type Frame } from "../runtime/trackers/linear/fields";
import { readIssue } from "../runtime/trackers/linear/read";
import { trackedFields, type TrackedField } from "../src/tracker";
import type { WorkItem } from "../src/shared";
import { rewritten, type FakeIssue } from "./support/fake-linear";
import { linearWorld, type LinearWorld } from "./support/linear-world";

/** Numbers that are the same every time, so that a run that fails can be run again. */
function dice(seed: number) {
  return (sides: number) => {
    seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) | 0;
    const mixed = Math.imul(seed ^ (seed >>> 7), 61 | seed) ^ seed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) % sides;
  };
}

const fields = ["title", "description", "priority", "estimate", "dueDate", "labels", "assignee", "status", "cycle", "goal"] as const;

/** One person at MemCode, one in Linear, a bad network, and MemCode closed now and then. */
async function run(seed: number, steps: number, withWorkers = false, withTrash = false) {
  const w = await linearWorld();
  const roll = dice(seed);
  const pick = <T>(list: T[]): T => list[roll(list.length)];
  const { linear } = w;
  const projects = [linear.project("Export", ["First", "Second"]), linear.project("Billing")];
  const cycles = [
    linear.cycle("Cycle 5", "2026-11-22T23:00:00.000Z", "2026-12-06T23:00:00.000Z", { isActive: true }),
    linear.cycle("Cycle 6", "2026-12-06T23:00:00.000Z", "2026-12-20T23:00:00.000Z"),
  ];
  const labels = ["red", "green", "blue"].map((name) => linear.label(name));
  const places = [
    { project: null, milestone: null },
    { project: projects[0].id, milestone: projects[0].milestones[0].id },
    { project: projects[0].id, milestone: projects[0].milestones[1].id },
    { project: projects[1].id, milestone: null },
  ];
  for (let n = 0; n < 6; n++) linear.issue({ ...pick(places), state: pick([linear.states.todo, linear.states.backlog, linear.states.progress]).id });
  // Every goal has an issue, so that a card can be moved to any of them.
  for (const place of places) linear.issue(place);
  await w.imported();
  let trouble = true;
  linear.before = (operation) => {
    if (!trouble || roll(6) > 0) return undefined;
    const kind = roll(4);
    return kind === 0 ? "offline" : kind === 1 ? linear.limited(1) : kind === 2 && /^(Update|Create)/.test(operation) ? "lose" : undefined;
  };
  /** When each side last changed a field, and to what: the newest is what must remain. */
  const last = new Map<string, { at: string; side: "here" | "there"; label: string }>();
  let words = 0;
  const settle = async () => {
    w.service.noticed();
    // What it remembers is read from a file after MemCode was opened again.
    await (w.service as unknown as { memoryOf(id: string): Promise<unknown> }).memoryOf(w.connection.id);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const editThere = () => {
    const issue = pick([...linear.issues.values()]);
    const field = pick([...fields]);
    const word = `there ${++words}`;
    const values: Record<(typeof fields)[number], Partial<FakeIssue>> = {
      title: { title: word },
      description: { description: rewritten(word) },
      priority: { priority: roll(5) },
      estimate: { estimate: pick([null, 1, 3, 8]) },
      dueDate: { dueDate: pick([null, "2026-12-01", "2026-12-24"]) },
      labels: { labels: labels.filter(() => roll(2)).map((label) => label.id) },
      assignee: { assignee: pick([null, linear.users.alex.id, linear.users.dana.id]) },
      status: { state: pick([linear.states.backlog, linear.states.todo, linear.states.ready, linear.states.progress, linear.states.review, linear.states.done, linear.states.canceled]).id },
      cycle: { cycle: pick([null, ...cycles.map((cycle) => cycle.id)]) },
      goal: pick(places),
    };
    linear.edit(issue, values[field]);
    last.set(issue.id + field, { at: issue.updatedAt, side: "there", label: word });
  };
  const editHere = async () => {
    const task = pick(w.state.tasks.filter((item) => item.tracker)) as WorkItem | undefined;
    if (!task) return;
    const field = pick([...fields]);
    const word = `here ${++words}`;
    const patches: Record<(typeof fields)[number], Parameters<LinearWorld["edit"]>[1]> = {
      title: { title: word },
      description: { description: word + "\n- a\n- b  " },
      priority: { priority: pick(["urgent", "high", "medium", "low", "none"] as const) },
      estimate: { estimate: pick([null, 1, 3, 8]) },
      dueDate: { dueDate: pick([null, "2026-12-01", "2026-12-24"]) },
      labels: { labels: ["red", "green", "blue", "new " + roll(3)].filter(() => roll(2)) },
      assignee: { assignee: pick([null, { id: linear.users.alex.id, name: "Alex Berg" }, { id: linear.users.dana.id, name: "Dana Ito" }]) },
      status: pick([{ statusId: w.lane("planned") }, { statusId: w.lane("working") }, { statusId: w.lane("review") }, { statusId: w.lane("done") }, { archivedAt: linear.tick(), closedAs: "canceled" as const }, { archivedAt: null }]),
      cycle: { cycleId: pick([null, ...w.state.cycles.map((cycle) => cycle.id)]) },
      goal: { epicId: pick(w.state.epics.filter((epic) => epic.tracker).map((epic) => epic.id)) },
    };
    const before = JSON.stringify(task);
    try {
      w.edit(task, patches[field]);
    } catch {
      return; // MemCode itself would not let a person do that.
    }
    if (JSON.stringify({ ...task, updatedAt: "" }) === JSON.stringify({ ...JSON.parse(before), updatedAt: "" })) return;
    last.set(task.tracker!.id + field, { at: task.updatedAt, side: "here", label: word });
    await settle();
  };
  /** Deleted or put back there, or in another team for a while. Linear tells nobody. */
  const trash = () => {
    const issue = pick([...linear.issues.values()]);
    if (issue.trashed) linear.bin(issue, false);
    else if (issue.team !== linear.team.id) linear.edit(issue, { team: linear.team.id });
    else if (roll(2)) linear.bin(issue);
    else linear.edit(issue, { team: linear.otherTeam.id });
  };
  /** A worker starts, ends well or badly, or what it made ships. */
  const worker = async () => {
    const task = pick(w.state.tasks.filter((item) => item.tracker && !item.archivedAt)) as WorkItem | undefined;
    if (!task) return;
    const to = (stage: WorkItem["stage"]) => {
      task.stage = stage;
      task.statusId = w.lane(stage);
      task.updatedAt = linear.tick();
    };
    if (task.run.state === "running") {
      task.run.state = pick(["finished", "finished", "failed", "stopped"] as const);
      to("review");
    } else if (task.run.startedAt && !task.run.shipped && roll(2)) {
      task.run.shipped = true;
      to("done");
    } else {
      task.run = { state: "running", startedAt: linear.tick(), branch: "feat/export" };
      to("working");
    }
    await settle();
  };
  for (let step = 0; step < steps; step++) {
    const what = roll(withWorkers ? 14 : 12);
    if (what >= 12) {
      await worker();
      continue;
    }
    if (what < 4 && withTrash && roll(4) === 0) trash();
    else if (what < 4) editThere();
    else if (what < 8) await editHere();
    else if (what < 11) {
      linear.tick(roll(3) * 40_000);
      await (roll(3) ? w.sync() : w.service.sync(w.connection.id, "send")).catch(() => {});
    } else if (roll(3) === 0) await w.restart(roll(2) === 0);
  }
  trouble = false;
  for (const issue of linear.issues.values()) {
    if (issue.trashed) linear.bin(issue, false);
    if (issue.team !== linear.team.id) linear.edit(issue, { team: linear.team.id });
  }
  // What is being worked on ends and ships.
  for (const task of w.state.tasks)
    if (task.run.startedAt && !task.run.shipped) {
      task.run.state = "finished";
      task.run.shipped = true;
      if (!task.archivedAt) {
        task.stage = "done";
        task.statusId = w.lane("done");
      }
      task.updatedAt = linear.tick();
    }
  for (let n = 0; n < 4; n++) {
    linear.tick(400_000);
    // What was edited and deleted at once on a finished issue is found when all is compared.
    if (withTrash && n === 0) linear.tick(13 * 3_600_000);
    await w.sync();
  }
  const writes = linear.calls.filter((call) => /^(Update|Create)/.test(call.operation)).length;
  for (let n = 0; n < 3; n++) {
    linear.tick(60_000);
    await w.sync();
  }
  const echoes = linear.calls.filter((call) => /^(Update|Create)/.test(call.operation)).length - writes;
  const frame: Frame = {
    state: w.state,
    connection: w.connection,
    statuses: new Map(w.connection.statuses!.map((item) => [item.id, item])),
    labels: new Map([...linear.labels.values()].map((label) => [label.id, label])),
    people: new Map(w.connection.people!.map((person) => [person.id, person])),
  };
  const apart: string[] = [];
  const lost: string[] = [];
  for (const issue of linear.issues.values()) {
    const tasks = w.state.tasks.filter((task) => task.tracker?.id === issue.id);
    if (tasks.length !== 1) apart.push(`${linear.key(issue)} has ${tasks.length} cards`);
    const [task] = tasks;
    if (!task) continue;
    const there = thereOf(readIssue((linear as any).issueNode(issue))!, frame);
    const here = hereOf(task, frame);
    for (const field of trackedFields) {
      const said = toThere(field, here[field], frame, there, task);
      if (said === undefined) continue;
      // What is in a cycle shows as planned; its status there stays Backlog.
      if (field === "status" && there.status === linear.states.backlog.id && there.cycle && here.status === w.lane("planned")) continue;
      const agree = field === "description" ? rewritten(String(said)) === there.description : same(said, there[field]);
      if (!agree) apart.push(`${linear.key(issue)} ${field}: here ${JSON.stringify(here[field])}, there ${JSON.stringify(there[field])}`);
    }
    for (const field of ["title", "description"] as const) {
      const newest = last.get(issue.id + field);
      if (newest && !String(there[field as TrackedField]).startsWith(newest.label))
        lost.push(`${linear.key(issue)} ${field}: ${newest.label} (${newest.side}) became ${there[field as TrackedField]}`);
    }
  }
  const standing = w.state.tasks.filter((task) => task.tracker && task.tracker.standing !== "synced").map((task) => `${task.identifier} ${task.tracker!.standing} ${task.tracker!.note ?? ""}`);
  await w.end();
  return { apart, lost, echoes, standing, calls: linear.calls.length };
}

for (const [withWorkers, withTrash] of [[false, false], [true, false], [false, true], [true, true]])
test(`whatever happens in between${withWorkers ? ", with workers on it" : ""}${withTrash ? ", with issues deleted and moved" : ""}, both sides end up the same, with the newest of everything`, async () => {
  const runs = Number(process.env.LINEAR_RUNS ?? 40);
  for (let seed = 1; seed <= runs; seed++) {
    const result = await run(seed * 7919, Number(process.env.LINEAR_STEPS ?? 160), withWorkers, withTrash);
    assert.deepEqual(result.apart, [], `run ${seed}: out of step`);
    assert.deepEqual(result.lost, [], `run ${seed}: a newer value was lost`);
    assert.equal(result.echoes, 0, `run ${seed}: something goes round in circles`);
    assert.deepEqual(result.standing, [], `run ${seed}: a card does not know it is in step`);
  }
});
