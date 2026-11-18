import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { applyPatch, structuredPatch } from "diff";
import { z } from "zod";
import type { WorkItem } from "../src/shared";
import type { ChangeCheckpoint, ChangeFile } from "../src/changes";
import { childEnv, exec, git, within } from "./local";

const fileLimit = 2_000_000;
const text = z.string().max(fileLimit);
const hunk = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(text).max(100_000),
});
const editResult = z.object({
  filePath: z.string().min(1).max(4096),
  structuredPatch: z.array(hunk).max(4096),
  type: z.enum(["create", "update"]).optional(),
  content: text.optional(),
  originalFile: text.nullable().optional(),
  userModified: z.boolean().optional(),
});
type EditResult = z.infer<typeof editResult>;
const sessionFrame = z.object({
  type: z.enum(["assistant", "user"]),
  session_id: z.string().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  timestamp: z.string().optional(),
  tool_use_result: z.unknown().optional(),
  toolUseResult: z.unknown().optional(),
  message: z.object({ content: z.array(z.unknown()) }),
});
const sourceEditCall = z.object({
  type: z.literal("tool_use"),
  name: z.enum(["Edit", "Write", "MultiEdit"]),
  id: z.string(),
  input: z.object({ file_path: z.string() }),
});
const sourceEditReturn = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
});
type PendingEdit = {
  file: string;
  before?: Promise<Buffer | null | undefined>;
};
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
function permittedPath(root: string, path: string): string | undefined {
  const candidate = resolve(root, path);
  const rel = relative(root, candidate).replaceAll("\\", "/");
  if (
    !rel ||
    !within(root, candidate) ||
    /(?:^|\/)(?:\.git|\.memcode|node_modules)(?:\/|$)/i.test(rel)
  )
    return;
  return rel;
}
async function readSource(
  root: string,
  path: string,
): Promise<Buffer | undefined | null> {
  try {
    const actual = await realpath(join(root, path));
    if (!permittedPath(await realpath(root), actual)) return;
    const file = await open(actual, "r");
    try {
      const s = await file.stat();
      if (!s.isFile() || s.size > fileLimit) return;
      const bytes = Buffer.alloc(s.size);
      let at = 0;
      while (at < bytes.length) {
        const { bytesRead } = await file.read(bytes, at, bytes.length - at, at);
        if (!bytesRead) return;
        at += bytesRead;
      }
      const after = await file.stat();
      return s.size === after.size && s.ctimeMs === after.ctimeMs
        ? bytes
        : undefined;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return;
  }
}
function receiptFile(path: string, result: EditResult): ChangeFile | undefined {
  const created =
    result.type === "create" &&
    result.originalFile === null &&
    typeof result.content === "string";
  const hunks = created
    ? structuredPatch(path, path, "", result.content!, "", "", { context: 3 })
        .hunks
    : result.structuredPatch;
  const file: ChangeFile = {
    path,
    binary: false,
    status: created ? "added" : "modified",
    additions: 0,
    deletions: 0,
    hunks: [],
  };
  let bytes = 0;
  for (const h of hunks) {
    let oldLine = h.oldStart,
      newLine = h.newStart;
    const lines: ChangeFile["hunks"][number]["lines"] = [];
    for (const row of h.lines) {
      bytes += row.length;
      if (bytes > fileLimit) return;
      if (row.startsWith("\\")) continue;
      if (!/^[+\- ]/.test(row)) return;
      const kind =
        row[0] === "+" ? "add" : row[0] === "-" ? "delete" : "context";
      if (kind === "add") file.additions++;
      if (kind === "delete") file.deletions++;
      lines.push({
        kind,
        text: row.slice(1),
        oldLine: kind === "add" ? undefined : oldLine++,
        newLine: kind === "delete" ? undefined : newLine++,
      });
    }
    if (
      oldLine - h.oldStart !== h.oldLines ||
      newLine - h.newStart !== h.newLines
    )
      return;
    file.hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines });
  }
  return created || file.additions || file.deletions ? file : undefined;
}
function afterText(path: string, result: EditResult) {
  if (typeof result.content === "string") return result.content;
  if (typeof result.originalFile !== "string") return;
  try {
    const applied = applyPatch(result.originalFile, {
      oldFileName: path,
      newFileName: path,
      oldHeader: "",
      newHeader: "",
      hunks: result.structuredPatch,
    });
    return applied === false ? undefined : applied;
  } catch {
    return undefined;
  }
}
const sameText = (
  bytes: Buffer | null | undefined,
  expected: string | null | undefined,
) =>
  (bytes === null && expected === null) ||
  (Buffer.isBuffer(bytes) &&
    typeof expected === "string" &&
    Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes) &&
    bytes.toString("utf8").replaceAll("\r\n", "\n") ===
      expected.replaceAll("\r\n", "\n"));

