import { join } from "node:path";
import type { WorkItem } from "../src/shared";

type TaskRecords = Pick<WorkItem, "id" | "run">;

/**
 * Where a task's worker records live: its change journal, the documents its
 * worker made, and its Fleet activity. They sit in the task's goal checkout.
 */
export function workerRecordsFolder(task: TaskRecords): string | undefined {
  return task.run.workspace
    ? join(task.run.workspace, ".memcode", "workers", task.id)
    : undefined;
}

/** The folder a task's records must resolve inside. */
export function workerRecordsBoundary(task: TaskRecords): string | undefined {
  return task.run.workspace;
}
