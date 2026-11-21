import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ArrowUpRight,
  Check,
  Download,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  appUpdater,
  updateBusy,
  updatePercent,
  type AppUpdater,
  type UpdateContext,
  type PublishedAppRelease,
} from "../updates";
import { errorMessage } from "../errors";
import { Spinner } from "./UI";
import "../styles-updates.css";

function ReleaseHistoryEntry({
  entry,
  initiallyOpen,
}: {
  entry: PublishedAppRelease;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details
      className="app-update-history-entry"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <strong>{entry.title || `Version ${entry.version}`}</strong>
        <span>
          v{entry.version} · {new Date(entry.publishedAt).toLocaleDateString()}
        </span>
      </summary>
      {open && (
        <div className="app-update-notes">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              img: () => null,
              a: ({ children }) => <span>{children}</span>,
            }}
          >
            {entry.notes}
          </ReactMarkdown>
        </div>
      )}
    </details>
  );
}

/** A quiet installed-app entry point; checking never signs in or installs. */
export function AppUpdateAction({
  open,
  automaticDownloads = true,
  updater = appUpdater,
}: {
  open: () => void;
  automaticDownloads?: boolean;
  updater?: AppUpdater;
}) {
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot);
  useEffect(
    () => updater.setAutomaticDownloads(automaticDownloads),
    [updater, automaticDownloads],
  );
  useEffect(() => {
    void updater.start();
    const recheck = () => {
      if (document.visibilityState === "visible") void updater.poll();
    };
    const timer = setInterval(recheck, 15 * 60_000);
    if (typeof timer === "object") timer.unref?.();
    window.addEventListener("focus", recheck);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", recheck);
    };
  }, [updater]);
  if (!state.release || state.info?.development) return null;
  const percent = updatePercent(state.progress);
  const label =
    state.phase === "ready"
      ? "Install and restart"
      : state.phase === "downloading"
        ? `Downloading${percent === undefined ? "…" : ` ${percent}%`}`
        : state.phase === "verifying"
          ? "Verifying update…"
          : state.phase === "installing"
            ? "Restarting…"
            : "Download update";
  return (
    <button
      className="app-update-action"
      onClick={() => {
        if (state.phase === "ready")
          void updater.requestRestart().then((started) => {
            if (!started) open();
          });
        else if (!updateBusy(state.phase)) void updater.download();
        else open();
      }}
      title={`MemCode ${state.release.version} · ${label}`}
    >
      <Download size={12} />
      <span>{label}</span>
    </button>
  );
}

