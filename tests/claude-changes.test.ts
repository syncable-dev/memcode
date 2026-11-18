import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { ClaudeEditJournal } from "../runtime/claude-changes";
import {
  readWorkerChanges,
  readDisplayedWorkerChanges,
} from "../runtime/changes";
import { captureStoryReview } from "../runtime/code-review-snapshot";
import { git } from "../runtime/local";
import type { WorkItem } from "../src/shared";

async function setup(t: TestContext) {
  const tmp = await mkdtemp(join(tmpdir(), "memcode-claude-test-"));
  t.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(tmp, "canonical"),
    workspace = join(tmp, "epic"),
    branch = "epic/fixture";
  await mkdir(root);
  await git(root, ["init", "--initial-branch=main"]);
  await writeFile(join(root, ".gitignore"), ".memcode/\n");
  await writeFile(join(root, "hello.ts"), "export const hello = 1;\n");
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "baseline",
  ]);
  await git(root, ["worktree", "add", "-b", branch, workspace]);
  const baseline = await git(root, ["rev-parse", "HEAD"]);
  const config = join(tmp, "claude");
  const sessionId = randomUUID(),
    changeRunId = randomUUID();
  const task = {
    id: randomUUID(),
    harness: "claude",
    identifier: "MC-T",
    run: {
      state: "running",
      branch,
      workspace,
      baseline,
      sessionId,
      changeRunId,
    },
  } as WorkItem;
  const transcript = join(
    config,
    "projects",
    workspace.replace(/[^a-z0-9]/gi, "-"),
  );
  await mkdir(transcript, { recursive: true });
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => {
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = old;
  });
  const events: Record<string, unknown>[] = [];
  function pair(path: string, before: string | null, after: string) {
    const file = join(workspace, path),
      id = randomUUID();
    const common = {
      sessionId,
      cwd: workspace,
      gitBranch: branch,
      timestamp: new Date().toISOString(),
    };
    const frames = [
      {
        ...common,
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id,
              name: before === null ? "Write" : "Edit",
              input: { file_path: file },
            },
          ],
        },
      },
      {
        ...common,
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: id, content: "Saved." },
          ],
        },
        toolUseResult: {
          filePath: file,
          ...(before === null
            ? {
                type: "create",
                originalFile: null,
                content: after,
                structuredPatch: [],
              }
            : {
                originalFile: before,
                structuredPatch: [
                  {
                    oldStart: 1,
                    newStart: 1,
                    oldLines: 1,
                    newLines: 1,
                    lines: ["-" + before.trimEnd(), "+" + after.trimEnd()],
                  },
                ],
              }),
        },
      },
    ] as const;
    events.push(...frames);
    return frames;
  }
  const store = () =>
    writeFile(
      join(transcript, sessionId + ".jsonl"),
      events.map((x) => JSON.stringify(x)).join("\n") + "\n",
    );
  return { root, workspace, task, pair, store, events };
}
test("real worktree paths, Edit and Write receipts survive restart without including staged or sibling changes", async (t) => {
  const f = await setup(t);
  const files = [
    ["hello.ts", "export const hello = 1;\n", "export const hello = 2;\n"],
    ["notes.md", null, "# Notes\n"],
  ] as const;
  let updates = 0;
  const journal = new ClaudeEditJournal(f.task, () => updates++);
  for (const [path, before, after] of files) {
    const [call, result] = f.pair(path, before, after);
    journal.observe({ ...call, session_id: f.task.run.sessionId });
    await writeFile(join(f.workspace, path), after);
    journal.observe({ ...result, tool_use_result: result.toolUseResult });
    await journal.flush();
  }
  await writeFile(join(f.workspace, "peer.txt"), "Another story\n");
  await f.store();
  f.task.run.state = "finished";
  f.task.run.nativeEditCapture = true;
  assert.equal(updates, 2);
  for (const task of [f.task, structuredClone(f.task)]) {
    const result = await readDisplayedWorkerChanges(task);
    assert.equal(result.additions, 2);
    assert.equal(result.deletions, 1);
    assert.deepEqual(
      result.checkpoints.map((c) => c.basis),
      ["native-edit", "native-edit"],
    );
    assert.deepEqual(
      result.checkpoints.map((c) => c.files[0].path),
      ["hello.ts", "notes.md"],
    );
    const review = await captureStoryReview(task);
    assert.deepEqual(review.limitations, []);
    assert.equal(review.snapshot.files[0].attribution, "native-edit");
    assert.doesNotMatch(review.patch, /peer\.txt/);
  }
  assert.equal(await readFile(join(f.root, "hello.ts"), "utf8"), files[0][1]);
});
test("a legacy session recovers only matching successful edits, reports missing proof, and does not regenerate a peer diff", async (t) => {
  const f = await setup(t);
  f.task.run.state = "finished";
  const old = "export const hello = 1;\n",
    after = "export const hello = 2;\n";
  f.pair("hello.ts", old, after);
  const bad = f.pair("bad.ts", null, "bad\n");
  Object.assign(bad[1].message.content[0], { is_error: true });
  const wrong = f.pair("wrong.ts", null, "outside\n");
  for (const e of wrong) Object.assign(e, { gitBranch: "other" });
  const missingBranch = f.pair("unknown.ts", null, "outside\n");
  for (const e of missingBranch) Object.assign(e, { gitBranch: undefined });
  f.pair(".memcode/private", null, "private\n");
  await writeFile(join(f.workspace, "hello.ts"), "export const hello = 99;\n");
  await f.store();
  const ui = await readDisplayedWorkerChanges(f.task);
  assert.equal(ui.checkpoints.length, 1);
  assert.equal(ui.checkpoints[0].basis, "native-receipt");
  assert.deepEqual(
    ui.checkpoints[0].files[0].hunks[0].lines.map((l) => l.text),
    [old.trim(), after.trim()],
  );
  const worker = await readWorkerChanges(f.task);
  assert.equal(worker.unverifiedEdits, 1);
  assert.equal(worker.checkpoints.length, 0);
  const review = await captureStoryReview(f.task);
  assert.equal(review.patch, "");
  assert.equal(review.snapshot.files.length, 0);
  assert.match(
    review.limitations.join(" "),
    /1 worker edit.*exact before-and-after/,
  );
  assert.equal(
    (await readDisplayedWorkerChanges(f.task)).checkpoints.length,
    1,
  );
});
test("a successful older Edit with matching Git baseline and disk is recovered as exact source", async (t) => {
  const f = await setup(t);
  f.task.run.state = "finished";
  const old = "export const hello = 1;\n",
    after = "export const hello = 2;\n";
  f.pair("hello.ts", old, after);
  await f.store();
  await writeFile(join(f.workspace, "hello.ts"), after);
  const review = await captureStoryReview(f.task);
  assert.deepEqual(review.limitations, []);
  assert.equal(review.snapshot.files[0].attribution, "native-edit");
  assert.match(review.patch, /\+export const hello = 2;/);
  assert.deepEqual(review.implementationRunIds, [f.task.run.changeRunId]);
});
test("native receipts integrate with Fleet snapshots and an earlier scoped import never inflates the diff", async (t) => {
  const f = await setup(t);
  f.task.run.state = "finished";
  const old = "export const hello = 1;\n",
    own = "export const hello = 2;\n",
    final = "export const hello = 3;\n";
  f.pair("hello.ts", old, own);
  await f.store();
  await writeFile(join(f.workspace, "hello.ts"), own);
  const native = (await readDisplayedWorkerChanges(f.task)).checkpoints[0];
  assert.equal(native.basis, "native-edit");
  const journal = join(
    f.workspace,
    ".memcode",
    "workers",
    f.task.id,
    "changes",
  );
  const baseline = {
    ...native,
    id: "scoped",
    basis: "scoped-baseline",
    runId: "old-" + f.task.id,
    startedAt: "2001-01-01T00:00:00Z",
    at: "2999-01-01T00:00:00Z",
  };
  await writeFile(
    join(journal, "checkpoints.jsonl"),
    JSON.stringify(baseline) + "\n",
  );
  const scoped = await readDisplayedWorkerChanges(f.task);
  assert.equal(scoped.checkpoints.length, 1);
  assert.equal(scoped.additions, 1);
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  await writeFile(join(journal, "blobs", hash(final)), final);
  await writeFile(join(f.workspace, "hello.ts"), final);
  const segment = {
    ...native,
    id: "second",
    runId: randomUUID(),
    basis: "fleet-reservation",
    startedAt: "2098-01-01T00:00:00Z",
    at: "2099-01-01T00:00:00Z",
    files: [
      { ...native.files[0], beforeHash: hash(own), afterHash: hash(final) },
    ],
  };
  await writeFile(
    join(journal, "checkpoints.jsonl"),
    [baseline, segment].map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  const mixed = await captureStoryReview(f.task);
  assert.equal(mixed.snapshot.files[0].attribution, "verified-edits");
  assert.deepEqual(mixed.limitations, []);
  assert.match(mixed.patch, /\+export const hello = 3/);
  assert.doesNotMatch(mixed.patch, /export const hello = 2/);
  const reservation = {
    ...native,
    basis: "fleet-reservation",
    id: "verified",
    startedAt: baseline.startedAt,
    at: native.at,
  };
  await writeFile(
    join(journal, "checkpoints.jsonl"),
    [baseline, reservation].map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  assert.deepEqual(
    (await readDisplayedWorkerChanges(f.task)).checkpoints.map((c) => c.basis),
    ["fleet-reservation"],
  );
});
