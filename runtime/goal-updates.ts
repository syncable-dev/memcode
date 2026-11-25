import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { AppState, Epic, WorkItem } from "../src/shared";
import type { WorkerChanges } from "../src/changes";
import { isActive, isQuickChanges } from "../src/domain";
import { isOnBranch } from "../src/goal-work";
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
  /** Sends a task's worker this as its next instruction. */
  askWorker?: (task: WorkItem, text: string) => void;
  readChanges?: ReadChanges;
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
  register(
    "epic:resolve-update",
    z.object({ epicId: z.string().min(1).max(200) }).strict(),
    (input) => updates.resolveWithWorker(input.epicId),
  );
  register(
    "epic:undo-update",
    z.object({ epicId: z.string().min(1).max(200) }).strict(),
    (input) => updates.undo(input.epicId),
  );
}

/** Brings a goal up to date with its integration branch, only when the person asks. */
export class GoalUpdates {
  constructor(private deps: GoalUpdateDependencies) {}

  async updateFromBase(epicId: string): Promise<GoalUpdateResult> {
    const { epic, worktree } = this.target(epicId);
    if (epic.resolving) throw new Error(stillResolving(epic.resolving));
    const base = epic.baseBranch ?? (await detectBranchStrategy(worktree)).base;
    const target = await integrationCommit(worktree, {
      base,
      remote: await primaryRemote(worktree),
    });
    if (await contains(worktree, target)) {
      delete epic.updateNeeded;
      await this.deps.changed();
      return { merged: false, savedWork: false };
    }
    const savedWork = await saveWork(worktree, base);
    const conflicts = await bringIn(worktree, epic, target, base);
    if (conflicts.length) {
      await this.deps.changed();
      return { merged: false, savedWork, conflicts };
    }
    await this.deps.changed();
    void this.deps.refreshGraph?.(epicId).catch(() => {});
    return { merged: true, savedWork };
  }

  /**
   * Brings the base in and leaves what conflicts in the goal's folder for one of its
   * workers to resolve. The merge is committed when that worker ends and no conflict is
   * left; until then it can be undone.
   */
  async resolveWithWorker(
    epicId: string,
  ): Promise<{ merged: boolean; savedWork: boolean; asked?: string }> {
    const { epic, worktree, tasks } = this.target(epicId);
    const ask = this.deps.askWorker;
    if (!ask) throw new Error("Workers are not available.");
    let savedWork = false;
    if (epic.resolving) await this.left(epic.resolving, worktree);
    else {
      const base = epic.baseBranch ?? (await detectBranchStrategy(worktree)).base;
      const target = await integrationCommit(worktree, {
        base,
        remote: await primaryRemote(worktree),
      });
      savedWork = await saveWork(worktree, base);
      const files = await bringIn(worktree, epic, target, base, true);
      if (!files.length) {
        await this.deps.changed();
        void this.deps.refreshGraph?.(epicId).catch(() => {});
        return { merged: true, savedWork };
      }
      epic.resolving = { base, target, files, since: now(), taskId: "" };
    }
    const resolving = epic.resolving!;
    if (!resolving.files.length) {
      await this.commit(epic, worktree);
      return { merged: true, savedWork };
    }
    const task = await this.closestTo(tasks, resolving.files);
    resolving.taskId = task.id;
    ask(
      task,
      `${resolving.base} was merged into this goal's branch, and it conflicts in ${resolving.files.join(", ")}. Each of those files holds both sides between conflict markers. Edit them so that what this goal does and what ${resolving.base} does both work, and leave no marker behind. Then run the project's tests and fix what the merge broke. Do not run git merge, commit, reset or checkout: MemCode commits the merge when you end.`,
    );
    await this.deps.changed();
    return { merged: false, savedWork, asked: task.identifier };
  }
  /** A worker's turn ended: a base it was bringing in is committed once nothing conflicts. */
  async workerEnded(task: WorkItem): Promise<void> {
    const epic = this.deps.state().epics.find((item) => item.id === task.epicId);
    if (!epic?.resolving || epic.resolving.taskId !== task.id || !task.run.workspace)
      return;
    await this.left(epic.resolving, task.run.workspace);
    if (epic.resolving.files.length) await this.deps.changed();
    else await this.commit(epic, task.run.workspace);
  }
  async undo(epicId: string): Promise<void> {
    const { epic, worktree } = this.target(epicId);
    if (!epic.resolving) return;
    await git(worktree, ["merge", "--abort"]);
    delete epic.resolving;
    await this.deps.changed();
  }
  /** Which of the files still hold a conflict. */
  private async left(
    resolving: NonNullable<Epic["resolving"]>,
    worktree: string,
  ): Promise<void> {
    const checked = await Promise.all(
      resolving.files.map(async (file) =>
        (await hasConflict(join(worktree, file))) ? [file] : [],
      ),
    );
    resolving.files = checked.flat();
  }
  private async commit(epic: Epic, worktree: string): Promise<void> {
    const { base, target } = epic.resolving!;
    await git(worktree, ["add", "-A"]);
    await git(worktree, ["commit", "--no-edit", "-m", `Update from ${base}`]);
    epic.baseRevision = target;
    delete epic.resolving;
    delete epic.mergedRevision;
    delete epic.updateNeeded;
    await this.deps.changed();
    void this.deps.refreshGraph?.(epic.id).catch(() => {});
  }
  /** The task that changed most of these files knows best what they should do. */
  private async closestTo(tasks: WorkItem[], files: string[]): Promise<WorkItem> {
    const counted = await Promise.all(
      tasks.map(async (task) => {
        const changes = await this.deps.readChanges?.(task).catch(() => undefined);
        const own = new Set(
          changes?.checkpoints.flatMap((item) => item.files.map((file) => file.path)),
        );
        return { task, count: files.filter((file) => own.has(file)).length };
      }),
    );
    return counted.sort(
      (a, b) =>
        b.count - a.count ||
        (b.task.run.finishedAt ?? "").localeCompare(a.task.run.finishedAt ?? ""),
    )[0].task;
  }

