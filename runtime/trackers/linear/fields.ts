import type { AppState, WorkItem, WorkflowState } from "../../../src/shared";
import type { Person } from "../../../src/people";
import type { Priority } from "../../../src/planning/priority";
import {
  trackedFields,
  type TrackedField,
  type TrackerConnection,
  type TrackerStatus,
} from "../../../src/tracker";
import { isActive } from "../../../src/domain";
import {
  backlogStatusId,
  plannedOutsideCycleId,
  taskStatus,
  workflowFor,
} from "../../../src/planning/workflow";
import { applyTaskPatch } from "../../task-planning";
import type { Issue, Label } from "./read";

/** The longest description a task here can hold. */
export const longestDescription = 20_000;
const clipNote = "\n\n… The rest of this description is in Linear.";
/** What a task here holds of a description that is longer than it can hold. */
export const clipped = (full: string): string =>
  full.length > longestDescription
    ? full.slice(0, longestDescription - clipNote.length) + clipNote
    : full;
/** As much of a longer title as a shared board carries. */
export function isCut(here: string, there: string): boolean {
  const part = here.trimEnd().replace(/[\ud800-\udbff\ufffd]$/, "").trimEnd();
  return part.length >= 235 && there.length > here.length && there.startsWith(part);
}
/** A part of what is in Linear. It is never sent back, whatever else is known of the card. */
const isClipped = (task: WorkItem, text: string) =>
  !!task.tracker?.clipped || text.endsWith(clipNote);

/** A task as Linear has it, in Linear's own terms. */
export interface There {
  title: string;
  description: string;
  status: string;
  priority: number;
  estimate: number | null;
  labels: string[];
  assignee: string | null;
  dueDate: string | null;
  cycle: string | null;
  /** "milestone:id" or "project:id", or the parent issue that is a goal here. */
  goal: string | null;
  parent: string | null;
}
/** The same task as it is here, in MemCode's own terms. */
export interface Here {
  title: string;
  description: string;
  status: string;
  priority: Priority;
  estimate: number | null;
  labels: string[];
  assignee: string | null;
  dueDate: string | null;
  cycle: string | null;
  goal: string | null;
  parent: string | null;
}

/** What it takes to read one side in the other's terms. */
export interface Frame {
  state: AppState;
  connection: TrackerConnection;
  statuses: Map<string, TrackerStatus>;
  labels: Map<string, Label>;
  people: Map<string, Person>;
  /** The stages of lanes, also of those that are not here any more. */
  stages?: Record<string, string>;
}

const priorityThere: Record<Priority, number> = {
  none: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};
const priorityHere: Priority[] = ["none", "urgent", "high", "medium", "low"];

export const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
export const sorted = (names: string[]) => [...new Set(names)].sort((a, b) => a.localeCompare(b));

export function thereOf(issue: Issue, frame: Frame): There {
  const isGoal = (id: string) => goalOf(frame, "parent:" + id);
  return {
    title: issue.title,
    description: issue.description,
    status: issue.statusId,
    priority: issue.priority,
    estimate: issue.estimate,
    labels: sorted(issue.labelIds.flatMap((id) => frame.labels.get(id)?.name ?? [])),
    assignee: issue.assignee?.id ?? null,
    dueDate: issue.dueDate,
    cycle: issue.cycleId,
    goal: goalRef(issue, frame),
    parent: issue.parentId && !isGoal(issue.parentId) ? issue.parentId : null,
  };
}

/** Which goal here an issue belongs to, by what goals are in this connection. */
function goalRef(issue: Issue, frame: Frame): string | null {
  const goals = frame.connection.choices?.goals ?? "milestones";
  if (goals === "none") return null;
  if (goals === "parents") return issue.parentId ? "parent:" + issue.parentId : null;
  return issue.milestoneId
    ? "milestone:" + issue.milestoneId
    : issue.projectId
      ? "project:" + issue.projectId
      : null;
}
export function goalOf(frame: Frame, ref: string | null) {
  if (!ref) return undefined;
  const [kind, id] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  return frame.state.epics.find(
    (epic) =>
      epic.projectId === frame.connection.projectId &&
      epic.tracker?.provider === "linear" &&
      epic.tracker.id === id &&
      epic.tracker.kind === kind,
  );
}
/** The task here that is this issue. */
export const taskOf = (frame: Frame, issueId: string | null): WorkItem | undefined =>
  issueId
    ? frame.state.tasks.find(
        (task) =>
          task.projectId === frame.connection.projectId && task.tracker?.id === issueId,
      )
    : undefined;
