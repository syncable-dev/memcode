import { realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { AppState } from "../src/shared";
import { workerRecordsBoundary, workerRecordsFolder } from "./worker-records";
import { artifactFormat } from "../src/artifact-format";
import { fileLink, type FileReference } from "../src/file-reference";
import { within } from "./local";

export function outputRoots(dataDir: string, task: AppState["tasks"][number]) {
  return [
    join(dataDir, "examples"),
    join(dataDir, "captures", task.id),
    ...(workerRecordsFolder(task)
      ? [join(workerRecordsFolder(task)!, "artifacts")]
      : []),
    ...(task.run.worktree
      ? [join(task.run.worktree, ".memcode", "artifacts")]
      : []),
  ];
}

const samePath = (left: string, right: string) => {
  const a = resolve(left),
    b = resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
};

/** Canonicalize explicit approved directories, such as a selected project root. */
export async function canonicalDirectories(paths: string[]): Promise<string[]> {
  const directories = await Promise.all(
    paths.map(async (path) => {
      try {
        const canonical = await realpath(path);
        return (await stat(canonical)).isDirectory() ? canonical : null;
      } catch {
        return null;
      }
    }),
  );
  return [
    ...new Set(directories.filter((path): path is string => path !== null)),
  ];
}

/** Resolve aliases in approved anchors without granting a redirected output subtree. */
export async function canonicalArtifactRoots(
  dataDir: string,
  task: AppState["tasks"][number],
): Promise<string[]> {
  const singleId =
    task.id.length > 0 &&
    task.id !== "." &&
    task.id !== ".." &&
    !/[\\/\x00]/.test(task.id);
  const candidates: Array<[string, string]> = [
    [dataDir, join(dataDir, "examples")],
    ...(singleId
      ? [[dataDir, join(dataDir, "captures", task.id)] as [string, string]]
      : []),
    ...(singleId && workerRecordsFolder(task)
      ? [
          [
            workerRecordsBoundary(task)!,
            join(workerRecordsFolder(task)!, "artifacts"),
          ] as [string, string],
        ]
      : []),
    ...(task.run.worktree
      ? [
          [
            task.run.worktree,
            join(task.run.worktree, ".memcode", "artifacts"),
          ] as [string, string],
        ]
      : []),
  ];
  const cache = new Map<string, Promise<string | undefined>>();
  const directory = (path: string) => {
    let value = cache.get(path);
    if (!value) {
      value = canonicalDirectories([path]).then((items) => items[0]);
      cache.set(path, value);
    }
    return value;
  };
  const roots = await Promise.all(
    candidates.map(async ([anchor, output]) => {
      if (!within(anchor, output)) return null;
      const [canonicalAnchor, canonicalOutput] = await Promise.all([
        directory(anchor),
        directory(output),
      ]);
      if (!canonicalAnchor || !canonicalOutput) return null;
      const expected = resolve(
        canonicalAnchor,
        relative(resolve(anchor), resolve(output)),
      );
      // A /var -> /private/var alias in the approved anchor is valid. A link in
      // captures/ or .memcode/.../artifacts must not widen this read capability.
      return samePath(expected, canonicalOutput) &&
        within(canonicalAnchor, canonicalOutput)
        ? canonicalOutput
        : null;
    }),
  );
  return [...new Set(roots.filter((path): path is string => path !== null))];
}

export async function resolveFile(
  state: AppState,
  dataDir: string,
  taskId: string,
  href: string,
  basePath?: string,
): Promise<FileReference> {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) throw Error("Work item not found.");
  const project = state.projects.find((p) => p.id === task.projectId),
    root = task.run.workspace ?? task.run.worktree ?? project?.path,
    link = fileLink(href),
    artifacts = state.artifacts.filter((a) => a.taskId === task.id);
  const approvedOutputs = await canonicalArtifactRoots(dataDir, task);
  const roots = [
    ...(await canonicalDirectories(root ? [root] : [])),
    ...approvedOutputs,
  ];
  const named =
    !link.path.includes("/") && !link.path.includes("\\")
      ? artifacts.filter((a) => a.name === link.path)
      : [];
  // A basename from a worker response refers to its saved output when unambiguous.
  const candidate =
    named.length === 1
      ? named[0].path
      : isAbsolute(link.path)
        ? link.path
        : root
          ? resolve(root, link.path)
          : "";
  let path = candidate ? await realpath(candidate).catch(() => null) : null;
  if (!path && basePath && !isAbsolute(link.path))
    path = await realpath(resolve(dirname(basePath), link.path)).catch(
      () => null,
    );
  if (!path)
    throw Error(
      "This file is no longer available in the project or this worker’s saved outputs.",
    );
  if (!roots.some((root) => within(root, path!)))
    throw Error(
      "This file is outside the project and this worker’s output folders.",
    );
  const info = await stat(path);
  if (!info.isFile()) throw Error("Choose a file to preview.");
  let artifact = artifacts.find(
    (a) =>
      samePath(a.path, path!) || (candidate && samePath(a.path, candidate)),
  );
  if (!artifact) {
    // Discovery stores canonical paths; agent links may retain the selected
    // folder's alias. Compare only matching basenames before resolving them.
    const filename =
      process.platform === "win32"
        ? basename(path).toLowerCase()
        : basename(path);
    for (const saved of artifacts) {
      const savedName =
        process.platform === "win32"
          ? basename(saved.path).toLowerCase()
          : basename(saved.path);
      if (savedName !== filename) continue;
      const canonical = await realpath(saved.path).catch(() => null);
      if (canonical && samePath(canonical, path)) {
        artifact = saved;
        break;
      }
    }
  }
  if (!approvedOutputs.some((root) => within(root, path))) artifact = undefined;
  let format = artifactFormat(path);
  // Opening source HTML does not execute it. Saved HTML artifacts remain interactive.
  if (!artifact && format === "html") format = "text";
  return {
    path,
    name: basename(path),
    relativePath:
      root && within(root, path)
        ? relative(root, path).replaceAll("\\", "/")
        : basename(path),
    format,
    revision: `${info.mtimeMs}:${info.size}`,
    size: info.size,
    line: link.line,
    ...(artifact ? { artifactId: artifact.id } : {}),
  };
}
