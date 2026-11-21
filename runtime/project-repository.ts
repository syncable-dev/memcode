import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Project } from "../src/shared";
import { git } from "./local";

const exclusions = ["/.memcode/", "/.memdb/", "/.memtrace/"];
const exclusionWrites = new Map<string, Promise<void>>();

/** Git-local metadata only; call before creating any project runtime stores. */
export async function ensureLocalRuntimeIgnored(root: string): Promise<void> {
  // Git resolves the common metadata directory for linked worktrees too.
  const gitPath = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
  const path = isAbsolute(gitPath) ? gitPath : resolve(root, gitPath);
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  const previous = exclusionWrites.get(key);
  if (previous) return previous;
  const pending = (async () => {
    let existing = "";
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink())
        throw Error(
          "Git’s local exclusion file must be a regular file before MemCode can prepare runtime storage.",
        );
      existing = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lines = new Set(existing.split(/\r?\n/));
    const missing = exclusions.filter((entry) => !lines.has(entry));
    if (!missing.length) return;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      `${existing.endsWith("\n") || !existing ? "" : "\n"}# MemCode local runtime stores and worker output\n${missing.join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  })();
  exclusionWrites.set(key, pending);
  try {
    await pending;
  } finally {
    if (exclusionWrites.get(key) === pending) exclusionWrites.delete(key);
  }
}

/** Empty folders opened as projects need the same foundation as a new project. */
export async function ensureProjectRepository(
  project: Project,
  signal?: AbortSignal,
): Promise<void> {
  if (!project.path) throw Error("Choose a local project folder first.");
  const path = project.path;
  let root: string | undefined;
  try {
    root = await git(path, ["rev-parse", "--show-toplevel"]);
  } catch {
    // A genuinely empty folder can be safely initialized without adopting files.
  }
  if (root) {
    const [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(root),
      realpath(path),
    ]);
    const identity = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    if (identity(canonicalRoot) !== identity(canonicalPath))
      throw Error(
        `Select the Git repository root (${root}) to connect this project.`,
      );
    await ensureLocalRuntimeIgnored(path);
    const branch = await git(path, ["branch", "--show-current"]);
    signal?.throwIfAborted();
    if (!branch) throw Error("Choose a named local Git branch before analyzing this project.");
    if (branch !== project.branch) {
      if (project.analysisCheckout || project.analysisCurrentSource)
        throw Error("This goal checkout changed branch. Its earlier analysis was not adopted.");
      project.branch = branch;
      if (project.analysis === "ready") project.analysis = "idle";
      project.analysisNote = "Reading the current local branch.";
    }
    return;
  }
  if ((await readdir(path)).length)
    throw Error(
      "This folder is not a Git repository. Initialize Git in it, then refresh code context, or select an existing repository.",
    );
  signal?.throwIfAborted();
  await git(path, ["init", "--initial-branch=main"]);
  await writeFile(
    join(path, "README.md"),
    `# ${project.name}\n\n${project.description || "A new project, started in MemCode."}\n`,
    { flag: "wx" },
  );
  await writeFile(
    join(path, ".gitignore"),
    ".memcode/\n.memdb/\n.memtrace/\nnode_modules/\n.env\n",
    { flag: "wx" },
  );
  await git(path, ["add", "--", "README.md", ".gitignore"]);
  await git(path, [
    "-c",
    "user.name=MemCode",
    "-c",
    "user.email=local@memcode.invalid",
    "commit",
    "-m",
    "Start project from MemCode brief",
  ]);
  signal?.throwIfAborted();
  project.branch = "main";
}
