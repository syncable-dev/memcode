import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  BETA_ORIGIN,
  BETA_PROGRAM,
  BETA_TERMS,
  BetaRequestError,
  createBetaAuthorization,
  verifyBetaAccess,
  type BetaBinding,
  type BetaTokens,
  type BetaPublicKey,
} from "../runtime/beta-auth";
import {
  MemCodeBeta,
  type BetaCredentials,
  type BetaStorage,
  type BetaStoredState,
} from "../runtime/beta";
import { childEnv } from "../runtime/commands";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { createRuntime } from "../runtime/app";
import { ManagedMemcodeEngine } from "../runtime/managed-engine";
import { MemtraceEngine } from "../runtime/memtrace";

const pair = generateKeyPairSync("ed25519");
const publicKey = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "memcode-client-test",
  alg: "EdDSA",
  use: "sig",
} as BetaPublicKey;
const account = { id: "user-fixture", name: "Test member" };
const binding = {
  deviceId: "device-fixture-123456",
  sessionId: "session-fixture-123456",
};
function issue(
  bound: BetaBinding,
  now: number,
  changes: Record<string, unknown> = {},
  headerChanges: Record<string, unknown> = {},
) {
  const header = {
    alg: "EdDSA",
    typ: "JWT",
    kid: publicKey.kid,
    ...headerChanges,
  };
  const claims = {
    iss: "https://memtrace.io",
    aud: "memcode-engine-beta",
    purpose: "memcode-engine-beta",
    program: BETA_PROGRAM,
    sub: account.id,
    name: account.name,
    device_id: bound.deviceId,
    session_id: bound.sessionId,
    terms_version: BETA_TERMS,
    entitlements: {
      local_engine: true,
      graph_queries: "unlimited",
      cortex: true,
      improve: true,
      external_memdb: false,
      provider_credits: false,
    },
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 900,
    jti: randomBytes(32).toString("base64url"),
    ...changes,
  };
  const head = Buffer.from(JSON.stringify(header)).toString("base64url"),
    body = Buffer.from(JSON.stringify(claims)).toString("base64url"),
    input = head + "." + body;
  return (
    input +
    "." +
    sign(null, Buffer.from(input), pair.privateKey).toString("base64url")
  );
}
function tokens(bound: BetaBinding, now: number): BetaTokens {
  return {
    access_token: issue(bound, now),
    token_type: "Bearer",
    expires_in: 900,
    refresh_token: randomBytes(32).toString("base64url"),
    refresh_expires_at: new Date(now + 30 * 86400000).toISOString(),
    terms_version: BETA_TERMS,
    account,
  };
}
const loadKeys = async () => ({ keys: [publicKey] });
const delay = () => new Promise((resolve) => setImmediate(resolve));

test("engine beta proof is signed, account/device/session bound, and cannot grant provider credits or remote MemDB", async () => {
  const now = Date.now(),
    valid = issue(binding, now);
  assert.equal(
    (await verifyBetaAccess(valid, binding, { loadKeys })).account.id,
    account.id,
  );
  for (const changes of [
    { aud: "memcode-team" },
    { purpose: "memcode-team" },
    { device_id: "other-device" },
    { session_id: "other-session" },
    { terms_version: "unknown" },
    { exp: Math.floor(now / 1000) - 1 },
    { exp: Math.floor(now / 1000) + 901 },
    {
      entitlements: {
        local_engine: true,
        graph_queries: "unlimited",
        cortex: true,
        improve: true,
        external_memdb: true,
        provider_credits: true,
      },
    },
  ])
    await assert.rejects(
      verifyBetaAccess(issue(binding, now, changes), binding, { loadKeys }),
      /could not be verified/,
    );
  await assert.rejects(
    verifyBetaAccess(
      issue(binding, now, {}, { jku: "https://attacker.invalid/keys" }),
      binding,
      { loadKeys },
    ),
  );
  const tampered = valid.split(".");
  tampered[1] = Buffer.from(JSON.stringify({ sub: "changed" })).toString(
    "base64url",
  );
  await assert.rejects(
    verifyBetaAccess(tampered.join("."), binding, { loadKeys }),
  );
});

