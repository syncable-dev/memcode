import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { git } from "../runtime/local";
import { EpicWorkspace } from "../runtime/epic-workspace";
import { shipBranch } from "../runtime/goal-branch";
import { createPullRequestService } from "../runtime/pull-request";
import { retireShippedGoal } from "../runtime/shipped-goal";
import { applyBoard, boardOf } from "../runtime/sharing/board/board";
import { emptyBoard } from "../runtime/sharing/board/document";
import { initialState } from "../src/seed";
import { currentPullRequest, mergedPullRequests, pullRequestOf } from "../src/goal-work";
import { epicReadiness } from "../src/pull-request";
import type { AppState, Epic, Project, WorkItem } from "../src/shared";
import type { SharedProjectLink } from "../src/sharing";

const AT = "2026-11-25T10:00:00.000Z";
const fakeGitHubCli = fileURLToPath(new URL("fixtures/fake-gh.mjs", import.meta.url));
const onGitHub = (number: number, state: "OPEN" | "MERGED") => ({
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  state,
  isDraft: false,
  reviewDecision: "",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [],
});

async function setUp(root: string) {
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.invalid"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
  ])
    await git(root, ["config", key, value]);
}

async function computer(directory: string, name: string, remote: string) {
  const root = join(directory, name),
    data = join(directory, `${name}-profile`);
  await mkdir(data);
  await git(directory, ["clone", "--quiet", remote, root]);
  await setUp(root);
  const state: AppState = initialState();
  const project = {
    id: "p1",
    name: "App",
    description: "",
    path: root,
    branch: "main",
    baseBranch: "main",
    repoId: "canonical",
    analysis: "ready",
    createdAt: AT,
  } as Project;
  const goal: Epic = {
    id: "goal",
    projectId: "p1",
    identifier: "EP-01",
    title: "Checkout",
    description: "Customers pay in one step.",
    phase: "now",
    color: "mint",
    order: 0,
  };
  state.projects = [project];
  state.epics = [goal];
  state.tasks = [];
  const workspaces = new EpicWorkspace(() => state, data, async () => ({
    base: "main",
    reason: { kind: "fallback" },
    remote: "origin",
    featurePrefix: "feat/",
    fixPrefix: "fix/",
  }));
  // GitHub, as the person's own `gh` answers for it. Null is a computer without it.
  const github = { pr: null as object | null, calls: [] as string[][] };
  const answers = join(directory, `${name}-gh.json`);
  const service = createPullRequestService({
    state: () => state,
    changed: async () => {},
    openUrl: async () => {},
    findGitHubCli: async () => {
      if (!github.pr) return null;
      await writeFile(answers, JSON.stringify({ ...github, mergeMethod: "SQUASH" }));
      return {
        command: process.execPath,
        prefix: [fakeGitHubCli],
        env: { FAKE_GH_STATE: answers },
      };
    },
    readChanges: async (task) => ({
      taskId: task.id,
      checkpoints: [],
      files: 1,
      additions: 1,
      deletions: 0,
    }),
  });
  const task = (id: string, title: string, epicId: string | null = "goal") => {
    const item = {
      id,
      identifier: id.toUpperCase(),
      projectId: "p1",
      epicId,
      title,
      description: "",
      stage: "planned",
      priority: "medium",
      category: "Work",
      harness: "claude",
      kind: "feature",
      checklist: [],
      messages: [],
      createdAt: AT,
      updatedAt: AT,
      run: { state: "idle" },
    } as WorkItem;
    state.tasks.push(item);
    return item;
  };
  const start = async (item: WorkItem) => {
    item.run = { ...item.run, state: "preparing", startedAt: AT };
    await workspaces.activate(item, project, { ownedCheckout: true });
  };
  /** Starts a task's worker, which writes one file and finishes. */
  const work = async (item: WorkItem, file = `${item.id}.ts`) => {
    await start(item);
    item.run.changeRunId = `run-${item.id}`;
    await writeFile(join(item.run.workspace!, file), `export const ${item.id} = 1;\n`);
    item.run.state = "finished";
    item.stage = "review";
    return item;
  };
  const create = (shipUnfinished?: boolean, epicId = "goal") =>
    service.create({
      epicId,
      title: "Ship",
      description: "Why",
      commitMessage: "Ship",
      ...(shipUnfinished ? { shipUnfinished } : {}),
    });
  return { root, data, state, project, goal, workspaces, service, github, task, start, work, create };
}
type Computer = Awaited<ReturnType<typeof computer>>;

