import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../runtime/local.ts";
import {
  detectBranchStrategy,
  inferBranchStrategy,
  goalBranchName,
  integrationCommit,
  quickChangesBranchName,
} from "../runtime/branch-strategy.ts";

test("a dev-first flow sends stories to dev and keeps the team's prefixes", () => {
  const strategy = inferBranchStrategy({
    defaultBranch: "main",
    branches: ["main", "dev", "staging", "release/beta18", "feat/a", "fix/b"],
    merged: [
      { base: "dev", head: "feat/shared-sessions" },
      { base: "dev", head: "fix/approval-stall" },
      { base: "dev", head: "feat/review-lane" },
      { base: "main", head: "release/beta18" },
      { base: "staging", head: "dev" },
    ],
  });
  assert.equal(strategy.base, "dev");
  assert.equal(strategy.featurePrefix, "feat/");
  assert.equal(strategy.fixPrefix, "fix/");
});

test("a trunk-based repository branches from main with its own feature prefix", () => {
  const strategy = inferBranchStrategy({
    defaultBranch: "main",
    branches: ["main"],
    merged: [
      { base: "main", head: "feature/login" },
      { base: "main", head: "feature/billing" },
      { base: "main", head: "bugfix/rounding" },
    ],
  });
  assert.equal(strategy.base, "main");
  assert.equal(strategy.featurePrefix, "feature/");
  assert.equal(strategy.fixPrefix, "bugfix/");
});

test("without merge history, an integration branch beats the default branch", () => {
  assert.equal(
    inferBranchStrategy({ defaultBranch: "main", branches: ["main", "develop"], merged: [] }).base,
    "develop",
  );
  assert.equal(
    inferBranchStrategy({ defaultBranch: "trunk", branches: ["trunk"], merged: [] }).base,
    "trunk",
  );
  const empty = inferBranchStrategy({ branches: [], merged: [] });
  assert.equal(empty.base, "main");
  assert.equal(empty.featurePrefix, "feat/");
  assert.equal(empty.fixPrefix, "fix/");
});

test("MemCode's own epic branches never teach the naming convention", () => {
  const strategy = inferBranchStrategy({
    branches: ["main"],
    merged: [
      { base: "main", head: "epic/ep-01-abc" },
      { base: "main", head: "epic/ep-02-def" },
      { base: "main", head: "feature/x" },
    ],
  });
  assert.equal(strategy.featurePrefix, "feature/");
});

test("a goal branch reads like the team named it", () => {
  const strategy = { base: "dev", featurePrefix: "feat/", fixPrefix: "fix/" };
  assert.equal(
    goalBranchName(strategy, "Keep people signed in across deploys!"),
    "feat/keep-people-signed-in-across-deploys",
  );
  const long = goalBranchName(strategy, "A ".repeat(80) + "title");
  assert.ok(long.length <= 60, long);
  assert.doesNotMatch(long, /-$/);
  assert.equal(
    quickChangesBranchName(strategy, new Date("2026-11-20T10:00:00Z")),
    "feat/quick-changes-2026-11-20",
  );
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "memcode-branch-strategy-"));
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
  await git(repo, ["remote", "add", "origin", remote]);
  await writeFile(join(repo, "app.ts"), "export const v = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "Initial"]);
  await git(repo, ["push", "-u", "origin", "main"]);
  await git(repo, ["switch", "-c", "dev"]);
  await git(repo, ["switch", "-c", "feature/login"]);
  await writeFile(join(repo, "login.ts"), "export const login = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "Login"]);
  await git(repo, ["switch", "dev"]);
  await git(repo, ["merge", "--no-ff", "feature/login", "-m", "Merge branch 'feature/login' into dev"]);
  await git(repo, ["push", "-u", "origin", "dev"]);
  await git(repo, ["remote", "set-head", "origin", "main"]);
  return { root, remote, repo };
}

test("the strategy is read from the remote's merge history", async () => {
  const r = await repository();
  try {
    await git(r.repo, ["switch", "main"]);
    const strategy = await detectBranchStrategy(r.repo, async () => null);
    assert.equal(strategy.remote, "origin");
    assert.equal(strategy.base, "dev");
    assert.equal(strategy.featurePrefix, "feature/");
  } finally {
    await rm(r.root, { recursive: true, force: true });
  }
});

test("new work starts from the integration branch as the remote has it", async () => {
  const r = await repository();
  try {
    const other = join(r.root, "other");
    await git(r.root, ["clone", "--branch", "dev", r.remote, other]);
    await git(other, ["config", "user.name", "Other"]);
    await git(other, ["config", "user.email", "other@example.test"]);
    await writeFile(join(other, "news.ts"), "export const news = 1;\n");
    await git(other, ["add", "-A"]);
    await git(other, ["commit", "-m", "Teammate work"]);
    await git(other, ["push", "origin", "dev"]);
    await git(r.repo, ["switch", "main"]);
    const commit = await integrationCommit(r.repo, {
      base: "dev",
      remote: "origin",
      featurePrefix: "feat/",
      fixPrefix: "fix/",
    });
    assert.equal(commit, await git(other, ["rev-parse", "HEAD"]));
  } finally {
    await rm(r.root, { recursive: true, force: true });
  }
});

test("without a remote, new work starts from the local integration branch", async () => {
  const r = await repository();
  try {
    await git(r.repo, ["remote", "remove", "origin"]);
    await git(r.repo, ["switch", "main"]);
    const strategy = await detectBranchStrategy(r.repo, async () => null);
    assert.equal(strategy.remote, undefined);
    assert.equal(strategy.base, "dev");
    assert.equal(
      await integrationCommit(r.repo, strategy),
      await git(r.repo, ["rev-parse", "dev"]),
    );
  } finally {
    await rm(r.root, { recursive: true, force: true });
  }
});
