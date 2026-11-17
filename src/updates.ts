import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { errorMessage } from "./errors";

export interface AppUpdateInfo {
  currentVersion: string;
  development: boolean;
  previousError?: string | null;
  readyRelease?: AppRelease | null;
}
export interface AppRelease {
  version: string;
  notes: string;
  publishedAt?: string | null;
}
export interface PublishedAppRelease {
  version: string;
  title: string;
  notes: string;
  publishedAt: string;
}
export interface UpdateProgress {
  phase: "downloading" | "verifying" | "ready" | "installing";
  downloaded: number;
  total?: number | null;
}
export interface AppUpdateAPI {
  info(): Promise<AppUpdateInfo>;
  context(): Promise<UpdateContext>;
  history(): Promise<PublishedAppRelease[]>;
  check(): Promise<AppRelease | null>;
  download(
    version: string,
    progress: (value: UpdateProgress) => void,
  ): Promise<void>;
  install(
    version: string,
    progress: (value: UpdateProgress) => void,
  ): Promise<void>;
}
export interface UpdateContext {
  activeWorkers: number;
  activeTerminals: number;
}
export type UpdatePhase =
  | "loading"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "error"
  | UpdateProgress["phase"];
export interface AppUpdateSnapshot {
  phase: UpdatePhase;
  info?: AppUpdateInfo;
  release?: AppRelease;
  checkedAt?: string;
  progress?: UpdateProgress;
  error?: string;
  restartReview?: UpdateContext;
}

const nativeAPI: AppUpdateAPI = {
  info: () =>
    isTauri()
      ? invoke("app_update_info")
      : Promise.resolve({ currentVersion: "", development: true }),
  check: () => invoke("app_update_check"),
  context: () => invoke("app_update_context"),
  history: () => invoke("app_update_history"),
  download: (version, progress) => {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = progress;
    return invoke("app_update_download", { version, channel });
  },
  install: (version, progress) => {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = progress;
    return invoke("app_update_install", { version, channel });
  },
};