async function team() {
  const directory = await mkdtemp(join(tmpdir(), "memcode-goal-ships-"));
  const remote = join(directory, "remote.git"),
    seed = join(directory, "seed");
  await git(directory, ["init", "--bare", "--initial-branch=main", remote]);
  await git(directory, ["init", "--initial-branch=main", seed]);
  await setUp(seed);
  await git(seed, ["remote", "add", "origin", remote]);
  await writeFile(join(seed, "app.ts"), "export const app = 1;\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-m", "Initial"]);
  await git(seed, ["push", "-u", "origin", "main"]);
  const squash = async (branch: string) => {
    await git(seed, ["fetch", "origin"]);
    await git(seed, ["merge", "--ff-only", "origin/main"]);
    await git(seed, ["merge", "--squash", `origin/${branch}`]);
    await git(seed, ["commit", "-m", `Merge ${branch}`]);
    await git(seed, ["push", "origin", "main"]);
  };
  return {
    computer: (name: string) => computer(directory, name, remote),
    squash,
    /** Someone else's commit. */
    push: async (branch: string, file: string, text: string) => {
      await git(seed, ["fetch", "origin"]);
      await git(seed, ["merge", "--ff-only", "origin/main"]);
      await writeFile(join(seed, file), text);
      await git(seed, ["add", "-A"]);
      await git(seed, ["commit", "-m", file]);
      await git(seed, ["push", "origin", `HEAD:${branch}`]);
    },
    /** Squashes the goal's pushed branch into main, as GitHub would, and tells MemCode. */
    merge: async (c: Computer) => {
      const branch = c.goal.branch!;
      await squash(branch);
      const record = c.state.pullRequests!.find((item) => item.branch === branch)!;
      Object.assign(record, { state: "merged", mergedAt: AT });
      return { branch, finished: shipBranch(c.state, c.goal, branch, AT) };
    },
    end: () => rm(directory, { recursive: true, force: true, maxRetries: 5 }),
  };
}

const diffWithMain = async (c: Computer, branch: string) => {
  await git(c.root, ["fetch", "origin"]);
  return (await git(c.root, ["diff", "--name-only", `origin/main...${branch}`])).split("\n");
};

test("a goal ships what was worked on, stays open, and starts again from the newest base", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    const one = c.task("t1", "Show the total"),
      two = c.task("t2", "Pay by card"),
      three = c.task("t3", "Send a receipt"),
      four = c.task("t4", "Refund a payment");
    await c.work(one);
    await c.work(two);
    assert.equal(one.run.workspace, two.run.workspace, "tasks worked on together share it");
    assert.deepEqual(epicReadiness(c.state.tasks, c.goal), {
      total: 2,
      ready: 2,
      active: 0,
      waiting: 2,
      unfinished: 0,
      isReady: true,
    });
    await c.create();
    const first = await t.merge(c);
    assert.equal(first.branch, "feat/checkout");
    assert.equal(first.finished, 2);
    assert.deepEqual(c.state.tasks.map((task) => task.stage), ["done", "done", "planned", "planned"]);
    assert.equal(c.goal.closedAt, undefined, "two tasks are left");
    assert.equal(c.goal.branch, undefined);

    await c.work(three);
    assert.equal(c.goal.branch, "feat/send-a-receipt", "named by the task that begins it");
    assert.notEqual(three.run.workspace, one.run.workspace, "its own checkout");
    assert.notEqual(three.run.analysisProjectId, one.run.analysisProjectId);
    assert.equal(
      await git(three.run.workspace!, ["rev-parse", "HEAD"]),
      await git(c.root, ["rev-parse", "origin/main"]),
      "from main with the first pull request in it",
    );
    const plan = await c.service.plan("goal");
    assert.equal(plan.title, "Send a receipt", "not the whole goal's name again");
    assert.doesNotMatch(plan.description, /Show the total/);
    assert.equal(plan.existing, undefined, "the merged pull request is not this one");
    await c.create();
    assert.deepEqual(await diffWithMain(c, c.goal.branch!), ["t3.ts"]);
    assert.equal(c.state.pullRequests!.length, 2);
    assert.deepEqual(
      mergedPullRequests(c.state.pullRequests, c.goal).map((item) => item.branch),
      ["feat/checkout"],
    );
    await t.merge(c);
    await c.work(four);
    await c.create();
    await t.merge(c);
    assert.ok(c.goal.closedAt, "nothing is left, so the goal is finished");
  } finally {
    await t.end();
  }
});

