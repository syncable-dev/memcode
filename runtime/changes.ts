import { recoverClaudeEdits } from "./claude-changes";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { structuredPatch } from "diff";
import type { Project, WorkItem } from "../src/shared";
import type {
  ChangeCheckpoint,
  ChangeFile,
  WorkerChanges,
} from "../src/changes";
import { git, within, now, exec, childEnv } from "./local";

type FileState = { hash?: string; bytes: number; binary: boolean };
/** A file as it was last recorded, kept so the next change can be compared against it. */
type Baseline = FileState & { content?: Buffer };
type Following = {
  root: string;
  branch: string;
  runId: string;
  since: string;
  /** Files named as the worker went along, beyond the task's planned scope. */
  named: Set<string>;
  paths: Set<string>;
};
const missing: Baseline = { bytes: 0, binary: false };
const scopeLimit = 200;

export interface CheckpointOptions {
  /** Other tasks editing this file right now: their unrecorded edits may be in this record. */
  sharedWith?: (path: string) => string[];
  /** Files to leave for a worker that is still editing them. */
  skip?: (path: string) => boolean;
}
function directory(task: WorkItem) {
  if (!task.run.workspace)
    throw Error("This work item has no shared workspace.");
  return join(task.run.workspace, ".memcode", "workers", task.id, "changes");
}
function exactScope(task: WorkItem) {
  return [
    ...new Set([
      ...(task.scope ?? []),
      ...(task.evidence?.symbols ?? []).map((s) => s.file),
    ]),
  ];
}
function decode(bytes: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
function fileState(bytes: Buffer): Baseline {
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    binary: bytes.includes(0) || decode(bytes) === undefined,
    content: bytes,
  };
}
/**
 * Which task changed what. Every file being edited in a checkout has one moving baseline:
 * the next worker to record takes everything since it, and the baseline moves on. So each
 * change is recorded exactly once, and workers never take turns to keep the record straight.
 */
