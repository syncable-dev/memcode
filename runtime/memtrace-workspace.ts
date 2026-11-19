import { createHash } from "node:crypto";
import {
  lstat,
  stat,
  realpath,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

async function isKind(path: string, kind: "file" | "directory") {
  try {
    const entry = await stat(path);
    return kind === "file" ? entry.isFile() : entry.isDirectory();
  } catch {
    return false;
  }
}

/**
 * An existing Folder Group claims normal Git repos directly beneath its marker.
 * This selects the MCP store/discovery owner only; indexing still uses project.path.
 * Do not infer scope from an unmarked ancestor, a nested repo, or a .git file
 * (linked worktree/submodule membership requires the engine's own explicit scope).
 */
export async function resolveMcpWorkspace(
  projectPath: string,
): Promise<{ directory: string; workspace?: string }> {
  let root: string;
  try {
    root = await realpath(projectPath);
  } catch {
    return { directory: projectPath };
  }
  if (await isKind(join(root, ".memtrace-workspace"), "file"))
    return { directory: root, workspace: root };
  const parent = dirname(root);
  if (
    parent !== root &&
    (await isKind(join(root, ".git"), "directory")) &&
    (await isKind(join(parent, ".memtrace-workspace"), "file"))
  )
    return { directory: parent, workspace: parent };
  return { directory: root };
}

export interface MemtraceScopeBinding {
  mode: "workspace" | "project";
  dataDirectory: string;
  workspaceFile?: string;
}

async function rejectRedirectedGraphPath(path: string): Promise<void> {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (entry?.isSymbolicLink())
    throw Error("The managed Memtrace graph cannot use a redirected path.");
}

async function managedProjectDirectory(root: string, checkout: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await rejectRedirectedGraphPath(root);
  const key = createHash("sha256")
    .update(admissionPath(checkout))
    .digest("hex")
    .slice(0, 32);
  return join(await realpath(root), key);
}

async function ensureProjectManifest(workspaceFile: string, expected: string) {
  try {
    await writeFile(workspaceFile, expected, { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await rejectRedirectedGraphPath(workspaceFile);
  if ((await readFile(workspaceFile, "utf8")) !== expected)
    throw Error(
      "The MemCode project workspace manifest has changed. Review its repository membership before reconnecting.",
    );
}

function singleMemberManifest(directory: string, ownedWorktree = false) {
  return `version = 1\n${ownedWorktree ? 'checkout_mode = "owned-worktree-v1"\n' : ""}name = "MemCode project"\nmembers = [${JSON.stringify(directory.replaceAll("\\", "/"))}]\n`;
}

export async function projectMcpWorkspace(
  projectPath: string,
  options: {
    checkoutMode?: "owned-worktree-v1";
    managedGraphRoot?: string;
  } = {},
) {
  const directory = await realpath(projectPath);
  const ownedWorktree = options.checkoutMode === "owned-worktree-v1";
  // Owned epic manifests must remain underneath the linked checkout. The
  // managed primary graph lives in the profile so a standalone CLI can keep
  // its existing checkout-local graph and indexing history.
  const managedRoot = ownedWorktree ? undefined : options.managedGraphRoot;
  const graphDirectory = managedRoot
    ? await managedProjectDirectory(managedRoot, directory)
    : directory;
  const anchor = join(graphDirectory, ".memcode", "memtrace");
  const workspaceFile = join(anchor, "workspace.toml");
  const dataDirectory = join(anchor, ".memdb");
  const jobDirectory = join(anchor, ".memtrace");
  const expected = singleMemberManifest(directory, ownedWorktree);
  if (managedRoot) {
    for (const path of [
      graphDirectory,
      dirname(anchor),
      anchor,
      workspaceFile,
      dataDirectory,
      jobDirectory,
    ])
      await rejectRedirectedGraphPath(path);
  }
  await mkdir(anchor, { recursive: true, mode: 0o700 });
  if (managedRoot) await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await ensureProjectManifest(workspaceFile, expected);
  return {
    directory,
    workspaceFile,
    dataDirectory,
    jobDirectory,
  };
}

const connectionOverrides = [
  "MEMTRACE_MEMDB_DATA_DIR",
  "MEMTRACE_DATA_DIR",
  "MEMTRACE_MEMDB_MODE",
  "MEMTRACE_MEMDB_ENDPOINT",
  "MEMTRACE_MEMDB_ENDPOINTS",
  "MEMTRACE_MEMDB_DB",
  "MEMTRACE_HOSTED_MODE",
  "MEMTRACE_WORKSPACE_ROOT",
  "CURSOR_WORKSPACE_ROOT",
  "VSCODE_WORKSPACE_FOLDER",
  "WORKSPACE_FOLDER_PATHS",
];

async function hasSingleFolderMember(directory: string, scopeFile: string) {
  const bytes = await readFile(scopeFile, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (bytes === null) return false;
  const scope = JSON.parse(bytes);
  if (
    scope?.version !== 1 ||
    scope.scope_source?.kind !== "folder" ||
    !Array.isArray(scope.members) ||
    scope.members.length !== 1
  )
    return false;
  const member = scope.members[0]?.path;
  if (
    typeof member !== "string" ||
    admissionPath(member) !== admissionPath(directory)
  )
    throw Error(
      "The standalone Memtrace store belongs to a different checkout.",
    );
  return true;
}

async function assertProfileOutsideGit(directory: string) {
  for (let path = directory; ; path = dirname(path)) {
    if (
      await lstat(join(path, ".git")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      })
    )
      throw Error(
        "The standalone Memtrace workspace needs a profile folder outside source repositories.",
      );
    if (dirname(path) === path) return;
  }
}

/** Keep both physical store and job history when an epic opens a linked worktree. */
export async function standaloneMcpWorkspace(
  directory: string,
  profileRoot: string,
  env: Record<string, string>,
) {
  if (connectionOverrides.some((key) => env[key])) return null;
  const jobDirectory = join(directory, ".memtrace");
  if (
    !(await lstat(join(directory, ".git")).catch(() => null))?.isDirectory() ||
    (await isKind(join(jobDirectory, "team.toml"), "file"))
  )
    return null;
  const dataDirectory = join(directory, ".memdb");
  const scopeFile = join(dataDirectory, ".memtrace-store-scope.json");
  for (const path of [dataDirectory, jobDirectory, scopeFile])
    await rejectRedirectedGraphPath(path);
  if (!(await hasSingleFolderMember(directory, scopeFile))) return null;
  const bindingRoot = await managedProjectDirectory(profileRoot, directory);
  // The native stdio client elects owners by its working directory. Its
  // launch folder must not resolve to the canonical Git checkout of an epic.
  await assertProfileOutsideGit(bindingRoot);
  await rejectRedirectedGraphPath(bindingRoot);
  await mkdir(bindingRoot, { recursive: true, mode: 0o700 });
  const workspaceFile = join(bindingRoot, "standalone-workspace.toml");
  await ensureProjectManifest(workspaceFile, singleMemberManifest(directory));
  return { workspaceFile, dataDirectory, jobDirectory };
}

export class MemtraceAdmissionError extends Error {}

/** Wait for an unbound startup record; never reinterpret it as a repo. */
export async function waitForPrivateRepositoryDiscovery(
  initial: any,
  scope: Awaited<ReturnType<typeof projectMcpWorkspace>> | null,
  read: () => Promise<any>,
  update: (note: string) => void,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    isCancelled?: () => boolean;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<any> {
  const pending = (value: any) => {
    const rows = Array.isArray(value) ? value : value?.repos;
    if (!scope || !Array.isArray(rows) || rows.length !== 1) return false;
    const row = rows[0];
    return (
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      row.path == null &&
      row.repo_path == null &&
      !(
        row.ingestion_path === "episode_only" &&
        typeof row.repo_id === "string" &&
        row.repo_id.trim()
      )
    );
  };
  const now = options.now ?? Date.now,
    sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    deadline = now() + (options.timeoutMs ?? 10_000);
  const active = () => {
    if (options.isCancelled?.())
      throw Error("The Memtrace connection is closing.");
  };
  let value = initial;
  while (pending(value)) {
    active();
    if (now() >= deadline)
      throw new MemtraceAdmissionError(
        "Memtrace's local project discovery is not ready. Retry when preparation completes; no repository was adopted or indexed.",
      );
    update("Preparing local code context · waiting for project discovery…");
    await sleep(Math.min(options.pollMs ?? 250, Math.max(0, deadline - now())));
    active();
    if (now() >= deadline) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      value = await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new MemtraceAdmissionError(
                  "Memtrace's local project discovery did not respond before its deadline. No repository was adopted or indexed.",
                ),
              ),
            Math.max(1, deadline - now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    active();
  }
  return value;
}

const admissionPath = (value: string) => {
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

/** A native owner can publish an Episode before its Repository/path row exists. */
export async function admitPrivateEpisodeRepository(
  repos: unknown[],
  scope: Awaited<ReturnType<typeof projectMcpWorkspace>> | null,
  branch: string,
  read: (
    name: "get_repository_stats" | "get_query_revision",
    args: { repo_id: string; branch: string },
  ) => Promise<Record<string, any>>,
): Promise<Record<string, any> | null> {
  // This exception is confined to the app-created, exact one-member private
  // workspace. Never adopt an arbitrary pathless row or infer membership by name.
  if (!scope || !branch || repos.length !== 1) return null;
  const repo = repos[0] as Record<string, any> | null;
  if (
    !repo ||
    typeof repo !== "object" ||
    repo.ingestion_path !== "episode_only" ||
    repo.path != null ||
    repo.repo_path != null ||
    typeof repo.repo_id !== "string" ||
    !repo.repo_id.trim() ||
    repo.repo_id.length > 500
  )
    return null;
  const args = { repo_id: repo.repo_id, branch };
  const stats = await read("get_repository_stats", args);
  if (
    stats?.repo_in_store !== true ||
    stats?.diagnostic?.kind === "wrong_store" ||
    (stats.repo_id != null && stats.repo_id !== repo.repo_id)
  )
    return null;
  for (const path of [stats.path, stats.repo_path]) {
    if (
      path != null &&
      (typeof path !== "string" ||
        admissionPath(path) !== admissionPath(scope.directory))
    )
      return null;
  }
  const revision = await read("get_query_revision", args);
  if (
    typeof revision?.worktree !== "string" ||
    admissionPath(revision.worktree) !== admissionPath(scope.directory) ||
    revision.branch !== branch ||
    (revision.repo_id != null && revision.repo_id !== repo.repo_id)
  )
    return null;
  // A partial revision proves only the selected source binding, never index
  // readiness. analyze() must still verify the complete source/index certificate.
  return repo;
}

/** The SDK merges an inherited uppercase PATH; Windows must receive one spelling. */
export function normalizeMcpEnvironment(
  input: Record<string, string>,
): Record<string, string> {
  const env = { ...input };
  const key =
    Object.keys(env).find((key) => key === "PATH") ??
    Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const value = key ? env[key] : undefined;
  for (const key of Object.keys(env))
    if (key.toUpperCase() === "PATH") delete env[key];
  if (value !== undefined) env.PATH = value;
  return env;
}