test("real loopback beta PKCE uses exact official URLs, checks state, and never forwards CLI/provider credentials", async () => {
  let opened: URL | undefined,
    redirect = "",
    challenge = "";
  const calls: string[] = [];
  const auth = createBetaAuthorization({
    openExternal: async (value) => {
      opened = new URL(value);
      assert.equal(opened.origin, BETA_ORIGIN);
      assert.equal(opened.pathname, "/api/memcode/beta/authorize");
      assert.equal([...opened.searchParams].length, 8);
      redirect = opened.searchParams.get("redirect_uri")!;
      challenge = opened.searchParams.get("code_challenge")!;
      const bad = new URL(redirect);
      bad.searchParams.set("state", "not-the-state");
      bad.searchParams.set("code", "c".repeat(43));
      assert.equal((await fetch(bad)).status, 404);
      const good = new URL(redirect);
      good.searchParams.set("state", opened.searchParams.get("state")!);
      good.searchParams.set("code", "c".repeat(43));
      const response = await fetch(good);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(await response.text(), /Approval received/);
    },
    fetcher: (async (url, options) => {
      calls.push(String(url));
      assert.equal(
        (options?.headers as Record<string, string>)?.authorization,
        undefined,
      );
      assert.equal(options?.redirect, "error");
      if (String(url).endsWith("/status"))
        return Response.json({
          available: true,
          program: BETA_PROGRAM,
          terms_version: BETA_TERMS,
        });
      if (String(url).endsWith("/revoke"))
        return new Response(null, { status: 204 });
      const body = JSON.parse(String(options?.body));
      assert.equal(body.redirect_uri, redirect);
      assert.equal(
        createHash("sha256").update(body.code_verifier).digest("base64url"),
        challenge,
      );
      assert.equal(body.code, "c".repeat(43));
      assert.ok(body.client.version);
      assert.equal(Object.hasOwn(body, "license_key"), false);
      return Response.json(tokens(binding, Date.now()));
    }) as typeof fetch,
  });
  const result = await auth.authorize(binding);
  assert.ok(result.refresh_token);
  await auth.revoke(result.refresh_token, binding);
  assert.equal(calls.length, 3);
  await assert.rejects(fetch(redirect));
});

test("cancel before readiness cannot open a browser or leave a callback listener", async () => {
  let release!: (response: Response) => void,
    opened = 0;
  const auth = createBetaAuthorization({
    openExternal: async () => {
      opened++;
    },
    fetcher: (() =>
      new Promise((resolve) => (release = resolve))) as typeof fetch,
  });
  const pending = auth.authorize(binding);
  const rejected = assert.rejects(pending, /cancelled/);
  auth.cancel();
  release(
    Response.json({
      available: true,
      program: BETA_PROGRAM,
      terms_version: BETA_TERMS,
    }),
  );
  await rejected;
  assert.equal(opened, 0);
});

test("browser approval finishes even if the native browser opener has not replied", async () => {
  let finishOpening!: () => void;
  let received!: () => void;
  const callbackReceived = new Promise<void>((resolve) => (received = resolve));
  const auth = createBetaAuthorization({
    openExternal: async (value) => {
      const authorization = new URL(value);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set(
        "state",
        authorization.searchParams.get("state")!,
      );
      callback.searchParams.set("code", "c".repeat(43));
      const response = await fetch(callback);
      assert.match(await response.text(), /Approval received/);
      received();
      return new Promise<void>((resolve) => (finishOpening = resolve));
    },
    fetcher: (async (url) =>
      String(url).endsWith("/status")
        ? Response.json({
            available: true,
            program: BETA_PROGRAM,
            terms_version: BETA_TERMS,
          })
        : Response.json(tokens(binding, Date.now()))) as typeof fetch,
  });
  const connecting = auth.authorize(binding);
  try {
    await callbackReceived;
    assert.equal(
      await Promise.race([connecting.then(() => true), wait(150, false)]),
      true,
    );
  } finally {
    finishOpening?.();
    await connecting;
  }
});

