import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionAsk, needsPerson, verdictSummary } from "../src/fleet.ts";

const positions = [
  { taskId: "t1", agentId: "memcode:t1" },
  { taskId: "t2", agentId: "memcode:t2" },
];
const name = (taskId?: string) => ({ t1: "MC-1", t2: "MC-2" })[taskId ?? ""] ?? "another agent";

test("a disagreement reaches the person only once the workers could not settle it", () => {
  assert.equal(needsPerson({ status: "open", positions }), false, "the workers are still judging");
  assert.equal(needsPerson({ status: "open", positions, needs: "decide" }), true);
  assert.equal(needsPerson({ status: "open", positions, needs: "confirm" }), true);
  assert.equal(needsPerson({ status: "open" }), true, "raised outside MemCode: nobody here can judge it");
  assert.equal(needsPerson({ status: "resolved", positions, needs: "decide" }), false);
});

test("the person is told what is asked of them", () => {
  assert.equal(decisionAsk({ status: "open", positions, needs: "confirm" }), "Confirm the workers' recommendation");
  assert.equal(decisionAsk({ status: "open", positions, needs: "decide" }), "The workers could not settle this");
  assert.equal(decisionAsk({ status: "open", positions }), "The workers are settling this");
  assert.equal(decisionAsk({ status: "open" }), "Needs your decision");
  assert.equal(decisionAsk({ status: "resolved", positions, resolutionKind: "agents" }), "Settled by the workers");
  assert.equal(decisionAsk({ status: "resolved", positions, resolutionKind: "human" }), "You decided");
});

test("each worker's verdict reads as a sentence", () => {
  const [position] = positions;
  assert.equal(verdictSummary({ ...position, verdict: "reconcile" }, name), "Says both changes fit together");
  assert.equal(verdictSummary({ ...position, verdict: "recommend", winnerTaskId: "t2" }, name), "Recommends MC-2 goes ahead");
  assert.equal(
    verdictSummary({ ...position, verdict: "recommend", winnerTaskId: "t1" }, name),
    "Says its own change has to stand",
    "arguing for its own task is that worker's case, not a recommendation",
  );
  assert.equal(verdictSummary({ ...position, verdict: "ask_human" }, name), "Asks you");
  assert.equal(verdictSummary(position, name), undefined, "has not judged yet");
});