test("two people work on one goal on two computers, and both can push", async () => {
  const t = await team();
  try {
    const a = await t.computer("a");
    const b = await t.computer("b");
    a.task("t1", "Show the total");
    a.task("t2", "Pay by card");
    await a.work(a.state.tasks[0]);
    // The shared board carries the goal and its tasks to the other computer.
    const board = boardOf(a.state, "p1");
    b.state.epics = [];
    applyBoard(b.state, "p1", emptyBoard(), board, { at: AT });
    b.goal = b.state.epics[0];
    const theirs = b.state.tasks.find((task) => task.id === "t2")!;
    await b.work(theirs);
    assert.equal(b.goal.branch, "feat/pay-by-card");
    assert.equal((await a.create()).pushed, true);
    assert.equal((await b.create()).pushed, true);
    const plan = await b.service.plan("goal");
    assert.doesNotMatch(plan.description, /Show the total/, "only what was done here");

    // The other computer's branch does not replace the one being worked on.
    const before = boardOf(b.state, "p1");
    const after = structuredClone(before);
    after.goals.goal.fields.branch = "feat/checkout";
    after.goals.goal.fields.phase = "later";
    applyBoard(b.state, "p1", before, after, { at: AT });
    assert.equal(b.goal.branch, "feat/pay-by-card");
    assert.equal(b.goal.phase, "later");

    // Shipping here leaves the other person's task alone.
    b.state.tasks.find((task) => task.id === "t1")!.stage = "review";
    await t.merge(b);
    assert.deepEqual(b.state.tasks.map((task) => [task.id, task.stage]), [
      ["t1", "review"],
      ["t2", "done"],
    ]);
    assert.equal(b.goal.closedAt, undefined);
  } finally {
    await t.end();
  }
});

test("two computers that start a goal before they have heard of each other can both push", async () => {
  const t = await team();
  try {
    for (const [goal, first, second] of [
      ["goal", "Show the total", "Pay by card"],
      [null, "Fix a typo", "Rename a button"],
    ] as const) {
      const a = await t.computer(`a-${goal}`);
      const b = await t.computer(`b-${goal}`);
      for (const c of [a, b])
        c.state.sharedProjectLinks = [
          { projectId: "p1", sharedProjectId: "s1" } as SharedProjectLink,
        ];
      const mine = await a.work(a.task("t1", first, goal));
      const theirs = await b.work(b.task("t2", second, goal));
      assert.notEqual(mine.run.branch, theirs.run.branch);
      for (const [c, task] of [
        [a, mine],
        [b, theirs],
      ] as const) {
        const made = await c.create(undefined, task.epicId!);
        assert.equal(made.pushed, true, `${task.run.branch}`);
      }
    }
  } finally {
    await t.end();
  }
});

test("a merge made on GitHub is noticed, also by the task that starts next", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    await c.work(c.task("t1", "Show the total"));
    const two = c.task("t2", "Pay by card"),
      three = c.task("t3", "Send a receipt");
    await c.create();
    const record = c.state.pullRequests![0];
    Object.assign(record, { number: 7, state: "open" });
    c.github.pr = onGitHub(7, "OPEN");
    await c.service.noticeMerges(() => true);
    assert.equal(record.state, "open");

    c.github.pr = onGitHub(7, "MERGED");
    // As the app does before a worker enters the branch.
    two.run = { ...two.run, state: "preparing", startedAt: AT };
    await c.service.noticeMerges((goal) => goal.id === "goal", "t2");
    assert.equal(record.state, "merged");
    assert.equal(c.state.tasks[0].stage, "done");
    await c.work(two);
    assert.equal(c.goal.branch, "feat/pay-by-card", "not the branch that merged");
    assert.equal(three.stage, "planned");
    await c.service.noticeMerges(() => true);
    assert.equal(two.stage, "review", "its own branch has no pull request yet");
  } finally {
    await t.end();
  }
});