export function AppUpdates({
  currentVersion,
  automaticDownloads = true,
  onAutomaticDownloadsChange,
  beforeRestart,
  updater = appUpdater,
}: {
  currentVersion: string;
  automaticDownloads?: boolean;
  onAutomaticDownloadsChange?: (enabled: boolean) => void;
  beforeRestart?: () => Promise<void>;
  updater?: AppUpdater;
}) {
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot);
  const [confirm, setConfirm] = useState(false);
  const [context, setContext] = useState<UpdateContext>();
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState("");
  const [history, setHistory] = useState<PublishedAppRelease[]>();
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [saving, setSaving] = useState(false);
  const restart = async (confirmed = false) => {
    if (saving) return;
    setSaving(true);
    setContextError("");
    try {
      await beforeRestart?.();
      if (confirmed) {
        setConfirm(false);
        await updater.install();
      } else await updater.requestRestart();
    } catch (error) {
      setContextError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const loadHistory = async () => {
    if (historyBusy) return;
    setHistoryBusy(true);
    setHistoryError("");
    try {
      setHistory(await updater.history());
    } catch (error) {
      setHistoryError(errorMessage(error));
    } finally {
      setHistoryBusy(false);
    }
  };
  const reviewInstall = async () => {
    setConfirm(true);
    setContext(undefined);
    setContextError("");
    setContextBusy(true);
    try {
      setContext(await updater.inspect());
    } catch (error) {
      setContextError(errorMessage(error));
    } finally {
      setContextBusy(false);
    }
  };
  useEffect(() => {
    void updater.openSettings();
  }, [updater]);
  useEffect(
    () => updater.setAutomaticDownloads(automaticDownloads),
    [updater, automaticDownloads],
  );
  useEffect(() => {
    setConfirm(false);
  }, [state.release?.version]);
  useEffect(() => {
    if (state.restartReview) {
      setContext(state.restartReview);
      setContextError("");
      setConfirm(true);
    }
  }, [state.restartReview]);
  const busy = updateBusy(state.phase),
    percentage = updatePercent(state.progress);
  const version = state.info?.currentVersion || currentVersion;
  const development = state.info?.development;
  const label =
    state.phase === "checking"
      ? "Checking for updates…"
      : state.phase === "downloading"
        ? `Downloading update${percentage === undefined ? "…" : ` · ${percentage}%`}`
        : state.phase === "verifying"
          ? "Verifying the signed download…"
          : state.phase === "installing"
            ? "Installing and restarting MemCode…"
            : state.phase === "ready"
              ? `Version ${state.release?.version} is ready to install.`
              : state.phase === "current"
                ? "You’re up to date."
                : state.release
                  ? `Version ${state.release.version} is available.`
                  : development
                    ? "Development build"
                    : "Updates, at your pace.";
  return (
    <section
      className="settings-section app-updates"
      aria-label="App updates"
      data-guide="app-updates"
    >
      <div className="app-updates-heading">
        <Download size={17} />
        <span>
          <strong>MemCode updates</strong>
          <small>
            New releases, with a signed download and a clear change log.
          </small>
        </span>
        <span className="app-update-version">v{version}</span>
      </div>
      <div
        className={
          "app-update-status" +
          (state.phase === "ready" ? " app-update-status-ready" : "")
        }
        aria-live="polite"
      >
        <div className="app-update-status-icon">
          {busy ? (
            <Spinner />
          ) : state.phase === "current" ? (
            <Check size={17} />
          ) : (
            <Sparkles size={17} />
          )}
        </div>
        <div>
          <strong>{label}</strong>
          <p>
            {development
              ? "Keep this checkout current with Git. Signed app updates are available in installed beta releases."
              : state.phase === "ready"
                ? "Your verified download is saved. Install it and MemCode will reopen automatically with your workspace and settings."
                : state.phase === "downloading" || state.phase === "verifying"
                  ? "You can keep working. An Install and restart button appears here when the verified download is ready."
                  : "MemCode checks automatically. Updates and your settings stay saved when you close the app."}
          </p>
        </div>
        {state.info && !development && (
          <button
            className={
              "button " + (state.phase === "ready" ? "primary" : "secondary")
            }
            type="button"
            disabled={busy || saving || confirm}
            onClick={() =>
              state.phase === "ready" ? void restart() : void updater.check()
            }
          >
            <RefreshCw size={13} />
            {saving
              ? "Saving settings…"
              : state.phase === "ready"
                ? "Install and restart"
                : state.phase === "checking"
                  ? "Checking"
                  : "Check for updates"}
          </button>
        )}
      </div>
      {state.phase === "downloading" && (
        <div
          className="app-update-progress"
          role="progressbar"
          aria-label="Update download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
        >
          <span
            style={{
              width: percentage === undefined ? "25%" : `${percentage}%`,
            }}
          />
        </div>
      )}
      {!development && onAutomaticDownloadsChange && (
        <label className="checkbox-label app-update-preference">
          <input
            type="checkbox"
            checked={automaticDownloads}
            onChange={(event) =>
              onAutomaticDownloadsChange(event.target.checked)
            }
          />
          <span>
            Download updates automatically
            <small>
              Verified downloads prepare in the background. You choose when to
              restart.
            </small>
          </span>
        </label>
      )}
      {state.error && (
        <p className="app-update-error" role="alert">
          {state.error}
        </p>
      )}
      {contextError && !confirm && (
        <p className="app-update-error" role="alert">
          {contextError}
        </p>
      )}
      {state.checkedAt && !busy && (
        <small className="app-update-checked">
          Last successful check {new Date(state.checkedAt).toLocaleString()}
        </small>
      )}
      {state.release && (
        <div className="app-update-release">
          <div className="app-update-release-title">
            <strong>What’s new in {state.release.version}</strong>
            {state.release.publishedAt && (
              <small>
                {new Date(state.release.publishedAt).toLocaleDateString()}
              </small>
            )}
          </div>
          <div className="app-update-notes">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                img: () => null,
                a: ({ children }) => <span>{children}</span>,
              }}
            >
              {state.release.notes ||
                "This release includes improvements to MemCode."}
            </ReactMarkdown>
          </div>
          {!busy && !confirm && state.phase !== "ready" && (
            <button
              type="button"
              className="button primary"
              onClick={() => void updater.download()}
            >
              <Download size={14} />
              Download update
              <ArrowUpRight size={13} />
            </button>
          )}
          {!busy && confirm && (
            <div className="app-update-confirm">
              <p>
                <strong>Install and restart?</strong>{" "}
                {contextBusy
                  ? "Checking running sessions…"
                  : context
                    ? context.activeWorkers
                      ? `${context.activeWorkers} ${context.activeWorkers === 1 ? "worker is" : "workers are"} still running. Finish or stop them before updating.`
                      : context.activeTerminals
                        ? `Restarting closes ${context.activeTerminals} ${context.activeTerminals === 1 ? "terminal session" : "terminal sessions"} and your open browser sessions.`
                        : "Open browser sessions will close. No terminal sessions are running."
                    : "Check session status before installing."}{" "}
                Your account, projects, tasks and files are kept.
              </p>
              {contextError && (
                <p className="app-update-error" role="alert">
                  {contextError}
                </p>
              )}
              <div>
                <button
                  type="button"
                  className="button secondary"
                  disabled={contextBusy}
                  onClick={() => void reviewInstall()}
                  aria-label="Refresh update readiness"
                >
                  <RefreshCw size={12} />
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setConfirm(false);
                    updater.dismissRestartReview();
                  }}
                >
                  Not now
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    saving ||
                    contextBusy ||
                    !context ||
                    context.activeWorkers > 0
                  }
                  onClick={() => void restart(true)}
                >
                  {saving ? "Saving settings…" : "Install and restart"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <details
        className="app-update-changelog"
        onToggle={(event) => {
          if (event.currentTarget.open && !history && !historyBusy)
            void loadHistory();
        }}
      >
        <summary>
          Release notes <span>Recent updates</span>
        </summary>
        {historyBusy && (
          <p className="app-update-history-loading">
            <Spinner />
            Loading release notes…
          </p>
        )}
        {historyError && (
          <div>
            <p className="app-update-error" role="alert">
              {historyError}
            </p>
            <button
              type="button"
              className="button secondary"
              onClick={() => void loadHistory()}
            >
              <RefreshCw size={12} />
              Try again
            </button>
          </div>
        )}
        {history && !history.length && (
          <p className="app-update-history-empty">
            No beta releases have been published yet.
          </p>
        )}
        {history?.map((entry, index) => (
          <ReleaseHistoryEntry
            key={entry.version}
            entry={entry}
            initiallyOpen={index === 0 && !state.release}
          />
        ))}
      </details>
      <p className="app-update-trust">
        <ShieldCheck size={13} />
        Update signatures are verified before installation. Your coding models
        keep their own account and usage limits.
      </p>
    </section>
  );
}
