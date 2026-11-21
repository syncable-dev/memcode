import type { Placement, PlannedGoal, WorkDraft } from "./goal-plan";
import type { Epic } from "./shared";

/** Where a planned goal goes: an existing goal, the Quick changes batch, or a new goal. */
export type Place =
  | { kind: "goal"; epicId: string }
  | { kind: "quick" }
  | { kind: "new" };

/** When a new goal's work should happen; the Roadmap's Now, Next and Later. */
export type Timing = Epic["phase"];

/** What each Roadmap column means to someone choosing it; onboarding and New work share it. */
export const timings: Record<Timing, { name: string; meaning: string }> = {
  now: { name: "Now", meaning: "You’re working on this goal now." },
  next: { name: "Next", meaning: "Up next, once the goals you’re on now are done." },
  later: { name: "Later", meaning: "It should get done, but you haven’t decided when." },
};

const quickChangeLength = 120;
const quickChangeParts = 1;

/** One short line that doesn't list several things usually means one small change. */
export function looksSmall(request: string): boolean {
  const text = request.trim();
  const parts = text.split(/,|;|\band\b/i).filter((part) => part.trim()).length;
  return (
    !text.includes("\n") &&
    text.length <= quickChangeLength &&
    parts <= quickChangeParts
  );
}

/** A worker read the code and answered with a plan; not the request standing in for one. */
function plannedByWorker(draft: WorkDraft): boolean {
  return "harness" in draft && !draft.fallback;
}

/** What Memtrace searches to find open goals already changing a planned goal's code. */
export function placementQuery(goal: PlannedGoal): string {
  return [
    goal.title,
    ...goal.tasks.map((task) => (task.brief ? `${task.title}. ${task.brief}` : task.title)),
  ].join("\n");
}

export interface PlacesInput {
  /** One per planned goal, in the same order. */
  placements: Placement[];
  draft: WorkDraft;
  request: string;
  /** The goal whose card the person started from. */
  fixedEpicId?: string;
}

/** A goal picked from its card takes everything; then a goal changing the same code; then size. */
export function suggestedPlaces(input: PlacesInput): Place[] {
  const oneChange = (goal: PlannedGoal) =>
    goal.tasks.length === 1 && (plannedByWorker(input.draft) || looksSmall(input.request));
  return input.draft.goals.map((goal, index): Place => {
    if (input.fixedEpicId) return { kind: "goal", epicId: input.fixedEpicId };
    const match = input.placements[index]?.goals[0];
    if (match) return { kind: "goal", epicId: match.epicId };
    return oneChange(goal) ? { kind: "quick" } : { kind: "new" };
  });
}

/** One new goal at a time is for now; later new goals wait so a big plan doesn't start everything. */
export function suggestedTimings(places: Place[]): Timing[] {
  let firstNewGoal = true;
  return places.map((place) => {
    if (place.kind !== "new") return "now";
    const timing = firstNewGoal ? "now" : "next";
    firstNewGoal = false;
    return timing;
  });
}

/** Quick changes and work joining a goal start right away; a new goal starts only when it's for now. */
export function startsNow(place: Place, timing: Timing): boolean {
  return place.kind !== "new" || timing === "now";
}

export interface ThinkingProgress {
  /** The worker's display name; absent when no worker is connected. */
  planner?: string;
  /** Related files Memtrace found; absent until the search returns. */
  files?: string[];
  /** The worker has answered (or there was no worker to ask). */
  planned: boolean;
}
export interface ThinkingStep {
  label: string;
  state: "done" | "active" | "waiting";
  detail?: string;
}

const filesShown = 3;

function foundFiles(files: string[]): ThinkingStep {
  if (!files.length)
    return { label: "No related code found, so the plan uses your words", state: "done" };
  const more = files.length - filesShown;
  return {
    label: `Found ${files.length} related ${files.length === 1 ? "file" : "files"}`,
    state: "done",
    detail: files.slice(0, filesShown).join(" · ") + (more > 0 ? ` and ${more} more` : ""),
  };
}

/** MemCode's own steps while a request is planned, so every worker shows the same progress. */
export function thinkingSteps(progress: ThinkingProgress): ThinkingStep[] {
  const finding: ThinkingStep = progress.files
    ? foundFiles(progress.files)
    : { label: "Finding the code this touches", state: "active" };
  const planning: ThinkingStep[] = progress.planner
    ? [
        progress.planned
          ? { label: `${progress.planner} planned the work`, state: "done" }
          : { label: `${progress.planner} is planning the tasks`, state: "active" },
      ]
    : [];
  const placing: ThinkingStep = {
    label: "Checking your open goals",
    state: progress.planned && progress.files ? "active" : "waiting",
  };
  return [finding, ...planning, placing];
}

const startsAtOnce = 3;

/**
 * Starts workers a few at a time so a big plan doesn't flood the machine. Each start runs
 * until its worker is prepared and launched; a failed one is reported, the rest carry on.
 */
export async function startEach(
  tasks: Array<{ id: string; identifier: string }>,
  start: (id: string) => Promise<unknown>,
  limit = startsAtOnce,
): Promise<string[]> {
  const failed: string[] = [];
  const queue = [...tasks];
  const lane = async () => {
    for (let task = queue.shift(); task; task = queue.shift())
      await start(task.id).catch((error: Error) =>
        failed.push(`${task.identifier}: ${error.message}`),
      );
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
  return failed;
}

/** How many of a plan's tasks can start now; the rest are created and stay ready to start. */
export function startsWithinLimit(input: { startable: number; freeSlots: number }) {
  const now = Math.max(0, Math.min(input.startable, input.freeSlots));
  return { now, waiting: Math.max(0, input.startable - now) };
}

/** A goal split out of a bigger request is described by its own tasks, not the whole request. */
export function goalDescription(goal: PlannedGoal, request: string, split: boolean): string {
  if (!split) return request.trim();
  return goal.tasks.map((task) => task.brief.trim() || task.title.trim()).join("\n\n");
}
