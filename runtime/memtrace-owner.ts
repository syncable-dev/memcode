import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { Command } from "./commands";
import type { projectMcpWorkspace } from "./memtrace-workspace";

type ProjectScope = Awaited<ReturnType<typeof projectMcpWorkspace>>;
type OwnedProcess = {
  child: ChildProcess;
  failed?: Error;
  exited?: number | null;
  startedAt: number;
  output: string;
  progress?: string;
};
const execute = promisify(execFile);

/** The host must allow the native sidecar's recovery budget plus its final probe. */
export function memtraceOwnerTimeoutMs(env: Record<string, string>): number {
  const configured = Number(env.MEMTRACE_MEMDB_SIDECAR_STARTUP_SECS);
  const seconds =
    Number.isInteger(configured) && configured > 0
      ? Math.min(configured, 3600)
      : 900;
  return (seconds + 30) * 1000;
}

function diagnostic(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\bBearer\s+[^\s"',;}]+/gi, "Bearer [redacted]")
    .replace(
      /((?:authorization|api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|secret|license[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "[redacted]")
    .trim();
}

function diagnosticSuffix(owned: OwnedProcess): string {
  const tail = diagnostic(owned.output)
    .split("\n")
    .filter(Boolean)
    .slice(-12)
    .join("\n")
    .slice(-4000);
  return tail ? `\n\n${tail}` : "";
}

/** A cold stdio session is healthy but cannot query until start publishes an owner. */
export function pendingMemtraceOwner(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /no workspace owner is attached yet|this session attaches when memtrace start publishes one/i.test(
    text,
  );
}

export function disconnectedMemtraceClient(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /connection closed|not connected|transport (?:is )?closed/i.test(text);
}

async function stopOwnedProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    // Includes the npm shim's native child, and only this spawned process tree.
    // Never use `memtrace stop`: it could stop an owner borrowed from the user.
    await execute(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, timeout: 5000, maxBuffer: 16000 },
    ).catch(() => {
      child.kill();
    });
  } else {
    const exited = new Promise<void>((done) =>
      child.once("close", () => done()),
    );
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
}

interface OwnerOptions {
  spawn?: typeof spawn;
  stop?: (child: ChildProcess) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

/** Only owns children it spawned; an already reachable owner is always borrowed. */
export class ManagedMemtraceOwners {
  private readonly owned = new Map<string, OwnedProcess>();
  private readonly abort = new AbortController();
  constructor(private readonly options: OwnerOptions = {}) {}

  /** Explicit diagnostics only: selected owner's bounded, redacted certificate errors. */
  certificateDiagnostics(dataDirectory: string): string[] {
    const owned = this.owned.get(dataDirectory);
    if (!owned) return [];
    return diagnostic(owned.output)
      .split("\n")
      .filter((line) =>
        /owned branch index could not be certified|certificate|input changed|parsed files|stored files|no complete pre-index|hashing budget/i.test(
          line,
        ),
      )
      .slice(-8)
      .map((line) => line.slice(0, 500));
  }

  async ready(
    scope: ProjectScope,
    command: Command,
    env: Record<string, string>,
    probe: () => Promise<void>,
    onProgress?: (note: string) => void,
  ): Promise<void> {
    if (this.abort.signal.aborted)
      throw Error("The Memtrace connection is closing.");
    try {
      await probe();
      return; // Reuse the live owner without spawning or taking ownership.
    } catch (error) {
      if (!pendingMemtraceOwner(error) && !disconnectedMemtraceClient(error))
        throw error;
    }
    if (this.abort.signal.aborted)
      throw Error("The Memtrace connection is closing.");
    let owned = this.owned.get(scope.dataDirectory);
    if (!owned) {
      const child = (this.options.spawn ?? spawn)(
        command.command,
        [
          ...command.prefix,
          "start",
          "--headless",
          "--workspace-file",
          scope.workspaceFile,
        ],
        {
          cwd: scope.directory,
          env: {
            ...env,
            MEMTRACE_MEMDB_DATA_DIR: scope.dataDirectory,
            MEMTRACE_DATA_DIR: scope.jobDirectory,
            MEMTRACE_NO_WATCH_RESTORE: "1",
            MEMTRACE_UI_PORT: "0",
          },
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      owned = { child, startedAt: Date.now(), output: "" };
      this.owned.set(scope.dataDirectory, owned);
      const record = owned;
      child.once("error", (error) => {
        record.failed = error;
      });
      child.once("close", (code) => {
        record.exited = code;
        if (this.owned.get(scope.dataDirectory) === record)
          this.owned.delete(scope.dataDirectory);
      });
      // Drain both pipes while retaining only a bounded diagnostic tail. Native
      // backoff/recovery messages must not disappear behind a generic exit code.
      const capture = (chunk: Buffer | string) => {
        record.output = (record.output + chunk.toString()).slice(-8192);
        const lines = diagnostic(record.output).split("\n").filter(Boolean);
        const latest = lines
          .reverse()
          .find((line) =>
            /start|recover|migrat|restor|wait|ready|backoff|paused|fail|error|download|embedding|model|coreml|onnx/i.test(
              line,
            ),
          );
        if (latest) record.progress = latest.slice(0, 500);
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
    }
    const deadline =
      owned.startedAt + (this.options.timeoutMs ?? memtraceOwnerTimeoutMs(env));
    let lastProgress = "",
      lastReport = 0;
    const report = (note: string) => {
      if (note === lastProgress && Date.now() - lastReport < 10_000) return;
      lastProgress = note;
      lastReport = Date.now();
      try {
        onProgress?.(note);
      } catch {
        /* A UI observer cannot abort recovery. */
      }
    };
    try {
      while (!this.abort.signal.aborted) {
        const elapsed = Math.floor((Date.now() - owned.startedAt) / 1000);
        report(
          owned.progress
            ? `Memtrace · ${owned.progress}`
            : `Preparing the local Memtrace engine · ${elapsed}s elapsed. Recovery can take several minutes.`,
        );
        if (owned.failed)
          throw new Error(
            "Memtrace could not launch this project's local engine. " +
              diagnostic(owned.failed.message) +
              diagnosticSuffix(owned),
            { cause: owned.failed },
          );
        if (owned.exited !== undefined && owned.exited !== 0)
          throw Error(
            `Memtrace could not start this project's local engine (exit ${owned.exited ?? "signal"}).${diagnosticSuffix(owned)}`,
          );
        try {
          await probe();
          report("The local Memtrace engine is ready.");
          return;
        } catch (error) {
          if (
            !pendingMemtraceOwner(error) &&
            !disconnectedMemtraceClient(error)
          )
            throw error;
        }
        if (Date.now() >= deadline)
          throw Error(
            "Memtrace is taking too long to prepare this project's local engine. Reconnect to inspect its state." +
              diagnosticSuffix(owned),
          );
        await pause(this.options.pollMs ?? 500, undefined, {
          signal: this.abort.signal,
        });
      }
      throw Error("The Memtrace connection is closing.");
    } catch (error) {
      if (this.owned.get(scope.dataDirectory) === owned) {
        this.owned.delete(scope.dataDirectory);
        await (this.options.stop ?? stopOwnedProcess)(owned.child);
      }
      if (this.abort.signal.aborted)
        throw Error("The Memtrace connection is closing.");
      throw error;
    }
  }

  async release(dataDirectory: string): Promise<void> {
    const record = this.owned.get(dataDirectory);
    if (!record) return;
    this.owned.delete(dataDirectory);
    await (this.options.stop ?? stopOwnedProcess)(record.child);
  }

  async close(): Promise<void> {
    this.abort.abort();
    const owned = [...this.owned.values()];
    this.owned.clear();
    await Promise.allSettled(
      owned.map((record) =>
        (this.options.stop ?? stopOwnedProcess)(record.child),
      ),
    );
  }
}
