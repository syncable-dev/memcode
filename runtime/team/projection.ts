import { plainPriority } from "../../src/planning/priority";
import type { AppState, WorkItem } from "../../src/shared";
import type { TeamCommand, TeamComment, TeamCycle, TeamEpic, TeamSnapshot, TeamStory } from "../../src/team";
import { relative, isAbsolute } from "node:path";
import type { ReviewReference } from "../../src/review";
import { portablePath } from "./protocol";

/** The complete sharing whitelist. Never serialize a WorkItem or AppState here. */
export interface SharedProjection {
  stories: TeamStory[];
  epics: TeamEpic[];
  cycles: TeamCycle[];
  comments: Array<Omit<TeamComment, "memberId" | "revision">>;
}
const relativeScope = (value: string) => portablePath.safeParse(value).success;
const sorted = <T extends { id: string }>(items: T[]) => items.sort((a, b) => a.id.localeCompare(b.id));

export function projectSharedState(state: AppState, projectId: string): SharedProjection {
  const tasks = state.tasks.filter((task) => task.projectId === projectId && !task.example);
  const taskIds = new Set(tasks.map((task) => task.id));
  const sharedReviews = (state.reviewComments ?? []).filter((comment) => taskIds.has(comment.taskId) && comment.status === "shared");
  const reviewIds = new Set(sharedReviews.map((comment) => `review:${comment.id}`));
  const project = state.projects.find((project) => project.id === projectId);
  const portableReference = (reference: ReviewReference): TeamComment["reference"] | undefined => {
    if (reference.kind === "conversation") return undefined;
    const path = reference.path && project?.path ? relative(project.path, reference.path).replaceAll("\\", "/") : reference.path;
    return {
      kind: reference.kind, name: reference.name, quote: reference.quote,
      ...(path && !isAbsolute(path) && relativeScope(path) ? { path } : {}),
      ...(reference.revision ? { revision: reference.revision } : {}),
      ...(reference.lineStart ? { line: reference.lineStart } : {}),
      ...(reference.lineEnd ? { endLine: reference.lineEnd } : {}),
      ...(reference.page ? { page: reference.page } : {}),
      ...(reference.sheet ? { sheet: reference.sheet } : {}),
      ...(reference.cells ? { range: reference.cells } : {}),
      ...(reference.selector ? { selector: reference.selector.slice(0, 1000) } : {}),
    };
  };
  return {
    stories: sorted(tasks.map((task): TeamStory => ({
      id: task.id, identifier: task.identifier, title: task.title,
      description: task.description, stage: task.stage, priority: plainPriority(task.priority),
      kind: task.kind ?? "feature", epicId: task.epicId ?? null,
      cycleId: task.cycleId ?? null, parentId: task.parentId ?? null,
      estimate: task.estimate ?? null, startDate: task.startDate ?? null,
      dueDate: task.dueDate ?? null, labels: [...(task.labels ?? [])],
      scope: (task.scope ?? []).map((value) => value.replaceAll("\\", "/").replace(/\/+$/, "")).filter(relativeScope), dependsOn: [...(task.dependsOn ?? [])],
    }))),
    epics: sorted(state.epics.filter((epic) => epic.projectId === projectId).map((epic): TeamEpic => ({
      id: epic.id, identifier: epic.identifier, title: epic.title,
      description: epic.description, phase: epic.phase, color: epic.color,
      order: epic.order, ...(epic.branch ? { branch: epic.branch } : {}),
      ...(epic.baseRevision ? { baseRevision: epic.baseRevision } : {}),
    }))),
    cycles: sorted(state.cycles.filter((cycle) => cycle.projectId === projectId).map((cycle): TeamCycle => ({
      id: cycle.id, name: cycle.name, description: cycle.goal,
      startDate: cycle.startDate, endDate: cycle.endDate,
      state: cycle.state === "planned" ? "upcoming" : cycle.state,
      timezone: cycle.timeZone, capacity: cycle.capacity, calendar: cycle.calendar,
    }))),
    comments: sorted([...(state.storyComments ?? []).filter((comment) => taskIds.has(comment.taskId) && !reviewIds.has(comment.id)).map((comment) => ({
      id: comment.id, storyId: comment.taskId, body: comment.text,
      ...(comment.parentId ? { parentId: comment.parentId } : {}),
      createdAt: comment.createdAt, updatedAt: comment.updatedAt,
      ...(comment.deletedAt ? { deletedAt: comment.deletedAt } : {}),
      ...(comment.reference ? { reference: comment.reference } : {}),
    })), ...sharedReviews.map((comment) => ({
      id: `review:${comment.id}`, storyId: comment.taskId, body: comment.text,
      createdAt: comment.createdAt, updatedAt: comment.updatedAt,
      reference: portableReference(comment.reference),
    }))]),
  };
}

