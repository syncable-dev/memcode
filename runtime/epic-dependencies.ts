import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppState, WorkItem } from "../src/shared";
import { pendingPrerequisites, stageLabel } from "../src/domain";
import { taskStatus, workflowFor } from "../src/planning/workflow";
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
      throw Error("A prerequisite source resolves outside the goal checkout.");
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

export function assertPrerequisitesComplete(state: AppState, task: WorkItem): void {
  const pending = pendingPrerequisites(task, state.tasks);
  if (!pending.length) return;
  const workflow = workflowFor(state, task.projectId);
  const blockers = pending.map(({ story }) =>
    story
      ? `${story.identifier} · ${story.title} (${taskStatus(story, workflow)?.name ?? stageLabel(story.stage)})`
      : "a task that is no longer available",
  );
  throw Error(`Waiting for ${blockers.join(", ")}. Review this task’s prerequisites before starting.`);
}

/** Done is a planning state. Across epics, verify the actual prerequisite code. */
export async function assertEpicDependencies(
  state: AppState,
  task: WorkItem,
  workspace: string,
): Promise<void> {
  if (!task.dependsOn?.length) return;
  const root = await realpath(workspace);
  assertPrerequisitesComplete(state, task);
  const dependencies = state.tasks.filter(
    (item) => item.projectId === task.projectId && task.dependsOn?.includes(item.id),
  );
  for (const dependency of dependencies) {
    if (dependency.epicId === task.epicId || dependency.kind === "research")
      continue;
    const changes = await readWorkerChanges(dependency);
    // Done in the tracker by someone who never worked on it here: the repository has it
    // or not, and nothing here can tell. The worker reads the code that is there.
    if (dependency.tracker && !dependency.run.startedAt && !changes.checkpoints.length)
      continue;
    if (!changes.checkpoints.length)
      throw Error(
        `${dependency.identifier} is Done, but its source handoff has not been verified. Integrate and review its changes before starting this dependent goal.`,
      );
    const expected = new Map<string, string | undefined>();
    for (const checkpoint of changes.checkpoints)
      for (const file of checkpoint.files)
        expected.set(file.path, file.afterHash);
    for (const [path, hash] of expected) {
      if ((await contentHash(root, path)) !== hash)
        throw Error(
          `${dependency.identifier}'s change to ${path} is not present in this goal. Integrate that prerequisite through Git, then retry. No worker was started.`,
        );
    }
  }
}
