import { useState } from "react";
import { Check, CheckCheck, Clock3, Layers3, Plus, Search } from "lucide-react";
import type { AppState, Cycle, CreateCycle, Project } from "../shared";
import { addDays, dayAt } from "../planning/dates";
import { isActive } from "../domain";
import { Modal } from "./Dialogs";
import { Select } from "./Select";
import { Spinner, StageIcon } from "./UI";
import { countLabel } from "./PlanningCharts";

export function CycleForm({
  project,
  cycle,
  count,
  close,
  saved,
  notify,
}: {
  project: Project;
  cycle?: Cycle;
  count: number;
  close: () => void;
  saved: (cycle?: Cycle) => void;
  notify: (message: string) => void;
}) {
  const today = dayAt();
  const [name, setName] = useState(
      cycle?.name ?? `Cycle ${String(count + 1).padStart(2, "0")}`,
    ),
    [goal, setGoal] = useState(cycle?.goal ?? ""),
    [startDate, setStartDate] = useState(cycle?.startDate ?? today),
    [endDate, setEndDate] = useState(cycle?.endDate ?? addDays(today, 13)),
    [timeZone, setTimeZone] = useState(
      cycle?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    [calendar, setCalendar] = useState<Cycle["calendar"]>(
      cycle?.calendar ?? "weekdays",
    ),
    [capacity, setCapacity] = useState(
      cycle?.capacity === null || cycle?.capacity === undefined
        ? ""
        : String(cycle.capacity),
    ),
    [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const input: CreateCycle = {
        projectId: project.id,
        name: name.trim(),
        goal: goal.trim(),
        startDate,
        endDate,
        timeZone,
        calendar,
        capacity: capacity.trim() === "" ? null : Number(capacity),
      };
      if (cycle) {
        const { projectId, ...patch } = input;
        await window.memcode.updateCycle(cycle.id, patch);
        saved();
      } else saved(await window.memcode.createCycle(input));
    } catch (error) {
      notify((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={cycle ? "Shape this cycle." : "A clear window for focused work."}
      kicker={cycle ? "EDIT CYCLE" : "NEW CYCLE"}
      description="Choose the focus and the time. Add tasks when you’re ready."
      close={close}
    >
      <form onSubmit={submit}>
        <div className="modal-body cycle-form">
          <label className="field">
            <span>Cycle name</span>
            <input
              aria-label="Cycle name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={160}
              autoFocus
              required
            />
          </label>
          <label className="field">
            <span>Focus</span>
            <textarea
              aria-label="Cycle focus"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="What should be meaningfully better by the end?"
              maxLength={10000}
            />
          </label>
          <div className="form-row">
            <label className="field">
              <span>Start date</span>
              <input
                aria-label="Cycle start date"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>End date</span>
              <input
                aria-label="Cycle end date"
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                min={startDate}
                required
              />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span>
                Capacity <small>Optional points</small>
              </span>
              <input
                aria-label="Cycle capacity"
                type="number"
                min="0"
                step="any"
                value={capacity}
                onChange={(event) => setCapacity(event.target.value)}
                placeholder="Not set"
              />
            </label>
            <label className="field">
              <span>Ideal-plan calendar</span>
              <Select
                aria-label="Cycle calendar"
                value={calendar}
                onValueChange={(value) =>
                  setCalendar(value as Cycle["calendar"])
                }
              >
                <option value="weekdays">Weekdays · Monday to Friday</option>
                <option value="calendar">Every calendar day</option>
              </Select>
            </label>
          </div>
          <label className="field">
            <span>Time zone</span>
            <input
              aria-label="Cycle time zone"
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              placeholder="Europe/Copenhagen"
              required
            />
          </label>
          <div className="cycle-form-note">
            <Clock3 size={13} />
            <p>
              Dates and daily progress use this time zone. Capacity is a
              planning estimate; it does not determine an agent’s model.
            </p>
          </div>
        </div>
        <footer className="modal-footer">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={!name.trim() || busy}
          >
            {busy ? (
              <Spinner size={13} />
            ) : cycle ? (
              <Check size={13} />
            ) : (
              <Plus size={13} />
            )}{" "}
            {cycle ? "Save cycle" : "Create cycle"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function FinishCycle({
  state,
  cycle,
  close,
  notify,
}: {
  state: AppState;
  cycle: Cycle;
  close: () => void;
  notify: (message: string) => void;
}) {
  const unfinished = state.tasks.filter(
    (task) =>
      task.cycleId === cycle.id && task.stage !== "done" && !task.archivedAt,
  );
  const activeWorkers = state.tasks.filter(
    (task) => task.cycleId === cycle.id && isActive(task),
  ).length;
  const destinations = state.cycles.filter(
    (other) =>
      other.projectId === cycle.projectId &&
      other.id !== cycle.id &&
      other.state !== "completed",
  );
  const [choice, setChoice] = useState("keep"),
    [target, setTarget] = useState("backlog"),
    [busy, setBusy] = useState(false);
  const complete = async () => {
    setBusy(true);
    try {
      const result = await window.memcode.completeCycle(
        cycle.id,
        choice === "keep" ? undefined : target === "backlog" ? null : target,
      );
      notify(
        result.moved
          ? `Cycle completed. ${result.moved} ${result.moved === 1 ? "task moved" : "tasks moved"} ${target === "backlog" ? "to the backlog" : "to the selected cycle"}.`
          : "Cycle completed. Its progress record is frozen.",
      );
      close();
    } catch (error) {
      notify((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Finish the cycle with a clear next step."
      kicker="COMPLETE CYCLE"
      description={cycle.name}
      close={close}
    >
      <div className="modal-body finish-cycle-body">
        <div className="cycle-finish-summary">
          <CheckCheck size={24} />
          <div>
            <strong>
              {unfinished.length
                ? `${unfinished.length} unfinished ${unfinished.length === 1 ? "task" : "tasks"}`
                : "All assigned tasks are complete."}
            </strong>
            <p>The completion snapshot is captured before any work moves.</p>
          </div>
        </div>
        {unfinished.length > 0 && (
          <fieldset className="cycle-finish-options">
            <legend>What happens to unfinished work?</legend>
            <label className={choice === "keep" ? "selected" : ""}>
              <input
                type="radio"
                name="carryover"
                value="keep"
                checked={choice === "keep"}
                onChange={() => setChoice("keep")}
              />
              <span>
                <strong>Keep it in this cycle</strong>
                <small>
                  Close the cycle with its unfinished work still assigned.
                </small>
              </span>
            </label>
            <label className={choice === "move" ? "selected" : ""}>
              <input
                type="radio"
                name="carryover"
                value="move"
                checked={choice === "move"}
                onChange={() => setChoice("move")}
              />
              <span>
                <strong>Carry it forward</strong>
                <small>
                  Move unfinished tasks to another cycle or the backlog.
                </small>
              </span>
            </label>
            {choice === "move" && (
              <label className="field cycle-destination">
                <span>Destination</span>
                <Select
                  aria-label="Carryover destination"
                  value={target}
                  onValueChange={setTarget}
                >
                  <option value="backlog">No cycle</option>
                  {destinations.map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </fieldset>
        )}
        <p className="cycle-form-note">
          This closes the planning cycle. It does not accept changes or start
          workers.
        </p>
        {activeWorkers > 0 && (
          <p className="cycle-context-message">
            Stop the cycle’s active workers before closing it.
          </p>
        )}
      </div>
      <footer className="modal-footer">
        <button className="button secondary" onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          onClick={() => void complete()}
          disabled={busy || activeWorkers > 0}
        >
          {busy ? <Spinner size={13} /> : <CheckCheck size={13} />}Complete
          cycle
        </button>
      </footer>
    </Modal>
  );
}

export function AddCycleWork({
  state,
  cycle,
  close,
  notify,
}: {
  state: AppState;
  cycle: Cycle;
  close: () => void;
  notify: (message: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false);
  const candidates = state.tasks.filter(
    (task) =>
      task.projectId === cycle.projectId &&
      !task.archivedAt &&
      task.cycleId !== cycle.id &&
      !state.cycles.some(
        (other) => other.id === task.cycleId && other.state === "completed",
      ),
  );
  const filtered = candidates.filter((task) =>
    `${task.identifier} ${task.title}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const submit = async () => {
    if (!selected.size) return;
    setBusy(true);
    try {
      await window.memcode.bulkUpdateTasks([...selected], {
        cycleId: cycle.id,
      });
      notify(
        `${selected.size} ${selected.size === 1 ? "task added" : "tasks added"} to ${cycle.name}.`,
      );
      close();
    } catch (error) {
      notify((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Choose the work for this cycle."
      kicker="ADD TASKS"
      description={cycle.name}
      close={close}
      wide
    >
      <div className="modal-body cycle-picker-body">
        <label className="cycle-picker-search">
          <Search size={15} />
          <input
            aria-label="Search cycle tasks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tasks by title or identifier…"
            autoFocus
          />
        </label>
        <div className="cycle-story-picker">
          {filtered.map((task) => {
            const source = state.cycles.find(
              (other) => other.id === task.cycleId,
            );
            return (
              <label
                key={task.id}
                className={selected.has(task.id) ? "selected" : ""}
              >
                <input
                  type="checkbox"
                  aria-label={`Add ${task.identifier} to cycle`}
                  checked={selected.has(task.id)}
                  disabled={isActive(task)}
                  onChange={() => toggle(task.id)}
                />
                <StageIcon stage={task.stage} />
                <span>
                  <small>
                    {task.identifier}
                    {source && <em>From {source.name}</em>}
                  </small>
                  <strong>{task.title}</strong>
                </span>
                <span className="cycle-picker-estimate">
                  {task.estimate === null || task.estimate === undefined
                    ? "Unestimated"
                    : `${countLabel(task.estimate)} pts`}
                </span>
                {isActive(task) && (
                  <span className="cycle-picker-running">Running</span>
                )}
              </label>
            );
          })}
          {!filtered.length && (
            <div className="cycle-picker-empty">
              <Layers3 size={23} />
              <p>
                {query
                  ? "No tasks match this search."
                  : "All available tasks are already assigned, archived, or in a completed cycle."}
              </p>
            </div>
          )}
        </div>
        <div className="cycle-form-note">
          <Layers3 size={13} />
          <p>
            Selected tasks move into this cycle. Their goals keep their work.
            Planning a cycle never starts a worker.
          </p>
        </div>
      </div>
      <footer className="modal-footer">
        <span>{selected.size} selected</span>
        <button
          className="button primary"
          disabled={!selected.size || busy}
          onClick={() => void submit()}
        >
          {busy ? <Spinner size={13} /> : <Plus size={13} />}Add{" "}
          {selected.size || ""} {selected.size === 1 ? "task" : "tasks"}
        </button>
      </footer>
    </Modal>
  );
}
