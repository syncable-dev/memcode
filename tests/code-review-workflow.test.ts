import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed.ts";
import type { AppState, WorkItem } from "../src/shared.ts";
import {
  initializeCodeReviewWorkflow,
  isCodeReviewTask,
  reviewWorkflowStates,
} from "../src/code-review-workflow.ts";
import { taskStatus, workflowFor } from "../src/planning/workflow.ts";
import { applyTaskPatch } from "../runtime/task-planning.ts";

function fixture() {
  const state = initialState();
  state.projects = [
    {
      id: "p",
      name: "Project",
      description: "",
      path: null,
      branch: "main",
      analysis: "idle",
      createdAt: "2026-11-17T12:00:00Z",
    },
  ];
  const task: WorkItem = {
    id: "t",
    identifier: "MC-1",
    projectId: "p",
    title: "A real handoff",
    description: "",
    stage: "review",
    priority: "medium",
    category: "Work",
    harness: "codex",
    checklist: [],
    messages: [],
    createdAt: "2026-11-17T12:00:00Z",
    updatedAt: "2026-11-17T12:00:00Z",
    run: { state: "finished" },
  };
  state.tasks = [task];
  state.workflowStates = reviewWorkflowStates("p").filter(
    (item) => item.id !== "p:code-review",
  );
  state.workflowStates.find((item) => item.id === "p:review")!.name =
    "In review";
  return { state, task };
}

test("existing handoffs remain awaiting acceptance, without claiming a code review happened", () => {
  const { state, task } = fixture();
  initializeCodeReviewWorkflow(state);
  const binding = state.reviewWorkflows!.p;
  assert.equal(task.statusId, binding.acceptanceStatusId);
  assert.equal(isCodeReviewTask(state, task), false);
  assert.equal(
    taskStatus(task, workflowFor(state, "p")).name,
    "Ready for acceptance",
  );
  assert.equal(task.codeReview, undefined);
  assert.equal(task.run.state, "finished");
  const saved = JSON.stringify(state);
  initializeCodeReviewWorkflow(state);
  assert.equal(JSON.stringify(state), saved);
});

test("Team bootstrap can prepare workflow roles without editing legacy story metadata", () => {
  const { state, task } = fixture();
  const original = structuredClone(task);
  initializeCodeReviewWorkflow(state, "p", { assignLegacyTasks: false });
  assert.deepEqual(task, original);
  assert.equal(state.workflowStates.length, 5);
  assert.ok(state.reviewWorkflows!.p);
});

test("review lane roles survive user labels and same-stage card moves", () => {
  const { state, task } = fixture();
  state.workflowStates.find((item) => item.id === "p:review")!.name =
    "Product sign-off";
  initializeCodeReviewWorkflow(state);
  const binding = state.reviewWorkflows!.p;
  applyTaskPatch(state, task, { statusId: binding.codeReviewStatusId });
  assert.equal(task.stage, "review");
  assert.equal(isCodeReviewTask(state, task), true);
  state.workflowStates.find(
    (item) => item.id === binding.codeReviewStatusId,
  )!.name = "Engineering check";
  initializeCodeReviewWorkflow(state);
  assert.equal(isCodeReviewTask(state, task), true);
  applyTaskPatch(state, task, { statusId: binding.acceptanceStatusId });
  assert.equal(isCodeReviewTask(state, task), false);
  assert.equal(
    taskStatus(task, workflowFor(state, "p")).name,
    "Product sign-off",
  );
});

test("an imported workflow waits for explicit roles instead of guessing from labels or hashed IDs", () => {
  const { state, task } = fixture();
  state.workflowStates = [
    {
      id: "team_hash1",
      projectId: "p",
      name: "Code review",
      stage: "review",
      color: "#699a91",
      order: 2,
    },
    {
      id: "team_hash2",
      projectId: "p",
      name: "Ready for acceptance",
      stage: "review",
      color: "#c19c51",
      order: 3,
    },
  ];
  task.statusId = "team_hash1";
  const states = JSON.stringify(state.workflowStates);
  initializeCodeReviewWorkflow(state);
  assert.equal(JSON.stringify(state.workflowStates), states);
  assert.equal(state.reviewWorkflows!.p, undefined);
  assert.equal(isCodeReviewTask(state, task), false);
});

test("a fresh workflow has five visible lanes but retains the four portable execution categories", () => {
  const state = {
    projects: [{ id: "p" }],
    tasks: [],
    workflowStates: [],
  } as unknown as AppState;
  initializeCodeReviewWorkflow(state);
  assert.deepEqual(
    workflowFor(state, "p").map((item) => item.name),
    ["Planned", "In progress", "Code review", "Ready for acceptance", "Done"],
  );
  assert.deepEqual(
    [...new Set(state.workflowStates.map((item) => item.stage))],
    ["planned", "working", "review", "done"],
  );
});