  private target(epicId: string): {
    epic: Epic;
    worktree: string;
    tasks: WorkItem[];
  } {
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
    const worked = tasks.filter(
      (task) => isOnBranch(task, epic) && task.run.workspace,
    );
    const worktree = worked[0]?.run.workspace;
    if (!worktree)
      throw new Error(
        "No task in this goal has run yet, so there is nothing to update.",
      );
    return { epic, worktree, tasks: worked };
  }
}

/** Why work on the branch waits while the base is being brought in. */
export const stillResolving = (resolving: NonNullable<Epic["resolving"]>) =>
  resolving.files.length
    ? `${resolving.base} is being brought into this goal and conflicts in ${resolving.files.join(", ")}. Wait for the worker that resolves it, or undo it on the Roadmap.`
    : `${resolving.base} is being brought into this goal. It is done in a moment.`;

/** Whether a file still holds what Git leaves for a person to resolve. */
async function hasConflict(path: string): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => "");
  return /^<{7}(?: |\r?$)/m.test(text) && /^>{7}(?: |\r?$)/m.test(text);
}

async function gitPath(cwd: string, name: string): Promise<string> {
  const path = await git(cwd, ["rev-parse", "--git-path", name]);
  return isAbsolute(path) ? path : join(cwd, path);
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

/** Merges the newer base into a goal's branch, or answers the files that conflict. */
export async function bringIn(
  worktree: string,
  epic: Epic,
  target: string,
  base: string,
  /** Leaves what conflicts in the folder instead of taking it out again. */
  keepConflicts = false,
): Promise<string[]> {
  const conflicts = await mergeOrUndo(
    worktree,
    target,
    base,
    epic.mergedRevision,
    keepConflicts,
  );
  if (!conflicts.length) {
    epic.baseRevision = target;
    delete epic.mergedRevision;
    delete epic.updateNeeded;
  }
  return conflicts;
}

/**
 * A conflicting merge is aborted in full; the caller gets the conflicting files.
 *
 * After `merged` went into the base, squashed or not, Git has no way to know that the
 * base holds this branch's work up to there, and would set that work against itself.
 * The base is then merged as a commit that follows `merged`, so that only what both
 * sides did since is compared.
 */
async function mergeOrUndo(
  cwd: string,
  target: string,
  base: string,
  merged?: string,
  keepConflicts = false,
): Promise<string[]> {
  const message = `Update from ${base}`;
  const branch = await git(cwd, ["rev-parse", "HEAD"]);
  const source = merged
    ? await git(cwd, ["commit-tree", `${target}^{tree}`, "-p", merged, "-m", message])
    : target;
  try {
    await git(cwd, [
      "merge",
      ...(merged ? ["--no-ff"] : []),
      "--no-edit",
      "-m",
      message,
      source,
    ]);
    if (merged) {
      // The same files, with the base itself as what was merged.
      const commit = await git(cwd, [
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        branch,
        "-p",
        target,
        "-m",
        message,
      ]);
      await git(cwd, ["reset", "--soft", commit]);
    }
    return [];
  } catch (error) {
    const conflicts = (
      await git(cwd, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")
    )
      .split("\n")
      .filter(Boolean);
    if (keepConflicts && conflicts.length) {
      // The commit that ends it has the base itself as what was merged.
      if (merged)
        await writeFile(await gitPath(cwd, "MERGE_HEAD"), target + "\n");
      return conflicts;
    }
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
  goal?: Pick<Epic, "branch">,
): Promise<Set<string>> {
  // Work on an earlier branch is in the base already.
  const tasks = state.tasks.filter(
    (task) =>
      task.epicId === epicId &&
      (!goal?.branch || !task.run.branch || task.run.branch === goal.branch),
  );
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
  const mergedFiles = await goalFiles(state, merged.id, readChanges, merged);
  const since = now();
  for (const goal of state.epics) {
    if (
      goal.id === merged.id ||
      goal.projectId !== merged.projectId ||
      goal.closedAt ||
      // With no work of its own yet, its branch starts from what was just merged.
      (!goal.branch &&
        !state.tasks.some((task) => isOnBranch(task, goal)))
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
    const shared = [...(await goalFiles(state, goal.id, readChanges, goal))]
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
