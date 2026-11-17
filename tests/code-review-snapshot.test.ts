import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { captureStoryReview } from "../runtime/code-review-snapshot";
import { git } from "../runtime/local";
import type { WorkItem } from "../src/shared";
import type { ChangeCheckpoint } from "../src/changes";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memcode-review-capture-"));
  await git(root, ["init", "--initial-branch=epic/review"]);
  await writeFile(join(root, ".gitignore"), ".memcode/\n");
  await git(root, ["add", ".gitignore"]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  const task: WorkItem = {
    id: "story",
    identifier: "MC-T",
    projectId: "project",
    title: "Scoped change",
    description: "",
    stage: "review",
    priority: "medium",
    category: "Work",
    harness: "codex",
    checklist: [],
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    run: { state: "finished", workspace: root, branch: "epic/review" },
  };
  const directory = join(root, ".memcode", "workers", task.id, "changes");
  await mkdir(join(directory, "blobs"), { recursive: true });
  const checkpoints: ChangeCheckpoint[] = [];
  async function checkpoint(
    before: string | undefined,
    after: string | undefined,
    options: { basis?: ChangeCheckpoint["basis"]; branch?: string } = {},
  ) {
    for (const text of [before, after])
      if (text !== undefined)
        await writeFile(join(directory, "blobs", hash(text)), text);
    checkpoints.push({
      id: String(checkpoints.length),
      runId: "run-" + checkpoints.length,
      taskId: task.id,
      agentId: "memcode:story",
      harness: "codex",
      branch: options.branch ?? task.run.branch!,
      startedAt: task.createdAt,
      at: task.updatedAt,
      basis: options.basis ?? "fleet-reservation",
      files: [
        {
          path: "source.ts",
          status:
            before === undefined
              ? "added"
              : after === undefined
                ? "deleted"
                : "modified",
          additions: 1,
          deletions: before === undefined ? 0 : 1,
          binary: false,
          hunks: [],
          beforeHash: before === undefined ? undefined : hash(before),
          afterHash: after === undefined ? undefined : hash(after),
        },
      ],
    });
    await writeFile(
      join(directory, "checkpoints.jsonl"),
      checkpoints.map((c) => JSON.stringify(c)).join("\n") + "\n",
    );
    if (after !== undefined) await writeFile(join(root, "source.ts"), after);
  }
  return { root, task, directory, checkpoint };
}

test("review composes the story's net add over multiple runs and preserves its absent original file", async () => {
  const f = await fixture();
  await f.checkpoint(undefined, "export const value = 1;\n");
  await f.checkpoint("export const value = 1;\n", "export const value = 2;\n");
  const result = await captureStoryReview(f.task);
  assert.equal(result.limitations.length, 0);
  assert.equal(result.snapshot.files[0].beforeHash, undefined);
  assert.equal(result.snapshot.additions, 1);
  assert.equal(result.snapshot.deletions, 0);
  assert.match(result.patch, /--- \/dev\/null/);
  assert.match(result.patch, /\+export const value = 2;/);
  assert.equal(result.baseFiles["source.ts"], "");
  assert.equal(result.implementationRunIds.length, 2);
});

test("intervening peer edits cannot be claimed as one worker's patch", async () => {
  const f = await fixture();
  await f.checkpoint("export const value = 0;\n", "export const value = 1;\n");
  await f.checkpoint("export const value = 5;\n", "export const value = 6;\n");
  const result = await captureStoryReview(f.task);
  assert.equal(result.snapshot.files[0].attribution, "discontinuous");
  assert.equal(result.patch, "");
  assert.match(result.limitations.join(" "), /intervening edit/);
});

test("later uncheckpointed source invalidates review coverage without reviewing another agent's work", async () => {
  const f = await fixture();
  await f.checkpoint("const n=0;\n", "const n=1;\n");
  await writeFile(join(f.root, "source.ts"), "const n=2;\n");
  const result = await captureStoryReview(f.task);
  assert.equal(result.patch, "");
  assert.match(result.limitations.join(" "), /last checkpoint/);
});

test("tampered saved blobs are rejected rather than becoming trusted review input", async () => {
  const f = await fixture();
  const before = "const n=0;\n";
  await f.checkpoint(before, "const n=1;\n");
  await writeFile(join(f.directory, "blobs", hash(before)), "injected");
  await assert.rejects(captureStoryReview(f.task), /content check/);
});

test("switching the branch rejects a review before source or graph queries", async () => {
  const f = await fixture();
  await f.checkpoint(undefined, "const n=1;\n");
  await git(f.root, ["switch", "-c", "epic/other"]);
  await assert.rejects(captureStoryReview(f.task), /changed branch/);
});

test("legacy baselines remain readable but cannot certify ownership", async () => {
  const f = await fixture();
  await f.checkpoint("const n=0;\n", "const n=1;\n", {
    basis: "scoped-baseline",
  });
  const result = await captureStoryReview(f.task);
  assert.match(result.patch, /const n=1/);
  assert.match(result.limitations.join(" "), /older scoped baseline/);
});
