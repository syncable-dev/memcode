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
  type UnfinishedTask,
} from "../src/pull-request";
import {
  currentPullRequest,
  isOnBranch,
  isRunning,
  isUnfinished,
} from "../src/goal-work";
import { shipBranch } from "./goal-branch";
import {
  availableBranch,
  detectBranchStrategy,
  integrationCommit,
  isPushed,
  primaryRemote,
  refExists,
} from "./branch-strategy";
import { readWorkerChanges } from "./changes";
import { childEnv, findCommand, type Command } from "./commands";
import { epicBranch } from "./epic-workspace";
import { GitHubCli, pullRequestNumber } from "./github-cli";
import { bringIn, flagGoalsAfterMerge, stillResolving } from "./goal-updates";
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
        shipUnfinished: z.boolean().optional(),
      })
      .strict(),
    (input) => service.create(input),
  );
  register(
    "epic:open-pull-request",
    goal.extend({ url: z.string().min(1).max(2000).optional() }).strict(),
    (input) => service.openExisting(input.epicId, input.url),
  );
  register(
    "epic:notice-merges",
    z.object({ projectId: z.string().min(1).max(200) }).strict(),
    (input) =>
      service.noticeMerges((goal) => goal.projectId === input.projectId),
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
    const readiness = epicReadiness(state.tasks, epic);
    const existing = this.record(epic);
    const cli = existing ? await this.gitHub() : undefined;
    const status =
      cli && existing ? await this.look(cli, epic, existing) : undefined;
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
      unfinished: state.tasks
        .filter((task) => isOnBranch(task, epic) && isUnfinished(task))
        .map(unfinishedTask),
      openConflicts: receipt.openConflicts,
      existing,
      ...(status ? { status } : {}),
      blocker: epic.resolving
        ? stillResolving(epic.resolving)
        : blockerFor(facts, readiness.active, receipt.openConflicts),
      notice: facts.remote
        ? undefined
        : "This project has no remote, so MemCode stops after the commit. Add a GitHub remote to open pull requests from here.",
      steps: stepsFor(facts, existing, epic),
      title: text.title,
      description: text.pullRequest,
      commitMessage: text.commitMessage,
      attribution: state.settings.handoffAttribution ?? "ask",
    };
  }

  async create(input: CreatePullRequest): Promise<PullRequestResult> {
    const plan = await this.plan(input.epicId);
    if (plan.blocker) throw new Error(plan.blocker);
    if (plan.unfinished.length && !input.shipUnfinished)
      throw new Error(
        `${plan.unfinished.map((task) => task.identifier).join(", ")} ${plan.unfinished.length === 1 ? "has" : "have"} unfinished work in this branch. Finish it, or say yes to shipping it.`,
      );
    const { path } = this.target(input.epicId);
    const committed = plan.current && plan.uncommitted.length > 0;
    if (committed) await commitAll(path, input.commitMessage);
    if (plan.current) await this.bringInMerged(input.epicId, path, plan);
    if (plan.remote) plan.branch = await this.push(input.epicId, path, plan);
    const revision = await git(path, [
      "rev-parse",
      `refs/heads/${plan.branch}`,
    ]).catch(() => undefined);
    const opening = plan.remote
      ? await this.open(path, plan, input)
      : { opened: "none" as const };
    const pullRequest = this.remember(plan, opening, revision);
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

  /**
   * Pushes the branch. Someone with a project of their own can have pushed a branch of
   * the same name since this one was begun: theirs stays, and this one gets another.
   */
  private async push(
    epicId: string,
    path: string,
    plan: PullRequestPlan,
  ): Promise<string> {
    const remote = plan.remote!;
    const taken = plan.branch;
    try {
      await push(path, remote, taken);
      return taken;
    } catch (error) {
      const isOurs = await git(path, ["config", `branch.${taken}.remote`]).then(
        () => true,
        () => false,
      );
      if (isOurs || !(await isPushed(path, remote, taken))) throw error;
    }
    const state = this.deps.state();
    const free = await availableBranch(
      path,
      taken,
      remote,
      new Set(state.epics.flatMap((item) => item.branch ?? [])),
    );
    await git(path, ["branch", "-m", taken, free]);
    const { epic } = this.target(epicId);
    epic.branch = free;
    for (const task of state.tasks)
      if (task.epicId === epicId && task.run.branch === taken) {
        task.run.branch = free;
        if (task.run.sessionBinding?.branch === taken)
          task.run.sessionBinding.branch = free;
      }
    await this.deps.changed();
    await push(path, remote, free);
    return free;
  }

  /** Records merges that happened on GitHub since the last look. */
  async noticeMerges(
    isWanted: (goal: Epic) => boolean,
    /** A task about to start: it is not work on the branch that merged. */
    startingTaskId?: string,
  ): Promise<void> {
    const open = this.deps.state().epics.flatMap((epic) => {
      const record = isWanted(epic) ? this.record(epic) : undefined;
      return record && record.state !== "merged" ? [{ epic, record }] : [];
    });
    const cli = open.length ? await this.gitHub() : undefined;
    if (!cli) return;
    for (const { epic, record } of open)
      // One project's folder being gone does not stop the others.
      await this.look(cli, epic, record, startingTaskId).catch(() => {});
  }

  private async look(
    cli: GitHubCli,
    epic: Epic,
    record: EpicPullRequest,
    startingTaskId?: string,
  ) {
    const status = await cli.status(this.target(epic.id).path, record, record.base);
    const isEarlier =
      !record.number &&
      this.deps
        .state()
        .pullRequests?.some(
          (item) => item !== record && item.number === status?.number,
        );
    if (isEarlier || !status) return undefined;
    record.number ??= status.number;
    if (record.number === status.number) record.url = status.url;
    if (status.state === "merged" && record.state !== "merged")
      await this.finishMerge(epic, record, startingTaskId);
    return status;
  }

  /** Opens the goal's pull request, or an earlier one of it. */
  async openExisting(epicId: string, url?: string): Promise<void> {
    const record = url
      ? this.deps
          .state()
          .pullRequests?.find(
            (item) => item.epicId === epicId && item.url === url,
          )
      : this.record(this.target(epicId).epic);
    if (!record?.url)
      throw new Error(
        "This goal has no pull request yet. Create one when its tasks are ready.",
      );
    await this.deps.openUrl(record.url);
  }

  async merge(epicId: string): Promise<MergeResult> {
    const { epic, path } = this.target(epicId);
    const record = this.record(epic);
    if (!record) throw new Error("Create the pull request before merging it.");
    const cli = await this.gitHub();
    if (!cli)
      throw new Error(
        "Install the GitHub CLI (gh) and sign in to merge from MemCode. You can still merge on GitHub.",
      );
    const status = await cli.status(path, record, record.base);
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

  /** A branch ships: its reviewed tasks are done and goals sharing its files are told. */
  private async finishMerge(
    epic: Epic,
    record: EpicPullRequest,
    startingTaskId?: string,
  ): Promise<MergeResult> {
    const state = this.deps.state();
    const at = now();
    record.state = "merged";
    record.mergedAt = at;
    record.updatedAt = at;
    const shipped = { ...epic, branch: record.branch };
    const unpushed = await hasUnpushedWork(
      this.target(epic.id).path,
      record.branch,
    ).catch(() => false);
    await flagGoalsAfterMerge(state, shipped, record.base, this.readChanges());
    const completedStories = shipBranch(
      state,
      epic,
      record.branch,
      at,
      (task) =>
        task.id !== startingTaskId &&
        (isRunning(task) ||
          (unpushed && (task.run.finishedAt ?? "") > (record.pushedAt ?? at))),
    );
    record.tasks = completedStories;
    if (!epic.closedAt && epic.branch === record.branch)
      epic.mergedRevision = record.revision;
    await this.deps.changed();
    // The import can take a while; the merge result doesn't wait for it. A branch the
    // goal goes on working in keeps its checkout.
    if (epic.closedAt || epic.branch !== record.branch)
      void this.retire(epic, shipped, record.base);
    return { pullRequest: record, completedStories };
  }

  /** Tidies up the branch that shipped. The goal itself may be on a new one by then. */
  private async retire(epic: Epic, shipped: Epic, mergedInto: string): Promise<void> {
    const retire = this.deps.retireShippedGoal;
    if (!retire) return;
    const outcome = await retire(shipped, mergedInto).catch(
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
      (task) => isOnBranch(task, epic) && task.run.workspace,
    )?.run.workspace;
    return { epic, path: worktree ?? project.path };
  }

  private record(epic: Epic): EpicPullRequest | undefined {
    return currentPullRequest(this.deps.state().pullRequests, epic);
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

  /** A branch that goes on after its pull request merged needs the base it merged into. */
  private async bringInMerged(
    epicId: string,
    path: string,
    plan: PullRequestPlan,
  ): Promise<void> {
    const { epic } = this.target(epicId);
    if (!epic.mergedRevision) return;
    const target = await integrationCommit(path, plan);
    const conflicts = await bringIn(path, epic, target, plan.base);
    if (conflicts.length)
      throw new Error(
        `The work is saved on ${plan.branch}, but ${plan.base} changed the same lines in ${conflicts.join(", ")}. Ask the task's worker to bring in ${plan.base}, then try again.`,
      );
  }

  private remember(
    plan: PullRequestPlan,
    opening: Opening,
    revision?: string,
  ): EpicPullRequest {
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
      ...(plan.remote ? { pushedAt: at } : {}),
      ...(revision ? { revision } : {}),
      createdAt: plan.existing?.createdAt ?? at,
      updatedAt: at,
    };
    state.pullRequests = [
      ...(state.pullRequests ?? []).filter(
        (item) =>
          item.epicId !== plan.epicId ||
          item.branch !== plan.branch ||
          // A branch that goes on after a merge keeps that pull request's record.
          (item.state === "merged" && item.number !== record.number),
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

function unfinishedTask(task: WorkItem): UnfinishedTask {
  const { identifier, title } = task;
  if (task.run.state === "blocked") return { identifier, title, state: "waiting" };
  return {
    identifier,
    title,
    state: task.run.state === "failed" ? "failed" : "stopped",
  };
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
  existing: EpicPullRequest | undefined,
  epic: Epic,
): string[] {
  const steps: string[] = [];
  const files = facts.uncommitted.length;
  if (files)
    steps.push(
      `Commit ${files} ${files === 1 ? "file" : "files"} to ${facts.branch}`,
    );
  if (epic.mergedRevision && facts.current)
    steps.push(`Bring in ${facts.base}, with the pull request that merged`);
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

/** Files or commits on the branch here that its remote copy does not have. */
async function hasUnpushedWork(cwd: string, branch: string): Promise<boolean> {
  const current = (await git(cwd, ["branch", "--show-current"])) === branch;
  if (current && (await changedPaths(cwd)).length) return true;
  const tracking = `refs/remotes/${await primaryRemote(cwd)}/${branch}`;
  return (
    (await refExists(cwd, tracking)) &&
    (await commitsAhead(cwd, branch, tracking)) > 0
  );
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
