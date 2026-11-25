import type { WorkItem } from "../../../src/shared";
import type { KeptValue, TrackedField } from "../../../src/tracker";
import {
  applyThere,
  byItself,
  changedSince,
  clipped,
  hasUnshippedWork,
  hereOf,
  isCut,
  isGoneLane,
  laneFor,
  same,
  shown,
  sorted,
  thereOf,
  toThere,
  type Frame,
  type Here,
  type There,
} from "./fields";
import type { Issue } from "./read";
import { backlogStatusId } from "../../../src/planning/workflow";
import { isActive } from "../../../src/domain";

/**
 * Both sides as they were when they last agreed. Linear rewrites some of what it is sent
 * (Markdown above all), and several of its statuses are one lane here, so each side is
 * compared with what it was itself and never with the other.
 */
export interface Base {
  /** The issue's id there, also when the task here is gone. */
  issue: string;
  here: Here;
  there: There;
  /** When a value here that differs from what both sides agreed on was last changed. */
  touched: Partial<Record<TrackedField, string>>;
  /** What it was then: another value is another change. */
  seen?: Partial<Here>;
  /** What Linear refused, and why. It is not asked the same thing again by itself. */
  stuck?: Partial<Record<TrackedField, { here: string; asked: string; note: string }>>;
  /** How the task stood when something from Linear could not be put on it. */
  held?: string;
  /** Its card was made by bringing work in. */
  brought?: true;
  /** Somebody here has changed it since, also when Linear has heard so. */
  mine?: true;
  /** What else was on the card when it was brought in: more on it since is somebody's work. */
  made?: string;
}

/** When each field last changed in Linear, as far as it was asked. */
export interface History {
  at: Partial<Record<TrackedField, string>>;
  /** A field that is not in it has not changed since then. */
  reaches?: string;
}

/** What can let through something that was held: a worker that ends, work that ships. */
const standsAt = (task: WorkItem): string =>
  [task.run.state, task.run.shipped ?? false, task.stage, !!task.archivedAt].join(" ");
/** Something from Linear was held, and the task has moved on since. */
export const mayFollowNow = (task: WorkItem, base: Base): boolean =>
  base.held !== undefined && base.held !== standsAt(task);

/** Lane last: what a goal, cycle or parent changes on the way is part of it. */
const order: TrackedField[] = [
  "title",
  "description",
  "priority",
  "estimate",
  "labels",
  "assignee",
  "dueDate",
  "goal",
  "parent",
  "cycle",
  "status",
];
const keptLimit = 12;

export interface Merge {
  /** What Linear has to hear, in its own terms. */
  push: Partial<There>;
  /** Why something from Linear is not on the task yet. */
  waits?: string;
  /** What from Linear cannot be put on the task, field by field. */
  refused: Partial<Record<TrackedField, string>>;
  /** Something on the task here changed. */
  changed: boolean;
  /** Linear said something new, and all of it is taken in. */
  heard: boolean;
}

export function baseFor(task: WorkItem, issue: Issue, frame: Frame): Base {
  return {
    issue: issue.id,
    here: hereOf(task, frame),
    there: thereOf(issue, frame),
    touched: {},
  };
}

/**
 * Two that were in step once, and nothing is remembered of it here: kept in step by another
 * computer, disconnected, or made into an issue with an answer that got lost. The card says
 * what was agreed on, field by field, and until when it holds its issue. What was changed on
 * one side is taken to the other. Where both changed, nobody can say which is newer: Linear's
 * stays, and the one here is kept.
 */
