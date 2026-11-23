/**
 * Why a project's new work starts from its base branch: the first of MemCode's rules
 * that applied, or the person's own choice. The rules, in order: where most merged
 * pull requests went; else an integration branch the repository has (develop,
 * development, dev); else its default branch; else main, or master when only master
 * exists.
 */
export type BaseReason =
  | { kind: "merged-pull-requests"; count: number; of: number }
  | { kind: "integration-branch" }
  | { kind: "default-branch" }
  | { kind: "fallback" };
export type BaseChoice = BaseReason | { kind: "chosen" };

/** A project's repository and where its work branches from, as the Roadmap shows it. */
export interface RepositoryStatus {
  folder: string;
  /** The remote new work is fetched from, such as "origin". */
  remote?: string;
  /** The repository's page, when the remote is on GitHub. */
  github?: string;
  /** Where new work starts, whether the person chose it, and why. */
  base: { branch: string; chosen: boolean; reason: BaseChoice };
  /** Every branch, local or on the remote, by name. */
  branches: string[];
}

const GITHUB_PAGE = "https://github.com/";

/** How the project switcher names a repository: owner/name on GitHub, else its folder. */
export function repositoryName(repository: Pick<RepositoryStatus, "folder" | "github">): string {
  if (repository.github?.startsWith(GITHUB_PAGE))
    return repository.github.slice(GITHUB_PAGE.length);
  return repository.folder.split(/[\\/]/).filter(Boolean).at(-1) ?? repository.folder;
}

/** Which rule chose the base branch, in one sentence. */
export function baseReasonText(base: { branch: string; reason: BaseChoice }): string {
  const { branch, reason } = base;
  switch (reason.kind) {
    case "chosen":
      return `You chose ${branch}.`;
    case "merged-pull-requests":
      return reason.of === 1
        ? `Your last merged pull request went to ${branch}.`
        : `${reason.count} of your last ${reason.of} merged pull requests went to ${branch}.`;
    case "integration-branch":
      return `Your repository has a ${branch} branch.`;
    case "default-branch":
      return `${branch} is the repository's default branch.`;
    case "fallback":
      return `No other branch fits, so ${branch}.`;
  }
}

/** Where a goal's work goes: */
export type GoalBranch =
  /** a new branch from `from`, made when its first task starts; */
  | { kind: "on-first-start"; from: string }
  /** a branch it names that no worker here has used, such as one copied from another project; */
  | { kind: "unused"; branch: string }
  /** the branch its workers use. */
  | { kind: "working"; branch: string };

export function goalBranchStanding(
  goal: { branch?: string; baseBranch?: string },
  started: boolean,
  base: string,
): GoalBranch {
  if (!goal.branch) return { kind: "on-first-start", from: goal.baseBranch ?? base };
  return started
    ? { kind: "working", branch: goal.branch }
    : { kind: "unused", branch: goal.branch };
}
