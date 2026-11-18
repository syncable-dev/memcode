import { useRef, useState } from "react";
import { ChartNoAxesCombined, Network } from "lucide-react";
import type { AppState, Project, WorkItem } from "../shared";
import { CodeInsights } from "./CodeInsights";
import { Insights as DeliveryInsights } from "./Insights";
export function InsightsPage(props: {
  state: AppState;
  project: Project;
  open: (task: WorkItem) => void;
  notify: (message: string) => void;
  onAnalyze?: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"code" | "delivery">("code");
  const root = useRef<HTMLDivElement>(null);
  const choose = (value: "code" | "delivery") => {
    setTab(value);
    root.current
      ?.closest(".workspace-scroll")
      ?.scrollTo({ top: 0, behavior: "auto" });
  };
  return (
    <div className="insights-page" ref={root}>
      <div className="insights-navigation">
        <div
          className="insights-mode"
          role="tablist"
          aria-label="Insights mode"
        >
          <button
            role="tab"
            id="insights-code-tab"
            aria-controls="insights-code-panel"
            tabIndex={tab === "code" ? 0 : -1}
            aria-selected={tab === "code"}
            className={tab === "code" ? "active" : ""}
            onClick={() => choose("code")}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                choose("delivery");
                document.getElementById("insights-delivery-tab")?.focus();
              }
            }}
          >
            <Network size={14} />
            Code intelligence
          </button>
          <button
            role="tab"
            id="insights-delivery-tab"
            aria-controls="insights-delivery-panel"
            tabIndex={tab === "delivery" ? 0 : -1}
            aria-selected={tab === "delivery"}
            className={tab === "delivery" ? "active" : ""}
            onClick={() => choose("delivery")}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                choose("code");
                document.getElementById("insights-code-tab")?.focus();
              }
            }}
          >
            <ChartNoAxesCombined size={14} />
            Delivery
          </button>
        </div>
      </div>
      <div
        role="tabpanel"
        id={`insights-${tab}-panel`}
        aria-labelledby={`insights-${tab}-tab`}
      >
        {tab === "code" ? (
          <CodeInsights
            key={JSON.stringify([
              props.project.id,
              props.project.path,
              props.project.branch,
            ])}
            {...props}
          />
        ) : (
          <DeliveryInsights {...props} />
        )}
      </div>
    </div>
  );
}