export function reunited(
  task: WorkItem,
  issue: Issue,
  frame: Frame,
  history: History = { at: {} },
  /** The issue was made of this card: what differs was changed here since. */
  made = false,
): Base {
  const base = baseFor(task, issue, frame);
  const since = made ? issue.createdAt : task.tracker?.seen;
  for (const field of order) {
    if (field === "title" && isCut(String(base.here.title), String(base.there.title))) {
      // What a shared board holds of a long title: the whole of it is in Linear.
      base.there.title = apart;
      continue;
    }
    if (field === "description" && isPart(task, base)) {
      if (task.tracker) task.tracker.clipped = true;
      if (base.here.description !== clipped(String(base.there.description)))
        base.there.description = apart;
      continue;
    }
    const said = toThere(field, base.here[field], frame, base.there, task);
    if (said !== undefined && same(said, base.there[field])) continue;
    const here = made || changedSince(field, task, frame, base.there);
    const there = !since || lastChanged(field, issue, history) > since;
    if (here === false) {
      // Linear has no place for what is here: it says something only when it says so.
      const isSaid =
        said === undefined
          ? !!since && (history.at[field] ?? "") > since
          : // Its status and its scale stand for more than one value here.
            field === "status" || field === "estimate"
            ? there
            : true;
      if (isSaid) base.there[field] = apart as never;
      continue;
    }
    if (said === undefined) continue;
    base.here[field] = apart as never;
    if (here && !there) {
      base.touched[field] = task.updatedAt;
      continue;
    }
    base.there[field] = apart as never;
    base.touched[field] = never;
    (base.seen ??= {})[field] = hereOf(task, frame)[field] as never;
  }
  return base;
}
const apart = "\u0000apart";
/** Before anything else: whatever Linear has is newer. */
const never = "0001-01-01T00:00:00.000Z";
/** A milestone is not in the history, and neither is what nobody asked for. */
const lastChanged = (field: TrackedField, issue: Issue, history: History): string =>
  history.at[field] ??
  (field === "goal" ? issue.updatedAt : (history.reaches ?? issue.updatedAt));
const isPart = (task: WorkItem, base: Base) =>
  toThere("description", base.here.description, {} as Frame, base.there, task) === undefined ||
  (base.here.description !== base.there.description &&
    base.here.description === clipped(String(base.there.description)));

/** From here on both count as agreed, each as it is: nothing that differs now is sent. */
export function agreeAsIs(task: WorkItem, base: Base, frame: Frame): void {
  base.here = hereOf(task, frame);
  base.touched = {};
  delete base.seen;
  delete base.stuck;
}

/**
 * What a goal is was chosen anew. A card that is in one stays there; any other goes where
 * Linear has it.
 */
export function goalsChosenAnew(task: WorkItem, base: Base): void {
  base.there.goal = task.epicId ? (anyGoal as never) : null;
  base.here.goal = task.epicId ?? null;
  delete base.touched.goal;
}
const anyGoal = "\u0000any";

/**
 * The cards of a lane that was deleted went elsewhere by themselves, in the stage they were:
 * to where the issue's status shows now, or to the first lane. Anywhere else a person, or a
 * worker, moved them.
 */
function followGoneLane(task: WorkItem, base: Base, here: Here, frame: Frame): void {
  const gone = String(base.here.status);
  if (!isGoneLane(gone, frame)) return;
  const stage = frame.stages?.[gone];
  const put = byItself(task, base.there.status, frame);
  // Where nothing is known of the lane, nothing is said about it.
  if (stage && (stage !== task.stage || !put.includes(String(here.status)))) {
    base.here.status = apart;
    return;
  }
  base.here.status = here.status;
  delete base.touched.status;
  delete base.seen?.status;
}

/** Labels added and taken off on both sides, all of them. */
const bothLabels = (here: string[], was: string[], there: string[]): string[] =>
  sorted([
    ...there.filter((name) => here.includes(name) || !was.includes(name)),
    ...here.filter((name) => !was.includes(name)),
  ]);

/** Values the issue was made without: Linear has still to hear them, one by one. */
export function unsaid(base: Base, fields: TrackedField[], at: string): void {
  for (const field of fields) {
    base.here[field] = apart as never;
    base.touched[field] = at;
  }
}
/** All that differs here is what Linear refused already: asking again costs a call and changes nothing. */
export function onlyStuck(task: WorkItem, base: Base, frame: Frame): boolean {
  if (!stuckNote(base)) return false;
  const here = hereOf(task, frame);
  return order.every(
    (field) =>
      same(here[field], base.here[field]) ||
      base.stuck![field]?.here === JSON.stringify(here[field]),
  );
}
/** What Linear refused was taken back here: there is nothing left to say about it. */
export function takenBack(task: WorkItem, base: Base, frame: Frame): boolean {
  if (!stuckNote(base)) return false;
  const here = hereOf(task, frame);
  return (Object.keys(base.stuck!) as TrackedField[]).some((field) =>
    same(here[field], base.here[field]),
  );
}
/** Why a card has something Linear does not take. */
export const stuckNote = (base: Base): string | undefined =>
  Object.values(base.stuck ?? {})[0]?.note;