function storageFixture(initial?: {
  credentials?: BetaCredentials;
  accessToken?: string;
  accessFile?: string;
}) {
  let state: BetaStoredState = {
    configured: !!initial?.credentials,
    credentials: initial?.credentials ?? null,
    accessToken: initial?.accessToken,
    accessFile:
      initial?.accessFile ??
      join(tmpdir(), "memcode-beta-fixture", "access.jwt"),
  };
  const calls: string[] = [];
  const storage: BetaStorage = {
    read: async () => structuredClone(state),
    write: async (value) => {
      calls.push("store-refresh");
      state.credentials = structuredClone(value);
      state.configured = true;
      state.signedOut = value.signedOut === true;
    },
    writeAccess: async (value) => {
      calls.push("publish-access");
      assert.ok(state.credentials);
      assert.equal(state.signedOut, false);
      state.accessToken = value;
      return state.accessFile!;
    },
    clearAccess: async () => {
      calls.push("clear-access");
      state.accessToken = undefined;
    },
    markSignedOut: async () => {
      calls.push("tombstone");
      state.configured = true;
      state.signedOut = true;
      state.accessToken = undefined;
    },
    forgetSession: async () => {
      calls.push("forget-session");
      state.configured = true;
      state.signedOut = true;
      state.accessToken = undefined;
      state.credentials = null;
    },
    clear: async () => {
      calls.push("leave-beta");
      state = {
        configured: false,
        credentials: null,
        accessFile: state.accessFile,
      };
    },
  };
  return {
    storage,
    calls,
    get state() {
      return state;
    },
  };
}
function managerFixture() {
  let now = Date.now(),
    refreshes = 0,
    changes = 0,
    revokes: string[] = [],
    lastBinding: BetaBinding | undefined;
  const disk = storageFixture();
  const authorization = {
    available: async () => true,
    cancel: () => {},
    authorize: async (bound: BetaBinding) => {
      lastBinding = bound;
      return tokens(bound, now);
    },
    refresh: async (_token: string, bound: BetaBinding) => {
      refreshes++;
      return tokens(bound, now);
    },
    revoke: async (token: string) => {
      revokes.push(token);
    },
  };
  const options = {
    storage: disk.storage,
    authorization,
    loadKeys,
    now: () => now,
    assertMayChange: () => {},
    beforeIdentityChange: async () => {
      changes++;
    },
  };
  const manager = new MemCodeBeta(options);
  return {
    manager,
    disk,
    options,
    authorization,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
    get refreshes() {
      return refreshes;
    },
    get changes() {
      return changes;
    },
    get revokes() {
      return revokes;
    },
    get lastBinding() {
      return lastBinding;
    },
  };
}

test("cancelling a beta reconnect stops waiting for the previous session rotation", async () => {
  const fixture = managerFixture();
  let releaseRefresh!: (value: BetaTokens) => void;
  try {
    await fixture.manager.connect();
    fixture.advance(14 * 60000);
    const previousBinding = fixture.lastBinding!;
    fixture.authorization.refresh = async () =>
      new Promise((resolve) => (releaseRefresh = resolve));
    const refreshing = fixture.manager.refresh();
    await delay();
    const connecting = fixture.manager.connect();
    const cancelled = assert.rejects(connecting, /cancelled/);
    await delay();
    const cancel = fixture.manager.cancel();
    const rotated = tokens(previousBinding, fixture.now);
    try {
      assert.equal(
        await Promise.race([cancel.then(() => true), wait(150, false)]),
        true,
      );
    } finally {
      releaseRefresh(rotated);
      await Promise.all([refreshing, cancelled, cancel]);
    }
    assert.equal(
      (fixture.disk.state.credentials as BetaCredentials).refreshToken,
      rotated.refresh_token,
    );
  } finally {
    await fixture.manager.close();
  }
});

