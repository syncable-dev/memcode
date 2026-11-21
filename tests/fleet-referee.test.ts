import { test } from "node:test";
import assert from "node:assert/strict";
import { ruling } from "../runtime/fleet-referee.ts";
import type { ChangeKind, FleetPosition, VerdictKind } from "../src/fleet.ts";

const party = (
  id: string,
  kind: ChangeKind | undefined,
  verdict?: VerdictKind,
  winnerTaskId?: string,
): FleetPosition => ({ taskId: id, agentId: "memcode:" + id, kind, verdict, winnerTaskId });
const everyoneJudged: string[] = [];
/** A ruling read as one that asks the person, for the tests that expect exactly that. */
const asksPerson = (positions: FleetPosition[], awaiting: string[]) =>
  ruling(positions, awaiting) as { person?: "confirm" | "decide"; reason?: string };

test("a signature change over an ordinary edit is safe to order: the signature change stands", () => {
  assert.deepEqual(
    ruling([party("a", "signature", "reconcile"), party("b", "fix")], ["b"]),
    { settle: true, winnerTaskId: "a" },
  );
});

test("nothing is settled before a worker has judged", () => {
  assert.deepEqual(ruling([party("a", "signature"), party("b", "fix")], ["a", "b"]), { wait: true });
});

test("outside the safe case one verdict is not enough; two that agree settle it", () => {
  const first = [party("a", "signature", "reconcile"), party("b", "rename")];
  assert.deepEqual(ruling(first, ["b"]), { wait: true });
  assert.deepEqual(
    ruling([party("a", "signature", "reconcile"), party("b", "rename", "reconcile")], everyoneJudged),
    { settle: true, winnerTaskId: undefined },
  );
  assert.deepEqual(
    ruling([party("a", "signature", "recommend", "b"), party("b", "rename", "recommend", "b")], everyoneJudged),
    { settle: true, winnerTaskId: "b" },
  );
});

test("a lone verdict with nobody left to judge goes to the person as a recommendation", () => {
  assert.deepEqual(
    ruling([party("a", "signature", "recommend", "a"), party("b", "rename")], everyoneJudged),
    { person: "confirm", recommendedTaskId: "a" },
  );
});

test("workers who disagree, or one who asks, need the person to decide", () => {
  const differentWinners = asksPerson(
    [party("a", "signature", "recommend", "a"), party("b", "rename", "recommend", "b")],
    everyoneJudged,
  );
  assert.equal(differentWinners.person, "decide");
  assert.match(differentWinners.reason!, /disagree/);
  assert.equal(
    asksPerson([party("a", "signature", "reconcile"), party("b", "rename", "recommend", "b")], everyoneJudged).person,
    "decide",
    "one says they fit, the other picks a winner",
  );
  const asked = asksPerson([party("a", "signature", "ask_human"), party("b", "fix")], ["b"]);
  assert.equal(asked.person, "decide");
  assert.match(asked.reason!, /asked/);
});

test("moving or removing code under someone's edit is never settled without the person", () => {
  for (const kind of ["remove", "move"] as const) {
    const agreed = ruling(
      [party("a", kind, "recommend", "b"), party("b", "fix", "recommend", "b")],
      everyoneJudged,
    );
    assert.deepEqual(agreed, { person: "confirm", recommendedTaskId: "b", reason: "Code is being moved or removed." }, kind);
    assert.deepEqual(ruling([party("a", kind, "reconcile"), party("b", "fix")], ["b"]), { wait: true });
  }
});

test("two breaking changes to the same code are always the person's call", () => {
  const both = asksPerson([party("a", "signature", "reconcile"), party("b", "remove", "reconcile")], everyoneJudged);
  assert.equal(both.person, "decide");
  assert.match(both.reason!, /[Bb]oth/);
});

test("an agent outside MemCode, whose kind of change is unknown, is never treated as the safe case", () => {
  assert.deepEqual(
    ruling([party("a", "signature", "reconcile"), { agentId: "cursor-7" }], everyoneJudged),
    { person: "confirm", recommendedTaskId: undefined },
  );
});
