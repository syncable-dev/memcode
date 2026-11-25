import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import { filterWork } from "../src/planning/workflow";
import { groupWork } from "../src/planning/groups";
import { defaultView } from "../src/planning/types";
import type { AppState, WorkItem } from "../src/shared";
import { applyTaskPatch } from "../runtime/task-planning";
import { applyBoard, boardOf } from "../runtime/sharing/board/board";
import { emptyBoard } from "../runtime/sharing/board/document";
import { assertEpicDependencies } from "../runtime/epic-dependencies";

const at = "2026-11-25T12:00:00.000Z";
function workspace(): AppState {
  const state = initialState();
  state.projects = [
    {
      id: "p",
      name: "Web",
      description: "",
      path: process.cwd(),
      branch: "main",
      analysis: "idle",
      createdAt: at,
    },
  ];
  state.tasks = [];
  state.epics = [];
  state.storyComments = [];
  return state;
}
const task = (changes: Partial<WorkItem> = {}): WorkItem =>
  ({
    id: "t1",
    identifier: "MC-001",
    projectId: "p",
    title: "Export as CSV",
    description: "Line one.",
    stage: "planned",
    priority: "medium",
    category: "Work",
    kind: "feature",
    harness: "claude",
    checklist: [],
    messages: [{ id: "m1", role: "user", text: "Line one.", at }],
    run: { state: "idle" },
    createdAt: at,
    updatedAt: at,
    ...changes,
  }) as WorkItem;

const tracked = {
  provider: "linear" as const,
  id: "0b6c1c1e-0000-4000-8000-000000000001",
  key: "MEMDEV-12",
  url: "https://linear.app/memtrace/issue/MEMDEV-12/export-as-csv",
  kind: "issue" as const,
};

test("what older MemCodes do not know travels beside what they do", () => {
  const here = workspace();
  here.tasks = [
    task({
      priority: "urgent",
      assignee: { id: "u1", name: "Dana Ito", email: "dana@example.invalid" },
      tracker: { ...tracked, standing: "attention", note: "Only known here.", kept: [] },
      title: "A".repeat(250),
      labels: ["L".repeat(90)],
    }),
    task({
      id: "t2",
      identifier: "MC-002",
      priority: "none",
      archivedAt: at,
      closedAs: "canceled",
    }),
  ];
  const board = boardOf(here, "p");
  assert.equal(board.tasks.t1.fields.priority, "high", "the nearest an older MemCode knows");
  assert.equal(board.tasks.t2.fields.priority, "low");
  assert.equal((board.tasks.t1.fields.title as string).length, 240);
  assert.deepEqual(
    board.tasks.t1.fields.assignee,
    { id: "u1", name: "Dana Ito" },
    "no address of hers",
  );
  assert.deepEqual(board.tasks.t1.fields.tracker, tracked, "how it stands stays here");

  const there = workspace();
  applyBoard(there, "p", emptyBoard(), board, { at });
  const [one, two] = there.tasks;
  assert.equal(one.priority, "urgent");
  assert.deepEqual(one.assignee, { id: "u1", name: "Dana Ito" });
  assert.deepEqual(one.tracker, tracked);
  assert.deepEqual([two.priority, two.closedAs], ["none", "canceled"]);

  // It comes back with one field changed: the rest, the long title included, is as it was.
  const edited = structuredClone(board);
  edited.tasks.t1.fields.estimate = 3;
  applyBoard(here, "p", board, edited, { at });
  assert.equal(here.tasks[0].title.length, 250);
  assert.equal(here.tasks[0].tracker?.standing, "attention");
  assert.equal(here.tasks[0].estimate, 3);
});

test("a priority changed by an older MemCode wins over what stands beside it", () => {
  const state = workspace();
  state.tasks = [task({ priority: "urgent" })];
  const before = boardOf(state, "p");
  const after = structuredClone(before);
  after.tasks.t1.fields.priority = "low";
  applyBoard(state, "p", before, after, { at });
  assert.equal(state.tasks[0].priority, "low");
});

