import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { MemtraceAccountManager, memtraceManagedAuth } from "../runtime/account";
import { registerConnections } from "../runtime/worker-connections";
import { initialState } from "../src/seed";
import { within } from "../runtime/local";

const cleanEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, MEMTRACE_LICENSE_KEY: undefined, MEMTRACE_DEV: undefined, MEMTRACE_OFFLINE: undefined });
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    if (Date.now() > deadline) throw Error("Fixture account operation did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
async function fixture(options: { delayedStatus?: boolean; failedLogout?: boolean; alreadySignedIn?: boolean; unsigned?: boolean; noOwner?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memcode-account-session-"));
  const script = join(root, "memtrace.mjs"), audit = join(root, "calls.jsonl"), loginGate = join(root, "finish-login"), statusGate = join(root, "finish-status"), stateFile = join(root, "private", "account-session.json");
  await writeFile(script, `
import {appendFile,access} from 'node:fs/promises';
const args=process.argv.slice(2);
await appendFile(${JSON.stringify(audit)},JSON.stringify(args)+'\\n');
async function gate(path){for(let i=0;i<3000;i++){try{await access(path);return;}catch{}await new Promise(r=>setTimeout(r,20));}process.exit(9);}
if(args.join(' ')==='status --json'){
 ${options.delayedStatus ? `await gate(${JSON.stringify(statusGate)});` : ""}
 console.log(JSON.stringify({auth_session:{state:${JSON.stringify(options.unsigned ? "Missing" : "Valid")},degraded:${!!options.unsigned}},memdb:{owner_reachable:${!options.noOwner},seat_principal:'old-cached-owner'},session_token:'DO-NOT-EXPOSE'}));
}else if(args.join(' ')==='auth logout'){
 ${options.failedLogout ? "process.exit(7);" : "console.error('Credentials removed. Run memtrace auth login to re-authenticate.');"}
}else if(args.join(' ')==='auth login'){
 ${options.alreadySignedIn ? "console.error('Already signed in (enterprise).');process.exit(0);" : ""}
 console.error('Claim URL: https://www.memtrace.io/claim?code=fixture-new-account');
 await gate(${JSON.stringify(loginGate)});console.error("You're in.");
}else process.exit(8);
`);
  const managers: MemtraceAccountManager[] = [], opened: string[] = [];
  const manager = (environment: () => NodeJS.ProcessEnv = cleanEnvironment) => {
    const value = new MemtraceAccountManager(() => script, { call: async (method) => { opened.push(method); return null as never; } }, { stateFile, environment });
    managers.push(value); return value;
  };
  return { root, script, stateFile, managers, manager, opened,
    calls: async () => (await readFile(audit, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
    finishLogin: () => writeFile(loginGate, "done"),
    finishStatus: () => writeFile(statusGate, "done"),
    close: async () => { await Promise.all(managers.map((value) => value.close())); assert.ok(within(tmpdir(), root) && basename(root).startsWith("memcode-account-session-")); await rm(root, { recursive: true, force: true }); },
  };
}

test("a fresh unsigned account stops before engine or epic preparation", async () => {
  const f = await fixture({ unsigned: true });
  try {
    const manager = f.manager();
    await manager.refresh();
    assert.throws(() => manager.assertMayStart(), /Connect your Memtrace account in Settings/);
    assert.equal((await f.calls()).some((args) => args[0] !== "status"), false);
  } finally { await f.close(); }
});

test("a valid existing CLI session can start before its graph owner is opened", async () => {
  const f = await fixture({ noOwner: true });
  try {
    const manager = f.manager();
    await manager.refresh();
    assert.equal(manager.current.status, "unknown");
    assert.doesNotThrow(() => manager.assertMayStart());
  } finally { await f.close(); }
});

test("explicit logout persists a non-secret signed-out policy and ignores a cached owner's Valid state after restart", async () => {
  const f = await fixture();
  try {
    const manager = f.manager();
    assert.equal((await manager.refresh()).status, "connected");
    const signingOut = manager.signOut();
    assert.throws(() => manager.assertMayStart(), /account action/);
    const account = await signingOut;
    assert.equal(account.status, "needs-sign-in"); assert.equal(account.signedOut, true);
    assert.equal(account.principal, undefined); assert.equal(account.claimUrl, undefined);
    assert.throws(() => manager.assertMayStart(), /Sign in/);
    assert.deepEqual(JSON.parse(await readFile(f.stateFile, "utf8")), { version: 1, signedOut: true });
    await manager.close();
    const restarted = f.manager();
    const restored = await restarted.refresh();
    assert.equal(restored.signedOut, true); assert.equal(restored.status, "needs-sign-in");
    assert.equal((await f.calls()).filter((args) => args[0] === "status").length, 1, "No stale owner status is read while explicitly signed out");
  } finally { await f.close(); }
});

test("switch logs out before opening a new official login, preserves the start barrier, and requires a controlled reconnect", async () => {
  const f = await fixture();
  try {
    const manager = f.manager(); await manager.refresh();
    const pending = await manager.switchAccount();
    assert.equal(pending.loginPending, true); assert.equal(pending.signedOut, true);
    await until(() => !!manager.current.claimUrl);
    assert.equal((await manager.refresh()).loginPending, true);
    assert.throws(() => manager.assertMayStart(), /account action/);
    assert.deepEqual((await f.calls()).map((args) => args.join(" ")), ["status --json", "auth logout", "auth login"]);
    assert.deepEqual(f.opened, ["open_memtrace_claim"]);
    await f.finishLogin();
    await until(() => !manager.current.loginPending && manager.current.signedOut === false);
    const result = await manager.refresh();
    assert.equal(result.status, "connected"); assert.equal(result.reconnectRequired, true);
    assert.equal(result.principal, undefined, "A pre-switch owner's cached principal must not be shown as the new account");
    assert.doesNotMatch(JSON.stringify(result), /DO-NOT-EXPOSE/);
    assert.throws(() => manager.assertMayStart(), /Restart MemCode/);
  } finally { await f.close(); }
});

test("cancelling an in-flight login terminates only its fixture process and never reports it as a completed account switch", async () => {
  const f = await fixture();
  try {
    const manager = f.manager(); await manager.refresh();
    await manager.switchAccount(); await until(() => !!manager.current.claimUrl);
    const cancelled = await manager.cancelSignIn();
    assert.equal(cancelled.loginPending, false); assert.equal(cancelled.claimUrl, undefined); assert.equal(cancelled.signedOut, true);
    await f.finishLogin(); await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(manager.current.signedOut, true);
    assert.equal((await f.calls()).filter((args) => args.join(" ") === "auth logout").length, 1);
    assert.throws(() => manager.assertMayStart(), /Sign in/);
  } finally { await f.close(); }
});

test("a stale status read cannot repaint the account as connected after explicit logout", async () => {
  const f = await fixture({ delayedStatus: true });
  try {
    const manager = f.manager(), stale = manager.refresh();
    await until(async () => (await f.calls()).some((args) => args[0] === "status"));
    await manager.signOut(); await f.finishStatus(); await stale;
    assert.equal(manager.current.signedOut, true); assert.equal(manager.current.status, "needs-sign-in");
    assert.equal((await manager.refresh()).status, "needs-sign-in");
  } finally { await f.close(); }
});

test("a failed CLI logout never claims the user's session has been removed", async () => {
  const f = await fixture({ failedLogout: true });
  try {
    const manager = f.manager(); await manager.refresh();
    await assert.rejects(manager.signOut(), /could not sign out/);
    assert.equal(manager.current.signedOut, false); assert.equal(manager.current.status, "connected");
    assert.doesNotThrow(() => manager.assertMayStart());
  } finally { await f.close(); }
});

test("environment-managed authentication exposes override names without pretending a logout can change their values", async () => {
  const f = await fixture();
  try {
    const manager = f.manager(() => ({ ...cleanEnvironment(), MEMTRACE_LICENSE_KEY: "PRIVATE-ENVIRONMENT-KEY" }));
    const result = await manager.refresh();
    assert.equal(result.authMode, "environment"); assert.deepEqual(result.managedBy, ["MEMTRACE_LICENSE_KEY"]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-ENVIRONMENT-KEY/);
    await assert.rejects(manager.signOut(), /environment variables/);
    await assert.rejects(manager.switchAccount(), /environment variables/);
    assert.equal((await f.calls()).some((args) => args[0] === "auth"), false);
    assert.deepEqual(memtraceManagedAuth({ MEMTRACE_DEV: "1", MEMTRACE_OFFLINE: "1", MEMTRACE_LICENSE_KEY: " " }), ["MEMTRACE_DEV", "MEMTRACE_OFFLINE"]);
  } finally { await f.close(); }
});

test("runtime account routes reject changes during active work and leave provider approvals and Team memberships intact", async () => {
  const f = await fixture(), state = initialState();
  state.settings.memtracePath = f.script;
  state.tasks[0].example = false;
  state.workerConnections = { codex: { harness: "codex", runtimePath: "fixture-codex", approvedAt: "2026-11-15", auth: "authenticated", scopeVersion: 1 } };
  const before = structuredClone({ workerConnections: state.workerConnections, team: state.team });
  const routes = new Map<string, (input?: unknown) => unknown>();
  const registry = registerConnections((name, schema, handler) => routes.set(name, (input) => handler(schema.parse(input))), () => state, async () => {}, () => f.script, { call: async () => null as never }, undefined, { stateFile: f.stateFile, environment: cleanEnvironment });
  try {
    await routes.get("account:status")!();
    state.tasks[0].run.state = "running";
    for (const action of ["account:sign-out", "account:switch", "account:sign-in"]) await assert.rejects(Promise.resolve().then(() => routes.get(action)!()), /Stop active workers/);
    assert.equal((await f.calls()).some((args) => args[0] === "auth"), false);
    state.tasks[0].run.state = "finished";
    await routes.get("account:sign-out")!();
    assert.deepEqual({ workerConnections: state.workerConnections, team: state.team }, before);
  } finally { await registry.close(); await f.close(); }
});

test("unreadable account policy fails closed without replacing the saved file", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "private")); await writeFile(f.stateFile, "invalid policy");
    const manager = f.manager();
    await assert.rejects(manager.refresh(), /saved file has been preserved/);
    assert.throws(() => manager.assertMayStart(), /account state/);
    assert.equal(await readFile(f.stateFile, "utf8"), "invalid policy");
    assert.equal((await f.calls()).length, 0);
  } finally { await f.close(); }
});

test("a local policy write failure prevents the global logout command from running", async () => {
  const f = await fixture();
  try {
    const manager = f.manager(); await manager.refresh();
    await mkdir(f.stateFile + ".next", { recursive: true });
    await assert.rejects(manager.signOut(), /session was not changed/);
    assert.equal((await f.calls()).some((args) => args[0] === "auth"), false);
    assert.equal(manager.current.signedOut, false); assert.equal(manager.current.status, "connected");
  } finally { await f.close(); }
});

test("a switch that never opens a new claim cannot silently adopt an offline or restored old session", async () => {
  const f = await fixture({ alreadySignedIn: true });
  try {
    const manager = f.manager(); await manager.refresh();
    await manager.switchAccount();
    await until(() => !manager.current.loginPending);
    const result = await manager.refresh();
    assert.equal(result.signedOut, true); assert.equal(result.status, "needs-sign-in");
    assert.match(result.detail, /did not open a fresh account/);
    assert.equal(f.opened.length, 0); assert.throws(() => manager.assertMayStart(), /Sign in/);
  } finally { await f.close(); }
});
