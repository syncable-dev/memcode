import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "../runtime/local";
import { detectBranchStrategy } from "../runtime/branch-strategy";
import { githubPage, registerBranches } from "../runtime/branches";
import { initialState } from "../src/seed";
import type { Epic, Project, WorkItem } from "../src/shared";

/** A project folder on a stale branch, with a remote whose team works feature/* → dev → main. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memcode-repository-"));
  const remote = join(directory, "remote.git"),
    root = join(directory, "project");
  await git(directory, ["init", "--bare", "--initial-branch=main", remote]);
  await git(directory, ["init", "--initial-branch=main", root]);
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.invalid"],
    ["commit.gpgsign", "false"],
  ])
    await git(root, ["config", key, value]);
  await git(root, ["remote", "add", "origin", remote]);
  const commit = async (file: string, message: string) => {
    await writeFile(join(root, file), `export const x = "${message}";\n`);
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", message]);
  };
  await commit("a.ts", "Initial");
  await git(root, ["push", "-u", "origin", "main"]);
  await git(root, ["switch", "-c", "epic/old-goal"]);
  await git(root, ["switch", "-c", "dev", "main"]);
  await git(root, ["switch", "-c", "feature/login"]);
  await commit("login.ts", "Login");
  await git(root, ["switch", "dev"]);
  await git(root, ["merge", "--no-ff", "feature/login", "-m", "Merge branch 'feature/login' into dev"]);
  await commit("b.ts", "More on dev");
  await git(root, ["push", "-u", "origin", "dev"]);
  await git(root, ["push", "origin", "main:staging"]);
  await git(root, ["remote", "set-head", "origin", "main"]);
  // The folder sits on an old goal branch, with one file changed and not committed.
  await git(root, ["switch", "epic/old-goal"]);
  await writeFile(join(root, "a.ts"), "export const x = 'edited';\n");

  const state = initialState();
  const project: Project = {
    id: "project",
    name: "Website",
    description: "",
    path: root,
    branch: "epic/old-goal",
    analysis: "ready",
    createdAt: new Date().toISOString(),
  };
  state.projects = [project];
  state.tasks = [];
  state.epics = [];
  const goal = (id: string, changes: Partial<Epic> = {}): Epic => {
    const epic = {
      id,
      projectId: project.id,
      identifier: `EP-${id}`,
      title: `Goal ${id}`,
      description: "",
      phase: "now",
      color: "mint",
      order: 0,
      ...changes,
    } as Epic;
    state.epics.push(epic);
    return epic;
  };
  const routes = new Map<string, { schema: any; run: (input: any) => unknown }>();
  let saved = 0;
  registerBranches(
    (name, schema, run) => routes.set(name, { schema, run }),
    () => state,
    async () => void saved++,
    (cwd) => detectBranchStrategy(cwd, async () => null),
  );
  const call = async (name: string, input: unknown) => {
    const route = routes.get(name)!;
    return route.run(route.schema.parse(input)) as Promise<any>;
  };
  return { directory, root, state, project, goal, call, saved: () => saved };
}

test("GitHub remotes become their repository page; other remotes have none", () => {
  for (const url of [
    "https://github.com/syncable-dev/memcode.git",
    "https://github.com/syncable-dev/memcode",
    "git@github.com:syncable-dev/memcode.git",
    "ssh://git@github.com/syncable-dev/memcode.git",
  ])
    assert.equal(githubPage(url), "https://github.com/syncable-dev/memcode", url);
  assert.equal(githubPage("https://gitlab.com/team/app.git"), undefined);
  assert.equal(githubPage("/tmp/remote.git"), undefined);
});

test("the repository panel says which branch the folder is on, how far behind where new work starts, and what is uncommitted", async () => {
  const f = await fixture();
  try {
    const status = await f.call("project:repository", { projectId: f.project.id });
    assert.equal(status.folder, f.root);
    assert.equal(status.remote, "origin");
    assert.equal(status.branch, "epic/old-goal");
    assert.equal(status.changedFiles, 1);
    assert.deepEqual(status.base, { branch: "dev", chosen: false });
    assert.equal(status.behind, 3, "dev has the login branch, its merge and one more commit");
    assert.equal(status.ahead, 0);
    assert.deepEqual(status.branches, ["dev", "epic/old-goal", "feature/login", "main", "staging"]);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("you choose where new work starts, and can go back to what MemCode works out", async () => {
  const f = await fixture();
  try {
    await f.call("project:base-branch", { projectId: f.project.id, branch: "staging" });
    assert.equal(f.project.baseBranch, "staging");
    const chosen = await f.call("project:repository", { projectId: f.project.id });
    assert.deepEqual(chosen.base, { branch: "staging", chosen: true });
    assert.equal(chosen.behind, 0);
    await f.call("project:base-branch", { projectId: f.project.id, branch: null });
    assert.equal(f.project.baseBranch, undefined);
    assert.equal(f.saved(), 2);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a branch the repository does not have cannot be where new work starts", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => f.call("project:base-branch", { projectId: f.project.id, branch: "nope" }),
      /Website has no branch called nope\./,
    );
    assert.equal(f.project.baseBranch, undefined);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a goal that has not started can start fresh: its next work gets a new branch from where new work starts", async () => {
  const f = await fixture();
  try {
    const copied = f.goal("2", {
      branch: "epic/old-goal",
      baseBranch: "main",
      baseRevision: "3f19e16",
    });
    await f.call("goal:start-fresh", { id: copied.id });
    assert.equal(copied.branch, undefined);
    assert.equal(copied.baseRevision, undefined);
    assert.equal(copied.baseBranch, undefined, "it follows the project's choice");
    await f.call("goal:start-fresh", { id: copied.id, baseBranch: "staging" });
    assert.equal(copied.baseBranch, "staging");
    assert.equal(
      (await git(f.root, ["branch", "--list", "epic/old-goal"])).length > 0,
      true,
      "the old branch itself is never deleted",
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a goal whose work has started keeps its branch", async () => {
  const f = await fixture();
  try {
    const started = f.goal("3", { branch: "feature/goal-3", baseBranch: "dev" });
    f.state.tasks.push({
      id: "t1",
      projectId: f.project.id,
      epicId: started.id,
      run: { state: "finished", startedAt: new Date().toISOString() },
    } as WorkItem);
    await assert.rejects(
      () => f.call("goal:start-fresh", { id: started.id }),
      /Goal 3 already has work on feature\/goal-3\. Use Update from dev to bring in newer work\./,
    );
    assert.equal(started.branch, "feature/goal-3");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
