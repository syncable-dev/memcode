import { useEffect, useState } from "react";
import { ArrowUpRight, AudioLines, Check, Network } from "lucide-react";
import type { GuideAction } from "../onboarding";

/** Read-only checks: visiting setup never downloads or enables a model. */
export function LocalToolsGuide({
  onAction,
  hidden,
}: {
  onAction: (action: GuideAction) => void;
  hidden: boolean;
}) {
  const [voice, setVoice] = useState("Not set up");
  const [retrieval, setRetrieval] = useState("Not set up");
  useEffect(() => {
    if (hidden) return;
    let live = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const check = <T,>(request: Promise<T>) =>
      Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timers.push(
            setTimeout(() => reject(Error("Check setup in Settings")), 8000),
          );
        }),
      ]);
    setVoice("Checking setup…");
    setRetrieval("Checking setup…");
    void check(window.memcode.speechStatus()).then(
      (status) => {
        if (live)
          setVoice(
            status.state === "ready" || status.state === "available"
              ? "Ready"
              : status.state === "installing"
                ? "Downloading…"
                : status.state === "error"
                  ? "Not ready"
                  : "Not set up",
          );
      },
      () => live && setVoice("Check in Settings"),
    );
    void check(window.memcode.retrievalStatus()).then(
      (status) => {
        if (live)
          setRetrieval(
            status.status === "ready"
              ? "Installed"
              : status.status === "installing"
                ? "Downloading…"
                : status.status === "error"
                  ? "Not ready"
                  : "Not set up",
          );
      },
      () => live && setRetrieval("Check in Settings"),
    );
    return () => {
      live = false;
      timers.forEach(clearTimeout);
    };
  }, [hidden]);
  return (
    <div className="guide-local-tools">
      {[
        {
          action: "dictation" as const,
          icon: AudioLines,
          title: "Speak your prompts",
          status: voice,
          body: "Turn a spoken idea into an editable prompt. Whisper runs locally.",
        },
        {
          action: "retrieval" as const,
          icon: Network,
          title: "Local code retrieval",
          status: retrieval,
          body: "Qwen 2.5 Coder helps plan searches over Memtrace’s code context.",
        },
      ].map(({ action, icon: Icon, title, status, body }) => (
        <button key={action} type="button" onClick={() => onAction(action)}>
          <span className="guide-tool-icon">
            <Icon size={17} />
          </span>
          <span>
            <strong>{title}</strong>
            <small>{body}</small>
            <em>
              {["Ready", "Installed"].includes(status) && <Check size={10} />}
              {status} · Set up in Settings <ArrowUpRight size={10} />
            </em>
          </span>
        </button>
      ))}
      <p>On-device models download only when you choose setup.</p>
    </div>
  );
}
