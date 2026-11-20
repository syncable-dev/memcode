import { useState } from "react";
import {
  Activity,
  ArrowUpRight,
  CalendarDays,
  ChartNoAxesCombined,
  CheckCheck,
  Flag,
  GitBranch,
  Layers3,
  Tag,
  TrendingUp,
  Workflow,
} from "lucide-react";
import type { AppState, Project, Stage, WorkItem } from "../shared";
import { harnessNames, stages } from "../shared";
import { deliverySeries, projectForecast } from "../planning/analytics";
import { dateLabel, dayAt } from "../planning/dates";
import { isActive, stageLabel } from "../domain";
import { Select } from "./Select";
import { HarnessMark, StageIcon } from "./UI";
import {
  CycleCharts,
  countLabel,
  ThroughputChart,
  UnitToggle,
  type PlanningUnit,
} from "./PlanningCharts";

interface Props {
  state: AppState;
  project: Project;
  open: (task: WorkItem) => void;
  notify: (message: string) => void;
}
const stageColors: Record<Stage, string> = {
  planned: "#b0c3ac",
  working: "#48b68f",
  review: "#d2b478",
  done: "#75ad88",
};

export function Insights({ state, project, open }: Props) {
  const [unit, setUnit] = useState<PlanningUnit>("issues");
  const cycles = state.cycles.filter((cycle) => cycle.projectId === project.id);
  const [cycleId, setCycleId] = useState("active");
  const current =
    cycles.find((cycle) => cycle.id === cycleId) ??
    cycles.find((cycle) => cycle.state === "active") ??
    cycles
      .filter((cycle) => cycle.state === "completed")
      .sort((a, b) =>
        (b.completedAt ?? b.endDate).localeCompare(a.completedAt ?? a.endDate),
      )[0] ??
    cycles
      .filter((cycle) => cycle.state === "planned")
      .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  const tasks = state.tasks.filter(
      (task) => task.projectId === project.id && !task.archivedAt,
    ),
    unfinished = tasks.filter((task) => task.stage !== "done");
  const deliveries = deliverySeries(state, project.id),
    completed = deliveries.reduce((sum, point) => sum + (point.issues ?? 0), 0),
    observedDays = deliveries.filter((point) => point.issues !== null).length;
  const forecast = projectForecast(state, project.id);
  const unestimated = unfinished.filter(
    (task) => task.estimate === null || task.estimate === undefined,
  ).length;
  const active = tasks.filter((task) => isActive(task));
  return (
    <div className="insights-view">
      <section className="insights-hero">
        <div className="cycle-intro-grid" />
        <div>
          <span className="planning-kicker">
            <Activity size={13} />
            DELIVERY, WITH THE CONTEXT
          </span>
          <h2>See how the work moves.</h2>
          <p>
            Recorded progress, changing scope and the room to plan the next
            iteration with a clearer view.
          </p>
        </div>
        <div className="insights-history-start">
          <CalendarDays size={17} />
          <span>
            Tracking began
            <strong>
              {dateLabel(dayAt(state.planning.startedAt), {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </strong>
            <small>
              {observedDays} observed {observedDays === 1 ? "day" : "days"} in
              this window
            </small>
          </span>
        </div>
      </section>
      <div className="insight-metric-grid">
        <Metric
          icon={<Layers3 size={15} />}
          label="Open stories"
          value={unfinished.length}
          note="Current project scope"
        />
        <Metric
          icon={<CheckCheck size={15} />}
          label="Done transitions"
          value={completed}
          note="Recorded in the last 28 days"
        />
        <Metric
          icon={<Workflow size={15} />}
          label="Active workers"
          value={active.length}
          note="Actual running or preparing sessions"
        />
        <Metric
          icon={<Flag size={15} />}
          label="Unestimated stories"
          value={unestimated}
          note="Open work without a point estimate"
        />
      </div>
      <div className="insights-primary-grid">
        <section className="planning-chart-card throughput-card">
          <header>
            <span className="planning-chart-icon mint">
              <ChartNoAxesCombined size={18} />
            </span>
            <div>
              <h3>Delivery throughput</h3>
              <p>Daily accepted-work transitions over the last 28 days.</p>
            </div>
            <UnitToggle unit={unit} setUnit={setUnit} />
          </header>
          <ThroughputChart data={deliveries} unit={unit} />
          <p className="planning-chart-note">
            Only recorded transitions into Done count here. Earlier baseline
            completions are excluded; reopened stories can produce another
            transition.
          </p>
        </section>
        <section className="insight-status-card">
          <header>
            <span className="planning-chart-icon cyan">
              <Activity size={18} />
            </span>
            <div>
              <h3>The board, right now</h3>
              <p>Current core workflow stages.</p>
            </div>
          </header>
          <div className="insight-status-total">
            <strong>{tasks.length}</strong>
            <span>
              {tasks.length === 1 ? "story" : "stories"} in the project
            </span>
          </div>
          <div
            className="insight-stacked-status"
            aria-label={stages
              .map(
                (stage) =>
                  `${stageLabel(stage)}: ${tasks.filter((task) => task.stage === stage).length}`,
              )
              .join(", ")}
          >
            {stages.map((stage) => {
              const count = tasks.filter((task) => task.stage === stage).length;
              return (
                count > 0 && (
                  <i
                    key={stage}
                    style={{
                      width: `${(count / Math.max(1, tasks.length)) * 100}%`,
                      background: stageColors[stage],
                    }}
                  />
                )
              );
            })}
          </div>
          <div className="insight-status-list">
            {stages.map((stage) => (
              <div key={stage}>
                <StageIcon stage={stage} />
                <span>{stageLabel(stage)}</span>
                <strong>
                  {tasks.filter((task) => task.stage === stage).length}
                </strong>
                <small>
                  {tasks.length
                    ? Math.round(
                        (tasks.filter((task) => task.stage === stage).length /
                          tasks.length) *
                          100,
                      )
                    : 0}
                  %
                </small>
              </div>
            ))}
          </div>
          <p className="planning-chart-note">
            A current inventory snapshot, including work completed before
            tracking began.
          </p>
        </section>
      </div>
      <section className={"insight-forecast " + (forecast ? "available" : "")}>
        <span className="forecast-icon">
          <TrendingUp size={22} />
        </span>
        <div>
          <span className="planning-kicker">DELIVERY FORECAST</span>
          <h3>
            {forecast
              ? `At the observed pace, around ${dateLabel(forecast.date, { day: "numeric", month: "short", year: "numeric" })}.`
              : "A forecast needs a little more real history."}
          </h3>
          <p>
            {forecast
              ? `${unfinished.length} open stories at ${countLabel(forecast.pace)} recorded Done transitions per calendar day. Scope and future pace may change.`
              : "It appears after at least 7 observed days and 5 Done transitions spread across 3 days. New history builds the evidence; existing completed work is not backdated."}
          </p>
        </div>
        {forecast ? (
          <span className="forecast-days">
            <strong>{forecast.days}</strong>
            <small>calendar days</small>
          </span>
        ) : (
          <span className="forecast-evidence">
            Building evidence
            <ArrowUpRight size={13} />
          </span>
        )}
      </section>
      <div className="insight-breakdown-grid">
        <EpicBreakdown
          state={state}
          project={project}
          tasks={tasks}
          open={open}
        />
        <LabelBreakdown tasks={tasks} />
        <AssignmentBreakdown tasks={unfinished} />
      </div>
      <div className="insights-cycle-heading">
        <div>
          <span className="planning-kicker">ITERATION PROGRESS</span>
          <h2>{current ? current.name : "Give the next iteration a cycle."}</h2>
          <p>
            {current
              ? "The same recorded scope and progress available in the cycle view."
              : "Create a cycle and assign stories to start observing scope and progress."}
          </p>
        </div>
        {cycles.length > 0 && (
          <Select
            aria-label="Insights cycle"
            value={current?.id ?? "active"}
            onValueChange={setCycleId}
          >
            {cycles.map((cycle) => (
              <option key={cycle.id} value={cycle.id}>
                {cycle.name}
                {cycle.state === "active"
                  ? " · active"
                  : cycle.state === "completed"
                    ? " · completed"
                    : ""}
              </option>
            ))}
          </Select>
        )}
      </div>
      {current ? (
        <CycleCharts cycle={current} unit={unit} />
      ) : (
        <div className="insights-cycle-empty">
          <CalendarDays size={26} />
          <div>
            <h3>Progress belongs to a real cycle.</h3>
            <p>
              Set up the dates and scope in Cycles. Charts use recorded
              snapshots, with unknown history left as gaps.
            </p>
          </div>
        </div>
      )}
      <div className="planning-estimate-note">
        <GitBranch size={13} />
        <span>
          Story points are manual estimates for planning. Memtrace’s measured
          source complexity and blast radius guide model routing in each work
          item.
        </span>
      </div>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  note,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  note: string;
}) {
  return (
    <article>
      <span>
        {icon}
        {label}
      </span>
      <strong>{countLabel(value)}</strong>
      <p>{note}</p>
    </article>
  );
}

function EpicBreakdown({
  state,
  project,
  tasks,
  open,
}: {
  state: AppState;
  project: Project;
  tasks: WorkItem[];
  open: (task: WorkItem) => void;
}) {
  const groups = state.epics
    .filter((epic) => epic.projectId === project.id)
    .map((epic) => ({
      epic,
      tasks: tasks.filter((task) => task.epicId === epic.id),
    }))
    .filter((group) => group.tasks.length)
    .sort(
      (a, b) =>
        b.tasks.filter((task) => task.stage !== "done").length -
        a.tasks.filter((task) => task.stage !== "done").length,
    );
  return (
    <section className="insight-breakdown-card">
      <header>
        <Flag size={16} />
        <h3>Epic progress</h3>
        <span>{groups.length}</span>
      </header>
      {groups.length ? (
        <div className="insight-epic-rows">
          {groups.map(({ epic, tasks: items }) => {
            const done = items.filter((task) => task.stage === "done").length;
            return (
              <details key={epic.id}>
                <summary>
                  <span>
                    <small>{epic.identifier}</small>
                    <strong>{epic.title}</strong>
                  </span>
                  <b>
                    {done}
                    <small>/{items.length}</small>
                  </b>
                  <i>
                    <em style={{ width: `${(done / items.length) * 100}%` }} />
                  </i>
                </summary>
                <div>
                  {items
                    .filter((task) => task.stage !== "done")
                    .slice(0, 5)
                    .map((task) => (
                      <button key={task.id} onClick={() => open(task)}>
                        <StageIcon stage={task.stage} />
                        <span>{task.title}</span>
                        <ArrowUpRight size={11} />
                      </button>
                    ))}
                  {items.every((task) => task.stage === "done") && (
                    <p>All current stories are complete.</p>
                  )}
                  {items.filter((task) => task.stage !== "done").length > 5 && (
                    <p>
                      Plus{" "}
                      {items.filter((task) => task.stage !== "done").length - 5}{" "}
                      open stories in this epic.
                    </p>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      ) : (
        <div className="insight-breakdown-empty">
          <Flag size={23} />
          <p>Group stories into epics to see their progress here.</p>
        </div>
      )}
    </section>
  );
}

function LabelBreakdown({ tasks }: { tasks: WorkItem[] }) {
  const labels = [...new Set(tasks.flatMap((task) => task.labels ?? []))]
    .map((label) => ({
      label,
      total: tasks.filter((task) => task.labels?.includes(label)).length,
      open: tasks.filter(
        (task) => task.labels?.includes(label) && task.stage !== "done",
      ).length,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 9);
  const max = Math.max(1, ...labels.map((label) => label.total));
  return (
    <section className="insight-breakdown-card">
      <header>
        <Tag size={16} />
        <h3>Work by label</h3>
        <span>{labels.length}</span>
      </header>
      {labels.length ? (
        <div className="insight-label-rows">
          {labels.map((item) => (
            <div key={item.label}>
              <span>
                <i />
                {item.label}
                <strong>{item.total}</strong>
              </span>
              <div>
                <i style={{ width: `${(item.total / max) * 100}%` }} />
              </div>
              <small>{item.open} open</small>
            </div>
          ))}
          <p>A story can have more than one label.</p>
        </div>
      ) : (
        <div className="insight-breakdown-empty">
          <Tag size={23} />
          <p>Add labels to your stories to see how the work is distributed.</p>
        </div>
      )}
    </section>
  );
}

function AssignmentBreakdown({ tasks }: { tasks: WorkItem[] }) {
  const rows = [
    {
      id: "auto",
      name: "Automatic",
      count: tasks.filter((task) => task.assignment === "auto" && !task.route)
        .length,
    },
    ...(["codex", "claude", "cursor", "copilot", "dsh"] as const).map((id) => ({
      id,
      name: harnessNames[id],
      count: tasks.filter(
        (task) =>
          !(task.assignment === "auto" && !task.route) && task.harness === id,
      ).length,
    })),
  ];
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="insight-breakdown-card">
      <header>
        <Workflow size={16} />
        <h3>Open work by assignment</h3>
      </header>
      <div className="insight-assignment-rows">
        {rows.map((row) => (
          <div key={row.id}>
            <span>
              {row.id === "auto" ? (
                <span className="assignment-auto-mark">
                  <Layers3 size={12} />
                </span>
              ) : (
                <HarnessMark
                  id={row.id as "codex" | "claude" | "cursor" | "copilot" | "dsh"}
                  small
                />
              )}
              <strong>{row.name}</strong>
              <b>{row.count}</b>
            </span>
            <div>
              <i style={{ width: `${(row.count / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="planning-chart-note">
        Assigned or routed open stories. This is workload, not a provider
        performance ranking.
      </p>
    </section>
  );
}
