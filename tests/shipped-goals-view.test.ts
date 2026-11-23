import test from "node:test";
import assert from "node:assert/strict";
import { keptCheckoutNotes } from "../src/shipped-goals";

test("a shipped goal whose checkout stayed says why", () => {
  const notes = keptCheckoutNotes([
    { title: "Customers can export reports", closedAt: "2026-11-23", checkoutKept: "A worker is still running in this goal's checkout." },
    { title: "Sign-in feels instant", closedAt: "2026-11-22" },
    { title: "Still in progress", checkoutKept: "never shipped" },
  ]);

  assert.deepEqual(notes, [
    "“Customers can export reports” keeps its checkout. A worker is still running in this goal's checkout.",
  ]);
});
