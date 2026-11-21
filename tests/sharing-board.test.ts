import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import type { AppState, Epic, Project, WorkItem } from "../src/shared";
import { applyBoard, boardOf } from "../runtime/sharing/board/board";
import { emptyBoard, type Board } from "../runtime/sharing/board/document";

const at = "2026-11-21T12:00:00.000Z";
const project = (id: string, name: string): Project => ({
  id,
  name,
  description: "",
  path: `/work/${name}`,
  branch: "main",
  analysis: "idle",
  createdAt: at,
});
function workspace(projectId: string): AppState {
  const state = initialState();
  state.projects.push(project(projectId, "website"));
  state.activeProjectId = projectId;
  state.storyComments = [];
  return state;
}
const goal = (projectId: string, changes: Partial<Epic> = {}): Epic => ({
  id: "goal-1",
  projectId,
  identifier: "EP-01",
  title: "Customers can export reports",
  description: "As CSV and as PDF.",
  phase: "now",
  color: "mint",
  order: 0,
  branch: "epic/ep-01-reports",
  baseBranch: "dev",
  ...changes,
});
const task = (
  projectId: string,
  changes: Partial<WorkItem> = {},
): WorkItem => ({
  id: "task-1",
  identifier: "MC-001",
  projectId,
  title: "Export as CSV",
  description: "Line one.\nLine two.",
  stage: "working",
  statusId: `${projectId}:working`,
  priority: "high",
  category: "Work",
  kind: "feature",
  harness: "claude",
  assignment: "manual",
  modelOverride: "the model this computer chose",
  epicId: "goal-1",
  cycleId: "cycle-1",
  parentId: null,
  estimate: 3,
  startDate: "2026-11-20",
  dueDate: null,
  labels: ["urgent", "export"],
  scope: ["src/export", "C:\\work\\website\\src\\secret.ts", "docs/"],
  dependsOn: ["task-0"],
  relatedIds: ["task-9"],
  duplicateOf: null,
  customFields: { "field-1": "blue", "field-2": 2 },
  checklist: [
    { id: "step-1", text: "Read the code", done: true },
    { id: "step-2", text: "Write it", done: false },
  ],
  messages: [{ id: "m1", role: "tool", text: "PRIVATE TOOL OUTPUT", at }],
  run: {
    state: "idle",
    workspace: "/private/checkout",
    sessionId: "secret-session",
  },
  diff: "PRIVATE DIFF",
  createdAt: at,
  updatedAt: at,
  ...changes,
});
/** A whole project on the Mac, as MemCode keeps it. */
function mac(): AppState {
  const state = workspace("mac-project");
  state.epics.push(goal("mac-project"));
  state.cycles.push({
    id: "cycle-1",
    projectId: "mac-project",
    name: "Week 47",
    goal: "Ship the export",
    startDate: "2026-11-16",
    endDate: "2026-11-22",
    timeZone: "Europe/Copenhagen",
    state: "active",
    capacity: 20,
    calendar: "weekdays",
    createdAt: at,
    startedAt: at,
    snapshots: [],
  });
  state.tasks.push(task("mac-project"));
  state.storyComments!.push({
    id: "comment-1",
    taskId: "task-1",
    text: "Looks right to me.",
    author: { id: "acct-alex", name: "Alex Holm", source: "memtrace" },
    createdAt: at,
    updatedAt: at,
  });
  state.workflowStates.push(
    {
      id: "mac-project:working",
      projectId: "mac-project",
      name: "In progress",
      stage: "working",
      color: "#18c8b5",
      order: 2,
    },
    {
      id: "5d3a2f0e-5a52-4c1e-9d3e-2f1f5f3a9c11",
      projectId: "mac-project",
      name: "Blocked",
      stage: "working",
      color: "#cc8",
      order: 3,
      wipLimit: 2,
    },
  );
  state.customFields.push({
    id: "field-1",
    projectId: "mac-project",
    name: "Colour",
    type: "select",
    options: ["blue", "green"],
  });
  state.savedViews.push({
    id: "view-1",
    projectId: "mac-project",
    name: "Mine",
    mode: "list",
    groupBy: "epic",
    sortBy: "due",
    filters: {
      query: "",
      priority: "all",
      epicId: "goal-1",
      cycleId: "all",
      label: "all",
      kind: "all",
      harness: "all",
      archived: false,
    },
  });
  return state;
}
/** The same board arriving on a computer whose project has nothing in it yet. */
function arrivesOn(board: Board, projectId = "pc-project") {
  const state = workspace(projectId);
  applyBoard(state, projectId, emptyBoard(), board, { at });
  return state;
}