test("a follow-up to a task that merged on GitHub starts on a new branch", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    const one = await c.work(c.task("t1", "Show the total"));
    c.task("t2", "Pay by card");
    await c.create();
    Object.assign(c.state.pullRequests![0], { number: 7, state: "open" });
    c.github.pr = onGitHub(7, "MERGED");
    one.run = { ...one.run, state: "preparing", startedAt: AT };
    await c.service.noticeMerges((goal) => goal.id === "goal", "t1");
    await c.work(one, "follow-up.ts");
    assert.equal(c.goal.branch, "feat/show-the-total");
    assert.equal(one.stage, "review");
    assert.equal(c.goal.closedAt, undefined);
  } finally {
    await t.end();
  }
});

test("work newer than the pull request is not called done by its merge, and ships in the next", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    const one = await c.work(c.task("t1", "Show the total"));
    await c.create();
    const [first] = c.state.pullRequests!;
    Object.assign(first, { number: 7, state: "open" });
    // Two more on the branch after the push: one is finished, one still runs.
    const later = (ms: number) => new Date(Date.parse(first.pushedAt!) + ms).toISOString();
    const two = await c.work(c.task("t2", "Pay by card"));
    two.run.finishedAt = later(1000);
    const three = await c.work(c.task("t3", "Send a receipt"));
    Object.assign(three, { stage: "working" });
    three.run.state = "running";
    one.run.finishedAt = later(-1000);

    c.github.pr = onGitHub(7, "MERGED");
    await c.service.noticeMerges(() => true);
    assert.deepEqual(
      [one, two, three].map((task) => task.stage),
      ["done", "review", "working"],
    );
    assert.equal(c.goal.branch, "feat/checkout", "they go on where their work is");
    assert.equal(c.goal.closedAt, undefined);
    assert.equal(first.tasks, 1);
    assert.deepEqual(mergedPullRequests(c.state.pullRequests, c.goal), [first]);
    assert.equal(currentPullRequest(c.state.pullRequests, c.goal), undefined);

    three.run.state = "finished";
    three.run.finishedAt = later(2000);
    three.stage = "review";
    assert.equal((await c.service.plan("goal")).existing, undefined);
    c.github.pr = null;
    await c.create();
    assert.equal(c.state.pullRequests!.length, 2, "the merged one keeps its record");
    const second = currentPullRequest(c.state.pullRequests, c.goal)!;
    Object.assign(second, { number: 8, state: "open" });
    c.github.pr = onGitHub(8, "MERGED");
    await c.service.noticeMerges(() => true);
    assert.deepEqual([second.state, second.tasks], ["merged", 2]);
    assert.ok(c.goal.closedAt, "nothing is left");
    assert.equal(currentPullRequest(c.state.pullRequests, c.goal), second);
    assert.deepEqual(mergedPullRequests(c.state.pullRequests, c.goal), [first]);
    assert.equal(pullRequestOf(c.state.pullRequests, c.goal, one), first);
  } finally {
    await t.end();
  }
});

test("after a squash merge the next pull request from the branch holds only what is new", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    const write = (task: WorkItem, text: string) =>
      writeFile(join(task.run.workspace!, "index.ts"), text);
    const one = await c.work(c.task("t1", "Show the total"));
    await write(one, "export * from './total';\n");
    await c.create();
    const [first] = c.state.pullRequests!;
    Object.assign(first, { number: 7, state: "open" });
    one.run.finishedAt = new Date(Date.parse(first.pushedAt!) - 1000).toISOString();
    const two = await c.work(c.task("t2", "Pay by card"));
    two.run.finishedAt = new Date(Date.parse(first.pushedAt!) + 1000).toISOString();
    await write(two, "export * from './total';\nexport * from './card';\n");
    await t.push("main", "other.ts", "export const other = 1;\n");
    await t.squash(c.goal.branch!);
    c.github.pr = onGitHub(7, "MERGED");
    await c.service.noticeMerges(() => true);
    assert.deepEqual([one.stage, two.stage], ["done", "review"]);

    const plan = await c.service.plan("goal");
    assert.equal(plan.title, "Pay by card", "what shipped is not named again");
    assert.equal(plan.readiness.total, 1);
    assert.deepEqual(plan.steps.slice(0, 3), [
      "Commit 2 files to feat/checkout",
      "Bring in main, with the pull request that merged",
      "Push feat/checkout to origin",
    ]);
    c.github.pr = null;
    await c.create();
    assert.deepEqual(await diffWithMain(c, "feat/checkout"), ["index.ts", "t2.ts"]);
    await t.squash(c.goal.branch!);
    await git(c.root, ["fetch", "origin"]);
    assert.equal(
      await git(c.root, ["show", "origin/main:index.ts"]),
      "export * from './total';\nexport * from './card';",
      "it merged without a conflict",
    );
    assert.equal(await git(two.run.workspace!, ["status", "--porcelain"]), "");
  } finally {
    await t.end();
  }
});

