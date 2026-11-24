import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { AppState, WorkItem } from "../src/shared";
import { within } from "./local";

type TaskRecords = Pick<WorkItem, "id" | "run">;

/**
 * Where a task's worker records live: its change journal, the documents its
 * worker made, and its Fleet activity. They sit in the task's goal checkout
 * until the goal ships, then in MemCode's data folder (`run.records`).
 */
export function workerRecordsFolder(task: TaskRecords): string | undefined {
  if (task.run.records) return task.run.records;
  return task.run.workspace
    ? join(task.run.workspace, ".memcode", "workers", task.id)
    : undefined;
}

/** The folder a task's records must resolve inside. */
export function workerRecordsBoundary(task: TaskRecords): string | undefined {
  return task.run.records ?? task.run.workspace;
}

const SAFE_TASK_ID = /^[a-zA-Z0-9_.-]+$/;

/**
 * Move a shipped goal's task records out of its checkout into MemCode's data
 * folder, so its Changes, review and documents outlive the checkout. Points
 * each task and its documents at the new place. Returns how many tasks moved.
 */
export async function keepWorkerRecords(
  dataDir: string,
  state: Pick<AppState, "artifacts">,
  tasks: WorkItem[],
): Promise<number> {
  let kept = 0;
  for (const task of tasks) {
    if (task.run.records || !task.run.workspace) continue;
    if (!SAFE_TASK_ID.test(task.id) || task.id === "." || task.id === "..")
      throw Error(`The task id ${task.id} cannot name a records folder.`);
    const from = workerRecordsFolder(task)!;
    const to = join(dataDir, "goal-records", task.id);
    await moveFolder(from, to);
    task.run.records = to;
    pointDocumentsAt(state, task.id, from, to);
    kept++;
  }
  return kept;
}

async function moveFolder(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const exists = await stat(from).then(() => true, () => false);
  if (!exists) {
    await mkdir(to, { recursive: true });
    return;
  }
  await rename(from, to).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true });
  });
}

function pointDocumentsAt(
  state: Pick<AppState, "artifacts">,
  taskId: string,
  from: string,
  to: string,
): void {
  for (const artifact of state.artifacts)
    if (artifact.taskId === taskId && within(from, artifact.path))
      artifact.path = join(to, relative(from, artifact.path));
}
