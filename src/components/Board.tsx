import { memo, useCallback, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock3,
  GitBranch,
  Inbox,
  Link2,
  MessageSquare,
  Plus,
} from "lucide-react";
import type { Cycle, Stage, WorkItem } from "../shared";
import type { StoryComment } from "../story-comments";
import { harnessNames, stages } from "../shared";
import { isActive, stageLabel } from "../domain";
import { dateLabel, dayAt } from "../planning/dates";
import type { StoryReadiness } from "../planning/readiness";
import { PriorityMark, StageIcon, WorkerMark } from "./UI";
import { Select } from "./Select";

export interface BoardGroup {
  id: string;
  name: string;
  stage?: Stage;
  color?: string;
  wipLimit?: number | null;
  tasks: WorkItem[];
}
interface Props {
  tasks: WorkItem[];
  mode: "board" | "list";
  groups?: BoardGroup[];
  cycles?: Cycle[];
  storyComments?: StoryComment[];
  backlogId?: string;
  readiness?: ReadonlyMap<string, StoryReadiness>;
  open: (task: WorkItem) => void;
  create: (statusId?: string) => void;
  move: (id: string, group: string) => void;
  selected?: Set<string>;
  toggle?: (id: string) => void;
}
type BoardRenderProps = Props & { today: string };

function sameItems<T>(
  a?: T[],
  b?: T[],
  equal: (a: T, b: T) => boolean = Object.is,
) {
  return (
    a === b ||
    ((a?.length ?? 0) === (b?.length ?? 0) &&
      (a ?? []).every((value, index) => equal(value, b![index])))
  );
}

function sameFields(a: object, b: object, except: string[]) {
  if (a === b) return true;
  const before = a as Record<string, unknown>;
  const after = b as Record<string, unknown>;
  const keys = Object.keys(before).filter((key) => !except.includes(key));
  return (
    keys.length ===
      Object.keys(after).filter((key) => !except.includes(key)).length &&
    keys.every((key) => Object.hasOwn(after, key) && before[key] === after[key])
  );
}

/** Transcript bodies and activity timestamps do not appear on board cards. */
export function sameBoardTask(a: WorkItem, b: WorkItem) {
  return (
    a === b ||
    (sameFields(a, b, ["messages", "run", "updatedAt"]) &&
      sameFields(a.run, b.run, ["activity"]) &&
      a.run.activity?.phase === b.run.activity?.phase &&
      sameItems(a.messages, b.messages, (before, after) =>
        sameFields(before, after, ["text", "at"]),
      ))
  );
}

export function sameBoardRenderProps(a: BoardRenderProps, b: BoardRenderProps) {
  return (
    a.mode === b.mode &&
    a.today === b.today &&
    a.backlogId === b.backlogId &&
    (a.readiness === b.readiness ||
      a.tasks.every((task) => {
        const before = a.readiness?.get(task.id);
        const after = b.readiness?.get(task.id);
        return (
          before?.state === after?.state &&
          before?.label === after?.label &&
          before?.detail === after?.detail
        );
      })) &&
    sameItems(a.tasks, b.tasks, sameBoardTask) &&
    (a.groups === b.groups ||
      (!!a.groups &&
        !!b.groups &&
        a.groups.length === b.groups.length &&
        a.groups.every((group, index) => {
          const next = b.groups![index];
          return (
            group.id === next.id &&
            group.name === next.name &&
            group.stage === next.stage &&
            group.color === next.color &&
            group.wipLimit === next.wipLimit &&
            sameItems(group.tasks, next.tasks, sameBoardTask)
          );
        }))) &&
    sameItems(a.cycles, b.cycles) &&
    sameItems(a.storyComments, b.storyComments) &&
    (a.selected === b.selected ||
      ((a.selected?.size ?? 0) === (b.selected?.size ?? 0) &&
        [...(a.selected ?? [])].every((id) => b.selected?.has(id)))) &&
    a.open === b.open &&
    a.create === b.create &&
    a.move === b.move &&
    a.toggle === b.toggle
  );
}

/** Forward the latest actions without invalidating the expensive board view. */
export function WorkBoard(props: Props) {
  const actions = useRef(props);
  actions.current = props;
  const open = useCallback(
    (task: WorkItem) =>
      actions.current.open(
        actions.current.tasks.find((current) => current.id === task.id) ?? task,
      ),
    [],
  );
  const create = useCallback((statusId?: string) => actions.current.create(statusId), []);
  const move = useCallback(
    (id: string, group: string) => actions.current.move(id, group),
    [],
  );
  const toggle = useCallback((id: string) => actions.current.toggle?.(id), []);
  return (
    <MemoBoardContent
      {...props}
      today={dayAt()}
      open={open}
      create={create}
      move={move}
      toggle={toggle}
    />
  );
}

