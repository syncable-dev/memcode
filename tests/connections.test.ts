import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { initialState } from "../src/seed";
import {
  assertWorkerConnected,
  connectedRuntimes,
  parseWorkerAuth,
  registerConnections,
} from "../runtime/worker-connections";
import {
  memtraceClaimUrl,
  MemtraceAccountManager,
  parseMemtraceStatus,
} from "../runtime/account";
import type { AppState, HarnessRuntime } from "../src/shared";
import type { Command } from "../runtime/commands";
import {
  workerApprovalMatches,
  type WorkerConnectionStatus,
} from "../src/connections";

test("Memtrace status never invents a person or returns credential fields", () => {
  const account = parseMemtraceStatus({
    auth_session: { state: "Valid", degraded: false },
    memdb: { owner_reachable: true, mode: "local" },
    session_token: "DO-NOT-EXPOSE",
    license_key: "PRIVATE",
  });
  assert.equal(account.status, "connected");
  assert.equal(account.principal, undefined);
  assert.doesNotMatch(JSON.stringify(account), /DO-NOT-EXPOSE|PRIVATE/);
  assert.equal(
    parseMemtraceStatus({
      auth_session: { state: "Valid", degraded: false },
      memdb: { owner_reachable: false },
    }).status,
    "unknown",
  );
  const seat = parseMemtraceStatus({
    auth_session: { state: "Valid", degraded: false },
    memdb: {
      mode: "external",
      seat_principal: "studio-seat-123",
      user_org_id: "studio",
    },
  });
  assert.equal(seat.principal?.id, "studio-seat-123");
  assert.equal(seat.organizationId, "studio");
  assert.equal(
    parseMemtraceStatus({
      auth_session: { state: "Expired", degraded: true },
      memdb: { seat_principal: "studio-seat-123" },
    }).principal,
    undefined,
  );
});

test("claim links permit only the official HTTPS Memtrace claim action", () => {
  assert.equal(
    memtraceClaimUrl("https://www.memtrace.io/claim?code=abc_def-123"),
    "https://www.memtrace.io/claim?code=abc_def-123",
  );
  for (const url of [
    "https://memtrace.io.evil/claim?code=abcdefgh",
    "http://memtrace.io/claim?code=abcdefgh",
    "https://memtrace.io/settings?code=abcdefgh",
    "https://user:secret@memtrace.io/claim?code=abcdefgh",
    "https://memtrace.io:9999/claim?code=abcdefgh",
    "https://memtrace.io/claim?code=abcdefgh&redirect=https://evil.test",
  ])
    assert.equal(memtraceClaimUrl(url), undefined);
});

test("provider auth status parsing exposes only harmless account labels", () => {
  assert.deepEqual(
    parseWorkerAuth("codex", "", "Logged in using an API key: sk-SECRET"),
    { auth: "authenticated", accountLabel: "Configured API key" },
  );
  assert.deepEqual(
    parseWorkerAuth(
      "claude",
      JSON.stringify({
        loggedIn: true,
        email: "user@example.com",
        accessToken: "SECRET",
      }),
    ),
    { auth: "authenticated", accountLabel: "user@example.com" },
  );
  assert.deepEqual(
    parseWorkerAuth(
      "cursor",
      JSON.stringify({
        isAuthenticated: true,
        userInfo: { email: "user@example.com" },
        token: "SECRET",
      }),
    ),
    { auth: "authenticated", accountLabel: "user@example.com" },
  );
  assert.equal(parseWorkerAuth("claude", "unexpected output").auth, "unknown");
});

test("provider auth distinguishes signed out from a status it cannot verify", () => {
  assert.equal(
    parseWorkerAuth("claude", '{"loggedIn":false}').auth,
    "not-authenticated",
  );
  assert.equal(
    parseWorkerAuth("cursor", '\u001b[32m{"isAuthenticated":false}\u001b[0m')
      .auth,
    "not-authenticated",
  );
  assert.equal(
    parseWorkerAuth("claude", '{"message":"unavailable"}').auth,
    "unknown",
  );
  assert.equal(parseWorkerAuth("cursor", "null").auth, "unknown");
});

test("installed adapters are disconnected until an explicit path-bound grant", () => {
  const state = initialState(),
    runtime: HarnessRuntime = {
      id: "codex",
      name: "Codex",
      available: true,
      path: "/bin/codex",
      models: [],
    };
  assert.throws(() => assertWorkerConnected(state, "codex"), /Connect Codex/);
  assert.deepEqual(connectedRuntimes(state, [runtime]), []);
  state.workerConnections = {
    codex: {
      harness: "codex",
      approvedAt: new Date().toISOString(),
      runtimePath: runtime.path!,
      auth: "authenticated",
      scopeVersion: 1,
    },
  };
  assert.doesNotThrow(() =>
    assertWorkerConnected(state, "codex", runtime.path!),
  );
  assert.deepEqual(connectedRuntimes(state, [runtime]), [runtime]);
  assert.throws(
    () => assertWorkerConnected(state, "codex", "/other/codex"),
    /Connect Codex/,
  );
});

