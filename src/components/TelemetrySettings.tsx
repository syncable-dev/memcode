import { useEffect, useState } from "react";
import { ChartNoAxesCombined } from "lucide-react";
import type { TelemetryStatus } from "../telemetry";

export function TelemetrySettings({
  notify,
}: {
  notify: (message: string) => void;
}) {
  const [status, setStatus] = useState<TelemetryStatus | null>(null),
    [busy, setBusy] = useState(false),
    [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      void window.memcode
        .telemetryStatus?.()
        .then((value) => {
          if (live) {
            setStatus(value);
            setUnavailable(false);
          }
        })
        .catch(() => {
          if (live) setUnavailable(true);
        });
    };
    refresh();
    const unsubscribe = window.memcode.onBetaStatus?.(() => refresh());
    const timer = setInterval(refresh, 10000);
    return () => {
      live = false;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, []);
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      setStatus(await window.memcode.setTelemetryEnabled(enabled));
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "Usage sharing could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="settings-section"
      aria-label="Usage privacy preferences"
    >
      <div>
        <ChartNoAxesCombined size={17} />
        <span>
          <strong>Improve model routing</strong>
          <small>Optional measurements for future routing evaluation.</small>
        </span>
        <span className="settings-tag">
          {status?.enabled ? "Sharing enabled" : "Off by default"}
        </span>
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          aria-label="Share content-free usage"
          checked={status?.enabled ?? false}
          disabled={
            busy ||
            !status ||
            status.excluded ||
            (!status.enabled && !status.eligible)
          }
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>
          Share content-free usage for this Memtrace account
          <small>
            Measured complexity, selected models, run timing, planning counts
            and review outcomes.
          </small>
        </span>
      </label>
      <p className="muted">
        Usage reports never include prompts, source code, project or task text,
        file paths, branches, commands, transcripts, error text or artifact
        contents. Your configured coding provider still receives the context
        needed for its task.
      </p>
      <p className="muted" aria-live="polite">
        {unavailable
          ? "Usage controls are unavailable. Reopen Settings after updating MemCode."
          : !status
            ? "Checking privacy preferences…"
            : status.excluded
              ? "Usage sharing is excluded in this demo or QA profile."
              : !status.eligible
                ? "Connect MemCode beta to enable reporting for your account. Local work is always available without reporting."
                : status.enabled
                  ? `${status.pending} pending · ${status.sent} sent. Turning this off deletes pending reports and stops future uploads.`
                  : "Nothing is sent until you enable it. You can turn it off at any time."}
      </p>
      <p className="muted">
        Unsent reports expire after 30 days. Uploaded reports are retained for
        up to 90 days.{" "}
        <button
          className="text-button"
          type="button"
          onClick={() =>
            void window.memcode
              .openTelemetryPrivacy()
              .catch(() => notify("Could not open the usage privacy guide."))
          }
        >
          What is shared
        </button>
      </p>
    </section>
  );
}
