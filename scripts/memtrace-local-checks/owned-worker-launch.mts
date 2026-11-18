import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { verifyBetaAccess } from "../../runtime/beta-auth";
import { commandIdentity, findCommand } from "../../runtime/commands";
import { ManagedMemcodeEngine } from "../../runtime/managed-engine";
import { certifiedPublication, writingSourceRevision } from "../../runtime/memtrace-peer-index";
import { MemtraceEngine } from "../../runtime/memtrace";
import { parseWorkerAuth } from "../../runtime/worker-connections";
import { WorkerManager } from "../../runtime/workers";
import { initialState } from "../../src/seed";
import type { Epic, Project, WorkItem } from "../../src/shared";

// Uses the same advisory lock as the real native writer. Only acquired in the disposable store.
const python = [
  "import os,sys,time",
  "f=open(sys.argv[1],'a+b')",
  "if os.name=='nt':",
  " import msvcrt",
  " def acquire():",
  "  f.seek(0); msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)",
  "else:",
  " import fcntl",
  " def acquire(): fcntl.flock(f.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)",
  "deadline=time.monotonic()+10",
  "while True:",
  " try: acquire(); break",
  " except OSError:",
  "  if time.monotonic()>=deadline: raise",
  "  time.sleep(.05)",
  "print('ready',flush=True); sys.stdin.buffer.read(1); f.close()",
].join("\n");
async function holdWriter(store: string) {
  const proc = spawn(process.platform === "win32" ? "python" : "python3", [
    "-u", "-c", python, join(store, "reheal-store-mutations.lock"),
  ], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const ended = once(proc, "close");
  proc.stdin.on("error", () => {});
  try {
    await Promise.race([once(proc.stdout, "data"), ended.then(() => { throw Error("Could not hold the fixture writer lock."); })]);
  } catch (error) {
    proc.stdin.end(); await ended.catch(() => {}); throw error;
  }
  return async () => { proc.stdin.end("x"); await ended; };
}
function git(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", windowsHide: true }).trim();
}
const flag = (name: string) => {
  const ix = process.argv.indexOf(name);
  return ix === -1 ? undefined : process.argv[ix + 1];
};

async function main() {
  if (!process.argv.includes("--run-codex")) {
    console.log("Usage: node --import tsx scripts/memtrace-local-checks/owned-worker-launch.mts --run-codex --access-file /path/to/test-profile/access.jwt [--resources /path/to/MemCode/resources]");
    return;
  }
  const accessFile = flag("--access-file");
  assert(accessFile, "Supply a current MemCode QA profile access.jwt with --access-file.");
  const proof = resolve(accessFile);
  const token = (await readFile(proof, "utf8")).trim();
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  const binding = { sessionId: claims.session_id, deviceId: claims.device_id };
  const verified = await verifyBetaAccess(token, binding);
  const resources = flag("--resources") ?? (process.platform === "darwin" ? "/Applications/MemCode.app/Contents/Resources" : undefined);
  assert(resources, "Supply the installed MemCode resources directory with --resources.");
  const codex = await findCommand("codex");
  assert(codex, "Install and sign in to Codex on this test computer.");
  const login = spawn(codex.command, [...codex.prefix, "login", "status"], { env: { ...process.env, ...codex.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let loginOutput = "";
  login.stdout.on("data", (chunk) => { loginOutput += chunk; });
  login.stderr.on("data", (chunk) => { loginOutput += chunk; });
  await once(login, "close");
  assert.equal(parseWorkerAuth("codex", loginOutput).auth, "authenticated", "Sign in to Codex before running the fixture.");

  const root = await realpath(await mkdtemp(join(tmpdir(), "memcode-owned-worker-")));
  const managed = new ManagedMemcodeEngine(join(root, "profile"), {
    bundledDirectory: join(resources, "memtrace-engine"),
    fetch: async () => { throw Error("The installed bundle must match the engine pin in this checkout."); },
  });
  let worker: WorkerManager | undefined;
  let engine: MemtraceEngine | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    const exe = await managed.prepare();
    engine = new MemtraceEngine(() => exe, {
      privateProject: () => true, managedGraphRoot: join(root, "graphs"),
      environment: async () => ({ ...managed.executionEnvironment(), MEMCORTEX_STORE_DIR: join(root, "cortex"),
        MEMCODE_ENGINE_ACCESS_FILE: proof, MEMCODE_ENGINE_SESSION_ID: binding.sessionId, MEMCODE_ENGINE_DEVICE_ID: binding.deviceId,
        MEMTRACE_ENGINEER: verified.account.id }),
    });
    const canonical = join(root, "source");
    await mkdir(canonical);
    const marker = randomUUID();
    git(canonical, "init", "-q", "-b", "main");
    await writeFile(join(canonical, ".gitignore"), ".memcode/\n");
    await writeFile(join(canonical, ".memtraceignore"), "unused-qa-one/\n");
    await writeFile(join(canonical, "WorkDetail.ts"), "export function startupProbe() { return " + JSON.stringify(marker) + "; }\n");
    git(canonical, "add", ".");
    git(canonical, "-c", "user.name=Fixture", "-c", "user.email=qa@example.invalid", "commit", "-qm", "Synthetic baseline");
    const now = new Date().toISOString();
    const project: Project = { id: randomUUID(), name: "Startup fixture", description: "", path: canonical, branch: "main", analysis: "idle", createdAt: now };
    const epic: Epic = { id: randomUUID(), projectId: project.id, identifier: "EP-02", title: "Private epic checkout", description: "", order: 0, phase: "now", color: "mint", branch: "epic/startup-check" };
    const task: WorkItem = { id: randomUUID(), identifier: "MC-064", projectId: project.id, epicId: epic.id, title: "Inspect startupProbe in WorkDetail",
      description: "Use the MemCode context tools to find startupProbe in WorkDetail.ts. Read its definition and reply with the exact value it returns. Make no source edits.",
      stage: "planned", priority: "medium", harness: "codex", permissionMode: "auto", assignment: "manual", category: "Quality", kind: "test",
      scope: ["WorkDetail.ts"], checklist: [], messages: [], createdAt: now, updatedAt: now, run: { state: "idle" } };
    const state = initialState();
    state.projects = [project]; state.epics = [epic]; state.tasks = [task]; state.activeProjectId = project.id;
    state.workerConnections = { codex: { harness: "codex", auth: "authenticated", scopeVersion: 1, approvedAt: now, runtimePath: codex.command, runtimeIdentity: commandIdentity(codex) } };
    project.repoId = await engine.analyze(project, () => {});
    project.analysis = "ready";
    let pinned: string | undefined;
    let sawPinnedWrite = false;
    let certifiedBeforeLaunch = false;
    let injected = false;
    const raw = engine.call.bind(engine);
    const currentEngine = engine;
    engine.call = async (p, name, args, signal) => {
      const first = await raw(p, name, args, signal);
      if (p.analysisCheckout !== "owned-worktree-v1" || name !== "get_query_revision") return first;
      if (!injected && certifiedPublication(first, p, args.repo_id)) {
        injected = true;
        release = await holdWriter(currentEngine.scopeFor(p.id)!.dataDirectory);
        await writeFile(join(p.path!, ".memtraceignore"), "unused-qa-one/\nunused-qa-two/\n");
        const busy = await raw(p, name, args, signal);
        pinned = writingSourceRevision(busy, p, args.repo_id);
        assert(pinned, "Native revision did not report the held writer on this epic.");
        return busy;
      }
      if (pinned && release && args.expected_source_revision === pinned && writingSourceRevision(first, p, args.repo_id) === pinned) {
        sawPinnedWrite = true;
        await release(); release = undefined;
      }
      if (sawPinnedWrite && !task.run.sessionId && args.expected_source_revision === pinned && certifiedPublication(first, p, args.repo_id)) {
        certifiedBeforeLaunch = true;
      }
      return first;
    };
    worker = new WorkerManager(() => state, async () => {}, engine, join(root, "profile"));
    await worker.start(task, project);
    const deadline = Date.now() + 240_000;
    while (task.run.state === "preparing" || task.run.state === "running") {
      assert(Date.now() < deadline, "Codex did not finish within four minutes after launch.");
      assert(!state.workerInputs?.some((input) => input.status === "pending"), "Codex requested approval. Re-run on an approved QA account.");
      await pause(250);
    }
    assert(sawPinnedWrite && certifiedBeforeLaunch, "Worker did not wait for the exact owned-source publication certificate.");
    assert.equal(task.run.state, "finished", task.run.error ?? "Codex did not finish.");
    assert(task.run.sessionId, "A real Codex session must be opened.");
    assert(task.messages.some((msg) => msg.role === "assistant" && msg.text.includes(marker)), "Worker did not return the fixture source value.");
    assert.notEqual(task.run.workspace, canonical);
    assert.equal(git(canonical, "branch", "--show-current"), "main");
    assert.equal(git(task.run.workspace!, "branch", "--show-current"), epic.branch);
    console.log(JSON.stringify({ passed: true, platform: process.platform, writerContentionObserved: true,
      sourcePinnedAndCertified: true, freshEpic: true, codexReadSource: true, model: task.run.measurements?.modelId ?? null }));
  } finally {
    try { await release?.(); } finally {
      try { await worker?.close(); } finally { try { await engine?.close(); } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); } }
    }
  }
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
