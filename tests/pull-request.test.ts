import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../runtime/local.ts";
import {
  compareUrl,
  createPullRequestService,
  githubRepository,
} from "../runtime/pull-request.ts";
import { descriptionParts, epicReadiness } from "../src/pull-request.ts";
import type { AppState, Epic, Project, WorkItem } from "../src/shared.ts";

test("GitHub remotes are recognised in their common forms", () => {
  const expected = { owner: "acme", repo: "app" };
  assert.deepEqual(githubRepository("git@github.com:acme/app.git"), expected);
  assert.deepEqual(githubRepository("https://github.com/acme/app"), expected);
  assert.deepEqual(
    githubRepository("https://github.com/acme/app.git"),
    expected,
  );
  assert.deepEqual(
    githubRepository("ssh://git@github.com/acme/app.git"),
    expected,
  );
  assert.equal(githubRepository("git@gitlab.com:acme/app.git"), undefined);
  assert.equal(githubRepository("/srv/git/app.git"), undefined);
  assert.equal(
    githubRepository("https://github.com.evil.test/acme/app"),
    undefined,
  );
});

test("the GitHub compare page opens prefilled, without a description that is too long", () => {
  const repo = { owner: "acme", repo: "app" };
  const short = compareUrl(repo, "main", "epic/mc-12", "Tokens", "Body text");
  assert.equal(
    short.url,
    "https://github.com/acme/app/compare/main...epic/mc-12?expand=1&title=Tokens&body=Body+text",
  );
  assert.equal(short.descriptionOmitted, false);
  const long = compareUrl(repo, "main", "epic/mc-12", "Tokens", "x".repeat(9000));
  assert.equal(
    long.url,
    "https://github.com/acme/app/compare/main...epic/mc-12?expand=1&title=Tokens",
  );
  assert.equal(long.descriptionOmitted, true);
});

test("an epic is ready when every story is in review or done and none is running", () => {
  const story = (stage: WorkItem["stage"], state = "finished") =>
    ({ epicId: "e1", stage, run: { state } }) as WorkItem;
  assert.deepEqual(
    epicReadiness([story("review"), story("done"), story("planned")], "e1"),
    { total: 3, ready: 2, active: 0, isReady: false },
  );
  assert.deepEqual(epicReadiness([story("review"), story("done")], "e1"), {
    total: 2,
    ready: 2,
    active: 0,
    isReady: true,
  });
  assert.equal(
    epicReadiness([story("review", "running")], "e1").isReady,
    false,
  );
  assert.equal(epicReadiness([], "e1").isReady, false);
});

interface Fixture {
  root: string;
  repo: string;
  remote: string;
  state: AppState;
  opened: string[];
  service: ReturnType<typeof createPullRequestService>;
  ghCalls: () => Promise<string[][]>;
  /** Each shipped goal handed on to retirement, with the branch it merged into. */
  retirements: [string, string][];
}

const KEPT_REASON = "A worker is still running in this goal's checkout.";

interface FakeGitHub {
  pr: Record<string, unknown> | null;
  created?: Record<string, unknown>;
  mergeMethod?: string;
}

const fakeGitHubCli = fileURLToPath(
  new URL("./fixtures/fake-gh.mjs", import.meta.url),
);

/** Files each task changed, by task id; tasks not listed changed one unnamed file. */
const changedFiles: Record<string, string[]> = {};

