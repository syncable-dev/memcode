import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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

const sharedBefore = [
  "// Shared source",
  "",
  "export function first() {",
  "  const result = 1;",
  "  return result;",
  "}",
  "",
  "// Independent second feature",
  "",
  "export function second() {",
  "  return 10;",
  "}",
  "",
].join("\n");

test("review projects only this story after a later disjoint same-file edit and preserves its original hashes", async () => {
  const f = await fixture();
  const firstPass = sharedBefore.replace("result = 1", "result = 2"),
    ownAfter = firstPass.replace("result = 2", "result = 3"),
    current = ownAfter.replace("return 10", "return 20");
  await f.checkpoint(sharedBefore, firstPass);
  await f.checkpoint(firstPass, ownAfter);
  await writeFile(join(f.root, "source.ts"), current);
  const result = await captureStoryReview(f.task);
  assert.deepEqual(result.limitations, []);
  assert.equal(result.snapshot.files[0].beforeHash, hash(sharedBefore));
  assert.equal(result.snapshot.files[0].afterHash, hash(ownAfter));
  assert.deepEqual(result.snapshot.files[0].projection, {
    method: "unique-exact-context",
    baselineHash: hash(sharedBefore.replace("return 10", "return 20")),
    currentHash: hash(current),
    hunks: 1,
  });
  assert.equal(
    result.baseFiles["source.ts"],
    sharedBefore.replace("return 10", "return 20"),
  );
  assert.match(result.patch, /-  const result = 1;/);
  assert.match(result.patch, /\+  const result = 3;/);
  assert.doesNotMatch(result.patch, /^[+-]  return (10|20);/m);
  assert.equal(result.snapshot.additions, 1);
  assert.equal(result.snapshot.deletions, 1);
  assert.equal(
    await readFile(join(f.root, "source.ts"), "utf8"),
    current,
    "Capture never writes the execution source",
  );
});

test("ambiguous or overlapping later same-file edits stay incomplete without a projected patch", async () => {
  for (const mode of ["duplicate", "overlap"] as const) {
    const f = await fixture(),
      ownAfter = sharedBefore.replace("result = 1", "result = 2");
    await f.checkpoint(sharedBefore, ownAfter);
    await writeFile(
      join(f.root, "source.ts"),
      mode === "overlap"
        ? ownAfter.replace("result = 2", "result = 3")
        : ownAfter +
            "\nexport function first() {\n  const result = 2;\n  return result;\n}\n",
    );
    const result = await captureStoryReview(f.task);
    assert.equal(result.patch, "");
    assert.equal(result.snapshot.files[0].projection, undefined);
    assert.match(result.limitations.join(" "), /context|ambiguous|overlaps/);
  }
});

test("file addition or deletion with later source changes cannot project away file ownership", async () => {
  for (const transition of ["add", "delete"] as const) {
    const f = await fixture();
    await f.checkpoint(
      transition === "add" ? undefined : "const own = 0;\n",
      transition === "add" ? "const own = 1;\n" : undefined,
    );
    await writeFile(join(f.root, "source.ts"), "const peer = 2;\n");
    const result = await captureStoryReview(f.task);
    assert.equal(result.patch, "");
    assert.equal(result.snapshot.files[0].projection, undefined);
    assert.match(result.limitations.join(" "), /last checkpoint/);
  }
});

test("an unchanged story deletion still produces an exact deletion patch", async () => {
  const f = await fixture();
  await f.checkpoint("const own = 0;\n", undefined);
  await rm(join(f.root, "source.ts"), { force: true });
  const result = await captureStoryReview(f.task);
  assert.deepEqual(result.limitations, []);
  assert.match(result.patch, /\+\+\+ \/dev\/null/);
  assert.match(result.patch, /-const own = 0;/);
  assert.equal(result.snapshot.deletions, 1);
  assert.equal(result.snapshot.files[0].projection, undefined);
});

test("a peer deletion of this story's modified file stays incomplete", async () => {
  const f = await fixture();
  await f.checkpoint(
    sharedBefore,
    sharedBefore.replace("result = 1", "result = 2"),
  );
  await rm(join(f.root, "source.ts"));
  const result = await captureStoryReview(f.task);
  assert.equal(result.patch, "");
  assert.equal(result.snapshot.files[0].projection, undefined);
  assert.match(result.limitations.join(" "), /last checkpoint/);
});

test("a legacy baseline cannot gain verified ownership through disjoint projection", async () => {
  const f = await fixture(),
    ownAfter = sharedBefore.replace("result = 1", "result = 2");
  await f.checkpoint(sharedBefore, ownAfter, { basis: "scoped-baseline" });
  await writeFile(
    join(f.root, "source.ts"),
    ownAfter.replace("return 10", "return 20"),
  );
  const result = await captureStoryReview(f.task);
  assert.equal(result.patch, "");
  assert.equal(result.snapshot.files[0].projection, undefined);
  assert.match(result.limitations.join(" "), /older scoped baseline/);
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