const cycleOf = (frame: Frame, cycleId: string | null) =>
  cycleId
    ? frame.state.cycles.find(
        (cycle) =>
          cycle.projectId === frame.connection.projectId && cycle.tracker?.id === cycleId,
      )
    : undefined;

/**
 * What a task's lane says to people elsewhere. A worker that failed, was stopped or waits
 * has left half-done work in a review lane here: to everyone else it is still being done.
 */
export function statusHere(task: WorkItem, lanes: WorkflowState[]): string {
  if (task.archivedAt) return task.closedAs ?? "hidden";
  const working = `${task.projectId}:working`;
  if (isActive(task)) return working;
  if (
    task.stage === "review" &&
    !task.run.shipped &&
    ["failed", "stopped", "blocked"].includes(task.run.state)
  )
    return working;
  return taskStatus(task, lanes).id;
}

export function hereOf(task: WorkItem, frame: Frame): Here {
  return {
    title: task.title,
    description: task.description,
    status: statusHere(task, workflowFor(frame.state, task.projectId)),
    priority: task.priority,
    estimate: task.estimate ?? null,
    labels: sorted(task.labels ?? []),
    assignee: task.assignee?.id ?? null,
    dueDate: task.dueDate ?? null,
    cycle: task.cycleId ?? null,
    goal: task.epicId ?? null,
    parent: task.parentId ?? null,
  };
}

function short(text: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++)
    hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193);
  return (hash >>> 0).toString(36);
}
/**
 * What a card says in a field, short: the same on every computer that has the card, and so
 * without what is only known where its worker ran.
 */
function markOf(field: TrackedField, task: WorkItem, here: Here, lanes: WorkflowState[]): string {
  // A shared board carries no more of a title.
  if (field === "title") return short(task.title.slice(0, 230));
  if (field !== "status") return short(JSON.stringify(here[field]));
  const lane = taskStatus(task, lanes).id;
  const own = task.projectId + ":";
  return short(
    [lane.startsWith(own) ? lane.slice(own.length - 1) : lane, !!task.archivedAt, task.closedAs].join(),
  );
}
/** The marks of the fields both sides agree on now. The others keep what they had. */
export function marksNow(task: WorkItem, frame: Frame, agreed?: Here): string {
  const here = hereOf(task, frame);
  const lanes = workflowFor(frame.state, task.projectId);
  const before = (task.tracker?.marks ?? "").split(".");
  return trackedFields
    .map((field, at) =>
      !agreed || same(here[field], agreed[field])
        ? markOf(field, task, here, lanes)
        : (before[at] ?? ""),
    )
    .join(".");
}
/** Whether a field was changed here since both sides agreed on it, where that is known. */
export function changedSince(field: TrackedField, task: WorkItem, frame: Frame): boolean | undefined {
  const mark = (task.tracker?.marks ?? "").split(".")[trackedFields.indexOf(field)];
  if (!mark) return undefined;
  const lanes = workflowFor(frame.state, task.projectId);
  return mark !== markOf(field, task, hereOf(task, frame), lanes);
}

/**
 * A value here in Linear's terms, or nothing when Linear has no place for it: a goal,
 * cycle or parent that is not there, a card that is only hidden here.
 */