async function fixture(gitHub?: FakeGitHub): Promise<Fixture> {
  for (const key of Object.keys(changedFiles)) delete changedFiles[key];
  const root = await mkdtemp(join(tmpdir(), "memcode-pr-test-"));
  const remote = join(root, "remote.git"),
    repo = join(root, "repo");
  await git(root, ["init", "--bare", "--initial-branch=main", remote]);
  await git(root, ["init", "--initial-branch=main", repo]);
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.test"],
    ["commit.gpgsign", "false"],
  ])
    await git(repo, ["config", key, value]);
  await git(repo, ["remote", "add", "origin", "git@github.com:acme/app.git"]);
  await git(repo, ["remote", "set-url", "--push", "origin", remote]);
  await writeFile(join(repo, "app.ts"), "export const version = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "Initial"]);
  await git(repo, ["push", "-u", "origin", "main"]);
  await git(repo, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  const baseRevision = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["switch", "-c", "epic/mc-12"]);
  await writeFile(join(repo, "app.ts"), "export const version = 2;\n");
  await writeFile(join(repo, "session.ts"), "export const token = 1;\n");
  const project = {
    id: "p1",
    name: "App",
    path: repo,
    branch: "epic/mc-12",
  } as Project;
  const epic = {
    id: "e1",
    projectId: "p1",
    identifier: "MC-12",
    title: "Replace cookie sessions with rotating tokens",
    branch: "epic/mc-12",
    baseRevision,
  } as Epic;
  const stories = ["mc-41", "mc-42"].map(
    (id) =>
      ({
        id,
        identifier: id.toUpperCase(),
        projectId: "p1",
        epicId: "e1",
        title: `Story ${id}`,
        harness: "claude",
        stage: "review",
        run: { state: "finished" },
      }) as WorkItem,
  );
  const state = {
    projects: [project],
    epics: [epic],
    tasks: stories,
    fleetConflicts: [],
    settings: { handoffAttribution: "include" },
  } as unknown as AppState;
  const opened: string[] = [];
  const ghState = join(root, "gh-state.json");
  await writeFile(ghState, JSON.stringify({ calls: [], ...gitHub }));
  const retirements: [string, string][] = [];
  const service = createPullRequestService({
    state: () => state,
    changed: async () => {},
    retireShippedGoal: async (goal, mergedInto) => {
      retirements.push([goal.id, mergedInto]);
      return { kind: "kept", reason: KEPT_REASON };
    },
    openUrl: async (url) => {
      opened.push(url);
    },
    findGitHubCli: async () =>
      gitHub
        ? {
            command: process.execPath,
            prefix: [fakeGitHubCli],
            env: { FAKE_GH_STATE: ghState },
          }
        : null,
    readChanges: async (task) => {
      const paths = changedFiles[task.id];
      return {
        taskId: task.id,
        checkpoints: paths
          ? ([{ files: paths.map((path) => ({ path })) }] as any)
          : [],
        files: paths?.length ?? 1,
        additions: 3,
        deletions: 1,
      };
    },
  });
  const ghCalls = async () =>
    (JSON.parse(await readFile(ghState, "utf8")) as { calls: string[][] })
      .calls;
  return { root, repo, remote, state, opened, service, ghCalls, retirements };
}

