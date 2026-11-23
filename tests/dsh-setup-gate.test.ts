import test from "node:test";
import assert from "node:assert/strict";
import { DshSetupGate } from "../runtime/dsh-setup-gate";

test("DshSetupGate keeps setup, reviewers and other setup operations apart", async () => {
  const gate = new DshSetupGate();

  // A running reviewer keeps profile-changing setup out until it exits.
  const release = gate.admit("review");
  await assert.rejects(gate.run("apply-migrate", async () => "x"), /review or plan in progress/);
  // A dry-run only touches staging and may run beside a reviewer.
  assert.equal(await gate.run("dry-run", async () => "staged", { mutates: false }), "staged");
  release();
  release(); // idempotent

  let finish!: () => void;
  const running = gate.run("apply-migrate", () => new Promise<string>((resolve) => (finish = () => resolve("applied"))));
  assert.equal(gate.operation, "apply-migrate");
  assert.equal(gate.mutating, true);
  assert.throws(() => gate.admit("review"), /Wait for DeepSeek Harness setup to finish/);
  await assert.rejects(gate.run("select-profile", async () => 1), /already in progress/);
  finish();
  assert.equal(await running, "applied");
  assert.equal(gate.operation, null);

  // A failing operation still releases the gate.
  await assert.rejects(gate.run("install-cli", async () => { throw new Error("boom"); }), /boom/);
  gate.admit("plan")();
});

test("DshSetupGate.close waits for a running operation and refuses new ones", async () => {
  const gate = new DshSetupGate();
  let finish!: () => void;
  let settled = false;
  const running = gate.run("apply-migrate", () => new Promise<void>((resolve) => (finish = resolve))).then(() => {
    settled = true;
  });
  const closing = gate.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  finish();
  await closing;
  assert.equal(settled, true);
  await running;
  await assert.rejects(gate.run("select-profile", async () => 1), /shutting down/);
});
