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
  const updates = new GoalUpdates({
    state: () => state,
    changed: async () => {},
    refreshGraph: async (epicId) => {
      refreshed.push(epicId);
    },
  });
  return { root, goal, teammate, epic, task, refreshed, updates };
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
