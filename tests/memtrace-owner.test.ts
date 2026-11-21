import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  spawn as spawnProcess,
  type ChildProcess,
  type spawn,
} from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManagedMemtraceOwners,
  recordedOwnerState,
  pendingMemtraceOwner,
  memtraceOwnerTimeoutMs,
  memtraceOwnerShutdownTimeoutMs,
} from "../runtime/memtrace-owner.ts";

const pending = () =>
  Error(
    "-32603 repository summary revision probe failed: memdb: server_info unavailable: no workspace owner is attached yet; this session attaches when memtrace start publishes one",
  );
const scope = {
  directory: "C:/temporary/selected-project",
  workspaceFile:
    "C:/temporary/selected-project/.memcode/memtrace/workspace.toml",
  dataDirectory: "C:/temporary/selected-project/.memcode/memtrace/.memdb",
  jobDirectory: "C:/temporary/selected-project/.memcode/memtrace/.memtrace",
};
const command = { command: "node", prefix: ["installed/memtrace.js"] };
function fixture(
  flush?: () => Promise<void>,
  options: { recordedOwner?: () => Promise<"alive" | "gone" | "unknown"> } = {},
) {
  const child = Object.assign(new EventEmitter(), {
    pid: 123456,
    exitCode: null as number | null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcess;
  const spawns: unknown[][] = [],
    stopped: ChildProcess[] = [];
  const start = ((...args: unknown[]) => {
    spawns.push(args);
    return child;
  }) as typeof spawn;
  const owners = new ManagedMemtraceOwners({
    spawn: start,
    pollMs: 1,
    timeoutMs: 100,
    stop: async (process) => {
      stopped.push(process);
      await flush?.();
    },
    ...options,
  });
  return { owners, child, spawns, stopped };
}

test("pending owner is a distinct cold-start state, never generic wrong-store/auth failure", () => {
  assert.equal(pendingMemtraceOwner(pending()), true);
  assert.equal(pendingMemtraceOwner(Error("wrong_store")), false);
  assert.equal(pendingMemtraceOwner(Error("authentication expired")), false);
});

test("owner shutdown budget includes native durable flush and sidecar grace", () => {
  assert.equal(memtraceOwnerShutdownTimeoutMs({}), 135000);
  assert.equal(
    memtraceOwnerShutdownTimeoutMs({ MEMTRACE_MCP_SHUTDOWN_FLUSH_SECS: "300" }),
    315000,
  );
  assert.equal(
    memtraceOwnerShutdownTimeoutMs({
      MEMTRACE_SHUTDOWN_FLUSH_TIMEOUT_SECS: "300",
      MEMTRACE_MEMDB_SIDECAR_STOP_SECS: "40",
    }),
    355000,
  );
  assert.equal(
    memtraceOwnerShutdownTimeoutMs({ MEMTRACE_MCP_SHUTDOWN_FLUSH_SECS: "-1" }),
    135000,
  );
});

test(
  "Windows owned owner receives its native stop event and finishes a flush longer than the SDK close budget",
  { skip: process.platform !== "win32", timeout: 20000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "memcode-owned-grace-")),
      ready = join(directory, "ready"),
      finished = join(directory, "flushed"),
      fixtureScript = join(directory, "owner.ps1");
    await writeFile(
      fixtureScript,
      `param([string]$ReadyPath,[string]$FinishedPath)
$event = [System.Threading.EventWaitHandle]::new($false,[System.Threading.EventResetMode]::ManualReset,('Local\\memtrace-stop-' + $PID))
[System.IO.File]::WriteAllText($ReadyPath,'ready')
$null=$event.WaitOne()
Start-Sleep -Milliseconds 2700
[System.IO.File]::WriteAllText($FinishedPath,'flushed')
$event.Dispose()
exit 0
`,
    );
    const borrowed = spawnProcess(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    let owned: ChildProcess | undefined;
    const owners = new ManagedMemtraceOwners({
      spawn: (() =>
        (owned = spawnProcess(
          join(
            process.env.SystemRoot ?? "C:/Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            fixtureScript,
            ready,
            finished,
          ],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        ))) as unknown as typeof spawn,
      timeoutMs: 10000,
      pollMs: 20,
      stopGraceMs: 6000,
    });
    try {
      await owners.ready(scope, command, {}, async () => {
        if ((await readFile(ready, "utf8").catch(() => "")) !== "ready")
          throw pending();
      });
      const started = Date.now();
      await owners.release(scope.dataDirectory);
      assert.ok(
        Date.now() - started >= 2700,
        "must not force the owner out after two seconds",
      );
      assert.equal(await readFile(finished, "utf8"), "flushed");
      assert.equal(owned?.exitCode, 0);
      assert.equal(owned?.signalCode, null);
      assert.equal(borrowed.exitCode, null, "unrelated process remains alive");
    } finally {
      await owners.close();
      borrowed.kill();
      if (owned?.exitCode === null) owned.kill();
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  },
);

test(
  "Windows forced retirement stops only the exact owned launcher tree after the grace bound",
  { skip: process.platform !== "win32", timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "memcode-owned-fallback-")),
      ready = join(directory, "tree.json");
    const borrowed = spawnProcess(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    let owned: ChildProcess | undefined,
      descendant = 0;
    const owners = new ManagedMemtraceOwners({
      spawn: (() =>
        (owned = spawnProcess(
          process.execPath,
          [
            "-e",
            `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:child.pid})); setInterval(()=>{},1000);`,
            ready,
          ],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        ))) as unknown as typeof spawn,
      timeoutMs: 10000,
      pollMs: 20,
      stopGraceMs: 100,
    });
    try {
      await owners.ready(scope, command, {}, async () => {
        try {
          descendant = JSON.parse(await readFile(ready, "utf8")).pid;
        } catch {
          throw pending();
        }
      });
      await owners.release(scope.dataDirectory);
      assert.notEqual(owned?.exitCode, null);
      assert.throws(() => process.kill(descendant, 0), /ESRCH/);
      assert.equal(borrowed.exitCode, null);
    } finally {
      await owners.close();
      borrowed.kill();
      if (owned?.exitCode === null) owned.kill();
      if (descendant) {
        try {
          process.kill(descendant);
        } catch {}
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  },
);

test("a reachable owner is borrowed without a process or shutdown ownership", async () => {
  const f = fixture();
  await f.owners.ready(scope, command, {}, async () => {});
  await f.owners.close();
  assert.equal(f.spawns.length, 0);
  assert.equal(f.stopped.length, 0);
});

test("a store that still answers after its owner died is not borrowed: MemCode starts its own owner and waits for it to take over", async () => {
  // A previous MemCode run was killed. Its engine owner exits minutes later but leaves its
  // database server answering, until the next engine to start anywhere shuts it down.
  let owner: "alive" | "gone" = "gone";
  const f = fixture(undefined, { recordedOwner: async () => owner });
  let probes = 0,
    settled = false;
  const ready = f.owners
    .ready(scope, command, {}, async () => {
      probes++;
    })
    .then(() => {
      settled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.spawns.length, 1, "an ownerless store is taken over, not borrowed");
  assert.equal(settled, false, "not ready while only the dead owner's server answers");
  owner = "alive";
  await ready;
  assert.ok(probes >= 2, "the new owner is probed before the project is used");
  await f.owners.close();
  assert.deepEqual(f.stopped, [f.child], "MemCode owns what it started");
});

test("a reachable store whose owner is running is still borrowed", async () => {
  const f = fixture(undefined, { recordedOwner: async () => "alive" });
  await f.owners.ready(scope, command, {}, async () => {});
  await f.owners.close();
  assert.equal(f.spawns.length, 0);
  assert.equal(f.stopped.length, 0);
});

test("the store's own record says whether its owner process is still running", async () => {
  const store = await mkdtemp(join(tmpdir(), "memcode-owner-record-"));
  try {
    assert.equal(await recordedOwnerState(store), "unknown", "no record: nothing is known");
    const record = join(store, "daemon-state.json");
    await writeFile(record, JSON.stringify({ pid: process.pid }));
    assert.equal(await recordedOwnerState(store), "alive");
    const finished = spawnProcess(process.execPath, ["-e", ""]);
    await new Promise((resolve) => finished.once("exit", resolve));
    await writeFile(record, JSON.stringify({ pid: finished.pid }));
    assert.equal(await recordedOwnerState(store), "gone");
    await writeFile(record, "not a record");
    assert.equal(await recordedOwnerState(store), "unknown");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("certificate diagnostics are scoped, bounded and redacted without ordinary process output", async () => {
  const f = fixture();
  let queries = 0;
  await f.owners.ready(scope, command, {}, async () => {
    if (++queries < 2) throw pending();
  });
  f.child.stderr!.emit(
    "data",
    Buffer.from(
      "ordinary source output must stay private\n\u001b[31mWARN owned branch index could not be certified token=private-value password=private-password Bearer private-bearer\u001b[0m\n",
    ),
  );
  const lines = f.owners.certificateDiagnostics(scope.dataDirectory);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not be certified/);
  assert.doesNotMatch(
    lines[0],
    /private-value|private-password|private-bearer|ordinary source|\u001b/,
  );
  assert.deepEqual(f.owners.certificateDiagnostics("another-store"), []);
  for (let i = 0; i < 30; i++)
    f.child.stderr!.emit(
      "data",
      Buffer.from(`certificate ${i} ${"x".repeat(600)}\n`),
    );
  const tail = f.owners.certificateDiagnostics(scope.dataDirectory);
  assert.equal(tail.length, 8);
  assert.ok(tail.every((line) => line.length <= 500));
  await f.owners.close();
});

test("cold project starts exact one-member headless scope, waits for queries, closes only its child", async () => {
  const f = fixture();
  let queries = 0;
  await f.owners.ready(
    scope,
    command,
    { PATH: "prepared-path", USER_SETTING: "keep" },
    async () => {
      if (++queries < 4) throw pending();
    },
  );
  assert.equal(f.spawns.length, 1);
  const [binary, args, options] = f.spawns[0] as [
    string,
    string[],
    { cwd: string; env: Record<string, string>; shell?: boolean },
  ];
  assert.equal(binary, "node");
  assert.deepEqual(args, [
    "installed/memtrace.js",
    "start",
    "--headless",
    "--workspace-file",
    scope.workspaceFile,
  ]);
  assert.equal(options.cwd, scope.directory);
  assert.equal(options.env.MEMTRACE_MEMDB_DATA_DIR, scope.dataDirectory);
  assert.equal(options.env.MEMTRACE_DATA_DIR, scope.jobDirectory);
  assert.equal(options.env.MEMTRACE_UI_PORT, "0");
  assert.equal(options.env.USER_SETTING, "keep");
  assert.equal(options.shell, undefined);
  await f.owners.close();
  assert.deepEqual(f.stopped, [f.child]);
});

test("unexpected probe failures do not start or seize any owner", async () => {
  const f = fixture();
  await assert.rejects(
    f.owners.ready(scope, command, {}, async () => {
      throw Error("wrong_store");
    }),
    /wrong_store/,
  );
  assert.equal(f.spawns.length, 0);
  await f.owners.close();
});

test("overlapping bootstrap requests share one owned process", async () => {
  const f = fixture();
  let first = 0,
    second = 0;
  await Promise.all([
    f.owners.ready(scope, command, {}, async () => {
      if (++first < 3) throw pending();
    }),
    f.owners.ready(scope, command, {}, async () => {
      if (++second < 3) throw pending();
    }),
  ]);
  assert.equal(f.spawns.length, 1);
  await f.owners.close();
  assert.equal(f.stopped.length, 1);
});

test("reopening the same store waits for its native shutdown to release the database", async () => {
  let finish!: () => void;
  const draining = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture(() => draining);
  await f.owners.ready(scope, command, {}, async () => {
    if (!f.spawns.length) throw pending();
  });
  const retiring = f.owners.release(scope.dataDirectory);
  let probes = 0;
  const reopening = f.owners.ready(scope, command, {}, async () => {
    probes++;
    if (f.spawns.length < 2) throw pending();
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.spawns.length, 1, "the previous owner is still flushing");
    assert.equal(probes, 0, "a closing owner cannot be borrowed");
  } finally {
    finish();
    await Promise.all([retiring, reopening]);
    await f.owners.close();
  }
  assert.equal(f.spawns.length, 2);
  assert.equal(f.stopped.length, 2);
});

test("readiness timeout releases its own process instead of leaving a hidden owner", async () => {
  const f = fixture();
  await assert.rejects(
    f.owners.ready(scope, command, {}, async () => {
      throw pending();
    }),
    /taking too long/,
  );
  assert.equal(f.stopped.length, 1);
  await f.owners.close();
  assert.equal(f.stopped.length, 1);
});

test("close cancels bootstrap and cannot launch or stop a borrowed owner", async () => {
  const f = fixture();
  const waiting = f.owners.ready(scope, command, {}, async () => {
    throw pending();
  });
  await new Promise((done) => setTimeout(done, 5));
  await f.owners.close();
  await assert.rejects(waiting, /closing/);
  assert.equal(f.stopped.length, 1);
  await assert.rejects(
    f.owners.ready(scope, command, {}, async () => {}),
    /closing/,
  );
  assert.equal(f.spawns.length, 1);
});

test("owner readiness budget includes native recovery timeout instead of a 90 second cutoff", () => {
  assert.equal(memtraceOwnerTimeoutMs({}), 930_000);
  assert.equal(
    memtraceOwnerTimeoutMs({ MEMTRACE_MEMDB_SIDECAR_STARTUP_SECS: "1200" }),
    1_230_000,
  );
  assert.equal(
    memtraceOwnerTimeoutMs({ MEMTRACE_MEMDB_SIDECAR_STARTUP_SECS: "-1" }),
    930_000,
  );
  assert.equal(
    memtraceOwnerTimeoutMs({ MEMTRACE_MEMDB_SIDECAR_STARTUP_SECS: "invalid" }),
    930_000,
  );
  assert.equal(
    memtraceOwnerTimeoutMs({ MEMTRACE_MEMDB_SIDECAR_STARTUP_SECS: "7200" }),
    3_630_000,
  );
});

test("native startup backoff is visible and bounded with sensitive values redacted", async () => {
  const f = fixture();
  let probes = 0;
  await assert.rejects(
    f.owners.ready(scope, command, {}, async () => {
      if (++probes > 1) {
        f.child.stderr!.emit(
          "data",
          Buffer.from(
            "earlier noise ".repeat(2000) +
              "\n\u001b[31mStartup is paused after 3 failures. Use MEMTRACE_MEMDB_STARTUP_RETRY=1 for an explicit retry.\u001b[0m\napi_key=private-key password:private-pass Authorization: Bearer private-token\n",
          ),
        );
        f.child.emit("close", 1);
      }
      throw pending();
    }),
    (error) => {
      const message = (error as Error).message;
      assert.match(message, /Startup is paused after 3 failures/);
      assert.match(message, /MEMTRACE_MEMDB_STARTUP_RETRY=1/);
      assert.match(message, /exit 1/);
      assert.ok(message.length < 4300);
      assert.doesNotMatch(
        message,
        /private-key|private-pass|private-token|\u001b/,
      );
      return true;
    },
  );
  assert.equal(f.spawns.length, 1, "No automatic retry is attempted");
  await f.owners.close();
});

test("native recovery progress reaches the connection observer before readiness", async () => {
  const f = fixture(),
    notes: string[] = [];
  let probes = 0;
  await f.owners.ready(
    scope,
    command,
    {},
    async () => {
      if (++probes < 4) {
        if (probes === 2)
          f.child.stderr!.emit(
            "data",
            Buffer.from("Recovering the existing code graph · pass 2\n"),
          );
        throw pending();
      }
    },
    (note) => notes.push(note),
  );
  assert.ok(
    notes.some((note) => /Preparing the local Memtrace engine/.test(note)),
  );
  assert.ok(
    notes.some((note) => /Recovering the existing code graph/.test(note)),
  );
  assert.match(notes.at(-1)!, /engine is ready/);
  await f.owners.close();
});

test("first model download and embedding setup progress is visible, bounded and redacted before readiness", async () => {
  const f = fixture(),
    notes: string[] = [];
  const progress = [
    "Downloading model files token=private-download-token",
    "Loading embedding model password=private-model-password",
    "Compiling CoreML api_key=private-coreml-key",
    "Creating ONNX session Authorization: Bearer private-onnx-token " +
      "x".repeat(700),
  ];
  let probes = 0;
  try {
    await f.owners.ready(
      scope,
      command,
      {},
      async () => {
        probes++;
        if (probes === 1) throw pending();
        if (probes <= progress.length + 1) {
          f.child.stderr!.emit(
            "data",
            Buffer.from("\u001b[32m" + progress[probes - 2] + "\u001b[0m\n"),
          );
          throw pending();
        }
      },
      (note) => notes.push(note),
    );
    for (const label of [
      "Downloading model files",
      "Loading embedding model",
      "Compiling CoreML",
      "Creating ONNX session",
    ]) {
      assert.ok(
        notes.some((note) => note.includes(label)),
        label + " must reach the user during setup",
      );
    }
    assert.ok(notes.every((note) => note.length <= 512));
    assert.doesNotMatch(
      notes.join("\n"),
      /private-download-token|private-model-password|private-coreml-key|private-onnx-token|\u001b/,
    );
    assert.equal(notes.at(-1), "The local Memtrace engine is ready.");
  } finally {
    await f.owners.close();
  }
});
