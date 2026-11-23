/** A project's folder and where its work branches from, as the Repository panel shows it. */
export interface RepositoryStatus {
  folder: string;
  /** The remote new work is fetched from, such as "origin". */
  remote?: string;
  /** The repository's page, when the remote is on GitHub. */
  github?: string;
  /** The branch the folder is on, or null when it is on no branch. */
  branch: string | null;
  /** Files changed in the folder and not committed. */
  changedFiles: number;
  /** Where new work starts, and whether the person chose it. */
  base: { branch: string; chosen: boolean };
  /** Commits the folder's branch has that the base lacks, and the other way round. */
  ahead?: number;
  behind?: number;
  /** Every branch, local or on the remote, by name. */
  branches: string[];
}

/** What the Repository panel says about the folder's branch, in a sentence. */
export function folderStanding(status: RepositoryStatus): string {
  const where = status.branch
    ? `The folder is on ${status.branch}`
    : "The folder is on no branch";
  const behind = status.behind
    ? `, ${status.behind} ${status.behind === 1 ? "commit" : "commits"} behind ${status.base.branch}`
    : "";
  const changed = status.changedFiles
    ? ` ${status.changedFiles} changed ${status.changedFiles === 1 ? "file is" : "files are"} not committed.`
    : "";
  return `${where}${behind}.${changed}`;
}

/**
 * Where a goal's work goes, and whether it may start fresh: only before any worker
 * here has used its branch, such as a goal copied from another project.
 */
export function goalBranchStanding(
  goal: { branch?: string; baseBranch?: string },
  started: boolean,
  base: string,
): { text: string; startFresh: boolean } {
  if (!goal.branch)
    return {
      text: `Gets its own branch from ${goal.baseBranch ?? base} when work starts.`,
      startFresh: false,
    };
  if (started) return { text: `Work is on ${goal.branch}.`, startFresh: false };
  return {
    text: `Set to ${goal.branch}, which no worker here has used yet.`,
    startFresh: true,
  };
}