test("approved sign-in reconnects code context without waiting for a stale analysis request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memcode-beta-analysis-race-"));
  const folder = join(root, "source");
  await mkdir(folder);
  execFileSync("git", ["init", "--initial-branch=main", folder], { stdio: "ignore" });
  const command = join(root, "fixture-engine.mjs");
  await writeFile(command, "");
  let releaseAnalysis!: (id: string) => void;
  let analysisStarted!: () => void;
  const started = new Promise<void>((resolve) => (analysisStarted = resolve));
  const oldAnalysis = new Promise<string>((resolve) => (releaseAnalysis = resolve));
  let analyzeCalls = 0;
  t.mock.method(MemtraceEngine.prototype, "analyze", async () => {
    if (++analyzeCalls > 1) return "connected-graph";
    analysisStarted();
    return oldAnalysis;
  });
  t.mock.method(ManagedMemcodeEngine.prototype, "prepare", async () => command);
  const realFetch = globalThis.fetch;
  let approvedBinding!: BetaBinding;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== BETA_ORIGIN) return realFetch(input, init);
    if (url.pathname.endsWith("/status"))
      return Response.json({ available: true, program: BETA_PROGRAM, terms_version: BETA_TERMS });
    if (url.pathname.endsWith("/token")) return Response.json(tokens(approvedBinding, Date.now()));
    if (url.pathname.endsWith("/jwks")) return Response.json({ keys: [publicKey] });
    throw Error("Unexpected beta endpoint");
  });
  const runtime = await createRuntime(join(root, "profile"), root, {
    async call<T>(method: string, input?: unknown): Promise<T> {
      if (method === "beta_store_read") return { configured: false, credentials: null } as T;
      if (method === "beta_store_write") return null as T;
      if (method === "beta_access_write") return { accessFile: join(root, "access.jwt") } as T;
      if (method === "select_folder") return folder as T;
      if (method === "preview_hide") return null as T;
      if (method === "open_memcode_beta") {
        const request = new URL((input as { url: string }).url);
        approvedBinding = {
          deviceId: request.searchParams.get("device_id")!,
          sessionId: request.searchParams.get("session_id")!,
        };
        const callback = new URL(request.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "c".repeat(43));
        callback.searchParams.set("state", request.searchParams.get("state")!);
        assert.match(await (await realFetch(callback)).text(), /Approval received/);
        return null as T;
      }
      throw Error("Unexpected native operation " + method);
    },
  }, () => {});
  let analyzing: Promise<unknown> | undefined;
  let connecting: Promise<unknown> | undefined;
  try {
    runtime.store.state.settings.memtracePath = command;
    await runtime.request("project:select-folder");
    const item = (await runtime.request("project:create", {
      mode: "existing",
      parent: folder,
      name: "Local project",
      description: "Keep its saved checkout",
    })) as { id: string };
    analyzing = runtime.request("project:analyze", item.id).catch(() => {});
    await started;
    connecting = runtime.request("beta:connect");
    assert.equal(
      await Promise.race([connecting.then(() => true), wait(1200, false)]),
      true,
    );
    await runtime.request("project:analyze", item.id);
    releaseAnalysis("stale-graph");
    await analyzing;
    const project = runtime.store.state.projects.find((entry) => entry.id === item.id);
    assert.equal(project?.path, await realpath(folder));
    assert.equal(project?.repoId, "connected-graph");
  } finally {
    releaseAnalysis("stale-graph");
    await Promise.allSettled([analyzing, connecting]);
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser approval stores refresh before publishing proof and exposes only safe status/engine hints", async () => {
  const fixture = managerFixture();
  try {
    const status = await fixture.manager.connect();
    assert.equal(status.state, "connected");
    assert.equal(status.loginPending, false);
    assert.equal(status.accessMode, "beta");
    assert.deepEqual(fixture.disk.calls.slice(-2), [
      "store-refresh",
      "publish-access",
    ]);
    const env = await fixture.manager.environment();
    assert.deepEqual(Object.keys(env).sort(), [
      "MEMCODE_ENGINE_ACCESS_FILE",
      "MEMCODE_ENGINE_DEVICE_ID",
      "MEMCODE_ENGINE_SESSION_ID",
      "MEMCORTEX_STORE_DIR",
      "MEMTRACE_ENGINEER",
    ]);
    assert.equal(env.MEMCODE_ENGINE_DEVICE_ID, fixture.lastBinding?.deviceId);
    assert.equal(env.MEMTRACE_ENGINEER, account.id);
    assert.equal(
      env.MEMCORTEX_STORE_DIR,
      join(
        dirname(fixture.disk.state.accessFile!),
        "cortex",
        createHash("sha256").update(account.id).digest("hex"),
      ),
    );
    const encoded = JSON.stringify(status);
    assert.ok(
      !encoded.includes(
        (fixture.disk.state.credentials as BetaCredentials).refreshToken,
      ),
    );
    assert.ok(!encoded.includes(fixture.disk.state.accessToken!));
    assert.ok(!encoded.includes("access.jwt"));
  } finally {
    fixture.manager.close();
  }
});

test("concurrent engine reads renew once and persist the rotated secret before using the new proof", async () => {
  const fixture = managerFixture();
  try {
    await fixture.manager.connect();
    const old = (fixture.disk.state.credentials as BetaCredentials)
      .refreshToken;
    fixture.advance(14 * 60000);
    await Promise.all(
      Array.from({ length: 8 }, () => fixture.manager.environment()),
    );
    assert.equal(fixture.refreshes, 1);
    assert.notEqual(
      (fixture.disk.state.credentials as BetaCredentials).refreshToken,
      old,
    );
    assert.equal(
      fixture.changes,
      1,
      "same-session refresh does not restart the engine",
    );
  } finally {
    fixture.manager.close();
  }
});