/**
 * Notes when a value here starts to differ. Cheap enough for every change of the workspace.
 * A difference first seen after MemCode was closed is as old as the task's last change.
 */
export function observe(
  task: WorkItem,
  base: Base,
  frame: Frame,
  at: string,
): { differs: boolean; marked: boolean } {
  const here = hereOf(task, frame);
  followGoneLane(task, base, here, frame);
  let differs = false,
    marked = false;
  for (const field of order)
    if (same(here[field], base.here[field])) {
      delete base.touched[field];
      delete base.seen?.[field];
    } else {
      const seen = (base.seen ??= {});
      if (!base.touched[field] || !same(seen[field], here[field])) {
        base.touched[field] = task.updatedAt < at ? task.updatedAt : at;
        seen[field] = here[field] as never;
        marked = true;
      }
      differs = true;
    }
  return { differs, marked };
}

/** Where both sides have a value of their own: when each was changed has to be known. */
export function contested(task: WorkItem, issue: Issue, base: Base, frame: Frame): boolean {
  if (frame.connection.choices?.direction === "in") return false;
  const there = thereOf(issue, frame);
  const here = hereOf(task, frame);
  return order.some((field) => {
    if (same(here[field], base.here[field]) || same(there[field], base.there[field]))
      return false;
    const said = toThere(field, here[field], frame, there, task);
    return said !== undefined && !same(said, there[field]);
  });
}

/**
 * Brings one task and one issue together, field by field. A value changed on one side goes
 * to the other. Changed on both, the newer one wins and the other is kept on the card.
 */
export function mergeIssue(
  task: WorkItem,
  issue: Issue,
  base: Base,
  frame: Frame,
  at: string,
  /** When a field last changed there, where it matters. */
  changedAt: Partial<Record<TrackedField, string>> = {},
): Merge {
  const there = thereOf(issue, frame);
  const before = hereOf(task, frame);
  const bothWays = frame.connection.choices?.direction !== "in";
  const merge: Merge = { push: {}, refused: {}, changed: false, heard: false };
  const mine = new Set<TrackedField>();
  const pending = new Set<TrackedField>();
  followGoneLane(task, base, before, frame);
  if (base.there.goal === anyGoal) base.there.goal = there.goal;
  // Without its cycle it is in the backlog on both sides, and Planned is a change of its own.
  if (placedByHand(task, before, base, frame))
    base.here.status = backlogStatusId(task.projectId);
  for (const field of order) {
    const changedHere = !same(before[field], base.here[field]);
    const changedThere = !same(there[field], base.there[field]);
    if (!changedHere && !changedThere) continue;
    merge.heard ||= changedThere;
    const said = changedHere ? toThere(field, before[field], frame, there, task) : undefined;
    if (changedHere && said !== undefined && same(said, there[field])) {
      // Both came to the same value.
      base.there[field] = there[field] as never;
      continue;
    }
    if (changedHere && !changedThere) {
      if (said === undefined || !bothWays) {
        if (said === undefined) base.here[field] = before[field] as never;
        mine.add(field);
        continue;
      }
      merge.push[field] = said as never;
      mine.add(field);
      continue;
    }
    if (
      field === "labels" &&
      changedHere &&
      bothWays &&
      Array.isArray(base.here.labels) &&
      Array.isArray(base.there.labels)
    ) {
      const labels = bothLabels(before.labels, base.here.labels, there.labels);
      const last = task.updatedAt;
      const result = applyThere(task, "labels", labels, frame, at);
      if ("done" in result) {
        task.updatedAt = last > issue.updatedAt ? last : issue.updatedAt;
        // What is there is on the card now: anything else on it, or off it, was done here.
        base.there.labels = there.labels;
        base.here.labels = there.labels;
        merge.changed = true;
        if (!same(labels, there.labels)) {
          merge.push.labels = labels;
          mine.add("labels");
        }
        continue;
      }
    }
    if (changedHere && said !== undefined && bothWays) {
      const when = base.touched[field] ?? task.updatedAt;
      const theirs = changedAt[field] ?? issue.updatedAt;
      if (when > theirs && !(field === "status" && givenUp(task, there.status, frame))) {
        keep(task, field, there[field], "there", theirs, frame);
        merge.push[field] = said as never;
        mine.add(field);
        continue;
      }
    }
    // Its own change is as old as it is there: it must not make a change here look newer.
    const last = task.updatedAt;
    const result = applyThere(task, field, there[field], frame, at);
    if ("done" in result) {
      if (changedHere && said !== undefined)
        keep(task, field, before[field], "here", sinceWhen(base, field) ?? at, frame);
      task.updatedAt = last > issue.updatedAt ? last : issue.updatedAt;
      base.there[field] = there[field] as never;
      merge.changed = true;
    } else {
      pending.add(field);
      if ("waits" in result) merge.waits = result.waits;
      else merge.refused[field] = result.refused;
    }
  }
  // A cycle moves a planned card in or out of the backlog. What its status is, or is about
  // to be there, decides.
  const status = mine.has("status") ? merge.push.status : there.status;
  if (
    task.stage === "planned" &&
    !task.archivedAt &&
    status &&
    !pending.has("status") &&
    !same(before.cycle, hereOf(task, frame).cycle)
  )
    applyThere(task, "status", status, frame, at);
  // What an applied value changed beside itself is no change of the person's.
  const after = hereOf(task, frame);
  for (const field of order)
    if (!mine.has(field) && !pending.has(field)) {
      base.here[field] = after[field] as never;
      delete base.touched[field];
    }
  if (pending.size) base.held = standsAt(task);
  else delete base.held;
  merge.heard &&= !pending.size;
  return merge;
}
/** When it was changed here, where that is known. */
const sinceWhen = (base: Base, field: TrackedField): string | undefined =>
  base.touched[field] === never ? undefined : base.touched[field];

