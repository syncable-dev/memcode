import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { MemCodeBetaStatus } from "../src/beta";
import { verifyTelemetryAuthorization } from "./telemetry-auth";
import type { TelemetryAuthorization } from "./telemetry";
import type { NativeHost } from "./host";
import {
  BETA_TERMS,
  BetaRequestError,
  createBetaAuthorization,
  verifyBetaAccess,
  type BetaAccount,
  type BetaBinding,
  type BetaPublicKey,
  type BetaTokens,
} from "./beta-auth";

export interface BetaCredentials extends BetaBinding {
  version: 1;
  refreshToken: string;
  refreshExpiresAt: string;
  account: BetaAccount;
  termsVersion: string;
  publicKey: BetaPublicKey;
  accessExpiresAt: string;
  signedOut?: boolean;
  reauthRequired?: boolean;
}
export interface BetaStoredState {
  configured: boolean;
  signedOut?: boolean;
  credentials: unknown;
  accessToken?: string;
  accessFile?: string;
  storageError?: string;
}
export interface BetaStorage {
  read(): Promise<BetaStoredState>;
  write(credentials: BetaCredentials): Promise<void>;
  writeAccess(accessToken: string): Promise<string>;
  clearAccess(): Promise<void>;
  markSignedOut(): Promise<void>;
  clear(): Promise<void>;
  forgetSession(): Promise<void>;
}
export function nativeBetaStorage(host: NativeHost): BetaStorage {
  return {
    read: () => host.call("beta_store_read"),
    write: (credentials) => host.call("beta_store_write", { credentials }),
    writeAccess: async (accessToken) =>
      (
        await host.call<{ accessFile: string }>("beta_access_write", {
          accessToken,
        })
      ).accessFile,
    clearAccess: () => host.call("beta_access_clear"),
    markSignedOut: () => host.call("beta_store_mark_signed_out"),
    clear: () => host.call("beta_store_clear"),
    forgetSession: () => host.call("beta_store_forget_session"),
  };
}
function credential(value: unknown): BetaCredentials {
  const item = value as Partial<BetaCredentials> | null;
  if (
    !item ||
    item.version !== 1 ||
    typeof item.deviceId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(item.deviceId) ||
    typeof item.sessionId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(item.sessionId) ||
    typeof item.refreshToken !== "string" ||
    !/^[A-Za-z0-9_-]{32,200}$/.test(item.refreshToken) ||
    !Number.isFinite(Date.parse(item.refreshExpiresAt ?? "")) ||
    item.termsVersion !== BETA_TERMS ||
    !item.account?.id ||
    !item.account.name ||
    !item.publicKey ||
    !Number.isFinite(Date.parse(item.accessExpiresAt ?? ""))
  )
    throw Error(
      "Stored beta access could not be read. Disconnect and connect again.",
    );
  return item as BetaCredentials;
}
export interface MemCodeBetaOptions {
  telemetryOptIn?: () => boolean;
  storage: BetaStorage;
  authorization: ReturnType<typeof createBetaAuthorization>;
  loadKeys?: () => Promise<{ keys: BetaPublicKey[] }>;
  now?: () => number;
  assertMayChange(): void;
  beforeIdentityChange(): Promise<void>;
  afterConnected?(): Promise<void>;
  beforeEngineUse?(): Promise<void>;
  changed?(status: MemCodeBetaStatus): void;
}

function waitForBetaStep<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  return Promise.race([work, stopped]).finally(() =>
    signal.removeEventListener("abort", stop),
  );
}

