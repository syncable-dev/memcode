import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Link2,
  RefreshCw,
  ShieldCheck,
  Unplug,
  X,
} from "lucide-react";
import {
  harnessNames,
  type AppState,
  type Harness,
  type RuntimeInfo,
} from "../shared";
import type { WorkerConnectionStatus } from "../connections";
import {
  permissionModes,
  permissionLabels,
  permissionDescription,
  supportsPermissionMode,
  type PermissionMode,
} from "../permissions";
import { HarnessMark, Spinner } from "./UI";
import { Select } from "./Select";
import { useRuntimeHealth } from "../useRuntimeHealth";
import { approvedRuntime } from "../worker-availability";
import { desktopPlatform } from "../platform";
import "../styles-connections.css";
import "../styles-worker-defaults.css";

const defaultSummary = (mode: PermissionMode) =>
  mode === "full-access"
    ? "Bypasses tool approvals and the harness sandbox where supported."
    : mode === "auto"
      ? "Native risk review handles routine actions and escalates decisions to you."
      : "Uses the harness’s normal approval rules.";

export function WorkerConnections({
  runtime,
  state,
  notify,
  onCreateWork,
  onConnected,
  onRuntime,
  compact = false,
}: {
  runtime: RuntimeInfo;
  state: AppState;
  notify: (text: string) => void;
  onCreateWork?: (harness: Harness) => void;
  onConnected?: (harness: Harness) => void;
  onRuntime?: (runtime: RuntimeInfo) => void;
  compact?: boolean;
}) {
  const health = useRuntimeHealth();
  const [statuses, setStatuses] = useState<WorkerConnectionStatus[]>([]),
    [selected, setSelected] = useState<WorkerConnectionStatus>(),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [dialogError, setDialogError] = useState(""),
    [savingDefault, setSavingDefault] = useState<Harness>();
  const selectedHarness = selected?.harness;
  const readyToApprove =
    selected?.auth === "authenticated" || selected?.auth === "local";
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onRuntimeRef = useRef(onRuntime);
  onRuntimeRef.current = onRuntime;
  const refresh = useCallback(async (discover = false) => {
    setLoading(true);
    try {
      if (discover) {
        const catalog = await window.memcode.refreshWorkerCatalog();
        onRuntimeRef.current?.(catalog);
      }
      const current = await window.memcode.workerConnectionStatus();
      setStatuses(current);
      setSelected(
        (open) =>
          current.find((status) => status.harness === open?.harness) ?? open,
      );
      setError("");
      return current;
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  const key = Object.values(state.workerConnections ?? {})
    .map((c) => c?.harness + ":" + c?.approvedAt)
    .sort()
    .join("|");
  useEffect(() => {
    void refresh();
  }, [key, refresh]);
  useEffect(() => {
    if (!selectedHarness) return;
    const previous = document.activeElement;
    window.dispatchEvent(new CustomEvent("memcode:popover", { detail: true }));
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) setSelected(undefined);
      if (event.key === "Tab") {
        const controls = [
          ...document.querySelectorAll<HTMLElement>(
            ".connection-consent button:not([disabled]),.connection-consent input:not([disabled]),.connection-consent summary",
          ),
        ];
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
      window.dispatchEvent(
        new CustomEvent("memcode:popover", { detail: false }),
      );
    };
  }, [selectedHarness]);
  useEffect(() => {
    if (!selectedHarness) return;
    const frame = requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          readyToApprove
            ? ".connection-approval input"
            : ".connection-sign-in button",
        )
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [selectedHarness, readyToApprove]);
  const showConnection = (status: WorkerConnectionStatus) => {
    setSelected(status);
    setApproved(false);
    setDialogError("");
  };
  const checkSignIn = async () => {
    setDialogError("");
    const current = (await refresh(true))?.find(
      (status) => status.harness === selectedHarness,
    );
    if (current?.connected) {
      setSelected(undefined);
      notify(harnessNames[current.harness] + " connected.");
    } else if (!current) {
      setDialogError("MemCode couldn’t check sign-in. Try again.");
    } else if (current.installed && current.auth === "not-authenticated") {
      setDialogError(
        "You’re still signed out. Finish sign-in in Terminal, then check again.",
      );
    }
  };
  const copySignInCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setDialogError("");
      notify("Sign-in command copied.");
    } catch {
      setDialogError(
        "Select the command above and copy it into your terminal.",
      );
    }
  };
  const connect = async () => {
    if (!selected || !readyToApprove || !approved) return;
    setDialogError("");
    setBusy(true);
    try {
      await window.memcode.connectWorker(selected.harness, true);
      setSelected(undefined);
      setApproved(false);
      await refresh();
      notify(
        harnessNames[selected.harness] +
          " connected. Choose a story when you’re ready.",
      );
      onConnected?.(selected.harness);
    } catch (error) {
      setApproved(false);
      await refresh();
      setDialogError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async (harness: Harness) => {
    setBusy(true);
    try {
      await window.memcode.disconnectWorker(harness);
      await refresh();
      notify(
        harnessNames[harness] +
          " disconnected. Its provider sign-in is unchanged.",
      );
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveDefault = async (harness: Harness, mode: PermissionMode) => {
    setSavingDefault(harness);
    try {
      await window.memcode.setWorkerPermissionDefault(harness, mode);
      notify(
        `${harnessNames[harness]} default set to ${permissionLabels[mode]}. Stories without an override inherit it.`,
      );
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setSavingDefault(undefined);
    }
  };
  return (
    <section
      className={"worker-connections " + (compact ? "compact" : "")}
      aria-label="Worker connections"
      data-guide="worker-connections"
    >
      <header>
        <div>
          <span className="eyebrow">YOUR INSTALLED TOOLS</span>
          <h2>Connect a worker. Keep your setup.</h2>
          <p>
            Connect your tools and set their defaults once. Every story can
            override them.
          </p>
        </div>
        <button
          type="button"
          className="button secondary worker-connections-refresh"
          onClick={() => void refresh(true)}
          disabled={loading || busy || !health.available}
          aria-label="Refresh worker connections"
        >
          <RefreshCw size={12} className={loading ? "spin" : undefined} />
          {loading ? "Checking…" : "Refresh"}
        </button>
      </header>
      {error && health.available && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
      <div className="worker-connection-grid">
        {runtime.harnesses.map((catalogRuntime) => {
          const installed = catalogRuntime;
          const status = statuses.find((s) => s.harness === installed.id),
            connected = health.available && status?.connected === true,
            approvalSaved =
              status?.approvalSaved ??
              approvedRuntime(installed, state.workerConnections),
            available = status?.installed ?? installed.available,
            desktopFound = !!(
              status?.desktopAppPath ?? installed.desktopAppPath
            ),
            cursorNeedsAgent = installed.id === "cursor" && !available,
            defaultMode =
              state.settings.workerPermissionDefaults?.[installed.id] ??
              "review",
            active = state.tasks.filter(
              (t) =>
                !t.example &&
                t.harness === installed.id &&
                ["preparing", "running", "stopping"].includes(t.run.state),
            ).length;
          return (
            <article
              className={
                "worker-connection-card " + (connected ? "connected" : "")
              }
              key={installed.id}
              data-harness={installed.id}
            >
              <div className="connection-card-top">
                <HarnessMark id={installed.id} />
                <span className={connected ? "is-connected" : ""}>
                  {connected ? (
                    <>
                      <Check size={10} />
                      Connected
                    </>
                  ) : !health.available ? (
                    approvalSaved ? (
                      "Approval saved"
                    ) : (
                      "Status unavailable"
                    )
                  ) : approvalSaved ? (
                    "Connection saved"
                  ) : available ? (
                    "Installed"
                  ) : cursorNeedsAgent && desktopFound ? (
                    "Desktop app installed"
                  ) : desktopFound ? (
                    "App found"
                  ) : (
                    "Not installed"
                  )}
                </span>
              </div>
              <h3>{installed.name}</h3>
              <p>
                {!health.available
                  ? "Runtime disconnected. Your saved connection approval is unchanged."
                  : cursorNeedsAgent && desktopFound
                    ? "Cursor is installed. MemCode runs workers through the separate Cursor Agent CLI. Install it, then refresh here."
                    : !available && desktopFound && !approvalSaved
                      ? "Your desktop app is installed. Set up its agent command to run workers here, then refresh."
                      : (status?.note ??
                        (loading
                          ? "Checking your installed setup…"
                          : "Connect your installed worker to use it here."))}
              </p>
              {connected && status?.accountLabel && (
                <small className="connection-account-label">
                  {status.accountLabel}
                </small>
              )}
              {(available || approvalSaved) && (
                <div className="worker-default-control">
                  <label>
                    <span>Default permissions</span>
                    <Select
                      aria-label={`${installed.name} default permissions`}
                      value={defaultMode}
                      disabled={!!savingDefault || busy || !health.available}
                      onValueChange={(mode) =>
                        void saveDefault(installed.id, mode as PermissionMode)
                      }
                    >
                      {permissionModes.map((mode) => (
                        <option
                          key={mode}
                          value={mode}
                          disabled={!supportsPermissionMode(installed.id, mode)}
                        >
                          {permissionLabels[mode]}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <p title={permissionDescription(installed.id, defaultMode)}>
                    {defaultSummary(defaultMode)}
                  </p>
                  <small>
                    {savingDefault === installed.id ? (
                      <>
                        <Spinner />
                        Saving default…
                      </>
                    ) : active ? (
                      "Applies across projects on the next worker pass."
                    ) : (
                      "Across all projects · stories can override"
                    )}
                  </small>
                  {installed.id === "cursor" && (
                    <span className="worker-default-availability">
                      Smart Auto is unavailable through Cursor ACP.
                    </span>
                  )}
                </div>
              )}
              <footer>
                {!health.available ? (
                  <span className="connection-runtime-unavailable">
                    Reopen MemCode to reconnect
                  </span>
                ) : connected ? (
                  <>
                    <span>
                      {active
                        ? active + " active"
                        : "Ready for your next story"}
                    </span>
                    {onCreateWork && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onCreateWork(installed.id)}
                      >
                        Create work <ArrowUpRight size={12} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={"Disconnect " + installed.name}
                      title={
                        active
                          ? "Stop active workers before disconnecting"
                          : "Disconnect " + installed.name
                      }
                      disabled={busy || active > 0}
                      onClick={() => void disconnect(installed.id)}
                    >
                      <Unplug size={13} />
                    </button>
                  </>
                ) : approvalSaved ? (
                  <>
                    <button
                      type="button"
                      className="button secondary worker-connect-button"
                      disabled={loading || busy}
                      onClick={() => void refresh(true)}
                    >
                      <RefreshCw size={12} />
                      Check again
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        if (status?.installed) showConnection(status);
                        else
                          void window.memcode
                            .openWorkerSetup(installed.id)
                            .catch((error) => notify((error as Error).message));
                      }}
                    >
                      {available ? "Sign-in help" : "Set up agent"}
                      <ArrowUpRight size={12} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={"Disconnect " + installed.name}
                      disabled={busy || active > 0}
                      onClick={() => void disconnect(installed.id)}
                    >
                      <Unplug size={13} />
                    </button>
                  </>
                ) : !available ? (
                  <button
                    type="button"
                    className="button secondary worker-connect-button"
                    disabled={loading || busy}
                    onClick={() =>
                      void window.memcode
                        .openWorkerSetup(installed.id)
                        .catch((error) => notify((error as Error).message))
                    }
                  >
                    <ArrowUpRight size={12} />
                    {cursorNeedsAgent
                      ? "Install Cursor Agent CLI"
                      : "Set up " + installed.name}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button secondary worker-connect-button"
                    disabled={busy || loading}
                    onClick={() => {
                      showConnection(
                        status ?? {
                          harness: installed.id,
                          installed: true,
                          connected: false,
                          runtimePath: installed.path,
                          auth: "unknown",
                          note: "Check your existing sign-in before connecting.",
                          loginCommand:
                            installed.id === "cursor"
                              ? "agent login"
                              : installed.id === "claude"
                                ? "claude auth login"
                                : "codex login",
                        },
                      );
                    }}
                  >
                    <Link2 size={12} />
                    Connect {installed.name}
                  </button>
                )}
              </footer>
            </article>
          );
        })}
      </div>
      {selected && (
        <div
          className="connection-consent-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy)
              setSelected(undefined);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-consent-title"
            className="connection-consent"
          >
            <header>
              <HarnessMark id={selected.harness} />
              <button
                type="button"
                className="icon-button"
                aria-label="Close connection approval"
                onClick={() => setSelected(undefined)}
                disabled={busy}
              >
                <X size={16} />
              </button>
            </header>
            <h2 id="connection-consent-title">
              Connect {harnessNames[selected.harness]}.
            </h2>
            {dialogError && (
              <p className="connection-error" role="alert">
                {dialogError}
              </p>
            )}
            {!readyToApprove ? (
              <div className="connection-sign-in">
                {selected.installed ? (
                  <>
                    <p>
                      {selected.auth === "not-authenticated"
                        ? `Sign in to ${harnessNames[selected.harness]} with the command below, then return here.`
                        : "Check your existing sign-in. If you need to sign in, run this command in your terminal first."}
                    </p>
                    <code>{selected.loginCommand}</code>
                    <div className="connection-sign-in-actions">
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() =>
                          void copySignInCommand(selected.loginCommand)
                        }
                      >
                        Copy command
                      </button>
                      {desktopPlatform() === "macos" && (
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() =>
                            void window.memcode
                              .openWorkerTerminal()
                              .catch(() =>
                                setDialogError(
                                  "Open Terminal from Applications to run the sign-in command.",
                                ),
                              )
                          }
                        >
                          Open Terminal
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <p>
                    Install the worker’s command-line app, then check again.
                  </p>
                )}
                <div className="connection-sign-in-actions">
                  <button
                    type="button"
                    className="button primary"
                    disabled={loading}
                    onClick={() => void checkSignIn()}
                  >
                    {loading ? <Spinner /> : <RefreshCw size={12} />}
                    {selected.installed
                      ? "Check sign-in"
                      : "Check installation"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p>
                  Use the CLI and sign-in already on this computer. MemCode does
                  not ask for your provider password or API key.
                </p>
                <div className="connection-permissions">
                  <ShieldCheck size={16} />
                  <div>
                    <strong>What you’re allowing</strong>
                    <ul>
                      <li>Start this worker in projects you select.</li>
                      <li>
                        Pass your brief and relevant code context to its
                        configured model.
                      </li>
                      <li>
                        Show its managed browser, terminal, changes and saved
                        outputs here.
                      </li>
                    </ul>
                    <small>
                      Your provider’s own permissions still apply. Models may
                      use cloud services according to your existing setup.
                    </small>
                  </div>
                </div>
                <details>
                  <summary>Installed runtime and sign-in</summary>
                  <code>{selected.runtimePath}</code>
                  <p>
                    {selected.auth === "local"
                      ? "Using the configured local model."
                      : "An existing provider sign-in was detected."}
                  </p>
                </details>
                <label className="connection-approval">
                  <input
                    type="checkbox"
                    checked={approved}
                    onChange={(event) => setApproved(event.target.checked)}
                    disabled={busy}
                  />
                  <span>I allow MemCode to use this installed worker.</span>
                </label>
                <footer>
                  <small>Connecting does not start a coding task.</small>
                  <button
                    type="button"
                    className="button primary"
                    disabled={!approved || busy}
                    onClick={() => void connect()}
                  >
                    {busy ? <Spinner /> : <Link2 size={13} />}Approve & connect
                  </button>
                </footer>
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
