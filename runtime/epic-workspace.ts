import type { AppState, Epic, Project, WorkItem } from "../src/shared";
import { isActive } from "../src/domain";
import { git, now } from "./local";
import { ensureLocalRuntimeIgnored } from "./project-repository";
import { enterEpicCheckout } from "./epic-checkout";
import { realpath } from "node:fs/promises";

export function ensureTaskEpic(state: AppState, task: WorkItem): Epic {
  const assigned = state.epics.find(
    (epic) => epic.id === task.epicId && epic.projectId === task.projectId,
  );
  if (assigned) return assigned;
  let epic = state.epics.find(
    (epic) =>
      epic.projectId === task.projectId && epic.sourceKey === "project-work",
  );
  if (!epic) {
    const count =
      state.epics.filter((epic) => epic.projectId === task.projectId).length +
      1;
    epic = {
      id: `${task.projectId}-project-work`,
      projectId: task.projectId,
      identifier: `EP-${String(count).padStart(2, "0")}`,
      title: "Project work",
      description: "Focused stories for this project.",
      phase: "now",
      color: "mint",
      order: count,
      sourceKey: "project-work",
    };
    state.epics.push(epic);
  }
  task.epicId = epic.id;
  return epic;
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

// One checkout can host many story workers on the same epic branch.
// Switching that checkout to another epic is serialized and requires a quiet fleet.
export class EpicWorkspace {
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    private state: () => AppState,
    private dataDir?: string,
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
        "A result from the earlier execution mode is preserved in its previous folder. Review it before starting a new shared-branch story.",
      );
    const epic = ensureTaskEpic(this.state(), task),
      branch = epicBranch(epic);
    if (options.ownedCheckout && this.dataDir) {
      const checkout = await enterEpicCheckout(
        this.dataDir,
        project,
        epic,
        branch,
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
      const id = `${project.id}:epic:${epic.id}${checkout.workspace === canonical ? ":source" : ""}`;
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
        "Another epic has active workers in this project. Stop or finish that fleet before switching epic branches.",
      );
    // Local runtime stores are not source changes. Install these exclusions
    // before checking whether it is safe to switch an otherwise clean project.
    await ensureLocalRuntimeIgnored(project.path);
    const actual = await git(project.path, ["branch", "--show-current"]);
    if (!actual)
      throw new Error(
        "Choose a named project branch before activating an epic.",
      );
    const changedBranch = actual !== branch;
    if (changedBranch) {
      if (peers.length)
        throw new Error(
          "The checkout branch changed while this fleet was active. Stop the fleet and inspect the project.",
        );
      if (await git(project.path, ["status", "--porcelain"]))
        throw new Error(
          "Commit or finish the existing project changes before activating a different epic branch. No files were changed.",
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
        exists ? ["switch", branch] : ["switch", "-c", branch],
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
}
