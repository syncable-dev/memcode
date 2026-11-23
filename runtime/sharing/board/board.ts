import type { AppState, Epic, WorkItem } from "../../../src/shared";
import type {
  Cycle,
  CustomField,
  SavedView,
  WorkflowState,
} from "../../../src/planning/types";
import type { StoryComment } from "../../../src/story-comments";
import { isActive } from "../../../src/domain";
import { cycleSnapshot } from "../../../src/planning/history";
import {
  emptyBoard,
  type Board,
  type Collection,
  type Entry,
  type Json,
} from "./document";

/**
 * What of a MemCode project is on its shared board, and what a board from the
 * document means for the project on this computer. Everything else in the
 * workspace stays here: workers, conversations, changes, reviews, paths.
 */

/** When the log says an entry was made and last changed, and by which account. */
export interface EntryStamp {
  createdAt?: string;
  createdBy?: string;
  changedAt?: string;
}
export interface ApplyOptions {
  /** The moment to date a change with when the log has not dated it. */
  at: string;
  stampOf?: (collection: Collection, id: string) => EntryStamp | undefined;
  /** The name of a person on the project, by account. */
  nameOf?: (accountId: string) => string | undefined;
}

const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOMEONE = "Someone on this project";

/**
 * A lane that comes with a project carries the project's id in front, and that id
 * differs on every computer. On the board it is written without it. A lane a
 * person added has an id of its own and is written as it is.
 */
function laneOnBoard(projectId: string, id: string): string | undefined {
  if (id.startsWith(projectId + ":")) return id.slice(projectId.length + 1);
  return uuidShape.test(id) ? id : undefined;
}
const laneHere = (projectId: string, id: string) =>
  uuidShape.test(id) ? id : `${projectId}:${id}`;

const entry = (
  fields: Record<string, Json | undefined>,
  texts: Record<string, string> = {},
  sets: Record<string, Record<string, Json>> = {},
): Entry => ({
  fields: Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Record<string, Json>,
  texts,
  sets,
});
const members = (ids: string[] | undefined) =>
  Object.fromEntries((ids ?? []).map((id) => [id, true]));

/** A path a second computer can use: inside the project, with forward slashes. */
const isPortablePath = (path: string) =>
  path.length > 0 &&
  path.length <= 1000 &&
  !path.includes("\\") &&
  !path.startsWith("/") &&
  !/^[A-Za-z]:/.test(path) &&
  !/[\x00-\x1f]/.test(path) &&
  path.split("/").every((part) => part && part !== "." && part !== "..");

function taskOnBoard(task: WorkItem): Entry {
  const lane = task.statusId && laneOnBoard(task.projectId, task.statusId);
  const scope = (task.scope ?? [])
    .map((path) => path.replaceAll("\\", "/").replace(/\/+$/, ""))
    .filter(isPortablePath);
  return entry(
    {
      identifier: task.identifier,
      title: task.title,
      stage: task.stage,
      lane: lane || undefined,
      priority: task.priority,
      kind: task.kind ?? "feature",
      goal: task.epicId ?? null,
      cycle: task.cycleId ?? null,
      parent: task.parentId ?? null,
      estimate: task.estimate ?? null,
      startDate: task.startDate ?? null,
      dueDate: task.dueDate ?? null,
      duplicateOf: task.duplicateOf ?? null,
      category: task.category,
      archived: !!task.archivedAt,
    },
    { description: task.description },
    {
      label: members(task.labels),
      scope: members(scope),
      depends: members(task.dependsOn),
      related: members(task.relatedIds),
      field: { ...task.customFields },
      step: Object.fromEntries(
        task.checklist.map((step, order) => [
          step.id,
          { text: step.text, done: step.done, order },
        ]),
      ),
    },
  );
}

const goalOnBoard = (goal: Epic): Entry =>
  entry(
    {
      identifier: goal.identifier,
      title: goal.title,
      phase: goal.phase,
      color: goal.color,
      order: goal.order,
      branch: goal.branch,
      baseRevision: goal.baseRevision,
      baseBranch: goal.baseBranch,
      closed: !!goal.closedAt,
    },
    { description: goal.description },
  );

