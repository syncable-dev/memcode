import type {
  Cycle,
  Epic,
  Harness,
  Priority,
  Stage,
  TaskPatch,
  WorkItem,
  WorkflowState,
} from "../shared";
import type { GroupBy } from "./types";
import { taskStatus } from "./workflow";

export interface WorkGroup {
  id: string;
  name: string;
  stage?: Stage;
  color?: string;
  wipLimit?: number | null;
  tasks: WorkItem[];
}
interface GroupDefinition {
  id: string;
  name: string;
  stage?: Stage;
  color?: string;
  wipLimit?: number | null;
}
export interface GroupSources {
  tasks: WorkItem[];
  workflow: WorkflowState[];
  epics: Epic[];
  cycles: Cycle[];
}
interface MoveSources {
  workflow: WorkflowState[];
  cycles: Cycle[];
}
export type GroupMove =
  | { kind: "update"; patch: TaskPatch }
  | { kind: "blocked"; message: string }
  | { kind: "ignore" };

export const groupNames: Record<GroupBy, string> = {
  status: "Status",
  epic: "Goal",
  priority: "Priority",
  harness: "Harness",
  cycle: "Cycle",
  none: "No grouping",
};
const epicColors: Record<Epic["color"], string> = {
  mint: "#69ac8d",
  cyan: "#66aebb",
  lavender: "#9a90bd",
  amber: "#bca169",
};
const priorityColors: Record<Priority, string> = {
  high: "#bb8d69",
  medium: "#b5a468",
  low: "#8aa598",
};
const harnessNames: Record<Harness, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
  dsh: "DeepSeek Harness",
};

function assignGroups(
  definitions: GroupDefinition[],
  tasks: WorkItem[],
  key: (task: WorkItem) => string | undefined,
): WorkGroup[] {
  return definitions.map((group) => ({
    ...group,
    tasks: tasks.filter((task) => key(task) === group.id),
  }));
}
function epicGroups({ tasks, epics }: GroupSources): WorkGroup[] {
  const ids = new Set(epics.map((epic) => epic.id));
  const definitions = [
    ...epics.map((epic) => ({
      id: epic.id,
      name: epic.title,
      color: epicColors[epic.color],
    })),
    { id: "none", name: "Without a goal", color: "#b4bdb2" },
  ];
  return assignGroups(definitions, tasks, (task) =>
    ids.has(task.epicId ?? "") ? task.epicId! : "none",
  );
}
function cycleGroups({ tasks, cycles }: GroupSources): WorkGroup[] {
  const ids = new Set(cycles.map((cycle) => cycle.id));
  const definitions = [
    ...cycles.map((cycle) => ({
      id: cycle.id,
      name: cycle.name,
      color: cycle.state === "active" ? "#36b894" : "#a1b39d",
    })),
    { id: "none", name: "No cycle", color: "#b4bdb2" },
  ];
  return assignGroups(definitions, tasks, (task) =>
    ids.has(task.cycleId ?? "") ? task.cycleId! : "none",
  );
}
function priorityGroups(tasks: WorkItem[]): WorkGroup[] {
  const definitions = (["high", "medium", "low"] as const).map((priority) => ({
    id: priority,
    name: priority[0].toUpperCase() + priority.slice(1) + " priority",
    color: priorityColors[priority],
  }));
  return assignGroups(definitions, tasks, (task) => task.priority);
}
function harnessGroups(tasks: WorkItem[]): WorkGroup[] {
  const definitions = [
    { id: "auto", name: "Automatic routing", color: "#67a78b" },
    ...(["codex", "claude", "cursor", "copilot", "dsh"] as const).map((harness) => ({
      id: harness,
      name: harnessNames[harness],
      color: "#9aaba0",
    })),
  ];
  return assignGroups(definitions, tasks, (task) =>
    task.assignment === "auto" ? "auto" : task.harness,
  );
}

export function groupWork(
  groupBy: GroupBy,
  sources: GroupSources,
): WorkGroup[] {
  switch (groupBy) {
    case "status":
      return assignGroups(
        sources.workflow,
        sources.tasks,
        (task) => taskStatus(task, sources.workflow)?.id,
      );
    case "epic":
      return epicGroups(sources);
    case "priority":
      return priorityGroups(sources.tasks);
    case "harness":
      return harnessGroups(sources.tasks);
    case "cycle":
      return cycleGroups(sources);
    case "none":
      return [
        { id: "all", name: "All work", color: "#70a98d", tasks: sources.tasks },
      ];
  }
}

function statusPatch(
  target: string,
  workflow: WorkflowState[],
): TaskPatch | undefined {
  const status = workflow.find((item) => item.id === target);
  if (status) return { statusId: status.id, stage: status.stage };
}
function harnessPatch(target: string): TaskPatch {
  if (target === "auto") return { assignment: "auto", modelOverride: null };
  return {
    harness: target as Harness,
    assignment: "manual",
    modelOverride: null,
  };
}
function cycleMove(target: string, cycles: Cycle[]): GroupMove {
  if (cycles.find((cycle) => cycle.id === target)?.state === "completed")
    return {
      kind: "blocked",
      message: "Choose an upcoming or active cycle for this task.",
    };
  return {
    kind: "update",
    patch: { cycleId: target === "none" ? null : target },
  };
}

export function groupMove(
  groupBy: GroupBy,
  target: string,
  sources: MoveSources,
): GroupMove {
  switch (groupBy) {
    case "status": {
      const patch = statusPatch(target, sources.workflow);
      return patch ? { kind: "update", patch } : { kind: "ignore" };
    }
    case "epic":
      return {
        kind: "update",
        patch: { epicId: target === "none" ? null : target },
      };
    case "priority":
      return { kind: "update", patch: { priority: target as Priority } };
    case "harness":
      return { kind: "update", patch: harnessPatch(target) };
    case "cycle":
      return cycleMove(target, sources.cycles);
    case "none":
      return { kind: "ignore" };
  }
}

export function bulkEditPatch(
  action: string,
  archived: boolean,
  workflow: WorkflowState[],
  at: string,
): TaskPatch | undefined {
  if (action === "none") return;
  const [kind, value] = action.split("|");
  switch (kind) {
    case "status":
      return statusPatch(value, workflow);
    case "priority":
      return { priority: value as Priority };
    case "cycle":
      return { cycleId: value === "none" ? null : value };
    default:
      return { archivedAt: archived ? null : at };
  }
}
