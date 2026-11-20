import { z } from "zod";
import type { AppState, Epic, WorkItem } from "../src/shared";
import type { WorkerChanges } from "../src/changes";
import { isActive, isQuickChanges } from "../src/domain";
import {
  detectBranchStrategy,
  integrationCommit,
  primaryRemote,
} from "./branch-strategy";
import { git, now } from "./local";

type ReadChanges = (task: WorkItem) => Promise<WorkerChanges>;
type Register = (
  method: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;

export interface GoalUpdateDependencies {
  state: () => AppState;
  changed: () => Promise<void>;
  /** Re-verifies the goal's code graph after its branch moved (about a minute). */
  refreshGraph?: (epicId: string) => Promise<void>;
}
export interface GoalUpdateResult {
  merged: boolean;
  savedWork: boolean;
  conflicts?: string[];
}

export function registerGoalUpdates(register: Register, updates: GoalUpdates) {
  register(
    "epic:update-from-base",
    z.object({ epicId: z.string().min(1).max(200) }).strict(),
    (input) => updates.updateFromBase(input.epicId),
  );
}

/** Brings a goal up to date with its integration branch, only when the person asks. */
export class GoalUpdates {
  constructor(private deps: GoalUpdateDependencies) {}

  async updateFromBase(epicId: string): Promise<GoalUpdateResult> {
    const { epic, worktree } = this.target(epicId);
    const base = epic.baseBranch ?? (await detectBranchStrategy(worktree)).base;
    const target = await integrationCommit(worktree, {
      base,
      remote: await primaryRemote(worktree),
      featurePrefix: "",
      fixPrefix: "",
    });
    if (await contains(worktree, target)) {
      delete epic.updateNeeded;
      await this.deps.changed();
      return { merged: false, savedWork: false };
    }
    const savedWork = await saveWork(worktree, base);
    const conflicts = await mergeOrUndo(worktree, target, base);
    if (conflicts.length) {
      await this.deps.changed();
      return { merged: false, savedWork, conflicts };
    }
    epic.baseRevision = target;
    delete epic.updateNeeded;
    await this.deps.changed();
    void this.deps.refreshGraph?.(epicId).catch(() => {});
    return { merged: true, savedWork };
  }

  private target(epicId: string): { epic: Epic; worktree: string } {
    const state = this.deps.state();
    const epic = state.epics.find((item) => item.id === epicId);
    if (!epic) throw new Error("Goal not found.");
    if (epic.closedAt) throw new Error("This goal already shipped.");
    const tasks = state.tasks.filter((task) => task.epicId === epicId);
    const running = tasks.filter(isActive).length;
    if (running)
      throw new Error(
        running === 1
          ? "Wait for 1 running task to finish, or stop it."
          : `Wait for ${running} running tasks to finish, or stop them.`,
      );
    const worktree = tasks.find((task) => task.run.workspace)?.run.workspace;
    if (!worktree)
      throw new Error(
        "No task in this goal has run yet, so there is nothing to update.",
      );
    return { epic, worktree };
  }
}

async function contains(cwd: string, commit: string): Promise<boolean> {
  return git(cwd, ["merge-base", "--is-ancestor", commit, "HEAD"]).then(
    () => true,
    () => false,
  );
}

/** Agents leave work uncommitted; it is saved on the goal's own branch first. */
async function saveWork(cwd: string, base: string): Promise<boolean> {
  if (!(await git(cwd, ["status", "--porcelain"]))) return false;
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", `Save goal work before updating from ${base}`]);
  return true;
}

/** A conflicting merge is aborted in full; the caller gets the conflicting files. */
async function mergeOrUndo(
  cwd: string,
  target: string,
  base: string,
): Promise<string[]> {
  try {
    await git(cwd, ["merge", "--no-edit", "-m", `Update from ${base}`, target]);
    return [];
  } catch (error) {
    const conflicts = (
      await git(cwd, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")
    )
      .split("\n")
      .filter(Boolean);
    await git(cwd, ["merge", "--abort"]).catch(() => undefined);
    if (!conflicts.length) throw error;
    return conflicts;
  }
}

/** The files a goal's tasks changed or declared, from checkpoints and scope. */
export async function goalFiles(
  state: Pick<AppState, "tasks">,
  epicId: string,
  readChanges: ReadChanges,
): Promise<Set<string>> {
  const tasks = state.tasks.filter((task) => task.epicId === epicId);
  const changed = await Promise.all(tasks.map((task) => readChanges(task)));
  return new Set([
    ...changed.flatMap((item) =>
      item.checkpoints.flatMap((checkpoint) =>
        checkpoint.files.map((file) => file.path),
      ),
    ),
    ...tasks.flatMap((task) => task.scope ?? []),
  ]);
}

/**
 * After a goal merges, only goals that use the same files need an update.
 * An open Quick changes batch always does: its base moved under it.
 */
export async function flagGoalsAfterMerge(
  state: Pick<AppState, "tasks" | "epics">,
  merged: Epic,
  base: string,
  readChanges: ReadChanges,
): Promise<void> {
  const mergedFiles = await goalFiles(state, merged.id, readChanges);
  const since = now();
  for (const goal of state.epics) {
    if (
      goal.id === merged.id ||
      goal.projectId !== merged.projectId ||
      goal.closedAt
    )
      continue;
    if (isQuickChanges(goal)) {
      goal.updateNeeded ??= {
        reason: `${base} changed: “${merged.title}” merged.`,
        files: [],
        since,
      };
      continue;
    }
    const shared = [...(await goalFiles(state, goal.id, readChanges))]
      .filter((file) => mergedFiles.has(file))
      .sort();
    if (shared.length)
      goal.updateNeeded = {
        reason: `“${merged.title}” merged and changed ${shared.length === 1 ? "1 file" : `${shared.length} files`} this goal uses.`,
        files: shared,
        since,
      };
  }
}
