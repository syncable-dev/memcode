import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { childEnv, findCommand } from "./commands";
import { replaceWorkspace } from "./persistence";
import type { NativeHost } from "./host";
import type { MemtraceAccount } from "../src/connections";

const execute = promisify(execFile);
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const safeId = (value: unknown) =>
  typeof value === "string" && /^[\w.@:/-]{1,200}$/.test(value)
    ? value
    : undefined;
export function parseMemtraceStatus(data: unknown): MemtraceAccount {
  const status = data as {
    auth_session?: { state?: unknown; degraded?: unknown };
    memdb?: {
      mode?: unknown;
      owner_reachable?: unknown;
      seat_principal?: unknown;
      user_org_id?: unknown;
    };
  };
  const valid =
    status?.auth_session?.state === "Valid" &&
    status.auth_session.degraded === false;
  const hasSessionContext =
    status.memdb?.owner_reachable === true ||
    (status.memdb?.mode === "external" &&
      !!safeId(status.memdb?.seat_principal));
  const active = valid && hasSessionContext;
  const principal = active ? safeId(status.memdb?.seat_principal) : undefined;
  return {
    status: active
      ? "connected"
      : status?.auth_session?.degraded === true
        ? "needs-sign-in"
        : "unknown",
    label: active
      ? "Memtrace connected"
      : valid
        ? "Memtrace installed"
        : "Memtrace sign-in",
    detail: principal
      ? "Using the existing Memtrace seat session. No separate MemCode account is created."
      : active
        ? "Using the existing Memtrace session. This CLI does not expose an account profile; a valid license/session is not a verified person identity."
        : valid
          ? "Memtrace is installed, but this standalone status has no active owner or account identity. Open a project to connect the engine, or sign in through Memtrace."
          : "Sign in through Memtrace to use its existing session. MemCode never creates a separate account.",
    principal: principal
      ? { id: principal, name: "Memtrace member", source: "memtrace" }
      : undefined,
    organizationId: active ? safeId(status.memdb?.user_org_id) : undefined,
    checkedAt: new Date().toISOString(),
    loginPending: false,
  };
}
export function memtraceClaimUrl(value: string): string | undefined {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      !["memtrace.io", "www.memtrace.io"].includes(u.hostname) ||
      u.pathname !== "/claim" ||
      u.username ||
      u.password ||
      u.port ||
      u.hash ||
      [...u.searchParams.keys()].some((k) => k !== "code") ||
      !/^[-\w]{6,250}$/.test(u.searchParams.get("code") ?? "")
    )
      return;
    return u.href;
  } catch {
    return;
  }
}
export interface MemtraceAccountOptions {
  /** Non-secret local policy only. Never the Memtrace credentials file. */
  stateFile?: string;
  beforeChange?: () => void | Promise<void>;
  environment?: () => NodeJS.ProcessEnv;
}
export function memtraceManagedAuth(environment: NodeJS.ProcessEnv): string[] {
  return [
    ...(environment.MEMTRACE_LICENSE_KEY?.trim() ? ["MEMTRACE_LICENSE_KEY"] : []),
    ...(environment.MEMTRACE_DEV === "1" ? ["MEMTRACE_DEV"] : []),
    ...(environment.MEMTRACE_OFFLINE === "1" ? ["MEMTRACE_OFFLINE"] : []),
  ];
}
export class MemtraceAccountManager {
  current: MemtraceAccount = {
    status: "unknown",
    label: "Memtrace account",
    detail: "Use your existing Memtrace session.",
    loginPending: false,
  };
  private login?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<MemtraceAccount>;
  private closing = false;
  private confirmedByLoginAt?: string;
  private statusAbort?: AbortController;
  private generation = 0;
  private changing = false;
  private signedOut = false;
  private reconnectRequired = false;
  private policyReady = false;
  private sessionVerified = false;
  private policyFailure = false;
  private readonly ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly configuredPath: () => string,
    private readonly host: NativeHost,
    private readonly options: MemtraceAccountOptions = {},
  ) {
    this.ready = this.loadPolicy().then(() => { this.policyReady = true; });
    void this.ready.catch(() => { this.policyFailure = true; });
  }
  private environment() { return this.options.environment?.() ?? childEnv(); }
  private decorated(value: MemtraceAccount): MemtraceAccount {
    const managedBy = memtraceManagedAuth(this.environment());
    return {
      ...value,
      authMode: managedBy.length ? "environment" : "session",
      managedBy,
      signedOut: this.signedOut,
      reconnectRequired: this.reconnectRequired,
      // A cached workspace owner is not proof of the newly chosen person.
      ...(this.signedOut || this.reconnectRequired ? { principal: undefined, organizationId: undefined } : {}),
    };
  }
  private async loadPolicy() {
    if (!this.options.stateFile) return;
    try {
      const saved = JSON.parse(await readFile(this.options.stateFile, "utf8"));
      if (saved.version !== 1 || typeof saved.signedOut !== "boolean") throw Error("Invalid account policy");
      this.signedOut = saved.signedOut;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("MemCode could not read its local account state. The saved file has been preserved.");
    }
  }
  private persistPolicy() {
    if (!this.options.stateFile) return Promise.resolve();
    const path = this.options.stateFile, body = JSON.stringify({ version: 1, signedOut: this.signedOut });
    const pending = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path + ".next", body, { encoding: "utf8", mode: 0o600 });
      await replaceWorkspace(path + ".next", path);
    });
    this.writes = pending;
    return pending;
  }
  /** Synchronous: a queued worker cannot slip between a click and CLI mutation. */
  assertMayStart() {
    if (!this.policyReady || this.policyFailure) throw Error("Memtrace account state is still being checked. Refresh the account before starting a worker.");
    if (this.changing || this.login) throw Error("Wait for the Memtrace account action before starting a worker.");
    if (this.signedOut) throw Error("Sign in with Memtrace before starting a worker.");
    if (this.reconnectRequired) throw Error("Restart MemCode after changing the Memtrace session before starting workers. Restart any separately running Memtrace workspace too.");
    if (!this.sessionVerified && !memtraceManagedAuth(this.environment()).length)
      throw Error("Connect your Memtrace account in Settings before starting a worker. Choose Connect Memtrace beta, or explicitly connect your existing CLI setup.");
  }
  private invalidate() {
    this.generation++;
    this.statusAbort?.abort();
    this.refreshing = undefined;
    return this.generation;
  }
  private begin(action: NonNullable<MemtraceAccount["sessionAction"]>) {
    if (this.closing) throw Error("The MemCode workspace is closing.");
    if (this.changing || this.login) throw Error("Finish or cancel the pending Memtrace sign-in first.");
    this.changing = true;
    const generation = this.invalidate();
    this.current = this.decorated({ ...this.current, sessionAction: action, claimUrl: undefined });
    return generation;
  }
  private requireMutableAuth() {
    if (memtraceManagedAuth(this.environment()).length) throw Error("Memtrace authentication is managed by environment variables. Remove the displayed override and restart MemCode before switching accounts; no environment credential was changed.");
  }
  private signedOutStatus(detail = "Signed out of this computer’s shared Memtrace CLI session. Projects and provider sign-ins stay saved. Verified Team memberships are locked until you confirm your Memtrace account in the browser; invitation-preview memberships are unchanged.") {
    return this.decorated({ status: "needs-sign-in", label: "Memtrace signed out", detail, loginPending: false, checkedAt: new Date().toISOString() });
  }
  refresh(): Promise<MemtraceAccount> {
    if (this.closing) return Promise.resolve(this.current);
    if (this.refreshing) return this.refreshing;
    const pending = this.read().finally(() => { if (this.refreshing === pending) this.refreshing = undefined; });
    this.refreshing = pending;
    return pending;
  }
  private async read() {
    await this.ready;
    if (this.changing || this.login) return this.current;
    if (this.signedOut) return (this.current = this.current.signedOut ? this.decorated(this.current) : this.signedOutStatus());
    const generation = this.generation;
    const command = await findCommand("memtrace", this.configuredPath());
    if (this.closing || generation !== this.generation) return this.current;
    if (!command) {
      this.sessionVerified = false;
      return (this.current = this.decorated({
        status: "unavailable",
        label: "Memtrace not found",
        detail: "Install Memtrace or choose its executable in Settings.",
        loginPending: !!this.login,
      }));
    }
    try {
      this.statusAbort = new AbortController();
      const { stdout } = await execute(
        command.command,
        [...command.prefix, "status", "--json"],
        {
          env: { ...this.environment(), ...command.env },
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 1_000_000,
          encoding: "utf8",
          signal: this.statusAbort.signal,
        },
      );
      const start = stdout.indexOf("{");
      const raw = JSON.parse(stdout.slice(start));
      if (this.closing || generation !== this.generation) return this.current;
      const result = parseMemtraceStatus(raw);
      this.sessionVerified = raw.auth_session?.state === "Valid" && raw.auth_session?.degraded === false;
      if (
        this.confirmedByLoginAt &&
        result.status === "unknown" &&
        raw.auth_session?.state === "Valid" &&
        raw.auth_session?.degraded === false
      ) {
        result.status = "connected";
        result.label = "Memtrace connected";
        result.detail =
          "The official Memtrace login command confirmed this session. This CLI does not expose a person profile; no separate MemCode account is created.";
      }
      this.current = this.decorated({
        ...result,
        loginPending: !!this.login,
        claimUrl: this.current.claimUrl,
      });
    } catch {
      if (this.closing || generation !== this.generation) return this.current;
      this.sessionVerified = false;
      this.current = this.decorated({
        status: "unknown",
        label: "Memtrace status unavailable",
        detail:
          "The installed CLI could not report its session. Check Memtrace in Settings, then refresh.",
        checkedAt: new Date().toISOString(),
        loginPending: !!this.login,
        claimUrl: this.current.claimUrl,
      });
    }
    return this.current;
  }
  async signIn() {
    if (this.login) return this.current;
    const generation = this.begin("signing-in");
    try {
      await this.ready;
      await this.options.beforeChange?.();
      return await this.startLogin(generation);
    } finally { this.changing = false; if (!this.login) this.current = this.decorated({ ...this.current, sessionAction: undefined }); }
  }
  async signOut() {
    const generation = this.begin("signing-out");
    try {
      await this.ready;
      this.requireMutableAuth();
      await this.options.beforeChange?.();
      await this.logout(generation);
      return this.current;
    } finally { this.changing = false; this.current = this.decorated({ ...this.current, sessionAction: undefined }); }
  }
  async switchAccount() {
    const generation = this.begin("switching");
    try {
      await this.ready;
      this.requireMutableAuth();
      await this.options.beforeChange?.();
      await this.logout(generation);
      return await this.startLogin(generation, true);
    } finally { this.changing = false; if (!this.login) this.current = this.decorated({ ...this.current, sessionAction: undefined }); }
  }
  private async logout(generation: number) {
    const command = await findCommand("memtrace", this.configuredPath());
    if (!command)
      throw Error("Install Memtrace or choose its executable in Settings.");
    // Persist the adoption barrier before the CLI can remove credentials. A
    // crash or full disk cannot make an old owner's cached Valid state win.
    const previouslySignedOut = this.signedOut;
    this.signedOut = true;
    try { await this.persistPolicy(); }
    catch { this.signedOut = previouslySignedOut; throw Error("MemCode could not save its account-change state. The Memtrace session was not changed."); }
    try {
      await execute(command.command, [...command.prefix, "auth", "logout"], {
        env: { ...this.environment(), ...command.env }, windowsHide: true,
        timeout: 15000, maxBuffer: 64000, encoding: "utf8",
      });
    } catch {
      this.signedOut = previouslySignedOut;
      try { await this.persistPolicy(); } catch {
        this.signedOut = true;
        this.current = this.signedOutStatus("The account change could not be confirmed. Check the Memtrace CLI session and sign in again before starting workers.");
      }
      throw Error("The Memtrace CLI could not sign out. Its session has not been reported as changed; check the CLI and retry.");
    }
    if (this.closing || generation !== this.generation) throw Error("The Memtrace account action was interrupted.");
    this.signedOut = true;
    this.reconnectRequired = true;
    this.confirmedByLoginAt = undefined;
    this.current = this.signedOutStatus();
  }
  private async startLogin(generation: number, requireBrowser = false) {
    const command = await findCommand("memtrace", this.configuredPath());
    if (!command) throw Error("Install Memtrace or choose its executable in Settings.");
    if (this.closing || generation !== this.generation) throw Error("The Memtrace account action was interrupted.");
    const child = spawn(command.command, [...command.prefix, "auth", "login"], {
      env: { ...this.environment(), ...command.env },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.login = child;
    this.current = this.decorated({ ...this.current, loginPending: true, sessionAction: "signing-in", claimUrl: undefined });
    let output = "",
      opened = false;
    const consume = (chunk: Buffer) => {
      if (this.login !== child || generation !== this.generation || this.closing) return;
      output = (output + plain(chunk.toString())).slice(-8000);
      const url = memtraceClaimUrl(
        output.match(/Claim URL:\s*(https:\/\/[^\s]+)/)?.[1] ?? "",
      );
      if (url && !opened) {
        opened = true;
        this.current = this.decorated({ ...this.current, claimUrl: url });
        void this.host.call("open_memtrace_claim", { url }).catch(() => {
          if (this.login !== child || generation !== this.generation || this.closing) return;
          this.current = {
            ...this.current,
            detail:
              "Open the Memtrace claim link to finish sign-in, then refresh.",
          };
        });
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    const finish = async (succeeded = false) => {
      if (this.login !== child || generation !== this.generation) return;
      if (succeeded && requireBrowser && !opened) succeeded = false;
      if (succeeded) {
        this.confirmedByLoginAt = new Date().toISOString();
        this.signedOut = false;
        this.reconnectRequired = true;
      }
      this.login = undefined;
      clearTimeout(this.timer);
      this.current = this.decorated({
        ...this.current,
        loginPending: false,
        claimUrl: undefined,
        sessionAction: undefined,
        ...(!succeeded && this.signedOut ? { status: "needs-sign-in", label: "Memtrace sign-in needed", detail: requireBrowser && !opened
          ? "Memtrace did not open a fresh account sign-in. A separately running workspace or stored offline license may still supply a session. Restart that workspace and check its authentication before switching again."
          : "Sign-in did not complete. Sign in again when ready." } : {}),
      });
      try { await this.persistPolicy(); } catch { this.current = this.decorated({ ...this.current, detail: "Memtrace finished sign-in, but MemCode could not save its local account state. Restart and check the account before starting workers." }); }
      if (!this.closing) void this.refresh();
    };
    child.once("error", () => { void finish(false); });
    child.once("close", (code) => { void finish(code === 0); });
    this.timer = setTimeout(
      () => {
        void this.stopLogin(child).finally(() => { void finish(false); });
      },
      10 * 60 * 1000,
    );
    return this.current;
  }
  async cancelSignIn() {
    if (this.changing) throw Error("Wait for the current Memtrace account action.");
    const child = this.login;
    if (!child) return this.current;
    this.changing = true;
    this.invalidate();
    this.login = undefined;
    clearTimeout(this.timer);
    try {
      await this.stopLogin(child);
      this.current = this.signedOut ? this.signedOutStatus("Sign-in cancelled. Sign in again when ready.") : this.decorated({ ...this.current, loginPending: false, sessionAction: undefined, claimUrl: undefined, detail: "Sign-in cancelled. No new session was adopted by MemCode." });
      return this.current;
    } finally { this.changing = false; }
  }
  async close() {
    this.closing = true;
    this.invalidate();
    this.statusAbort?.abort();
    if (this.login) await this.stopLogin(this.login);
    this.login = undefined;
    clearTimeout(this.timer);
    await this.writes.catch(() => {});
  }
  private async stopLogin(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === "win32") {
      await execute(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000, maxBuffer: 16000 },
      ).catch(() => {
        child.kill();
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
    }
  }
}
