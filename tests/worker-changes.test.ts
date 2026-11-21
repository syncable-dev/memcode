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

async function sharedCheckout(t: { after(fn: () => unknown): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memcode-shared-edit-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "--initial-branch=main"]);
  const state = initialState(),
    project = { ...state.projects[0], path: root, example: false };
  const [first, second] = state.tasks.slice(0, 2).map((task, index) => ({
    ...task,
    id: "editor-" + index,
    scope: [] as string[],
    run: { state: "running" as const, branch: "main", workspace: root },
  }));
  const write = (a: number, b: number) =>
    writeFile(join(root, "shared.ts"), `export const a = ${a};\nexport const b = ${b};\n`);
  await write(1, 1);
  return { project, first, second, write, journal: new WorkerChangeJournal() };
}
const added = (changes: Awaited<ReturnType<typeof readWorkerChanges>>) =>
  changes.checkpoints.flatMap((checkpoint) =>
    checkpoint.files.flatMap((file) =>
      file.hunks.flatMap((hunk) =>
        hunk.lines.filter((line) => line.kind === "add").map((line) => line.text),
      ),
    ),
  );

test("two workers editing one file at once: every change is recorded once, and the record says who else was editing", async (t) => {
  const f = await sharedCheckout(t);
  await f.journal.begin(f.project, f.first, ["shared.ts"]);
  await f.journal.begin(f.project, f.second, ["shared.ts"]);
  await f.write(2, 1);
  await f.write(2, 2);
  await f.journal.checkpoint(f.project, f.first, { sharedWith: () => [f.second.id] });
  await f.write(2, 3);
  await f.journal.checkpoint(f.project, f.second);
  const [first, second] = await Promise.all([f.first, f.second].map(readWorkerChanges));
  assert.deepEqual(added(first), ["export const a = 2;", "export const b = 2;"]);
  assert.deepEqual(first.checkpoints[0].sharedWith, [f.second.id]);
  assert.deepEqual(added(second), ["export const b = 3;"], "nothing the first record already holds");
  assert.equal(second.checkpoints[0].sharedWith, undefined);
});

test("a finishing worker does not sweep up a file another worker is still editing", async (t) => {
  const f = await sharedCheckout(t);
  await f.journal.begin(f.project, f.first, ["shared.ts"]);
  await f.journal.begin(f.project, f.second, ["shared.ts"]);
  await f.write(1, 2);
  await f.journal.release(f.project, f.first, { skip: (path) => path === "shared.ts" });
  assert.equal((await readWorkerChanges(f.first)).checkpoints.length, 0);
  await f.journal.checkpoint(f.project, f.second);
  assert.deepEqual(added(await readWorkerChanges(f.second)), ["export const b = 2;"]);
});

test("a file a worker starts on later is followed from that moment", async (t) => {
  const f = await sharedCheckout(t);
  await f.journal.begin(f.project, f.first);
  await f.write(5, 1);
  await f.journal.begin(f.project, f.first, ["shared.ts"]);
  await f.write(5, 6);
  await f.journal.checkpoint(f.project, f.first);
  assert.deepEqual(added(await readWorkerChanges(f.first)), ["export const b = 6;"]);
});

test("a new file created in a task's planned folder is recorded as that task's", async (t) => {
  const f = await sharedCheckout(t);
  f.first.scope = ["parts/"];
  await f.journal.begin(f.project, f.first);
  await mkdir(join(f.project.path!, "parts"));
  await writeFile(join(f.project.path!, "parts", "helper.ts"), "export const helper = 1;\n");
  await f.journal.checkpoint(f.project, f.first);
  const [checkpoint] = (await readWorkerChanges(f.first)).checkpoints;
  assert.deepEqual(checkpoint.files.map((file) => [file.path, file.status]), [["parts/helper.ts", "added"]]);
});
