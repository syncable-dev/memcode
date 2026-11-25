import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../runtime/local.ts";
import { GoalUpdates } from "../runtime/goal-updates.ts";
import type { AppState, Epic, WorkItem } from "../src/shared.ts";

/** A goal worktree started from an older dev; a teammate has since pushed to dev. */
async function fixture(teammateFile = "news.ts") {
  const root = await mkdtemp(join(tmpdir(), "memcode-goal-update-"));
  const remote = join(root, "remote.git"),
    repo = join(root, "repo"),
    goal = join(root, "goal"),
    teammate = join(root, "teammate");
  await git(root, ["init", "--bare", "--initial-branch=dev", remote]);
  await git(root, ["init", "--initial-branch=dev", repo]);
  const identify = async (cwd: string) => {
    for (const [key, value] of [
      ["user.name", "Fixture"],
      ["user.email", "fixture@example.invalid"],
      ["commit.gpgsign", "false"],
    ])
      await git(cwd, ["config", key, value]);
  };
  await identify(repo);
  await git(repo, ["remote", "add", "origin", remote]);
  await writeFile(join(repo, "app.ts"), "export const version = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "Initial"]);
  await git(repo, ["push", "-u", "origin", "dev"]);
  await git(repo, ["worktree", "add", "-b", "feature/sessions", goal, "dev"]);
  await git(root, ["clone", "--branch", "dev", remote, teammate]);
  await identify(teammate);
  await writeFile(join(teammate, teammateFile), "export const fromDev = 1;\n");
  await git(teammate, ["add", "-A"]);
  await git(teammate, ["commit", "-m", "Teammate work on dev"]);
  await git(teammate, ["push", "origin", "dev"]);
  const epic = {
    id: "e1",
    projectId: "p1",
    identifier: "EP-01",
    title: "Keep people signed in",
    branch: "feature/sessions",
    baseBranch: "dev",
    updateNeeded: {
      reason: "“Reports” merged and changed 1 file this goal uses.",
      files: [teammateFile],
      since: "2026-11-20T10:00:00.000Z",
    },
  } as Epic;
  const task = {
    id: "t1",
    identifier: "MC-1",
    projectId: "p1",
    epicId: "e1",
    title: "Rotate tokens",
    stage: "review",
    run: { state: "finished", workspace: goal, branch: "feature/sessions" },
  } as WorkItem;
  const state = {
    projects: [{ id: "p1", path: repo }],
    epics: [epic],
    tasks: [task],
  } as unknown as AppState;
  const refreshed: string[] = [];
  const asked: [string, string][] = [];
  const updates = new GoalUpdates({
    askWorker: (task, text) => void asked.push([task.identifier, text]),
    readChanges: async (task) =>
      ({
        checkpoints: task.id === "t1" ? [{ files: [{ path: "app.ts" }] }] : [],
      }) as never,
    state: () => state,
    changed: async () => {},
    refreshGraph: async (epicId) => {
      refreshed.push(epicId);
    },
  });
  return { root, goal, teammate, epic, task, state, refreshed, asked, updates };
}

test("updating a goal saves its work, brings in the newer dev and clears the warning", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.goal, "session.ts"), "export const token = 1;\n");
    const result = await f.updates.updateFromBase("e1");
    assert.deepEqual(result, { merged: true, savedWork: true });
    assert.equal(
      (await readFile(join(f.goal, "news.ts"), "utf8")).replaceAll("\r\n", "\n"),
      "export const fromDev = 1;\n",
      "the teammate's dev change is now in the goal",
    );
    assert.equal(await git(f.goal, ["status", "--porcelain"]), "");
    assert.equal(
      await git(f.goal, ["log", "-1", "--format=%s", "HEAD^1"]),
      "Save goal work before updating from dev",
    );
    assert.equal(f.epic.updateNeeded, undefined);
    assert.equal(
      f.epic.baseRevision,
      await git(f.teammate, ["rev-parse", "HEAD"]),
    );
    assert.deepEqual(f.refreshed, ["e1"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a goal already up to date just clears the warning", async () => {
  const f = await fixture();
  try {
    await git(f.goal, ["fetch", "origin", "dev"]);
    await git(f.goal, ["merge", "--no-edit", "origin/dev"]);
    const result = await f.updates.updateFromBase("e1");
    assert.deepEqual(result, { merged: false, savedWork: false });
    assert.equal(f.epic.updateNeeded, undefined);
    assert.deepEqual(f.refreshed, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a conflicting update is undone, keeps the goal's work and names the files", async () => {
  const f = await fixture("app.ts");
  try {
    await writeFile(join(f.goal, "app.ts"), "export const version = 2;\n");
    const result = await f.updates.updateFromBase("e1");
    assert.deepEqual(result, {
      merged: false,
      savedWork: true,
      conflicts: ["app.ts"],
    });
    assert.ok(
      !existsSync(join(f.goal, "..", "repo", ".git", "worktrees", "goal", "MERGE_HEAD")),
      "no merge is left half-done",
    );
    assert.equal(await git(f.goal, ["status", "--porcelain"]), "");
    assert.equal(
      (await readFile(join(f.goal, "app.ts"), "utf8")).replaceAll("\r\n", "\n"),
      "export const version = 2;\n",
      "the goal's own change is kept",
    );
    assert.ok(f.epic.updateNeeded, "the goal still needs its update");
    assert.deepEqual(f.refreshed, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("running tasks block the update so no agent loses its footing", async () => {
  const f = await fixture();
  try {
    f.task.run.state = "running";
    await assert.rejects(
      f.updates.updateFromBase("e1"),
      /Wait for 1 running task to finish, or stop it/,
    );
    assert.ok(f.epic.updateNeeded);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

/** The goal and dev changed the same line of app.ts. */
async function conflicting() {
  const f = await fixture("app.ts");
  await writeFile(join(f.goal, "app.ts"), "export const version = 2;\n");
  await writeFile(join(f.goal, "session.ts"), "export const token = 1;\n");
  // A later task of the goal, which did not touch the file.
  f.state.tasks.push({
    ...structuredClone(f.task),
    id: "t2",
    identifier: "MC-2",
    run: { ...f.task.run, finishedAt: "2026-11-25T10:00:00.000Z" },
  } as WorkItem);
  return f;
}

test("a worker that knows the files is asked to resolve a conflict, and the merge is committed when none is left", async () => {
  const f = await conflicting();
  try {
    const result = await f.updates.resolveWithWorker("e1");
    assert.deepEqual(result, { merged: false, savedWork: true, asked: "MC-1" });
    assert.deepEqual(f.epic.resolving?.files, ["app.ts"]);
    assert.match(f.asked[0][1], /conflicts in app\.ts[\s\S]*Do not run git merge, commit/);
    assert.match(await readFile(join(f.goal, "app.ts"), "utf8"), /<<<<<<<[\s\S]*>>>>>>>/);
    await assert.rejects(f.updates.updateFromBase("e1"), /being brought into this goal/);

    // It ends without having finished: nothing is committed and it can be asked again.
    const head = await git(f.goal, ["rev-parse", "HEAD"]);
    await f.updates.workerEnded(f.task);
    assert.deepEqual(f.epic.resolving?.files, ["app.ts"]);
    assert.equal(await git(f.goal, ["rev-parse", "HEAD"]), head);
    assert.equal((await f.updates.resolveWithWorker("e1")).asked, "MC-1");

    await writeFile(join(f.goal, "app.ts"), "export const version = 3;\n");
    await f.updates.workerEnded(f.task);
    assert.equal(f.epic.resolving, undefined);
    assert.equal(f.epic.updateNeeded, undefined);
    assert.equal(await git(f.goal, ["status", "--porcelain"]), "");
    assert.equal(
      await git(f.goal, ["rev-parse", "HEAD^2"]),
      await git(f.teammate, ["rev-parse", "HEAD"]),
      "dev is part of the branch",
    );
    assert.equal(await git(f.goal, ["show", "HEAD:app.ts"]), "export const version = 3;");
    assert.equal(existsSync(join(f.goal, "session.ts")), true);
    assert.deepEqual(f.refreshed, ["e1"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an update that conflicts can be taken out again, with the goal's work as it was", async () => {
  const f = await conflicting();
  try {
    await f.updates.resolveWithWorker("e1");
    await f.updates.undo("e1");
    assert.equal(f.epic.resolving, undefined);
    assert.ok(f.epic.updateNeeded, "it still needs its update");
    assert.equal(await git(f.goal, ["status", "--porcelain"]), "");
    assert.equal(await git(f.goal, ["show", "HEAD:app.ts"]), "export const version = 2;");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("what does not conflict is brought in without a worker", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.updates.resolveWithWorker("e1"), {
      merged: true,
      savedWork: false,
    });
    assert.deepEqual(f.asked, []);
    assert.equal(f.epic.resolving, undefined);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("only what is new conflicts on a branch that goes on after a squash merge", async () => {
  const f = await conflicting();
  try {
    // The goal's first commit went into dev as a squash, and dev moved on.
    await git(f.goal, ["add", "-A"]);
    await git(f.goal, ["commit", "-m", "First pull request"]);
    f.epic.mergedRevision = await git(f.goal, ["rev-parse", "HEAD"]);
    await writeFile(join(f.teammate, "app.ts"), "export const version = 2;\n");
    await writeFile(join(f.teammate, "session.ts"), "export const token = 9;\n");
    await git(f.teammate, ["add", "-A"]);
    await git(f.teammate, ["commit", "-m", "Squash, and a change to the token"]);
    await git(f.teammate, ["push", "origin", "dev"]);
    await writeFile(join(f.goal, "session.ts"), "export const token = 5;\n");
    await f.updates.resolveWithWorker("e1");
    assert.deepEqual(f.epic.resolving?.files, ["session.ts"], "app.ts is the same on both sides");
    await writeFile(join(f.goal, "session.ts"), "export const token = 59;\n");
    f.epic.resolving!.taskId = "t1";
    await f.updates.workerEnded(f.task);
    assert.equal(
      await git(f.goal, ["rev-parse", "HEAD^2"]),
      await git(f.teammate, ["rev-parse", "HEAD"]),
    );
    assert.equal(f.epic.mergedRevision, undefined);
    assert.equal(
      await git(f.goal, ["diff", "--name-only", "HEAD^2", "HEAD"]),
      "session.ts",
      "the next pull request holds only what is new",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a worker that did not get to its end commits nothing, whatever the files look like", async () => {
  const f = await conflicting();
  try {
    await f.updates.resolveWithWorker("e1");
    const head = await git(f.goal, ["rev-parse", "HEAD"]);
    await writeFile(join(f.goal, "app.ts"), "half of it\n");
    for (const state of ["failed", "stopped", "blocked"] as const) {
      f.task.run.state = state;
      await f.updates.workerEnded(f.task);
      assert.deepEqual(f.epic.resolving?.files, ["app.ts"], state);
      assert.equal(await git(f.goal, ["rev-parse", "HEAD"]), head);
    }
    // Asked again, it is the worker's to say that it is done.
    assert.equal((await f.updates.resolveWithWorker("e1")).asked, "MC-1");
    f.task.run.state = "finished";
    await f.updates.workerEnded(f.task);
    assert.equal(f.epic.resolving, undefined);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a file that was deleted or is not text is for a person to resolve", async () => {
  const f = await conflicting();
  try {
    await rm(join(f.teammate, "app.ts"));
    await git(f.teammate, ["add", "-A"]);
    await git(f.teammate, ["commit", "-m", "Without app.ts"]);
    await git(f.teammate, ["push", "origin", "dev"]);
    await assert.rejects(f.updates.resolveWithWorker("e1"), /app\.ts: one side deleted or replaced the whole file/);
    assert.equal(f.epic.resolving, undefined);
    assert.deepEqual(f.asked, []);
    assert.equal(await git(f.goal, ["status", "--porcelain"]), "");
    assert.equal(await git(f.goal, ["show", "HEAD:app.ts"]), "export const version = 2;");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a merge that was ended in the folder is not recorded as done", async () => {
  const f = await conflicting();
  try {
    await f.updates.resolveWithWorker("e1");
    await git(f.goal, ["merge", "--abort"]);
    f.task.run.state = "finished";
    await assert.rejects(f.updates.workerEnded(f.task), /Update from dev again/);
    assert.equal(f.epic.resolving, undefined);
    assert.ok(f.epic.updateNeeded, "it still needs its update");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an update that conflicts can always be taken out, or finished", async () => {
  const f = await conflicting();
  try {
    // The worker ended the merge itself.
    await f.updates.resolveWithWorker("e1");
    await git(f.goal, ["merge", "--abort"]);
    await f.updates.undo("e1");
    assert.equal(f.epic.resolving, undefined);
    // The tasks that worked there are gone.
    await f.updates.resolveWithWorker("e1");
    const tasks = f.state.tasks.splice(0);
    await f.updates.undo("e1");
    assert.equal(f.epic.resolving, undefined);
    assert.equal(await git(f.goal, ["status", "--porcelain"]), "");
    f.state.tasks.push(...tasks);
    // A worker is on it.
    await f.updates.resolveWithWorker("e1");
    f.task.run.state = "running";
    await assert.rejects(f.updates.undo("e1"), /Wait for 1 running task/);
    f.task.run.state = "failed";
    // It also changed a file the merge had brought in by itself.
    const merged = (await git(f.goal, ["diff", "--name-only", "--cached", "--diff-filter=AM"])).split("\n").find((name) => name && name !== "app.ts");
    if (merged) {
      await writeFile(join(f.goal, merged), "more of it\n");
      await assert.rejects(f.updates.undo("e1"), new RegExp(merged.replace(".", "\\.") + " was changed as well"));
      assert.ok(f.epic.resolving);
      await git(f.goal, ["checkout", "--", merged]);
    }
    await f.updates.undo("e1");
    assert.equal(f.epic.resolving, undefined);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
