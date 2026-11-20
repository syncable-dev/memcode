import test from "node:test";
import assert from "node:assert/strict";
import { reportWorker, workerReport } from "../runtime/team/worker-activity";
import { initialState } from "../src/seed";
import type { TeamClaim } from "../src/team";

test("shared activity keeps provider model IDs without sharing opaque provider configuration", () => {
  const claim = { storyId: "story", attemptId: "attempt", epoch: 1 } as TeamClaim;
  const base = initialState().tasks[0];
  for (const [harness, requested, expected] of [
    ["dsh", '["deepseek-official","deepseek-v4-flash"]', "deepseek-v4-flash"],
    ["cursor", "grok-4.7[reasoning_effort=high,fast=true]", "grok-4.7"],
    ["copilot", "claude-haiku-5.5", "claude-haiku-5.5"],
  ] as const) {
    const task = { ...base, harness, route: { ...base.route!, model: requested }, run: {
      state: "running" as const, startedAt: "2026-11-20T00:00:00Z",
    } };
    const report = reportWorker(task, claim, "workspace")!;
    assert.equal(report.requestedModel, expected);
    assert.equal(workerReport.parse(report).harness, harness);
  }
});