test("legacy bundled-Node approval follows the provider across an app relocation, not an arbitrary script", () => {
  const state = initialState(),
    approvedAt = "2026-11-15T12:00:00Z";
  state.workerConnections = {
    codex: {
      harness: "codex",
      approvedAt,
      scopeVersion: 1,
      auth: "authenticated",
      runtimePath:
        "/Volumes/MemCode/MemCode.app/Contents/Resources/desktop-runtime/node",
    },
  };
  const runtime: HarnessRuntime = {
    id: "codex",
    name: "Codex",
    available: true,
    models: [],
    path: "/Applications/MemCode.app/Contents/Resources/desktop-runtime/node",
    runtimeIdentity:
      "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
  };
  assert.deepEqual(connectedRuntimes(state, [runtime]), [runtime]);
  assert.doesNotThrow(() =>
    assertWorkerConnected(
      state,
      "codex",
      runtime.path!,
      runtime.runtimeIdentity,
    ),
  );
  assert.throws(
    () =>
      assertWorkerConnected(
        state,
        "codex",
        runtime.path!,
        "/tmp/unknown-agent.mjs",
      ),
    /Connect Codex/,
  );
  assert.equal(state.workerConnections.codex?.approvedAt, approvedAt);
  state.workerConnections.codex!.runtimeIdentity = runtime.runtimeIdentity;
  assert.throws(
    () =>
      assertWorkerConnected(
        state,
        "codex",
        runtime.path!,
        "/other/node_modules/@openai/codex/bin/codex.js",
      ),
    /Connect Codex/,
  );
});

