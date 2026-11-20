import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isActive } from "../src/domain";
import type { AppState } from "../src/shared";
import type { TerminalManager } from "./terminals";
import { childEnv, exec, git, now, within } from "./local";
import type { WorkerCheckResult } from "../src/measurements";

export type CheckResult = WorkerCheckResult;
const OUTPUT_LIMIT = 262144,
  // This is a whole-project content fingerprint, not a source preview. Normal
  // vendored archives and screenshots can exceed the 2 MB preview limit.
  FILE_LIMIT = 8_000_000,
  SOURCE_LIMIT = 32_000_000;
const count = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 1e7;
const unknownCounts = () => ({ passed: null, failed: null });

export function parseCheckCounts(
  text: string,
  format: "tap" | "memcode-json" | "exit-code",
): { passed: number | null; failed: number | null } {
  if (format === "exit-code") return unknownCounts();
  // ConPTY sends an OSC window title immediately before the first output.
  // Node's general VT stripper can stop at the drive-letter colon and leave
  // the title glued to the TAP header. Remove complete OSC frames first, after
  // assembling all raw chunks. Titles are not machine-report content.
  text = text.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)/g, "");
  if (/(?:\x1b\]|\x9d)/.test(text)) return unknownCounts();
  text = stripVTControlCharacters(text);
  if (format === "memcode-json") {
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("MEMCODE_CHECK_RESULT "));
    if (lines.length !== 1) return unknownCounts();
    try {
      const value = JSON.parse(lines[0].slice("MEMCODE_CHECK_RESULT ".length));
      return value.version === 1 && count(value.passed) && count(value.failed)
        ? { passed: value.passed, failed: value.failed }
        : unknownCounts();
    } catch {
      return unknownCounts();
    }
  }
  if (!/^TAP version 13\s*$/m.test(text)) return unknownCounts();
  const field = (name: string) => {
    const values = [
      ...text.matchAll(new RegExp("^# " + name + " (\\d+)\\s*$", "gm")),
    ];
    return values.length === 1 ? Number(values[0][1]) : null;
  };
  const passed = field("pass"),
    failed = field("fail"),
    tests = field("tests"),
    cancelled = field("cancelled"),
    skipped = field("skipped"),
    todo = field("todo");
  return [passed, failed, tests, cancelled, skipped, todo].every(count) &&
    Number(passed) +
      Number(failed) +
      Number(cancelled) +
      Number(skipped) +
      Number(todo) ===
      tests
    ? { passed, failed }
    : unknownCounts();
}

async function boundedFile(path: string): Promise<Buffer | null> {
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > FILE_LIMIT) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const bytes = Buffer.allocUnsafe(Math.min(65536, FILE_LIMIT + 1 - size));
      const read = await file.read(bytes, 0, bytes.length, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
      if (size > FILE_LIMIT) return null;
      chunks.push(bytes.subarray(0, read.bytesRead));
    }
    const after = await file.stat();
    return after.size === size &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs
      ? Buffer.concat(chunks)
      : null;
  } finally {
    await file.close();
  }
}

/** Bounded content binding; only the digest stays on this device. Framed names,
 * contents and entry kinds prevent a rename/content boundary from colliding.
 * Unknown coverage cannot be linked to a worker/model. */