export function toThere(
  field: TrackedField,
  value: Here[TrackedField],
  frame: Frame,
  now: There,
  task: WorkItem,
): There[TrackedField] | undefined {
  switch (field) {
    case "title":
      return isCut(String(value), now.title) ? now.title : value;
    case "priority":
      return priorityThere[value as Priority];
    case "estimate": {
      if (value === null) return null;
      const sizes = frame.connection.team?.estimates ?? [];
      if (!sizes.length) return undefined;
      return sizes.reduce((best, size) =>
        Math.abs(size - Number(value)) < Math.abs(best - Number(value)) ? size : best,
      );
    }
    case "description":
      return isClipped(task, String(value ?? "")) ? undefined : value;
    case "assignee":
      return value === null || frame.people.has(String(value)) ? value : undefined;
    case "cycle": {
      if (value === null) return null;
      return frame.state.cycles.find((cycle) => cycle.id === value)?.tracker?.id;
    }
    case "goal": {
      // A goal there that is none here says nothing about being in no goal.
      if (value === null) return now.goal && !goalOf(frame, now.goal) ? now.goal : null;
      const goal = frame.state.epics.find((epic) => epic.id === value)?.tracker;
      return goal?.kind ? `${goal.kind}:${goal.id}` : undefined;
    }
    case "parent": {
      if (value === null) return null;
      return frame.state.tasks.find((item) => item.id === value)?.tracker?.id;
    }
    case "status":
      return statusThere(String(value), frame, now);
    default:
      return value;
  }
}

/** The lane a status shows in: the chosen one, or what it means where that lane is gone. */
export function laneFor(statusId: string | null, frame: Frame): string | undefined {
  const { choices, projectId } = frame.connection;
  const lanes = workflowFor(frame.state, projectId);
  const chosen = choices?.lanes[statusId ?? ""];
  if (chosen && (isOwnLane(chosen, projectId) || lanes.some((lane) => lane.id === chosen)))
    return chosen;
  const type = frame.statuses.get(statusId ?? "")?.type;
  if (type === "backlog") return backlogStatusId(projectId);
  if (type === "unstarted") return `${projectId}:planned`;
  if (type === "started")
    return `${projectId}:${choices?.send.review === statusId && choices.send.working !== statusId ? "review" : "working"}`;
  if (type === "completed") return `${projectId}:done`;
  return undefined;
}
const ownLanes = ["working", "planned", "review", "code-review", "done"];
/** One of MemCode's own lanes, which stand for its steps whether or not they are shown. */
const isOwnLane = (lane: string, projectId: string) =>
  lane === backlogStatusId(projectId) ||
  ownLanes.some((name) => lane === `${projectId}:${name}`);
/** A lane that was deleted: where its cards went is nothing a person said about them. */
export const isGoneLane = (lane: string, frame: Frame): boolean =>
  lane !== "hidden" &&
  lane !== "canceled" &&
  lane !== "duplicate" &&
  !lane.startsWith("\u0000") &&
  !isOwnLane(lane, frame.connection.projectId) &&
  !workflowFor(frame.state, frame.connection.projectId).some((item) => item.id === lane);

function statusThere(lane: string, frame: Frame, now: There): string | undefined {
  const { choices, projectId } = frame.connection;
  if (!choices || lane === "hidden") return undefined;
  const { send } = choices;
  if (lane === "canceled") return send.canceled;
  if (lane === "duplicate")
    return (
      [...frame.statuses.values()].find((status) => status.type === "duplicate")?.id ??
      send.canceled
    );
  const isOpen = (status: TrackerStatus | undefined) =>
    status?.type !== "canceled" && status?.type !== "duplicate";
  // Several statuses there can be one lane here: the one it has already is right.
  if (laneFor(now.status, frame) === lane && isOpen(frame.statuses.get(now.status)))
    return now.status;
  const standard: Record<string, string | undefined> = {
    [backlogStatusId(projectId)]: send.backlog,
    [`${projectId}:planned`]: send.planned,
    [`${projectId}:working`]: send.working,
    [`${projectId}:code-review`]: send.review,
    [`${projectId}:review`]: send.review,
    [`${projectId}:done`]: send.done,
  };
  if (lane in standard) return standard[lane];
  const own = [...frame.statuses.values()]
    .filter((status) => choices.lanes[status.id] === lane && isOpen(status))
    .sort((a, b) => a.position - b.position)[0];
  if (own) return own.id;
  const stage = workflowFor(frame.state, projectId).find((item) => item.id === lane)?.stage;
  return stage
    ? { planned: send.planned, working: send.working, review: send.review, done: send.done }[
        stage
      ]
    : undefined;
}