test("the board holds a project's plan and nothing a worker said or did", () => {
  const board = boardOf(mac(), "mac-project");
  const everything = JSON.stringify(board);
  for (const kept of [
    "PRIVATE",
    "secret",
    "/private/checkout",
    "the model this computer chose",
    "claude",
    "mac-project",
  ])
    assert.ok(!everything.includes(kept), `${kept} is on the board`);
  assert.deepEqual(board.tasks["task-1"], {
    fields: {
      identifier: "MC-001",
      title: "Export as CSV",
      stage: "working",
      lane: "working",
      priority: "high",
      kind: "feature",
      goal: "goal-1",
      cycle: "cycle-1",
      parent: null,
      estimate: 3,
      startDate: "2026-11-20",
      dueDate: null,
      duplicateOf: null,
      category: "Work",
      archived: false,
    },
    texts: { description: "Line one.\nLine two." },
    sets: {
      label: { urgent: true, export: true },
      scope: { "src/export": true, docs: true },
      depends: { "task-0": true },
      related: { "task-9": true },
      field: { "field-1": "blue", "field-2": 2 },
      step: {
        "step-1": { text: "Read the code", done: true, order: 0 },
        "step-2": { text: "Write it", done: false, order: 1 },
      },
    },
  });
  assert.deepEqual(Object.keys(board.lanes), [
    "working",
    "5d3a2f0e-5a52-4c1e-9d3e-2f1f5f3a9c11",
  ]);
  assert.deepEqual(Object.keys(boardOf(mac(), "example").tasks), []);
});

test("a board that arrives on a second computer becomes the same plan there, under that computer's project", () => {
  const board = boardOf(mac(), "mac-project");
  const pc = arrivesOn(board);
  assert.deepEqual(boardOf(pc, "pc-project"), board);
  const [arrived] = pc.tasks.filter((item) => item.projectId === "pc-project");
  assert.equal(arrived.statusId, "pc-project:working");
  assert.equal(arrived.harness, pc.settings.defaultHarness);
  assert.equal(arrived.assignment, "auto");
  assert.deepEqual(arrived.run, { state: "idle" });
  // A worker started here begins from the brief, as it does for a task made here.
  assert.deepEqual(
    arrived.messages.map((message) => [message.role, message.text]),
    [["user", "Line one.\nLine two."]],
  );
  assert.deepEqual(arrived.checklist, [
    { id: "step-1", text: "Read the code", done: true },
    { id: "step-2", text: "Write it", done: false },
  ]);
  assert.equal(pc.epics[0].projectId, "pc-project");
  assert.equal(pc.cycles[0].state, "active");
  assert.deepEqual(pc.workflowStates.map((lane) => lane.id).sort(), [
    "5d3a2f0e-5a52-4c1e-9d3e-2f1f5f3a9c11",
    "pc-project:working",
  ]);
  assert.equal(pc.savedViews[0].filters.epicId, "goal-1");
});

