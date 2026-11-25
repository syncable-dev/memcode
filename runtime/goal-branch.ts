import type { AppState, Epic, WorkItem } from "../src/shared";
import { isQuickChanges } from "../src/domain";
import { isOnBranch, openTasks } from "../src/goal-work";
import { refExists } from "./branch-strategy";
import { ensureTaskEpic } from "./epic-workspace";

/** The goal a task is about to work in, open again when it had closed. */
export function openGoalFor(state: AppState, task: WorkItem): Epic {
  const goal = ensureTaskEpic(state, task);
  if (!goal.closedAt) return goal;
  if (isQuickChanges(goal)) {
    // Quick changes ship as whole batches: a shipped one is followed by a new one.
    task.epicId = null;
    return ensureTaskEpic(state, task);
  }
  leaveBranch(goal);
  delete goal.closedAt;
  return goal;
}

/**
 * Whether a goal's branch can be worked on here. A branch another computer made is not
 * here until it is pushed: one of the same name would be a second branch that cannot
 * be pushed too. A branch someone brought here through Git is here.
 */
export async function worksHere(
  state: AppState,
  goal: Epic,
  folder: string,
): Promise<boolean> {
  if (state.tasks.some((task) => !!task.run.branch && isOnBranch(task, goal)))
    return true;
  return refExists(folder, `refs/heads/${goal.branch}`);
}

/**
 * What a merge leaves behind: the reviewed tasks that were in it are done, and the goal
 * closes when nothing is left or starts its next task on a new branch. A task with work
 * newer than the pull request keeps the goal on the branch, and ships in the next one.
 * Answers how many tasks it finished.
 */
export function shipBranch(
  state: AppState,
  goal: Epic,
  branch: string,
  at: string,
  isNewer: (task: WorkItem) => boolean = () => false,
): number {
  let completed = 0;
  let staysOnBranch = false;
  for (const task of state.tasks) {
    if (!isOnBranch(task, { id: goal.id, branch })) continue;
    if (task.stage !== "done" && task.run.branch === branch && isNewer(task))
      staysOnBranch = true;
    else if (task.stage === "review") {
      task.stage = "done";
      task.run.shipped = true;
      task.updatedAt = at;
      completed++;
    } else if (task.stage === "done") task.run.shipped = true;
  }
  if (staysOnBranch) return completed;
  // What was being brought into the branch that shipped is nobody's to finish any more.
  if (goal.branch === branch) delete goal.resolving;
  const left = openTasks(state.tasks, goal);
  if (isQuickChanges(goal)) {
    goal.closedAt ??= at;
    for (const task of left)
      // Someone may work on it elsewhere: a tracker says so without a worker here.
      if (task.stage === "planned" || task.run.state === "idle") {
        task.epicId = null;
        ensureTaskEpic(state, task);
      }
  } else if (!left.length) goal.closedAt ??= at;
  else if (goal.branch === branch) leaveBranch(goal);
  return completed;
}

function leaveBranch(goal: Epic): void {
  delete goal.branch;
  delete goal.baseRevision;
  delete goal.mergedRevision;
  delete goal.updateNeeded;
  delete goal.resolving;
}