/** Consume native successful tool receipts only. Never infer a worker's diff from a dirty checkout. */
export class ClaudeEditJournal {
  private pending = new Map<string, PendingEdit>();
  private tail = Promise.resolve();
  private error?: Error;
  private root: string;
  private runId: string;
  constructor(
    private task: WorkItem,
    private saved?: () => void,
    private legacy = false,
    private known = new Set<string>(),
  ) {
    this.root = task.run.workspace ?? "";
    this.runId = task.run.changeRunId ?? task.run.sessionId ?? "";
  }
  observe(value: unknown) {
    if (!this.root || !this.runId) return;
    const parsed = sessionFrame.safeParse(value);
    if (!parsed.success) return;
    const frame = parsed.data;
    const sessionId = frame.session_id ?? frame.sessionId;
    if (
      typeof sessionId !== "string" ||
      !uuid.test(sessionId) ||
      (this.task.run.sessionId && sessionId !== this.task.run.sessionId)
    )
      return;
    if (
      this.legacy &&
      (!frame.cwd ||
        relative(this.root, frame.cwd) !== "" ||
        !this.task.run.branch ||
        frame.gitBranch !== this.task.run.branch)
    )
      return;
    if (frame.type === "assistant") {
      for (const block of frame.message.content) {
        const call = sourceEditCall.safeParse(block);
        if (!call.success) continue;
        const { id, input } = call.data;
        const file = permittedPath(this.root, input.file_path);
        if (file && this.pending.size < 256)
          this.pending.set(sessionId + "\0" + id, {
            file,
            before: this.legacy ? undefined : readSource(this.root, file),
          });
      }
      return;
    }
    if (frame.type !== "user") return;
    const results = frame.message.content
      .map((block) => sourceEditReturn.safeParse(block))
      .filter((result) => result.success);
    if (results.length !== 1) return;
    const b = results[0].data,
      toolKey = sessionId + "\0" + b.tool_use_id,
      call = this.pending.get(toolKey);
    this.pending.delete(toolKey);
    if (!call || b.is_error) return;
    const result = editResult.safeParse(
      frame.tool_use_result ?? frame.toolUseResult,
    );
    if (
      !result.success ||
      result.data.userModified ||
      permittedPath(this.root, result.data.filePath) !== call.file
    )
      return;
    const file = receiptFile(call.file, result.data);
    if (!file) return;
    const at =
      typeof frame.timestamp === "string" && !isNaN(Date.parse(frame.timestamp))
        ? new Date(frame.timestamp).toISOString()
        : new Date().toISOString();
    const entry: ChangeCheckpoint = {
      id: "claude-" + digest(sessionId + "\0" + b.tool_use_id),
      runId: this.runId,
      taskId: this.task.id,
      agentId: "memcode:" + this.task.id,
      harness: "claude",
      branch: this.task.run.branch ?? "",
      startedAt: at,
      at,
      basis: "native-receipt",
      files: [file],
    };
    if (this.known.has(entry.id)) return;
    this.known.add(entry.id);
    const after = readSource(this.root, call.file);
    this.tail = this.tail
      .then(async () => {
        const dir = await journalDirectory(this.task);
        let before = await call.before;
        const disk = await after;
        if (disk === undefined) return; // Includes a symlink resolving outside this checkout.
        if (
          !sameText(before, result.data.originalFile) &&
          typeof result.data.originalFile === "string" &&
          this.task.run.baseline &&
          /^[a-f0-9]{7,64}$/i.test(this.task.run.baseline)
        ) {
          before = await exec(
            "git",
            ["-C", this.root, "show", this.task.run.baseline + ":" + call.file],
            {
              encoding: "buffer",
              maxBuffer: fileLimit,
              windowsHide: true,
              env: childEnv(),
            },
          )
            .then((r) => r.stdout)
            .catch(() => undefined);
        }
        if (
          disk &&
          sameText(disk, afterText(call.file, result.data)) &&
          entry.branch &&
          (await git(this.root, ["branch", "--show-current"])).trim() ===
            entry.branch &&
          (file.status === "added"
            ? result.data.originalFile === null
            : Buffer.isBuffer(before) &&
              typeof result.data.originalFile === "string" &&
              sameText(before, result.data.originalFile))
        ) {
          const blobs = join(dir, "blobs");
          await mkdir(blobs, { recursive: true });
          if (
            (await lstat(blobs)).isSymbolicLink() ||
            !within(await realpath(dir), await realpath(blobs))
          )
            throw Error("Invalid source snapshot directory.");
          const persist = async (bytes: Buffer) => {
            const hash = digest(bytes);
            const target = join(blobs, hash);
            await writeFile(target, bytes, { mode: 0o600, flag: "wx" }).catch(
              async (e) => {
                if (e.code !== "EEXIST") throw e;
                const info = await lstat(target);
                if (
                  !info.isFile() ||
                  info.size !== bytes.length ||
                  !(await readFile(target)).equals(bytes)
                )
                  throw Error(
                    "The saved source snapshot failed its content check.",
                  );
              },
            );
            return hash;
          };
          if (file.status !== "added" && before)
            file.beforeHash = await persist(before);
          file.afterHash = await persist(disk);
          entry.basis = "native-edit";
        }
        const ledger = join(dir, "claude-edits.jsonl");
        if ((await lstat(ledger).catch(() => undefined))?.isSymbolicLink())
          throw Error("Invalid worker change journal.");
        await appendFile(ledger, JSON.stringify(entry) + "\n", { mode: 0o600 });
        this.task.changesRevision = entry.id;
        this.saved?.();
      })
      .catch((error) => {
        this.error = error;
      });
  }
  async flush() {
    await this.tail;
    if (this.error) throw this.error;
  }
}

