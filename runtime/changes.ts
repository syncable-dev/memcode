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
type Snapshot = Map<string, FileState>;
type Reservation = {
  root: string;
  branch: string;
  runId: string;
  at: string;
  files: Snapshot;
};
const missing: FileState = { bytes: 0, binary: false };
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
  ]
    .map((p) => p.replaceAll("\\", "/"))
    .filter(Boolean);
}
function decode(bytes: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
/** Snapshots are taken at ownership grant, not at the epic baseline. */
export class WorkerChangeJournal {
  private reservations = new Map<string, Reservation>();
  async begin(project: Project, task: WorkItem) {
    if (this.reservations.has(task.id)) return;
    const root = await realpath(task.run.workspace ?? project.path!);
    const branch = (await git(root, ["branch", "--show-current"])).trim();
    if (task.run.branch && branch !== task.run.branch)
      throw Error("The epic branch changed before source attribution.");
    task.run.changeRunId ??= randomUUID();
    this.reservations.set(task.id, {
      root,
      branch,
      runId: task.run.changeRunId,
      at: now(),
      files: await this.snapshot(root, task),
    });
  }
  async checkpoint(project: Project, task: WorkItem) {
    const reservation = this.reservations.get(task.id);
    if (!reservation) return;
    if (
      (await git(reservation.root, ["branch", "--show-current"])).trim() !==
      reservation.branch
    )
      throw Error(
        "The epic branch changed. Source changes were not assigned to this worker.",
      );
    const current = await this.snapshot(reservation.root, task);
    const files: ChangeFile[] = [];
    for (const path of new Set([
      ...reservation.files.keys(),
      ...current.keys(),
    ])) {
      const before = reservation.files.get(path) ?? missing,
        after = current.get(path) ?? missing;
      if (before.hash === after.hash) continue;
      files.push(await this.diff(task, path, before, after));
    }
    if (files.length) {
      const entry: ChangeCheckpoint = {
        id: randomUUID(),
        runId: reservation.runId,
        taskId: task.id,
        agentId: "memcode:" + task.id,
        harness: task.harness,
        branch: reservation.branch,
        startedAt: reservation.at,
        at: now(),
        basis: "fleet-reservation",
        files,
      };
      await this.append(task, entry);
    }
    reservation.files = current;
    reservation.at = now();
  }
  async release(project: Project, task: WorkItem) {
    try {
      await this.checkpoint(project, task);
    } finally {
      this.reservations.delete(task.id);
    }
  }
  async importScopedBaseline(project: Project, task: WorkItem) {
    if (!task.run.baseline || !task.run.workspace || task.run.changeRunId)
      return;
    const root = await realpath(task.run.workspace),
      current = await this.snapshot(root, task),
      files: ChangeFile[] = [];
    await mkdir(join(directory(task), "blobs"), { recursive: true });
    for (const [path, after] of current) {
      let before: FileState = missing;
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
        const hash = createHash("sha256").update(bytes).digest("hex");
        await writeFile(join(directory(task), "blobs", hash), bytes, {
          flag: "wx",
          mode: 0o600,
        }).catch((e) => {
          if (e.code !== "EEXIST") throw e;
        });
        before = { hash, bytes: bytes.length, binary: bytes.includes(0) };
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
  private async snapshot(root: string, task: WorkItem): Promise<Snapshot> {
    const scope = exactScope(task);
    if (!scope.length) return new Map();
    for (const path of scope)
      if (!within(root, resolve(root, path)))
        throw Error("Change scope is outside the project.");
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
    const paths = new Set([
      ...tracked,
      ...scope.filter((p) => /\.[a-z0-9]+$/i.test(p)),
    ]);
    if (paths.size > 200)
      throw Error(
        "Narrow the source scope to at most 200 files for a coordinated edit.",
      );
    const result: Snapshot = new Map();
    for (const path of paths) {
      const candidate = resolve(root, path);
      if (
        !within(root, candidate) ||
        /(^|\/)(\.git|\.memcode|node_modules)(\/|$)/.test(path)
      )
        continue;
      try {
        const actual = await realpath(candidate);
        if (!within(root, actual))
          throw Error("Change scope resolves outside the project.");
        const info = await stat(actual);
        if (!info.isFile()) continue;
        if (info.size > 2_000_000)
          throw Error(
            "Source file exceeds the 2 MB change capture limit: " + path,
          );
        const bytes = await readFile(actual),
          after = await stat(actual);
        if (info.mtimeMs !== after.mtimeMs || info.size !== after.size)
          throw Error("Source changed during capture. Inspect Fleet again.");
        const hash = createHash("sha256").update(bytes).digest("hex"),
          blobs = join(directory(task), "blobs");
        await mkdir(blobs, { recursive: true });
        await writeFile(join(blobs, hash), bytes, {
          flag: "wx",
          mode: 0o600,
        }).catch((e) => {
          if (e.code !== "EEXIST") throw e;
        });
        result.set(relative(root, actual).replaceAll("\\", "/"), {
          hash,
          bytes: bytes.length,
          binary: bytes.includes(0) || decode(bytes) === undefined,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          result.set(path, missing);
        else throw error;
      }
    }
    return result;
  }
  private async diff(
    task: WorkItem,
    path: string,
    before: FileState,
    after: FileState,
  ): Promise<ChangeFile> {
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
    const blob = async (state: FileState) =>
      state.hash
        ? decode(await readFile(join(directory(task), "blobs", state.hash)))!
        : "";
    const patch = structuredPatch(
      path,
      path,
      await blob(before),
      await blob(after),
      "",
      "",
      { context: 3 },
    );
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
