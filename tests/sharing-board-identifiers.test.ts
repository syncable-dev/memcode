import test from "node:test";
import assert from "node:assert/strict";
import {
  newIdentifiers,
  NOT_IN_THE_LOG,
} from "../runtime/sharing/board/identifiers";

const task = (id: string, identifier: string, arrived = NOT_IN_THE_LOG) => ({
  id,
  identifier,
  arrived,
});
const renumbered = (...tasks: ReturnType<typeof task>[]) =>
  Object.fromEntries(newIdentifiers(tasks));

test("tasks that each have an identifier of their own keep it", () => {
  assert.deepEqual(
    renumbered(
      task("a", "MC-001", 1),
      task("b", "MC-002", 2),
      task("c", "MC-010"),
    ),
    {},
  );
  assert.deepEqual(renumbered(), {});
});

test("the task that reached the log later takes the number after the highest in use", () => {
  assert.deepEqual(
    renumbered(
      task("a", "MC-014", 40),
      task("b", "MC-014", 55),
      task("c", "MC-020", 12),
    ),
    { b: "MC-021" },
  );
  // Whichever order they are looked at in.
  assert.deepEqual(
    renumbered(
      task("c", "MC-020", 12),
      task("b", "MC-014", 55),
      task("a", "MC-014", 40),
    ),
    { b: "MC-021" },
  );
});

test("a task that is not in the log yet gives way to one that is", () => {
  assert.deepEqual(
    renumbered(task("mine", "MC-003"), task("theirs", "MC-003", 9)),
    { mine: "MC-004" },
  );
});

test("two tasks that arrived together are told apart by id, the same way on every computer", () => {
  assert.deepEqual(renumbered(task("b", "MC-001", 7), task("a", "MC-001", 7)), {
    b: "MC-002",
  });
  assert.deepEqual(renumbered(task("b", "MC-001"), task("a", "MC-001")), {
    b: "MC-002",
  });
});

test("every task that has to change gets a number of its own, in the order they arrived", () => {
  // A guest's board of three joins a shared board of three.
  assert.deepEqual(
    renumbered(
      task("alex-1", "MC-001", 1),
      task("alex-2", "MC-002", 2),
      task("alex-3", "MC-003", 3),
      task("dana-3", "MC-003", 12),
      task("dana-1", "MC-001", 10),
      task("dana-2", "MC-002", 11),
    ),
    { "dana-1": "MC-004", "dana-2": "MC-005", "dana-3": "MC-006" },
  );
  assert.deepEqual(
    renumbered(
      task("a", "MC-001", 1),
      task("b", "MC-001", 2),
      task("c", "MC-001", 3),
    ),
    { b: "MC-002", c: "MC-003" },
  );
});

test("a number keeps the width and the letters it was written with", () => {
  assert.deepEqual(renumbered(task("a", "MC-999", 1), task("b", "MC-999", 2)), {
    b: "MC-1000",
  });
  assert.deepEqual(
    renumbered(
      task("a", "WEB-7", 1),
      task("b", "WEB-7", 2),
      task("c", "MC-050", 3),
    ),
    { b: "WEB-8" },
  );
});

test("an identifier that does not end in a number is left as it is", () => {
  assert.deepEqual(
    renumbered(task("a", "launch", 1), task("b", "launch", 2)),
    {},
  );
});
