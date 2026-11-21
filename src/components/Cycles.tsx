import { CycleForm, FinishCycle, AddCycleWork } from "./CycleDialogs";
import { CycleStories } from "./CycleStories";
import { DeleteAction } from "./DeleteAction";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  CheckCheck,
  Clock3,
  Layers3,
  Play,
  Plus,
  Settings2,
  Target,
} from "lucide-react";
import type { AppState, Cycle, Project, WorkItem } from "../shared";
import { dateLabel, dayAt, daysBetween } from "../planning/dates";
import { cycleSnapshot } from "../planning/history";
import { isActive } from "../domain";
import { Spinner } from "./UI";
import {
  CycleCharts,
  countLabel,
  UnitToggle,
  type PlanningUnit,
} from "./PlanningCharts";

interface Props {
  state: AppState;
  project: Project;
  open: (task: WorkItem) => void;
  notify: (message: string) => void;
}
const stateNames = {
  planned: "Upcoming",
  active: "Active",
  completed: "Completed",
};
const dateRange = (cycle: Cycle) =>
  `${dateLabel(cycle.startDate)} — ${dateLabel(cycle.endDate, { month: "short", day: "numeric", year: "numeric" })}`;

export function Cycles({ state, project, open, notify }: Props) {
  const cycles = state.cycles.filter((cycle) => cycle.projectId === project.id);
  const fallback =
    cycles.find((cycle) => cycle.state === "active") ??
    cycles
      .filter((cycle) => cycle.state === "planned")
      .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ??
    cycles
      .filter((cycle) => cycle.state === "completed")
      .sort((a, b) =>
        (b.completedAt ?? b.endDate).localeCompare(a.completedAt ?? a.endDate),
      )[0];
  const [selectedId, setSelectedId] = useState<string | undefined>(
      fallback?.id,
    ),
    [form, setForm] = useState<"new" | Cycle | null>(null),
    [finish, setFinish] = useState<Cycle | null>(null),
    [addWork, setAddWork] = useState(false),
    [busy, setBusy] = useState(false),
    [unit, setUnit] = useState<PlanningUnit>("issues");
  useEffect(() => {
    setSelectedId(undefined);
    setForm(null);
    setFinish(null);
    setAddWork(false);
  }, [project.id]);
  const selected = cycles.find((cycle) => cycle.id === selectedId) ?? fallback;
  const start = async (cycle: Cycle) => {
    setBusy(true);
    try {
      await window.memcode.startCycle(cycle.id);
      notify("Cycle started. Its starting scope is now the planning baseline.");
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const otherActive = cycles.some(
    (cycle) => cycle.state === "active" && cycle.id !== selected?.id,
  );
  return (
    <div className="cycles-view">
      {!cycles.length ? (
        <div className="cycles-onboarding">
          <section className="cycle-intro-hero">
            <div className="cycle-intro-grid" />
            <span className="planning-kicker">
              <CalendarDays size={13} />A RHYTHM FOR THE WORK
            </span>
            <h2>
              Give the next iteration
              <br />
              <em>a clear finish line.</em>
            </h2>
            <p>
              A cycle brings the tasks, the focus and the time together. Plan
              the scope, track real progress, and carry the unfinished work
              forward deliberately.
            </p>
            <button
              className="button cycle-hero-action"
              onClick={() => setForm("new")}
            >
              <Plus size={14} />
              Create your first cycle
              <ArrowRight size={13} />
            </button>
          </section>
          <div className="cycle-onboarding-steps">
            <article>
              <span>01</span>
              <Layers3 size={20} />
              <h3>Choose the scope.</h3>
              <p>
                Gather focused tasks from any goal. Keep estimates and
                capacity visible.
              </p>
            </article>
            <article>
              <span>02</span>
              <Target size={20} />
              <h3>Follow the actual work.</h3>
              <p>
                Burndown and burnup reflect recorded changes, with the ideal
                plan shown separately.
              </p>
            </article>
            <article>
              <span>03</span>
              <CheckCheck size={20} />
              <h3>Finish with intention.</h3>
              <p>
                Review what shipped, then choose what to carry into the next
                cycle.
              </p>
            </article>
          </div>
        </div>
      ) : (
        <>
          <div className="cycles-overview-toolbar">
            <div>
              <span className="planning-kicker">YOUR PROJECT RHYTHM</span>
              <p>
                {cycles.filter((cycle) => cycle.state === "active").length}{" "}
                active<span>·</span>
                {
                  cycles.filter((cycle) => cycle.state === "planned").length
                }{" "}
                upcoming<span>·</span>
                {
                  cycles.filter((cycle) => cycle.state === "completed").length
                }{" "}
                completed
              </p>
            </div>
            <button className="button secondary" onClick={() => setForm("new")}>
              <Plus size={13} />
              New cycle
            </button>
          </div>
          <div className="cycles-layout">
            <aside className="cycle-rail" aria-label="Project cycles">
              {(["active", "planned", "completed"] as const).map((status) => {
                const group = cycles
                  .filter((cycle) => cycle.state === status)
                  .sort((a, b) =>
                    status === "completed"
                      ? b.endDate.localeCompare(a.endDate)
                      : a.startDate.localeCompare(b.startDate),
                  );
                if (!group.length) return null;
                return (
                  <section key={status}>
                    <h3>
                      {stateNames[status]}
                      <span>{group.length}</span>
                    </h3>
                    {group.map((cycle) => {
                      const snapshot =
                        cycle.state === "completed"
                          ? cycle.snapshots.at(-1)
                          : cycleSnapshot(state, cycle.id);
                      const completed = snapshot?.completed ?? 0,
                        total = snapshot?.total ?? 0;
                      return (
                        <button
                          className={
                            "cycle-rail-item " +
                            (selected?.id === cycle.id ? "selected" : "")
                          }
                          key={cycle.id}
                          onClick={() => setSelectedId(cycle.id)}
                          aria-current={
                            selected?.id === cycle.id ? "page" : undefined
                          }
                        >
                          <span className={"cycle-status-dot " + status} />
                          <div>
                            <strong>{cycle.name}</strong>
                            <small>
                              {dateLabel(cycle.startDate)} —{" "}
                              {dateLabel(cycle.endDate)}
                            </small>
                            <span className="cycle-mini-progress">
                              <i
                                style={{
                                  width: total
                                    ? `${(completed / total) * 100}%`
                                    : "0%",
                                }}
                              />
                            </span>
                          </div>
                          <span className="cycle-rail-count">
                            {completed}
                            <small>/{total}</small>
                          </span>
                        </button>
                      );
                    })}
                  </section>
                );
              })}
            </aside>
            {selected && (
              <div className="cycle-detail" key={selected.id}>
                <CycleHeader
                  cycle={selected}
                  state={state}
                  busy={busy}
                  otherActive={otherActive}
                  edit={() => setForm(selected)}
                  start={() => void start(selected)}
                  finish={() => setFinish(selected)}
                />
                <div className="cycle-chart-toolbar">
                  <div>
                    <h3>Scope and progress</h3>
                    <p>
                      {selected.state === "completed"
                        ? "A frozen record of this cycle at completion."
                        : "Every change to the cycle is reflected in its recorded history."}
                    </p>
                  </div>
                  <UnitToggle unit={unit} setUnit={setUnit} />
                </div>
                <CycleCharts cycle={selected} unit={unit} />
                <div className="planning-estimate-note">
                  <Layers3 size={13} />
                  <span>
                    Points are manual planning estimates. Memtrace
                    complexity, nesting and blast radius inform model routing
                    separately.
                  </span>
                </div>
                <CycleStories
                  state={state}
                  cycle={selected}
                  open={open}
                  add={() => setAddWork(true)}
                  notify={notify}
                />
              </div>
            )}
          </div>
        </>
      )}
      {form && (
        <CycleForm
          project={project}
          cycle={form === "new" ? undefined : form}
          count={cycles.length}
          close={() => setForm(null)}
          saved={(cycle) => {
            if (cycle) setSelectedId(cycle.id);
            setForm(null);
          }}
          notify={notify}
        />
      )}
      {finish && (
        <FinishCycle
          state={state}
          cycle={finish}
          close={() => setFinish(null)}
          notify={notify}
        />
      )}
      {addWork && selected && (
        <AddCycleWork
          state={state}
          cycle={selected}
          close={() => setAddWork(false)}
          notify={notify}
        />
      )}
    </div>
  );
}

function CycleHeader({
  cycle,
  state,
  busy,
  otherActive,
  edit,
  start,
  finish,
}: {
  cycle: Cycle;
  state: AppState;
  busy: boolean;
  otherActive: boolean;
  edit: () => void;
  start: () => void;
  finish: () => void;
}) {
  const snapshot =
    cycle.state === "completed"
      ? (cycle.snapshots.at(-1) ?? cycleSnapshot(state, cycle.id))
      : cycleSnapshot(state, cycle.id);
  const left = Math.max(0, snapshot.total - snapshot.completed),
    growth = cycle.baseline ? snapshot.total - cycle.baseline.total : null;
  const daysLeft = daysBetween(dayAt(undefined, cycle.timeZone), cycle.endDate);
  const workers = state.tasks.filter(
    (task) => task.cycleId === cycle.id && isActive(task),
  ).length;
  const capacity = cycle.capacity,
    over = capacity !== null ? snapshot.points - capacity : 0;
  return (
    <>
      <section className="cycle-detail-heading">
        <div className="cycle-heading-top">
          <span className={"cycle-state-pill " + cycle.state}>
            <span />
            {cycle.state === "planned"
              ? "Upcoming"
              : cycle.state === "active"
                ? "Active cycle"
                : "Completed cycle"}
          </span>
          <div className="cycle-heading-actions">
            <DeleteAction
              compact
              kind="cycle"
              id={cycle.id}
              name={cycle.name}
              disabled={workers > 0}
            />
            {cycle.state !== "completed" && (
              <button
                className="icon-button"
                title="Edit cycle"
                aria-label="Edit cycle"
                onClick={edit}
              >
                <Settings2 size={15} />
              </button>
            )}
            {cycle.state === "planned" && (
              <button
                className="button primary"
                onClick={start}
                disabled={busy || otherActive}
                title={
                  otherActive
                    ? "Finish the current active cycle first."
                    : undefined
                }
              >
                {busy ? <Spinner size={13} /> : <Play size={11} />}Start cycle
              </button>
            )}
            {cycle.state === "active" && (
              <button
                className="button primary"
                onClick={finish}
                disabled={workers > 0}
                title={
                  workers
                    ? "Stop the cycle’s active workers before finishing."
                    : undefined
                }
              >
                <CheckCheck size={14} />
                Finish cycle
              </button>
            )}
          </div>
        </div>
        <h2>{cycle.name}</h2>
        <p className="cycle-goal">
          {cycle.goal ||
            "A focused iteration. Add a focus to make the outcome clear."}
        </p>
        <div className="cycle-metadata">
          <span>
            <CalendarDays size={13} />
            {dateRange(cycle)}
          </span>
          <span>
            <Clock3 size={13} />
            {cycle.timeZone}
          </span>
          <span>
            {cycle.calendar === "weekdays"
              ? "Weekday plan"
              : "Calendar-day plan"}
          </span>
          {cycle.state === "active" && (
            <span className={daysLeft < 0 ? "cycle-overdue" : ""}>
              {daysLeft === 0
                ? "Ends today"
                : daysLeft > 0
                  ? `${daysLeft} ${daysLeft === 1 ? "day" : "days"} remaining`
                  : `${Math.abs(daysLeft)} days past planned end`}
            </span>
          )}
        </div>
        {workers > 0 && (
          <div className="cycle-context-message">
            {workers} {workers === 1 ? "worker is" : "workers are"} active. Stop
            or finish that work before closing the cycle.
          </div>
        )}
        {otherActive && cycle.state === "planned" && (
          <div className="cycle-context-message">
            Finish the project’s current active cycle before starting this one.
          </div>
        )}
      </section>
      <div className="cycle-stat-grid">
        <div>
          <span>Tasks complete</span>
          <strong>
            {snapshot.completed}
            <small>/ {snapshot.total}</small>
          </strong>
          <p>
            {snapshot.total
              ? Math.round((snapshot.completed / snapshot.total) * 100)
              : 0}
            % of the recorded scope
          </p>
        </div>
        <div>
          <span>Remaining</span>
          <strong>{left}</strong>
          <p>{snapshot.working + snapshot.review} in progress or review</p>
        </div>
        <div>
          <span>Estimated points</span>
          <strong>
            {countLabel(snapshot.points)}
            {capacity !== null && <small>/ {countLabel(capacity)}</small>}
          </strong>
          <p className={over > 0 ? "over-capacity" : ""}>
            {capacity === null
              ? "Capacity has not been set"
              : over > 0
                ? `${countLabel(over)} points over capacity`
                : `${countLabel(Math.max(0, capacity - snapshot.points))} points of capacity available`}
          </p>
        </div>
        <div>
          <span>Scope change</span>
          <strong>
            {growth === null ? "—" : `${growth > 0 ? "+" : ""}${growth}`}
          </strong>
          <p>
            {cycle.baseline
              ? "Tasks since the starting baseline"
              : "Baseline captured when the cycle starts"}
          </p>
        </div>
      </div>
      {snapshot.unestimated > 0 && (
        <p className="cycle-unestimated">
          <span />
          {snapshot.unestimated}{" "}
          {snapshot.unestimated === 1 ? "task has" : "tasks have"} no
          estimate. Point totals include estimated tasks only.
        </p>
      )}
    </>
  );
}
