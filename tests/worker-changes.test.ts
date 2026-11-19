import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import { WorkerChangeJournal, readWorkerChanges } from "../runtime/changes";
import { git } from "../runtime/local";

test("absolute scope from a checkout alias captures a single relative file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memcode-journal-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout"), alias = join(root, "alias");
  await mkdir(checkout);
  await symlink(await realpath(checkout), alias, "junction");
  await git(checkout, ["init", "--initial-branch=main"]);
  const state = initialState();
  const project = { ...state.projects[0], path: alias, example: false };
  const task = {
    ...state.tasks[0], id: "aliased-scope", scope: [join(alias, "new.ts")],
    run: { state: "running" as const, branch: "main", workspace: alias },
  };
  const journal = new WorkerChangeJournal();
  await journal.begin(project, task);
  await writeFile(join(checkout, "new.ts"), "export const answer = 42;\n");
  await journal.release(project, task);
  const changes = await readWorkerChanges(task);
  assert.deepEqual(changes.checkpoints[0].files.map(file => file.path), ["new.ts"]);
});

test("same-file Fleet handoff assigns each interval only to its owning worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-change-journal-"));
  await git(root, ["init", "--initial-branch=main"]);
  const state = initialState(),
    project = { ...state.projects[0], path: root, example: false };
  const tasks = state.tasks
    .slice(0, 3)
    .map((t, i) => ({
      ...t,
      id: "journal-" + i,
      scope: ["shared.ts"],
      run: { state: "running" as const, branch: "main", workspace: root },
    }));
  const journal = new WorkerChangeJournal();
  const path = join(root, "shared.ts");
  await writeFile(path, "export const agents = [];\n");
  for (let i = 0; i < tasks.length; i++) {
    await journal.begin(project, tasks[i]);
    const agents = ["codex", "claude", "cursor"].slice(0, i + 1);
    await writeFile(
      path,
      "export const agents = " + JSON.stringify(agents) + ";\n",
    );
    await journal.checkpoint(project, tasks[i]);
    await journal.release(project, tasks[i]);
  }
  const all = await Promise.all(tasks.map(readWorkerChanges));
  assert.equal(all.length, 3);
  for (const [i, changes] of all.entries()) {
    assert.equal(changes.files, 1);
    assert.equal(changes.checkpoints.length, 1);
    assert.equal(changes.additions, 1);
    assert.equal(changes.deletions, 1);
    assert.equal(changes.checkpoints[0].taskId, tasks[i].id);
    const lines = changes.checkpoints[0].files[0].hunks[0].lines;
    const added = lines.find((l) => l.kind === "add")!.text;
    const deleted = lines.find((l) => l.kind === "delete")!.text;
    assert.equal(
      added,
      "export const agents = " +
        JSON.stringify(["codex", "claude", "cursor"].slice(0, i + 1)) +
        ";",
    );
    assert.equal(
      deleted,
      i
        ? "export const agents = " +
            JSON.stringify(["codex", "claude", "cursor"].slice(0, i)) +
            ";"
        : "export const agents = [];",
    );
  }
  // A later unowned/manual change is never appended by an absent reservation.
  await writeFile(path, "export const agents = ['external'];\n");
  await journal.checkpoint(project, tasks[0]);
  assert.deepEqual(await readWorkerChanges(tasks[0]), all[0]);
  // New ownership starts from that current source, not any earlier epic diff.
  await journal.begin(project, tasks[0]);
  await writeFile(path, "export const agents = ['external', 'codex'];\n");
  await journal.release(project, tasks[0]);
  const next = (await readWorkerChanges(tasks[0])).checkpoints[1];
  assert.equal(
    next.files[0].hunks[0].lines.find((l) => l.kind === "delete")!.text,
    "export const agents = ['external'];",
  );
});

test("change capture preserves binary hashes and refuses an outside scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-change-binary-"));
  await git(root, ["init", "--initial-branch=main"]);
  const state = initialState(),
    project = { ...state.projects[0], path: root, example: false };
  const task = {
    ...state.tasks[0],
    id: "binary",
    scope: ["data.bin"],
    run: { state: "running" as const, branch: "main", workspace: root },
  };
  const journal = new WorkerChangeJournal();
  await writeFile(join(root, "data.bin"), Buffer.from([0, 1, 255]));
  await journal.begin(project, task);
  await writeFile(join(root, "data.bin"), Buffer.from([0, 2, 254]));
  await journal.release(project, task);
  const changes = await readWorkerChanges(task);
  assert.equal(changes.checkpoints[0].files[0].binary, true);
  assert.equal(changes.additions, 0);
  task.scope = ["../outside.ts"];
  await assert.rejects(journal.begin(project, task), /outside/);
});