async function journalDirectory(task: WorkItem) {
  if (
    !task.run.workspace ||
    !/^[a-zA-Z0-9_.-]+$/.test(task.id) ||
    task.id === "." ||
    task.id === ".."
  )
    throw Error("Invalid worker change directory.");
  const root = await realpath(task.run.workspace);
  let dir = root;
  for (const part of [".memcode", "workers", task.id, "changes"]) {
    dir = join(dir, part);
    await mkdir(dir, { recursive: true });
    if (
      (await lstat(dir)).isSymbolicLink() ||
      !within(root, await realpath(dir))
    )
      throw Error("Change directory is outside this checkout.");
  }
  return dir;
}

const recovered = new Map<string, { stamp: string; reading: Promise<void> }>();
export async function recoverClaudeEdits(task: WorkItem) {
  const root = task.run.workspace,
    id = task.run.sessionId;
  if (
    !root ||
    !id ||
    !uuid.test(id) ||
    task.harness !== "claude" ||
    (task.run.nativeEditCapture &&
      ["preparing", "running", "finishing", "stopping"].includes(
        task.run.state,
      ))
  )
    return;
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const dir = join(config, "projects", root.replace(/[^a-z0-9]/gi, "-"));
  const path = join(dir, id + ".jsonl");
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > 64_000_000) return;
  const key = task.id + "\0" + path,
    stamp = info.size + "-" + info.mtimeMs;
  const previous = recovered.get(key);
  if (previous?.stamp === stamp) return previous.reading;
  const reading = (async () => {
    await previous?.reading;
    if (!within(await realpath(config), await realpath(path))) return;
    const ledger = join(
      root,
      ".memcode",
      "workers",
      task.id,
      "changes",
      "claude-edits.jsonl",
    );
    const known = new Set<string>();
    const existing = await lstat(ledger).catch(() => undefined);
    if (
      existing?.isFile() &&
      existing.size <= 16_000_000 &&
      within(await realpath(root), await realpath(ledger))
    ) {
      const completedRows = (await readFile(ledger, "utf8")).split("\n");
      completedRows.pop(); // An in-flight append may end in an incomplete record.
      for (const line of completedRows.filter(Boolean))
        known.add(JSON.parse(line).id);
    }
    const rec = new ClaudeEditJournal(task, undefined, true, known);
    const lines = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (
        line.length > 8_000_000 ||
        (!line.includes('"tool_use"') && !line.includes('"tool_result"'))
      )
        continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      rec.observe(frame);
    }
    await rec.flush();
  })();
  if (recovered.size >= 64) recovered.delete(recovered.keys().next().value!);
  recovered.set(key, { stamp, reading });
  try {
    await reading;
  } catch (error) {
    recovered.delete(key);
    throw error;
  }
}