test("when the base really changed the same lines, the pull request says so and loses nothing", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    const one = await c.work(c.task("t1", "Show the total"), "index.ts");
    await c.create();
    const [first] = c.state.pullRequests!;
    Object.assign(first, { number: 7, state: "open" });
    one.run.finishedAt = new Date(Date.parse(first.pushedAt!) - 1000).toISOString();
    const two = await c.work(c.task("t2", "Pay by card"));
    two.run.finishedAt = new Date(Date.parse(first.pushedAt!) + 1000).toISOString();
    await writeFile(join(two.run.workspace!, "index.ts"), "mine\n");
    await t.squash(c.goal.branch!);
    await t.push("main", "index.ts", "theirs\n");
    c.github.pr = onGitHub(7, "MERGED");
    await c.service.noticeMerges(() => true);
    c.github.pr = null;
    await assert.rejects(c.create(), /main changed the same lines in index\.ts/);
    assert.equal(await git(two.run.workspace!, ["show", "HEAD:index.ts"]), "mine");
    assert.equal(await git(two.run.workspace!, ["status", "--porcelain"]), "");
    assert.equal(c.state.pullRequests!.length, 1);
  } finally {
    await t.end();
  }
});

test("quick changes stay open for work newer than their pull request", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    const one = await c.work(c.task("t1", "Fix a typo", null));
    await c.create(undefined, one.epicId!);
    const batch = c.state.epics.find((epic) => epic.id === one.epicId)!;
    Object.assign(c.state.pullRequests![0], { number: 7, state: "open" });
    const two = await c.work(c.task("t2", "Rename a button", null));
    two.run.state = "running";
    c.github.pr = onGitHub(7, "MERGED");
    await c.service.noticeMerges(() => true);
    assert.deepEqual([one.stage, two.epicId, batch.closedAt], ["done", batch.id, undefined]);
  } finally {
    await t.end();
  }
});

test("a branch someone pushed since the last fetch is not used again", async () => {
  const t = await team();
  try {
    // Two people with a project each on one repository, such as one epic brought in twice.
    const a = await t.computer("a");
    const b = await t.computer("b");
    await a.work(a.task("t1", "Show the total"));
    assert.equal((await a.create()).pushed, true);
    await b.work(b.task("t2", "Pay by card"));
    assert.equal(b.goal.branch, "feat/checkout-2");
    assert.equal((await b.create()).pushed, true);
  } finally {
    await t.end();
  }
});

test("two projects that begin the same goal before either pushes both ship it", async () => {
  const t = await team();
  try {
    const a = await t.computer("a");
    const b = await t.computer("b");
    await a.work(a.task("t1", "Show the total"));
    const theirs = await b.work(b.task("t2", "Pay by card"));
    assert.equal(a.goal.branch, b.goal.branch, "neither could know");
    assert.equal((await a.create()).pushed, true);
    const made = await b.create();
    assert.equal(made.pullRequest.branch, "feat/checkout-2");
    assert.deepEqual([b.goal.branch, theirs.run.branch], ["feat/checkout-2", "feat/checkout-2"]);
    assert.deepEqual(await diffWithMain(b, "feat/checkout-2"), ["t2.ts"]);
    // The goal goes on in the same folder under the new name.
    const next = await b.work(b.task("t3", "Send a receipt"));
    assert.equal(next.run.workspace, theirs.run.workspace);
    assert.equal((await b.create()).pullRequest.branch, "feat/checkout-2");
    await t.merge(b);
    await b.work(b.task("t4", "Refund a payment"));
    assert.equal(b.goal.branch, "feat/refund-a-payment");
  } finally {
    await t.end();
  }
});

test("a branch brought here through Git goes on here", async () => {
  const t = await team();
  try {
    const a = await t.computer("a");
    const b = await t.computer("b");
    await a.work(a.task("t1", "Show the total"));
    await a.create();
    Object.assign(b.goal, {
      branch: a.goal.branch,
      baseRevision: a.goal.baseRevision,
      baseBranch: "main",
    });
    await git(b.root, ["fetch", "origin"]);
    await git(b.root, ["branch", a.goal.branch!, `origin/${a.goal.branch}`]);
    const next = await b.work(b.task("t2", "Pay by card"));
    assert.equal(next.run.branch, a.goal.branch);
  } finally {
    await t.end();
  }
});

