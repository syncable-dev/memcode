import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime/app";
import { git } from "../runtime/local";
import { initializeCodeReviewWorkflow } from "../src/code-review-workflow";
import type { WorkItem } from "../src/shared";
import type { StoryReviewRun } from "../src/code-review";

test("the actual runtime routes a card into its dedicated review and final acceptance without marking Done", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memcode-review-routes-")),
    profile = join(directory, "profile"),
    root = join(directory, "source");
  await mkdir(root);
  await git(root, ["init", "--initial-branch=main"]);
  await writeFile(join(root, "README.md"), "Research evidence\n");
  await git(root, ["add", "README.md"]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  const runtime = await createRuntime(
    profile,
    directory,
    {
      call: async () => {
        throw Error("No native or model actions expected.");
      },
    },
    () => {},
    { discoverHarnesses: async () => [] },
  );
  try {
    const project = {
      id: "local",
      path: root,
      name: "Local",
      description: "",
      branch: "main",
      analysis: "idle" as const,
      createdAt: new Date().toISOString(),
    };
    runtime.store.state.projects.push(project);
    initializeCodeReviewWorkflow(runtime.store.state, project.id);
    const binding = runtime.store.state.reviewWorkflows![project.id];
    const story: WorkItem = {
      id: "research",
      identifier: "MC-T",
      projectId: project.id,
      title: "Research",
      description: "",
      kind: "research",
      stage: "planned",
      priority: "medium",
      category: "Work",
      harness: "codex",
      messages: [],
      checklist: [],
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
      run: { state: "finished", workspace: root, branch: "main" },
    };
    runtime.store.state.tasks.push(story);
    for (const status of runtime.store.state.workflowStates.filter(
      (item) =>
        item.projectId === project.id && item.id !== binding.codeReviewStatusId,
    )) {
      story.stage = status.stage;
      story.statusId = status.id;
      for (const [method, input] of [
        ["code-review:start", { taskId: story.id }],
        [
          "code-review:discuss",
          { taskId: story.id, runId: "unstarted", text: "Explain this" },
        ],
        [
          "code-review:request-fixes",
          { taskId: story.id, runId: "unstarted", findingIds: [] },
        ],
        ["code-review:accept", { taskId: story.id, runId: "unstarted" }],
      ] as const)
        await assert.rejects(
          runtime.request(method, input),
          /Code review lane/,
        );
      assert.equal(story.codeReview, undefined);
    }
    await runtime.request("task:update", {
      id: story.id,
      patch: { statusId: binding.codeReviewStatusId },
    });
    assert.equal(story.stage, "review");
    assert.ok(story.codeReview);
    let review: StoryReviewRun | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      review = (await runtime.request("code-review:get", {
        taskId: story.id,
      })) as StoryReviewRun;
      if (review?.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(review?.state, "completed", review?.note);
    assert.equal(review?.outcome, "not-applicable");
    assert.equal(review?.findings.length, 0);
    assert.equal(review?.metrics.length, 0);
    await runtime.request("code-review:accept", {
      taskId: story.id,
      runId: review!.id,
    });
    assert.equal(story.statusId, binding.acceptanceStatusId);
    assert.equal(story.stage, "review");
    assert.equal(story.harness, "codex");
    await assert.rejects(
      runtime.request("code-review:accept", {
        taskId: story.id,
        runId: "old-run",
      }),
      /Code review lane/,
    );
    assert.equal(
      (
        (await runtime.request("code-review:get", {
          taskId: story.id,
        })) as StoryReviewRun
      ).id,
      review!.id,
      "Leaving the lane preserves the saved report",
    );
    await assert.rejects(
      runtime.request("code-review:start", { taskId: story.id, extra: "bad" }),
      /Unrecognized/,
    );
  } finally {
    await runtime.close();
  }
});
