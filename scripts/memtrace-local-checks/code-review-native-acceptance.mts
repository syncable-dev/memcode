import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { MemtraceEngine } from "../memcode/runtime/memtrace";
import { CodeReviewManager } from "../memcode/runtime/code-review";
import { WorkerManager } from "../memcode/runtime/workers";
import {
  WorkerChangeJournal,
  readWorkerChanges,
} from "../memcode/runtime/changes";
import {
  checkSourceBinding,
  runTaskVerification,
} from "../memcode/runtime/verification";
import { epicAnalysisProject } from "../memcode/runtime/epic-checkout";
import { initialState } from "../memcode/src/seed";
import { verifyBetaAccess } from "../memcode/runtime/beta-auth";
import {
  prepareReviewAnalysis,
  repairReviewPublication,
} from "../memcode/runtime/review-analysis-prepare";

async function main() {
  const [root, candidate, nativeSource, proofPath, app] = process.argv.slice(2),
    pause = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    hash = (s: any) => createHash("sha256").update(s).digest("hex");
  const clean = (e: any) =>
    String(e?.stack ?? e?.message ?? e)
      .replace(
        /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        "[redacted]",
      )
      .slice(-6000);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    }).trim();
  const report: any = {
    kind: "actual-product-code-review-native-e2e",
    startedAt: new Date().toISOString(),
    passed: false,
    normalProfilesTouched: false,
    refreshCredentialRead: false,
    diagnosticThreadStackBytes: null,
    testThreadStackBytes: null,
    buildProfile: "release-optimized",
    providerExecution: false,
    fixture:
      "Controlled real source edits, actual WorkerChangeJournal and node --test checks; no provider-generated coding claimed.",
    calls: [],
    events: [],
    retirementWarnings: [],
    forcedOwnerCleanup: false,
    tests: {},
  };
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const message = clean(args.map(String).join(" "));
    if (/owned Memtrace.*(?:retirement|process)/i.test(message)) {
      report.retirementWarnings.push({ at: new Date().toISOString(), message });
      if (/exceeded graceful retirement/i.test(message))
        report.forcedOwnerCleanup = true;
    }
    originalWarn(...args);
  };
  const nativeName = process.platform === "win32" ? "memtrace.exe" : "memtrace";
  const shared = true;
  report.sharedFileProjection = shared;
  const tracked = new Map<number, string>(),
    terminalProcesses = new Set<any>();
  let engine: MemtraceEngine,
    manager: CodeReviewManager,
    workers: WorkerManager;
  let state: any;
  async function processes() {
    const all =
      process.platform === "win32"
        ? JSON.parse(
            execFileSync(
              "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress",
              ],
              { encoding: "utf8", windowsHide: true, maxBuffer: 5000000 },
            ),
          )
        : execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,lstart=,comm="], {
            encoding: "utf8",
            maxBuffer: 5000000,
          })
            .split("\n")
            .flatMap((line) => {
              const m = line.match(
                /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
              );
              return m
                ? [
                    {
                      ProcessId: Number(m[1]),
                      ParentProcessId: Number(m[2]),
                      WorkingSetSize: Number(m[3]) * 1024,
                      CreationDate: m[4],
                      Name: m[5],
                    },
                  ]
                : [];
            });
    const identity = (p: any) => `${p.Name}|${p.CreationDate}`;
    const track = (pid: number) => {
      const p = all.find((p: any) => p.ProcessId === pid);
      if (p && !tracked.has(pid)) tracked.set(pid, identity(p));
    };
    const belongs = (p: any) => tracked.get(p.ProcessId) === identity(p);
    for (const client of (engine as any)?.clients?.values() ?? [])
      if (client.transport?.pid) track(client.transport.pid);
    for (const project of report.projects ?? []) {
      const scope = engine.scopeFor(project.id);
      if (scope)
        try {
          track(
            JSON.parse(
              await readFile(
                join(scope.dataDirectory, "daemon-state.json"),
                "utf8",
              ),
            ).pid,
          );
        } catch {}
    }
    for (let i = 0; i < 8; i++)
      for (const p of all)
        if (
          all.some(
            (parent: any) =>
              parent.ProcessId === p.ParentProcessId && belongs(parent),
          )
        )
          track(p.ProcessId);
    const owned = all.filter(belongs);
    return {
      graphOwners: owned.filter((p) => /memcore-server(?:\.exe)?$/.test(p.Name))
        .length,
      processes: owned,
    };
  }
  const event = (stage: string, data: any = {}) => {
    const item = { stage, at: new Date().toISOString(), ...data };
    report.stage = stage;
    report.events.push(item);
    console.log(JSON.stringify(item));
  };
  async function until(check: () => Promise<any>, ms = 240000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const answer = await check();
      if (answer) return answer;
      await pause(100);
    }
    throw Error("Timed out at " + report.stage);
  }
  const tests = `import test from 'node:test';import assert from 'node:assert/strict';import {normalize,quantityTotal} from '../src/quantity.mjs';import {formatAmount,receipt} from '../src/format.mjs';
test('quantity preserves valid values',()=>assert.equal(normalize(4.9),4));
test('quantity rejects text',()=>assert.throws(()=>normalize('4'),TypeError));
test('quantity rejects negative',()=>assert.throws(()=>normalize(-1),RangeError));
test('quantity totals through helper',()=>assert.equal(quantityTotal(3),6));
test('format amount has currency precision',()=>assert.equal(formatAmount(2),'$2.00'));
test('format rejects negative',()=>assert.throws(()=>formatAmount(-1),RangeError));
test('receipt calls format',()=>assert.equal(receipt(2),'Total: $2.00'));
`;
  const quantityBase = `export function normalize(value) { return Number(value); }\nexport function quantityTotal(value) { return normalize(value) * 2; }\n`;
  const formatBase = `export function formatAmount(value) { return '$' + value; }\nexport function receipt(value) { return 'Total: ' + formatAmount(value); }\n`;
  const quantity = (b = false) =>
    `export function normalize(value) {\n  if (typeof value !== 'number') throw new TypeError('Expected a number');\n  if (!Number.isFinite(value) || value < 0${b ? " || value > 1000" : ""}) throw new RangeError('Invalid quantity');\n  return Math.floor(value);\n}\nexport function quantityTotal(value) { return normalize(value) * 2; }\n`;
  const format = (b = false) =>
    `export function formatAmount(value) {\n  if (value < 0) throw new RangeError('Invalid amount');\n${b ? "  if (value > 10000) { if (value > 100000) throw new RangeError('Too large'); }\n" : ""}  return '$' + value.toFixed(2);\n}\nexport function receipt(value) { return 'Total: ' + formatAmount(value); }\n`;
  try {
    assert.equal(process.env.RUST_MIN_STACK, undefined);
    event("prepare-controlled-fixture");
    const descriptor = JSON.parse(await readFile(proofPath, "utf8"));
    assert.equal(descriptor.kind, "short-lived-engine-proof");
    assert.equal(descriptor.refreshToken, undefined);
    const verified = await verifyBetaAccess(descriptor.accessProof, descriptor);
    assert.ok(Date.parse(verified.expiresAt) > Date.now() + 180000);
    const access = join(root, "engine-access.jwt");
    await writeFile(access, descriptor.accessProof, { mode: 0o600 });
    const env = {
      ...process.env,
      MEMCODE_ENGINE_ACCESS_FILE: access,
      MEMCODE_ENGINE_DEVICE_ID: descriptor.deviceId,
      MEMCODE_ENGINE_SESSION_ID: descriptor.sessionId,
      MEMTRACE_ENGINEER: verified.account.id,
      MEMCORTEX_STORE_DIR: join(root, "cortex"),
      MEMTRACE_SKIP_EMBED: "1",
    };
    engine = new MemtraceEngine(() => join(candidate, nativeName), {
      privateProject: () => true,
      environment: async () => env,
    });
    const nativeCall = engine.call.bind(engine);
    engine.call = async (project: any, name: string, args: any = {}) => {
      const start = Date.now(),
        taskId = state?.tasks?.find(
          (t) =>
            t.run.analysisProjectId === project.id &&
            t.codeReview?.state === "running",
        )?.id;
      try {
        const value = await nativeCall(project, name, args);
        report.calls.push({
          projectId: project.id,
          taskId,
          tool: name,
          args,
          durationMs: Date.now() - start,
          value,
        });
        return value;
      } catch (error) {
        report.calls.push({
          projectId: project.id,
          taskId,
          tool: name,
          args,
          durationMs: Date.now() - start,
          error: clean(error),
        });
        throw error;
      }
    };

    report.app = {
      sourceCommit: git(app, "rev-parse", "HEAD"),
      runtimeSha256: hash(await readFile(join(app, "runtime/code-review.ts"))),
      analysisSha256: hash(
        await readFile(join(app, "runtime/code-review-analysis.ts")),
      ),
      snapshotSha256: hash(
        await readFile(join(app, "runtime/code-review-snapshot.ts")),
      ),
      prepareSha256: hash(
        await readFile(join(app, "runtime/review-analysis-prepare.ts")),
      ),
    };
    report.engine = {
      nativeSourceCommit: "6ec252fb65599d3a2aaae8df7daf5ae934c6a58a",
      sha256: hash(await readFile(join(candidate, nativeName))),
    };
    assert.equal(
      report.engine.sha256,
      process.env.OWNED_NATIVE_EXPECTED_ENGINE_SHA,
      "Use the exact compiled engine verified by the local build receipt",
    );
    report.engine.executableSha256 = report.engine.sha256;
    report.engine.baseCommit = report.engine.nativeSourceCommit;
    const canonical = join(root, "canonical", "repo");
    await mkdir(join(canonical, "src"), { recursive: true });
    await mkdir(join(canonical, "test"));
    git(canonical, "init", "-b", "main");
    await writeFile(join(canonical, ".gitignore"), ".memcode/\n");
    if (shared) {
      await writeFile(
        join(canonical, "src/domain.mjs"),
        quantityBase +
          "\n// Formatting section starts here.\n\n\n\n" +
          formatBase,
      );
    } else {
      await writeFile(join(canonical, "src/quantity.mjs"), quantityBase);
      await writeFile(join(canonical, "src/format.mjs"), formatBase);
    }
    await writeFile(
      join(canonical, "test/domain.test.mjs"),
      shared
        ? tests
            .replaceAll("../src/quantity.mjs", "../src/domain.mjs")
            .replaceAll("../src/format.mjs", "../src/domain.mjs")
        : tests,
    );
    git(canonical, "add", ".");
    git(
      canonical,
      "-c",
      "user.name=Review fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Controlled baseline",
    );
    state = initialState();
    state.settings.maxWorkers = 2;
    state.tasks = [];
    state.reviewWorkflows = {};
    state.epics = [];
    const parent = {
      id: "controlled-project",
      name: "Controlled review fixture",
      description: "",
      path: canonical,
      branch: "main",
      repoId: "repo",
      analysis: "ready",
      createdAt: new Date().toISOString(),
    };
    state.projects = [parent];
    state.activeProjectId = parent.id;
    const journal = new WorkerChangeJournal(),
      projects = [];
    for (const epic of ["a", "b"]) {
      const path = join(root, "epic-" + epic, "repo");
      await mkdir(join(root, "epic-" + epic));
      git(canonical, "worktree", "add", path, "-b", "epic/" + epic);
      projects.push({
        ...parent,
        id: "review-" + epic,
        path,
        branch: "epic/" + epic,
        analysisCheckout: "owned-worktree-v1",
      });
      for (const kind of ["quantity", "format"]) {
        const task = {
          id: epic + "-" + kind,
          projectId: parent.id,
          epicId: epic,
          identifier: "TEST-" + epic + "-" + kind,
          title: "Controlled " + kind + " change",
          description:
            "Synthetic controlled source patch for native review validation, not provider-generated coding.",
          stage: "review",
          priority: "medium",
          category: "Work",
          harness: "codex",
          scope: [shared ? "src/domain.mjs" : "src/" + kind + ".mjs"],
          checklist: [],
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          run: {
            state: "running",
            workspace: path,
            branch: "epic/" + epic,
            analysisProjectId: "review-" + epic,
            analysisRepoId: "repo",
            changeRunId: "implementation-" + epic + "-" + kind,
          },
        };
        state.tasks.push(task);
        if (!shared) await journal.begin(parent as any, task as any);
      }
    }
    report.projects = projects;
    for (const task of state.tasks) {
      const path = join(task.run.workspace, task.scope[0]),
        text = task.id.endsWith("quantity")
          ? quantity(task.epicId === "b")
          : format(task.epicId === "b");
      if (shared) {
        await journal.begin(parent as any, task);
        const before = await readFile(path, "utf8");
        await writeFile(
          path,
          before.replace(
            task.id.endsWith("quantity") ? quantityBase : formatBase,
            () => text,
          ),
        );
        await journal.release(parent as any, task);
      } else await writeFile(path, text);
    }
    for (const task of state.tasks) {
      if (!shared) await journal.release(parent as any, task);
      task.run.state = "finished";
      task.run.finishedAt = new Date().toISOString();
      task.run.finishedSourceBinding = await checkSourceBinding(
        task.run.workspace,
      );
      assert.ok(task.run.finishedSourceBinding);
      report.tests[task.id] = { journal: await readWorkerChanges(task) };
      assert.equal(report.tests[task.id].journal.files, 1);
    }
    // Actual child-process test transport supplies complete sequenced terminal output.
    // It tests runTaskVerification binding, not the native PTY surface.
    const sessions = new Map<string, any>();
    const terminals: any = {
      execute: async (taskId: string, input: any) => {
        if (input.action === "start") {
          const task = state.tasks.find((t) => t.id === taskId),
            id = "node-check-" + taskId + "-" + Date.now(),
            session = { id, status: "running", seq: 0, exitCode: null },
            chunks = [];
          const child = spawn(input.program, input.args, {
            cwd: task.run.workspace,
            env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          terminalProcesses.add(child);
          for (const stream of [child.stdout, child.stderr])
            stream.on("data", (part) =>
              chunks.push({
                seq: ++session.seq,
                data: part.toString("base64"),
              }),
            );
          child.on("close", (code) => {
            session.exitCode = code;
            session.status = "exited";
            terminalProcesses.delete(child);
          });
          sessions.set(id, { session, chunks, child });
          return { session: { ...session } };
        }
        const found = sessions.get(input.sessionId);
        if (input.action === "stop") {
          found?.child.kill();
          return {};
        }
        return {
          session: { ...found.session },
          chunks: found.chunks.filter((c) => c.seq > input.after),
        };
      },
    };
    event("run-real-node-tests-for-four-linked-contributions");
    for (const task of state.tasks) {
      const check = await runTaskVerification(() => state, terminals, {
        id: task.id,
        program: process.execPath,
        args: ["--test", "--test-reporter=tap", "test/domain.test.mjs"],
        format: "tap",
        timeoutMs: 30000,
      });
      report.tests[task.id].checks = check;
      assert.equal(check.linked, true);
      assert.equal(check.passed, 7);
      assert.equal(check.failed, 0);
    }
    workers = new WorkerManager(
      () => state,
      async () => {},
      engine,
      join(root, "profile"),
    );
    const delegate = {
      call: (project: any, name: string, args: any) =>
        engine.call(project, name, args),
    };
    manager = new CodeReviewManager(
      join(root, "profile"),
      () => state,
      delegate,
      async () => {},
      {
        reviewProject: (task, parent) => epicAnalysisProject(parent, task),
        implementationCount: () => workers.implementationCount(),
        implementationStarting: (id) => workers.implementationStarting(id),
        engineVersion: (p) => engine.versionFor(p.id) ?? "not reported",
        prepare: async (task, selected, update, assertActive) => {
          event("prepare-native-review", {
            task: task.id,
            project: selected.id,
          });
          const ready = await prepareReviewAnalysis(
            engine,
            selected,
            update,
            assertActive,
          );
          task.run.analysisRepoId = ready.repoId;
          await processes();
          return ready;
        },
        repairPublication: async (
          task,
          scope,
          update,
          assertActive,
          expectedSourceRevision,
        ) => {
          event("repair-late-native-publication", {
            task: task.id,
            project: scope.id,
          });
          await repairReviewPublication(
            engine,
            scope,
            update,
            assertActive,
            expectedSourceRevision,
          );
        },
        settled: async (task) => {
          const retirementAt = Date.now();
          event("retiring-native-review", { task: task.id });
          await workers.releaseIdleAnalysis(task, parent as any, {
            reviewSettled: true,
          });
          report.events.push({
            stage: "settled",
            at: new Date().toISOString(),
            task: task.id,
            retirementMs: Date.now() - retirementAt,
            owners: await processes(),
          });
        },
        queueFixes: async (id, text) => {
          (report.queuedFixes ??= []).push({ id, text });
        },
        accept: async (id) => {
          (report.accepted ??= []).push(id);
        },
      },
    );
    event("start-four-real-reviews-in-parallel");
    await Promise.all(state.tasks.map((task) => manager.start(task.id)));
    const runs = await Promise.all(
      state.tasks.map((task) =>
        until(async () => {
          const run = await manager.get(task.id);
          if (run && !["queued", "running"].includes(run.state)) return run;
        }),
      ),
    );
    for (let i = 0; i < runs.length; i++) {
      const task = state.tasks[i],
        run = runs[i];
      report.tests[task.id].review = run;
      console.log(
        JSON.stringify({
          task: task.id,
          state: run.state,
          outcome: run.outcome,
          metrics: run.metrics,
          limitations: run.coverage.limitations,
          impact: run.impact,
          audit: run.engine.audit,
        }),
      );
    }
    await until(async () => manager.occupiedSlots() === 0);
    report.afterInitialReviews = await processes();
    assert.ok(
      runs.every((run) => run.state === "completed"),
      "All four reviews must finish",
    );
    assert.ok(
      runs.every(
        (run) =>
          run.metrics.length > 0 &&
          run.metrics.every(
            (m) =>
              m.source === "ast" &&
              m.cognitive !== null &&
              m.cyclomatic !== null,
          ),
      ),
      "Native measured quality must reach every story",
    );
    assert.ok(
      runs.every((run) => run.checks.some((c) => c.state === "passed")),
      "Actual linked checks must reach every story",
    );
    assert.ok(
      runs.every((run) => run.snapshot.files.length === 1),
      "Review only each card contribution",
    );
    report.initialCoverageComplete = runs.every(
      (run) =>
        run.outcome === "ready" && run.coverage.complete && run.impact.complete,
    );
    event("request-real-followup-and-rerun-with-new-journal");
    const task = state.tasks[0],
      first = runs[0];
    await manager.requestFixes(
      task.id,
      first.id,
      [],
      "Add an explicit safe-integer upper bound and preserve the peer format change.",
    );
    assert.equal(report.queuedFixes.length, 1);
    await manager.beforeWorker(task.id);
    task.run.state = "running";
    task.run.changeRunId = "implementation-" + task.id + "-fix";
    await journal.begin(parent as any, task);
    const fixed = quantity(false).replace(
        "value < 0",
        "value < 0 || value > Number.MAX_SAFE_INTEGER",
      ),
      fixPath = join(task.run.workspace, task.scope[0]);
    await writeFile(
      fixPath,
      shared
        ? (await readFile(fixPath, "utf8")).replace(
            quantity(false),
            () => fixed,
          )
        : fixed,
    );
    await journal.release(parent as any, task);
    task.run.state = "finished";
    task.run.finishedSourceBinding = await checkSourceBinding(
      task.run.workspace,
    );
    task.run.checks = await runTaskVerification(() => state, terminals, {
      id: task.id,
      program: process.execPath,
      args: ["--test", "--test-reporter=tap", "test/domain.test.mjs"],
      format: "tap",
      timeoutMs: 30000,
    });
    assert.equal(task.run.checks.linked, true);
    const queued = await manager.start(task.id),
      rerun = await until(async () => {
        const r = await manager.get(task.id);
        return r?.id === queued.id && !["queued", "running"].includes(r.state)
          ? r
          : null;
      });
    report.fixRerun = rerun;
    assert.equal(rerun.state, "completed");
    assert.ok(
      rerun.metrics.length > 0,
      "Follow-up must retain attributable AST measurements",
    );
    assert.ok(
      rerun.checks.some((c) => c.state === "passed"),
      "Follow-up must retain linked verification",
    );
    assert.notEqual(rerun.snapshot.patchHash, first.snapshot.patchHash);
    assert.ok(rerun.implementationRunIds.includes(task.run.changeRunId));
    report.tests.peerAfterFix = await manager.get(state.tasks[1].id);
    assert.equal(
      report.tests.peerAfterFix.state,
      "stale",
      "Peer review becomes stale after shared epic source changes",
    );
    await manager.close();
    await engine.close();
    report.closeBoundary = await processes();
    const drainingAt = Date.now();
    await until(async () => (await processes()).processes.length === 0, 5000);
    report.naturalDrainMs = Date.now() - drainingAt;
    report.afterAllClose = await processes();
    assert.equal(report.afterAllClose.processes.length, 0);
    assert.equal(
      report.initialCoverageComplete,
      true,
      "Every controlled initial review must be READY with complete measured coverage",
    );
    assert.equal(
      rerun.outcome,
      "ready",
      "Controlled follow-up review must be READY",
    );
    assert.equal(rerun.coverage.complete, true);
    assert.equal(
      report.forcedOwnerCleanup,
      false,
      "No owned engine required forced retirement",
    );
    report.passed = true;
  } catch (error) {
    report.failure = clean(error);
    console.log(
      JSON.stringify({ failure: report.failure, stage: report.stage }),
    );
  } finally {
    await manager?.close().catch(() => {});
    await engine?.close().catch(() => {});
    for (const child of terminalProcesses) child.kill();
    report.cleanup = await processes();
    console.warn = originalWarn;
    await rm(join(root, "engine-access.jwt"), { force: true });
    report.finishedAt = new Date().toISOString();
    await writeFile(
      join(root, "result.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        passed: report.passed,
        root,
        failure: report.failure,
        remainingProcesses: report.cleanup.processes.length,
      }),
    );
    if (!report.passed) process.exitCode = 1;
  }
}
void main().catch((error) => {
  console.error(
    String(error?.message ?? error).replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[redacted]",
    ),
  );
  process.exitCode = 1;
});
