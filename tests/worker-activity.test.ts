import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { trackTurnActivity } from "../runtime/agents/activity";
import type { AgentEvent } from "../runtime/agents/types";
import { WorkerActivityView } from "../src/components/WorkerInputPanel";
import type { WorkItem } from "../src/shared";
import type { WorkerActivity } from "../src/worker-input";

test("overlapping native calls keep their original start times and measured outcomes", () => {
  const update = trackTurnActivity();
  let activity: WorkerActivity | undefined;
  const record = (seconds: number, event: AgentEvent) =>
    (activity = update(event, activity, new Date(seconds * 1000).toISOString()));
  const call = (toolId: string, label: string, toolResult?: "failed" | "completed"): AgentEvent =>
    ({ type: "activity", phase: "tool", toolId, label, toolResult });
  record(1, call("a", "Reading symbols"));
  record(2, call("b", "Inspecting tests"));
  record(3, call("a", "Reading symbols"));
  record(4, { type: "message", role: "assistant", delta: true, text: "I am checking." });
  assert.equal(activity?.toolId, "a");
  assert.equal(activity?.at, new Date(1000).toISOString());
  record(6, call("b", "Inspecting tests", "failed"));
  assert.deepEqual(activity?.lastTool, { label: "Inspecting tests", durationMs: 4000, failed: true });
  assert.equal(activity?.toolId, "a");
  record(11, call("a", "Reading symbols", "completed"));
  assert.deepEqual(activity?.lastTool, { label: "Reading symbols", durationMs: 10000, failed: false });
  assert.equal(activity?.phase, "working");
  record(12, { type: "message", role: "assistant", text: "Reply", delta: true });
  const previous = activity;
  record(13, call("unknown", "unseen", "completed"));
  assert.deepEqual(activity, previous);
  record(14, { type: "message", role: "assistant", text: "More", delta: true });
  assert.equal(activity?.at, previous?.at);
});

test("the card renders an active operation and the measured previous result together", () => {
  const task = { run: { state: "running", activity: {
    phase: "tool", label: "Reading symbols", at: new Date().toISOString(),
    lastTool: { label: "Inspecting tests", durationMs: 4000, failed: true },
  } } } as WorkItem;
  const markup = renderToStaticMarkup(createElement(WorkerActivityView, { task }));
  assert.match(markup, /role="status">Reading symbols/);
  assert.match(markup, /title="Inspecting tests">Last tool failed in 4s/);
});