test("a worker that stopped early holds the branch until the person says yes", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    const one = await c.work(c.task("t1", "Show the total"));
    const two = await c.work(c.task("t2", "Pay by card"), "half-done.ts");
    two.run.state = "failed";
    assert.equal(epicReadiness(c.state.tasks, c.goal).isReady, false);
    assert.deepEqual((await c.service.plan("goal")).unfinished, [
      { identifier: "T2", title: "Pay by card", state: "failed" },
    ]);
    await assert.rejects(c.create(), /T2 has unfinished work/);
    assert.equal(
      await git(one.run.workspace!, ["log", "-1", "--format=%s"]),
      "Initial",
      "nothing was committed",
    );
    assert.equal((await c.create(true)).committed, true);
  } finally {
    await t.end();
  }
});

test("a start that was refused before a worker launched holds nothing up", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    await c.work(c.task("t1", "Show the total"));
    const two = c.task("t2", "Pay by card");
    await c.start(two);
    two.run.state = "failed";
    two.run.finishedAt = AT;
    const readiness = epicReadiness(c.state.tasks, c.goal);
    assert.equal(readiness.isReady, true);
    assert.equal(readiness.waiting, 1);
    assert.deepEqual((await c.service.plan("goal")).unfinished, []);
    two.run.changeRunId = "run-t2";
    assert.equal(epicReadiness(c.state.tasks, c.goal).unfinished, 1, "a worker did run");
  } finally {
    await t.end();
  }
});

test("work on a task that shipped opens its closed goal again, on a new branch", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    const one = await c.work(c.task("t1", "Show the total"));
    await c.create();
    const { branch } = await t.merge(c);
    assert.ok(c.goal.closedAt);
    await c.work(one, "fix.ts");
    assert.equal(c.goal.closedAt, undefined);
    assert.notEqual(one.run.branch, branch);
  } finally {
    await t.end();
  }
});

test("tasks started at the same moment begin one branch together", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    await c.work(c.task("t1", "Show the total"));
    await c.create();
    const two = c.task("t2", "Pay by card"),
      three = c.task("t3", "Send a receipt");
    await t.merge(c);
    await Promise.all([c.work(two), c.work(three)]);
    assert.equal(two.run.branch, three.run.branch);
  } finally {
    await t.end();
  }
});

test("quick changes nobody started go on to the next batch", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    const one = await c.work(c.task("q1", "Fix a typo", null));
    const batch = c.state.epics.find((epic) => epic.id === one.epicId)!;
    const two = c.task("q2", "Rename a setting", batch.id);
    // Someone works on it elsewhere, as a tracker says.
    const three = Object.assign(c.task("q3", "Fix a link", batch.id), { stage: "working" });
    shipBranch(c.state, batch, batch.branch!, AT);
    assert.ok(batch.closedAt);
    assert.equal(one.stage, "done");
    assert.notEqual(two.epicId, batch.id);
    assert.notEqual(three.epicId, batch.id);
    assert.equal(three.stage, "working");
  } finally {
    await t.end();
  }
});

test("tidying up a shipped branch leaves the goal's new one alone", async () => {
  const t = await team();
  try {
    const c = await t.computer("a");
    const one = await c.work(c.task("t1", "Show the total"));
    const two = c.task("t2", "Pay by card");
    await c.create();
    const { branch } = await t.merge(c);
    await c.work(two);
    two.run.state = "running";
    const counts = { episodes: 1, fleet_records: 1, nodes: 1, edges: 1 };
    const outcome = await retireShippedGoal(
      c.state,
      { ...c.goal, branch },
      "main",
      { dataDir: c.data, releaseGoalEngine: async () => {}, importHistory: async () => counts },
    );
    assert.equal(outcome.kind, "removed", "a worker on the new branch does not keep the old one");
    const left = await git(c.root, ["worktree", "list"]);
    assert.ok(left.includes("feat/pay-by-card"));
    assert.ok(!left.includes(`[${branch}]`));
    assert.ok(one.run.workspace);
  } finally {
    await t.end();
  }
});