test("a link on a board opens the tracker and nothing else", () => {
  const state = workspace();
  const board = emptyBoard();
  board.tasks.t1 = structuredClone(
    boardOf(Object.assign(workspace(), { tasks: [task({ tracker: tracked })] }), "p").tasks.t1,
  );
  for (const url of [
    "javascript:alert(1)",
    "https://linear.app.evil.example/x",
    "http://linear.app/x",
  ]) {
    (board.tasks.t1.fields.tracker as Record<string, string>).url = url;
    state.tasks = [];
    applyBoard(state, "p", emptyBoard(), board, { at });
    assert.equal(state.tasks[0].tracker?.url, undefined, url);
  }
});

test("a comment from the tracker keeps its author on every computer", () => {
  const here = workspace();
  here.tasks = [task()];
  here.storyComments = [
    {
      id: "c1",
      taskId: "t1",
      text: "Does this cover Excel?",
      author: { id: "linear-user", name: "Sam Rao", source: "linear" },
      createdAt: at,
      updatedAt: at,
    },
  ];
  const there = workspace();
  applyBoard(there, "p", emptyBoard(), boardOf(here, "p"), {
    at,
    stampOf: () => ({ createdBy: "account-1" }),
    nameOf: () => "Alex",
  });
  assert.equal(there.storyComments![0].author.name, "Sam Rao");
  assert.equal(there.storyComments![0].author.source, "linear");
});

test("a task nobody has started asks its worker for what it says now", () => {
  const state = workspace();
  const item = task();
  state.tasks = [item];
  applyTaskPatch(state, item, { description: "Line one, with headers." });
  assert.equal(item.messages[0].text, "Line one, with headers.");
  applyTaskPatch(state, item, { description: "" });
  assert.equal(
    item.messages[0].text,
    "Export as CSV",
    "without a description, the title is the request",
  );
  item.run.startedAt = at;
  applyTaskPatch(state, item, { description: "Too late." });
  assert.equal(item.messages[0].text, "Export as CSV", "a worker has it already");
  const written = task({
    id: "t3",
    messages: [{ id: "m", role: "user", text: "Said in other words.", at }],
  });
  state.tasks.push(written);
  applyTaskPatch(state, written, { description: "New." });
  assert.equal(
    written.messages[0].text,
    "Said in other words.",
    "a request of its own is left alone",
  );
});

test("work is sorted, grouped and filtered by the new priorities and people", () => {
  const items = [
    task({ id: "a", priority: "none" }),
    task({ id: "b", priority: "urgent", assignee: { id: "u1", name: "Dana" } }),
    task({ id: "c", priority: "high", assignee: { id: "u2", name: "Sam" } }),
  ];
  const ids = (filters = {}) =>
    filterWork([...items], {
      ...defaultView,
      filters: { ...defaultView.filters, ...filters },
    }).map((item) => item.id);
  assert.deepEqual(ids(), ["b", "c", "a"]);
  assert.deepEqual(ids({ assignee: "u1" }), ["b"]);
  assert.deepEqual(ids({ assignee: "none" }), ["a"]);
  assert.deepEqual(ids({ assignee: "all" }), ["b", "c", "a"]);
  const names = (list: WorkItem[]) =>
    groupWork("priority", { tasks: list, cycles: [], epics: [], workflow: [] } as never).map(
      (group) => group.name,
    );
  assert.deepEqual(names(items), [
    "Urgent",
    "High priority",
    "Medium priority",
    "Low priority",
    "No priority",
  ]);
  assert.deepEqual(
    names([items[2]]),
    ["High priority", "Medium priority", "Low priority"],
    "as before where they are not used",
  );
});

test("a prerequisite someone finished outside MemCode does not hold a worker up", async () => {
  const state = workspace();
  const done = task({ id: "d", epicId: "other", stage: "done", tracker: tracked });
  const next = task({ id: "n", epicId: "mine", dependsOn: ["d"] });
  state.tasks = [done, next];
  await assertEpicDependencies(state, next, process.cwd());
  delete done.tracker;
  await assert.rejects(
    assertEpicDependencies(state, next, process.cwd()),
    /source handoff has not been verified/,
  );
});

test("restoring a canceled task clears why it was closed", () => {
  const state = workspace();
  const item = task({ archivedAt: at, closedAs: "canceled" });
  state.tasks = [item];
  applyTaskPatch(state, item, { archivedAt: null });
  assert.equal(item.closedAs, null);
});