test("the plan lists what Create will do on the active epic branch", async () => {
  const f = await fixture();
  try {
    const plan = await f.service.plan("e1");
    assert.equal(plan.base, "main");
    assert.equal(plan.branch, "epic/mc-12");
    assert.equal(plan.current, true);
    assert.deepEqual([...plan.uncommitted].sort(), ["app.ts", "session.ts"]);
    assert.equal(plan.blocker, undefined);
    assert.deepEqual(plan.steps, [
      "Commit 2 files to epic/mc-12",
      "Push epic/mc-12 to origin",
      "Open the pull request on GitHub",
    ]);
    assert.equal(plan.title, "Replace cookie sessions with rotating tokens");
    assert.match(plan.description, /^## Summary\n/);
    assert.match(plan.commitMessage, /^Orchestrated-by: MemCode /m);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Create commits the epic's files, pushes the branch and opens the prefilled PR page", async () => {
  const f = await fixture();
  try {
    const plan = await f.service.plan("e1");
    const result = await f.service.create({
      epicId: "e1",
      title: "Rotate session tokens",
      description: "Edited description",
      commitMessage: "Rotate session tokens\n\nStories: MC-41, MC-42.\n",
    });
    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);
    assert.equal(result.opened, "browser");
    assert.equal(
      await git(f.repo, ["log", "-1", "--format=%s"]),
      "Rotate session tokens",
    );
    assert.equal(await git(f.repo, ["status", "--porcelain"]), "");
    assert.equal(
      await git(f.remote, ["rev-parse", "epic/mc-12"]),
      await git(f.repo, ["rev-parse", "HEAD"]),
    );
    assert.deepEqual(f.opened, [
      "https://github.com/acme/app/compare/main...epic/mc-12?expand=1&title=Rotate+session+tokens&body=Edited+description",
    ]);
    assert.deepEqual(
      f.state.pullRequests?.map((item) => [item.epicId, item.url]),
      [["e1", f.opened[0]]],
    );
    assert.ok(plan.steps.length === 3);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("running stories and open Fleet decisions block Create without touching git", async () => {
  const f = await fixture();
  try {
    f.state.tasks[0].run.state = "running";
    const running = await f.service.plan("e1");
    assert.equal(
      running.blocker,
      "Wait for 1 running task to finish, or stop it.",
    );
    await assert.rejects(
      f.service.create({
        epicId: "e1",
        title: "t",
        description: "d",
        commitMessage: "m",
      }),
      /Wait for 1 running task/,
    );
    assert.equal(await git(f.repo, ["log", "-1", "--format=%s"]), "Initial");

    f.state.tasks[0].run.state = "finished";
    f.state.fleetConflicts.push({
      id: "c1",
      projectId: "p1",
      epicId: "e1",
      branch: "epic/mc-12",
      taskIds: [],
      agentIds: [],
      scope: [],
      severity: "C",
      source: "episode",
      summary: "disagreement",
      status: "open",
      createdAt: "2026-11-20T10:00:00.000Z",
    });
    assert.equal(
      (await f.service.plan("e1")).blocker,
      "Resolve 1 open Fleet decision first.",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an epic that is not checked out skips the commit and pushes its existing commits", async () => {
  const f = await fixture();
  try {
    await git(f.repo, ["add", "-A"]);
    await git(f.repo, ["commit", "-m", "Epic work"]);
    await git(f.repo, ["switch", "main"]);
    await writeFile(join(f.repo, "other.ts"), "export {};\n");
    const plan = await f.service.plan("e1");
    assert.equal(plan.current, false);
    assert.deepEqual(plan.uncommitted, []);
    assert.equal(plan.ahead, 1);
    assert.deepEqual(plan.steps, [
      "Push epic/mc-12 to origin",
      "Open the pull request on GitHub",
    ]);
    const result = await f.service.create({
      epicId: "e1",
      title: "t",
      description: "d",
      commitMessage: "unused",
    });
    assert.equal(result.committed, false);
    assert.equal(result.pushed, true);
    assert.equal(
      await git(f.repo, ["status", "--porcelain"]),
      "?? other.ts",
      "another branch's work in the checkout is left alone",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an epic with no work yet explains why there is nothing to open", async () => {
  const f = await fixture();
  try {
    await git(f.repo, ["stash", "--include-untracked"]);
    const plan = await f.service.plan("e1");
    assert.equal(plan.blocker, "There are no changes on epic/mc-12 yet.");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a project without a remote commits and says how to continue", async () => {
  const f = await fixture();
  try {
    await git(f.repo, ["remote", "remove", "origin"]);
    const plan = await f.service.plan("e1");
    assert.deepEqual(plan.steps, ["Commit 2 files to epic/mc-12"]);
    assert.match(plan.notice ?? "", /no remote/i);
    const result = await f.service.create({
      epicId: "e1",
      title: "t",
      description: "d",
      commitMessage: "Commit only",
    });
    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.equal(result.opened, "none");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a recorded pull request reopens from the epic, and an unopened one explains itself", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.openExisting("e1"),
      /no pull request yet/i,
    );
    await f.service.create({
      epicId: "e1",
      title: "Tokens",
      description: "d",
      commitMessage: "Tokens",
    });
    await f.service.openExisting("e1");
    assert.equal(f.opened.length, 2);
    assert.equal(f.opened[1], f.opened[0]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the preview folds the receipt the way GitHub renders <details>", () => {
  assert.deepEqual(
    descriptionParts(
      "## Summary\n\nText\n\n<details>\n<summary>Fleet receipt · 2 stories</summary>\n\n| a |\n\n</details>\n",
    ),
    [
      { kind: "markdown", text: "## Summary\n\nText\n\n" },
      { kind: "details", summary: "Fleet receipt · 2 stories", text: "| a |" },
    ],
  );
  assert.deepEqual(descriptionParts("Plain"), [
    { kind: "markdown", text: "Plain" },
  ]);
});

const openPullRequest = {
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { state: "SUCCESS" },
  ],
};

test("with the GitHub CLI, Create opens the pull request directly and remembers it", async () => {
  const f = await fixture({ pr: null, created: openPullRequest });
  try {
    const result = await f.service.create({
      epicId: "e1",
      title: "Tokens",
      description: "Body",
      commitMessage: "Tokens",
    });
    assert.equal(result.opened, "created");
    assert.deepEqual(
      f.state.pullRequests?.map((item) => [item.url, item.number, item.state]),
      [["https://github.com/acme/app/pull/42", 42, "open"]],
    );
    assert.deepEqual(f.opened, [], "a created PR is linked, not forced open");
    const create = (await f.ghCalls()).find((call) => call[1] === "create");
    assert.deepEqual(create?.slice(0, 6), [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "epic/mc-12",
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an approved pull request with green checks merges the repo's way and finishes its stories", async () => {
  const f = await fixture({ pr: openPullRequest, mergeMethod: "SQUASH" });
  try {
    f.state.pullRequests = [
      {
        epicId: "e1",
        branch: "epic/mc-12",
        base: "main",
        url: openPullRequest.url,
        number: 42,
        state: "open",
        createdAt: "2026-11-20T10:00:00.000Z",
        updatedAt: "2026-11-20T10:00:00.000Z",
      },
    ];
    const plan = await f.service.plan("e1");
    assert.deepEqual(plan.status, {
      number: 42,
      url: openPullRequest.url,
      state: "open",
      draft: false,
      review: "approved",
      checks: "passing",
      mergeMethod: "squash",
    });
    const merged = await f.service.merge("e1");
    assert.equal(merged.completedStories, 2);
    const merge = (await f.ghCalls()).find((call) => call[1] === "merge");
    assert.deepEqual(merge, ["pr", "merge", "42", "--squash"]);
    assert.equal(f.state.pullRequests?.[0].state, "merged");
    assert.ok(f.state.pullRequests?.[0].mergedAt);
    assert.deepEqual(
      f.state.tasks.map((task) => task.stage),
      ["done", "done"],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a merged goal's checkout is retired, and a reason to keep it is saved on the goal", async () => {
  const f = await fixture({ pr: openPullRequest, mergeMethod: "SQUASH" });
  try {
    f.state.pullRequests = [
      {
        epicId: "e1",
        branch: "epic/mc-12",
        base: "main",
        url: openPullRequest.url,
        number: 42,
        state: "open",
        createdAt: "2026-11-20T10:00:00.000Z",
        updatedAt: "2026-11-20T10:00:00.000Z",
      },
    ];
    await f.service.merge("e1");
    const goal = f.state.epics.find((epic) => epic.id === "e1")!;
    for (let wait = 0; wait < 50 && !goal.checkoutKept; wait++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(f.retirements, [["e1", "main"]]);
    assert.equal(goal.checkoutKept, KEPT_REASON);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a pull request that GitHub would not merge explains why and is left alone", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }, /Checks are failing on GitHub/],
    [{ statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] }, /Checks are still running/],
    [{ reviewDecision: "CHANGES_REQUESTED" }, /A reviewer requested changes/],
    [{ reviewDecision: "REVIEW_REQUIRED" }, /Waiting for an approving review/],
    [{ mergeStateStatus: "DIRTY" }, /merge conflicts with main/],
    [{ mergeStateStatus: "BEHIND" }, /behind main/],
    [{ isDraft: true }, /still a draft/],
  ];
  for (const [override, reason] of cases) {
    const f = await fixture({
      pr: { ...openPullRequest, ...override },
      mergeMethod: "MERGE",
    });
    try {
      f.state.pullRequests = [
        {
          epicId: "e1",
          branch: "epic/mc-12",
          base: "main",
          url: openPullRequest.url,
          number: 42,
          state: "open",
          createdAt: "",
          updatedAt: "",
        },
      ];
      const plan = await f.service.plan("e1");
      assert.match(plan.status?.mergeBlocker ?? "", reason);
      await assert.rejects(f.service.merge("e1"), reason);
      assert.ok(
        !(await f.ghCalls()).some((call) => call[1] === "merge"),
        "nothing was merged",
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test("without the GitHub CLI, Merge says what it needs", async () => {
  const f = await fixture();
  try {
    f.state.pullRequests = [
      {
        epicId: "e1",
        branch: "epic/mc-12",
        base: "main",
        url: "https://github.com/acme/app/compare/main...epic/mc-12",
        createdAt: "",
        updatedAt: "",
      },
    ];
    const plan = await f.service.plan("e1");
    assert.equal(plan.status, undefined);
    await assert.rejects(f.service.merge("e1"), /GitHub CLI/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("when a goal merges, open goals that use the same files and the open Quick changes batch are told to update", async () => {
  const f = await fixture({ pr: openPullRequest, mergeMethod: "MERGE" });
  try {
    f.state.pullRequests = [
      {
        epicId: "e1",
        branch: "epic/mc-12",
        base: "main",
        url: openPullRequest.url,
        number: 42,
        state: "open",
        createdAt: "",
        updatedAt: "",
      },
    ];
    const goal = (id: string, extra: Partial<Epic> = {}) =>
      ({
        id,
        projectId: "p1",
        identifier: id.toUpperCase(),
        title: `Goal ${id}`,
        description: "",
        phase: "now",
        color: "mint",
        order: 2,
        ...extra,
      }) as Epic;
    const task = (id: string, epicId: string) =>
      ({
        id,
        identifier: id.toUpperCase(),
        projectId: "p1",
        epicId,
        title: id,
        harness: "codex",
        stage: "working",
        run: { state: "finished" },
      }) as WorkItem;
    f.state.epics.push(
      goal("overlapping"),
      goal("separate"),
      goal("batch", { sourceKey: "quick-changes", title: "Quick changes" }),
      goal("shipped", { closedAt: "2026-11-01T00:00:00.000Z" }),
    );
    f.state.tasks.push(
      task("o1", "overlapping"),
      task("s1", "separate"),
      task("b1", "batch"),
      task("x1", "shipped"),
    );
    changedFiles["mc-41"] = ["src/auth/session.ts", "src/api/refresh.ts"];
    changedFiles["mc-42"] = ["src/api/refresh.ts"];
    changedFiles["o1"] = ["src/auth/session.ts", "src/ui/banner.ts"];
    changedFiles["s1"] = ["src/reports/export.ts"];
    changedFiles["b1"] = ["README.md"];
    changedFiles["x1"] = ["src/api/refresh.ts"];
    await f.service.merge("e1");
    const epic = (id: string) => f.state.epics.find((item) => item.id === id)!;
    assert.ok(epic("e1").closedAt, "the merged goal is closed");
    assert.deepEqual(epic("overlapping").updateNeeded?.files, ["src/auth/session.ts"]);
    assert.match(
      epic("overlapping").updateNeeded?.reason ?? "",
      /Replace cookie sessions with rotating tokens” merged and changed 1 file this goal uses/,
    );
    assert.equal(epic("separate").updateNeeded, undefined);
    assert.match(epic("batch").updateNeeded?.reason ?? "", /main changed/);
    assert.equal(epic("shipped").updateNeeded, undefined, "closed goals are left alone");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