const cycleOnBoard = (cycle: Cycle): Entry =>
  entry({
    name: cycle.name,
    goal: cycle.goal,
    startDate: cycle.startDate,
    endDate: cycle.endDate,
    timeZone: cycle.timeZone,
    state: cycle.state,
    capacity: cycle.capacity,
    calendar: cycle.calendar,
  });

const commentOnBoard = (comment: StoryComment): Entry =>
  entry({
    task: comment.taskId,
    parent: comment.parentId ?? null,
    text: comment.text,
    reference: comment.reference as Json | undefined,
  });

/** The shared board of one project, as the workspace on this computer has it. */
export function boardOf(state: AppState, projectId: string): Board {
  const board = emptyBoard();
  const tasks = state.tasks.filter(
    (task) => task.projectId === projectId && !task.example,
  );
  for (const task of tasks) board.tasks[task.id] = taskOnBoard(task);
  for (const goal of state.epics)
    if (goal.projectId === projectId) board.goals[goal.id] = goalOnBoard(goal);
  for (const cycle of state.cycles)
    if (cycle.projectId === projectId)
      board.cycles[cycle.id] = cycleOnBoard(cycle);
  for (const comment of state.storyComments ?? [])
    if (comment.taskId in board.tasks && !comment.deletedAt)
      board.comments[comment.id] = commentOnBoard(comment);
  for (const lane of state.workflowStates) {
    const id = lane.projectId === projectId && laneOnBoard(projectId, lane.id);
    if (id)
      board.lanes[id] = entry({
        name: lane.name,
        stage: lane.stage,
        color: lane.color,
        order: lane.order,
        wipLimit: lane.wipLimit ?? null,
      });
  }
  for (const field of state.customFields)
    if (field.projectId === projectId)
      board.fields[field.id] = entry({
        name: field.name,
        type: field.type,
        options: field.options,
      });
  for (const view of state.savedViews)
    if (view.projectId === projectId)
      board.views[view.id] = entry({
        name: view.name,
        mode: view.mode,
        groupBy: view.groupBy,
        sortBy: view.sortBy,
        filters: view.filters as unknown as Json,
      });
  return board;
}