function BoardContent({
  tasks,
  mode,
  groups,
  cycles = [],
  storyComments = [],
  backlogId,
  readiness,
  open,
  create,
  move,
  selected = new Set(),
  toggle,
  today,
}: BoardRenderProps) {
  const [dragged, setDragged] = useState<string | null>(null),
    [over, setOver] = useState<string | null>(null);
  const [backlogCollapsed, setBacklogCollapsed] = useState(() => {
    try {
      return (
        !!backlogId &&
        localStorage.getItem("memcode.board." + backlogId + ".collapsed") ===
          "true"
      );
    } catch {
      return false;
    }
  });
  function toggleBacklog() {
    const next = !backlogCollapsed;
    setBacklogCollapsed(next);
    try {
      localStorage.setItem(
        "memcode.board." + backlogId + ".collapsed",
        String(next),
      );
    } catch {
      // The board remains usable when this window has no writable browser storage.
    }
  }
  const collapseButton = useRef<HTMLButtonElement>(null);
  function changeBacklogVisibility() {
    toggleBacklog();
    requestAnimationFrame(() =>
      collapseButton.current?.focus({ preventScroll: true }),
    );
  }
  const commentCounts = new Map<string, number>();
  for (const comment of storyComments)
    if (!comment.deletedAt)
      commentCounts.set(
        comment.taskId,
        (commentCounts.get(comment.taskId) ?? 0) + 1,
      );
  const discussion = (task: WorkItem) => {
    const count = commentCounts.get(task.id) ?? 0;
    return count > 0 ? (
      <span
        title={`${count} story comment${count === 1 ? "" : "s"}`}
        aria-label={`${count} story comment${count === 1 ? "" : "s"}`}
      >
        <MessageSquare size={11} />
        {count}
      </span>
    ) : null;
  };
  const queued = (task: WorkItem) => {
    const count = task.messages.filter(
      (message) => message.followupState === "queued" && !message.promptedAt,
    ).length;
    return count > 0 ? (
      <span
        title={`${count} queued follow-up${count === 1 ? "" : "s"}`}
        aria-label={`${count} queued follow-up${count === 1 ? "" : "s"}`}
      >
        <Clock3 size={11} />
        {count} queued
      </span>
    ) : null;
  };
  const lanes: BoardGroup[] =
    groups ??
    stages.map((stage) => ({
      id: stage,
      name: stageLabel(stage),
      stage,
      tasks: tasks.filter((task) => task.stage === stage),
    }));
  const checkbox = (task: WorkItem) => (
    <input
      type="checkbox"
      className="selection-checkbox"
      aria-label={`Select ${task.identifier}`}
      checked={selected.has(task.id)}
      onClick={(event) => event.stopPropagation()}
      onChange={() => toggle?.(task.id)}
    />
  );
  const assignment = (task: WorkItem) =>
    task.assignment === "auto" && !task.route
      ? "Automatic"
      : harnessNames[task.harness];
  if (mode === "list")
    return (
      <div
        className="work-list planning-list"
        role="table"
        aria-label="Work items"
      >
        <div className="list-head planning-list-head" role="row">
          <span />
          <span role="columnheader">Work item</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Priority</span>
          <span role="columnheader">Points</span>
          <span role="columnheader">Cycle</span>
          <span role="columnheader">Worker</span>
          <span role="columnheader">Due</span>
        </div>
        {lanes.map((group) => (
          <section className="list-section" key={group.id} role="rowgroup">
            <div className="list-section-heading" data-work-group={group.id}>
              <span
                className="group-color"
                style={{ background: group.color ?? "#9aaf9e" }}
              />
              <strong>{group.name}</strong>
              <span>{group.tasks.length}</span>
              <button
                className="icon-button"
                title="Create work item"
                onClick={() => create(group.stage ? group.id : undefined)}
              >
                <Plus size={14} />
              </button>
            </div>
            {group.tasks.map((task) => (
              <div
                className={
                  "work-row planning-row " +
                  (selected.has(task.id) ? "selected" : "")
                }
                role="row"
                key={task.id}
                data-work-item={task.id}
              >
                <span role="cell">{checkbox(task)}</span>
                <span role="cell">
                  <button className="row-title" onClick={() => open(task)}>
                    <small>{task.identifier}</small>
                    <span>{task.title}</span>
                    {task.parentId && (
                      <span className="sub-story-tag">sub</span>
                    )}
                  </button>
                </span>
                <span className="row-status" role="cell">
                  <StageIcon stage={task.stage} />
                  {stageLabel(task.stage)}
                </span>
                <span role="cell">
                  <PriorityMark value={task.priority} />
                  <small className="capitalize">{task.priority}</small>
                </span>
                <span role="cell" className="row-points">
                  {task.estimate ?? "—"}
                </span>
                <span role="cell" className="row-cycle">
                  {cycles.find((cycle) => cycle.id === task.cycleId)?.name ??
                    "Backlog"}
                </span>
                <span className="row-harness" role="cell">
                  <WorkerMark task={task} small />
                  {assignment(task)}
                </span>
                <span
                  role="cell"
                  className={
                    task.dueDate &&
                    task.dueDate < today &&
                    task.stage !== "done"
                      ? "overdue"
                      : ""
                  }
                >
                  {task.dueDate ? dateLabel(task.dueDate) : "—"}
                </span>
              </div>
            ))}
          </section>
        ))}
        {!tasks.length && (
          <div className="filtered-empty">
            No stories match this view. Adjust the filters or create a work
            item.
          </div>
        )}
      </div>
    );
  return (
    <div
      className="work-board"
      style={{
        gridTemplateColumns: lanes
          .map((lane) =>
            lane.id === backlogId && backlogCollapsed
              ? "42px"
              : "minmax(245px,1fr)",
          )
          .join(" "),
      }}
    >
      {lanes.map((group) => (
        <section
          className={"board-column " + (over === group.id ? "drop-over" : "")}
          key={group.id}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(group.id);
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(event) => {
            event.preventDefault();
            if (dragged) move(dragged, group.id);
            setDragged(null);
            setOver(null);
          }}
        >
          {group.id === backlogId && backlogCollapsed ? (
            <button
              ref={collapseButton}
              type="button"
              className="backlog-rail"
              data-work-group={group.id}
              aria-label={`Expand Backlog, ${group.tasks.length} stories`}
              title={`Expand Backlog (${group.tasks.length})`}
              aria-expanded={false}
              onClick={changeBacklogVisibility}
            >
              <ChevronRight size={15} />
              <Inbox size={14} />
              <span>Backlog</span>
              <small>{group.tasks.length}</small>
            </button>
          ) : (
            <>
              <div className="column-heading" data-work-group={group.id}>
                <div>
                  {group.id === backlogId ? (
                    <Inbox size={14} />
                  ) : group.stage ? (
                    <StageIcon stage={group.stage} />
                  ) : (
                    <span
                      className="group-color"
                      style={{ background: group.color ?? "#9aaf9e" }}
                    />
                  )}
                  <h3>{group.name}</h3>
                  <span
                    className={
                      "column-count " +
                      (group.wipLimit && group.tasks.length > group.wipLimit
                        ? "over-limit"
                        : "")
                    }
                  >
                    {group.tasks.length}
                    {group.wipLimit ? ` / ${group.wipLimit}` : ""}
                  </span>
                </div>
                <div>
                  {group.id === backlogId && (
                    <button
                      ref={collapseButton}
                      type="button"
                      className="icon-button"
                      title="Collapse Backlog"
                      aria-label="Collapse Backlog"
                      aria-expanded={true}
                      onClick={changeBacklogVisibility}
                    >
                      <ChevronLeft size={15} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    title={`Add work item to ${group.name}`}
                    onClick={() => create(group.stage ? group.id : undefined)}
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </div>
              <div
                className="column-track"
                style={
                  group.color ? { background: group.color + "70" } : undefined
                }
              />
              <div
                className="column-cards"
                tabIndex={0}
                aria-label={`${group.name} lane`}
              >
                {group.tasks.map((task) => (
                  <article
                    className={
                      "work-card " +
                      (dragged === task.id ? "dragging " : "") +
                      (selected.has(task.id) ? "selected" : "")
                    }
                    key={task.id}
                    role="button"
                    data-work-item={task.id}
                    tabIndex={0}
                    aria-label={`${task.identifier}: ${task.title}`}
                    aria-describedby={
                      readiness?.has(task.id)
                        ? `readiness-${task.id}`
                        : undefined
                    }
                    draggable={!isActive(task)}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", task.id);
                      event.dataTransfer.effectAllowed = "move";
                      setDragged(task.id);
                    }}
                    onDragEnd={() => {
                      setDragged(null);
                      setOver(null);
                    }}
                    onClick={() => open(task)}
                    onKeyDown={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        ["Enter", " "].includes(event.key)
                      ) {
                        event.preventDefault();
                        open(task);
                      }
                    }}
                  >
                    <div className="card-topline">
                      <span className="card-identifier card-selection">
                        {toggle && checkbox(task)}
                        <span>{task.identifier}</span>
                      </span>
                      <div className="card-actions">
                        <PriorityMark value={task.priority} />
                        <span
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <Select
                            aria-label={`Move ${task.identifier}`}
                            className="card-move-select"
                            value="none"
                            disabled={isActive(task)}
                            onValueChange={(value) => {
                              if (value !== "none") move(task.id, value);
                            }}
                          >
                            <option value="none">•••</option>
                            {lanes.map((lane) => (
                              <option key={lane.id} value={lane.id}>
                                Move to {lane.name}
                              </option>
                            ))}
                          </Select>
                        </span>
                      </div>
                    </div>
                    <h4>{task.title}</h4>
                    {task.run.activity?.phase === "waiting_for_user" && (
                      <span className="worker-needs-input">
                        Waiting for you
                      </span>
                    )}
                    <p className="card-description">{task.description}</p>
                    {readiness?.has(task.id) && (
                      <ReadinessNote
                        id={task.id}
                        value={readiness.get(task.id)!}
                      />
                    )}
                    <div className="card-tags">
                      <span
                        className={`category ${task.category.toLowerCase()}`}
                      >
                        <i />
                        {task.category}
                      </span>
                      {task.labels?.slice(0, 2).map((label) => (
                        <span className="story-label" key={label}>
                          {label}
                        </span>
                      ))}
                    </div>
                    {(task.estimate != null ||
                      task.dueDate ||
                      task.parentId) && (
                      <div className="card-planning">
                        {task.estimate != null && (
                          <span>{task.estimate} pts</span>
                        )}
                        {task.dueDate && (
                          <span
                            className={
                              task.dueDate < today && task.stage !== "done"
                                ? "overdue"
                                : ""
                            }
                          >
                            <Clock3 size={10} />
                            {dateLabel(task.dueDate)}
                          </span>
                        )}
                        {task.parentId && (
                          <span className="sub-story-tag">Child story</span>
                        )}
                      </div>
                    )}
                    <div className="card-runbook">
                      <div className="tiny-track">
                        <i
                          style={{
                            width: task.checklist.length
                              ? `${(task.checklist.filter((item) => item.done).length / task.checklist.length) * 100}%`
                              : "0%",
                          }}
                        />
                      </div>
                      <span>
                        {task.checklist.filter((item) => item.done).length}/
                        {task.checklist.length}
                      </span>
                    </div>
                    <div className="card-footer">
                      <div className="worker-identity">
                        <WorkerMark task={task} small />
                        <span>{assignment(task)}</span>
                        {isActive(task) && <span className="live-dot" />}
                      </div>
                      <div className="card-meta">
                        {queued(task)}
                        {discussion(task)}
                        {task.stage === "done" ? (
                          <Check size={13} className="mint-ink" />
                        ) : (
                          <ArrowUpRight size={13} />
                        )}
                      </div>
                    </div>
                  </article>
                ))}
                {!group.tasks.length && (
                  <button className="empty-column" onClick={() => create(group.stage ? group.id : undefined)}>
                    <Plus size={16} />
                    <span>Add a work item</span>
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      ))}
    </div>
  );
}

const MemoBoardContent = memo(BoardContent, sameBoardRenderProps);

function ReadinessNote({ id, value }: { id: string; value: StoryReadiness }) {
  const Icon =
    value.state === "ready"
      ? CircleCheck
      : value.state === "handoff"
        ? GitBranch
        : Link2;
  return (
    <span
      id={`readiness-${id}`}
      className={`card-readiness ${value.state}`}
      title={value.detail}
    >
      <Icon size={12} aria-hidden="true" />
      <span>{value.label}</span>
      <span className="sr-only">{value.detail}</span>
    </span>
  );
}
