/** Work as proposed before it exists: what the composer shows for editing. */
export interface PlannedTask {
  title: string;
  brief: string;
  files: string[];
  /** The task's runbook as planned; empty means it gets the standard runbook when created. */
  steps: string[];
}
export interface PlannedGoal {
  title: string;
  tasks: PlannedTask[];
}
/** One request can hold several outcomes; each planned goal ships as its own pull request. */
export interface PlannedWork {
  goals: PlannedGoal[];
  /** The harness's answer couldn't be read, so the request became one task. */
  fallback?: true;
}

const plannedTitleLength = 200;

/** The request itself as one task: where a plan starts when no worker wrote one. */
export function requestAsPlan(request: string): PlannedWork {
  const title = request.replace(/\s+/g, " ").trim().slice(0, plannedTitleLength);
  return {
    goals: [{ title, tasks: [{ title, brief: request.trim(), files: [], steps: [] }] }],
  };
}

export interface WorkPlan extends PlannedWork {
  harness: import("./shared").Harness;
  model: string;
}
/** What the composer edits: a worker's plan, or the request standing in when none planned it. */
export type WorkDraft = PlannedWork | WorkPlan;

/** An open goal already changing code that a new request touches. */
export interface GoalMatch {
  epicId: string;
  title: string;
  shared: string[];
}
export interface Placement {
  files: string[];
  goals: GoalMatch[];
}
