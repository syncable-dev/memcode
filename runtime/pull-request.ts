import { z } from "zod";
import type { AppState, Epic, Project, WorkItem } from "../src/shared";
import type { WorkerChanges } from "../src/changes";
import {
  epicReadiness,
  type CreatePullRequest,
  type EpicPullRequest,
  type GitHubRepository,
  type MergeResult,
  type PullRequestPlan,
  type PullRequestResult,
} from "../src/pull-request";
import {
  detectBranchStrategy,
  primaryRemote,
  refExists,
} from "./branch-strategy";
import { readWorkerChanges } from "./changes";
import { childEnv, findCommand, type Command } from "./commands";
import { epicBranch } from "./epic-workspace";
import { GitHubCli, pullRequestNumber } from "./github-cli";
import { flagGoalsAfterMerge } from "./goal-updates";
import {
  collectEpicReceipt,
  composeEpicHandoff,
  handoffCredit,
} from "./handoff";
import { exec, git, now } from "./local";
import type { CheckoutOutcome } from "./shipped-goal";
import { withTemporaryFile } from "./temporary-file";

type Register = (
  method: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;

export interface PullRequestDependencies {
  state: () => AppState;
  changed: () => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  findGitHubCli?: () => Promise<Command | null>;
  readChanges?: (task: WorkItem) => Promise<WorkerChanges>;
  /** After a merge: add the goal's history to the project's index and remove its checkout. */
  retireShippedGoal?: (goal: Epic, mergedInto: string) => Promise<CheckoutOutcome>;
}

interface RepositoryFacts {
  branch: string;
  exists: boolean;
  current: boolean;
  remote?: string;
  github?: GitHubRepository;
  base: string;
  uncommitted: string[];
  ahead: number;
}

interface Opening {
  opened: PullRequestResult["opened"];
  url?: string;
  descriptionOmitted?: boolean;
}

const networkTimeoutMs = 120_000;
const compareUrlLimit = 6000;
const githubRemote =
  /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export function registerPullRequests(
  register: Register,
  service: PullRequestService,
) {
  const epicId = z.string().min(1).max(200);
  const goal = z.object({ epicId }).strict();
  register("epic:pull-request-plan", goal, (input) => service.plan(input.epicId));
  register(
    "epic:create-pull-request",
    z
      .object({
        epicId,
        title: z.string().trim().min(1).max(256),
        description: z.string().max(60_000),
        commitMessage: z.string().trim().min(1).max(20_000),
      })
      .strict(),
    (input) => service.create(input),
  );
  register("epic:open-pull-request", goal, (input) =>
    service.openExisting(input.epicId),
  );
  register("epic:merge-pull-request", goal, (input) =>
    service.merge(input.epicId),
  );
}

export function createPullRequestService(deps: PullRequestDependencies) {
  return new PullRequestService(deps);
}

/** Commits, pushes, opens and merges a goal's PR, only when the person clicks. */
export class PullRequestService {
  constructor(private deps: PullRequestDependencies) {}

  /** Also records a merge that happened on GitHub since the last look. */
  async plan(epicId: string): Promise<PullRequestPlan> {
    const state = this.deps.state();
    const { epic, path } = this.target(epicId);
    const facts = await inspectRepository(path, epic, this.findCli());
    const receipt = await collectEpicReceipt(state, epicId, this.readChanges());
    const text = composeEpicHandoff(receipt, handoffCredit(state.settings));
    const readiness = epicReadiness(state.tasks, epicId);
    const existing = state.pullRequests?.find((item) => item.epicId === epicId);
    const cli = existing ? await this.gitHub() : undefined;
    const status = cli && existing
      ? await cli.status(path, existing.branch, existing.base)
      : undefined;
    if (status?.state === "merged" && existing?.state !== "merged")
      await this.finishMerge(epic, existing!);
    return {
      epicId,
      branch: facts.branch,
      base: facts.base,
      current: facts.current,
      uncommitted: facts.uncommitted,
      ahead: facts.ahead,
      remote: facts.remote,
      github: facts.github,
      readiness,
      openConflicts: receipt.openConflicts,
      existing,
      ...(status ? { status } : {}),
      blocker: blockerFor(facts, readiness.active, receipt.openConflicts),
      notice: facts.remote
        ? undefined
        : "This project has no remote, so MemCode stops after the commit. Add a GitHub remote to open pull requests from here.",
      steps: stepsFor(facts, existing),
      title: text.title,
      description: text.pullRequest,
      commitMessage: text.commitMessage,
      attribution: state.settings.handoffAttribution ?? "ask",
    };
  }

  async create(input: CreatePullRequest): Promise<PullRequestResult> {
    const plan = await this.plan(input.epicId);
    if (plan.blocker) throw new Error(plan.blocker);
    const { path } = this.target(input.epicId);
    const committed = plan.current && plan.uncommitted.length > 0;
    if (committed) await commitAll(path, input.commitMessage);
    if (plan.remote) await push(path, plan.remote, plan.branch);
    const opening = plan.remote
      ? await this.open(path, plan, input)
      : { opened: "none" as const };
    const pullRequest = this.remember(plan, opening);
    this.confirmAttributionDefault();
    await this.deps.changed();
    return {
      pullRequest,
      committed,
      pushed: !!plan.remote,
      opened: opening.opened,
      ...(opening.descriptionOmitted ? { descriptionOmitted: true } : {}),
    };
  }

  async openExisting(epicId: string): Promise<void> {
    const record = this.record(epicId);
    if (!record?.url)
      throw new Error(
        "This goal has no pull request yet. Create one when its tasks are ready.",
      );
    await this.deps.openUrl(record.url);
  }

  async merge(epicId: string): Promise<MergeResult> {
    const { epic, path } = this.target(epicId);
    const record = this.record(epicId);
    if (!record) throw new Error("Create the pull request before merging it.");
    const cli = await this.gitHub();
    if (!cli)
      throw new Error(
        "Install the GitHub CLI (gh) and sign in to merge from MemCode. You can still merge on GitHub.",
      );
    const status = await cli.status(path, record.branch, record.base);
    if (!status)
      throw new Error(
        "GitHub didn't return this pull request. Check that gh is signed in to the right account.",
      );
    if (status.state !== "merged") {
      if (status.mergeBlocker) throw new Error(status.mergeBlocker);
      await cli.merge(path, status.number, status.mergeMethod ?? "merge");
    }
    return this.finishMerge(epic, record);
  }

  /** A shipped goal closes; its reviewed tasks are done; goals sharing its files are told. */
  private async finishMerge(
    epic: Epic,
    record: EpicPullRequest,
  ): Promise<MergeResult> {
    const state = this.deps.state();
    const at = now();
    record.state = "merged";
    record.mergedAt = at;
    record.updatedAt = at;
    epic.closedAt ??= at;
    let completedStories = 0;
    for (const task of state.tasks)
      if (task.epicId === epic.id && task.stage === "review") {
        task.stage = "done";
        task.updatedAt = at;
        completedStories++;
      }
    await flagGoalsAfterMerge(state, epic, record.base, this.readChanges());
    await this.deps.changed();
    // The import can take a while; the merge result doesn't wait for it.
    void this.retire(epic, record.base);
    return { pullRequest: record, completedStories };
  }

  private async retire(epic: Epic, mergedInto: string): Promise<void> {
    const retire = this.deps.retireShippedGoal;
    if (!retire) return;
    const outcome = await retire(epic, mergedInto).catch(
      (error: Error): CheckoutOutcome => ({ kind: "kept", reason: error.message }),
    );
    if (outcome.kind === "kept") epic.checkoutKept = outcome.reason;
    else delete epic.checkoutKept;
    await this.deps.changed();
  }

  private target(epicId: string): { epic: Epic; path: string } {
    const state = this.deps.state();
    const epic = state.epics.find((item) => item.id === epicId);
    if (!epic) throw new Error("Goal not found.");
    const project = state.projects.find(
      (item: Project) => item.id === epic.projectId,
    );
    if (!project?.path) throw new Error("Choose a local project folder first.");
    const worktree = state.tasks.find(
      (task) => task.epicId === epicId && task.run.workspace,
    )?.run.workspace;
    return { epic, path: worktree ?? project.path };
  }

  private record(epicId: string): EpicPullRequest | undefined {
    return this.deps.state().pullRequests?.find((item) => item.epicId === epicId);
  }

  private findCli(): () => Promise<Command | null> {
    return this.deps.findGitHubCli ?? (() => findCommand("gh"));
  }

  private async gitHub(): Promise<GitHubCli | undefined> {
    const cli = await this.findCli()().catch(() => null);
    return cli ? new GitHubCli(cli) : undefined;
  }

  private readChanges() {
    return this.deps.readChanges ?? readWorkerChanges;
  }

  private async open(
    cwd: string,
    plan: PullRequestPlan,
    input: CreatePullRequest,
  ): Promise<Opening> {
    const created = await this.openWithCli(cwd, plan, input).catch(
      () => undefined,
    );
    if (created) return created;
    if (!plan.github) return { opened: "none" };
    const page = compareUrl(
      plan.github,
      plan.base,
      plan.branch,
      input.title,
      input.description,
    );
    await this.deps.openUrl(page.url);
    return {
      opened: "browser",
      url: page.url,
      descriptionOmitted: page.descriptionOmitted,
    };
  }

  private async openWithCli(
    cwd: string,
    plan: PullRequestPlan,
    input: CreatePullRequest,
  ): Promise<Opening | undefined> {
    const cli = await this.gitHub();
    if (!cli) return undefined;
    const existing = await cli.existingUrl(cwd, plan.branch);
    if (existing) return { opened: "existing", url: existing };
    const url = await cli.create(cwd, {
      base: plan.base,
      head: plan.branch,
      title: input.title,
      body: input.description,
    });
    return url ? { opened: "created", url } : undefined;
  }

  private remember(plan: PullRequestPlan, opening: Opening): EpicPullRequest {
    const state = this.deps.state();
    const at = now();
    const url = opening.url ?? plan.existing?.url;
    const number = url ? pullRequestNumber(url) : undefined;
    const record: EpicPullRequest = {
      epicId: plan.epicId,
      branch: plan.branch,
      base: plan.base,
      ...(url ? { url } : {}),
      ...(number ? { number, state: "open" as const } : {}),
      createdAt: plan.existing?.createdAt ?? at,
      updatedAt: at,
    };
    state.pullRequests = [
      ...(state.pullRequests ?? []).filter(
        (item) => item.epicId !== plan.epicId,
      ),
      record,
    ];
    return record;
  }

  /** The sheet shows the MemCode line checked until the person unchecks it. */
  private confirmAttributionDefault() {
    const settings = this.deps.state().settings;
    if (!settings.handoffAttribution || settings.handoffAttribution === "ask")
      settings.handoffAttribution = "include";
  }
}

export function githubRepository(
  remoteUrl: string,
): GitHubRepository | undefined {
  const match = githubRemote.exec(remoteUrl.trim());
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

export function compareUrl(
  repository: GitHubRepository,
  base: string,
  branch: string,
  title: string,
  description: string,
): { url: string; descriptionOmitted: boolean } {
  const page = `https://github.com/${repository.owner}/${repository.repo}/compare/${refPath(base)}...${refPath(branch)}`;
  const full = `${page}?${new URLSearchParams({ expand: "1", title, body: description })}`;
  if (full.length <= compareUrlLimit)
    return { url: full, descriptionOmitted: false };
  return {
    url: `${page}?${new URLSearchParams({ expand: "1", title })}`,
    descriptionOmitted: true,
  };
}

function refPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function blockerFor(
  facts: RepositoryFacts,
  activeStories: number,
  openConflicts: number,
): string | undefined {
  if (!facts.exists) return "No task in this goal has run yet.";
  if (activeStories)
    return activeStories === 1
      ? "Wait for 1 running task to finish, or stop it."
      : `Wait for ${activeStories} running tasks to finish, or stop them.`;
  if (openConflicts)
    return openConflicts === 1
      ? "Resolve 1 open Fleet decision first."
      : `Resolve ${openConflicts} open Fleet decisions first.`;
  if (!facts.uncommitted.length && !facts.ahead)
    return `There are no changes on ${facts.branch} yet.`;
  return undefined;
}

function stepsFor(
  facts: RepositoryFacts,
  existing?: EpicPullRequest,
): string[] {
  const steps: string[] = [];
  const files = facts.uncommitted.length;
  if (files)
    steps.push(
      `Commit ${files} ${files === 1 ? "file" : "files"} to ${facts.branch}`,
    );
  if (!facts.remote) return steps;
  steps.push(`Push ${facts.branch} to ${facts.remote}`);
  if (!facts.github) steps.push("Copy the description for your Git host");
  else if (existing?.url) steps.push("Update the open pull request");
  else steps.push("Open the pull request on GitHub");
  return steps;
}

async function inspectRepository(
  cwd: string,
  epic: Epic,
  findCli: () => Promise<Command | null>,
): Promise<RepositoryFacts> {
  const branch = epic.branch ?? epicBranch(epic);
  const exists = await refExists(cwd, `refs/heads/${branch}`);
  const current = (await git(cwd, ["branch", "--show-current"])) === branch;
  const remote = await primaryRemote(cwd);
  const remoteUrl = remote
    ? await git(cwd, ["remote", "get-url", remote])
    : undefined;
  const base =
    epic.baseBranch ?? (await detectBranchStrategy(cwd, findCli)).base;
  return {
    branch,
    exists,
    current,
    remote,
    github: remoteUrl ? githubRepository(remoteUrl) : undefined,
    base,
    uncommitted: current ? await changedPaths(cwd) : [],
    ahead: exists
      ? await commitsAhead(cwd, branch, await baseRef(cwd, remote, base, epic))
      : 0,
  };
}

async function baseRef(
  cwd: string,
  remote: string | undefined,
  base: string,
  epic: Epic,
): Promise<string | undefined> {
  const candidates = [
    ...(remote ? [`refs/remotes/${remote}/${base}`] : []),
    `refs/heads/${base}`,
  ];
  for (const ref of candidates) if (await refExists(cwd, ref)) return ref;
  return epic.baseRevision;
}

async function commitsAhead(
  cwd: string,
  branch: string,
  base?: string,
): Promise<number> {
  if (!base) return 0;
  const count = await git(cwd, [
    "rev-list",
    "--count",
    `${base}..refs/heads/${branch}`,
  ]).catch(() => "0");
  return Number(count) || 0;
}

/** Porcelain output keeps its leading status columns, so it is not trimmed. */
async function changedPaths(cwd: string): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd, windowsHide: true, encoding: "utf8", env: childEnv() },
  );
  const entries = stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") index++;
  }
  return paths;
}

async function commitAll(cwd: string, message: string) {
  await git(cwd, ["add", "-A"]);
  await withTemporaryFile(message.trimEnd() + "\n", (file) =>
    git(cwd, ["commit", "-F", file]),
  );
}

async function push(cwd: string, remote: string, branch: string) {
  try {
    await exec("git", ["push", "-u", remote, branch], {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      timeout: networkTimeoutMs,
      env: { ...childEnv(), GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? "")
      .trim()
      .split("\n")
      .pop();
    throw new Error(
      `The commit is saved locally, but pushing ${branch} to ${remote} failed${detail ? `: ${detail}` : "."} Check your Git credentials and try again.`,
    );
  }
}
