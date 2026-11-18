import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
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
  dataDirectory: string;
  environment: Record<string, string>;
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

/** Match native durable-flush budgets, rather than the MCP SDK's two-second EOF window. */
export function memtraceOwnerShutdownTimeoutMs(
  env: Record<string, string>,
): number {
  const seconds = (name: string, fallback: number, ceiling: number) => {
    const value = Number(env[name]);
    return Number.isInteger(value) && value > 0
      ? Math.min(value, ceiling)
      : fallback;
  };
  return (
    (Math.max(
      seconds("MEMTRACE_MCP_SHUTDOWN_FLUSH_SECS", 120, 3600),
      seconds("MEMTRACE_SHUTDOWN_FLUSH_TIMEOUT_SECS", 10, 300) +
        seconds("MEMTRACE_MEMDB_SIDECAR_STOP_SECS", 30, 3600),
    ) +
      15) *
    1000
  );
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

// The native Windows daemon exposes this exact per-PID stop event. Process
// handles pin each observed child identity; no store lookup or global stop is used.
const WINDOWS_OWNED_STOP = `
param([int]$RootPid, [int]$GraceMs)
$ErrorActionPreference = 'Stop'
$owned = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$seen = [System.Collections.Generic.HashSet[int]]::new()
function Add-OwnedTree {
  $table = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($RootPid)
  foreach ($known in $owned) { if (-not $known.HasExited) { $queue.Enqueue($known.Id) } }
  while ($queue.Count -gt 0) {
    $target = $queue.Dequeue()
    if ($seen.Add($target)) {
      try { $process = [System.Diagnostics.Process]::GetProcessById($target); $null = $process.Handle; $owned.Add($process) } catch {}
    }
    foreach ($entry in $table) { if ($entry.ParentProcessId -eq $target -and -not $seen.Contains([int]$entry.ProcessId)) { $queue.Enqueue([int]$entry.ProcessId) } }
  }
}
try {
  Add-OwnedTree
  $requested = 0
  foreach ($process in $owned) {
    if ($process.HasExited) { continue }
    try { $event = [System.Threading.EventWaitHandle]::OpenExisting('Local\\memtrace-stop-' + $process.Id); try { if ($event.Set()) { $requested++ } } finally { $event.Dispose() } } catch {}
  }
  $window = if ($requested -gt 0) { $GraceMs } else { [Math]::Min($GraceMs, 5000) }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($window)
  while ([DateTime]::UtcNow -lt $deadline -and @($owned | Where-Object { -not $_.HasExited }).Count -gt 0) { Start-Sleep -Milliseconds 100 }
  $forced = 0
  if (@($owned | Where-Object { -not $_.HasExited }).Count -gt 0) {
    Add-OwnedTree
    for ($index = $owned.Count - 1; $index -ge 0; $index--) {
      $process = $owned[$index]
      if (-not $process.HasExited) { try { $process.Kill(); $forced++ } catch {} }
    }
  }
  foreach ($process in $owned) { if (-not $process.HasExited) { $null = $process.WaitForExit(5000) } }
  $survivors = @($owned | Where-Object { -not $_.HasExited } | ForEach-Object { $_.Id })
  @{requested=$requested; forced=$forced; survivors=$survivors} | ConvertTo-Json -Compress
} finally { foreach ($process in $owned) { $process.Dispose() } }
`;

async function stopOwnedProcess(
  record: OwnedProcess,
  graceMs?: number,
): Promise<void> {
  const child = record.child,
    pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  const budget = graceMs ?? memtraceOwnerShutdownTimeoutMs(record.environment);
  if (process.platform === "win32") {
    const shell = join(
      process.env.SystemRoot ?? "C:/Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    try {
      // Script is constant; the only arguments are the PID we spawned and a bounded budget.
      const { stdout } = await execute(
        shell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `& { ${WINDOWS_OWNED_STOP} }`,
          String(pid),
          String(budget),
        ],
        {
          windowsHide: true,
          timeout: budget + 15000,
          maxBuffer: 16000,
        },
      );
      const result = JSON.parse(stdout.trim());
      if (Array.isArray(result.survivors) && result.survivors.length)
        throw Error(
          "An owned Memtrace process did not stop after its shutdown budget.",
        );
      if (result.forced > 0)
        console.warn(
          "An owned Memtrace engine exceeded graceful retirement; its exact process tree was stopped. Its next open may require recovery.",
        );
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null)
        await execute(
          join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"),
          ["/PID", String(pid), "/T", "/F"],
          {
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 16000,
          },
        ).catch(() => child.kill());
      throw error;
    }
  } else {
    let owner = pid;
    // An npm launcher can parent the native owner. Signal only a process in
    // this detached owned group, so a backend borrowed from another app survives.
    try {
      const state = JSON.parse(
        await readFile(join(record.dataDirectory, "daemon-state.json"), "utf8"),
      );
      if (Number.isSafeInteger(state.pid) && state.pid > 0) {
        const { stdout } = await execute(
          "ps",
          ["-o", "pgid=", "-p", String(state.pid)],
          { timeout: 3000 },
        );
        if (Number(stdout.trim()) === pid) owner = state.pid;
      }
    } catch {
      /* An owner may not have published yet. The exact launcher is still ours. */
    }
    try {
      process.kill(owner, "SIGTERM");
    } catch {
      /* It already exited. */
    }
    const alive = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + budget;
    while (alive() && Date.now() < deadline) await pause(100);
    if (alive()) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* Group finished meanwhile. */
      }
      console.warn(
        "An owned Memtrace engine exceeded graceful retirement; its exact process group was stopped. Its next open may require recovery.",
      );
    }
  }
}