test("same-session refresh reuses its verified signing key, fetches a changed kid and still rejects a forged signature", async () => {
  const fixture = managerFixture();
  let keyLoads = 0,
    keys = [publicKey];
  fixture.options.loadKeys = async () => {
    keyLoads++;
    return { keys };
  };
  try {
    await fixture.manager.connect();
    assert.equal(keyLoads, 1);
    await fixture.manager.refresh();
    assert.equal(
      keyLoads,
      1,
      "ordinary rotation must not wait on a redundant JWKS request",
    );
    const nextPair = generateKeyPairSync("ed25519");
    const nextKey = {
      ...nextPair.publicKey.export({ format: "jwk" }),
      kid: "rotated-test-key",
      alg: "EdDSA",
      use: "sig",
    } as BetaPublicKey;
    keys = [nextKey];
    const signed = (bound: BetaBinding, forge = false) => {
      const next = tokens(bound, fixture.now);
      const head = Buffer.from(
        JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: nextKey.kid }),
      ).toString("base64url");
      const input = head + "." + next.access_token.split(".")[1];
      next.access_token =
        input +
        "." +
        sign(
          null,
          Buffer.from(input),
          forge ? pair.privateKey : nextPair.privateKey,
        ).toString("base64url");
      return next;
    };
    fixture.authorization.refresh = async (_, bound) => signed(bound);
    await fixture.manager.refresh();
    assert.equal(
      keyLoads,
      2,
      "an unknown kid must load and verify the current official keys",
    );
    assert.equal(
      (fixture.disk.state.credentials as BetaCredentials).publicKey.kid,
      nextKey.kid,
    );
    await fixture.manager.refresh();
    assert.equal(keyLoads, 2);
    const retained = structuredClone(fixture.disk.state);
    fixture.authorization.refresh = async (_, bound) => signed(bound, true);
    await fixture.manager.refresh();
    assert.equal(keyLoads, 2);
    assert.deepEqual(
      fixture.disk.state,
      retained,
      "a matching cached kid never bypasses cryptographic verification",
    );
  } finally {
    await fixture.manager.close();
  }
});

