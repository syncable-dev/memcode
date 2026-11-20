/** A goal as proposed before it exists: what the composer shows for editing. */
export interface PlannedTask {
  title: string;
  brief: string;
  files: string[];
}
export interface PlannedGoal {
  title: string;
  tasks: PlannedTask[];
  /** The harness's answer couldn't be read, so the request became one task. */
  fallback?: true;
}
export interface GoalPlan extends PlannedGoal {
  harness: import("./shared").Harness;
  model: string;
}

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
