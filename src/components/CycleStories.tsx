import { useState } from "react";
import { ArrowRight, ArrowUpRight, Layers3, Plus, X } from "lucide-react";
import type { AppState, Cycle, WorkItem } from "../shared";
import { isActive } from "../domain";
import { taskStatus, workflowFor } from "../planning/workflow";
import { storyReadiness } from "../planning/readiness";
import type { WorkflowState } from "../planning/types";
import { Spinner, StageIcon, WorkerMark } from "./UI";
import { countLabel } from "./PlanningCharts";

export function CycleStories({
  state,
  cycle,
  open,
  add,
  notify,
}: {
  state: AppState;
  cycle: Cycle;
  open: (task: WorkItem) => void;
  add: () => void;
  notify: (message: string) => void;
}) {
  const projectTasks = state.tasks.filter(
    (item) => item.projectId === cycle.projectId,
  );
  const workflow = workflowFor(state, cycle.projectId);
  const tasks = projectTasks.filter(
    (task) =>
      task.cycleId === cycle.id && (!task.archivedAt || task.stage === "done"),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false);
  const selectedTasks = tasks.filter(
    (task) => selected.has(task.id) && !isActive(task),
  );
  const remove = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      await window.memcode.bulkUpdateTasks(ids, { cycleId: null });
      setSelected(new Set());
      notify(
        `${ids.length} ${ids.length === 1 ? "task moved" : "tasks moved"} to the backlog.`,
      );
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const carried = new Set(
    state.planning.events
      .filter(
        (event) =>
          cycle.completedAt &&
          event.at === cycle.completedAt &&
          event.before?.cycleId === cycle.id &&
          event.after.cycleId !== cycle.id,
      )
      .map((event) => event.taskId),
  );
  return (
    <section className="cycle-story-section">
      <header>
        <div>
          <h3>
            Tasks in this cycle<span>{tasks.length}</span>
          </h3>
          <p>
            {cycle.state === "completed"
              ? "Current membership; completion metrics above preserve the closing snapshot."
              : "Keep the scope focused and the next step clear."}
          </p>
        </div>
        {cycle.state !== "completed" && (
          <button className="button secondary" onClick={add}>
            <Plus size={13} />
            Add tasks
          </button>
        )}
      </header>
      {tasks.length ? (
        <div className="cycle-story-table-wrap">
          <table className="cycle-story-table">
            <thead>
              <tr>
                {cycle.state !== "completed" && (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all cycle tasks"
                      checked={
                        tasks.some((task) => !isActive(task)) &&
                        tasks
                          .filter((task) => !isActive(task))
                          .every((task) => selected.has(task.id))
                      }
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? new Set(
                                tasks
                                  .filter((task) => !isActive(task))
                                  .map((task) => task.id),
                              )
                            : new Set(),
                        )
                      }
                    />
                  </th>
                )}
                <th>Task</th>
                <th>Status</th>
                {cycle.state !== "completed" && <th>Readiness</th>}
                <th>Estimate</th>
                <th>Worker</th>
                {cycle.state !== "completed" && <th />}
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  {cycle.state !== "completed" && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${task.identifier}`}
                        checked={selected.has(task.id)}
                        disabled={isActive(task)}
                        onChange={() => toggle(task.id)}
                      />
                    </td>
                  )}
                  <td>
                    <button
                      className="cycle-story-link"
                      onClick={() => open(task)}
                    >
                      <span>{task.identifier}</span>
                      <strong>{task.title}</strong>
                      <ArrowUpRight size={12} />
                    </button>
                  </td>
                  <td>
                    <span className="cycle-story-status">
                      <StageIcon stage={task.stage} />
                      {taskStatus(task, workflow).name}
                    </span>
                  </td>
                  {cycle.state !== "completed" && (
                    <td>
                      <CycleReadiness
                        task={task}
                        projectTasks={projectTasks}
                        workflow={workflow}
                        open={open}
                      />
                    </td>
                  )}
                  <td>
                    <span
                      className={
                        task.estimate === null || task.estimate === undefined
                          ? "unestimated"
                          : ""
                      }
                    >
                      {task.estimate === null || task.estimate === undefined
                        ? "—"
                        : countLabel(task.estimate)}
                    </span>
                  </td>
                  <td>
                    <span className="cycle-story-worker">
                      <WorkerMark task={task} small />
                      <small>
                        {task.assignment === "auto" && !task.route
                          ? "Auto"
                          : task.harness === "claude"
                            ? "Claude"
                            : task.harness === "cursor"
                              ? "Cursor"
                              : "Codex"}
                      </small>
                    </span>
                  </td>
                  {cycle.state !== "completed" && (
                    <td>
                      <button
                        className="icon-button"
                        title={`Remove ${task.identifier} from cycle`}
                        aria-label={`Remove ${task.identifier} from cycle`}
                        disabled={busy || isActive(task)}
                        onClick={() => void remove([task.id])}
                      >
                        <X size={12} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {selectedTasks.length > 0 && (
            <div className="cycle-selection-bar">
              <span>{selectedTasks.length} selected</span>
              <button
                disabled={busy}
                onClick={() =>
                  void remove(selectedTasks.map((task) => task.id))
                }
              >
                {busy ? <Spinner size={12} /> : <ArrowRight size={12} />}Move to
                backlog
              </button>
              <button onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}
        </div>
      ) : (
        <div className="cycle-no-stories">
          <Layers3 size={23} />
          <strong>
            {cycle.state === "completed"
              ? "No tasks remain assigned here."
              : "The cycle is ready for its scope."}
          </strong>
          <p>
            {cycle.state === "completed"
              ? "Its closing snapshot still preserves the measured totals."
              : "Add existing tasks from your project. Workers start only when you choose to run them."}
          </p>
          {cycle.state !== "completed" && (
            <button className="text-button" onClick={add}>
              <Plus size={12} />
              Choose tasks
            </button>
          )}
        </div>
      )}
      {carried.size > 0 && (
        <p className="cycle-carried-note">
          <ArrowRight size={12} />
          {carried.size} unfinished{" "}
          {carried.size === 1 ? "task was" : "tasks were"} carried out when
          this cycle closed.
        </p>
      )}
    </section>
  );
}

function CycleReadiness({
  task,
  projectTasks,
  workflow,
  open,
}: {
  task: WorkItem;
  projectTasks: WorkItem[];
  workflow: WorkflowState[];
  open: (task: WorkItem) => void;
}) {
  const readiness = storyReadiness(task, projectTasks, workflow);
  if (!readiness) return <span aria-label="Not awaiting a start">—</span>;
  if (readiness.state !== "blocked")
    return (
      <span className="cycle-readiness" title={readiness.detail}>
        {readiness.label}
      </span>
    );
  const { blockers } = readiness;
  return (
    <div className="cycle-readiness blocked">
      <span>
        Waiting on{" "}
        {blockers.length === 1 ? "1 task" : `${blockers.length} tasks`}
      </span>
      {blockers.map(({ id, story }) =>
        story ? (
          <button type="button" key={id} onClick={() => open(story)}>
            <span>
              {story.identifier} · {story.title}
            </span>
            <small>
              {story.archivedAt && "Archived · "}
              {taskStatus(story, workflow).name}
              {story.cycleId !== task.cycleId && " · Outside this cycle"}
            </small>
          </button>
        ) : (
          <button type="button" key={id} onClick={() => open(task)}>
            Review unavailable prerequisite
          </button>
        ),
      )}
    </div>
  );
}