test("update shutdown retains an in-flight one-use refresh rotation for the next launch", async () => {
  const fixture = managerFixture();
  let resumed: MemCodeBeta | undefined;
  try {
    await fixture.manager.connect();
    fixture.advance(14 * 60000);
    let release!: (value: BetaTokens) => void;
    let rotated: BetaTokens | undefined;
    fixture.authorization.refresh = async (_secret, bound) => {
      rotated = tokens(bound, fixture.now);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const refreshing = fixture.manager.refresh();
    await delay();
    assert.ok(rotated);
    const closing = fixture.manager.close();
    release(rotated);
    await Promise.all([refreshing, closing]);
    assert.equal(
      (fixture.disk.state.credentials as BetaCredentials).refreshToken,
      rotated.refresh_token,
      "a consumed server token must be replaced in secure storage before shutdown",
    );
    assert.equal(
      fixture.revokes.length,
      0,
      "updating must not revoke the account",
    );
    fixture.authorization.authorize = async () => {
      throw Error("A restart must not request browser approval");
    };
    fixture.authorization.refresh = async (secret, bound) => {
      assert.equal(
        secret,
        rotated!.refresh_token,
        "the next launch must use the committed rotated secret",
      );
      return tokens(bound, fixture.now);
    };
    resumed = new MemCodeBeta({
      ...fixture.options,
      storage: fixture.disk.storage,
    });
    assert.equal((await resumed.status()).state, "connected");
    fixture.advance(14 * 60000);
    assert.equal((await resumed.refresh()).state, "connected");
  } finally {
    await resumed?.close();
    await fixture.manager.close();
  }
});

test("shutdown bounds a stalled refresh drain and rejects a response after its deadline", async (context) => {
  const fixture = managerFixture();
  let release!: (value: BetaTokens) => void;
  try {
    await fixture.manager.connect();
    const original = (fixture.disk.state.credentials as BetaCredentials)
      .refreshToken;
    fixture.advance(14 * 60000);
    fixture.authorization.refresh = async () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const refreshing = fixture.manager.refresh();
    await delay();
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let done = false;
    const closing = fixture.manager.close().then(() => {
      done = true;
    });
    await delay();
    context.mock.timers.tick(16999);
    await delay();
    assert.equal(done, false);
    context.mock.timers.tick(1);
    await closing;
    assert.equal(
      done,
      true,
      "shutdown must stay inside the native runtime's twenty-second grace",
    );
    release(tokens(fixture.lastBinding!, fixture.now));
    await refreshing;
    assert.equal(
      (fixture.disk.state.credentials as BetaCredentials).refreshToken,
      original,
      "late responses after shutdown must not mutate the retained account",
    );
  } finally {
    context.mock.timers.reset();
    await fixture.manager.close();
  }
});

test("shutdown still cancels a late browser account approval without replacing the retained account", async () => {
  const fixture = managerFixture();
  try {
    await fixture.manager.connect();
    const original = structuredClone(fixture.disk.state.credentials);
    let release!: (value: BetaTokens) => void;
    let pendingBinding!: BetaBinding;
    fixture.authorization.authorize = async (bound) => {
      pendingBinding = bound;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const connecting = fixture.manager.connect();
    const rejected = assert.rejects(connecting, /cancelled/);
    await delay();
    await fixture.manager.close();
    release(tokens(pendingBinding, fixture.now));
    await rejected;
    assert.deepEqual(fixture.disk.state.credentials, original);
    assert.equal(fixture.revokes.length, 0);
  } finally {
    await fixture.manager.close();
  }
});

test("an account switch waiting for rotation cannot start a browser approval after shutdown", async () => {
  const fixture = managerFixture();
  try {
    await fixture.manager.connect();
    fixture.advance(14 * 60000);
    let release!: (value: BetaTokens) => void;
    let approvals = 0;
    fixture.authorization.refresh = async () =>
      new Promise((resolve) => {
        release = resolve;
      });
    fixture.authorization.authorize = async (bound) => {
      approvals++;
      return tokens(bound, fixture.now);
    };
    const refreshing = fixture.manager.refresh();
    await delay();
    const switching = fixture.manager.connect();
    const rejected = assert.rejects(switching, /cancelled/);
    await delay();
    const closing = fixture.manager.close();
    const rotated = tokens(fixture.lastBinding!, fixture.now);
    release(rotated);
    await Promise.all([refreshing, closing, rejected]);
    assert.equal(approvals, 0);
    assert.equal(
      (fixture.disk.state.credentials as BetaCredentials).refreshToken,
      rotated.refresh_token,
    );
    await assert.rejects(fixture.manager.connect(), /cancelled/);
  } finally {
    await fixture.manager.close();
  }
});

test("logout retains beta-mode tombstone, blocks paid CLI fallback, and survives a restart", async () => {
  const fixture = managerFixture();
  try {
    await fixture.manager.connect();
    await fixture.manager.signOut();
    assert.equal(fixture.disk.state.configured, true);
    assert.equal(fixture.disk.state.signedOut, true);
    assert.equal(fixture.disk.state.credentials, null);
    assert.equal(fixture.disk.state.accessToken, undefined);
    assert.throws(() => fixture.manager.assertMayStart(), /paid CLI session/);
    await assert.rejects(fixture.manager.environment(), /paid CLI session/);
    const restarted = new MemCodeBeta({
      ...fixture.options,
      storage: fixture.disk.storage,
    });
    try {
      assert.equal((await restarted.status()).accessMode, "beta");
      await assert.rejects(restarted.environment(), /paid CLI session/);
    } finally {
      restarted.close();
    }
    const cli = await fixture.manager.useExistingCLI();
    assert.equal(cli.accessMode, "installed-cli");
    assert.deepEqual(await fixture.manager.environment(), {});
  } finally {
    fixture.manager.close();
  }
});

test("offline sign-out clears proof locally, retains only encrypted pending revocation, and never rejoins on restart", async () => {
  const fixture = managerFixture();
  fixture.authorization.revoke = async () => {
    throw Error("Offline");
  };
  try {
    await fixture.manager.connect();
    const result = await fixture.manager.signOut();
    assert.equal(result.state, "disconnected");
    assert.equal(result.revocationPending, true);
    assert.equal(fixture.disk.state.accessToken, undefined);
    assert.equal(
      (fixture.disk.state.credentials as BetaCredentials).signedOut,
      true,
    );
    await assert.rejects(fixture.manager.useExistingCLI(), /remote revocation/);
  } finally {
    fixture.manager.close();
  }
});

test("server revocation clears proof and fails closed instead of using CLI auth", async () => {
  const fixture = managerFixture();
  try {
    await fixture.manager.connect();
    fixture.authorization.refresh = async () => {
      throw new BetaRequestError(401);
    };
    fixture.advance(14 * 60000);
    await assert.rejects(fixture.manager.environment(), /expired|revoked/);
    assert.equal(fixture.disk.state.accessToken, undefined);
    assert.equal(fixture.manager.snapshot().state, "expired");
    assert.throws(
      () => fixture.manager.assertMayStart(),
      /Connect MemCode beta again/,
    );
  } finally {
    fixture.manager.close();
  }
});

test("an account switch waits for rotation and revokes the latest refresh; cancellation cannot persist a late approval", async () => {
  const fixture = managerFixture();
  try {
    await fixture.manager.connect();
    fixture.advance(14 * 60000);
    let complete!: (value: BetaTokens) => void;
    fixture.authorization.refresh = async () =>
      new Promise((resolve) => (complete = resolve));
    const renewing = fixture.manager.environment();
    await delay();
    const signingOut = fixture.manager.signOut();
    await delay();
    assert.equal(fixture.revokes.length, 0);
    const fresh = tokens(fixture.lastBinding!, fixture.now);
    complete(fresh);
    await assert.rejects(renewing, /access changed/);
    await signingOut;
    assert.ok(fixture.revokes.includes(fresh.refresh_token));
    let approve!: (value: BetaTokens) => void, bound!: BetaBinding;
    fixture.authorization.authorize = async (value) => {
      bound = value;
      return new Promise((resolve) => (approve = resolve));
    };
    const pending = fixture.manager.connect();
    await delay();
    const cancel = fixture.manager.cancel();
    approve(tokens(bound, fixture.now));
    await assert.rejects(pending, /cancelled/);
    await cancel;
    assert.equal(fixture.disk.state.signedOut, true);
    assert.equal(fixture.disk.state.accessToken, undefined);
  } finally {
    fixture.manager.close();
  }
});

test("workers and ordinary tools never inherit beta engine proof locations or bindings", () => {
  const keys = [
    "MEMCODE_ENGINE_ACCESS_FILE",
    "MEMCODE_ENGINE_DEVICE_ID",
    "MEMCODE_ENGINE_SESSION_ID",
    "MEMCORTEX_STORE_DIR",
    "MEMTRACE_ENGINEER",
    "MEMTRACE_CORTEX",
  ];
  const old = keys.map((key) => process.env[key]);
  process.env.MEMCODE_ENGINE_ACCESS_FILE = "private-proof-file";
  process.env.MEMCODE_ENGINE_DEVICE_ID = "private-device";
  process.env.MEMCODE_ENGINE_SESSION_ID = "private-session";
  process.env.MEMCORTEX_STORE_DIR = "private-cortex-store";
  process.env.MEMTRACE_ENGINEER = "private-engine-account";
  process.env.MEMTRACE_CORTEX = "off";
  try {
    const env = childEnv();
    assert.equal(env.MEMCODE_ENGINE_ACCESS_FILE, undefined);
    assert.equal(env.MEMCODE_ENGINE_DEVICE_ID, undefined);
    assert.equal(env.MEMCODE_ENGINE_SESSION_ID, undefined);
    assert.equal(env.MEMCORTEX_STORE_DIR, undefined);
    assert.equal(env.MEMTRACE_ENGINEER, undefined);
    assert.equal(env.MEMTRACE_CORTEX, "off");
    const legacy = childEnv({ engine: true });
    assert.equal(legacy.MEMCORTEX_STORE_DIR, "private-cortex-store");
    assert.equal(legacy.MEMTRACE_ENGINEER, "private-engine-account");
    assert.equal(legacy.MEMCODE_ENGINE_ACCESS_FILE, undefined);
  } finally {
    keys.forEach((key, index) => {
      if (old[index] === undefined) delete process.env[key];
      else process.env[key] = old[index];
    });
  }
});

test("beta Cortex namespace is profile/account bound, stable across refresh, and Fleet identity follows only the verified account", async () => {
  const f = managerFixture();
  let otherProfile: MemCodeBeta | undefined;
  try {
    await f.manager.connect();
    const first = await f.manager.environment();
    assert.equal(first.MEMTRACE_ENGINEER, account.id);
    assert.equal(
      first.MEMTRACE_CORTEX,
      undefined,
      "Beta does not force Cortex on",
    );
    f.advance(14 * 60000);
    const renewed = await f.manager.environment();
    assert.equal(renewed.MEMCORTEX_STORE_DIR, first.MEMCORTEX_STORE_DIR);
    const disk = storageFixture({
      accessFile: join(tmpdir(), "other-memcode-profile", "access.jwt"),
    });
    otherProfile = new MemCodeBeta({ ...f.options, storage: disk.storage });
    await otherProfile.connect();
    const other = await otherProfile.environment();
    assert.notEqual(other.MEMCORTEX_STORE_DIR, first.MEMCORTEX_STORE_DIR);
    const nextAccount = { id: "verified-second-user", name: "Second member" };
    f.authorization.authorize = async (bound) => ({
      ...tokens(bound, f.now),
      account: nextAccount,
      access_token: issue(bound, f.now, {
        sub: nextAccount.id,
        name: nextAccount.name,
      }),
    });
    const changes = f.changes;
    await f.manager.connect();
    const switched = await f.manager.environment();
    assert.equal(
      f.changes,
      changes + 1,
      "Switch closes/rebinds owned engine contexts before new proof publication",
    );
    assert.equal(switched.MEMTRACE_ENGINEER, nextAccount.id);
    assert.notEqual(switched.MEMCORTEX_STORE_DIR, first.MEMCORTEX_STORE_DIR);
    assert.equal(
      dirname(switched.MEMCORTEX_STORE_DIR),
      dirname(first.MEMCORTEX_STORE_DIR),
    );
    await f.manager.signOut();
    await assert.rejects(f.manager.environment(), /paid CLI/);
  } finally {
    otherProfile?.close();
    f.manager.close();
  }
});

test("logout while managed engine prepares cannot release the previous identity's environment", async () => {
  const f = managerFixture();
  let finish!: () => void;
  try {
    await f.manager.connect();
    Object.assign(f.options, {
      beforeEngineUse: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const environment = f.manager.environment();
    await delay();
    assert.ok(finish);
    await f.manager.signOut();
    finish();
    await assert.rejects(environment, /access changed/);
    assert.equal(f.disk.state.accessToken, undefined);
  } finally {
    finish?.();
    f.manager.close();
  }
});

test("a failed secure-store inspection cannot silently choose separately billed CLI access", async () => {
  const f = managerFixture();
  f.disk.storage.read = async () => {
    throw Error("locked OS storage");
  };
  try {
    const status = await f.manager.status();
    assert.equal(status.accessMode, "beta");
    assert.equal(status.state, "unavailable");
    assert.throws(() => f.manager.assertMayStart(), /Secure beta storage/);
    await assert.rejects(f.manager.environment(), /Secure beta storage/);
  } finally {
    f.manager.close();
  }
});

test("a rotated refresh is never published to the engine when OS credential persistence fails", async () => {
  const f = managerFixture();
  try {
    await f.manager.connect();
    const initial = f.disk.state.accessToken;
    f.advance(901000);
    f.disk.storage.write = async () => {
      throw Error("OS credential store locked");
    };
    await assert.rejects(f.manager.environment(), /credential store locked/);
    assert.notEqual(f.disk.state.accessToken, initial);
    assert.equal(f.disk.state.accessToken, undefined);
    assert.equal(f.manager.snapshot().accessMode, "beta");
  } finally {
    f.manager.close();
  }
});

test("the session shown to memtrace.io's other endpoints waits for a rotation in flight", async () => {
  const f = managerFixture();
  let releaseRefresh!: (value: BetaTokens) => void;
  try {
    assert.equal(await f.manager.sessionProof(), null);
    await f.manager.connect();
    const connected = f.disk.state.credentials as BetaCredentials;
    assert.deepEqual(await f.manager.sessionProof(), {
      refreshToken: connected.refreshToken,
      deviceId: connected.deviceId,
      sessionId: connected.sessionId,
      accountId: account.id,
    });
    f.advance(14 * 60000);
    f.authorization.refresh = async () =>
      new Promise((resolve) => (releaseRefresh = resolve));
    const refreshing = f.manager.refresh();
    await delay();
    let shown = false;
    const proof = f.manager.sessionProof().then((value) => {
      shown = true;
      return value;
    });
    await wait(40);
    assert.equal(shown, false, "the spent refresh token must not be shown");
    const rotated = tokens(f.lastBinding!, f.now);
    releaseRefresh(rotated);
    await refreshing;
    assert.equal((await proof)!.refreshToken, rotated.refresh_token);
    assert.notEqual(rotated.refresh_token, connected.refreshToken);
  } finally {
    await f.manager.close();
  }
});

test("there is no session to show after sign-out, after revocation or once the refresh has expired", async () => {
  const signedOut = managerFixture();
  try {
    await signedOut.manager.connect();
    await signedOut.manager.signOut();
    assert.equal(await signedOut.manager.sessionProof(), null);
  } finally {
    await signedOut.manager.close();
  }
  const revoked = managerFixture();
  try {
    await revoked.manager.connect();
    revoked.advance(14 * 60000);
    revoked.authorization.refresh = async () => {
      throw new BetaRequestError(401);
    };
    await revoked.manager.refresh();
    assert.equal(await revoked.manager.sessionProof(), null);
  } finally {
    await revoked.manager.close();
  }
  const expired = managerFixture();
  try {
    await expired.manager.connect();
    assert.ok(await expired.manager.sessionProof());
    expired.advance(31 * 86400000);
    assert.equal(await expired.manager.sessionProof(), null);
  } finally {
    await expired.manager.close();
  }
});