test("a change on the board changes the shared part of a task here and leaves its worker alone", () => {
  const state = mac();
  const before = boardOf(state, "mac-project");
  const after = structuredClone(before);
  Object.assign(after.tasks["task-1"].fields, {
    title: "Export as CSV and TSV",
    stage: "review",
    lane: "review",
    estimate: null,
  });
  after.tasks["task-1"].texts.description = "A new brief.";
  after.tasks["task-1"].sets.step["step-2"] = {
    text: "Write it",
    done: true,
    order: 1,
  };
  applyBoard(state, "mac-project", before, after, {
    at: "2026-11-22T08:00:00.000Z",
    stampOf: () => ({ changedAt: "2026-11-22T07:59:00.000Z" }),
  });
  const [changed] = state.tasks.filter((item) => item.id === "task-1");
  assert.equal(changed.title, "Export as CSV and TSV");
  assert.equal(changed.stage, "review");
  assert.equal(changed.statusId, "mac-project:review");
  assert.equal(changed.estimate, null);
  assert.equal(changed.description, "A new brief.");
  assert.equal(changed.checklist[1].done, true);
  assert.equal(changed.updatedAt, "2026-11-22T07:59:00.000Z");
  assert.equal(changed.harness, "claude");
  assert.equal(changed.modelOverride, "the model this computer chose");
  assert.equal(changed.messages[0].text, "PRIVATE TOOL OUTPUT");
  assert.equal(changed.run.sessionId, "secret-session");
  assert.equal(changed.diff, "PRIVATE DIFF");
  assert.equal(changed.createdAt, at);
});

test("only what changed on the board is touched: an edit made here in the meantime stays", () => {
  const state = mac();
  const before = boardOf(state, "mac-project");
  const after = structuredClone(before);
  after.goals["goal-1"].fields.title = "A new name for the goal";
  state.tasks.find((item) => item.id === "task-1")!.title =
    "Edited here, not sent yet";
  applyBoard(state, "mac-project", before, after, { at });
  assert.equal(state.epics[0].title, "A new name for the goal");
  assert.equal(
    state.tasks.find((item) => item.id === "task-1")!.title,
    "Edited here, not sent yet",
  );
});

test("a task deleted on the board goes, unless a worker is running on it here", () => {
  for (const running of [false, true]) {
    const state = mac();
    if (running)
      state.tasks.find((item) => item.id === "task-1")!.run.state = "running";
    const before = boardOf(state, "mac-project");
    const after = structuredClone(before);
    delete after.tasks["task-1"];
    delete after.goals["goal-1"];
    delete after.cycles["cycle-1"];
    applyBoard(state, "mac-project", before, after, { at });
    assert.equal(
      state.tasks.some((item) => item.id === "task-1"),
      running,
    );
    assert.equal(state.epics.length, 0);
    assert.equal(state.cycles.length, 0);
    // The example project and its tasks are no part of this.
    assert.ok(state.tasks.some((item) => item.example));
  }
});

test("a comment arrives under the name of whoever the log says sent it, and one taken back keeps its place", () => {
  const board = boardOf(mac(), "mac-project");
  const pc = workspace("pc-project");
  applyBoard(pc, "pc-project", emptyBoard(), board, {
    at,
    stampOf: (collection) =>
      collection === "comments"
        ? {
            createdAt: "2026-11-20T10:00:00.000Z",
            createdBy: "acct-dana",
            changedAt: "2026-11-20T10:05:00.000Z",
          }
        : undefined,
    nameOf: (account) => (account === "acct-dana" ? "Dana Ek" : undefined),
  });
  assert.deepEqual(pc.storyComments, [
    {
      id: "comment-1",
      taskId: "task-1",
      text: "Looks right to me.",
      parentId: undefined,
      reference: undefined,
      updatedAt: "2026-11-20T10:05:00.000Z",
      deletedAt: undefined,
      author: { id: "acct-dana", name: "Dana Ek", source: "memtrace" },
      createdAt: "2026-11-20T10:00:00.000Z",
    },
  ]);
  const without = structuredClone(board);
  delete without.comments["comment-1"];
  applyBoard(pc, "pc-project", board, without, {
    at: "2026-11-22T09:00:00.000Z",
  });
  assert.equal(pc.storyComments![0].deletedAt, "2026-11-22T09:00:00.000Z");
  assert.equal(boardOf(pc, "pc-project").comments["comment-1"], undefined);
  // Someone the project does not name is still shown as someone.
  const unnamed = workspace("pc-project");
  applyBoard(unnamed, "pc-project", emptyBoard(), board, { at });
  assert.equal(
    unnamed.storyComments![0].author.name,
    "Someone on this project",
  );
});