test("Cursor version upgrades keep consent only within the already approved installation", () => {
  const receipt = {
    harness: "cursor" as const,
    scopeVersion: 1 as const,
    auth: "authenticated" as const,
    approvedAt: "2026-11-15T12:00:00Z",
    runtimePath:
      "C:/Users/Test/AppData/Local/cursor-agent/versions/2026.1/node.exe",
  };
  const runtime = {
    id: "cursor" as const,
    path: "C:/Users/Test/AppData/Local/cursor-agent/versions/2026.2/node.exe",
    runtimeIdentity:
      "cursor-agent-install:c:/users/test/appdata/local/cursor-agent",
  };
  assert.equal(workerApprovalMatches(receipt, runtime), true);
  assert.equal(
    workerApprovalMatches(receipt, {
      ...runtime,
      runtimeIdentity: "cursor-agent-install:c:/unapproved/cursor-agent",
    }),
    false,
  );
  for (const alias of ["agent", "cursor-agent"]) {
    const macReceipt = {
      ...receipt,
      runtimePath: `/Users/demo/.local/bin/${alias}`,
    };
    const macRuntime = {
      id: "cursor" as const,
      path: "/Users/demo/.local/share/cursor-agent/versions/2026.2/cursor-agent",
      runtimeIdentity:
        "cursor-agent-install:/Users/demo/.local/share/cursor-agent",
    };
    assert.equal(workerApprovalMatches(macReceipt, macRuntime), true);
    assert.equal(
      workerApprovalMatches(macReceipt, {
        ...macRuntime,
        runtimeIdentity:
          "cursor-agent-install:/Users/other/.local/share/cursor-agent",
      }),
      false,
    );
    assert.equal(
      workerApprovalMatches(
        { ...macReceipt, runtimePath: "/usr/local/bin/agent" },
        macRuntime,
      ),
      false,
    );
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memcode-connect-test-")),
    script = join(directory, "cli.mjs"),
    audit = join(directory, "audit.ndjson");
  await writeFile(
    script,
    `import{appendFileSync}from'node:fs';const[name,...args]=process.argv.slice(2);appendFileSync(${JSON.stringify(audit)},JSON.stringify({name,args})+'\\n');if(name==='codex')console.error('Logged in using ChatGPT');else if(name==='claude')console.log(JSON.stringify({loggedIn:true,email:'test@example.com',accessToken:'SECRET'}));else if(name==='cursor')console.log(JSON.stringify({isAuthenticated:true,userInfo:{email:'test@example.com'},token:'SECRET'}));`,
  );
  return {
    directory,
    script,
    audit,
    cleanup: async () => {
      assert.ok(
        resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
          basename(directory).startsWith("memcode-connect-test-"),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("saved provider consent survives a changed host launcher, missing PATH and transient sign-in probes", async () => {
  const f = await fixture(),
    state = initialState();
  const provider = join(
    f.directory,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  await mkdir(join(provider, ".."), { recursive: true });
  await writeFile(
    join(f.directory, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFile(provider, await readFile(f.script, "utf8"));
  const approvedAt = "2026-11-15T12:00:00Z";
  state.workerConnections = {
    codex: {
      harness: "codex",
      approvedAt,
      runtimePath:
        "/Volumes/MemCode/MemCode.app/Contents/Resources/desktop-runtime/node",
      auth: "authenticated",
      scopeVersion: 1,
    },
  };
  let missing = false,
    gone = false,
    saves = 0;
  let identity = provider;
  const routes = new Map<
    string,
    { schema: any; handler: (input: any) => any }
  >();
  const command: Command = {
    command: process.execPath,
    prefix: [provider, "codex"],
    identity,
  };
  const registry = registerConnections(
    (name, schema, handler) => routes.set(name, { schema, handler }),
    () => state,
    async () => {
      saves++;
    },
    () => join(f.directory, "no-memtrace"),
    { call: async () => undefined as never },
    async (harness, configured = "") =>
      harness === "codex" && !gone && (!missing || configured === identity)
        ? { ...command, identity }
        : null,
  );
  const status = async () =>
    (await routes.get("connection:status")!.handler(undefined)).find(
      (item: any) => item.harness === "codex",
    );
  try {
    assert.equal((await status()).connected, true);
    assert.equal(saves, 1, "A legacy launcher receipt is migrated once.");
    assert.equal(state.workerConnections.codex?.approvedAt, approvedAt);
    assert.equal(state.workerConnections.codex?.runtimeIdentity, provider);
    assert.equal(state.workerConnections.codex?.runtimePath, process.execPath);
    missing = true;
    assert.equal(
      (await status()).connected,
      true,
      "A saved provider entry works when GUI PATH loses it.",
    );
    gone = true;
    const unavailable = await status();
    assert.equal(unavailable.installed, false);
    assert.equal(unavailable.approvalSaved, true);
    assert.equal(unavailable.approvedAt, approvedAt);
    assert.match(unavailable.note, /approval is saved/);
    gone = false;
    await writeFile(
      provider,
      "console.error('not logged in'); process.exit(1);\n",
    );
    const signedOut = await status();
    assert.equal(signedOut.auth, "not-authenticated");
    assert.equal(signedOut.connected, false);
    assert.equal(signedOut.approvalSaved, true);
    assert.equal(signedOut.approvedAt, approvedAt);
    await writeFile(provider, "throw Error('temporary status failure');\n");
    const unknown = await status();
    assert.equal(unknown.auth, "unknown");
    assert.equal(unknown.approvalSaved, true);
    assert.equal(state.workerConnections.codex?.approvedAt, approvedAt);
    missing = false;
    identity = join(
      f.directory,
      "other",
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    const changed = await status();
    assert.equal(
      changed.approvalSaved,
      false,
      "A different provider entry needs new consent even under the same Node launcher.",
    );
    assert.equal(state.workerConnections.codex?.runtimeIdentity, provider);
  } finally {
    await registry.close();
    await f.cleanup();
  }
});
test("connection consent uses only read-only auth probes and persists no credentials", async () => {
  const f = await fixture(),
    state = initialState(),
    routes = new Map<string, { schema: any; handler: (input: any) => any }>();
  let saves = 0;
  const registry = registerConnections(
    (name, schema, handler) => routes.set(name, { schema, handler }),
    () => state,
    async () => {
      saves++;
    },
    () => join(f.directory, "not-installed.exe"),
    { call: async () => undefined as any },
    async (name) => ["copilot", "dsh"].includes(name) ? null : ({ command: process.execPath, prefix: [f.script, name] }),
  );
  const call = (name: string, input?: unknown) => {
    const r = routes.get(name)!;
    return r.handler(r.schema.parse(input));
  };
  try {
    const installed = await call("connection:status");
    assert.equal(
      installed.filter((s: any) => !["copilot", "dsh"].includes(s.harness)).every((s: any) => s.installed && !s.connected),
      true,
    );
    assert.equal(state.workerConnections, undefined);
    assert.throws(() =>
      call("connection:approve", { harness: "claude", approved: false }),
    );
    const result = await call("connection:approve", {
      harness: "claude",
      approved: true,
    });
    assert.equal(result.connected, true);
    assert.equal(
      (state as AppState).workerConnections?.claude?.scopeVersion,
      1,
    );
    assert.equal(saves, 1);
    assert.doesNotMatch(
      JSON.stringify(state.workerConnections),
      /SECRET|accessToken|"token"/,
    );
    const audit = (await readFile(f.audit, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(audit.filter((row) => row.name === "claude").length, 2);
    assert.ok(
      audit.every(({ name, args }) =>
        name === "codex"
          ? args.join(" ") === "login status"
          : name === "claude"
            ? args.join(" ") === "auth status"
            : args.join(" ") === "status --format json",
      ),
    );
    const task = state.tasks[0];
    task.harness = "claude";
    task.example = false;
    task.run.state = "running";
    await assert.rejects(
      call("connection:disconnect", { harness: "claude" }),
      /Stop this adapter/,
    );
    task.run.state = "finished";
    await call("connection:disconnect", { harness: "claude" });
    assert.equal((state as AppState).workerConnections?.claude, undefined);
  } finally {
    await registry.close();
    await f.cleanup();
  }
});

for (const sample of [
  {
    harness: "dsh",
    output: `process.stderr.write('dsh: profile "acp" does not exist. PRIVATE-FIXTURE');`,
    issue: "unsupported-cli",
    guidance: /Update the DeepSeek Harness CLI/,
  },
  {
    harness: "copilot",
    output: `process.stdout.write('Not JSON. PRIVATE-FIXTURE\\n');`,
    issue: "unavailable",
    guidance: /couldn’t read.*GitHub Copilot/i,
  },
] as const) {
  test(`${sample.harness} reports a worker connection failure without exposing CLI output`, async () => {
    const f = await fixture();
    const state = initialState();
    const routes = new Map<string, (input: unknown) => unknown>();
    await writeFile(f.script, `${sample.output}\nprocess.exit(1);\n`);
    const registry = registerConnections(
      (name, schema, handler) =>
        routes.set(name, (input) => handler(schema.parse(input))),
      () => state,
      async () => assert.fail("No approval should be saved"),
      () => join(f.directory, "no-memtrace"),
      { call: async () => undefined as never },
      async (id) =>
        id === sample.harness
          ? { command: process.execPath, prefix: [f.script] }
          : null,
    );
    try {
      const statuses = (await routes.get("connection:status")!(undefined)) as
        WorkerConnectionStatus[];
      const status = statuses.find(({ harness }) => harness === sample.harness)!;
      assert.equal(status.connected, false);
      assert.equal(status.connectionIssue, sample.issue);
      assert.match(status.note, sample.guidance);
      assert.doesNotMatch(JSON.stringify(status), /PRIVATE-FIXTURE/);
      await assert.rejects(async () => {
        await routes.get("connection:approve")!({
          harness: sample.harness,
          approved: true,
        });
      }, { message: status.note });
      assert.equal(state.workerConnections, undefined);
    } finally {
      await registry.close();
      await f.cleanup();
    }
  });
}

test("explicit Memtrace sign-in delegates the official claim to the system-browser host only", async () => {
  const f = await fixture(),
    script = join(f.directory, "memtrace.mjs"),
    opened: any[] = [];
  await writeFile(
    script,
    `const args=process.argv.slice(2);if(args[0]==='status')console.log(JSON.stringify({auth_session:{state:'Valid',degraded:false},memdb:{owner_reachable:true},token:'SECRET'}));else if(args.join(' ')==='auth login'){console.error('Claim URL: https://www.memtrace.io/claim?code=test-device-code');setTimeout(()=>process.exit(0),500);}`,
  );
  const manager = new MemtraceAccountManager(() => script, {
    call: async (method, input) => {
      opened.push({ method, input });
      return undefined as any;
    },
  });
  try {
    const pending = await manager.signIn();
    assert.equal(pending.loginPending, true);
    for (let i = 0; i < 100 && !opened.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(opened, [
      {
        method: "open_memtrace_claim",
        input: { url: "https://www.memtrace.io/claim?code=test-device-code" },
      },
    ]);
    const loginDeadline = Date.now() + 5000;
    while (manager.current.loginPending && Date.now() < loginDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.current.loginPending, false);
    const status = await manager.refresh();
    assert.equal(status.status, "connected");
    assert.equal(status.principal, undefined);
    assert.doesNotMatch(JSON.stringify(status), /SECRET/);
  } finally {
    await manager.close();
    await f.cleanup();
  }
});

test("a confirmed official login fast-path works before a local owner has started", async () => {
  const f = await fixture(),
    script = join(f.directory, "memtrace-fast.mjs"),
    opened: any[] = [];
  await writeFile(
    script,
    `if(process.argv[2]==='status')console.log(JSON.stringify({auth_session:{state:'Valid',degraded:false},memdb:{owner_reachable:false}}));else console.error('Already signed in (community).');`,
  );
  const manager = new MemtraceAccountManager(() => script, {
    call: async (method) => {
      opened.push(method);
      return undefined as any;
    },
  });
  try {
    assert.equal((await manager.refresh()).status, "unknown");
    await manager.signIn();
    for (let i = 0; i < 100 && manager.current.loginPending; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await manager.refresh()).status, "connected");
    assert.equal(manager.current.principal, undefined);
    assert.deepEqual(opened, []);
  } finally {
    await manager.close();
    await f.cleanup();
  }
});
