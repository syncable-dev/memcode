import type { Stage, Priority, Harness } from "../shared";

export interface WorkflowState {
  id: string;
  projectId: string;
  name: string;
  stage: Stage;
  color: string;
  order: number;
  wipLimit?: number | null;
}
export interface CustomField {
  id: string;
  projectId: string;
  name: string;
  type: "text" | "number" | "select";
  options: string[];
}
export interface CycleSnapshot {
  at: string;
  sequence: number;
  total: number;
  completed: number;
  planned: number;
  working: number;
  review: number;
  points: number;
  completedPoints: number;
  unestimated: number;
}
export interface Cycle {
  id: string;
  projectId: string;
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  state: "planned" | "active" | "completed";
  capacity: number | null;
  calendar: "weekdays" | "calendar";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  baseline?: CycleSnapshot;
  snapshots: CycleSnapshot[];
  /** The cycle this is in the connected tracker. */
  tracker?: import("../tracker").TrackedItem;
}
export type ViewMode = "board" | "list" | "timeline" | "calendar";
export type GroupBy =
  "status" | "epic" | "priority" | "harness" | "cycle" | "none";
export interface WorkFilters {
  query: string;
  priority: Priority | "all";
  /** A person's id, "none" for nobody. Views saved before people have none. */
  assignee?: string;
  epicId: string;
  cycleId: string;
  label: string;
  kind: string;
  harness: Harness | "all";
  archived: boolean;
}
export interface ViewConfig {
  mode: ViewMode;
  groupBy: GroupBy;
  sortBy: "priority" | "updated" | "created" | "due" | "estimate";
  filters: WorkFilters;
}
export interface SavedView extends ViewConfig {
  id: string;
  projectId: string;
  name: string;
}
export interface TaskObservation {
  projectId: string;
  stage: Stage;
  cycleId: string | null;
  estimate: number | null;
  archived: boolean;
}
export interface TaskEvent {
  id: string;
  sequence: number;
  taskId: string;
  projectId: string;
  at: string;
  kind: "baseline" | "created" | "changed";
  before?: TaskObservation;
  after: TaskObservation;
}
export interface PlanningHistory {
  /** Shared projects whose history is derived from accepted relay events. */
  authoritativeProjects?: string[];
  startedAt: string;
  events: TaskEvent[];
  observations: Record<string, TaskObservation>;
}
export interface CreateCycle {
  projectId: string;
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  capacity: number | null;
  calendar: Cycle["calendar"];
}
export interface TaskPlanningFields {
  cycleId?: string | null;
  estimate?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  labels?: string[];
  parentId?: string | null;
  relatedIds?: string[];
  duplicateOf?: string | null;
  statusId?: string;
  archivedAt?: string | null;
  customFields?: Record<string, string | number | null>;
}
export const defaultFilters: WorkFilters = {
  query: "",
  priority: "all",
  epicId: "all",
  cycleId: "all",
  label: "all",
  kind: "all",
  harness: "all",
  archived: false,
};
export const defaultView: ViewConfig = {
  mode: "board",
  groupBy: "status",
  sortBy: "priority",
  filters: defaultFilters,
};
export const estimateOptions = [0, 1, 2, 3, 5, 8, 13, 21];
