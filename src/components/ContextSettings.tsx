import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, Network, RefreshCw } from "lucide-react";
import {
  contextAssistantDefaults,
  type ContextAssistantSettings,
  type ContextAssistantSetupState,
} from "../context-settings";
import {
  RetrievalStatusCheck,
  retrievalSetupMessage,
  retrievalSetupState,
} from "../context-setup-status";
import { Select } from "./Select";
import { Spinner } from "./UI";
import "../styles-local-model.css";

const megabytes = (bytes: number) =>
  `${Math.ceil(bytes / 1_000_000).toLocaleString()} MB`;

export function ContextSettings({
  value,
  change,
}: {
  value?: ContextAssistantSettings;
  change: (value: ContextAssistantSettings) => void;
}) {
  const settings = value ?? contextAssistantDefaults;
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const update = (patch: Partial<ContextAssistantSettings>) =>
    change({ ...settings, ...patch });
  const [status, setStatus] = useState<ContextAssistantSetupState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preferenceError, setPreferenceError] = useState("");
  const [checking, setChecking] = useState(false);
  const checks = useRef(new RetrievalStatusCheck());
  const mounted = useRef(true);
  const installingRef = useRef(false);
  const preferenceSequence = useRef(0);
  const persistManaged = async (next: ContextAssistantSettings) => {
    change(next);
    if (next.provider !== "onnx" || next.packageDirectory.trim()) return true;
    const sequence = ++preferenceSequence.current;
    try {
      await window.memcode.configureRetrieval(next);
      if (mounted.current && sequence === preferenceSequence.current)
        setPreferenceError("");
      return true;
    } catch (error) {
      if (mounted.current && sequence === preferenceSequence.current)
        setPreferenceError(
          error instanceof Error ? error.message : String(error),
        );
      return false;
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      checks.current.invalidate();
    };
  }, []);
  const managed =
    settings.provider === "onnx" && !settings.packageDirectory.trim();
  const refresh = useCallback(async () => {
    setChecking(true);
    const result = await checks.current.run(() =>
      window.memcode.retrievalStatus(),
    );
    if (!result || !mounted.current) return;
    if (result.status) {
      setStatus(result.status);
      setError("");
    } else setError(result.error);
    setChecking(false);
  }, []);
  useEffect(() => {
    if (managed) void refresh();
    return () => checks.current.invalidate();
  }, [settings.enabled, managed, refresh]);
  useEffect(() => {
    if (!busy && status?.status !== "installing") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled || (!installingRef.current && busy)) return;
      await refresh();
      if (!cancelled) timer = setTimeout(() => void poll(), 750);
    };
    timer = setTimeout(() => void poll(), 750);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [busy, status?.status, refresh]);
  const install = async () => {
    checks.current.invalidate();
    installingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const next = retrievalSetupState(await window.memcode.installRetrieval());
      const persisted =
        next.status !== "ready" ||
        (await persistManaged(latestSettings.current));
      checks.current.invalidate();
      if (mounted.current) {
        setStatus(next);
        if (persisted) setError("");
      }
    } catch (error) {
      checks.current.invalidate();
      if (mounted.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      installingRef.current = false;
      if (mounted.current) {
        setBusy(false);
        setChecking(false);
      }
    }
  };
  const installing = busy || (status?.status === "installing" && !error);
  const failed = !!error || status?.status === "error";
  const ready = status?.status === "ready" && !failed;
  return (
    <section
      className="settings-section context-settings"
      aria-label="Local retrieval settings"
    >
      <div>
        <Network size={17} />
        <span>
          <strong>Local retrieval assistant</strong>
          <small>
            Memtrace finds the code. A local assistant helps plan the search.
          </small>
        </span>
        <span className="settings-tag">On this computer</span>
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) =>
            void persistManaged({ ...settings, enabled: event.target.checked })
          }
        />
        <span>
          Use a local retrieval assistant
          <small>
            Source facts, impact and coordination stay with Memtrace.
          </small>
        </span>
      </label>
      {preferenceError && (
        <p className="local-model-error" role="alert">
          Your retrieval preference was not saved. {preferenceError}
        </p>
      )}
      {!settings.enabled && managed && status?.status === "ready" && (
        <p className="settings-hint">
          <Check size={13} /> Your local model is installed. Enable it whenever
          you need it.
        </p>
      )}
      {settings.enabled && managed && (
        <div className="local-model-card" aria-busy={installing || checking}>
          <small>{settings.model.replace(/^.*\//, "")}</small>
          <div className="local-model-status">
            {installing || (checking && !status) ? (
              <Spinner />
            ) : ready ? (
              <Check size={15} />
            ) : (
              <Network size={15} />
            )}
            <strong>
              {failed
                ? "Local retrieval needs attention"
                : ready
                  ? "Ready to assist"
                  : installing
                    ? status?.phase === "verify"
                      ? "Checking your local model…"
                      : "Downloading your local model…"
                    : "Set up local retrieval"}
            </strong>
            {ready && <span className="local-model-ready">Installed</span>}
          </div>
          <p>{retrievalSetupMessage(status, error)}</p>
          {installing && (
            <div className="local-model-progress" role="status">
              <progress
                aria-label="Local retrieval model download"
                max={status?.totalBytes || 1}
                value={status?.downloadedBytes ?? 0}
              />
              {status?.totalBytes ? (
                <small>
                  {megabytes(status.downloadedBytes)} of{" "}
                  {megabytes(status.totalBytes)}
                </small>
              ) : null}
            </div>
          )}
          {(!ready || error) && status?.status !== "unsupported" && (
            <button
              type="button"
              className="button primary"
              disabled={installing || checking}
              onClick={() => void (!status || error ? refresh() : install())}
            >
              {installing ? (
                <Spinner />
              ) : error || status?.status === "error" ? (
                <RefreshCw size={13} />
              ) : (
                <Download size={13} />
              )}
              {installing
                ? "Setting up…"
                : error
                  ? "Check setup again"
                  : status?.status === "error"
                    ? "Retry setup"
                    : "Set up local retrieval"}
            </button>
          )}
          <small>
            {ready && !preferenceError
              ? "Runs locally when a worker needs context. Your setup is saved automatically."
              : ready
                ? "Your model is installed. Change the assistant preference again to retry saving."
                : `Downloads ${status?.totalBytes ? `about ${megabytes(status.totalBytes)} of ` : "the "}model files once. No extra app or package paths. Your code stays on this computer.`}
          </small>
        </div>
      )}
      {settings.enabled && (error || status?.status === "error") && (
        <p className="local-model-error" role="alert">
          {error || status?.message}
        </p>
      )}
      {settings.enabled && !managed && (
        <p className="settings-hint">
          Using your advanced local configuration.
          <button
            type="button"
            className="text-button"
            onClick={() =>
              update({
                provider: "onnx",
                packageDirectory: "",
                model: contextAssistantDefaults.model,
              })
            }
          >
            Use MemCode setup
          </button>
        </p>
      )}
      {settings.enabled && (
        <details className="local-model-advanced">
          <summary>Advanced · use an existing local model or server</summary>
          <label className="field">
            <span>Local inference</span>
            <Select
              aria-label="Context assistant provider"
              value={settings.provider}
              onValueChange={(value) =>
                update({
                  provider: value as ContextAssistantSettings["provider"],
                  ...(value === "onnx"
                    ? { model: contextAssistantDefaults.model }
                    : {}),
                })
              }
            >
              <option value="onnx">MemCode local model</option>
              <option value="openai-compatible">
                Existing local model server
              </option>
            </Select>
          </label>
          {settings.provider === "onnx" ? (
            <label className="field">
              <span>Optional Transformers package directory</span>
              <input
                aria-label="Context model package directory"
                placeholder="Leave blank to use MemCode’s managed setup"
                value={settings.packageDirectory}
                onChange={(event) =>
                  update({ packageDirectory: event.target.value })
                }
              />
            </label>
          ) : (
            <label className="field">
              <span>Local server API base</span>
              <input
                aria-label="Context model endpoint"
                placeholder="http://127.0.0.1:11434/v1"
                value={settings.baseUrl}
                onChange={(event) => update({ baseUrl: event.target.value })}
              />
            </label>
          )}
          <label className="field">
            <span>Local model</span>
            <input
              aria-label="Context assistant model"
              readOnly={settings.provider === "onnx"}
              value={settings.model}
              onChange={(event) => update({ model: event.target.value })}
            />
          </label>
        </details>
      )}
      <p className="settings-hint">
        Memtrace retrieval works without this optional model. Setup and local
        processing stay separate from your coding-model account.
      </p>
    </section>
  );
}
