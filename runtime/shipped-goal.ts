import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { AppState, Epic, WorkItem } from "../src/shared";
import { isActive } from "../src/domain";
import { git } from "./local";
import { keepWorkerRecords } from "./worker-records";

/**
 * After a goal's pull request merges: bring the goal's history into the
 * project's index, keep its task records, then remove its checkout
 * (ADR-0001). Anything that could lose work keeps the checkout and says why.
 */

/** What MemCode asks the project's engine for (`import_goal_history`). */
export interface GoalHistoryRequest {
  goal_store: string;
  goal_checkout: string;
  repo_id: string;
  project_path: string;
  branch: string;
  merged_into: string;
  dry_run: boolean;
}

/** How much history moved, as the engine counts it. */
export interface HistoryCounts {
  episodes: number;
  fleet_records: number;
  nodes: number;
  edges: number;
}

export type CheckoutOutcome =
  | { kind: "removed"; imported: HistoryCounts }
  | { kind: "kept"; reason: string };

export interface ShippedGoalDeps {
  dataDir: string;
  /** Stop the goal's own engine so its store is free to read. */
  releaseGoalEngine: (goal: Epic, task: WorkItem) => Promise<void>;
  /** Run `import_goal_history` on the project's engine. */
  importHistory: (request: GoalHistoryRequest) => Promise<HistoryCounts>;
}

const kept = (reason: string): CheckoutOutcome => ({ kind: "kept", reason });

export async function retireShippedGoal(
  state: AppState,
  goal: Epic,
  mergedInto: string,
  deps: ShippedGoalDeps,
): Promise<CheckoutOutcome> {
  const tasks = state.tasks.filter((task) => task.epicId === goal.id);
  const project = state.projects.find((item) => item.id === goal.projectId);
  const checkout = tasks.find((task) => task.run.workspace)?.run.workspace;
  if (!project?.path || !checkout || !goal.branch) return kept("This goal has no checkout of its own.");
  if ((await realpath(checkout).catch(() => checkout)) === (await realpath(project.path)))
    return kept("This goal worked in your project folder, which MemCode never removes.");
  if (tasks.some(isActive)) return kept("A worker is still running in this goal's checkout.");
  if (await hasUncommittedWork(checkout))
    return kept("This goal's checkout has changes that are not committed.");
  if (!project.repoId) return kept("The project's code index isn't ready, so the goal's history can't be added to it yet.");
  await deps.releaseGoalEngine(goal, tasks.find((task) => task.run.analysisProjectId) ?? tasks[0]);
  const request: GoalHistoryRequest = {
    goal_store: join(checkout, ".memcode", "memtrace", ".memdb"),
    goal_checkout: checkout,
    repo_id: project.repoId,
    project_path: project.path,
    branch: goal.branch,
    merged_into: mergedInto,
    dry_run: true,
  };
  const imported = await importChecked(request, deps);
  if (imported.kind === "kept") return imported;
  await keepWorkerRecords(deps.dataDir, state, tasks);
  const removal = await git(project.path, ["worktree", "remove", checkout]).then(
    () => undefined,
    (error: Error) => error.message,
  );
  if (removal) return kept(`The goal's history and task records are kept, but Git didn't remove its checkout: ${removal}`);
  return imported;
}

/** Count first, then import, and accept only an import that moved what the count said. */
async function importChecked(
  request: GoalHistoryRequest,
  deps: ShippedGoalDeps,
): Promise<CheckoutOutcome> {
  try {
    const expected = await deps.importHistory(request);
    const imported = await deps.importHistory({ ...request, dry_run: false });
    if (!sameCounts(expected, imported))
      return kept("The goal's history import didn't match its dry run, so its checkout stays.");
    return { kind: "removed", imported };
  } catch (error) {
    const message = (error as Error).message;
    if (/unknown tool|tool not found|not found: import_goal_history|method not found/i.test(message))
      return kept("This Memtrace engine can't import goal history yet, so the goal's checkout stays.");
    return kept(`The goal's history couldn't be added to the project's index: ${message}`);
  }
}

function sameCounts(a: HistoryCounts, b: HistoryCounts): boolean {
  return (
    a.episodes === b.episodes &&
    a.fleet_records === b.fleet_records &&
    a.nodes === b.nodes &&
    a.edges === b.edges
  );
}

async function hasUncommittedWork(checkout: string): Promise<boolean> {
  const status = await git(checkout, ["status", "--porcelain", "--untracked-files=all"]);
  return status.trim().length > 0;
}
