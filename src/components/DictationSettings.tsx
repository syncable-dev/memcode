import { useEffect, useState } from "react";
import { AudioLines, Check, Download, RefreshCw, Square } from "lucide-react";
import type { Settings } from "../shared";
import {
  speechDefaults,
  type SpeechSettings,
  type SpeechStatus,
} from "../speech";
import { Select } from "./Select";
import { Spinner } from "./UI";
import "../styles-dictation.css";

export function DictationSettings({
  settings,
  change,
}: {
  settings: Settings;
  change: (value: SpeechSettings, endpoint?: string) => void;
}) {
  const [status, setStatus] = useState<SpeechStatus>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const value = settings.speech ?? {
    ...speechDefaults,
    mode: "endpoint" as const,
  };
  const refresh = async () => {
    try {
      const value = await window.memcode.speechStatus();
      setStatus(value);
      return value;
    } catch (error) {
      setError((error as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!busy && status?.state !== "installing" && status?.state !== "starting")
      return;
    const timer = setInterval(() => void refresh(), 600);
    return () => clearInterval(timer);
  }, [busy, status?.state]);
  const act = async (action: () => Promise<SpeechStatus | void>) => {
    setBusy(true);
    setError("");
    try {
      const result = await action();
      if (result) setStatus(result);
      else await refresh();
    } catch (error) {
      const message = (error as Error).message;
      // An RPC failure can leave the last polled snapshot at "installing".
      // The retry stays usable even if the subsequent status check also fails.
      setStatus((previous) =>
        previous ? { ...previous, state: "error", message } : previous,
      );
      await refresh();
      setError(message);
    } finally {
      setBusy(false);
    }
  };
  const dirty =
    !!status &&
    (JSON.stringify(status.settings) !== JSON.stringify(value) ||
      (value.mode === "endpoint" &&
        status.endpoint !== settings.speechEndpoint));
  const installed = status?.state === "available";
  const locallyReady = installed && value.mode !== "endpoint";
  const downloadSize = status?.downloadBytes
    ? `about ${Math.ceil(status.downloadBytes / 1_000_000).toLocaleString()} MB`
    : "a small download";
  return (
    <section
      className="settings-section dictation-settings"
      data-guide="dictation-settings"
      aria-label="Local dictation settings"
    >
      <div>
        <AudioLines size={17} />
        <span>
          <strong>Local dictation</strong>
          <small>Speak your idea. Review the words before sending.</small>
        </span>
        <span className="settings-tag">On this computer</span>
      </div>
      <div className="dictation-setup-card">
        <span className={"speech-status " + (status?.state ?? "unconfigured")}>
          {status?.state === "ready" || locallyReady ? (
            <Check size={13} />
          ) : busy ? (
            <Spinner />
          ) : (
            <AudioLines size={13} />
          )}
          <strong>
            {status?.state === "ready" || locallyReady
              ? "Ready to dictate"
              : status?.state === "installing"
                ? "Setting up dictation"
                : status?.state === "starting"
                  ? "Starting your local model"
                  : installed
                    ? "Configured speech server"
                    : "A voice for your ideas"}
          </strong>
        </span>
        <p>
          {locallyReady
            ? "Your model and settings are saved. Click a microphone in any prompt to dictate; the local model starts automatically."
            : (status?.message ??
              "Set up a small local speech model. Your audio stays on this computer.")}
        </p>
        {status?.state === "installing" && (
          <progress
            aria-label="Local dictation download"
            max={1}
            value={status.progress ?? 0}
          />
        )}
        {status?.state !== "ready" &&
          !locallyReady &&
          status?.managedInstallAvailable !== false && (
            <>
              <button
                type="button"
                className="button primary"
                disabled={
                  busy ||
                  (!status && !error) ||
                  status?.state === "starting" ||
                  status?.state === "installing"
                }
                onClick={() =>
                  void act(async () => {
                    if (!status) return refresh();
                    const result = await (installed
                      ? window.memcode.prepareSpeech()
                      : window.memcode.installSpeech());
                    change(result.settings);
                    return result;
                  })
                }
              >
                <Download size={13} />
                {busy
                  ? "Setting up…"
                  : !status && error
                    ? "Check setup again"
                    : installed
                      ? "Start local dictation"
                      : "Set up local dictation"}
              </button>
              <small>
                {installed
                  ? "Your local model is installed. It also starts when you click a microphone in any prompt."
                  : `Downloads multilingual Whisper Tiny and its CPU runtime once (${downloadSize}). No extra apps or package paths.`}
              </small>
            </>
          )}
        {status?.state === "ready" && (
          <div className="dictation-ready-actions">
            <small>{status.modelName ?? "Your local speech server"}</small>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void act(() => window.memcode.stopSpeech())}
            >
              <Square size={11} />
              {status.mode === "managed" ? "Stop local speech" : "Disconnect"}
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="dictation-error" role="alert">
          {error}
        </p>
      )}
      <p className="settings-hint">
        When you first record, allow microphone access for MemCode. Your audio
        is transcribed on this computer.
      </p>
      <details className="dictation-advanced">
        <summary>Advanced · use an existing local model or server</summary>
        <label className="field">
          <span>Speech setup</span>
          <Select
            value={value.mode}
            onValueChange={(mode) =>
              change({ ...value, mode: mode as SpeechSettings["mode"] })
            }
            aria-label="Speech setup"
          >
            <option value="managed">Installed whisper.cpp model</option>
            <option value="endpoint">Existing local speech server</option>
          </Select>
        </label>
        {value.mode === "managed" ? (
          <>
            <label className="field">
              <span>Whisper server executable</span>
              <input
                aria-label="Whisper executable"
                value={value.executable}
                onChange={(event) =>
                  change({ ...value, executable: event.target.value })
                }
                placeholder="Absolute path to whisper-server"
              />
            </label>
            <label className="field">
              <span>Local model file</span>
              <input
                aria-label="Whisper model"
                value={value.modelPath}
                onChange={(event) =>
                  change({ ...value, modelPath: event.target.value })
                }
                placeholder="Absolute path to a ggml Whisper model"
              />
            </label>
          </>
        ) : (
          <label className="field">
            <span>Whisper inference endpoint</span>
            <input
              aria-label="Speech endpoint"
              value={settings.speechEndpoint}
              onChange={(event) => change(value, event.target.value)}
              placeholder="http://127.0.0.1:8080/inference"
            />
          </label>
        )}
        <label className="field">
          <span>Language</span>
          <Select
            aria-label="Dictation language"
            value={value.language}
            onValueChange={(language) => change({ ...value, language })}
          >
            <option value="auto">Detect automatically</option>
            <option value="en">English</option>
            <option value="da">Dansk</option>
          </Select>
        </label>
        <div className="dictation-check">
          <button
            type="button"
            className="button secondary"
            disabled={busy || dirty}
            onClick={() => void act(() => window.memcode.prepareSpeech())}
          >
            <RefreshCw size={12} />
            Check local connection
          </button>
          <small>
            {dirty
              ? "Save settings to use your changes."
              : "No microphone recording is made by this check."}
          </small>
        </div>
      </details>
    </section>
  );
}