/** What came of putting a value from Linear on a task here. */
export type Applied =
  | { done: true }
  /** A worker is on it: it can be done when the worker ends. */
  | { waits: string }
  /** It cannot be done: what a person should know. */
  | { refused: string };

const held: ReadonlySet<TrackedField> = new Set(["status", "goal", "parent"]);

/** A worker changed code for this task that has not gone out yet. */
export const hasUnshippedWork = (task: WorkItem): boolean =>
  !!task.run.startedAt && task.stage !== "done" && !task.run.shipped;

export function applyThere(
  task: WorkItem,
  field: TrackedField,
  value: There[TrackedField],
  frame: Frame,
  at: string,
): Applied {
  const { state } = frame;
  if (held.has(field) && isActive(task))
    return {
      waits: `${task.identifier} has a worker running. The change from Linear follows when it ends.`,
    };
  const patch = (fields: Parameters<typeof applyTaskPatch>[2]): Applied => {
    try {
      applyTaskPatch(state, task, fields, at);
      return { done: true };
    } catch (error) {
      return { refused: (error as Error).message };
    }
  };
  switch (field) {
    case "title":
      return patch({ title: String(value).slice(0, 255) });
    case "description": {
      const full = String(value ?? "");
      const part = clipped(full);
      const result = patch({ description: part });
      if (task.tracker) {
        if (part !== full) task.tracker.clipped = true;
        else delete task.tracker.clipped;
      }
      return result;
    }
    case "priority":
      return patch({ priority: priorityHere[Number(value)] ?? "none" });
    case "estimate":
      return patch({ estimate: value as number | null });
    case "labels":
      return patch({ labels: value as string[] });
    case "assignee":
      return patch({
        assignee: value === null ? null : (frame.people.get(String(value)) ?? null),
      });
    case "dueDate":
      // A start date that is only here must not stop a date that everyone sees.
      if (value && task.startDate && task.startDate > String(value))
        task.startDate = null;
      return patch({ dueDate: value as string | null });
    case "cycle": {
      const cycle = cycleOf(frame, value as string | null);
      if (value && !cycle) return { done: true };
      if (isActive(task)) {
        // Linear puts what is started in the current cycle by itself. A worker does not
        // work from its cycle, so there is nothing to wait for.
        task.cycleId = cycle?.id ?? null;
        return { done: true };
      }
      const lanes = workflowFor(state, task.projectId);
      const planned = `${task.projectId}:planned`;
      if (!cycle) {
        const result = patch({ cycleId: null });
        return result;
      }
      // What is in a cycle is planned; the backlog cannot hold one.
      const inBacklog =
        task.stage === "planned" && taskStatus(task, lanes).id === backlogStatusId(task.projectId);
      if (cycle.state === "completed") {
        task.cycleId = cycle.id;
        return { done: true };
      }
      return patch({ cycleId: cycle.id, ...(inBacklog ? { statusId: planned } : {}) });
    }
    case "goal": {
      const goal = goalOf(frame, value as string | null);
      const target = goal?.id ?? null;
      if ((task.epicId ?? null) === target) return { done: true };
      if (hasUnshippedWork(task))
        return {
          refused: `${task.identifier} was moved to ${goal?.title ?? "no goal"} in Linear. It has changes here that are not shipped, so it stays in its goal.`,
        };
      if (goal?.closedAt) delete goal.closedAt;
      return patch({ epicId: target });
    }
    case "parent":
      return patch({ parentId: taskOf(frame, value as string | null)?.id ?? null });
    case "status":
      return applyStatus(task, String(value), frame, at, patch);
  }
}

