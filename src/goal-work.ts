import type { EpicPullRequest } from "./pull-request";
import type { Epic, WorkItem } from "./shared";

/**
 * A goal ships as many pull requests as it needs. The tasks started together on this
 * computer are on the goal's branch and ship in one pull request. After it merges, the
 * next task that starts gets a new branch, and the goal closes when nothing is left.
 */

type Task = Pick<WorkItem, "epicId" | "stage" | "run">;
type Goal = Pick<Epic, "id" | "branch">;

export const isRunning = (task: Task): boolean =>
  ["preparing", "running", "stopping"].includes(task.run.state);

/** A worker was launched for it. A start that was refused before that left nothing. */
const hasWorked = (task: Task): boolean =>
  task.stage !== "planned" || !!task.run.changeRunId || !!task.run.sessionId;

/** A worker here worked on it on the goal's branch, so it ships with that branch. */
export const isOnBranch = (task: Task, goal: Goal): boolean =>
  task.epicId === goal.id &&
  task.run.state !== "idle" &&
  !task.run.shipped &&
  (!task.run.branch || task.run.branch === goal.branch) &&
  (isRunning(task) || hasWorked(task));

/** Its worker stopped before it was done, and what it left is in the branch's files. */
export function isUnfinished(task: Task): boolean {
  if (task.stage === "done" || isRunning(task) || !hasWorked(task)) return false;
  return (
    task.stage !== "review" ||
    ["failed", "stopped", "blocked"].includes(task.run.state)
  );
}

/** The goal's tasks that are still to do. */
export const openTasks = <T extends Task & Pick<WorkItem, "archivedAt">>(
  tasks: readonly T[],
  goal: Goal,
): T[] =>
  tasks.filter(
    (task) => task.epicId === goal.id && task.stage !== "done" && !task.archivedAt,
  );

/**
 * The pull request of the branch the goal is on now. One that merged is not it while the
 * goal goes on: what is newer on the branch ships in another.
 */
export function currentPullRequest(
  pullRequests: readonly EpicPullRequest[] | undefined,
  goal: Goal & Pick<Epic, "closedAt">,
): EpicPullRequest | undefined {
  if (!goal.branch) return undefined;
  const onBranch = (pullRequests ?? []).filter(
    (item) => item.epicId === goal.id && item.branch === goal.branch,
  );
  return (
    onBranch.find((item) => item.state !== "merged") ??
    (goal.closedAt ? onBranch.at(-1) : undefined)
  );
}

/** The goal's pull requests that merged, oldest first, without the one it closed with. */
export function mergedPullRequests(
  pullRequests: readonly EpicPullRequest[] | undefined,
  goal: Goal & Pick<Epic, "closedAt">,
): EpicPullRequest[] {
  const current = currentPullRequest(pullRequests, goal);
  return (pullRequests ?? []).filter(
    (item) =>
      item.epicId === goal.id && item.state === "merged" && item !== current,
  );
}

/** The pull request a task's work went into, or is about to. */
export function pullRequestOf(
  pullRequests: readonly EpicPullRequest[] | undefined,
  goal: Goal & Pick<Epic, "closedAt">,
  task: Task,
): EpicPullRequest | undefined {
  const branch = task.run.branch ?? goal.branch;
  if (task.stage !== "done")
    return currentPullRequest(pullRequests, { ...goal, branch });
  const onBranch = (pullRequests ?? []).filter(
    (item) => item.epicId === goal.id && item.branch === branch,
  );
  return onBranch.find((item) => item.state === "merged") ?? onBranch.at(-1);
}
