import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import type { AppState, Epic, WorkItem } from "../src/shared";
import { git } from "../runtime/local";
import {
  retireShippedGoal,
  type GoalHistoryRequest,
  type HistoryCounts,
} from "../runtime/shipped-goal";

const COUNTS: HistoryCounts = { episodes: 3, fleet_records: 1, nodes: 5, edges: 2 };

async function shippedGoal(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "memcode-shipped-goal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const checkout = join(root, "data", "epic-checkouts", "goal-1");
  await mkdir(project, { recursive: true });
  await git(project, ["init", "--initial-branch=dev"]);
  await git(project, ["-c", "user.email=a@b.c", "-c", "user.name=A", "commit", "--allow-empty", "-m", "start"]);
  await git(project, ["worktree", "add", "-b", "feat/export", checkout]);
  await mkdir(join(checkout, ".memcode", "workers", "task-1"), { recursive: true });
  await writeFile(join(checkout, ".memcode", "workers", "task-1", "fleet-activity.jsonl"), "{}\n");
  await mkdir(join(checkout, ".memcode", "memtrace", ".memdb"), { recursive: true });
  await writeFile(join(checkout, ".memcode", "memtrace", ".memdb", "store"), "goal store");
  await writeFile(join(project, ".git", "info", "exclude"), ".memcode/\n");
  const seed = initialState();
  const goal: Epic = { ...seed.epics[0], id: "goal-1", projectId: "p1", branch: "feat/export", closedAt: "2026-11-23T10:00:00Z" };
  const task: WorkItem = {
    ...seed.tasks[0],
    id: "task-1",
    epicId: goal.id,
    projectId: "p1",
    stage: "done",
    run: { ...seed.tasks[0].run, state: "idle", workspace: checkout, branch: "feat/export" },
  };
  const state = {
    ...seed,
    projects: [{ ...seed.projects[0], id: "p1", path: project, example: false, repoId: "project" }],
    epics: [goal],
    tasks: [task],
    artifacts: [],
  } as AppState;
  const calls: GoalHistoryRequest[] = [];
  let released = 0;
  const deps = {
    dataDir: join(root, "data"),
    releaseGoalEngine: async () => void released++,
    importHistory: async (request: GoalHistoryRequest) => {
      calls.push(request);
      return COUNTS;
    },
  };
  return { project, checkout, goal, task, state, deps, calls, released: () => released };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

test("a shipped goal's history is imported, its records kept, then its checkout removed", async (t) => {
  const goal = await shippedGoal(t);

  const outcome = await retireShippedGoal(goal.state, goal.goal, "dev", goal.deps);

  assert.deepEqual(outcome, { kind: "removed", imported: COUNTS });
  assert.equal(goal.released(), 1);
  assert.deepEqual(goal.calls.map((call) => call.dry_run), [true, false]);
  assert.equal(goal.calls[1].goal_store, join(goal.checkout, ".memcode", "memtrace", ".memdb"));
  assert.equal(goal.calls[1].merged_into, "dev");
  assert.equal(goal.calls[1].repo_id, "project");
  assert.equal(await exists(goal.checkout), false);
  assert.ok(await exists(join(goal.task.run.records!, "fleet-activity.jsonl")));
  assert.match(await git(goal.project, ["branch", "--list", "feat/export"]), /feat\/export/);
});

test("a checkout is removed even when its engine cache has paths longer than Windows' 260 characters", async (t) => {
  const goal = await shippedGoal(t);
  // The engine names graph-cache files r<64 hex>__<65 hex>.<kind>. Inside
  // %APPDATA%\MemCode\epic-checkouts\<id> that passes 260 characters, which
  // plain `git worktree remove` cannot delete on Windows.
  const cache = join(goal.checkout, ".memcode", "memtrace", ".memdb", "graph-cache");
  const name = `r${"a".repeat(64)}__${"b".repeat(65)}.picture-generation`;
  const padding = "p".repeat(Math.max(0, 261 - join(cache, name).length));
  await mkdir(join(cache, padding || "."), { recursive: true });
  const longPath = join(cache, padding || ".", name);
  await writeFile(longPath, "cache");
  assert.ok(longPath.length > 260);

  const outcome = await retireShippedGoal(goal.state, goal.goal, "dev", goal.deps);

  assert.deepEqual(outcome, { kind: "removed", imported: COUNTS });
  assert.equal(await exists(goal.checkout), false);
});

test("a checkout with work that isn't committed stays, and nothing is imported", async (t) => {
  const goal = await shippedGoal(t);
  await writeFile(join(goal.checkout, "draft.ts"), "export const draft = 1;\n");

  const outcome = await retireShippedGoal(goal.state, goal.goal, "dev", goal.deps);

  assert.equal(outcome.kind, "kept");
  assert.match((outcome as { reason: string }).reason, /not committed/);
  assert.equal(goal.calls.length, 0);
  assert.ok(await exists(goal.checkout));
});

test("a checkout stays when the import doesn't match its dry run", async (t) => {
  const goal = await shippedGoal(t);
  let call = 0;
  goal.deps.importHistory = async () => (call++ === 0 ? COUNTS : { ...COUNTS, nodes: 4 });

  const outcome = await retireShippedGoal(goal.state, goal.goal, "dev", goal.deps);

  assert.equal(outcome.kind, "kept");
  assert.match((outcome as { reason: string }).reason, /didn't match/);
  assert.ok(await exists(goal.checkout));
  assert.equal(goal.task.run.records, undefined);
});

test("a checkout stays when the engine can't import goal history yet", async (t) => {
  const goal = await shippedGoal(t);
  goal.deps.importHistory = async () => {
    throw Error("MCP error -32601: tool not found: import_goal_history");
  };

  const outcome = await retireShippedGoal(goal.state, goal.goal, "dev", goal.deps);

  assert.equal(outcome.kind, "kept");
  assert.match((outcome as { reason: string }).reason, /can't import/);
  assert.ok(await exists(goal.checkout));
});

test("a checkout stays while one of its workers is running", async (t) => {
  const goal = await shippedGoal(t);
  goal.task.run.state = "running";

  const outcome = await retireShippedGoal(goal.state, goal.goal, "dev", goal.deps);

  assert.equal(outcome.kind, "kept");
  assert.equal(goal.calls.length, 0);
});

test("a goal that worked in the project folder itself has no checkout to remove", async (t) => {
  const goal = await shippedGoal(t);
  goal.task.run.workspace = goal.project;

  const outcome = await retireShippedGoal(goal.state, goal.goal, "dev", goal.deps);

  assert.equal(outcome.kind, "kept");
  assert.ok(await exists(goal.project));
  assert.equal(goal.calls.length, 0);
});