export const emptySharedProjection = (): SharedProjection => ({ stories: [], epics: [], cycles: [], comments: [] });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Emit domain changes only; streamed tokens, routes and analysis never produce operations. */
export function sharedCommands(before: SharedProjection, after: SharedProjection): TeamCommand[] {
  const commands: TeamCommand[] = [];
  for (const collection of ["epics", "cycles", "stories"] as const) {
    const prior = new Map(before[collection].map((item) => [item.id, item]));
    const current = new Set(after[collection].map((item) => item.id));
    for (const item of after[collection]) {
      const old = prior.get(item.id);
      if (same(old, item)) continue;
      if (collection === "stories" && old) {
        const patch = Object.fromEntries(Object.entries(item).filter(([key, value]) => key !== "id" && !same(value, (old as unknown as Record<string, unknown>)[key])));
        commands.push({ type: "story.patch", storyId: item.id, patch });
      } else if (collection === "stories") commands.push({ type: "story.put", story: item as TeamStory });
      else if (collection === "epics") commands.push({ type: "epic.put", epic: item as TeamEpic });
      else commands.push({ type: "cycle.put", cycle: item as TeamCycle });
    }
    for (const item of before[collection]) if (!current.has(item.id)) {
      if (collection === "stories") commands.push({ type: "story.delete", storyId: item.id });
      else if (collection === "epics") commands.push({ type: "epic.delete", epicId: item.id });
      else commands.push({ type: "cycle.delete", cycleId: item.id });
    }
  }
  const comments = new Map(before.comments.map((comment) => [comment.id, comment]));
  for (const comment of after.comments) {
    const old = comments.get(comment.id);
    if (same(old, comment)) continue;
    if (comment.deletedAt) {
      if (old && !old.deletedAt) commands.push({ type: "comment.delete", commentId: comment.id });
    } else if (!old) commands.push({ type: "comment.add", commentId: comment.id, storyId: comment.storyId, body: comment.body, ...(comment.parentId ? { parentId: comment.parentId } : {}), ...(comment.reference ? { reference: comment.reference } : {}) });
    else commands.push({ type: "comment.edit", commentId: comment.id, body: comment.body });
  }
  const puts = commands.filter((command): command is Extract<TeamCommand, { type: "story.put" }> => command.type === "story.put");
  const pending = new Map(puts.map((command) => [command.story.id, command]));
  const ordered: typeof puts = [], visiting = new Set<string>();
  const visit = (id: string) => {
    const command = pending.get(id); if (!command) return;
    if (visiting.has(id)) throw Error("Shared tasks contain a parent cycle. Fix their parent relationship before syncing.");
    visiting.add(id);
    if (command.story.parentId) visit(command.story.parentId);
    visiting.delete(id); pending.delete(id); ordered.push(command);
  };
  for (const command of puts) visit(command.story.id);
  const commentAdds = commands.filter((command): command is Extract<TeamCommand, { type: "comment.add" }> => command.type === "comment.add");
  const pendingComments = new Map(commentAdds.map((command) => [command.commentId, command]));
  const orderedComments: typeof commentAdds = [];
  const visitComment = (id: string) => {
    const command = pendingComments.get(id); if (!command) return;
    pendingComments.delete(id);
    if (command.parentId) visitComment(command.parentId);
    orderedComments.push(command);
  };
  for (const command of commentAdds) visitComment(command.commentId);
  // Create referenced planning records and parents before child stories/patches.
  // Remove planning records last, after their stories have been reassigned.
  return [
    ...commands.filter((command) => command.type === "epic.put" || command.type === "cycle.put"),
    ...ordered,
    ...commands.filter((command) => command.type !== "story.put" && command.type !== "epic.put" && command.type !== "cycle.put" && command.type !== "epic.delete" && command.type !== "cycle.delete" && command.type !== "comment.add"),
    ...orderedComments,
    ...commands.filter((command) => command.type === "epic.delete" || command.type === "cycle.delete"),
  ];
}

