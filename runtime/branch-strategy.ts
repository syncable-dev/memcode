import { childEnv, findCommand, type Command } from "./commands";
import { exec, git } from "./local";

/** Where new work starts and how the team names its branches. */
export interface BranchStrategy {
  base: string;
  remote?: string;
  featurePrefix: string;
  fixPrefix: string;
}
export interface MergedBranch {
  base: string;
  head: string;
}
export interface BranchHistory {
  defaultBranch?: string;
  branches: string[];
  merged: MergedBranch[];
}
type FindGitHubCli = () => Promise<Command | null>;

const integrationBranches = [
  "develop",
  "development",
  "dev",
  "staging",
  "main",
  "master",
  "trunk",
];
const integrationWithoutHistory = ["develop", "development", "dev"];
const featureFamilies = ["feat", "feature", "features"];
const fixFamilies = ["fix", "bugfix", "bug"];
const nonWorkBranch = /^(release|hotfix|epic|memcode)\//;
const historyLimit = "200";
const branchNameLimit = 60;
const networkTimeoutMs = 30_000;

export function inferBranchStrategy(
  history: BranchHistory,
): Omit<BranchStrategy, "remote"> {
  const work = history.merged.filter((merge) => isWorkBranch(merge.head));
  const names = [
    ...work.map((merge) => merge.head),
    ...history.branches.filter(isWorkBranch),
  ];
  return {
    base:
      mostCommon(work.map((merge) => merge.base), integrationBranches) ??
      baseWithoutHistory(history),
    featurePrefix: commonPrefix(names, featureFamilies) ?? "feat/",
    fixPrefix: commonPrefix(names, fixFamilies) ?? "fix/",
  };
}

export function goalBranchName(
  strategy: Pick<BranchStrategy, "featurePrefix">,
  title: string,
): string {
  return branchName(strategy.featurePrefix, title);
}

export function quickChangesBranchName(
  strategy: Pick<BranchStrategy, "featurePrefix">,
  day: Date,
): string {
  return branchName(
    strategy.featurePrefix,
    `quick-changes-${day.toISOString().slice(0, 10)}`,
  );
}

/** New work never picks up an old branch: a taken name gets a numeric suffix. */
export async function availableBranch(
  cwd: string,
  name: string,
  remote?: string,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const candidate = attempt === 1 ? name : `${name}-${attempt}`;
    const taken =
      (await refExists(cwd, `refs/heads/${candidate}`)) ||
      (!!remote && (await refExists(cwd, `refs/remotes/${remote}/${candidate}`)));
    if (!taken) return candidate;
  }
}

/** Reads the convention from merged pull requests, falling back to merge commits. */
export async function detectBranchStrategy(
  cwd: string,
  findGitHubCli: FindGitHubCli = () => findCommand("gh"),
): Promise<BranchStrategy> {
  const remote = await primaryRemote(cwd);
  const branches = await branchNames(cwd, remote);
  const merged =
    (await mergedPullRequests(cwd, findGitHubCli)) ??
    (await mergeCommits(cwd, remote, branches));
  const defaultBranch = remote ? await remoteDefault(cwd, remote) : undefined;
  return {
    ...inferBranchStrategy({ defaultBranch, branches, merged }),
    ...(remote ? { remote } : {}),
  };
}

/** The commit new work starts from: the remote's integration branch when reachable. */
export async function integrationCommit(
  cwd: string,
  strategy: BranchStrategy,
): Promise<string> {
  if (strategy.remote) {
    await fetchBranch(cwd, strategy.remote, strategy.base);
    const tracking = `refs/remotes/${strategy.remote}/${strategy.base}`;
    if (await refExists(cwd, tracking))
      return git(cwd, ["rev-parse", tracking]);
  }
  const local = `refs/heads/${strategy.base}`;
  if (await refExists(cwd, local)) return git(cwd, ["rev-parse", local]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

export async function primaryRemote(cwd: string): Promise<string | undefined> {
  const remotes = (await git(cwd, ["remote"])).split("\n").filter(Boolean);
  return remotes.includes("origin") ? "origin" : remotes[0];
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  return git(cwd, ["show-ref", "--verify", "--quiet", ref]).then(
    () => true,
    () => false,
  );
}

function isWorkBranch(name: string): boolean {
  return !integrationBranches.includes(name) && !nonWorkBranch.test(name);
}

function baseWithoutHistory(history: BranchHistory): string {
  const integration = integrationWithoutHistory.find((name) =>
    history.branches.includes(name),
  );
  if (integration) return integration;
  if (history.defaultBranch) return history.defaultBranch;
  return history.branches.includes("master") &&
    !history.branches.includes("main")
    ? "master"
    : "main";
}

function mostCommon(
  values: string[],
  preference: string[],
): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const rank = (value: string) => {
    const index = preference.indexOf(value);
    return index < 0 ? preference.length : index;
  };
  return [...counts]
    .sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]))
    .at(0)?.[0];
}

