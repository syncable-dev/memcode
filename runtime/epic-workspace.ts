import type { AppState, Epic, Project, WorkItem } from "../src/shared";
import { randomUUID } from "node:crypto";
import {
  acceptsQuickChanges,
  isActive,
  isQuickChanges,
  quickChangesSource,
} from "../src/domain";
import {
  availableBranch,
  detectBranchStrategy,
  goalBranchName,
  integrationCommit,
  quickChangesBranchName,
  type BranchStrategy,
} from "./branch-strategy";
import { git, now } from "./local";
import { openGoalFor, worksHere } from "./goal-branch";
import { ensureLocalRuntimeIgnored } from "./project-repository";
import { enterEpicCheckout } from "./epic-checkout";
import { realpath } from "node:fs/promises";

/** Every task lives in a goal: its chosen goal, its parent's, or the open Quick changes batch. */
export function ensureTaskEpic(state: AppState, task: WorkItem): Epic {
  const assigned = state.epics.find(
    (epic) => epic.id === task.epicId && epic.projectId === task.projectId,
  );
  if (assigned) return assigned;
  const parent = state.tasks.find((item) => item.id === task.parentId);
  const inherited = state.epics.find(
    (epic) => epic.id === parent?.epicId && !epic.closedAt,
  );
  const epic = inherited ?? quickChangesBatch(state, task.projectId);
  task.epicId = epic.id;
  return epic;
}

function quickChangesBatch(state: AppState, projectId: string): Epic {
  const open = state.epics.find(
    (epic) =>
      epic.projectId === projectId &&
      isQuickChanges(epic) &&
      acceptsQuickChanges(epic),
  );
  if (open) return open;
  const count = state.epics.filter((epic) => epic.projectId === projectId).length + 1;
  const batch: Epic = {
    id: `${projectId}-quick-${randomUUID().slice(0, 8)}`,
    projectId,
    identifier: `EP-${String(count).padStart(2, "0")}`,
    title: "Quick changes",
    description: "Small changes that ship together in one pull request.",
    phase: "now",
    color: "mint",
    order: count,
    sourceKey: quickChangesSource,
  };
  state.epics.push(batch);
  return batch;
}

export function epicBranch(epic: Epic): string {
  return (
    epic.branch ??
    `epic/${epic.identifier.toLowerCase()}-${epic.id
      .replace(/[^a-z0-9]/gi, "")
      .slice(-10)
      .toLowerCase()}`
  );
}

const strategyLifetimeMs = 10 * 60_000;