interface OwnerOptions {
  spawn?: typeof spawn;
  stop?: (child: ChildProcess) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  stopGraceMs?: number;
}

/** Only owns children it spawned; an already reachable owner is always borrowed. */
export class ManagedMemtraceOwners {
  private readonly owned = new Map<string, OwnedProcess>();
  private readonly draining = new Map<string, Promise<void>>();
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
    const directory = scope.dataDirectory;
    if (this.draining.has(directory)) {
      await this.draining.get(directory);
      return this.ready(scope, command, env, probe, onProgress);
    }
    const previous = this.owned.get(directory);
    let reachable = false;
    try {
      await probe();
      reachable = true;
    } catch (error) {
      if (!pendingMemtraceOwner(error) && !disconnectedMemtraceClient(error))
        throw error;
    }
    if (this.abort.signal.aborted)
      throw Error("The Memtrace connection is closing.");
    if (
      this.draining.has(directory) ||
      (previous && previous !== this.owned.get(directory))
    )
      return this.ready(scope, command, env, probe, onProgress);
    if (reachable) return; // Borrow a live owner without taking ownership.
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
      owned = {
        child,
        startedAt: Date.now(),
        output: "",
        dataDirectory: scope.dataDirectory,
        environment: env,
      };
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
        if (this.draining.has(directory))
          return this.ready(scope, command, env, probe, onProgress);
        try {
          await probe();
          if (
            this.draining.has(directory) ||
            this.owned.get(directory) !== owned
          )
            return this.ready(scope, command, env, probe, onProgress);
          if (this.abort.signal.aborted)
            throw Error("The Memtrace connection is closing.");
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
      if (this.owned.get(scope.dataDirectory) === owned)
        await this.release(scope.dataDirectory);
      if (this.abort.signal.aborted)
        throw Error("The Memtrace connection is closing.");
      throw error;
    }
  }

  async release(dataDirectory: string): Promise<void> {
    const pending = this.draining.get(dataDirectory);
    if (pending) return pending;
    const record = this.owned.get(dataDirectory);
    if (!record) return;
    // The native store lock can outlive its query endpoint. Reserve the
    // directory until the exact owner finishes its durable shutdown.
    const retirement = Promise.resolve()
      .then(() => this.stop(record))
      .then(() => {
        if (this.owned.get(dataDirectory) === record)
          this.owned.delete(dataDirectory);
      })
      .finally(() => this.draining.delete(dataDirectory));
    this.draining.set(dataDirectory, retirement);
    return retirement;
  }

  async close(): Promise<void> {
    this.abort.abort();
    const directories = new Set([
      ...this.owned.keys(),
      ...this.draining.keys(),
    ]);
    await Promise.allSettled(
      [...directories].map((directory) => this.release(directory)),
    );
  }
  private stop(record: OwnedProcess): Promise<void> {
    return this.options.stop
      ? this.options.stop(record.child)
      : stopOwnedProcess(record, this.options.stopGraceMs);
  }
}