// What is read from a board was written by someone else's computer, so every value
// is checked. One that does not pass is left out and the value already here stays.
type Read<T> = (value: Json | undefined) => T | undefined;
const line =
  (longest: number): Read<string> =>
  (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= longest &&
    !/[\x00-\x1f\x7f]/.test(value)
      ? value
      : undefined;
const wording =
  (longest: number) =>
  (value: unknown): string | undefined =>
    typeof value === "string" && value.length <= longest ? value : undefined;
const oneOf =
  <T extends string>(...choices: T[]): Read<T> =>
  (value) =>
    choices.includes(value as T) ? (value as T) : undefined;
const idOrNone: Read<string | null> = (value) =>
  value === null
    ? null
    : typeof value === "string" && value.length > 0 && value.length <= 250
      ? value
      : undefined;
const dayOrNone: Read<string | null> = (value) =>
  value === null
    ? null
    : typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : undefined;
const numberWithin =
  (least: number, most: number): Read<number> =>
  (value) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= least &&
    value <= most
      ? value
      : undefined;
const orNone =
  <T>(read: Read<T>): Read<T | null> =>
  (value) =>
    value === null ? null : read(value);
const flag: Read<boolean> = (value) =>
  typeof value === "boolean" ? value : undefined;
const or = <T>(read: T | undefined, kept: T): T =>
  read === undefined ? kept : read;
const memberIds = (set: Record<string, Json> | undefined, most: number) =>
  Object.keys(set ?? {})
    .filter((id) => id.length > 0 && id.length <= 1000)
    .slice(0, most);

const stageRead = oneOf("planned", "working", "review", "done");

function stepsFrom(set: Record<string, Json> | undefined) {
  const steps: Array<{
    id: string;
    text: string;
    done: boolean;
    order: number;
  }> = [];
  for (const [id, value] of Object.entries(set ?? {})) {
    const step = value as { text?: Json; done?: Json; order?: Json } | null;
    const text = wording(20000)(step?.text);
    if (!step || typeof step !== "object" || text === undefined) continue;
    steps.push({
      id,
      text,
      done: step.done === true,
      order: typeof step.order === "number" ? step.order : steps.length,
    });
  }
  return steps
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .slice(0, 500)
    .map(({ id, text, done }) => ({ id, text, done }));
}

function customValues(set: Record<string, Json> | undefined) {
  const values: Record<string, string | number | null> = {};
  for (const [id, value] of Object.entries(set ?? {}))
    if (
      value === null ||
      (typeof value === "number" && Number.isFinite(value)) ||
      wording(20000)(value) !== undefined
    )
      values[id] = value as string | number | null;
  return Object.keys(values).length ? values : undefined;
}

const positive: Read<number> = (value) =>
  Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
/** What each part of a comment's reference may be. A part that is not listed makes it no reference. */
const referenceParts: Record<string, Read<unknown>> = {
  kind: oneOf("file", "artifact", "changes", "terminal"),
  name: line(240),
  quote: wording(20000),
  path: (value) =>
    typeof value === "string" && isPortablePath(value) ? value : undefined,
  resultId: line(250),
  revision: line(200),
  line: positive,
  endLine: positive,
  page: positive,
  sheet: line(200),
  range: line(100),
  selector: line(1000),
};

/** What a comment points at, when the board holds exactly what MemCode writes there. */
function referenceFrom(value: Json | undefined): StoryComment["reference"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const parts = Object.entries(value);
  const usable = parts.every(
    ([name, part]) => referenceParts[name]?.(part) !== undefined,
  );
  const { kind, name, quote } = value;
  if (
    !usable ||
    kind === undefined ||
    name === undefined ||
    quote === undefined
  )
    return undefined;
  return value as unknown as StoryComment["reference"];
}

/** The shared part of a task as the board has it. Nothing when the board has no usable task there. */
function taskFromBoard(
  projectId: string,
  shared: Entry,
  kept: WorkItem | undefined,
): Partial<WorkItem> | undefined {
  const { fields, texts, sets } = shared;
  const identifier = or(line(240)(fields.identifier), kept?.identifier),
    title = or(line(240)(fields.title), kept?.title),
    stage = or(stageRead(fields.stage), kept?.stage);
  if (!identifier || !title || !stage) return undefined;
  const lane = line(250)(fields.lane);
  return {
    identifier,
    title,
    stage,
    statusId: lane ? laneHere(projectId, lane) : undefined,
    description: or(wording(20000)(texts.description), kept?.description ?? ""),
    priority: or(
      oneOf("high", "medium", "low")(fields.priority),
      kept?.priority ?? "medium",
    ),
    kind: or(
      oneOf("feature", "fix", "refactor", "research", "test")(fields.kind),
      kept?.kind ?? "feature",
    ),
    epicId: or(idOrNone(fields.goal), kept?.epicId ?? null),
    cycleId: or(idOrNone(fields.cycle), kept?.cycleId ?? null),
    parentId: or(idOrNone(fields.parent), kept?.parentId ?? null),
    estimate: or(
      orNone(numberWithin(0, 10000))(fields.estimate),
      kept?.estimate ?? null,
    ),
    startDate: or(dayOrNone(fields.startDate), kept?.startDate ?? null),
    dueDate: or(dayOrNone(fields.dueDate), kept?.dueDate ?? null),
    duplicateOf: or(idOrNone(fields.duplicateOf), kept?.duplicateOf ?? null),
    category: or(line(200)(fields.category), kept?.category ?? "Work"),
    labels: memberIds(sets.label, 30).filter((label) => label.length <= 100),
    scope: memberIds(sets.scope, 200).filter(isPortablePath),
    dependsOn: memberIds(sets.depends, 200),
    relatedIds: memberIds(sets.related, 200),
    customFields: customValues(sets.field),
    checklist: stepsFrom(sets.step),
  };
}

function applyTasks(
  state: AppState,
  projectId: string,
  before: Board,
  after: Board,
  options: ApplyOptions,
) {
  const gone = new Set(
    Object.keys(before.tasks).filter((id) => !(id in after.tasks)),
  );
  // A task with a worker running on this computer is not taken away under it.
  state.tasks = state.tasks.filter(
    (task) =>
      task.projectId !== projectId || !gone.has(task.id) || isActive(task),
  );
  for (const [id, shared] of Object.entries(after.tasks)) {
    if (JSON.stringify(before.tasks[id]) === JSON.stringify(shared)) continue;
    const kept = state.tasks.find((task) => task.id === id);
    if (kept && kept.projectId !== projectId) continue;
    const read = taskFromBoard(projectId, shared, kept);
    if (!read) continue;
    const stamp = options.stampOf?.("tasks", id);
    const archived = or(flag(shared.fields.archived), !!kept?.archivedAt);
    const dated = {
      updatedAt: stamp?.changedAt ?? options.at,
      archivedAt: archived
        ? (kept?.archivedAt ?? stamp?.changedAt ?? options.at)
        : null,
    };
    if (kept) {
      Object.assign(kept, read, dated);
      continue;
    }
    const createdAt = stamp?.createdAt ?? options.at;
    state.tasks.push({
      id,
      projectId,
      harness: state.settings.defaultHarness,
      assignment: "auto",
      // The brief a worker here starts from, as the first message of any task is.
      messages: [
        {
          id: `brief:${id}`,
          role: "user",
          text: read.description || read.title!,
          at: createdAt,
        },
      ],
      run: { state: "idle" },
      createdAt,
      ...(read as Required<
        Pick<WorkItem, "identifier" | "title" | "stage" | "description">
      > &
        Pick<WorkItem, "priority" | "category" | "checklist">),
      ...dated,
    });
  }
}

function applyGoals(
  state: AppState,
  projectId: string,
  before: Board,
  after: Board,
  at: string,
) {
  state.epics = state.epics.filter(
    (goal) =>
      goal.projectId !== projectId ||
      !(goal.id in before.goals) ||
      goal.id in after.goals,
  );
  for (const [id, shared] of Object.entries(after.goals)) {
    if (JSON.stringify(before.goals[id]) === JSON.stringify(shared)) continue;
    const kept = state.epics.find((goal) => goal.id === id);
    if (kept && kept.projectId !== projectId) continue;
    const { fields, texts } = shared;
    const identifier = or(line(240)(fields.identifier), kept?.identifier),
      title = or(line(240)(fields.title), kept?.title);
    if (!identifier || !title) continue;
    const closed = or(flag(fields.closed), !!kept?.closedAt);
    const read: Omit<Epic, "id" | "projectId"> = {
      identifier,
      title,
      description: or(
        wording(20000)(texts.description),
        kept?.description ?? "",
      ),
      phase: or(
        oneOf("now", "next", "later")(fields.phase),
        kept?.phase ?? "next",
      ),
      color: or(
        oneOf("mint", "cyan", "lavender", "amber")(fields.color),
        kept?.color ?? "mint",
      ),
      order: or(numberWithin(-1e9, 1e9)(fields.order), kept?.order ?? 0),
      branch: line(240)(fields.branch),
      baseRevision: line(64)(fields.baseRevision),
      baseBranch: line(240)(fields.baseBranch),
      closedAt: closed ? (kept?.closedAt ?? at) : undefined,
    };
    if (kept) Object.assign(kept, read);
    else state.epics.push({ id, projectId, ...read });
  }
}

/** A cycle this computer saw start or finish on the board. */
interface CycleTurn {
  cycle: Cycle;
  kind: "started" | "finished";
  at: string;
}

function applyCycles(
  state: AppState,
  projectId: string,
  before: Board,
  after: Board,
  options: ApplyOptions,
): CycleTurn[] {
  const turns: CycleTurn[] = [];
  state.cycles = state.cycles.filter(
    (cycle) =>
      cycle.projectId !== projectId ||
      !(cycle.id in before.cycles) ||
      cycle.id in after.cycles,
  );
  for (const [id, shared] of Object.entries(after.cycles)) {
    if (JSON.stringify(before.cycles[id]) === JSON.stringify(shared)) continue;
    const kept = state.cycles.find((cycle) => cycle.id === id);
    if (kept && kept.projectId !== projectId) continue;
    const { fields } = shared;
    const name = or(line(240)(fields.name), kept?.name),
      startDate = or(dayOrNone(fields.startDate), kept?.startDate),
      endDate = or(dayOrNone(fields.endDate), kept?.endDate);
    if (!name || !startDate || !endDate) continue;
    const stamp = options.stampOf?.("cycles", id);
    const changedAt = stamp?.changedAt ?? options.at;
    const state_ = or(
      oneOf("planned", "active", "completed")(fields.state),
      kept?.state ?? "planned",
    );
    const read = {
      name,
      goal: or(wording(20000)(fields.goal), kept?.goal ?? ""),
      startDate,
      endDate,
      timeZone: or(line(100)(fields.timeZone), kept?.timeZone ?? "UTC"),
      state: state_,
      capacity: or(
        orNone(numberWithin(0, 100000))(fields.capacity),
        kept?.capacity ?? null,
      ),
      calendar: or(
        oneOf("weekdays", "calendar")(fields.calendar),
        kept?.calendar ?? "weekdays",
      ),
      // A cycle started or finished when the log says its state changed.
      startedAt:
        state_ === "planned" ? kept?.startedAt : (kept?.startedAt ?? changedAt),
      completedAt:
        state_ === "completed" ? (kept?.completedAt ?? changedAt) : undefined,
    };
    const was = kept?.state;
    const cycle: Cycle = kept
      ? Object.assign(kept, read)
      : {
          id,
          projectId,
          createdAt: stamp?.createdAt ?? options.at,
          snapshots: [],
          ...read,
        };
    if (!kept) state.cycles.push(cycle);
    // Only a start or a finish seen here is recorded. A cycle that arrives
    // already started has no baseline: what its scope was then is not known here.
    if (was === "planned" && state_ !== "planned" && !cycle.baseline)
      turns.push({ cycle, kind: "started", at: cycle.startedAt ?? changedAt });
    if (was && was !== "completed" && state_ === "completed")
      turns.push({
        cycle,
        kind: "finished",
        at: cycle.completedAt ?? changedAt,
      });
  }
  return turns;
}

/**
 * What starting or finishing a cycle here records, for a cycle started or
 * finished on another computer: its scope at the start, and its count at the
 * end. Taken once the tasks that came with the change are in.
 */
function recordCycleTurns(state: AppState, turns: CycleTurn[]) {
  for (const { cycle, kind, at } of turns)
    if (kind === "started")
      cycle.baseline ??= cycleSnapshot(state, cycle.id, at);
    else cycle.snapshots.push(cycleSnapshot(state, cycle.id, at));
}

function applyComments(
  state: AppState,
  before: Board,
  after: Board,
  options: ApplyOptions,
) {
  const comments = (state.storyComments ??= []);
  for (const id of Object.keys(before.comments)) {
    const kept = comments.find((comment) => comment.id === id);
    // A comment that was taken back keeps its place, so replies still have something to answer.
    if (kept && !(id in after.comments) && !kept.deletedAt)
      kept.deletedAt =
        options.stampOf?.("comments", id)?.changedAt ?? options.at;
  }
  for (const [id, shared] of Object.entries(after.comments)) {
    if (JSON.stringify(before.comments[id]) === JSON.stringify(shared))
      continue;
    const kept = comments.find((comment) => comment.id === id);
    const { fields } = shared;
    const taskId = or(line(250)(fields.task), kept?.taskId),
      text = or(wording(20000)(fields.text), kept?.text);
    if (!taskId || text === undefined) continue;
    const stamp = options.stampOf?.("comments", id);
    const parentId = or(idOrNone(fields.parent), kept?.parentId ?? null);
    const read = {
      taskId,
      text,
      parentId: parentId ?? undefined,
      reference: referenceFrom(fields.reference),
      updatedAt: stamp?.changedAt ?? options.at,
      deletedAt: undefined,
    };
    if (kept) {
      Object.assign(kept, read);
      continue;
    }
    const account = stamp?.createdBy;
    comments.push({
      id,
      ...read,
      // The log says who sent a comment. What the comment says about itself is not asked.
      author: {
        id: account ?? "unknown",
        name: (account && options.nameOf?.(account)) || SOMEONE,
        source: "memtrace",
      },
      createdAt: stamp?.createdAt ?? options.at,
    });
  }
}

/** Lanes, custom fields and saved views are small lists that a project holds whole. */
function applyProjectLists(
  state: AppState,
  projectId: string,
  before: Board,
  after: Board,
) {
  const changed = (collection: "lanes" | "fields" | "views") =>
    JSON.stringify(before[collection]) !== JSON.stringify(after[collection]);
  if (changed("lanes") && Object.keys(after.lanes).length) {
    const lanes: WorkflowState[] = [];
    for (const [id, { fields }] of Object.entries(after.lanes)) {
      const name = line(200)(fields.name),
        stage = stageRead(fields.stage);
      if (!name || !stage) continue;
      lanes.push({
        id: laneHere(projectId, id),
        projectId,
        name,
        stage,
        color: or(line(100)(fields.color), "#98a59d"),
        order: or(numberWithin(-1e9, 1e9)(fields.order), lanes.length),
        wipLimit: or(orNone(numberWithin(0, 100000))(fields.wipLimit), null),
      });
    }
    // A lane that is not on the board and cannot be written there stays where it is.
    const local = (lane: WorkflowState) =>
      lane.projectId !== projectId || !laneOnBoard(projectId, lane.id);
    state.workflowStates = [...state.workflowStates.filter(local), ...lanes];
  }
  if (changed("fields")) {
    const fields: CustomField[] = [];
    for (const [id, { fields: read }] of Object.entries(after.fields)) {
      const name = line(200)(read.name),
        type = oneOf("text", "number", "select")(read.type);
      if (!name || !type) continue;
      const options = Array.isArray(read.options)
        ? read.options.filter(
            (option): option is string =>
              typeof option === "string" && option.length <= 200,
          )
        : [];
      fields.push({
        id,
        projectId,
        name,
        type,
        options: options.slice(0, 200),
      });
    }
    state.customFields = [
      ...state.customFields.filter((field) => field.projectId !== projectId),
      ...fields,
    ];
  }
  if (changed("views")) {
    const views: SavedView[] = [];
    for (const [id, { fields }] of Object.entries(after.views)) {
      const name = line(200)(fields.name),
        mode = oneOf("board", "list", "timeline", "calendar")(fields.mode),
        groupBy = oneOf(
          "status",
          "epic",
          "priority",
          "harness",
          "cycle",
          "none",
        )(fields.groupBy),
        sortBy = oneOf(
          "priority",
          "updated",
          "created",
          "due",
          "estimate",
        )(fields.sortBy);
      const filters = fields.filters;
      if (!name || !mode || !groupBy || !sortBy) continue;
      if (!filters || typeof filters !== "object" || Array.isArray(filters))
        continue;
      views.push({
        id,
        projectId,
        name,
        mode,
        groupBy,
        sortBy,
        filters: filters as unknown as SavedView["filters"],
      });
    }
    state.savedViews = [
      ...state.savedViews.filter((view) => view.projectId !== projectId),
      ...views,
    ];
  }
}

/**
 * Makes the project on this computer follow a board that changed. Only what
 * differs between `before` and `after` is touched, and only the shared part of
 * a task: its worker, its conversation and its changes are left alone.
 */
export function applyBoard(
  state: AppState,
  projectId: string,
  before: Board,
  after: Board,
  options: ApplyOptions,
): void {
  applyProjectLists(state, projectId, before, after);
  applyGoals(state, projectId, before, after, options.at);
  const turns = applyCycles(state, projectId, before, after, options);
  applyTasks(state, projectId, before, after, options);
  applyComments(state, before, after, options);
  recordCycleTurns(state, turns);
}