export class WorkerChangeJournal {
  private following = new Map<string, Following>();
  private baselines = new Map<string, Map<string, Baseline>>();
  /** Starts following the task's planned files, plus `files`, from how they are now. */
  async begin(project: Project, task: WorkItem, files: string[] = []) {
    const joined = this.following.get(task.id);
    const following = joined ?? (await this.join(project, task));
    const paths = await this.resolve(following.root, task, files);
    if (!joined) this.following.set(task.id, following);
    for (const file of files) following.named.add(file);
    const baseline = this.baselineOf(following.root);
    for (const path of paths) {
      following.paths.add(path);
      if (!baseline.has(path))
        baseline.set(path, await this.read(following.root, path));
    }
  }
  private async join(project: Project, task: WorkItem): Promise<Following> {
    const root = await realpath(task.run.workspace ?? project.path!);
    const branch = (await git(root, ["branch", "--show-current"])).trim();
    if (task.run.branch && branch !== task.run.branch)
      throw Error("The goal branch changed before source attribution.");
    task.run.changeRunId ??= randomUUID();
    return {
      root,
      branch,
      runId: task.run.changeRunId,
      since: now(),
      named: new Set(),
      paths: new Set(),
    };
  }
  private baselineOf(root: string) {
    let baseline = this.baselines.get(root);
    if (!baseline) this.baselines.set(root, (baseline = new Map()));
    return baseline;
  }
  /** Records what changed in the task's files since they were last recorded; true when something was. */
  async checkpoint(
    project: Project,
    task: WorkItem,
    options: CheckpointOptions = {},
  ): Promise<boolean> {
    const following = this.following.get(task.id);
    if (!following) return false;
    if (
      (await git(following.root, ["branch", "--show-current"])).trim() !==
      following.branch
    )
      throw Error(
        "The goal branch changed. Source changes were not assigned to this worker.",
      );
    const baseline = this.baselineOf(following.root);
    const files: ChangeFile[] = [];
    const coEditors = new Set<string>();
    // A file created since the task began, inside a folder it follows, is its own too.
    for (const path of await this.resolve(following.root, task, [...following.named]))
      following.paths.add(path);
    for (const path of following.paths) {
      if (options.skip?.(path)) continue;
      const before = baseline.get(path) ?? missing,
        after = await this.read(following.root, path);
      if (before.hash === after.hash) continue;
      files.push(await this.diff(task, path, before, after));
      for (const other of options.sharedWith?.(path) ?? []) coEditors.add(other);
      baseline.set(path, after);
    }
    if (files.length) {
      const entry: ChangeCheckpoint = {
        id: randomUUID(),
        runId: following.runId,
        taskId: task.id,
        agentId: "memcode:" + task.id,
        harness: task.harness,
        branch: following.branch,
        startedAt: following.since,
        at: now(),
        basis: "fleet-reservation",
        files,
        ...(coEditors.size ? { sharedWith: [...coEditors] } : {}),
      };
      await this.append(task, entry);
    }
    following.since = now();
    return files.length > 0;
  }
  /** Records what is left, then stops following; a file nobody follows any more loses its baseline. */
  async release(
    project: Project,
    task: WorkItem,
    options: CheckpointOptions = {},
  ) {
    const following = this.following.get(task.id);
    try {
      await this.checkpoint(project, task, options);
    } finally {
      this.following.delete(task.id);
      if (following) this.forgetUnfollowed(following);
    }
  }
  private forgetUnfollowed(left: Following) {
    const baseline = this.baselineOf(left.root);
    const stillFollowed = new Set(
      [...this.following.values()]
        .filter((other) => other.root === left.root)
        .flatMap((other) => [...other.paths]),
    );
    for (const path of left.paths)
      if (!stillFollowed.has(path)) baseline.delete(path);
    if (!baseline.size) this.baselines.delete(left.root);
  }
  async importScopedBaseline(project: Project, task: WorkItem) {
    if (!task.run.baseline || !task.run.workspace || task.run.changeRunId)
      return;
    const root = await realpath(task.run.workspace),
      files: ChangeFile[] = [];
    for (const path of await this.resolve(root, task, [])) {
      const after = await this.read(root, path);
      if (!after.hash) continue;
      let before: Baseline = missing;
      try {
        const { stdout: bytes } = await exec(
          "git",
          ["-C", root, "show", task.run.baseline + ":" + path],
          {
            encoding: "buffer",
            maxBuffer: 2_000_000,
            windowsHide: true,
            env: childEnv(),
          },
        );
        before = fileState(bytes);
      } catch (error) {
        if (
          !String(error).includes("does not exist") &&
          !String(error).includes("exists on disk") &&
          !String(error).includes("not in")
        )
          throw error;
      }
      if (before.hash !== after.hash)
        files.push(await this.diff(task, path, before, after));
    }
    if (files.length)
      await this.append(task, {
        id: randomUUID(),
        runId: "earlier-" + task.id,
        taskId: task.id,
        agentId: "memcode:" + task.id,
        harness: task.harness,
        branch: task.run.branch ?? project.branch,
        startedAt: task.run.startedAt ?? task.createdAt,
        at: task.run.finishedAt ?? task.updatedAt,
        basis: "scoped-baseline",
        files,
      });
  }
  /** The files a task is following: its planned scope and `files`, with folders expanded. */
  private async resolve(
    root: string,
    task: WorkItem,
    files: string[],
  ): Promise<string[]> {
    const declared = [...new Set([...exactScope(task), ...files])]
      .map((path) => path.replaceAll("\\", "/"))
      .filter(Boolean);
    if (!declared.length) return [];
    const checkout = resolve(task.run.workspace ?? root);
    if (checkout !== root && (await realpath(checkout)) !== root)
      throw Error("The worker checkout moved during change capture.");
    // Git and the journal use paths relative to the physical checkout. Graph
    // evidence can name the same file through the checkout selected by the user.
    const scope = declared.map((path) => {
      const target = resolve(checkout, path);
      const base = within(checkout, target) ? checkout : root;
      if (!within(base, target)) throw Error("Change scope is outside the project.");
      return relative(base, target).replaceAll("\\", "/") || ".";
    });
    const tracked = (
      await git(root, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...scope,
      ])
    )
      .split("\0")
      .filter(Boolean);
    const paths = [
      ...new Set([...tracked, ...scope.filter((p) => /\.[a-z0-9]+$/i.test(p))]),
    ].filter(
      (path) =>
        within(root, resolve(root, path)) &&
        !/(^|\/)(\.git|\.memcode|node_modules)(\/|$)/.test(path),
    );
    if (paths.length > scopeLimit)
      throw Error(
        `Narrow the source scope to at most ${scopeLimit} files for a coordinated edit.`,
      );
    return paths;
  }
  private async read(root: string, path: string): Promise<Baseline> {
    try {
      const actual = await realpath(resolve(root, path));
      if (!within(root, actual))
        throw Error("Change scope resolves outside the project.");
      const info = await stat(actual);
      if (!info.isFile()) return missing;
      if (info.size > 2_000_000)
        throw Error(
          "Source file exceeds the 2 MB change capture limit: " + path,
        );
      const bytes = await readFile(actual),
        after = await stat(actual);
      if (info.mtimeMs !== after.mtimeMs || info.size !== after.size)
        throw Error("Source changed during capture. Record this edit again.");
      return fileState(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing;
      throw error;
    }
  }
  /** Code review reads a change's before and after text from the task's own folder. */
  private async keep(task: WorkItem, state: Baseline) {
    if (!state.hash || !state.content) return;
    const blobs = join(directory(task), "blobs");
    await mkdir(blobs, { recursive: true });
    await writeFile(join(blobs, state.hash), state.content, {
      flag: "wx",
      mode: 0o600,
    }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
  private async diff(
    task: WorkItem,
    path: string,
    before: Baseline,
    after: Baseline,
  ): Promise<ChangeFile> {
    await this.keep(task, before);
    await this.keep(task, after);
    const binary = before.binary || after.binary;
    const file: ChangeFile = {
      path,
      status: !before.hash ? "added" : !after.hash ? "deleted" : "modified",
      additions: 0,
      deletions: 0,
      binary,
      hunks: [],
      beforeHash: before.hash,
      afterHash: after.hash,
    };
    if (binary) return file;
    const text = (state: Baseline) =>
      state.content ? decode(state.content)! : "";
    const patch = structuredPatch(path, path, text(before), text(after), "", "", {
      context: 3,
    });
    for (const hunk of patch.hunks) {
      let oldLine = hunk.oldStart,
        newLine = hunk.newStart;
      file.hunks.push({
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
        lines: hunk.lines
          .filter((l) => !l.startsWith("\\"))
          .map((line) => {
            const kind =
              line[0] === "+" ? "add" : line[0] === "-" ? "delete" : "context";
            if (kind === "add") file.additions++;
            if (kind === "delete") file.deletions++;
            return {
              kind,
              text: line.slice(1),
              oldLine: kind === "add" ? undefined : oldLine++,
              newLine: kind === "delete" ? undefined : newLine++,
            };
          }),
      });
    }
    return file;
  }
  private async append(task: WorkItem, entry: ChangeCheckpoint) {
    const path = join(directory(task), "checkpoints.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    task.changesRevision = entry.id;
  }
}

export function readWorkerChanges(task: WorkItem) {
  return readChanges(task, false);
}
export function readDisplayedWorkerChanges(task: WorkItem) {
  return readChanges(task, true);
}
async function readChanges(
  task: WorkItem,
  includeReceipts: boolean,
): Promise<WorkerChanges> {
  const empty: WorkerChanges = {
    taskId: task.id,
    checkpoints: [],
    additions: 0,
    deletions: 0,
    files: 0,
  };
  if (!task.run.workspace) return empty;
  await recoverClaudeEdits(task);
  const readLedger = async (name: string): Promise<ChangeCheckpoint[]> => {
    const target = join(directory(task), name);
    const path = await realpath(target).catch((e) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (!path) return [];
    if (!within(await realpath(task.run.workspace!), path))
      throw Error("This change journal is outside the worker checkout.");
    if ((await stat(path)).size > 16_000_000)
      throw Error("Open a smaller worker run to review its change journal.");
    const text = await readFile(path, "utf8");
    const rows = text.split("\n");
    // A simultaneous append may still be writing its final record.
    rows.pop();
    return rows
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChangeCheckpoint)
      .filter((entry) => entry.taskId === task.id);
  };
  const [fleet, native] = await Promise.all([
    readLedger("checkpoints.jsonl"),
    readLedger("claude-edits.jsonl"),
  ]);
  const unique = new Map<string, ChangeCheckpoint>();
  for (const entry of native) {
    if (!unique.has(entry.id) || entry.basis === "native-edit")
      unique.set(entry.id, entry);
  }
  const receipts = [...unique.values()];
  const uncovered = receipts.filter(
    (entry) =>
      !fleet.some(
        (reservation) =>
          reservation.basis === "fleet-reservation" &&
          reservation.runId === entry.runId &&
          reservation.branch === entry.branch &&
          reservation.startedAt <= entry.at &&
          reservation.at >= entry.at &&
          reservation.files.some((file) => file.path === entry.files[0]?.path),
      ),
  );
  const unverified = uncovered.filter(
    (entry) =>
      entry.basis === "native-receipt" && entry.branch === task.run.branch,
  );
  // The old importer could save a whole scoped file before native receipts
  // were supported. Prefer the worker's receipts for that interval and file.
  const scoped = fleet.flatMap((entry) => {
    if (entry.basis !== "scoped-baseline") return [entry];
    const files = entry.files.filter(
      (file) =>
        !receipts.some(
          (edit) =>
            edit.branch === entry.branch &&
            edit.at >= entry.startedAt &&
            edit.at <= entry.at &&
            edit.files.some((nativeFile) => nativeFile.path === file.path),
        ),
    );
    return files.length ? [{ ...entry, files }] : [];
  });
  const checkpoints = [
    ...scoped,
    ...uncovered.filter(
      (entry) => includeReceipts || entry.basis === "native-edit",
    ),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const files = checkpoints.flatMap((c) => c.files);
  return {
    taskId: task.id,
    checkpoints,
    ...(unverified.length > 0 && {
      unverifiedEdits: unverified.length,
      unverifiedRevision: createHash("sha256")
        .update(JSON.stringify(unverified))
        .digest("hex"),
    }),
    files: new Set(files.map((f) => f.path)).size,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}
