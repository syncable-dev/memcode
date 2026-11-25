import type {
  MergeMethod,
  PullRequestStatus,
} from "../src/pull-request";
import { childEnv, type Command } from "./commands";
import { exec } from "./local";
import { withTemporaryFile } from "./temporary-file";

const networkTimeoutMs = 120_000;
const statusFields =
  "number,url,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup";
const failedConclusions = [
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
];
const failedStates = ["FAILURE", "ERROR"];
const pendingStates = ["PENDING", "EXPECTED"];

export interface NewPullRequest {
  base: string;
  head: string;
  title: string;
  body: string;
}

interface CheckRollupItem {
  status?: string;
  conclusion?: string | null;
  state?: string;
}
interface RawPullRequest {
  number: number;
  url: string;
  state: string;
  isDraft?: boolean;
  reviewDecision?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: CheckRollupItem[];
}

/** The pull-request operations MemCode performs through the person's own `gh`. */
export class GitHubCli {
  constructor(private cli: Command) {}

  /** The branch's open pull request. One that merged or was closed is not reused. */
  async existingUrl(cwd: string, branch: string): Promise<string | undefined> {
    const view = await this.run(cwd, [
      "pr",
      "view",
      branch,
      "--json",
      "url,state",
    ]).catch(() => "");
    if (!view) return undefined;
    const found = JSON.parse(view) as Pick<RawPullRequest, "url" | "state">;
    return found.state === "OPEN" ? found.url : undefined;
  }

  async create(cwd: string, pull: NewPullRequest): Promise<string | undefined> {
    const output = await withTemporaryFile(pull.body, (file) =>
      this.run(cwd, [
        "pr",
        "create",
        "--base",
        pull.base,
        "--head",
        pull.head,
        "--title",
        pull.title,
        "--body-file",
        file,
      ]),
    );
    const url = output.split("\n").pop();
    return url?.startsWith("https://") ? url : undefined;
  }

  /** By its number when known: a branch can have had several pull requests. */
  async status(
    cwd: string,
    pull: { branch: string; number?: number },
    base: string,
  ): Promise<PullRequestStatus | undefined> {
    const view = await this.run(cwd, [
      "pr",
      "view",
      pull.number ? String(pull.number) : pull.branch,
      "--json",
      statusFields,
    ]).catch(() => "");
    if (!view) return undefined;
    return readPullRequestStatus(
      JSON.parse(view) as RawPullRequest,
      await this.defaultMergeMethod(cwd),
      base,
    );
  }

  async merge(cwd: string, number: number, method: MergeMethod) {
    await this.run(cwd, ["pr", "merge", String(number), `--${method}`]);
  }

  private async defaultMergeMethod(
    cwd: string,
  ): Promise<MergeMethod | undefined> {
    const repository = await this.run(cwd, [
      "repo",
      "view",
      "--json",
      "viewerDefaultMergeMethod",
    ]).catch(() => "");
    const method = repository
      ? (JSON.parse(repository).viewerDefaultMergeMethod as string | undefined)
      : undefined;
    return method ? (method.toLowerCase() as MergeMethod) : undefined;
  }

  private async run(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await exec(this.cli.command, [...this.cli.prefix, ...args], {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      timeout: networkTimeoutMs,
      env: { ...childEnv(), ...this.cli.env, GH_PROMPT_DISABLED: "1" },
    });
    return stdout.trim();
  }
}

export function pullRequestNumber(url: string): number | undefined {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? Number(match[1]) : undefined;
}

export function readPullRequestStatus(
  raw: RawPullRequest,
  mergeMethod: MergeMethod | undefined,
  base: string,
): PullRequestStatus {
  const status: PullRequestStatus = {
    number: raw.number,
    url: raw.url,
    state:
      raw.state === "MERGED"
        ? "merged"
        : raw.state === "CLOSED"
          ? "closed"
          : "open",
    draft: !!raw.isDraft,
    review: reviewOf(raw.reviewDecision),
    checks: checksOf(raw.statusCheckRollup ?? []),
    ...(mergeMethod ? { mergeMethod } : {}),
  };
  const blocker = mergeBlocker(status, raw.mergeStateStatus, base);
  return {
    ...status,
    ...(blocker ? { mergeBlocker: blocker } : {}),
    ...(status.state === "open" &&
    ["DIRTY", "BEHIND"].includes(raw.mergeStateStatus ?? "")
      ? { needsBase: true }
      : {}),
  };
}

function reviewOf(decision?: string): PullRequestStatus["review"] {
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes-requested";
  if (decision === "REVIEW_REQUIRED") return "review-required";
  return "not-required";
}

function checksOf(rollup: CheckRollupItem[]): PullRequestStatus["checks"] {
  if (!rollup.length) return "none";
  const failed = rollup.some(
    (item) =>
      failedConclusions.includes(item.conclusion ?? "") ||
      failedStates.includes(item.state ?? ""),
  );
  if (failed) return "failing";
  const pending = rollup.some(
    (item) =>
      (item.status !== undefined && item.status !== "COMPLETED") ||
      pendingStates.includes(item.state ?? ""),
  );
  return pending ? "pending" : "passing";
}

/** GitHub's own view of mergeability, phrased as the next thing to do. */
function mergeBlocker(
  status: PullRequestStatus,
  mergeState: string | undefined,
  base: string,
): string | undefined {
  if (status.state === "merged") return "Already merged.";
  if (status.state === "closed") return "The pull request is closed.";
  if (status.draft) return "The pull request is still a draft.";
  if (status.review === "changes-requested")
    return "A reviewer requested changes.";
  if (status.review === "review-required")
    return "Waiting for an approving review.";
  if (status.checks === "failing") return "Checks are failing on GitHub.";
  if (status.checks === "pending") return "Checks are still running.";
  if (mergeState === "DIRTY")
    return `The branch has merge conflicts with ${base}.`;
  if (mergeState === "BEHIND")
    return `The branch is behind ${base}.`;
  if (mergeState === "BLOCKED")
    return "GitHub's branch rules are blocking the merge.";
  if (mergeState === "UNKNOWN")
    return "GitHub is still checking whether it can merge.";
  return undefined;
}