/** Native owns the durable verified download; only an explicit action installs. */
export class AppUpdater {
  private snapshot: AppUpdateSnapshot = { phase: "loading" };
  private listeners = new Set<() => void>();
  private initialized?: Promise<void>;
  private busy = false;
  private inspectingRestart = false;
  private started = false;
  private lastPassiveCheck?: number;
  private automaticDownloads = false;
  constructor(
    private readonly api: AppUpdateAPI = nativeAPI,
    private readonly clock: () => number = Date.now,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(value: Partial<AppUpdateSnapshot>) {
    this.snapshot = { ...this.snapshot, ...value };
    this.listeners.forEach((listener) => listener());
  }
  initialize() {
    return (this.initialized ??= this.api.info().then(
      (info) => {
        this.set({
          info,
          phase: info.readyRelease
            ? "ready"
            : info.previousError
              ? "error"
              : "idle",
          release: info.readyRelease ?? undefined,
          error: info.previousError ?? undefined,
        });
      },
      (error) => {
        const message = errorMessage(error);
        this.set({
          phase: "error",
          error: /app_update_info.*not found/i.test(message)
            ? "Restart MemCode to load app-update support from this build."
            : message,
        });
        this.initialized = undefined;
      },
    ));
  }
  inspect() {
    return this.api.context();
  }
  history() {
    return this.api.history();
  }
  setAutomaticDownloads(enabled: boolean) {
    this.automaticDownloads = enabled;
    if (enabled && this.snapshot.phase === "available") void this.download();
  }
  async start() {
    if (this.started) return;
    this.started = true;
    await this.initialize();
    if (
      this.snapshot.info &&
      !this.snapshot.info.development &&
      this.snapshot.phase !== "ready"
    )
      await this.poll();
  }
  async poll(maximumAge = 15 * 60_000) {
    if (
      !this.snapshot.info ||
      this.snapshot.info.development ||
      this.busy ||
      updateBusy(this.snapshot.phase) ||
      this.snapshot.phase === "ready"
    )
      return;
    if (
      this.lastPassiveCheck !== undefined &&
      this.clock() - this.lastPassiveCheck < maximumAge
    )
      return;
    await this.check();
  }
  async openSettings() {
    await this.initialize();
    // Opening Settings is an explicit interest in current availability. The
    // background timer's throttle must not make a newly published update hidden.
    await this.poll(0);
  }
  async check() {
    if (
      this.busy ||
      this.snapshot.phase === "installing" ||
      this.snapshot.phase === "ready"
    )
      return;
    this.busy = true;
    try {
      await this.initialize();
      if (!this.snapshot.info || this.snapshot.info.development) return;
      this.lastPassiveCheck = this.clock();
      this.set({
        phase: "checking",
        release: undefined,
        error: undefined,
        progress: undefined,
      });
      const release = await this.api.check();
      this.set({
        phase: release ? "available" : "current",
        info: { ...this.snapshot.info, previousError: undefined },
        release: release ?? undefined,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.set({ phase: "error", error: errorMessage(error) });
    } finally {
      this.busy = false;
    }
    if (this.automaticDownloads && this.snapshot.phase === "available")
      await this.download();
  }
  async download() {
    if (
      this.busy ||
      updateBusy(this.snapshot.phase) ||
      this.snapshot.phase === "ready" ||
      !this.snapshot.release ||
      this.snapshot.info?.development
    )
      return;
    this.busy = true;
    const version = this.snapshot.release.version;
    this.set({ phase: "downloading", error: undefined, progress: undefined });
    try {
      await this.api.download(version, (progress) =>
        this.set({ phase: progress.phase, progress }),
      );
      this.set({ phase: "ready" });
    } catch (error) {
      this.set({ phase: "error", error: errorMessage(error) });
    } finally {
      this.busy = false;
    }
  }
  async install() {
    if (
      this.busy ||
      this.snapshot.phase !== "ready" ||
      !this.snapshot.release ||
      this.snapshot.info?.development
    )
      return;
    this.busy = true;
    this.set({
      phase: "installing",
      error: undefined,
      restartReview: undefined,
    });
    try {
      await this.api.install(this.snapshot.release.version, (progress) =>
        this.set({ phase: progress.phase, progress }),
      );
      // Native installation restarts the app; this renderer cannot claim a new version.
      this.set({ phase: "installing" });
    } catch (error) {
      const message = errorMessage(error);
      const info = await this.api.info().catch(() => this.snapshot.info);
      this.set({
        phase:
          info?.readyRelease?.version === this.snapshot.release?.version ||
          /running worker|running workers|workers.*before updating/i.test(
            message,
          )
            ? "ready"
            : "error",
        info,
        error: message,
      });
    } finally {
      this.busy = false;
    }
  }
  /** An explicit restart click needs review only when sessions would be lost. */
  async requestRestart() {
    if (this.busy || this.inspectingRestart || this.snapshot.phase !== "ready")
      return false;
    this.inspectingRestart = true;
    try {
      const context = await this.inspect();
      if (context.activeWorkers || context.activeTerminals) {
        this.set({ restartReview: context });
        return false;
      }
      await this.install();
      return this.getSnapshot().phase === "installing";
    } catch (error) {
      this.set({ error: errorMessage(error) });
      return false;
    } finally {
      this.inspectingRestart = false;
    }
  }
  dismissRestartReview() {
    this.set({ restartReview: undefined });
  }
}

export const appUpdater = new AppUpdater();
export const updateBusy = (phase: UpdatePhase) =>
  ["loading", "checking", "downloading", "verifying", "installing"].includes(
    phase,
  );
export function updatePercent(progress?: UpdateProgress): number | undefined {
  if (!progress?.total || progress.total <= 0) return undefined;
  return Math.max(
    0,
    Math.min(100, Math.round((progress.downloaded / progress.total) * 100)),
  );
}