function commonPrefix(names: string[], families: string[]): string | undefined {
  const used = names
    .map((name) => name.split("/")[0])
    .filter((first, index) => names[index].includes("/") && families.includes(first));
  const family = mostCommon(used, families);
  return family ? family + "/" : undefined;
}

function branchName(prefix: string, words: string): string {
  const stem = words
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return prefix + clippedAtWord(stem, branchNameLimit - prefix.length);
}

function clippedAtWord(stem: string, limit: number): string {
  if (stem.length <= limit) return stem;
  const clipped = stem.slice(0, limit);
  const boundary = clipped.lastIndexOf("-");
  return (boundary > 0 ? clipped.slice(0, boundary) : clipped).replace(
    /-+$/,
    "",
  );
}

async function branchNames(cwd: string, remote?: string): Promise<string[]> {
  const namespace = remote ? `refs/remotes/${remote}/` : "refs/heads/";
  const refs = await git(cwd, ["for-each-ref", "--format=%(refname)", namespace]);
  return refs
    .split("\n")
    .filter(Boolean)
    .map((ref) => ref.slice(namespace.length))
    .filter((name) => name !== "HEAD");
}

async function remoteDefault(
  cwd: string,
  remote: string,
): Promise<string | undefined> {
  const head = await git(cwd, [
    "symbolic-ref",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  ]).catch(() => "");
  return head.startsWith(remote + "/")
    ? head.slice(remote.length + 1)
    : undefined;
}

async function mergedPullRequests(
  cwd: string,
  findGitHubCli: FindGitHubCli,
): Promise<MergedBranch[] | undefined> {
  const cli = await findGitHubCli().catch(() => null);
  if (!cli) return undefined;
  try {
    const { stdout } = await exec(
      cli.command,
      [
        ...cli.prefix,
        "pr",
        "list",
        "--state",
        "merged",
        "--limit",
        "50",
        "--json",
        "baseRefName,headRefName",
      ],
      {
        cwd,
        windowsHide: true,
        encoding: "utf8",
        timeout: networkTimeoutMs,
        env: { ...childEnv(), ...cli.env, GH_PROMPT_DISABLED: "1" },
      },
    );
    const merged = (
      JSON.parse(stdout) as Array<{ baseRefName: string; headRefName: string }>
    ).map((item) => ({ base: item.baseRefName, head: item.headRefName }));
    return merged.length ? merged : undefined;
  } catch {
    return undefined;
  }
}

async function mergeCommits(
  cwd: string,
  remote: string | undefined,
  branches: string[],
): Promise<MergedBranch[]> {
  const merged: MergedBranch[] = [];
  for (const base of branches.filter((name) =>
    integrationBranches.includes(name),
  )) {
    const ref = remote ? `refs/remotes/${remote}/${base}` : `refs/heads/${base}`;
    const subjects = await git(cwd, [
      "log",
      "--merges",
      "--format=%s",
      "-n",
      historyLimit,
      ref,
    ]).catch(() => "");
    for (const subject of subjects.split("\n"))
      merged.push(...mergedBranchFrom(subject, base));
  }
  return merged;
}

function mergedBranchFrom(subject: string, base: string): MergedBranch[] {
  const pullRequest = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(
    subject,
  );
  if (pullRequest) return [{ base, head: pullRequest[1] }];
  const branch =
    /^Merge branch '([^']+)'(?: of \S+)?(?: into (\S+))?/.exec(subject) ??
    /^Merge remote-tracking branch '[^/']+\/([^']+)'(?: into (\S+))?/.exec(
      subject,
    );
  if (branch) return [{ base: branch[2] ?? base, head: branch[1] }];
  return [];
}

/** Fetches one branch from a remote, giving up quietly when the network does not answer. */
export async function fetchBranch(cwd: string, remote: string, branch: string) {
  await exec("git", ["fetch", "--quiet", remote, branch], {
    cwd,
    windowsHide: true,
    timeout: networkTimeoutMs,
    env: { ...childEnv(), GIT_TERMINAL_PROMPT: "0" },
  }).catch(() => undefined);
}