function applyStatus(
  task: WorkItem,
  statusId: string,
  frame: Frame,
  at: string,
  patch: (fields: Parameters<typeof applyTaskPatch>[2]) => Applied,
): Applied {
  const status = frame.statuses.get(statusId);
  if (!status || status.type === "triage") return { done: true };
  const closed = status.type === "canceled" || status.type === "duplicate";
  if (closed) {
    if (task.archivedAt && task.closedAs) return { done: true };
    if (hasUnshippedWork(task))
      return {
        refused: `${task.identifier} was ${status.type === "canceled" ? "canceled" : "marked a duplicate"} in Linear. It has changes here that are not shipped. Ship or discard them, then archive it.`,
      };
    return patch({ archivedAt: at, closedAs: status.type as "canceled" | "duplicate" });
  }
  if (task.archivedAt && task.closedAs) {
    const restored = patch({ archivedAt: null, closedAs: null });
    if (!("done" in restored)) return restored;
  }
  const lanes = workflowFor(frame.state, task.projectId);
  const wanted = laneFor(statusId, frame);
  const lane = lanes.find((item) => item.id === wanted);
  if (!lane) return { done: true };
  const now = taskStatus(task, lanes);
  if (now.id === lane.id) return { done: true };
  // Only MemCode moves a card to Code review, and a review that is under way goes on.
  if (lane.stage === "review" && now.stage === "review") return { done: true };
  if (lane.id.endsWith(":code-review")) return { done: true };
  const backlog = backlogStatusId(task.projectId);
  if (lane.id === backlog && task.cycleId)
    return patch({ statusId: `${task.projectId}:planned` });
  if (lane.stage === "planned" && lane.id !== backlog && !task.cycleId) {
    const result = patch({ statusId: lane.id });
    if ("done" in result && lane.id === `${task.projectId}:planned`)
      task.statusId = plannedOutsideCycleId(task.projectId);
    return result;
  }
  return patch({ statusId: lane.id });
}

/** A value as a person reads it. */
export function shown(field: TrackedField, value: unknown, side: "here" | "there", frame: Frame): string {
  if (value === null || value === undefined || value === "") return "nothing";
  const text = String(value);
  if (field === "status")
    return side === "there"
      ? (frame.statuses.get(text)?.name ?? text)
      : text === "hidden" || text === "canceled" || text === "duplicate"
        ? text
        : (workflowFor(frame.state, frame.connection.projectId).find((lane) => lane.id === text)
            ?.name ?? text);
  if (field === "priority")
    return side === "there" ? (priorityHere[Number(value)] ?? text) : text;
  if (field === "labels") return (value as string[]).join(", ") || "nothing";
  if (field === "assignee") return frame.people.get(text)?.name ?? text;
  if (field === "cycle")
    return (
      frame.state.cycles.find((cycle) => cycle.id === text || cycle.tracker?.id === text)
        ?.name ?? text
    );
  if (field === "goal") {
    const goal = side === "there" ? goalOf(frame, text) : frame.state.epics.find((epic) => epic.id === text);
    return goal?.title ?? text;
  }
  if (field === "parent")
    return (
      frame.state.tasks.find((task) => task.id === text || task.tracker?.id === text)
        ?.identifier ?? text
    );
  return text.length > 300 ? text.slice(0, 300) + "…" : text;
}

/** The part of Linear's update that says these values. Labels come as ids. */
export function inputOf(
  values: Partial<There>,
  frame: Frame,
  labelIds?: string[],
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of trackedFields) {
    if (!(field in values)) continue;
    const value = values[field];
    switch (field) {
      case "status":
        input.stateId = value;
        break;
      case "labels":
        input.labelIds = labelIds ?? [];
        break;
      case "assignee":
        input.assigneeId = value;
        break;
      case "cycle":
        input.cycleId = value;
        break;
      case "parent":
        if (!String(input.parentId ?? "")) input.parentId = value;
        break;
      case "goal": {
        const [kind, id] = value ? String(value).split(":") : [null, null];
        if (kind === "milestone") {
          // A milestone is in a project, and Linear wants to hear both.
          const project = goalOf(frame, String(value))?.tracker?.within;
          if (project) input.projectId = project;
          input.projectMilestoneId = id;
        } else if (kind === "project") {
          input.projectId = id;
          input.projectMilestoneId = null;
        } else if (kind === "parent") input.parentId = id;
        // Out of a parent that is a goal here: its project and milestone stay as they are.
        else if (frame.connection.choices?.goals === "parents") input.parentId = null;
        else {
          input.projectId = null;
          input.projectMilestoneId = null;
        }
        break;
      }
      default:
        input[field] = value;
    }
  }
  return input;
}
