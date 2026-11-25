import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Epic, Project, WorkItem } from "../src/shared";
import { git, within } from "./local";
import { ensureLocalRuntimeIgnored } from "./project-repository";

const key = (path: string) =>
  process.platform === "win32" ? path.toLowerCase() : path;
async function commonDirectory(root: string): Promise<string> {
  const path = await git(root, ["rev-parse", "--git-common-dir"]);
  return realpath(isAbsolute(path) ? path : resolve(root, path));
}

/** One registered linked checkout per epic. Never copy .git or reset a checkout. */
export async function enterEpicCheckout(
  dataDir: string,
  project: Project,
  epic: Epic,
  branch: string,
  /** The goal shipped an earlier branch, whose checkout may still be there. */
  shippedBefore = false,
): Promise<{ workspace: string; created: boolean }> {
  const root = await realpath(project.path!);
  await git(root, ["check-ref-format", "--branch", branch]);
  const common = await commonDirectory(root);
  const checkoutId = createHash("sha256")
    .update(
      key(common) +
        "\0" +
        project.id +
        "\0" +
        epic.id +
        (shippedBefore ? "\0" + branch : ""),
    )
    .digest("hex")
    .slice(0, 24);
  const anchor = join(resolve(dataDir), "epic-checkouts");
  await mkdir(anchor, { recursive: true });
  const actualAnchor = await realpath(anchor);
  if (!within(await realpath(dataDir), actualAnchor))
    throw Error(
      "The goal checkout folder resolves outside MemCode's local data directory.",
    );
  const workspace = join(actualAnchor, checkoutId);
  const registered = (
    await git(root, ["worktree", "list", "--porcelain", "-z"])
  )
    .split("\0\0")
    .filter(Boolean)
    .map((record) =>
      Object.fromEntries(
        record
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const split = line.indexOf(" ");
            return split < 0
              ? [line, ""]
              : [line.slice(0, split), line.slice(split + 1)];
          }),
      ),
    );
  const owned = registered.find(
    (entry) => key(resolve(entry.worktree ?? "")) === key(workspace),
  );
  if (owned) {
    if (
      owned.branch !== `refs/heads/${branch}` ||
      owned.locked !== undefined ||
      owned.prunable !== undefined
    )
      throw Error(
        "This goal's saved checkout changed branch or is unavailable. Its files were preserved; inspect it before starting workers.",
      );
    if (
      key(await commonDirectory(workspace)) !== key(common) ||
      key(await realpath(workspace)) !== key(workspace)
    )
      throw Error(
        "This goal's checkout no longer belongs to the selected repository.",
      );
    await ensureLocalRuntimeIgnored(workspace);
    return { workspace, created: false };
  }
  const occupied = registered.find(
    (entry) => entry.branch === `refs/heads/${branch}`,
  );
  if (occupied) {
    const open = await realpath(occupied.worktree);
    if (key(open) === key(root)) return { workspace: root, created: false };
    // MemCode made it for this goal before the branch got the name it has now.
    if (within(actualAnchor, open) && occupied.locked === undefined) {
      await ensureLocalRuntimeIgnored(open);
      return { workspace: open, created: false };
    }
    throw Error(
      "This goal branch is already open in another checkout. Connect that checkout explicitly; MemCode has not moved or overwritten it.",
    );
  }
  let exists = true;
  try {
    await git(root, ["show-ref", "--verify", `refs/heads/${branch}`]);
  } catch {
    exists = false;
  }
  const base = epic.baseRevision ?? (await git(root, ["rev-parse", "HEAD"]));
  await git(root, ["rev-parse", "--verify", `${base}^{commit}`]);
  await git(
    root,
    exists
      ? ["worktree", "add", workspace, branch]
      : ["worktree", "add", "-b", branch, workspace, base],
  );
  if (key(await commonDirectory(workspace)) !== key(common))
    throw Error("Git did not bind the new goal checkout to this repository.");
  await ensureLocalRuntimeIgnored(workspace);
  epic.baseRevision ??= base;
  return { workspace, created: true };
}

export function epicAnalysisProject(project: Project, task: WorkItem): Project {
  if (!task.run.workspace || !task.run.analysisProjectId || !task.run.branch)
    return project;
  return {
    ...project,
    id: task.run.analysisProjectId,
    path: task.run.workspace,
    branch: task.run.branch,
    repoId: task.run.analysisRepoId,
    analysis: task.run.analysisRepoId ? "ready" : "idle",
    analysisCheckout: task.run.analysisProjectId.endsWith(":source")
      ? undefined
      : "owned-worktree-v1",
    analysisCurrentSource: true,
  };
}
