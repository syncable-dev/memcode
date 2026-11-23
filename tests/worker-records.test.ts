import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import type { WorkItem } from "../src/shared";
import { WorkerChangeJournal, readWorkerChanges } from "../runtime/changes";
import { git } from "../runtime/local";
import { keepWorkerRecords, workerRecordsFolder } from "../runtime/worker-records";

async function shippedGoal(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "memcode-worker-records-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const dataDir = join(root, "data");
  await mkdir(checkout);
  await git(checkout, ["init", "--initial-branch=main"]);
  const state = initialState();
  const project = { ...state.projects[0], path: checkout, example: false };
  const task: WorkItem = {
    ...state.tasks[0],
    id: "export-report",
    scope: ["report.ts"],
    run: { ...state.tasks[0].run, branch: "main", workspace: checkout },
  };
  const journal = new WorkerChangeJournal();
  await journal.begin(project, task);
  await writeFile(join(checkout, "report.ts"), "export const report = 1;\n");
  await journal.release(project, task);
  const documents = join(workerRecordsFolder(task)!, "artifacts");
  await mkdir(documents, { recursive: true });
  await writeFile(join(documents, "summary.md"), "# Export\n");
  const artifact = {
    ...state.artifacts[0],
    id: "summary",
    taskId: task.id,
    path: join(documents, "summary.md"),
  };
  return { checkout, dataDir, state: { tasks: [task], artifacts: [artifact] }, task };
}

test("a shipped goal's task records outlive its checkout", async (t) => {
  const goal = await shippedGoal(t);

  await keepWorkerRecords(goal.dataDir, goal.state, [goal.task]);
  await rm(goal.checkout, { recursive: true, force: true });

  const changes = await readWorkerChanges(goal.task);
  assert.deepEqual(changes.checkpoints[0].files.map((file) => file.path), ["report.ts"]);
  assert.equal(await readFile(goal.state.artifacts[0].path, "utf8"), "# Export\n");
});

test("kept records live in MemCode's data folder and the task says where", async (t) => {
  const goal = await shippedGoal(t);

  const kept = await keepWorkerRecords(goal.dataDir, goal.state, [goal.task]);

  assert.equal(kept, 1);
  assert.equal(goal.task.run.records, join(goal.dataDir, "goal-records", "export-report"));
  assert.equal(workerRecordsFolder(goal.task), goal.task.run.records);
  assert.equal(goal.state.artifacts[0].path, join(goal.task.run.records!, "artifacts", "summary.md"));
});

test("keeping records twice moves nothing the second time", async (t) => {
  const goal = await shippedGoal(t);
  await keepWorkerRecords(goal.dataDir, goal.state, [goal.task]);

  const keptAgain = await keepWorkerRecords(goal.dataDir, goal.state, [goal.task]);

  assert.equal(keptAgain, 0);
  assert.equal((await readWorkerChanges(goal.task)).checkpoints.length, 1);
});

test("a task id that could leave the records folder is refused", async (t) => {
  const goal = await shippedGoal(t);
  goal.task.id = "..";

  await assert.rejects(keepWorkerRecords(goal.dataDir, goal.state, [goal.task]), /task id/);
});