export function projectionFromSnapshot(snapshot: TeamSnapshot): SharedProjection {
  const stripRevision = <T extends { revision?: number }>(item: T): Omit<T, "revision"> => {
    const { revision: _revision, ...rest } = item;
    return rest;
  };
  return {
    stories: sorted(snapshot.stories.map(stripRevision)),
    epics: sorted(snapshot.epics.map(stripRevision)),
    cycles: sorted(snapshot.cycles.map(stripRevision)),
    comments: sorted(snapshot.comments.map(({ memberId: _memberId, ...comment }) => stripRevision(comment))),
  };
}

/** Only managed shared entities are removed; local execution and credentials survive merges. */
export function applySharedSnapshot(state: AppState, projectId: string, snapshot: TeamSnapshot, previous: SharedProjection): void {
  const at = new Date().toISOString();
  const managed = (collection: "stories" | "epics" | "cycles") => new Set(previous[collection].map((item) => item.id));
  const stories = new Set(snapshot.stories.map((story) => story.id));
  const previousStories = managed("stories");
  state.tasks = state.tasks.filter((task) => task.projectId !== projectId || !previousStories.has(task.id) || stories.has(task.id));
  for (const shared of snapshot.stories) {
    let local = state.tasks.find((task) => task.id === shared.id);
    if (local && local.projectId !== projectId) throw new Error("A shared task ID is already used by another local project. Choose a dedicated local project.");
    if (!local) {
      local = {
        id: shared.id, identifier: shared.identifier, projectId,
        title: shared.title, description: shared.description,
        stage: shared.stage, priority: shared.priority, category: "Work",
        harness: state.settings.defaultHarness, assignment: "auto",
        checklist: [], messages: [{ id: `team-brief:${shared.id}`, role: "system", text: `Shared team brief\n\n${shared.description || shared.title}`, at }],
        createdAt: at, updatedAt: at, run: { state: "idle" },
      } satisfies WorkItem;
      state.tasks.push(local);
    }
    const { revision: _revision, assignedMemberId: _owner, ...fields } = shared;
    // A team knows three priorities: what it has of this one may be all it can have.
    const priority =
      plainPriority(local.priority) === shared.priority ? local.priority : shared.priority;
    Object.assign(local, fields, { projectId, priority });
    // A relative shared scope is useful; local absolute workspace bindings remain local.
    local.scope = (shared.scope ?? []).filter(relativeScope);
  }
  const previousEpics = managed("epics"), previousCycles = managed("cycles");
  const epics = new Set(snapshot.epics.map((item) => item.id)), cycles = new Set(snapshot.cycles.map((item) => item.id));
  state.epics = state.epics.filter((item) => item.projectId !== projectId || !previousEpics.has(item.id) || epics.has(item.id));
  state.cycles = state.cycles.filter((item) => item.projectId !== projectId || !previousCycles.has(item.id) || cycles.has(item.id));
  for (const shared of snapshot.epics) {
    const { revision: _revision, ...fields } = shared;
    const local = state.epics.find((epic) => epic.id === shared.id);
    if (local && local.projectId !== projectId) throw new Error("A shared goal ID is already used by another local project.");
    if (local) Object.assign(local, fields);
    else state.epics.push({ ...fields, projectId });
  }
  for (const shared of snapshot.cycles) {
    const local = state.cycles.find((cycle) => cycle.id === shared.id);
    if (local && local.projectId !== projectId) throw new Error("A shared cycle ID is already used by another local project.");
    const fields = {
      id: shared.id, name: shared.name, goal: shared.description,
      startDate: shared.startDate, endDate: shared.endDate,
      state: shared.state === "upcoming" ? "planned" as const : shared.state,
      timeZone: shared.timezone ?? "UTC", capacity: shared.capacity ?? null, calendar: shared.calendar ?? "weekdays" as const,
    };
    if (local) Object.assign(local, fields);
    else state.cycles.push({ ...fields, projectId, createdAt: at, snapshots: [] });
  }
  const comments = (state.storyComments ??= []);
  for (const shared of snapshot.comments) {
    // Portable review selections appear in the shared discussion, while saved
    // local review drafts and their absolute file bindings remain untouched.
    const local = comments.find((comment) => comment.id === shared.id);
    const member = snapshot.members.find((member) => member.id === shared.memberId);
    const fields = {
      id: shared.id, taskId: shared.storyId, text: shared.body, reference: shared.reference,
      parentId: shared.parentId, createdAt: shared.createdAt, updatedAt: shared.updatedAt,
      deletedAt: shared.deletedAt,
      author: { id: shared.memberId, name: member?.name ?? "Teammate", source: "local" as const },
    };
    if (local) Object.assign(local, fields);
    else comments.push(fields);
  }
}
