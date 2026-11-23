import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../runtime/local";
import type { AppState } from "../src/shared";

// Board sync writes its own save before the workspace that goes with it:
// runtime/sharing/board/sync.ts. These are the two things it needs of the store.

async function store(context: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "memcode-workspace-save-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const made = new LocalStore(dir);
  await made.load();
  const onDisk = async () =>
    JSON.parse(await readFile(join(dir, "workspace.json"), "utf8")) as AppState;
  return { store: made, onDisk };
}
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

test("a workspace is saved as it was when the save was asked for, after the step that goes first", async (context) => {
  const { store: saving, onDisk } = await store(context);
  await saving.save();
  const first = gate();
  const order: string[] = [];
  saving.state.activeProjectId = "as it was when asked";
  const saved = saving.save(async () => {
    await first.opened;
    order.push("the step that goes first");
  });
  // The workspace changes while that step is still running.
  saving.state.activeProjectId = "changed afterwards";
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.notEqual((await onDisk()).activeProjectId, "as it was when asked");
  first.open();
  await saved;
  order.push("the workspace file");
  assert.deepEqual(order, ["the step that goes first", "the workspace file"]);
  assert.equal((await onDisk()).activeProjectId, "as it was when asked");
});

test("a save asked for later is written after one that is still waiting for its first step", async (context) => {
  const { store: saving, onDisk } = await store(context);
  const first = gate();
  saving.state.activeProjectId = "earlier";
  const earlier = saving.save(() => first.opened);
  saving.state.activeProjectId = "later";
  let laterIsWritten = false;
  const later = saving.save().then(() => void (laterIsWritten = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The later save holds the same changes, so it must not reach the disk first.
  assert.equal(laterIsWritten, false);
  first.open();
  await Promise.all([earlier, later]);
  assert.equal((await onDisk()).activeProjectId, "later");
});

test("when the step that goes first fails, the workspace file is left as it was", async (context) => {
  const { store: saving, onDisk } = await store(context);
  saving.state.activeProjectId = "kept";
  await saving.save();
  saving.state.activeProjectId = "never written";
  await assert.rejects(
    saving.save(async () => {
      throw new Error("the first step failed");
    }),
    /the first step failed/,
  );
  assert.equal((await onDisk()).activeProjectId, "kept");
  // A later save is not held up by it.
  saving.state.activeProjectId = "written after";
  await saving.save();
  assert.equal((await onDisk()).activeProjectId, "written after");
});