/** A separate browser grant; never imports, changes or forwards CLI/provider auth. */
export class MemCodeBeta {
  private record?: BetaCredentials;
  private token?: string;
  private telemetry?: TelemetryAuthorization;
  private accessFile?: string;
  private configured = false;
  private signedOut = false;
  private initializing?: Promise<void>;
  private ready = false;
  private storageFailure?: string;
  private note?: string;
  private changing = false;
  private refreshing?: Promise<void>;
  private connecting?: Promise<MemCodeBetaStatus>;
  private revoking?: Promise<void>;
  private connectionAbort?: AbortController;
  private connectionPhase?: MemCodeBetaStatus["connectionPhase"];
  private committing = false;
  private generation = 0;
  private closing = false;
  private closed?: Promise<void>;
  private retryAfter = 0;
  private timer: ReturnType<typeof setInterval>;
  private readonly clock: () => number;
  constructor(private readonly options: MemCodeBetaOptions) {
    this.clock = options.now ?? Date.now;
    this.timer = setInterval(() => {
      if (!this.changing && !this.closing) {
        if (this.record?.signedOut) void this.retryRevocation();
        else void this.refreshAccess(true).catch(() => {});
      }
    }, 600000);
    this.timer.unref();
  }
  private emit() {
    this.options.changed?.(this.snapshot());
  }
  async initialize() {
    return (this.initializing ??= (async () => {
      try {
        const stored = await this.options.storage.read();
        this.configured = stored.configured === true;
        this.signedOut = stored.signedOut === true;
        this.storageFailure = stored.storageError;
        if (stored.credentials) {
          this.record = credential(stored.credentials);
          this.record.signedOut ||= this.signedOut;
          this.configured = true;
          if (this.record.signedOut) this.signedOut = true;
          else if (
            stored.accessToken &&
            stored.accessFile &&
            !this.record.reauthRequired
          ) {
            try {
              const verified = await verifyBetaAccess(
                stored.accessToken,
                this.record,
                {
                  cachedKey: this.record.publicKey,
                  accountId: this.record.account.id,
                  now: this.clock,
                },
              );
              this.record.accessExpiresAt = verified.expiresAt;
              this.token = stored.accessToken;
              this.accessFile = stored.accessFile;
            } catch {
              this.token = undefined;
            }
          }
        }
      } catch {
        // If storage cannot be inspected, its persisted billing choice is
        // unknown. Require explicit recovery instead of assuming paid CLI mode.
        this.configured = true;
        this.storageFailure =
          "Secure beta storage could not be opened. Unlock the OS credential store or reconnect beta access.";
      } finally {
        this.ready = true;
        this.emit();
      }
      if (
        this.record &&
        !this.signedOut &&
        !this.record.reauthRequired &&
        !this.current()
      )
        void this.refreshAccess(false).catch(() => {});
      if (this.record?.signedOut) void this.retryRevocation();
    })());
  }
  private current() {
    return (
      !!this.token &&
      !!this.accessFile &&
      !!this.record &&
      Date.parse(this.record.accessExpiresAt) > this.clock()
    );
  }
  usesBeta() {
    return this.configured;
  }
  isChanging() {
    return this.changing;
  }
  reportEngineProgress(note: string) {
    this.note = note.slice(0, 300);
    this.emit();
  }
  assertMayStart() {
    if (this.changing)
      throw Error(
        "Finish or cancel the MemCode beta sign-in before starting a worker.",
      );
    if (this.usesBeta() && this.signedOut)
      throw Error(
        "Connect your MemCode beta account again before using the engine. It will not fall back to a paid CLI session.",
      );
    if (
      this.usesBeta() &&
      (!this.record || this.record.reauthRequired || this.storageFailure)
    )
      throw Error(
        this.storageFailure ??
          "Connect MemCode beta again before starting a worker.",
      );
  }
  snapshot(): MemCodeBetaStatus {
    const account = this.record?.account;
    const base = {
      loginPending: this.changing,
      accessMode: this.usesBeta()
        ? ("beta" as const)
        : ("installed-cli" as const),
      ...(account
        ? {
            account: {
              id: account.id,
              name: account.name,
              ...(account.email ? { email: account.email } : {}),
            },
          }
        : {}),
    };
    if (this.changing) {
      const connectionPhase = this.connectionPhase ?? "finishing";
      return {
        ...base,
        state: "connecting",
        connectionPhase,
        canCancel: !!this.connectionAbort && !this.committing,
        detail:
          connectionPhase === "browser"
            ? "Approve noncommercial beta access in your Memtrace browser session."
            : connectionPhase === "starting"
              ? "Getting your beta sign-in ready."
              : (this.note ?? "Finishing your beta connection."),
      };
    }
    if (this.signedOut || this.record?.signedOut)
      return {
        ...base,
        state: "disconnected",
        detail: this.record
          ? "Signed out on this device. Remote revocation will retry when the service is reachable."
          : "Connect your Memtrace account for noncommercial beta access.",
        ...(this.record ? { revocationPending: true } : {}),
      };
    if (this.storageFailure)
      return { ...base, state: "unavailable", detail: this.storageFailure };
    if (this.current() && this.record && !this.record.reauthRequired)
      return {
        ...base,
        state: "connected",
        detail:
          this.note ??
          "Unlimited local Memtrace engine usage for the noncommercial beta. Model accounts and credits remain separate.",
        accessExpiresAt: this.record.accessExpiresAt,
        refreshExpiresAt: this.record.refreshExpiresAt,
        termsVersion: this.record.termsVersion,
      };
    if (this.configured)
      return {
        ...base,
        state: "expired",
        detail:
          this.note ??
          "This beta session needs to reconnect before the local engine can use it.",
      };
    return {
      state: "disconnected",
      accessMode: this.usesBeta() ? "beta" : "installed-cli",
      detail: "Connect your Memtrace account for noncommercial beta access.",
      loginPending: false,
    };
  }
  async status() {
    await this.initialize();
    return this.snapshot();
  }
  private async persist(
    tokens: BetaTokens,
    binding: BetaBinding,
    generation: number,
    identityChange: boolean,
  ) {
    const signal = identityChange ? this.connectionAbort?.signal : undefined;
    const verification = verifyBetaAccess(tokens.access_token, binding, {
      loadKeys: this.options.loadKeys,
      cachedKey: identityChange ? undefined : this.record?.publicKey,
      now: this.clock,
      accountId: tokens.account.id,
    });
    const verified = signal
      ? await waitForBetaStep(verification, signal)
      : await verification;
    if (
      verified.account.name !== tokens.account.name ||
      verified.account.email !== tokens.account.email ||
      Date.parse(tokens.refresh_expires_at) <= this.clock() ||
      Date.parse(verified.expiresAt) >
        Date.parse(tokens.refresh_expires_at) + 1000
    )
      throw Error(
        "Memtrace returned an inconsistent beta account. Connect again.",
      );
    if (
      (this.closing && identityChange) ||
      generation !== this.generation ||
      signal?.aborted
    )
      throw Error("This beta action was cancelled.");
    const record: BetaCredentials = {
      version: 1,
      deviceId: binding.deviceId,
      sessionId: binding.sessionId,
      refreshToken: tokens.refresh_token,
      refreshExpiresAt: tokens.refresh_expires_at,
      account: verified.account,
      termsVersion: BETA_TERMS,
      publicKey: verified.publicKey,
      accessExpiresAt: verified.expiresAt,
    };
    if (identityChange) {
      this.committing = true;
      this.note = "Saving your approved beta connection securely.";
      this.emit();
      await this.options.beforeIdentityChange();
    }
    if (
      (this.closing && identityChange) ||
      generation !== this.generation ||
      signal?.aborted
    )
      throw Error("This beta action was cancelled.");
    // Persist the rotated refresh in the OS store before granting engine access.
    await this.options.storage.write(record);
    this.record = record;
    this.configured = true;
    this.signedOut = false;
    this.storageFailure = undefined;
    this.token = undefined;
    try {
      this.accessFile = await this.options.storage.writeAccess(
        tokens.access_token,
      );
    } catch {
      this.note =
        "The beta connection was saved, but its private engine proof could not be written. Refresh the connection to retry.";
      await this.options.storage.clearAccess().catch(() => {});
      throw Error(this.note);
    }
    this.token = tokens.access_token;
    this.telemetry = undefined;
    if (this.options.telemetryOptIn?.() && tokens.telemetry_token) {
      try {
        this.telemetry = verifyTelemetryAuthorization(
          tokens.telemetry_token,
          binding,
          record.account.id,
          verified.publicKey,
          this.clock(),
        );
      } catch {
        /* Optional diagnostics cannot invalidate ordinary engine access. */
      }
    }
    this.note = undefined;
    this.retryAfter = 0;
    this.emit();
  }
  connect(): Promise<MemCodeBetaStatus> {
    if (this.closing)
      return Promise.reject(new Error("MemCode beta sign-in was cancelled."));
    if (this.connecting)
      return Promise.reject(
        new Error("Finish or cancel the current beta sign-in first."),
      );
    this.connectionAbort = new AbortController();
    this.connecting = this.connectAction(this.connectionAbort.signal).finally(
      () => {
        this.connecting = undefined;
        this.connectionAbort = undefined;
        this.connectionPhase = undefined;
        this.committing = false;
      },
    );
    return this.connecting;
  }
  private async connectAction(signal: AbortSignal) {
    await waitForBetaStep(this.initialize(), signal);
    signal.throwIfAborted();
    if (this.changing)
      throw Error("Finish or cancel the current beta action first.");
    this.options.assertMayChange();
    this.changing = true;
    this.connectionPhase = "starting";
    this.note = undefined;
    this.emit();
    try {
      // An in-flight rotation must settle before a switch can replace/revoke it.
      if (this.refreshing)
        await waitForBetaStep(this.refreshing.catch(() => {}), signal);
      if (this.revoking)
        await waitForBetaStep(this.revoking.catch(() => {}), signal);
      signal.throwIfAborted();
      const generation = ++this.generation;
      const binding = {
        deviceId: this.record?.deviceId ?? randomUUID(),
        sessionId: randomUUID(),
      };
      this.connectionPhase = "browser";
      this.emit();
      const tokens = await waitForBetaStep(
        this.options.authorization.authorize(binding),
        signal,
      );
      signal.throwIfAborted();
      this.connectionPhase = "finishing";
      this.emit();
      const previous = this.record;
      await this.persist(tokens, binding, generation, true);
      if (previous && !previous.signedOut)
        void this.options.authorization
          .revoke(previous.refreshToken, previous)
          .catch(() => {});
      await this.options.afterConnected?.();
    } catch (error) {
      this.note =
        error instanceof Error
          ? error.message
          : "MemCode beta could not connect.";
      throw error;
    } finally {
      this.changing = false;
      this.emit();
    }
    return this.snapshot();
  }
  async cancel() {
    if (!this.connecting) return this.status();
    if (this.committing)
      throw Error(
        "Memtrace approval has completed. Wait for the connection to finish, then disconnect if needed.",
      );
    this.cancelConnection();
    await this.connecting.catch(() => {});
    return this.snapshot();
  }
  private cancelConnection() {
    this.connectionAbort?.abort(
      new Error("MemCode beta sign-in was cancelled."),
    );
    this.options.authorization.cancel();
  }
  private async refreshAccess(force: boolean) {
    await this.initialize();
    if (
      this.changing ||
      this.closing ||
      this.signedOut ||
      !this.record ||
      this.record.signedOut
    )
      return;
    if (this.record.reauthRequired)
      throw Error("This beta session needs to connect again.");
    if (
      !force &&
      this.current() &&
      Date.parse(this.record.accessExpiresAt) > this.clock() + 120000
    )
      return;
    if (this.clock() < this.retryAfter) {
      if (this.current()) return;
      throw Error(this.note ?? "Try beta access again shortly.");
    }
    if (this.refreshing) return this.refreshing;
    const generation = this.generation,
      record = this.record;
    this.refreshing = (async () => {
      try {
        if (Date.parse(record.refreshExpiresAt) <= this.clock())
          throw new BetaRequestError(401);
        const tokens = await this.options.authorization.refresh(
          record.refreshToken,
          record,
        );
        if (tokens.account.id !== record.account.id)
          throw new BetaRequestError(401);
        await this.persist(tokens, record, generation, false);
      } catch (error) {
        if (generation !== this.generation || this.closing) return;
        this.note =
          error instanceof Error
            ? error.message
            : "Memtrace beta could not refresh.";
        if (
          error instanceof BetaRequestError &&
          (error.status === 401 || error.status === 409)
        ) {
          record.reauthRequired = true;
          this.token = undefined;
          this.telemetry = undefined;
          await this.options.storage.clearAccess().catch(() => {});
          await this.options.storage.write(record).catch(() => {});
        } else if (error instanceof BetaRequestError && error.status === 429)
          this.retryAfter = this.clock() + 60000;
        else if (error instanceof BetaRequestError && error.status === 503) {
          try {
            if (!(await this.options.authorization.available())) {
              this.token = undefined;
              this.telemetry = undefined;
              await this.options.storage.clearAccess();
            }
          } catch {
            /* Keep a still-valid proof on network/service failure. */
          }
        }
        if (!this.current()) {
          this.token = undefined;
          this.telemetry = undefined;
          await this.options.storage.clearAccess().catch(() => {});
        }
        this.emit();
        throw error;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }
  async refresh() {
    if (this.storageFailure && !this.changing) {
      this.initializing = undefined;
      this.storageFailure = undefined;
      await this.initialize();
    }
    try {
      await this.refreshAccess(true);
      if (this.current()) await this.options.beforeEngineUse?.();
    } catch (error) {
      this.note =
        error instanceof Error
          ? error.message
          : "Beta access could not refresh.";
      this.emit();
    }
    return this.snapshot();
  }
  async resume() {
    await this.refreshAccess(false).catch(() => {});
    return this.snapshot();
  }
  async environment(): Promise<Record<string, string>> {
    await this.initialize();
    this.assertMayStart();
    if (!this.usesBeta()) return {};
    await this.refreshAccess(false);
    if (!this.current() || !this.record)
      throw Error(
        this.note ??
          "Reconnect MemCode beta before using its local engine access.",
      );
    const generation = this.generation,
      record = this.record;
    await this.options.beforeEngineUse?.();
    if (
      generation !== this.generation ||
      record !== this.record ||
      this.changing ||
      this.signedOut ||
      !this.current()
    )
      throw Error(
        "Beta access changed while the local engine was preparing. Connect again before continuing.",
      );
    return {
      MEMCODE_ENGINE_ACCESS_FILE: this.accessFile!,
      MEMCODE_ENGINE_DEVICE_ID: record.deviceId,
      MEMCODE_ENGINE_SESSION_ID: record.sessionId,
      MEMCORTEX_STORE_DIR: join(
        dirname(this.accessFile!),
        "cortex",
        createHash("sha256").update(record.account.id).digest("hex"),
      ),
      MEMTRACE_ENGINEER: record.account.id,
    };
  }
  clearTelemetryAuthorization() {
    this.telemetry = undefined;
  }
  /** Host-only purpose-specific credential; never part of status, disk state or engine env. */
  async telemetryAuthorization(): Promise<TelemetryAuthorization | null> {
    if (!this.options.telemetryOptIn?.() || this.changing || this.closing)
      return null;
    await this.initialize();
    if (!this.record || this.signedOut || this.record.reauthRequired)
      return null;
    const generation = this.generation;
    await this.refreshAccess(false);
    if (!this.telemetry || this.telemetry.expiresAt <= this.clock() + 30000)
      await this.refreshAccess(true);
    if (
      generation !== this.generation ||
      this.changing ||
      this.closing ||
      !this.options.telemetryOptIn?.() ||
      !this.current()
    )
      return null;
    return this.telemetry &&
      this.telemetry.accountId === this.record?.account.id &&
      this.telemetry.expiresAt > this.clock()
      ? this.telemetry
      : null;
  }
  private retryRevocation(allowChanging = false): Promise<void> {
    if (this.revoking) return this.revoking;
    const record = this.record;
    if (!record?.signedOut || this.closing) return Promise.resolve();
    const generation = this.generation;
    this.revoking = (async () => {
      try {
        await this.options.authorization.revoke(record.refreshToken, record);
        if (
          this.record !== record ||
          generation !== this.generation ||
          (this.changing && !allowChanging)
        )
          return;
        await this.options.storage.forgetSession();
        if (this.record === record) {
          this.record = undefined;
          this.configured = true;
        }
        this.emit();
      } catch {
        /* The encrypted tombstone is retained for a later retry. */
      } finally {
        this.revoking = undefined;
      }
    })();
    return this.revoking;
  }
  async signOut() {
    await this.initialize();
    if (!this.configured && !this.record) return this.snapshot();
    if (this.changing)
      throw Error("Finish or cancel the current beta action first.");
    this.options.assertMayChange();
    this.changing = true;
    this.emit();
    try {
      await this.refreshing?.catch(() => {});
      await this.revoking?.catch(() => {});
      ++this.generation;
      await this.options.storage.markSignedOut();
      this.signedOut = true;
      this.token = undefined;
      this.telemetry = undefined;
      if (this.record) {
        this.record.signedOut = true;
        await this.options.storage.write(this.record).catch(() => {});
      }
      await this.options.beforeIdentityChange();
      if (this.record) await this.retryRevocation(true);
      else {
        this.configured = true;
      }
    } finally {
      this.changing = false;
      this.emit();
    }
    return this.snapshot();
  }
  async useExistingCLI() {
    await this.signOut();
    if (this.record?.signedOut)
      throw Error(
        "Beta is signed out locally, but remote revocation could not be confirmed. Retry when online before changing engine billing.",
      );
    this.options.assertMayChange();
    this.changing = true;
    this.emit();
    try {
      await this.options.storage.clear();
      await this.options.beforeIdentityChange();
      this.configured = false;
      this.signedOut = false;
      this.storageFailure = undefined;
      this.note = undefined;
    } finally {
      this.changing = false;
      this.emit();
    }
    return this.snapshot();
  }
  close() {
    if (this.closed) return this.closed;
    this.closing = true;
    clearInterval(this.timer);
    this.cancelConnection();
    this.closed = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // A refresh may already have consumed its one-use server credential.
        // Let that same-session rotation reach secure storage before exit;
        // new refreshes and browser/account changes are blocked by closing.
        if (this.refreshing)
          await Promise.race([
            this.refreshing.catch(() => {}),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, 17000);
            }),
          ]);
      } finally {
        clearTimeout(timeout);
        ++this.generation;
        this.telemetry = undefined;
      }
    })();
    return this.closed;
  }
}