// Supported engines give every epic its own checkout. Only the compatibility
// path below switches a single shared checkout and requires a quiet fleet.
export class EpicWorkspace {
  private locks = new Map<string, Promise<unknown>>();
  private strategies = new Map<
    string,
    { at: number; strategy: Promise<BranchStrategy> }
  >();
  constructor(
    private state: () => AppState,
    private dataDir?: string,
    private detectStrategy: (
      cwd: string,
    ) => Promise<BranchStrategy> = detectBranchStrategy,
  ) {}
  async activate(
    task: WorkItem,
    project: Project,
    options: { ownedCheckout?: boolean } = {},
  ): Promise<{ epic: Epic; changedBranch: boolean }> {
    const previous = this.locks.get(project.id) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.enter(task, project, options));
    this.locks.set(project.id, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(project.id) === current) this.locks.delete(project.id);
    }
  }
  private async enter(
    task: WorkItem,
    project: Project,
    options: { ownedCheckout?: boolean },
  ) {
    if (!project.path) throw new Error("Choose a local project folder first.");
    if (task.run.worktree && !task.run.workspace)
      throw new Error(
        "A result from the earlier execution mode is preserved in its previous folder. Review it before starting a new shared-branch task.",
      );
    const epic = openGoalFor(this.state(), task);
    await this.prepareBranch(epic, project, task);
    const branch = epicBranch(epic);
    if (options.ownedCheckout && this.dataDir) {
      const shippedBefore = !!this.state().pullRequests?.some(
        (item) => item.epicId === epic.id && item.branch !== branch,
      );
      const checkout = await enterEpicCheckout(
        this.dataDir,
        project,
        epic,
        branch,
        shippedBefore,
      );
      const canonical = await realpath(project.path);
      epic.branch = branch;
      epic.baseRevision ??= await git(checkout.workspace, [
        "rev-parse",
        "HEAD",
      ]);
      task.run.workspace = checkout.workspace;
      task.run.branch = branch;
      task.run.baseline = epic.baseRevision;
      // Even when the epic is already open in the primary folder, use a
      // separate current-source view. Its history import must not gate work.
      const id = `${project.id}:epic:${epic.id}${shippedBefore ? `:${branch}` : ""}${checkout.workspace === canonical ? ":source" : ""}`;
      if (task.run.analysisProjectId !== id)
        task.run.analysisRepoId = undefined;
      task.run.analysisProjectId = id;
      task.updatedAt = now();
      return { epic, changedBranch: false };
    }
    const peers = this.state().tasks.filter(
      (other) =>
        other.id !== task.id &&
        other.projectId === project.id &&
        isActive(other),
    );
    if (peers.some((peer) => peer.epicId !== epic.id))
      throw new Error(
        "The connected Memtrace engine does not support parallel goal checkouts. Reconnect the bundled Memtrace engine in Settings, then retry. Your running workers and their changes have been preserved.",
      );
    // Local runtime stores are not source changes. Install these exclusions
    // before checking whether it is safe to switch an otherwise clean project.
    await ensureLocalRuntimeIgnored(project.path);
    const actual = await git(project.path, ["branch", "--show-current"]);
    if (!actual)
      throw new Error(
        "Choose a named project branch before activating a goal.",
      );
    const changedBranch = actual !== branch;
    if (changedBranch) {
      if (peers.length)
        throw new Error(
          "The checkout branch changed while this fleet was active. Stop the fleet and inspect the project.",
        );
      if (await git(project.path, ["status", "--porcelain"]))
        throw new Error(
          "Commit or finish the existing project changes before activating a different goal branch. No files were changed.",
        );
      const head = await git(project.path, ["rev-parse", "HEAD"]);
      let exists = true;
      try {
        await git(project.path, [
          "show-ref",
          "--verify",
          `refs/heads/${branch}`,
        ]);
      } catch {
        exists = false;
      }
      await git(
        project.path,
        exists
          ? ["switch", branch]
          : ["switch", "-c", branch, epic.baseRevision ?? head],
      );
      epic.baseRevision ??= head;
    }
    epic.branch = branch;
    epic.baseRevision ??= await git(project.path, ["rev-parse", "HEAD"]);
    project.branch = branch;
    task.run.workspace = project.path;
    task.run.branch = branch;
    task.run.baseline = epic.baseRevision;
    task.updatedAt = now();
    return { epic, changedBranch };
  }

  /**
   * New work starts from the branch the goal or the project chose, or else the team's
   * integration branch, and is named the team's way.
   */
  private async prepareBranch(epic: Epic, project: Project, task: WorkItem) {
    const path = project.path!;
    if (epic.branch && (await worksHere(this.state(), epic, path))) return;
    const elsewhere = epic.branch;
    const shared = !!this.state().sharedProjectLinks?.some(
      (link) => link.projectId === project.id,
    );
    // The goal's own name is taken by its first branch; what comes later is named by
    // the task that begins it. On a shared project every branch is: two computers can
    // start the same goal before either has heard of the other.
    const byTask =
      shared ||
      !!elsewhere ||
      !!this.state().pullRequests?.some((item) => item.epicId === epic.id);
    // Not this computer's: what the shared board says stays there for the one it belongs to.
    if (elsewhere && shared)
      epic.boardBranch ??= { branch: elsewhere, baseRevision: epic.baseRevision };
    delete epic.branch;
    delete epic.baseRevision;
    const detected = await this.strategyFor(path);
    const base = epic.baseBranch ?? project.baseBranch ?? detected.base;
    const strategy = { ...detected, base };
    epic.branch = await availableBranch(
      path,
      isQuickChanges(epic)
        ? quickChangesBranchName(
            strategy,
            new Date(),
            shared ? task.title : undefined,
          )
        : goalBranchName(strategy, byTask ? task.title : epic.title),
      strategy.remote,
      new Set(
        [elsewhere, ...this.state().epics.map((other) => other.branch)].filter(
          (name): name is string => !!name,
        ),
      ),
    );
    epic.baseBranch = base;
    epic.baseRevision ??= await integrationCommit(path, strategy);
  }

  private strategyFor(path: string): Promise<BranchStrategy> {
    const cached = this.strategies.get(path);
    if (cached && Date.now() - cached.at < strategyLifetimeMs)
      return cached.strategy;
    const strategy = this.detectStrategy(path);
    this.strategies.set(path, { at: Date.now(), strategy });
    strategy.catch(() => this.strategies.delete(path));
    return strategy;
  }
}