export async function checkSourceBinding(root: string): Promise<string | null> {
  try {
    const canonicalRoot = await realpath(root);
    // The generic git helper trims text; filenames may begin with whitespace.
    const listed = await exec(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: canonicalRoot,
        windowsHide: true,
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
        env: childEnv(),
      },
    );
    const paths = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(listed.stdout as Buffer)
      .split("\0")
      .filter(Boolean);
    if (paths.length > 5000) return null;
    const hash = createHash("sha256");
    const frame = (value: string | Buffer) => {
      const bytes = typeof value === "string" ? Buffer.from(value) : value;
      hash.update(String(bytes.length) + ":");
      hash.update(bytes);
    };
    frame("memcode-source-binding-v1");
    let bytes = 0;
    for (const name of [...new Set(paths)].sort()) {
      if (isAbsolute(name) || name.split(/[\\/]/).some((part) => part === ".."))
        return null;
      const path = resolve(canonicalRoot, name);
      if (!within(canonicalRoot, path)) return null;
      try {
        const canonicalPath = await realpath(path);
        if (!within(canonicalRoot, canonicalPath)) return null;
        const content = await boundedFile(canonicalPath);
        if (
          !content ||
          (bytes += content.length) > SOURCE_LIMIT ||
          (await realpath(path)) !== canonicalPath
        )
          return null;
        frame("file");
        frame(name);
        frame(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
        frame("deleted");
        frame(name);
      }
    }
    frame("branch");
    frame(await git(canonicalRoot, ["branch", "--show-current"]));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export async function runTaskVerification(
  state: () => AppState,
  terminals: TerminalManager,
  input: {
    id: string;
    program: string;
    args: string[];
    format: "tap" | "memcode-json" | "exit-code";
    timeoutMs: number;
    cwd?: string;
  },
): Promise<CheckResult> {
  const task = state().tasks.find((item) => item.id === input.id),
    project = state().projects.find((item) => item.id === task?.projectId);
  if (
    !task ||
    !project?.path ||
    task.example ||
    project.example ||
    isActive(task) ||
    !task.run.changeRunId ||
    !task.changesRevision
  )
    throw Error("Finish a recorded worker pass before running its checks.");
  const runId = task.run.changeRunId,
    revision = task.changesRevision,
    finishedBinding = task.run.finishedSourceBinding;
  const root = task.run.workspace ?? project.path,
    startedAt = now(),
    before = await checkSourceBinding(root);
  const reply = await terminals.execute(task.id, {
    action: "start",
    program: input.program,
    args: input.args,
    label: "Verification",
    cols: 400,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  if (!reply.session) throw Error("Verification terminal did not start.");
  const sessionId = reply.session.id,
    deadline = Date.now() + input.timeoutMs,
    chunks: Buffer[] = [];
  let after = 0,
    bytes = 0,
    exitCode: number | null = null,
    timedOut = false,
    truncated = false,
    ended = false;
  let exitedAt: number | undefined,
    stableExitReads = 0;
  try {
    while (true) {
      const observed = await terminals.execute(task.id, {
        action: "observe",
        sessionId,
        after,
      });
      if (!observed.session || observed.session.id !== sessionId) {
        truncated = true;
        break;
      }
      const previous = after;
      if (!Array.isArray(observed.chunks)) truncated = true;
      for (const chunk of observed.chunks ?? []) {
        if (
          !Number.isSafeInteger(chunk.seq) ||
          chunk.seq < 1 ||
          typeof chunk.data !== "string"
        ) {
          truncated = true;
          continue;
        }
        if (chunk.seq <= after) continue;
        if (chunk.seq !== after + 1) truncated = true;
        const value = Buffer.from(chunk.data, "base64");
        if (value.toString("base64") !== chunk.data) truncated = true;
        after = chunk.seq;
        bytes += value.length;
        if (bytes > OUTPUT_LIMIT) truncated = true;
        else chunks.push(value);
      }
      if (observed.truncated || observed.session.seq > after) truncated = true;
      if (observed.session.status === "exited") {
        ended = true;
        exitCode =
          typeof observed.session.exitCode === "number" &&
          Number.isInteger(observed.session.exitCode)
            ? observed.session.exitCode
            : null;
        exitedAt ??= Date.now();
        stableExitReads = after === previous ? stableExitReads + 1 : 0;
        // Native process-exit and PTY-read notifications use separate threads.
        // Drain trailing chunks before trusting the final machine report.
        if (stableExitReads >= 2 && Date.now() - exitedAt >= 100) break;
      }
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
  } finally {
    if (!ended)
      await terminals
        .execute(task.id, { action: "stop", sessionId })
        .catch(() => {});
  }
  const sourceAfter = await checkSourceBinding(root),
    current = state().tasks.find((item) => item.id === input.id);
  let counts =
    timedOut || truncated || exitCode === null
      ? unknownCounts()
      : parseCheckCounts(Buffer.concat(chunks).toString("utf8"), input.format);
  if (counts.failed !== null && (exitCode === 0) !== (counts.failed === 0))
    counts = unknownCounts();
  const result: CheckResult = {
    runId,
    revision,
    sessionId,
    ...counts,
    exitCode,
    source: "memcode_check",
    startedAt,
    finishedAt: now(),
    timedOut,
    linked:
      !timedOut &&
      !truncated &&
      !!finishedBinding &&
      before === finishedBinding &&
      before === sourceAfter &&
      current?.run.changeRunId === runId &&
      current.run.finishedSourceBinding === finishedBinding &&
      current.changesRevision === revision &&
      !isActive(current),
  };
  if (current && current.run.changeRunId === runId) current.run.checks = result;
  return result;
}
