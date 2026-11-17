import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppState, WorkItem } from "../src/shared";
import { readWorkerChanges } from "./changes";
import { within } from "./local";

async function contentHash(
  root: string,
  path: string,
): Promise<string | undefined> {
  const candidate = resolve(root, path);
  if (!within(root, candidate))
    throw Error("A prerequisite has an invalid source path.");
  try {
    const actual = await realpath(candidate);
    if (!within(root, actual))
      throw Error("A prerequisite source resolves outside the epic checkout.");
    const file = await open(actual, "r");
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 2_000_000)
        throw Error(
          "A prerequisite source is too large to verify automatically.",
        );
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > 2_000_000)
          throw Error("A prerequisite source changed during verification.");
        hash.update(chunk);
      }
      const after = await file.stat();
      if (
        before.size !== size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw Error("A prerequisite source changed during verification.");
      return hash.digest("hex");
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Done is a planning state. Across epics, verify the actual prerequisite code. */
export async function assertEpicDependencies(
  state: AppState,
  task: WorkItem,
  workspace: string,
): Promise<void> {
  if (!task.dependsOn?.length) return;
  const root = await realpath(workspace);
  for (const id of task.dependsOn ?? []) {
    const dependency = state.tasks.find(
      (item) => item.id === id && item.projectId === task.projectId,
    );
    if (!dependency || dependency.stage !== "done")
      throw Error(
        "Complete the prerequisite stories before starting this worker.",
      );
    if (dependency.epicId === task.epicId || dependency.kind === "research")
      continue;
    const changes = await readWorkerChanges(dependency);
    if (!changes.checkpoints.length)
      throw Error(
        `${dependency.identifier} is Done, but its source handoff has not been verified. Integrate and review its changes before starting this dependent epic.`,
      );
    const expected = new Map<string, string | undefined>();
    for (const checkpoint of changes.checkpoints)
      for (const file of checkpoint.files)
        expected.set(file.path, file.afterHash);
    for (const [path, hash] of expected) {
      if ((await contentHash(root, path)) !== hash)
        throw Error(
          `${dependency.identifier}'s change to ${path} is not present in this epic. Integrate that prerequisite through Git, then retry. No worker was started.`,
        );
    }
  }
}
