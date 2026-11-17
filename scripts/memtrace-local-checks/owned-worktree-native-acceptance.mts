import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  cp,
  stat,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyBetaAccess } from "../memcode/runtime/beta-auth";
import { MemtraceEngine } from "../memcode/runtime/memtrace";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const clean = (error: unknown) =>
  String((error as any)?.message ?? error)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(-3000);
const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 8000000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function unwrap(value: any) {
  if (value.isError)
    throw Error(
      value.content?.map((item: any) => item.text ?? "").join("\n") ??
        "Native tool failed",
    );
  for (const item of [...(value.content ?? [])].reverse()) {
    try {
      const parsed = JSON.parse(item.text);
      if (parsed.error) throw Error(parsed.error);
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  throw Error("Native tool returned no JSON");
}
type Scope = {
  name: string;
  root: string;
  branch: string;
  anchor: string;
  manifest: string;
  store: string;
  owner?: ChildProcess;
  ownerState?: any;
  output: string;
  client?: Client;
  clients: Client[];
  mcpPids: number[];
  exits?: any[];
  env: any;
};
async function main() {
  const [root, candidate, releaseDirectory, descriptorFile, appDirectory] =
    process.argv.slice(2);
  const nativeName = process.platform === "win32" ? "memtrace.exe" : "memtrace";
  const report: any = {
    kind: "candidate-owned-git-worktree-native-acceptance",
    startedAt: new Date().toISOString(),
    passed: false,
    normalProfilesTouched: false,
    refreshCredentialRead: false,
    buildProfile:
      process.env.OWNED_NATIVE_RELEASE === "1"
        ? "release-optimized"
        : "test-unoptimized",
    testThreadStackBytes:
      process.env.OWNED_NATIVE_RELEASE === "1" ? null : 16777216,
    tests: {},
    timings: {},
    calls: [],
  };
  if (process.env.OWNED_NATIVE_RELEASE === "1")
    assert.equal(
      process.env.RUST_MIN_STACK,
      undefined,
      "Release control must use the production default thread stack",
    );
  const scopes: Scope[] = [];
  let productEngine: MemtraceEngine | undefined;
  const trackedPids = new Set<number>();
  const stage = (value: string) => {
    report.stage = value;
    console.log(JSON.stringify({ stage: value }));
  };
  const now = () => performance.now();
  async function open(scope: Scope) {
    const transport = new StdioClientTransport({
      command: join(candidate, nativeName),
      args: ["mcp", "--workspace-file", scope.manifest],
      cwd: scope.anchor,
      env: scope.env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      scope.output = (scope.output + clean(chunk.toString())).slice(-10000);
    });
    const client = new Client(
      { name: "owned-worktree-acceptance", version: "1" },
      { capabilities: {} },
    );
    scope.clients.push(client);
    await client.connect(transport);
    if (transport.pid) scope.mcpPids.push(transport.pid);
    const processHandle = (transport as any)._process;
    if (processHandle) {
      scope.exits ??= [];
      const pid = processHandle.pid;
      processHandle.once("exit", (code: any, signal: any) =>
        scope.exits!.push({ pid, code, signal }),
      );
    }
    return client;
  }
  const call = async (
    scope: Scope,
    name: string,
    args: any = {},
    client = scope.client!,
  ) => {
    const started = now();
    report.currentCall = { scope: scope.name, tool: name };
    try {
      const answer = unwrap(
        await client.callTool({ name, arguments: args }, undefined, {
          timeout: 90000,
        }),
      );
      report.calls.push({
        scope: scope.name,
        tool: name,
        durationMs: Math.round(now() - started),
        ok: true,
      });
      return answer;
    } catch (error) {
      report.calls.push({
        scope: scope.name,
        tool: name,
        durationMs: Math.round(now() - started),
        ok: false,
        error: clean(error),
      });
      throw error;
    }
  };
  async function ready(scope: Scope) {
    scope.owner = spawn(
      join(candidate, nativeName),
      ["start", "--headless", "--workspace-file", scope.manifest],
      {
        cwd: scope.anchor,
        env: scope.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const capture = (chunk: Buffer) => {
      scope.output = (scope.output + clean(chunk.toString())).slice(-15000);
    };
    scope.owner.stdout?.on("data", capture);
    scope.owner.stderr?.on("data", capture);
    const started = now(),
      deadline = Date.now() + 180000;
    let last = "";
    while (Date.now() < deadline) {
      if (scope.owner.exitCode !== null)
        throw Error(
          `${scope.name} owner exited ${scope.owner.exitCode}: ${scope.output}`,
        );
      let client: Client | undefined;
      try {
        const published = JSON.parse(
          await readFile(join(scope.store, "daemon-state.json"), "utf8"),
        );
        if (
          published.pid !== scope.owner.pid ||
          !published.controlPort ||
          published.status === "stopping"
        )
          throw Error(
            "The explicitly started owner has not published its serving endpoint",
          );
        scope.ownerState = published;
        client = await open(scope);
        await call(scope, "list_indexed_repositories", {}, client);
        assert.doesNotMatch(
          scope.output,
          /No license found|Requesting device code|Claim URL:/,
        );
        scope.client = client;
        report.timings[scope.name + "OwnerReadyMs"] = Math.round(
          now() - started,
        );
        return;
      } catch (error) {
        last = clean(error);
        await client?.close().catch(() => {});
        await pause(350);
      }
    }
    throw Error(
      `${scope.name} owner readiness expired: ${last}; ${scope.output}`,
    );
  }
  async function stop(scope: Scope) {
    await snapshot();
    for (const client of scope.clients.splice(0))
      await client.close().catch(() => {});
    scope.client = undefined;
    if (scope.owner?.pid && scope.owner.exitCode === null) {
      if (process.platform === "win32") {
        try {
          execFileSync(
            "taskkill.exe",
            ["/PID", String(scope.owner.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore", timeout: 10000 },
          );
        } catch {
          scope.owner.kill();
        }
        await pause(500);
      } else {
        scope.owner.kill("SIGTERM");
        const deadline = Date.now() + 20000;
        while (
          scope.owner.exitCode === null &&
          scope.owner.signalCode === null &&
          Date.now() < deadline
        )
          await pause(100);
        if (scope.owner.exitCode === null && scope.owner.signalCode === null) {
          (report.forcedOwnerCleanup ??= []).push({
            scope: scope.name,
            pid: scope.owner.pid,
          });
          scope.owner.kill("SIGKILL");
          await pause(500);
        }
      }
    }
    scope.owner = undefined;
  }
  async function index(scope: Scope) {
    const started = now();
    const deadline = Date.now() + 180000;
    let request: any;
    while (Date.now() < deadline) {
      request = await call(scope, "index_directory", {
        repo_id: "repo",
        path: scope.root,
        branch: scope.branch,
        incremental: false,
        skip_embed: true,
      });
      if (request.job_id) break;
      if (request.reason === "peer_indexing" || request.skipped === true) {
        const revision = await call(scope, "get_query_revision", {
          repo_id: "repo",
          wait_ms: 2000,
        });
        if (revision.ready) {
          report.timings[scope.name + "IndexMs"] = Math.round(now() - started);
          return {
            status: "completed",
            adoptedPeerPublication: true,
            revision,
          };
        }
        await pause(250);
        continue;
      }
      throw Error("No index job id: " + JSON.stringify(request));
    }
    if (request.job_id) {
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const job = await call(scope, "check_job_status", {
          job_id: request.job_id,
        });
        if (job.status === "failed") throw Error(JSON.stringify(job));
        if (job.status === "completed") {
          report.timings[scope.name + "IndexMs"] = Math.round(now() - started);
          return job;
        }
        await pause(250);
      }
      throw Error("Index job deadline expired");
    }
    throw Error("No index job id: " + JSON.stringify(request));
  }
  async function certificate(scope: Scope, expected?: string) {
    let result: any;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      result = await call(scope, "get_query_revision", {
        repo_id: "repo",
        ...(expected ? { expected_source_revision: expected } : {}),
        wait_ms: 2000,
      });
      if (
        result.ready &&
        !result._meta?.stale &&
        result._meta?.graph_revision?.publication_unchanged_during_call !==
          false
      )
        return result;
      await pause(250);
    }
    throw Error(
      `${scope.name} certificate not ready: ${JSON.stringify(result)}`,
    );
  }
  const quality = (scope: Scope) =>
    call(scope, "get_function_quality_metrics", {
      repo_id: "repo",
      branch: scope.branch,
      function_name: "score",
      file_path: "src/index.ts",
    });
  const impact = (scope: Scope) =>
    call(scope, "get_impact", {
      repo_id: "repo",
      branch: scope.branch,
      target: "score",
      max_depth: 5,
    });
  async function capture(scope: Scope) {
    const deadline = Date.now() + 45000;
    let last: any;
    while (Date.now() < deadline) {
      const revision = await certificate(scope);
      const group = {
        revision,
        quality: await quality(scope),
        impact: await impact(scope),
        context: await call(scope, "get_symbol_context", {
          repo_id: "repo",
          branch: scope.branch,
          symbol: "score",
          file_path: "src/index.ts",
        }),
        processes: await call(scope, "list_processes", {
          repo_id: "repo",
          branch: scope.branch,
          limit: 10,
        }),
        review: await call(scope, "find_code_review_issues", {
          repo_id: "repo",
          repo_root: scope.root,
          diff: (() => {
            const value = git(scope.root, [
              "diff",
              "HEAD",
              "--",
              "src/index.ts",
            ]);
            return value ? value + "\n" : value;
          })(),
          base_sha_files: {
            "src/index.ts": git(scope.root, ["show", "HEAD:src/index.ts"]),
          },
          graph_mode: "strict",
          review_mode: "online",
          max_candidates: 20,
        }),
        closingRevision: await call(scope, "get_query_revision", {
          repo_id: "repo",
          expected_revision: revision.token,
        }),
      };
      last = group.closingRevision;
      if (
        !last.ready ||
        last.token !== revision.token ||
        last._meta?.stale ||
        last._meta?.graph_revision?.publication_unchanged_during_call === false
      ) {
        (report.transientQueryGroups ??= []).push({
          scope: scope.name,
          ready: last.ready,
          status: last.status,
          tokenChanged: last.token !== revision.token,
        });
        await pause(100);
        continue;
      }
      assert.equal(group.review._workflow, "deterministic_code_review");
      assert.equal(group.review._graph_state, "ready");
      assert.equal(typeof group.review._detectors, "object");
      return group;
    }
    throw Error(
      scope.name +
        " did not finish a stable query group: " +
        JSON.stringify(last),
    );
  }
  async function snapshot(
    roots = scopes.flatMap((s) => (s.owner?.pid ? [s.owner.pid] : [])),
  ) {
    const all =
      process.platform === "win32"
        ? JSON.parse(
            execFileSync(
              "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress",
              ],
              { encoding: "utf8", windowsHide: true, maxBuffer: 5000000 },
            ),
          )
        : execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,comm="], {
            encoding: "utf8",
            maxBuffer: 5000000,
          })
            .split("\n")
            .flatMap((line) => {
              const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
              return m
                ? [
                    {
                      ProcessId: Number(m[1]),
                      ParentProcessId: Number(m[2]),
                      WorkingSetSize: Number(m[3]) * 1024,
                      Name: m[4],
                    },
                  ]
                : [];
            });
    const mcpRoots = scopes.flatMap((scope) => scope.mcpPids);
    const ids = new Set([...trackedPids, ...roots, ...mcpRoots]);
    for (let i = 0; i < 8; i++)
      for (const process of all)
        if (ids.has(process.ParentProcessId)) ids.add(process.ProcessId);
    for (const pid of ids) trackedPids.add(pid);
    const processes = all.filter((process: any) => ids.has(process.ProcessId));
    return {
      ownerRoots: roots,
      mcpRoots,
      processes,
      totalWorkingSetBytes: processes.reduce(
        (n: number, p: any) => n + Number(p.WorkingSetSize ?? 0),
        0,
      ),
      workingSetNote:
        "Summed process residency includes shared pages; it is not unique physical RAM.",
      graphServerCount: processes.filter((p: any) =>
        /memcore-server/i.test(p.Name),
      ).length,
    };
  }
  try {
    stage("prepare-candidate");
    const proofDescriptor = JSON.parse(await readFile(descriptorFile, "utf8"));
    assert.equal(proofDescriptor.kind, "short-lived-engine-proof");
    assert.equal(proofDescriptor.refreshToken, undefined);
    const verified = await verifyBetaAccess(
      proofDescriptor.accessProof,
      proofDescriptor,
    );
    assert.ok(Date.parse(verified.expiresAt) > Date.now() + 240000);
    const proof = join(root, "engine-access.jwt");
    await writeFile(proof, proofDescriptor.accessProof, {
      flag: "wx",
      mode: 0o600,
    });
    report.engine = {
      version: execFileSync(join(candidate, nativeName), ["--version"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      executableSha256: hash(await readFile(join(candidate, nativeName))),
      baseCommit: git(releaseDirectory, ["rev-parse", "HEAD"]),
      sourceDiffSha256: hash(
        Buffer.from(git(releaseDirectory, ["diff", "--binary"])),
      ),
      ownedCheckoutModuleSha256: hash(
        await readFile(
          join(releaseDirectory, "crates/memtrace-mcp/src/owned_checkout.rs"),
        ),
      ),
      candidate: true,
    };
    const baseline = join(root, "canonical", "repo");
    await mkdir(join(baseline, "src"), { recursive: true });
    git(baseline, ["init", "-b", "main"]);
    const sourceCanonical =
      "export function score(value: number): number { return value + 1; }\nexport function canonicalCaller(value: number): number { return score(value); }\nexport function main() { return canonicalCaller(1); }\n";
    await writeFile(join(baseline, ".gitignore"), ".memcode/\n");
    await writeFile(join(baseline, "src/index.ts"), sourceCanonical);
    git(baseline, ["add", "."]);
    git(baseline, [
      "-c",
      "user.name=Acceptance",
      "-c",
      "user.email=acceptance@example.invalid",
      "commit",
      "-m",
      "Synthetic baseline",
    ]);
    const sourceA =
      "export function score(value: number): number { if (value > 0) return value + 2; return 0; }\nexport function onlyA(value: number): number { return score(value); }\nexport function main() { return onlyA(1); }\n";
    const sourceB =
      "export function score(value: number): number { if (value > 1) { if (value > 2) { if (value > 3) return value; return 3; } return 2; } return 1; }\nexport function onlyB(value: number): number { return score(value); }\nexport function secondB(value: number): number { return score(value + 10); }\nexport function main() { return onlyB(1); }\n";
    for (const [name, branch, source] of [
      ["canonical", "main", sourceCanonical],
      ["epic-a", "epic/a", sourceA],
      ["epic-b", "epic/b", sourceB],
    ]) {
      const path = name === "canonical" ? baseline : join(root, name, "repo");
      if (name !== "canonical") {
        await mkdir(join(root, name));
        git(baseline, ["worktree", "add", path, "-b", branch]);
        await writeFile(join(path, "src/index.ts"), source);
      }
      const anchor = join(path, ".memcode/memtrace");
      await mkdir(anchor, { recursive: true });
      const manifest = join(anchor, "workspace.toml");
      await writeFile(
        manifest,
        `version=1\n${name === "canonical" ? "" : 'checkout_mode="owned-worktree-v1"\n'}members=[${JSON.stringify(path.replaceAll("\\", "/"))}]\n`,
      );
      const env = {
        ...process.env,
        ...(process.env.OWNED_NATIVE_RELEASE === "1"
          ? {}
          : { RUST_MIN_STACK: "16777216" }),
        MEMTRACE_MEMDB_DATA_DIR: join(anchor, ".memdb"),
        MEMTRACE_DATA_DIR: join(anchor, "jobs"),
        MEMTRACE_NO_WATCH_RESTORE: "0",
        MEMTRACE_UI_PORT: "0",
        MEMTRACE_SKIP_EMBED: "1",
        MEMTRACE_START_AUTOINDEX: "0",
        MEMCODE_ENGINE_ACCESS_FILE: proof,
        MEMCODE_ENGINE_DEVICE_ID: proofDescriptor.deviceId,
        MEMCODE_ENGINE_SESSION_ID: proofDescriptor.sessionId,
        MEMTRACE_ENGINEER: verified.account.id,
        MEMCORTEX_STORE_DIR: join(root, "cortex"),
      };
      scopes.push({
        name,
        root: path,
        branch,
        anchor,
        manifest,
        store: env.MEMTRACE_MEMDB_DATA_DIR,
        clients: [],
        mcpPids: [],
        output: "",
        env,
      });
    }
    const common = await realpath(
      git(baseline, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
    report.tests.sharedGitObjects = [];
    for (const scope of scopes) {
      const actual = await realpath(
        git(scope.root, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]),
      );
      assert.equal(actual, common);
      if (scope.name !== "canonical")
        assert.equal((await stat(join(scope.root, ".git"))).isFile(), true);
      report.tests.sharedGitObjects.push({
        name: scope.name,
        commonDirectory: actual,
        gitDirectory: git(scope.root, ["rev-parse", "--absolute-git-dir"]),
      });
    }
    if (process.env.OWNED_NATIVE_PRODUCT === "1") {
      stage("actual-memcode-product-owned-lifecycle");
      for (const scope of scopes.slice(1)) await rm(scope.manifest);
      const authEnv = { ...scopes[1].env };
      delete authEnv.MEMTRACE_MEMDB_DATA_DIR;
      delete authEnv.MEMTRACE_DATA_DIR;
      productEngine = new MemtraceEngine(() => join(candidate, nativeName), {
        privateProject: () => true,
        environment: async () => authEnv,
      });
      const projects = scopes
        .slice(1)
        .map((scope) => ({
          id: "qa-product-" + scope.name,
          name: scope.name,
          description: "Disposable native owned epic acceptance",
          path: scope.root,
          branch: scope.branch,
          analysisCheckout: "owned-worktree-v1" as const,
          analysis: "idle" as const,
          repoId: "repo",
          createdAt: new Date().toISOString(),
        }));
      report.tests.product = {
        memcodeCommit: git(appDirectory, ["rev-parse", "HEAD"]),
        runtimeSha256: hash(
          await readFile(join(appDirectory, "runtime/memtrace.ts")),
        ),
        peerIndexSha256: hash(
          await readFile(join(appDirectory, "runtime/memtrace-peer-index.ts")),
        ),
        ownerSha256: hash(
          await readFile(join(appDirectory, "runtime/memtrace-owner.ts")),
        ),
        projects: [],
        progress: [],
      };
      for (let i = 0; i < projects.length; i++) {
        const project = projects[i],
          scope = scopes[i + 1];
        const started = now();
        project.repoId = await productEngine.analyze(project, (note) => {
          report.tests.product.progress.push({ scope: scope.name, note });
          console.log(JSON.stringify({ scope: scope.name, note }));
        });
        const binding = productEngine.scopeFor(project.id)!;
        scope.store = binding.dataDirectory;
        scope.client = await productEngine.connect(project);
        const pid = (productEngine as any).clients.get(project.id)?.transport
          ?.pid;
        if (pid) scope.mcpPids.push(pid);
        scope.ownerState = JSON.parse(
          await readFile(join(scope.store, "daemon-state.json"), "utf8"),
        );
        report.tests.product.projects.push({
          name: scope.name,
          project,
          binding,
          ownerState: scope.ownerState,
          analysisMs: Math.round(now() - started),
          capture: await capture(scope),
          diagnostics: productEngine.certificateDiagnosticsFor(project.id),
        });
      }
      const [aProject, bProject] = projects,
        [a, b] = scopes.slice(1);
      const aBefore = report.tests.product.projects[0].capture;
      assert.equal(aBefore.quality.function.cognitive_complexity, 1);
      assert.equal(
        report.tests.product.projects[1].capture.quality.function
          .cognitive_complexity,
        6,
      );
      const roots = [a.ownerState.pid, b.ownerState.pid];
      report.tests.product.beforeRetire = await snapshot(roots);
      stage("retire-one-real-product-epic");
      const stoppedAt = now();
      await productEngine.releaseEpic(aProject);
      report.tests.product.retireMs = Math.round(now() - stoppedAt);
      report.tests.product.afterRetire = await snapshot(roots);
      assert.ok(
        !report.tests.product.afterRetire.processes.some(
          (p: any) => p.ProcessId === a.ownerState.pid,
        ),
      );
      assert.ok(
        report.tests.product.afterRetire.processes.some(
          (p: any) => p.ProcessId === b.ownerState.pid,
        ),
      );
      assert.equal(
        (
          await productEngine.call(bProject, "get_query_revision", {
            repo_id: bProject.repoId,
          })
        ).ready,
        true,
      );
      stage("reopen-real-product-epic-cache");
      a.client = await productEngine.connect(aProject);
      const reopenPid = (productEngine as any).clients.get(aProject.id)
        ?.transport?.pid;
      if (reopenPid) a.mcpPids.push(reopenPid);
      report.tests.product.reopened = await capture(a);
      assert.equal(
        report.tests.product.reopened.revision.source_revision,
        aBefore.revision.source_revision,
      );
      const reopened = JSON.parse(
        await readFile(join(a.store, "daemon-state.json"), "utf8"),
      );
      roots.push(reopened.pid);
      await productEngine.releaseEpic(aProject);
      await productEngine.releaseEpic(bProject);
      report.tests.product.afterAllRetire = await snapshot(roots);
      assert.equal(report.tests.product.afterAllRetire.graphServerCount, 0);
      assert.ok(
        !report.tests.product.afterAllRetire.processes.some((p: any) =>
          /memtrace|memcore-server/i.test(p.Name),
        ),
      );
      report.passed = true;
      return;
    }
    if (process.env.OWNED_NATIVE_LEGACY_ONLY === "1") {
      stage("fresh-direct-owner-legacy-overlay-regression");
      const canonical = scopes[0];
      canonical.env.MEMTRACE_NO_WATCH_RESTORE = "1";
      canonical.client = await open(canonical);
      await call(canonical, "list_indexed_repositories");
      report.tests.legacy = {
        canonicalIndex: await index(canonical),
        canonical: await capture(canonical),
      };
      const legacy = join(root, "legacy-overlay");
      git(baseline, ["worktree", "add", legacy, "-b", "legacy/overlay"]);
      await writeFile(
        join(legacy, "src/index.ts"),
        sourceCanonical + "export function legacyBefore() { return 1; }\n",
      );
      const request = await call(canonical, "index_directory", {
        repo_id: "repo",
        path: legacy,
        branch: "legacy/overlay",
        skip_embed: true,
        incremental: true,
      });
      if (request.job_id) {
        for (let i = 0; i < 100; i++) {
          const job = await call(canonical, "check_job_status", {
            job_id: request.job_id,
          });
          if (job.status === "completed") {
            report.tests.legacy.overlayIndex = job;
            break;
          }
          await pause(100);
        }
      }
      assert.equal(
        report.tests.legacy.overlayIndex?.result?.private_source?.status,
        "complete",
      );
      report.tests.legacy.watch = await call(canonical, "watch_directory", {
        repo_id: "repo",
        path: legacy,
        branch: "legacy/overlay",
      });
      await writeFile(
        join(legacy, "src/index.ts"),
        sourceCanonical +
          "export function legacyBefore() { return 1; }\nexport function savedOverlayProbe() { return 42; }\n",
      );
      let answer: any,
        error = "";
      for (let i = 0; i < 100; i++) {
        try {
          answer = await call(canonical, "find_code", {
            repo_id: "repo",
            branch: "legacy/overlay",
            worktree: "repo:legacy-overlay",
            query: "savedOverlayProbe",
            limit: 5,
          });
          if (answer.found && answer.count) break;
        } catch (e) {
          error = clean(e);
        }
        await pause(150);
      }
      report.tests.legacy.afterSave = { answer, error };
      assert.equal(answer?.found, true);
      assert.equal(
        answer.private_source.graph_dependencies,
        "canonical_only; private graph unavailable",
      );
      report.tests.legacy.canonicalForeign = await call(
        canonical,
        "find_symbol",
        { repo_id: "repo", branch: "main", name: "savedOverlayProbe" },
      );
      assert.equal(report.tests.legacy.canonicalForeign.found, false);
      report.passed = true;
      return;
    }
    if (process.env.OWNED_NATIVE_DIRECT_ONLY === "1") {
      const direct = scopes[1];
      stage("cold-direct-mcp-owned-bootstrap");
      direct.client = await open(direct);
      await call(direct, "list_indexed_repositories");
      direct.ownerState = JSON.parse(
        await readFile(join(direct.store, "daemon-state.json"), "utf8"),
      );
      assert.equal(direct.ownerState.pid, direct.mcpPids.at(-1));
      assert.doesNotMatch(
        direct.output,
        /No license found|Requesting device code|Claim URL:/,
      );
      report.tests.direct = {
        ownerState: direct.ownerState,
        index: await index(direct),
        ...(await capture(direct)),
      };
      report.tests.direct.watch = await call(direct, "watch_directory", {
        repo_id: "repo",
        path: direct.root,
        branch: direct.branch,
      });
      await writeFile(
        join(direct.root, "src/watch.ts"),
        "export function watchDirect() { return 42; }\n",
      );
      let seen: any;
      for (let i = 0; i < 100; i++) {
        seen = await call(direct, "find_symbol", {
          repo_id: "repo",
          branch: direct.branch,
          name: "watchDirect",
        });
        if (seen.found) break;
        await pause(100);
      }
      assert.equal(seen?.found, true);
      report.tests.direct.afterSave = await capture(direct);
      report.tests.direct.beforeClose = await snapshot([]);
      stage("direct-transport-natural-close");
      const started = now();
      await stop(direct);
      await pause(1500);
      report.tests.direct.closeMs = Math.round(now() - started);
      report.tests.direct.exits = direct.exits;
      report.tests.direct.afterClose = await snapshot([]);
      assert.equal(report.tests.direct.afterClose.graphServerCount, 0);
      assert.equal(report.tests.direct.exits?.at(-1)?.code, 0);
      assert.equal(report.tests.direct.exits?.at(-1)?.signal, null);
      let retained: any;
      try {
        retained = JSON.parse(
          await readFile(join(direct.store, "daemon-state.json"), "utf8"),
        );
      } catch {}
      report.tests.direct.ownerStateAfterClose = retained ?? null;
      assert.equal(retained, undefined);
      report.passed = true;
      return;
    }
    for (const scope of scopes) {
      stage("start-and-index-" + scope.name);
      await ready(scope);
      const capabilities = await call(scope, "get_checkout_capabilities");
      assert.equal(capabilities.owned_worktree_v1, true);
      report.tests[scope.name] = {
        capabilities,
        ownerState: scope.ownerState,
        index: await index(scope),
        ...(await capture(scope)),
      };
    }
    const [canonical, a, b] = scopes;
    for (const scope of [a, b]) {
      const revision = report.tests[scope.name].revision;
      assert.equal(revision.checkout_mode, "owned-worktree-v1");
      assert.equal(revision.graph_scope, "owned_worktree_graph");
      assert.equal(revision.branch, scope.branch);
      assert.equal(
        await realpath(revision.worktree),
        await realpath(scope.root),
      );
    }
    assert.equal(
      report.tests["epic-a"].quality.function.cognitive_complexity,
      1,
    );
    assert.equal(report.tests["epic-a"].quality.function.complexity, 2);
    assert.equal(report.tests["epic-a"].quality.function.max_nesting, 1);
    assert.equal(
      report.tests["epic-b"].quality.function.cognitive_complexity,
      6,
    );
    assert.equal(report.tests["epic-b"].quality.function.complexity, 4);
    assert.equal(report.tests["epic-b"].quality.function.max_nesting, 3);
    assert.equal(report.tests["epic-a"].impact.total_affected, 2);
    assert.equal(report.tests["epic-b"].impact.total_affected, 3);
    assert.match(JSON.stringify(report.tests["epic-a"].context), /onlyA/);
    assert.doesNotMatch(
      JSON.stringify(report.tests["epic-a"].context),
      /onlyB/,
    );
    assert.match(JSON.stringify(report.tests["epic-b"].context), /onlyB/);
    for (const scope of [a, b]) {
      const processes = report.tests[scope.name].processes;
      assert.ok(
        processes.count > 0,
        "Fixture main entry must produce a branch-scoped process",
      );
      report.tests[scope.name].processFlow = await call(
        scope,
        "get_process_flow",
        {
          repo_id: "repo",
          branch: scope.branch,
          process: processes.processes[0].id,
          limit: 20,
        },
      );
    }
    stage("isolation-guards");
    report.tests.guards = [];
    for (const [name, args] of [
      [
        "index_directory",
        {
          repo_id: "repo",
          path: canonical.root,
          branch: "main",
          skip_embed: true,
        },
      ],
      ["watch_directory", { repo_id: "repo", path: b.root, branch: b.branch }],
      [
        "index_directory",
        {
          repo_id: "repo",
          path: a.root,
          branch: "wrong-branch",
          skip_embed: true,
        },
      ],
    ] as const) {
      let error = "",
        answer: any;
      try {
        answer = await call(a, name, args);
        if (answer.job_id) {
          for (let i = 0; i < 20; i++) {
            const job = await call(a, "check_job_status", {
              job_id: answer.job_id,
            });
            if (job.status === "completed") break;
            await pause(100);
          }
        }
      } catch (e) {
        error = clean(e);
      }
      report.tests.guards.push({ name, error, answer });
      assert.ok(error, JSON.stringify({ name, args, answer }));
    }
    report.tests.memoryBeforeExtraClients = await snapshot();
    const extraA = await open(a),
      extraB = await open(b);
    await Promise.all([
      call(
        a,
        "get_function_quality_metrics",
        {
          repo_id: "repo",
          branch: a.branch,
          function_name: "score",
          file_path: "src/index.ts",
        },
        extraA,
      ),
      call(
        b,
        "get_function_quality_metrics",
        {
          repo_id: "repo",
          branch: b.branch,
          function_name: "score",
          file_path: "src/index.ts",
        },
        extraB,
      ),
    ]);
    report.tests.memoryAfterExtraClients = await snapshot();
    assert.equal(report.tests.memoryBeforeExtraClients.graphServerCount, 3);
    assert.equal(report.tests.memoryAfterExtraClients.graphServerCount, 3);
    stage("shared-canonical-fleet");
    report.tests.fleet = [];
    for (const agent of ["epic-a-worker", "epic-b-worker"])
      report.tests.fleet.push(
        await call(canonical, "fleet_publish_intent", {
          repo_id: "repo",
          branch: "main",
          agent_id: agent,
          intent: { bug_fix: { defect: "logic_error" } },
          touched: ["src/index.ts"],
          assignment:
            "Disposable cross-epic integration advisory fixture; no source mutation.",
        }),
      );
    report.tests.fleetStatus = await call(canonical, "fleet_status", {
      repo_id: "repo",
      branch: "main",
    });
    assert.equal(report.tests.fleetStatus.active_agents, 2);
    assert.equal(report.tests.fleetStatus.live_intents, 2);
    assert.equal(report.tests.fleet[0].you, "epic-a-worker");
    assert.equal(report.tests.fleet[1].you, "epic-b-worker");
    assert.equal(
      report.tests.fleet[1].active_conflicts[0].agent_id,
      "epic-a-worker",
    );
    assert.equal(report.tests.fleet[1].coordination.would_escalate, false);
    stage("concurrent-private-watches");
    await Promise.all(
      [a, b].map(async (scope) => {
        report.tests[scope.name].watch = await call(scope, "watch_directory", {
          repo_id: "repo",
          path: scope.root,
          branch: scope.branch,
        });
        assert.equal(
          report.tests[scope.name].watch.index_scope.view,
          "owned_worktree_graph",
        );
      }),
    );
    const updatedA = sourceA.replace(
      "if (value > 0) return value + 2;",
      "if (value > 0) { if (value > 5) return value + 5; return value + 2; }",
    );
    const updatedB = sourceB.replace(
      "if (value > 1) { if (value > 2) { if (value > 3) return value; return 3; } return 2; } return 1;",
      "return value;",
    );
    await Promise.all(
      [a, b].map(async (scope, i) => {
        const started = now();
        await writeFile(
          join(scope.root, "src/index.ts"),
          i ? updatedB : updatedA,
        );
        await writeFile(
          join(scope.root, "src/watch.ts"),
          `export function ${i ? "watchB" : "watchA"}() { return ${i + 1}; }\n`,
        );
        const deadline = Date.now() + 45000;
        let found: any;
        while (Date.now() < deadline) {
          found = await call(scope, "find_symbol", {
            repo_id: "repo",
            branch: scope.branch,
            name: i ? "watchB" : "watchA",
          });
          if (found.found && found.count) break;
          await pause(200);
        }
        assert.equal(found.found, true);
        report.tests[scope.name].watchOwn = found;
        report.tests[scope.name].watchForeign = await call(
          scope,
          "find_symbol",
          {
            repo_id: "repo",
            branch: scope.branch,
            name: i ? "watchA" : "watchB",
          },
        );
        assert.equal(report.tests[scope.name].watchForeign.found, false);
        report.tests[scope.name].afterWatch = await capture(scope);
        report.timings[scope.name + "SavedWatchMs"] = Math.round(
          now() - started,
        );
        assert.notEqual(
          report.tests[scope.name].afterWatch.revision.source_revision,
          report.tests[scope.name].revision.source_revision,
        );
      }),
    );
    assert.equal(
      report.tests["epic-a"].afterWatch.quality.function.cognitive_complexity,
      3,
    );
    assert.equal(
      report.tests["epic-b"].afterWatch.quality.function.cognitive_complexity,
      0,
    );
    report.tests.canonicalAfterPrivateEdits = await capture(canonical);
    assert.equal(
      report.tests.canonicalAfterPrivateEdits.revision.source_revision,
      report.tests.canonical.revision.source_revision,
    );
    assert.equal(
      report.tests.canonicalAfterPrivateEdits.quality.function
        .cognitive_complexity,
      0,
    );
    report.tests.canonicalForeign = await call(canonical, "find_symbol", {
      repo_id: "repo",
      branch: "main",
      name: "watchA",
    });
    assert.equal(report.tests.canonicalForeign.found, false);
    stage("restart-with-persisted-watches");
    for (const scope of [a, b]) {
      await stop(scope);
      await ready(scope);
      report.tests[scope.name].restarted = await capture(scope);
      assert.equal(
        report.tests[scope.name].restarted.revision.source_revision,
        report.tests[scope.name].afterWatch.revision.source_revision,
      );
      const watched = await call(scope, "list_watched_paths");
      report.tests[scope.name].restoredWatch = watched;
      assert.match(JSON.stringify(watched), /owned_worktree_graph/);
    }
    if (process.env.OWNED_NATIVE_ONLY === "1") {
      report.passed = true;
      return;
    }
    stage("default-overlay-source-publication-regression");
    // Attached clients do not own watcher pipelines. Reopen the canonical store
    // as a direct MCP owner and explicitly arm a uniquely named legacy overlay.
    await stop(canonical);
    canonical.env.MEMTRACE_NO_WATCH_RESTORE = "1";
    canonical.client = await open(canonical);
    await call(canonical, "list_indexed_repositories");
    canonical.ownerState = JSON.parse(
      await readFile(join(canonical.store, "daemon-state.json"), "utf8"),
    );
    assert.equal(canonical.ownerState.pid, canonical.mcpPids.at(-1));
    report.tests.canonicalAfterDirectReopen = await capture(canonical);
    const legacy = join(root, "legacy-overlay");
    git(baseline, ["worktree", "add", legacy, "-b", "legacy/overlay"]);
    await writeFile(
      join(legacy, "src/index.ts"),
      sourceCanonical + "export function legacyBefore() { return 1; }\n",
    );
    const overlayRequest = await call(canonical, "index_directory", {
      repo_id: "repo",
      path: legacy,
      branch: "legacy/overlay",
      incremental: true,
      skip_embed: true,
    });
    if (overlayRequest.job_id) {
      for (let i = 0; i < 100; i++) {
        const job = await call(canonical, "check_job_status", {
          job_id: overlayRequest.job_id,
        });
        if (job.status === "completed") {
          report.tests.defaultOverlayIndex = job;
          break;
        }
        await pause(200);
      }
    }
    report.tests.defaultOverlayWatch = await call(
      canonical,
      "watch_directory",
      { repo_id: "repo", path: legacy, branch: "legacy/overlay" },
    );
    await writeFile(
      join(legacy, "src/index.ts"),
      sourceCanonical +
        "export function legacyBefore() { return 1; }\nexport function savedOverlayProbe() { return 42; }\n",
    );
    let overlay: any,
      overlayError = "";
    for (let i = 0; i < 100; i++) {
      try {
        overlay = await call(canonical, "find_code", {
          repo_id: "repo",
          branch: "legacy/overlay",
          worktree: "repo:legacy-overlay",
          query: "savedOverlayProbe",
          limit: 5,
        });
        if (overlay.found && overlay.count) break;
      } catch (error) {
        overlayError = clean(error);
      }
      await pause(250);
    }
    report.tests.defaultOverlayAfterSavedChange = {
      answer: overlay,
      transientError: overlayError,
    };
    assert.equal(overlay?.found, true);
    assert.equal(
      overlay.private_source.graph_dependencies,
      "canonical_only; private graph unavailable",
    );
    const fresh = await certificate(a);
    assert.equal(fresh.checkout_mode, "owned-worktree-v1");
    assert.equal(fresh.branch, "epic/a");
    report.tests.defaultOverlayCanonicalForeign = await call(
      canonical,
      "find_symbol",
      { repo_id: "repo", branch: "main", name: "savedOverlayProbe" },
    );
    assert.equal(report.tests.defaultOverlayCanonicalForeign.found, false);
    report.passed = true;
  } catch (error) {
    report.failure = clean(error);
  } finally {
    stage("cleanup");
    await productEngine?.close().catch(() => {});
    const ownerPids = scopes.flatMap((scope) =>
      scope.owner?.pid ? [scope.owner.pid] : [],
    );
    for (const scope of [...scopes].reverse()) {
      await stop(scope);
      report.tests[scope.name] ??= {};
      if (!report.passed)
        report.tests[scope.name].ownerDiagnostic = scope.output;
    }
    report.cleanup = await snapshot(ownerPids);
    if (report.cleanup.processes.length || report.forcedOwnerCleanup?.length) {
      report.passed = false;
      report.failure ??= "Owned test processes did not retire naturally";
      if (process.platform !== "win32") {
        report.failureCleanup = [];
        for (const p of report.cleanup.processes) {
          if (p.Name.startsWith(candidate + "/")) {
            try {
              process.kill(p.ProcessId, "SIGTERM");
              report.failureCleanup.push(p.ProcessId);
            } catch {}
          }
        }
        await pause(1500);
        report.afterFailureCleanup = await snapshot(ownerPids);
        for (const p of report.afterFailureCleanup.processes) {
          if (p.Name.startsWith(candidate + "/")) {
            try {
              process.kill(p.ProcessId, "SIGKILL");
            } catch {}
          }
        }
      }
    }
    await rm(join(root, "engine-access.jwt"), { force: true });
    report.finishedAt = new Date().toISOString();
    await writeFile(
      join(root, "result.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        root,
        passed: report.passed,
        failure: report.failure,
        engine: report.engine,
        timings: report.timings,
      }),
    );
  }
}
void main().catch((error) => {
  console.error(clean(error));
  process.exitCode = 1;
});
