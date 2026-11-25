import { z } from "zod";
import type { AppState, Epic, Project } from "../src/shared";
import type { RepositoryStatus } from "../src/branches";
import {
  detectBranchStrategy,

  primaryRemote,
  refExists,
  type BranchStrategy,
} from "./branch-strategy";
import { git } from "./local";

/**
 * Where a project's work branches from: its repository, the branch new work
 * starts from (worked out from the repository, or chosen), and a goal that has not
 * started going back to a fresh branch. Branches themselves are never deleted.
 */

type Register = (
  name: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
type DetectStrategy = (cwd: string) => Promise<BranchStrategy>;

const identifier = z.string().trim().min(1).max(250);
const branchName = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .regex(/^(?!-)[^\s~^:?*[\\]+$/, "Use a branch name.");

const GITHUB_REMOTE =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

/** A GitHub remote's repository page, from its https or ssh address. */
export function githubPage(remoteUrl: string): string | undefined {
  const match = remoteUrl.trim().match(GITHUB_REMOTE);
  return match ? `https://github.com/${match[1]}/${match[2]}` : undefined;
}

export function registerBranches(
  register: Register,
  state: () => AppState,
  changed: () => Promise<void>,
  detect: DetectStrategy = (cwd) => detectBranchStrategy(cwd),
): void {
  register(
    "project:repository",
    z.object({ projectId: identifier }).strict(),
    ({ projectId }) => repositoryStatus(projectNamed(state(), projectId), detect),
  );
  register(
    "project:base-branch",
    z.object({ projectId: identifier, branch: branchName.nullable() }).strict(),
    async ({ projectId, branch }) => {
      const project = projectNamed(state(), projectId);
      await chooseBaseBranch(project, branch);
      await changed();
      return repositoryStatus(project, detect);
    },
  );
  register(
    "goal:start-fresh",
    z
      .object({ id: identifier, baseBranch: branchName.nullable().optional() })
      .strict(),
    async ({ id, baseBranch }) => {
      await startGoalFresh(state(), id, baseBranch ?? null);
      await changed();
    },
  );
}

async function repositoryStatus(
  project: Project,
  detect: DetectStrategy,
): Promise<RepositoryStatus> {
  const folder = folderOf(project);
  const remote = await primaryRemote(folder);
  const address = remote
    ? await git(folder, ["remote", "get-url", remote]).catch(() => "")
    : "";
  const github = githubPage(address);
  const base = project.baseBranch
    ? { branch: project.baseBranch, chosen: true, reason: { kind: "chosen" as const } }
    : await detect(folder).then(({ base, reason }) => ({ branch: base, chosen: false, reason }));
  return {
    folder,
    ...(remote ? { remote } : {}),
    ...(github ? { github } : {}),
    base,
    branches: await branchNames(folder, remote),
  };
}

async function branchNames(
  folder: string,
  remote: string | undefined,
): Promise<string[]> {
  const listed = await git(folder, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    ...(remote ? [`refs/remotes/${remote}`] : []),
  ]);
  const names = listed
    .split("\n")
    .filter(Boolean)
    .filter((name) => name !== remote && !name.endsWith("/HEAD"))
    .map((name) =>
      remote && name.startsWith(`${remote}/`)
        ? name.slice(remote.length + 1)
        : name,
    );
  return [...new Set(names)].sort();
}

async function chooseBaseBranch(
  project: Project,
  branch: string | null,
): Promise<void> {
  if (branch === null) {
    delete project.baseBranch;
    return;
  }
  await requireBranch(project, branch);
  project.baseBranch = branch;
}

async function startGoalFresh(
  state: AppState,
  id: string,
  baseBranch: string | null,
): Promise<void> {
  const goal = state.epics.find((epic) => epic.id === id);
  if (!goal) throw Error("Goal not found.");
  if (goal.branch && hasStarted(state, goal))
    throw Error(
      `${goal.title} already has work on ${goal.branch}. Use Update from ${goal.baseBranch ?? "dev"} to bring in newer work.`,
    );
  if (baseBranch)
    await requireBranch(projectNamed(state, goal.projectId), baseBranch);
  delete goal.branch;
  delete goal.baseRevision;
  if (baseBranch) goal.baseBranch = baseBranch;
  else delete goal.baseBranch;
}

/** A goal has started once a worker has run one of its tasks. */
const hasStarted = (state: AppState, goal: Epic) =>
  state.tasks.some(
    (task) =>
      task.epicId === goal.id &&
      !!task.run.startedAt &&
      (!task.run.branch || task.run.branch === goal.branch),
  );

async function requireBranch(project: Project, branch: string): Promise<void> {
  const folder = folderOf(project);
  const remote = await primaryRemote(folder);
  const known =
    (await refExists(folder, `refs/heads/${branch}`)) ||
    (!!remote && (await refExists(folder, `refs/remotes/${remote}/${branch}`)));
  if (!known) throw Error(`${project.name} has no branch called ${branch}.`);
}

function projectNamed(state: AppState, id: string): Project {
  const project = state.projects.find((item) => item.id === id);
  if (!project) throw Error("Project not found.");
  return project;
}

function folderOf(project: Project): string {
  if (!project.path || project.example)
    throw Error("Choose a local project folder first.");
  return project.path;
}
