import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "../runtime/local";
import { EpicWorkspace, ensureTaskEpic } from "../runtime/epic-workspace";
import { detectBranchStrategy } from "../runtime/branch-strategy";
import { projectSharedState } from "../runtime/team/projection";
import { initialState } from "../src/seed";
import { isQuickChanges } from "../src/domain";
import type { Epic, WorkItem } from "../src/shared";

/** A project whose team works feature/* → dev → main, with dev ahead of main. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memcode-story-branches-"));
  const remote = join(directory, "remote.git"),
    root = join(directory, "project"),
    data = join(directory, "profile");
  await mkdir(data);
  await git(directory, ["init", "--bare", "--initial-branch=main", remote]);
  await git(directory, ["init", "--initial-branch=main", root]);
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.invalid"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
  ])
    await git(root, ["config", key, value]);
  await git(root, ["remote", "add", "origin", remote]);
  await writeFile(join(root, "source.ts"), "export const n = 0;\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "Initial"]);
  await git(root, ["push", "-u", "origin", "main"]);
  await git(root, ["switch", "-c", "dev"]);
  await git(root, ["switch", "-c", "feature/login"]);
  await writeFile(join(root, "login.ts"), "export const login = 1;\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "Login"]);
  await git(root, ["switch", "dev"]);
  await git(root, [
    "merge",
    "--no-ff",
    "feature/login",
    "-m",
    "Merge branch 'feature/login' into dev",
  ]);
  await git(root, ["push", "-u", "origin", "dev"]);
  await git(root, ["switch", "main"]);
  await git(root, ["remote", "set-head", "origin", "main"]);
  const state = initialState();
  const project = {
    id: "project",
    name: "Project",
    description: "",
    path: root,
    branch: "main",
    repoId: "canonical",
    analysis: "ready" as const,
    createdAt: new Date().toISOString(),
  };
  state.projects = [project];
  state.epics = [];
  state.tasks = [];
  const story = (
    id: string,
    title: string,
    epicId: string | null = null,
  ): WorkItem => {
    const task = {
      id,
      identifier: "MC-" + id,
      projectId: project.id,
      epicId,
      title,
      description: `Brief for ${title}`,
      stage: "planned",
      priority: "medium",
      category: "Work",
      harness: "codex",
      kind: "feature",
      checklist: [],
      messages: [],
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
      run: { state: "preparing" },
    } as WorkItem;
    state.tasks.push(task);
    return task;
  };
  const workspaces = new EpicWorkspace(() => state, data, (cwd) =>
    detectBranchStrategy(cwd, async () => null),
  );
  return { directory, root, state, project, story, workspaces };
}

const today = new Date().toISOString().slice(0, 10);

test("tasks without a goal share the project's Quick changes batch, branched from dev", async () => {
  const f = await fixture();
  try {
    const one = f.story("1", "Fix typo in the login banner");
    const two = f.story("2", "Rename a confusing setting");
    const batch = ensureTaskEpic(f.state, one);
    assert.ok(isQuickChanges(batch));
    assert.equal(batch.title, "Quick changes");
    assert.equal(ensureTaskEpic(f.state, two), batch, "small tasks batch together");
    await f.workspaces.activate(one, f.project, { ownedCheckout: true });
    await f.workspaces.activate(two, f.project, { ownedCheckout: true });
    assert.equal(one.run.workspace, two.run.workspace, "one warm worktree for the batch");
    assert.equal(batch.branch, `feature/quick-changes-${today}`);
    assert.equal(batch.baseBranch, "dev");
    assert.equal(
      await git(one.run.workspace!, ["rev-parse", "HEAD"]),
      await git(f.root, ["rev-parse", "origin/dev"]),
      "the batch starts from dev, not from whatever the user has checked out",
    );
    assert.equal(await git(f.root, ["branch", "--show-current"]), "main");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a shipped or outdated batch takes no new tasks; the next small task starts a fresh one", async () => {
  const f = await fixture();
  try {
    const first = ensureTaskEpic(f.state, f.story("1", "Small fix"));
    first.closedAt = new Date().toISOString();
    const second = ensureTaskEpic(f.state, f.story("2", "Another small fix"));
    assert.notEqual(second.id, first.id);
    second.updateNeeded = { reason: "dev changed", files: [], since: new Date().toISOString() };
    const third = ensureTaskEpic(f.state, f.story("3", "Third small fix"));
    assert.notEqual(third.id, second.id);
    assert.ok(isQuickChanges(third));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("existing Project work epics keep serving as the open batch", async () => {
  const f = await fixture();
  try {
    const legacy: Epic = {
      id: "legacy",
      projectId: f.project.id,
      identifier: "EP-01",
      title: "Project work",
      description: "",
      phase: "now",
      color: "mint",
      order: 1,
      sourceKey: "project-work",
    };
    f.state.epics.push(legacy);
    assert.equal(ensureTaskEpic(f.state, f.story("1", "Small fix")), legacy);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a task chosen into a goal joins it; the goal branches from dev with the team's naming", async () => {
  const f = await fixture();
  try {
    const epic: Epic = {
      id: "e1",
      projectId: f.project.id,
      identifier: "EP-01",
      title: "Keep people signed in",
      description: "",
      phase: "now",
      color: "mint",
      order: 1,
    };
    f.state.epics.push(epic);
    const one = f.story("1", "Rotate tokens", "e1");
    const two = f.story("2", "Refresh endpoint", "e1");
    assert.equal(ensureTaskEpic(f.state, one), epic);
    await f.workspaces.activate(one, f.project, { ownedCheckout: true });
    await f.workspaces.activate(two, f.project, { ownedCheckout: true });
    assert.equal(one.run.workspace, two.run.workspace);
    assert.equal(epic.branch, "feature/keep-people-signed-in");
    assert.equal(epic.baseBranch, "dev");
    assert.equal(
      await git(one.run.workspace!, ["rev-parse", "HEAD"]),
      await git(f.root, ["rev-parse", "origin/dev"]),
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a goal never reuses an existing branch name", async () => {
  const f = await fixture();
  try {
    await git(f.root, ["branch", "feature/keep-people-signed-in", "main"]);
    const epic: Epic = {
      id: "e1",
      projectId: f.project.id,
      identifier: "EP-01",
      title: "Keep people signed in",
      description: "",
      phase: "now",
      color: "mint",
      order: 1,
    };
    f.state.epics.push(epic);
    const task = f.story("1", "Rotate tokens", "e1");
    await f.workspaces.activate(task, f.project, { ownedCheckout: true });
    assert.equal(epic.branch, "feature/keep-people-signed-in-2");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Quick changes batches are shared with the team like any goal", async () => {
  const f = await fixture();
  try {
    const task = f.story("1", "Small fix");
    const batch = ensureTaskEpic(f.state, task);
    const shared = projectSharedState(f.state, f.project.id);
    assert.deepEqual(shared.epics.map((epic) => epic.id), [batch.id]);
    assert.equal(shared.stories[0].epicId, batch.id);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a project that chose where new work starts branches its goals from there", async () => {
  const f = await fixture();
  try {
    await git(f.root, ["switch", "-c", "staging", "main"]);
    await writeFile(join(f.root, "staging.ts"), "export const s = 1;\n");
    await git(f.root, ["add", "-A"]);
    await git(f.root, ["commit", "-m", "Staging only"]);
    await git(f.root, ["push", "-u", "origin", "staging"]);
    await git(f.root, ["switch", "main"]);
    Object.assign(f.project, { baseBranch: "staging" });
    const task = f.story("1", "Add the export");
    task.epicId = ensureTaskEpic(f.state, task).id;
    await f.workspaces.activate(task, f.project, { ownedCheckout: true });
    const goal = f.state.epics.find((epic) => epic.id === task.epicId)!;
    assert.equal(goal.baseBranch, "staging");
    assert.equal(
      await git(task.run.workspace!, ["rev-parse", "HEAD"]),
      await git(f.root, ["rev-parse", "origin/staging"]),
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