/**
 * In a cycle, an issue of Linear's backlog is planned here. Out of the cycle it would be in
 * the backlog here too, so one that is still planned was put there by a person.
 */
function placedByHand(task: WorkItem, here: Here, base: Base, frame: Frame): boolean {
  return (
    !!base.here.cycle &&
    !here.cycle &&
    here.status === `${task.projectId}:planned` &&
    laneFor(base.there.status, frame) === backlogStatusId(task.projectId)
  );
}

/**
 * Somebody there gave the issue up while a worker here was on it. The worker starting or
 * ending is no answer to that: it is a person's to settle, so nothing is sent.
 */
function givenUp(task: WorkItem, statusId: string | null, frame: Frame): boolean {
  const type = frame.statuses.get(statusId ?? "")?.type;
  return (
    (type === "canceled" || type === "duplicate") &&
    (task.stage === "working" || task.stage === "review") &&
    (isActive(task) || hasUnshippedWork(task))
  );
}

/** Linear took these values: both sides agree on them, each as it has them. */
export function agreed(
  task: WorkItem,
  pushed: Partial<There>,
  issue: Issue,
  sent: Here,
  base: Base,
  frame: Frame,
): void {
  const there = thereOf(issue, frame);
  const now = hereOf(task, frame);
  for (const field of Object.keys(pushed) as TrackedField[]) {
    base.there[field] = there[field] as never;
    base.here[field] = sent[field] as never;
    // Changed again while it was on its way: that change is still to be sent.
    if (same(now[field], sent[field])) delete base.touched[field];
    base.mine = true;
  }
}

function keep(
  task: WorkItem,
  field: TrackedField,
  value: unknown,
  from: KeptValue["from"],
  at: string,
  frame: Frame,
): void {
  if (!task.tracker) return;
  const kept = (task.tracker.kept ?? []).filter((item) => item.field !== field);
  task.tracker.kept = [
    { field, value, shown: shown(field, value, from, frame), from, at },
    ...kept,
  ].slice(0, keptLimit);
}