test("a value that cannot be what it claims is left out, and what was here stays", () => {
  const state = mac();
  const before = boardOf(state, "mac-project");
  const after = structuredClone(before);
  Object.assign(after.tasks["task-1"].fields, {
    title: "x".repeat(241),
    stage: "shipped",
    priority: 7,
    estimate: -1,
    startDate: "tomorrow",
    goal: 42,
    kind: null,
    archived: "yes",
  });
  after.tasks["task-1"].texts.description = "y".repeat(20001);
  after.tasks["task-1"].sets.step.bad = "not a step";
  after.tasks["task-1"].sets.field["field-3"] = { nested: true };
  after.tasks["task-1"].sets.scope["../outside"] = true;
  after.tasks["task-1"].sets.scope["/etc/passwd"] = true;
  after.goals["goal-1"].fields.phase = "never";
  after.goals["goal-1"].fields.order = "first";
  after.cycles["cycle-1"].fields.endDate = 5;
  applyBoard(state, "mac-project", before, after, { at });
  const kept = state.tasks.find((item) => item.id === "task-1")!;
  assert.equal(kept.title, "Export as CSV");
  assert.equal(kept.stage, "working");
  assert.equal(kept.priority, "high");
  assert.equal(kept.estimate, 3);
  assert.equal(kept.startDate, "2026-11-20");
  assert.equal(kept.epicId, "goal-1");
  assert.equal(kept.kind, "feature");
  assert.equal(kept.archivedAt, null);
  assert.equal(kept.description, "Line one.\nLine two.");
  assert.deepEqual(
    kept.checklist.map((step) => step.id),
    ["step-1", "step-2"],
  );
  assert.deepEqual(kept.customFields, { "field-1": "blue", "field-2": 2 });
  assert.deepEqual(kept.scope, ["src/export", "docs"]);
  assert.equal(state.epics[0].phase, "now");
  assert.equal(state.epics[0].order, 0);
  assert.equal(state.cycles[0].endDate, "2026-11-22");
});

test("an entry with nothing usable in it is not shown, and never breaks the rest", () => {
  const board = boardOf(mac(), "mac-project");
  board.tasks["nameless"] = {
    fields: { stage: "planned" },
    texts: {},
    sets: {},
  };
  board.tasks["task-2"] = structuredClone(board.tasks["task-1"]);
  board.tasks["task-2"].fields.identifier = "MC-002";
  board.goals["empty"] = { fields: {}, texts: {}, sets: {} };
  board.cycles["dateless"] = {
    fields: { name: "No dates" },
    texts: {},
    sets: {},
  };
  board.comments["orphan"] = { fields: { text: 5 }, texts: {}, sets: {} };
  board.lanes["nameless"] = {
    fields: { stage: "planned" },
    texts: {},
    sets: {},
  };
  const pc = arrivesOn(board);
  assert.deepEqual(
    pc.tasks
      .filter((item) => item.projectId === "pc-project")
      .map((item) => item.id)
      .sort(),
    ["task-1", "task-2"],
  );
  assert.equal(pc.epics.length, 1);
  assert.equal(pc.cycles.length, 1);
  assert.equal(pc.storyComments!.length, 1);
  assert.ok(!pc.workflowStates.some((lane) => lane.id.endsWith("nameless")));
});

