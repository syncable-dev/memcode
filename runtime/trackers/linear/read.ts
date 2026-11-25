import type { Person } from "../../../src/people";
import type { TrackedField, TrackerStatus, TrackerTeam } from "../../../src/tracker";

/**
 * Linear's answers as MemCode keeps them. What is read comes from the network, so each
 * value is checked and one that cannot be what it claims is left out.
 */
export interface Issue {
  id: string;
  key: string;
  url?: string;
  title: string;
  description: string;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  estimate: number | null;
  dueDate: string | null;
  statusId: string;
  assignee: Person | null;
  teamId: string;
  cycleId: string | null;
  projectId: string | null;
  milestoneId: string | null;
  parentId: string | null;
  labelIds: string[];
  updatedAt: string;
  createdAt: string;
  /** In the trash, or archived there. */
  gone: boolean;
}
export interface Comment {
  id: string;
  issueId: string;
  parentId: string | null;
  body: string;
  author: Person;
  createdAt: string;
  updatedAt: string;
  gone: boolean;
}
export interface Label {
  id: string;
  name: string;
  isGroup: boolean;
}
export interface Cycle {
  id: string;
  name: string;
  description: string;
  startsAt: string;
  endsAt: string;
  completedAt: string | null;
  isActive: boolean;
  gone: boolean;
}
export interface Milestone {
  id: string;
  name: string;
  description: string;
  order: number;
  done: boolean;
  gone: boolean;
}
export interface LinearProject {
  id: string;
  name: string;
  description: string;
  url?: string;
  order: number;
  status: "backlog" | "planned" | "started" | "paused" | "completed" | "canceled";
  gone: boolean;
  milestones: Milestone[];
}

const text = (value: unknown, most = 200_000): string =>
  typeof value === "string" ? value.slice(0, most) : "";
const line = (value: unknown, most = 500): string =>
  text(value, most)
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim();
const id = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;
const idOf = (value: unknown): string | null => id((value as { id?: unknown } | null)?.id);
const when = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const day = (value: unknown): string | null =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const address = (value: unknown): string | undefined =>
  typeof value === "string" && /^https:\/\/linear\.app\/[^\s]{1,500}$/.test(value)
    ? value
    : undefined;

export function readPerson(value: any): Person | null {
  const person = id(value?.id);
  const name = line(value?.name || value?.displayName, 200);
  if (!person || !name) return null;
  const email = line(value.email, 320);
  return { id: person, name, ...(email ? { email } : {}) };
}

export function readIssue(value: any): Issue | null {
  const issue = id(value?.id),
    statusId = idOf(value?.state),
    teamId = idOf(value?.team),
    updatedAt = when(value?.updatedAt);
  if (!issue || !statusId || !teamId || !updatedAt) return null;
  return {
    id: issue,
    key: line(value.identifier, 60),
    url: address(value.url),
    title: line(value.title, 255) || "Untitled",
    description: text(value.description).replaceAll("\r\n", "\n"),
    priority: Math.min(4, Math.max(0, Math.round(number(value.priority) ?? 0))),
    estimate: number(value.estimate),
    dueDate: day(value.dueDate),
    statusId,
    assignee: readPerson(value.assignee),
    teamId,
    cycleId: idOf(value.cycle),
    projectId: idOf(value.project),
    milestoneId: idOf(value.projectMilestone),
    parentId: idOf(value.parent),
    labelIds: Array.isArray(value.labelIds)
      ? value.labelIds.flatMap((label: unknown) => id(label) ?? [])
      : [],
    updatedAt,
    createdAt: when(value.createdAt) ?? updatedAt,
    gone: !!value.trashed || !!value.archivedAt,
  };
}

export function readComment(value: any): Comment | null {
  const comment = id(value?.id),
    issueId = idOf(value?.issue),
    updatedAt = when(value?.updatedAt);
  if (!comment || !issueId || !updatedAt) return null;
  const outside = line(value.botActor?.name || value.externalUser?.name, 200);
  return {
    id: comment,
    issueId,
    parentId: idOf(value.parent),
    body: text(value.body).replaceAll("\r\n", "\n"),
    author: readPerson(value.user) ?? {
      id: "outside",
      name: outside || "Someone in Linear",
    },
    createdAt: when(value.createdAt) ?? updatedAt,
    updatedAt,
    gone: !!value.archivedAt,
  };
}

export function readStatus(value: any): TrackerStatus | null {
  const status = id(value?.id);
  const types = [
    "triage",
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
    "duplicate",
  ] as const;
  const type = types.find((item) => item === value?.type);
  if (!status || !type) return null;
  return {
    id: status,
    name: line(value.name, 100) || type,
    type,
    position: number(value.position) ?? 0,
    ...(typeof value.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value.color)
      ? { color: value.color }
      : {}),
  };
}

