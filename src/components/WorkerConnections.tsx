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
import { DshSetupFlow } from "./DshSetupFlow";
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
    [savingDefault, setSavingDefault] = useState<Harness>(),
    [dshReady, setDshReady] = useState(false);
  const selectedHarness = selected?.harness;
  const readyToApprove =
    selected?.auth === "authenticated" || selected?.auth === "local" || selected?.auth === "provider-managed";
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
      (
        document.querySelector<HTMLElement>(
          selectedHarness === "dsh"
            ? ".dsh-setup-flow button:not([disabled]), .dsh-setup-flow input:not([disabled]), .connection-approval input"
            : readyToApprove
              ? ".connection-approval input"
              : ".connection-sign-in button",
        ) ??
        // While setup is still loading only a spinner renders; keep keyboard
        // focus inside the modal on its always-present Close button.
        document.querySelector<HTMLElement>(
          'button[aria-label="Close connection approval"]',
        )
      )?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [selectedHarness, readyToApprove]);
  const showConnection = (status: WorkerConnectionStatus) => {
    setSelected(status);
    setApproved(false);
    setDshReady(false);
    setDialogError("");
  };
  const openConnectionModal = (
    installed: RuntimeInfo["harnesses"][number],
    status?: WorkerConnectionStatus,
  ) => {
    showConnection(
      status ?? {
        harness: installed.id,
        installed: installed.available,
        connected: false,
        runtimePath: installed.path,
        desktopAppPath: installed.desktopAppPath,
        auth: installed.id === "dsh" ? "provider-managed" : "unknown",
        note:
          installed.id === "dsh"
            ? "Set up DeepSeek Harness and choose an ACP profile."
            : "Check your existing sign-in before connecting.",
        loginCommand:
          installed.id === "cursor"
            ? "agent login"
            : installed.id === "claude"
              ? "claude auth login"
              : installed.id === "dsh"
                ? "dsh --help"
                : "codex login",
      },
    );
  };
  const checkConnection = async () => {
    setDialogError("");
    const current = (await refresh(true))?.find(
      (status) => status.harness === selectedHarness,
    );
    if (current?.connected) {
      setSelected(undefined);
      notify(harnessNames[current.harness] + " connected.");
    } else if (!current) {
      setDialogError("MemCode couldn’t check this connection. Try again.");
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
      const connection = await window.memcode.connectWorker(
        selected.harness,
        true,
      );
      setStatuses((items) => [
        ...items.filter((item) => item.harness !== connection.harness),
        connection,
      ]);
      setSelected(undefined);
      setApproved(false);
      notify(
        harnessNames[selected.harness] +
          " connected. Choose a task when you’re ready.",
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
        `${harnessNames[harness]} default set to ${permissionLabels[mode]}. Tasks without an override inherit it.`,
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
            Connect your tools and set their defaults once. Every task can
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
                  ) : (cursorNeedsAgent || installed.id === "dsh") &&
                    desktopFound ? (
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
                    : installed.id === "dsh" && !available && desktopFound && !approvalSaved
                      ? "DeepSeek Harness Desktop is installed. Install its dsh CLI and choose an ACP profile to run workers here."
                      : !available && desktopFound && !approvalSaved
                        ? "Your desktop app is installed. Set up its agent command to run workers here, then refresh."
                        : (status?.note ??
                          (loading
                            ? "Checking your installed setup…"
                            : "Connect your installed worker to use it here."))}
              </p>
              {connected && (status?.accountLabel || installed.id === "dsh") && (
                <small className="connection-account-label">
                  {installed.id === "dsh"
                    ? `ACP profile: ${installed.activeProfile || "acp"} · ${installed.models.length} model${installed.models.length === 1 ? "" : "s"}`
                    : status?.accountLabel}
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
                      "Across all projects · tasks can override"
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
                        : "Ready for your next task"}
                    </span>
                    {installed.id === "dsh" && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => openConnectionModal(installed, status)}
                      >
                        Sync Desktop models
                      </button>
                    )}
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
                        if (status?.installed || installed.id === "dsh")
                          openConnectionModal(installed, status);
                        else
                          void window.memcode
                            .openWorkerSetup(installed.id)
                            .catch((error) => notify((error as Error).message));
                      }}
                    >
                      {status?.connectionIssue
                        ? "Connection help"
                        : available
                          ? "Sign-in help"
                          : "Set up agent"}
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
                    onClick={() => {
                      if (installed.id === "dsh") {
                        openConnectionModal(installed, status);
                      } else {
                        void window.memcode
                          .openWorkerSetup(installed.id)
                          .catch((error) => notify((error as Error).message));
                      }
                    }}
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
                    onClick={() => openConnectionModal(installed, status)}
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
              {selected.harness === "dsh"
                ? selected.connected
                  ? "Configure DeepSeek Harness."
                  : !selected.installed
                    ? "Set up DeepSeek Harness."
                    : "Connect DeepSeek Harness."
                : `Connect ${harnessNames[selected.harness]}.`}
            </h2>
            {dialogError && (
              <p className="connection-error" role="alert">
                {dialogError}
              </p>
            )}
            {selected.harness === "dsh" && (
              <DshSetupFlow
                alreadyConnected={selected.connected}
                notify={notify}
                onRuntime={onRuntime}
                onRefreshStatus={async () => {
                  await refresh(true);
                }}
                onReadyChange={setDshReady}
                onClose={() => setSelected(undefined)}
              />
            )}
            {selected.harness === "dsh" && selected.connected ? (
              <footer>
                <small>Profile and provider changes take effect immediately.</small>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setSelected(undefined)}
                >
                  Done
                </button>
              </footer>
            ) : selected.harness === "dsh" && !dshReady ? null : !readyToApprove ? (
              <div className="connection-sign-in">
                {selected.connectionIssue ? (
                  <p>{selected.note}</p>
                ) : selected.installed ? (
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
                    onClick={() => void checkConnection()}
                  >
                    {loading ? <Spinner /> : <RefreshCw size={12} />}
                    {selected.connectionIssue
                      ? "Check again"
                      : selected.installed
                        ? "Check sign-in"
                        : "Check installation"}
                  </button>
                  {selected.connectionIssue && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() =>
                        void window.memcode
                          .openWorkerSetup(selected.harness)
                          .catch(() => setDialogError("Couldn’t open the CLI setup guide in your browser."))
                      }
                    >
                      <ArrowUpRight size={12} />
                      CLI setup guide
                    </button>
                  )}
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
                      : selected.auth === "provider-managed"
                        ? "This CLI manages provider sign-in and confirms model access when work starts. If needed, use the CLI’s sign-in or provider setup first."
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
                  <small>
                    {selected.harness === "dsh" && !dshReady
                      ? "Finish the DeepSeek Harness setup above before connecting."
                      : "Connecting does not start a coding task."}
                  </small>
                  <button
                    type="button"
                    className="button primary"
                    disabled={!approved || busy || (selected.harness === "dsh" && !dshReady)}
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
