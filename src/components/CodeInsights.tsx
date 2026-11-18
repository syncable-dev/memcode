import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Boxes,
  Code2,
  GitBranch,
  Layers3,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { IntelligenceDetail, IntelligenceSection } from "../intelligence";
import { qualityValue } from "../intelligence";
import { Empty, Spinner } from "./UI";
import { StyleProfile } from "./StyleProfile";
import {
  AnalysisError,
  CaptureButtons,
  countLabel,
  DetailResults,
  Distribution,
  FindingList,
  MetricTile,
  scopedCheckpoints,
  SnapshotEvidence,
  useCapture,
  type IntelligenceProps,
} from "./IntelligenceUI";

const tabs = [
  { id: "quality", label: "Quality", icon: ShieldCheck },
  { id: "architecture", label: "Architecture", icon: Boxes },
  { id: "flows", label: "Flows", icon: Network },
  { id: "api", label: "API surface", icon: GitBranch },
  { id: "history", label: "Changes", icon: Activity },
  { id: "style", label: "Style", icon: Code2 },
  { id: "governance", label: "Rules", icon: Layers3 },
] as const;
type Tab = (typeof tabs)[number]["id"];

export function CodeInsights(props: IntelligenceProps) {
  const { state, project, notify, onAnalyze } = props;
  const report = useCapture(project, notify);
  const snapshot = scopedCheckpoints(state, project, report.latest).at(-1);
  const ready =
    project.analysis === "ready" &&
    !!project.repoId &&
    !!project.path &&
    !project.example;
  const indexing = ["connecting", "indexing"].includes(project.analysis);
  const [setupPending, setSetupPending] = useState(false);
  const [setupError, setSetupError] = useState("");
  useEffect(() => {
    if (!snapshot && ready) void report.load();
  }, [snapshot?.id, ready, project.repoId]);
  const startAnalysis = async () => {
    setSetupPending(true);
    setSetupError("");
    try {
      if (onAnalyze) await onAnalyze();
      else await report.capture(false);
    } catch (reason) {
      setSetupError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSetupPending(false);
    }
  };
  const [tab, setTab] = useState<Tab>("quality"),
    [detail, setDetail] = useState<IntelligenceDetail | null>(null),
    [detailError, setDetailError] = useState(""),
    [loading, setLoading] = useState(false),
    [file, setFile] = useState("src/shared.ts");
  const { busy, capture } = report;
  const request = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    root.current
      ?.closest(".workspace-scroll")
      ?.scrollTo({ top: 0, behavior: "auto" });
  }, [tab, project.id]);
  const [findingMode, setFindingMode] = useState<"complexity" | "reachability">(
    "complexity",
  );
  const load = async (
    section: IntelligenceSection,
    input?: Record<string, unknown>,
  ) => {
    const currentRequest = ++request.current;
    setLoading(true);
    setDetail(null);
    setDetailError("");
    try {
      const result = (await window.memcode.queryIntelligence(
        project.id,
        section,
        input,
      )) as IntelligenceDetail;
      if (currentRequest === request.current) setDetail(result);
    } catch (error) {
      if (currentRequest === request.current)
        setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      if (currentRequest === request.current) setLoading(false);
    }
  };
  useEffect(() => {
    request.current++;
    setDetail(null);
    setTab("quality");
    setLoading(false);
    return () => {
      request.current++;
    };
  }, [project.id]);
  useEffect(() => {
    if (tab !== "quality" && project.analysis === "ready" && !project.example)
      void load(tab, tab === "governance" ? { file } : undefined);
  }, [tab, project.id, project.analysis]);
  if (!snapshot) {
    const problem = report.error || setupError;
    const waiting = busy || setupPending || indexing || (ready && !problem);
    const title = project.example
      ? "Your code deserves real evidence."
      : problem
        ? "The code report couldn’t load."
        : indexing || setupPending
          ? "Preparing code analysis…"
          : ready || busy
            ? "Loading your code report…"
            : !project.path
              ? "Connect your local code."
              : "Analyze this checkout.";
    const description = problem ? (
      <AnalysisError message={problem} />
    ) : project.example ? (
      "Choose a local project to see measurements from its source."
    ) : indexing ? (
      project.analysisNote ||
      "Your report will open when the local graph is ready."
    ) : ready || busy ? (
      "Reading quality and complexity from this branch’s existing graph."
    ) : !project.path ? (
      "Choose the project folder on this computer to see its code quality."
    ) : (
      "Memtrace measures the source for this branch and prepares a quality report."
    );
    return (
      <div className="code-insights-view">
        <section className="intelligence-intro">
          <div className="intelligence-intro-icon">
            <Network size={24} />
          </div>
          <div>
            <span className="intelligence-kicker">
              MEMTRACE CODE INTELLIGENCE
            </span>
            <h2>Understand what you’re about to change.</h2>
            <p>
              Source relationships, measured complexity and recorded history in
              one considered view.
            </p>
          </div>
        </section>
        <div aria-live="polite" aria-busy={waiting}>
          <Empty
            icon={waiting ? <Spinner size={26} /> : <Sparkles size={29} />}
            title={title}
            description={description}
            action={
              !project.example && !waiting ? (
                <button
                  className="button primary"
                  onClick={() =>
                    void (ready ? capture(false) : startAnalysis())
                  }
                >
                  <RefreshCw size={14} />
                  {ready
                    ? "Retry report"
                    : !project.path
                      ? "Connect local code"
                      : "Analyze local code"}
                </button>
              ) : undefined
            }
          />
        </div>
      </div>
    );
  }
  const elevated = qualityValue(snapshot, "elevated");
  return (
    <div className="code-insights-view" ref={root} data-view={tab}>
      <div className="intelligence-toolbar">
        <span className="intelligence-kicker">
          <span />
          MEMTRACE / SOURCE INTELLIGENCE
        </span>
        <CaptureButtons project={project} busy={busy} capture={capture} />
      </div>
      {report.error && <AnalysisError message={report.error} savedCheckpoint />}
      <div
        className="intelligence-tabs"
        role="tablist"
        aria-label="Code intelligence views"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            <item.icon size={13} />
            {item.label}
          </button>
        ))}
      </div>
      {tab === "quality" && (
        <>
          <section className="intelligence-overview">
            <div className="intelligence-overview-copy">
              <span>THE CODE, IN CONTEXT</span>
              <h2>
                A clearer view.
                <br />
                <em>A better next move.</em>
              </h2>
              <p>
                {countLabel(snapshot.metrics.symbols)} source symbols connected
                by {countLabel(snapshot.metrics.edges)} structural
                relationships.
              </p>
              <div>
                <span>
                  <GitBranch size={12} />
                  {snapshot.branch}
                </span>
                <span>{countLabel(snapshot.metrics.files)} indexed files</span>
              </div>
            </div>
            <div className="intelligence-overview-data">
              <div className="intelligence-overview-metrics">
                <MetricTile
                  label="AST-measured"
                  value={countLabel(snapshot.metrics.measuredFunctions)}
                  caption="Function and method records"
                />
                <MetricTile
                  label="Elevated complexity"
                  value={countLabel(elevated)}
                  caption="High + critical engine bands"
                  accent="amber"
                />
                <MetricTile
                  label="Cleanup candidates"
                  value={countLabel(snapshot.metrics.deadCodeCandidates)}
                  caption="Verify reachability before removal"
                  accent="cyan"
                />
              </div>
              <Distribution snapshot={snapshot} />
            </div>
          </section>
        </>
      )}
      <SnapshotEvidence snapshot={snapshot} />
      {tab === "quality" ? (
        <>
          <div className="intelligence-quality-notes">
            <div>
              <ShieldCheck size={17} />
              <span>
                <strong>
                  {countLabel(snapshot.metrics.importCycles)} import cycles
                </strong>
                <small>Complete enumeration when available</small>
              </span>
            </div>
            <div>
              <Layers3 size={17} />
              <span>
                <strong>
                  {countLabel(snapshot.metrics.communities)} modules
                </strong>
                <small>Detected source communities</small>
              </span>
            </div>
            <div>
              <Network size={17} />
              <span>
                <strong>
                  {countLabel(snapshot.metrics.processes)} process records
                </strong>
                <small>Static entry-point neighborhoods</small>
              </span>
            </div>
          </div>
          <div
            className="quality-finding-switch"
            role="group"
            aria-label="Quality findings"
          >
            <button
              className={findingMode === "complexity" ? "active" : ""}
              aria-pressed={findingMode === "complexity"}
              onClick={() => setFindingMode("complexity")}
            >
              Complexity hotspots <span>{snapshot.hotspots.length}</span>
            </button>
            <button
              className={findingMode === "reachability" ? "active" : ""}
              aria-pressed={findingMode === "reachability"}
              onClick={() => setFindingMode("reachability")}
            >
              Reachability candidates <span>{snapshot.deadCode.length}</span>
            </button>
            <small>
              Explore a focused sample, then inspect or plan a change.
            </small>
          </div>
          <FindingList
            key={findingMode}
            {...props}
            snapshot={snapshot}
            title={
              findingMode === "complexity"
                ? "Complexity hotspots"
                : "Reachability candidates"
            }
            description={
              findingMode === "complexity"
                ? "AST measurements. Bars compare values within this returned sample."
                : "Investigation leads; dynamic calls and framework conventions can change the conclusion."
            }
            findings={
              findingMode === "complexity"
                ? snapshot.hotspots
                : snapshot.deadCode
            }
          />
        </>
      ) : (
        <section className="intelligence-panel intelligence-explorer">
          <div className="intelligence-explorer-toolbar">
            {tab === "governance" ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void load("governance", { file });
                }}
              >
                <label>
                  <Code2 size={13} />
                  <input
                    aria-label="Source file for governing rules"
                    value={file}
                    onChange={(event) => setFile(event.target.value)}
                    placeholder="src/shared.ts"
                  />
                </label>
                <button
                  className="button secondary"
                  type="submit"
                  disabled={loading}
                >
                  Read rules
                  <ArrowUpRight size={12} />
                </button>
              </form>
            ) : (
              <span>Read from the selected repository and branch</span>
            )}
            <button
              className="icon-button"
              title="Refresh intelligence detail"
              disabled={loading}
              onClick={() =>
                void load(
                  tab as IntelligenceSection,
                  tab === "governance" ? { file } : undefined,
                )
              }
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {loading ? (
            <div className="intelligence-loading">
              <Spinner size={20} />
              <p>Reading source-backed context…</p>
            </div>
          ) : detail?.section === "style" && detail.style ? (
            <StyleProfile detail={detail} />
          ) : detail ? (
            <DetailResults
              detail={detail}
              back={() => void load("flows")}
              selectFlow={(id) => void load("flow", { process: id })}
            />
          ) : (
            <div className="intelligence-small-empty">
              <Network size={20} />
              {detailError ? (
                <AnalysisError message={detailError} />
              ) : (
                <p>Use refresh to read this part of the graph.</p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