/** The sizes a team gives its work, as numbers. T-shirt sizes are numbers underneath. */
function estimatesOf(value: any): number[] {
  const base: Record<string, number[]> = {
    exponential: [1, 2, 4, 8, 16],
    fibonacci: [1, 2, 3, 5, 8],
    linear: [1, 2, 3, 4, 5],
    tShirt: [1, 2, 3, 5, 8],
  };
  const extended: Record<string, number[]> = {
    exponential: [32, 64],
    fibonacci: [13, 21],
    linear: [6, 7],
    tShirt: [13, 21],
  };
  const type = String(value?.issueEstimationType ?? "");
  if (!base[type]) return [];
  return [
    ...(value.issueEstimationAllowZero ? [0] : []),
    ...base[type],
    ...(value.issueEstimationExtended ? extended[type] : []),
  ];
}

export function readTeam(value: any): TrackerTeam | null {
  const team = id(value?.id);
  if (!team) return null;
  return {
    id: team,
    key: line(value.key, 20),
    name: line(value.name, 200) || "Team",
    ...(typeof value.timezone === "string" ? { timeZone: line(value.timezone, 60) } : {}),
    cyclesEnabled: value.cyclesEnabled === true,
    estimates: estimatesOf(value),
  };
}

export function readLabel(value: any): Label | null {
  const label = id(value?.id),
    name = line(value?.name, 100);
  return label && name ? { id: label, name, isGroup: value.isGroup === true } : null;
}

export function readCycle(value: any): Cycle | null {
  const cycle = id(value?.id),
    startsAt = when(value?.startsAt),
    endsAt = when(value?.endsAt);
  if (!cycle || !startsAt || !endsAt) return null;
  return {
    id: cycle,
    name: line(value.name, 200) || `Cycle ${number(value.number) ?? ""}`.trim(),
    description: text(value.description, 20_000),
    startsAt,
    endsAt,
    completedAt: when(value.completedAt),
    isActive: value.isActive === true,
    gone: !!value.archivedAt && !value.completedAt,
  };
}

export function readProject(value: any): LinearProject | null {
  const project = id(value?.id);
  if (!project) return null;
  const statuses = [
    "backlog",
    "planned",
    "started",
    "paused",
    "completed",
    "canceled",
  ] as const;
  return {
    id: project,
    name: line(value.name, 200) || "Project",
    description: text(value.description, 20_000),
    url: address(value.url),
    order: number(value.sortOrder) ?? 0,
    status: statuses.find((item) => item === value.status?.type) ?? "planned",
    gone: !!value.archivedAt,
    milestones: (Array.isArray(value.projectMilestones?.nodes)
      ? value.projectMilestones.nodes
      : []
    ).flatMap((item: any) => {
      const milestone = id(item?.id);
      return milestone
        ? [
            {
              id: milestone,
              name: line(item.name, 200) || "Milestone",
              description: text(item.description, 20_000),
              order: number(item.sortOrder) ?? 0,
              done: item.status === "done",
              gone: !!item.archivedAt,
            },
          ]
        : [];
    }),
  };
}

/** When each field of an issue last changed, from Linear's own history of it. */
export function readHistory(nodes: unknown): Partial<Record<TrackedField, string>> {
  const times: Partial<Record<TrackedField, string>> = {};
  const changed: [TrackedField, (entry: any) => boolean][] = [
    ["title", (entry) => differs(entry.fromTitle, entry.toTitle)],
    ["description", (entry) => entry.updatedDescription === true],
    ["priority", (entry) => differs(entry.fromPriority, entry.toPriority)],
    ["estimate", (entry) => differs(entry.fromEstimate, entry.toEstimate)],
    ["dueDate", (entry) => differs(entry.fromDueDate, entry.toDueDate)],
    ["labels", (entry) => !!entry.addedLabelIds?.length || !!entry.removedLabelIds?.length],
    ["status", (entry) => differs(entry.fromState?.id, entry.toState?.id)],
    ["assignee", (entry) => differs(entry.fromAssignee?.id, entry.toAssignee?.id)],
    ["cycle", (entry) => differs(entry.fromCycle?.id, entry.toCycle?.id)],
    ["goal", (entry) => differs(entry.fromProject?.id, entry.toProject?.id)],
    ["parent", (entry) => differs(entry.fromParent?.id, entry.toParent?.id)],
  ];
  for (const entry of Array.isArray(nodes) ? nodes : []) {
    const at = when(entry?.createdAt);
    if (!at) continue;
    for (const [field, has] of changed)
      if (has(entry) && (times[field] ?? "") < at) times[field] = at;
  }
  return times;
}
const differs = (from: unknown, to: unknown) => (from ?? null) !== (to ?? null);

/** How many entries of an issue's history are asked for. */
export const historyLength = 30;
/** How far back the entries go: further back than a field that is not among them changed. */
export function historyReaches(nodes: unknown): string | undefined {
  if (!Array.isArray(nodes)) return undefined;
  if (nodes.length < historyLength) return "";
  return nodes.flatMap((entry) => when(entry?.createdAt) ?? []).sort()[0];
}
