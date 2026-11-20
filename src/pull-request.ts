import { isActive } from "./domain";
import type { HandoffAttribution } from "./handoff";
import type { WorkItem } from "./shared";

/** One epic is one branch, so every story in it lands in one pull request. */
export interface EpicReadiness {
  total: number;
  ready: number;
  active: number;
  isReady: boolean;
}

export interface EpicPullRequest {
  epicId: string;
  branch: string;
  base: string;
  /** The PR itself, or GitHub's prefilled compare page when no CLI created it. */
  url?: string;
  number?: number;
  state?: "open" | "merged" | "closed";
  mergedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type MergeMethod = "merge" | "squash" | "rebase";

/** GitHub's current view of the pull request, read through the person's `gh`. */
export interface PullRequestStatus {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  review: "approved" | "changes-requested" | "review-required" | "not-required";
  checks: "passing" | "failing" | "pending" | "none";
  mergeMethod?: MergeMethod;
  /** Why Merge is unavailable; absent when GitHub would merge it now. */
  mergeBlocker?: string;
}

export interface MergeResult {
  pullRequest: EpicPullRequest;
  completedStories: number;
}

export interface GitHubRepository {
  owner: string;
  repo: string;
}

export interface PullRequestPlan {
  epicId: string;
  branch: string;
  base: string;
  current: boolean;
  uncommitted: string[];
  ahead: number;
  remote?: string;
  github?: GitHubRepository;
  readiness: EpicReadiness;
  openConflicts: number;
  existing?: EpicPullRequest;
  status?: PullRequestStatus;
  blocker?: string;
  notice?: string;
  steps: string[];
  title: string;
  description: string;
  commitMessage: string;
  attribution: HandoffAttribution;
}

export interface CreatePullRequest {
  epicId: string;
  title: string;
  description: string;
  commitMessage: string;
}

export interface PullRequestResult {
  pullRequest: EpicPullRequest;
  committed: boolean;
  pushed: boolean;
  opened: "created" | "existing" | "browser" | "none";
  descriptionOmitted?: boolean;
}

export function epicReadiness(
  tasks: WorkItem[],
  epicId: string,
): EpicReadiness {
  const stories = tasks.filter((task) => task.epicId === epicId);
  const ready = stories.filter(
    (task) => task.stage === "review" || task.stage === "done",
  ).length;
  const active = stories.filter(isActive).length;
  return {
    total: stories.length,
    ready,
    active,
    isReady: stories.length > 0 && ready === stories.length && active === 0,
  };
}

export type DescriptionPart =
  | { kind: "markdown"; text: string }
  | { kind: "details"; summary: string; text: string };

const foldedSection =
  /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g;

/** Splits out GitHub's collapsible sections so the preview can fold them too. */
export function descriptionParts(text: string): DescriptionPart[] {
  const parts: DescriptionPart[] = [];
  let consumed = 0;
  for (const match of text.matchAll(foldedSection)) {
    if (match.index > consumed)
      parts.push({ kind: "markdown", text: text.slice(consumed, match.index) });
    parts.push({
      kind: "details",
      summary: match[1].trim(),
      text: match[2].trim(),
    });
    consumed = match.index + match[0].length;
  }
  if (consumed < text.length)
    parts.push({ kind: "markdown", text: text.slice(consumed) });
  return parts.filter((part) => part.kind === "details" || part.text.trim());
}
