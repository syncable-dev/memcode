import type { Person } from "./people";

/** The tools a team plans in that a project can be kept in step with. */
export type TrackerProvider = "linear";
export const trackerNames: Record<TrackerProvider, string> = { linear: "Linear" };

/**
 * How an entry here stands with the one in the tracker.
 * - synced: both sides hold the same.
 * - sending: changed here, on its way.
 * - waiting: changed there, and waits for a worker here to finish.
 * - attention: the tracker refused something, or a person has to choose.
 * - unlinked: the issue is gone there, or the project was disconnected.
 */
export type TrackerStanding =
  | "synced"
  | "sending"
  | "waiting"
  | "attention"
  | "unlinked";

/** What a task, goal, cycle or comment here is in the tracker. */
export interface TrackedItem {
  provider: TrackerProvider;
  /** The tracker's own id. Keys and titles change; this does not. */
  id: string;
  /** What people call it there, such as MEMDEV-12. */
  key?: string;
  url?: string;
  /** Its status there, by name. */
  status?: string;
  /** A goal is a milestone, a project or a parent issue there. */
  kind?: "issue" | "milestone" | "project" | "parent" | "cycle" | "comment";
  standing?: TrackerStanding;
  /** What there is to know about the standing, as one sentence. */
  note?: string;
  /** Values that gave way when both sides had changed, newest first. */
  kept?: KeptValue[];
  /** The project a milestone is in. */
  within?: string;
  /** The text there is longer than a task here can hold; it is never sent back. */
  clipped?: boolean;
}

/** A value that lost to a newer one. One click puts it back. */
export interface KeptValue {
  field: TrackedField;
  value: unknown;
  /** The value as a person reads it. */
  shown: string;
  from: "here" | "there";
  at: string;
}

/** What of a task is kept the same on both sides. */
export const trackedFields = [
  "title",
  "description",
  "status",
  "priority",
  "estimate",
  "labels",
  "assignee",
  "dueDate",
  "cycle",
  "goal",
  "parent",
] as const;
export type TrackedField = (typeof trackedFields)[number];
export const trackedFieldNames: Record<TrackedField, string> = {
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  estimate: "Estimate",
  labels: "Labels",
  assignee: "Assignee",
  dueDate: "Due date",
  cycle: "Cycle",
  goal: "Goal",
  parent: "Parent",
};

export interface TrackerTeam {
  id: string;
  key: string;
  name: string;
  timeZone?: string;
  cyclesEnabled: boolean;
  /** Estimates a task may have there; empty when the team does not estimate. */
  estimates: number[];
}

/** A status in the tracker. Its type is what it means, whatever it is called. */
export interface TrackerStatus {
  id: string;
  name: string;
  type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | "duplicate";
  position: number;
  color?: string;
}

/** Where MemCode's own steps go in the tracker. */
export interface SentStatuses {
  backlog?: string;
  planned?: string;
  working?: string;
  review?: string;
  done?: string;
  canceled?: string;
}

export type TrackerScope = "open" | "cycle" | "all";
export type TrackerGoals = "milestones" | "parents" | "none";

/** What the person chose when they brought a team in. */
export interface TrackerChoices {
  teamId: string;
  scope: TrackerScope;
  goals: TrackerGoals;
  /** Both ways, or only from the tracker. */
  direction: "both" | "in";
  /** New tasks here become issues there. */
  createIssues: boolean;
  /** The lane a status shows in, by status id. */
  lanes: Record<string, string>;
  send: SentStatuses;
}

/**
 * Which MemCode keeps a project in step. On a shared project everyone sees the same
 * cards, and two MemCodes writing the same change into them would write it twice.
 */
export interface TrackerKeeper {
  projectId: string;
  provider: TrackerProvider;
  /** The connection that does it, on whichever computer it is. */
  connection: string;
  by: string;
  workspace: string;
  team: string;
  since: string;
}
/** The keeper of a project, when it is somewhere else. */
export function keptElsewhere(
  state: { trackerKeepers?: TrackerKeeper[]; trackers?: TrackerConnection[] },
  projectId: string,
): TrackerKeeper | undefined {
  const keeper = state.trackerKeepers?.find((item) => item.projectId === projectId);
  return keeper && !state.trackers?.some((item) => item.id === keeper.connection)
    ? keeper
    : undefined;
}

/** A project's connection to a tracker, as the window sees it. Holds no secret. */
export interface TrackerConnection {
  id: string;
  projectId: string;
  provider: TrackerProvider;
  workspace: { id: string; name: string; urlKey: string };
  /** Who signed in: MemCode acts as them. */
  viewer: Person;
  connectedAt: string;
  team?: TrackerTeam;
  choices?: TrackerChoices;
  statuses?: TrackerStatus[];
  people?: Person[];
  importedAt?: string;
  /** Since when changes here are sent, and new tasks become issues: never what was before. */
  sendsSince?: string;
  createsSince?: string;
  /** Until when the import can be taken back. */
  undoUntil?: string;
  lastCheckedAt?: string;
  /** Why nothing is going back and forth. */
  problem?: string;
  paused?: boolean;
}

/** What a person is about to bring in, before anything is changed. */
export interface TrackerPreview {
  team: TrackerTeam;
  statuses: TrackerStatus[];
  counts: Record<TrackerScope, number>;
  goals: { milestones: number; projects: number; parents: number };
  /** The choices MemCode suggests, with each status's lane filled in. */
  suggested: TrackerChoices;
}

/** The lanes a status can show in. */
export interface TrackerLane {
  id: string;
  name: string;
}