test("archiving and closing are flags on the board and dates here", () => {
  const state = mac();
  const before = boardOf(state, "mac-project");
  const after = structuredClone(before);
  after.tasks["task-1"].fields.archived = true;
  after.goals["goal-1"].fields.closed = true;
  after.cycles["cycle-1"].fields.state = "completed";
  applyBoard(state, "mac-project", before, after, {
    at: "2026-11-23T10:00:00.000Z",
    stampOf: () => ({ changedAt: "2026-11-23T09:00:00.000Z" }),
  });
  assert.equal(
    state.tasks.find((item) => item.id === "task-1")!.archivedAt,
    "2026-11-23T09:00:00.000Z",
  );
  assert.equal(state.epics[0].closedAt, "2026-11-23T10:00:00.000Z");
  assert.equal(state.cycles[0].completedAt, "2026-11-23T09:00:00.000Z");
  assert.equal(state.cycles[0].startedAt, at);
  assert.equal(
    boardOf(state, "mac-project").tasks["task-1"].fields.archived,
    true,
  );
  // Taking the flag off again takes the date off.
  const restored = boardOf(state, "mac-project");
  const reopened = structuredClone(restored);
  reopened.tasks["task-1"].fields.archived = false;
  applyBoard(state, "mac-project", restored, reopened, { at });
  assert.equal(
    state.tasks.find((item) => item.id === "task-1")!.archivedAt,
    null,
  );
});

test("a lane a person made by hand in an older way stays on this computer and off the board", () => {
  const state = mac();
  state.workflowStates.push({
    id: "hand-made",
    projectId: "mac-project",
    name: "Odd",
    stage: "planned",
    color: "#000",
    order: 9,
  });
  state.tasks.find((item) => item.id === "task-1")!.statusId = "hand-made";
  const board = boardOf(state, "mac-project");
  assert.ok(!("hand-made" in board.lanes));
  assert.equal(board.tasks["task-1"].fields.lane, undefined);
  const after = structuredClone(board);
  after.lanes.working.fields.name = "Doing";
  applyBoard(state, "mac-project", board, after, { at });
  assert.ok(state.workflowStates.some((lane) => lane.id === "hand-made"));
  assert.equal(
    state.workflowStates.find((lane) => lane.id === "mac-project:working")!
      .name,
    "Doing",
  );
});

test("what a comment points at is taken only when it is what MemCode would have written", () => {
  const withReference = (reference: unknown) => {
    const board = boardOf(mac(), "mac-project");
    board.comments["comment-1"].fields.reference = reference as never;
    const pc = workspace("pc-project");
    applyBoard(pc, "pc-project", emptyBoard(), board, { at });
    assert.equal(pc.storyComments!.length, 1);
    assert.equal(pc.storyComments![0].text, "Looks right to me.");
    return pc.storyComments![0].reference;
  };
  const real = {
    kind: "file",
    name: "export.ts",
    quote: "const rows = [];",
    path: "src/export/export.ts",
    line: 12,
    endLine: 14,
  };
  assert.deepEqual(withReference(real), real);
  assert.deepEqual(
    withReference({ kind: "changes", name: "The diff", quote: "" }),
    {
      kind: "changes",
      name: "The diff",
      quote: "",
    },
  );
  // Anything else leaves the comment without a reference, never with a wrong one.
  for (const wrong of [
    "a string",
    42,
    [real],
    { ...real, kind: "website" },
    { ...real, name: 7 },
    { ...real, name: "" },
    { ...real, quote: "q".repeat(20001) },
    { ...real, path: "/etc/passwd" },
    { ...real, path: "../outside.ts" },
    { ...real, path: "C:\\Users\\someone\\secret.ts" },
    { ...real, line: -1 },
    { ...real, line: 1.5 },
    { ...real, selector: "s".repeat(1001) },
    { ...real, extra: "something MemCode does not write" },
    { kind: "file", quote: "no name" },
  ])
    assert.equal(withReference(wrong), undefined, JSON.stringify(wrong));
});
