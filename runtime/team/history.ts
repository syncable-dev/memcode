import { z } from "zod";
import { createHash } from "node:crypto";
import type { AppState } from "../../src/shared";
import type { CycleSnapshot, TaskObservation } from "../../src/planning/types";
import type { TeamEvent, TeamSnapshot, TeamStory } from "../../src/team";
import { localTeamId, remoteTeamId, type TeamIdentityBinding } from "./identity";
import { backlogStatusId, isBacklogStatus, plannedOutsideCycleId } from "../../src/planning/workflow";

// Kept outside the strict v1 board protocol: old clients can continue syncing.
const id = z.string().min(1).max(200);
const instant = z.string().max(50).refine((value) => Number.isFinite(Date.parse(value)), "Use a valid timestamp.");
const count = z.number().int().nonnegative();
const points = z.number().finite().nonnegative();
const storyPlanningSchema = z.object({
  id, category: z.string().max(200),
  checklist: z.array(z.object({ id, text: z.string().max(20000), done: z.boolean() }).strict()).max(500),
  archivedAt: instant.nullable(), relatedIds: z.array(id).max(200).optional(), duplicateOf: id.nullable().optional(), statusId: id.optional(),
  customFields: z.record(id, z.union([z.string().max(20000), z.number().finite(), z.null()])).optional(),
}).strict();
const projectPlanningSchema = z.object({
  workflowStates: z.array(z.object({ id, name: z.string().max(200), stage: z.enum(["planned", "working", "review", "done"]), color: z.string().max(100), order: z.number().finite(), wipLimit: count.nullable().optional() }).strict()).max(100),
  customFields: z.array(z.object({ id, name: z.string().max(200), type: z.enum(["text", "number", "select"]), options: z.array(z.string().max(200)).max(200) }).strict()).max(100),
  savedViews: z.array(z.object({ id, name: z.string().max(200), mode: z.enum(["board", "list", "timeline", "calendar"]), groupBy: z.enum(["status", "epic", "priority", "harness", "cycle", "none"]), sortBy: z.enum(["priority", "updated", "created", "due", "estimate"]), filters: z.object({ query: z.string().max(2000), priority: z.enum(["high", "medium", "low", "all"]), epicId: id, cycleId: id, label: z.string().max(200), kind: z.string().max(200), harness: z.enum(["codex", "claude", "cursor", "all"]), archived: z.boolean() }).strict() }).strict()).max(200),
}).strict();
const observationSchema = z.object({
  stage: z.enum(["planned", "working", "review", "done"]),
  cycleId: id.nullable(), estimate: points.nullable(), archived: z.boolean(),
}).strict();
const cycleSnapshotSchema = z.object({
  at: instant, sequence: count, total: count, completed: count,
  planned: count, working: count, review: count, points,
  completedPoints: points, unestimated: count,
}).strict();
export const planningSeedSchema = z.object({
  startedAt: instant,
  stories: z.array(storyPlanningSchema.extend({ createdAt: instant, updatedAt: instant })).max(10000),
  cycles: z.array(z.object({ id, createdAt: instant, startedAt: instant.optional(), completedAt: instant.optional(), baseline: cycleSnapshotSchema.optional(), snapshots: z.array(cycleSnapshotSchema).max(20000) }).strict()).max(1000),
  events: z.array(z.object({ id, sequence: count, taskId: id, at: instant, kind: z.enum(["baseline", "created", "changed"]), before: observationSchema.optional(), after: observationSchema }).strict()).max(100000),
  comments: z.array(z.object({ id, createdAt: instant, updatedAt: instant, deletedAt: instant.optional() }).strict()).max(20000),
  planning: projectPlanningSchema,
}).strict().superRefine((value, context) => {
  for (const collection of ["stories", "cycles", "events", "comments"] as const) {
    const seen = new Set<string>();
    for (const item of value[collection]) {
      if (seen.has(item.id)) context.addIssue({ code: "custom", message: `Duplicate ${collection} history ID.`, path: [collection] });
      seen.add(item.id);
    }
  }
});
export type TeamPlanningSeed = z.infer<typeof planningSeedSchema>;
export const planningHistorySchema = planningSeedSchema.safeExtend({
  version: z.literal(1), workspaceId: id, through: count,
  import: z.object({ opId: id, hash: z.string().regex(/^[a-f0-9]{64}$/), at: instant }).strict().optional(),
});
export const planningHistoryUnchangedSchema = z.object({ version: z.literal(1), workspaceId: id, through: count, unchanged: z.literal(true) }).strict();
export type TeamPlanningHistory = z.infer<typeof planningHistorySchema>;
export const planningImportSchema = z.object({ workspaceId: id, opId: id, expectedHead: count, history: planningSeedSchema }).strict();
const expectedMetadataSchema = z.object({ stories: z.array(z.object({ id, hash: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()).max(10000), planningHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const planningMetadataSchema = z.object({ workspaceId: id, opId: id, stories: z.array(storyPlanningSchema).max(10000), planning: projectPlanningSchema.optional(), expected: expectedMetadataSchema.optional() }).strict();
export type TeamPlanningMetadata = Pick<z.infer<typeof planningMetadataSchema>, "stories" | "planning">;
export type ExpectedPlanningMetadata = z.infer<typeof expectedMetadataSchema>;
export function planningValueHash(value: unknown): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, stable(value)])) : value;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export function validatePlanningImport(seed: TeamPlanningSeed, board: TeamSnapshot, now: string): void {
  const latest = Date.parse(now) + 5 * 60_000;
  const times = [seed.startedAt, ...seed.stories.flatMap((item) => [item.createdAt, item.updatedAt, ...(item.archivedAt ? [item.archivedAt] : [])]), ...seed.comments.flatMap((item) => [item.createdAt, item.updatedAt, ...(item.deletedAt ? [item.deletedAt] : [])]), ...seed.events.map((item) => item.at), ...seed.cycles.flatMap((item) => [item.createdAt, ...(item.startedAt ? [item.startedAt] : []), ...(item.completedAt ? [item.completedAt] : []), ...(item.baseline ? [item.baseline.at] : []), ...item.snapshots.map((snapshot) => snapshot.at)])];
  if (times.some((value) => Date.parse(value) > latest)) throw Error("Planning history contains a future occurrence time. Check the source computer's clock before importing.");
  if (seed.events.some((event, i) => i > 0 && event.sequence <= seed.events[i - 1].sequence)) throw Error("Planning history events must retain their original increasing sequence.");
  const last = new Map(seed.events.map((event) => [event.taskId, event.after]));
  for (const story of board.stories) {
    const observed = last.get(story.id), meta = seed.stories.find((item) => item.id === story.id);
    if (observed && !same(observed, observation(story, !!meta?.archivedAt))) throw Error("The board changed after its original planning history was captured. Verify the source before importing.");
  }
}

const ordered = <T extends { id: string }>(items: T[]) => items.sort((a, b) => a.id.localeCompare(b.id));
const portableObservation = ({ stage, cycleId, estimate, archived }: TaskObservation) => ({ stage, cycleId, estimate, archived });
export function projectPlanningHistory(state: AppState, projectId: string): TeamPlanningSeed {
  const stories = state.tasks.filter((task) => task.projectId === projectId && !task.example);
  const ids = new Set(stories.map((task) => task.id));
  const commentIds = new Set(stories.flatMap((task) => (state.storyComments ?? []).filter((comment) => comment.taskId === task.id).map((comment) => comment.id)));
  return planningSeedSchema.parse({
    startedAt: state.planning.startedAt,
    stories: ordered(stories.map(({ id, createdAt, updatedAt, archivedAt, category, checklist, relatedIds, duplicateOf, statusId, customFields }) => ({ id, createdAt, updatedAt, archivedAt: archivedAt ?? null, category, checklist, relatedIds, duplicateOf, statusId, customFields }))),
    cycles: ordered(state.cycles.filter((cycle) => cycle.projectId === projectId).map(({ id, createdAt, startedAt, completedAt, baseline, snapshots }) => ({ id, createdAt, startedAt, completedAt, baseline, snapshots }))),
    events: state.planning.events.filter((event) => event.projectId === projectId).map(({ id, sequence, taskId, at, kind, before, after }) => ({ id, sequence, taskId, at, kind, ...(before ? { before: portableObservation(before) } : {}), after: portableObservation(after) })),
    comments: ordered((state.storyComments ?? []).filter((comment) => commentIds.has(comment.id) && ids.has(comment.taskId)).map(({ id, createdAt, updatedAt, deletedAt }) => ({ id, createdAt, updatedAt, deletedAt }))),
    planning: {
      workflowStates: state.workflowStates.filter((item) => item.projectId === projectId).map(({ projectId: _projectId, ...value }) => value),
      customFields: state.customFields.filter((item) => item.projectId === projectId).map(({ projectId: _projectId, ...value }) => value),
      savedViews: state.savedViews.filter((item) => item.projectId === projectId).map(({ projectId: _projectId, ...value }) => value),
    },
  });
}

/** The hot path excludes timestamps, snapshots and event history entirely. */
export function projectPlanningMetadata(state: AppState, projectId: string): TeamPlanningMetadata {
  return {
    stories: ordered(state.tasks.filter((task) => task.projectId === projectId && !task.example).map(({ id, archivedAt, category, checklist, relatedIds, duplicateOf, statusId, customFields }) => ({ id, archivedAt: archivedAt ?? null, category, checklist: structuredClone(checklist), relatedIds, duplicateOf, statusId, customFields: customFields ? { ...customFields } : undefined }))),
    planning: {
      workflowStates: state.workflowStates.filter((item) => item.projectId === projectId).map(({ projectId: _projectId, ...value }) => value),
      customFields: state.customFields.filter((item) => item.projectId === projectId).map(({ projectId: _projectId, ...value }) => value),
      savedViews: state.savedViews.filter((item) => item.projectId === projectId).map(({ projectId: _projectId, ...value }) => value),
    },
  };
}

export function remotePlanningMetadata(binding: TeamIdentityBinding, metadata: TeamPlanningMetadata): TeamPlanningMetadata {
  const seed = remotePlanningSeed(binding, { startedAt: new Date(0).toISOString(), stories: metadata.stories.map((value) => ({ ...value, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() })), cycles: [], events: [], comments: [], planning: metadata.planning ?? { workflowStates: [], customFields: [], savedViews: [] } });
  return structuredClone({ ...planningMetadata(seed), ...(metadata.planning ? {} : { planning: undefined }) });
}

export function remotePlanningSeed(binding: TeamIdentityBinding, seed: TeamPlanningSeed): TeamPlanningSeed {
  const translate = (kind: Parameters<typeof remoteTeamId>[1], id: string) => {
    if (kind === "workflow") {
      if (isBacklogStatus(id)) return backlogStatusId("memcode");
      if (id.endsWith(":planned-without-cycle")) return plannedOutsideCycleId("memcode");
    }
    return remoteTeamId(binding, kind, id);
  };
  const observation = (value: TeamPlanningSeed["events"][number]["after"]) => ({ ...value, cycleId: value.cycleId ? translate("cycle", value.cycleId) : null });
  return {
    ...seed,
    stories: seed.stories.map((value) => ({ ...value, id: translate("story", value.id), ...(value.relatedIds ? { relatedIds: value.relatedIds.map((id) => translate("story", id)) } : {}), ...(value.duplicateOf ? { duplicateOf: translate("story", value.duplicateOf) } : {}), ...(value.statusId ? { statusId: translate("workflow", value.statusId) } : {}), ...(value.customFields ? { customFields: Object.fromEntries(Object.entries(value.customFields).map(([id, value]) => [translate("field", id), value])) } : {}) })),
    cycles: seed.cycles.map((value) => ({ ...value, id: translate("cycle", value.id) })),
    comments: seed.comments.map((value) => ({ ...value, id: translate("comment", value.id) })),
    events: seed.events.map((value) => ({ ...value, taskId: translate("story", value.taskId), before: value.before ? observation(value.before) : undefined, after: observation(value.after) })),
    planning: {
      workflowStates: seed.planning.workflowStates.map((value) => ({ ...value, id: translate("workflow", value.id) })),
      customFields: seed.planning.customFields.map((value) => ({ ...value, id: translate("field", value.id) })),
      savedViews: seed.planning.savedViews.map((value) => ({ ...value, id: translate("view", value.id), filters: { ...value.filters, epicId: value.filters.epicId === "all" ? "all" : translate("epic", value.filters.epicId), cycleId: value.filters.cycleId === "all" ? "all" : translate("cycle", value.filters.cycleId) } })),
    },
  };
}

export function emptyPlanningHistory(workspaceId: string, at: string): TeamPlanningHistory {
  return { version: 1, workspaceId, through: 0, startedAt: at, stories: [], cycles: [], events: [], comments: [], planning: { workflowStates: [], customFields: [], savedViews: [] } };
}
const observation = (story: TeamStory, archived = false) => ({ stage: story.stage, cycleId: story.cycleId ?? null, estimate: story.estimate ?? null, archived });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function snapshot(history: TeamPlanningHistory, board: TeamSnapshot, cycleId: string, at: string): CycleSnapshot {
  const tasks = board.stories.filter((story) => story.cycleId === cycleId && (!history.stories.find((item) => item.id === story.id)?.archivedAt || story.stage === "done"));
  const sum = (stories: TeamStory[]) => stories.reduce((total, story) => total + (story.estimate ?? 0), 0);
  const done = tasks.filter((story) => story.stage === "done");
  return { at, sequence: history.events.at(-1)?.sequence ?? 0, total: tasks.length, completed: done.length, planned: tasks.filter((story) => story.stage === "planned").length, working: tasks.filter((story) => story.stage === "working").length, review: tasks.filter((story) => story.stage === "review").length, points: sum(tasks), completedPoints: sum(done), unestimated: tasks.filter((story) => story.estimate == null).length };
}
/** Derive history once from committed relay events, including edits made by older clients. */
export function advancePlanningHistory(history: TeamPlanningHistory, before: TeamSnapshot, after: TeamSnapshot, event: TeamEvent): void {
  for (const change of event.changes) {
    if (change.collection === "stories") {
      const story = after.stories.find((item) => item.id === change.id), prior = before.stories.find((item) => item.id === change.id);
      let meta = history.stories.find((item) => item.id === change.id);
      if (!story) { history.stories = history.stories.filter((item) => item.id !== change.id); continue; }
      if (!meta) { meta = { id: story.id, createdAt: event.at, updatedAt: event.at, archivedAt: null, category: "Work", checklist: [] }; history.stories.push(meta); }
      meta.updatedAt = event.at;
      const next = observation(story, !!meta.archivedAt), previous = prior ? observation(prior, !!meta.archivedAt) : undefined;
      if (!previous || !same(previous, next)) history.events.push({ id: `relay:${event.id}:${story.id}`, sequence: (history.events.at(-1)?.sequence ?? 0) + 1, taskId: story.id, at: event.at, kind: prior ? "changed" : "created", ...(previous ? { before: previous } : {}), after: next });
    }
    if (change.collection === "cycles") {
      const cycle = after.cycles.find((item) => item.id === change.id), prior = before.cycles.find((item) => item.id === change.id);
      let meta = history.cycles.find((item) => item.id === change.id);
      if (!cycle) { history.cycles = history.cycles.filter((item) => item.id !== change.id); continue; }
      if (!meta) { meta = { id: cycle.id, createdAt: event.at, snapshots: [] }; history.cycles.push(meta); }
      if (cycle.state === "active" && prior?.state !== "active") { meta.startedAt = event.at; meta.baseline = snapshot(history, after, cycle.id, event.at); }
      if (cycle.state === "completed" && prior?.state !== "completed") meta.completedAt = event.at;
    }
    if (change.collection === "comments") {
      const comment = after.comments.find((item) => item.id === change.id);
      if (!comment) continue;
      const prior = history.comments.find((item) => item.id === comment.id);
      const meta = { id: comment.id, createdAt: prior?.createdAt ?? comment.createdAt, updatedAt: event.at, ...(comment.deletedAt ? { deletedAt: event.at } : {}) };
      if (prior) Object.assign(prior, meta); else history.comments.push(meta);
    }
  }
  const changedPlanning = event.changes.some((change) => change.collection === "stories" || change.collection === "cycles") || event.activity?.type === "planning.updated";
  for (const cycle of changedPlanning ? after.cycles : []) {
    const meta = history.cycles.find((item) => item.id === cycle.id);
    if (!meta || (cycle.state === "completed" && !event.changes.some((change) => change.collection === "cycles" && change.id === cycle.id))) continue;
    const next = snapshot(history, after, cycle.id, event.at), prior = meta.snapshots.at(-1);
    const { at: _at, sequence: _sequence, ...counts } = next;
    const { at: _previousAt, sequence: _previousSequence, ...previousCounts } = prior ?? {};
    if (!prior || !same(counts, previousCounts)) meta.snapshots.push(next);
  }
  history.through = event.sequence;
}

export function updatePlanningMetadata(history: TeamPlanningHistory, board: TeamSnapshot, metadata: TeamPlanningMetadata, event: TeamEvent, preserveUnchangedTimestamps = true): void {
  for (const value of metadata.stories) {
    const story = board.stories.find((item) => item.id === value.id), meta = history.stories.find((item) => item.id === value.id);
    if (!story || !meta) throw Error("The shared story no longer exists.");
    const {createdAt: _createdAt, updatedAt: _updatedAt, ...current} = meta;
    if (preserveUnchangedTimestamps && planningValueHash(current) === planningValueHash(value)) continue;
    const before = observation(story, !!meta.archivedAt);
    Object.assign(meta, structuredClone(value), { updatedAt: event.at });
    const after = observation(story, !!meta.archivedAt);
    if (!same(before, after)) history.events.push({ id: `relay:${event.id}:${story.id}`, sequence: (history.events.at(-1)?.sequence ?? 0) + 1, taskId: story.id, at: event.at, kind: "changed", before, after });
  }
  if (metadata.planning) history.planning = structuredClone(metadata.planning);
  advancePlanningHistory(history, board, board, event);
}

export function planningMetadataHasChanges(history: TeamPlanningHistory, metadata: TeamPlanningMetadata): boolean {
  const current = planningMetadata(history);
  return metadata.stories.some((value) => {
    const prior = current.stories.find((item) => item.id === value.id);
    return !prior || planningValueHash(prior) !== planningValueHash(value);
  }) || !!(metadata.planning && planningValueHash(metadata.planning) !== planningValueHash(current.planning));
}

export function planningHistorySeed(history: TeamPlanningHistory): TeamPlanningSeed {
  const {version: _version,workspaceId: _workspaceId,through: _through,import: _import,...seed} = history;
  return seed;
}

export const planningTimestampRepairSchema = z.object({
  workspaceId:id,opId:id,expectedHead:count,
  expectedImportHash:z.string().regex(/^[a-f0-9]{64}$/),
  expectedHistoryHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Only recover original dates from the immutable import, never replace accepted planning. */
export function originalTimestampRepairs(history: TeamPlanningHistory, imported: TeamPlanningSeed): Array<{id:string;from:string;to:string}> {
  const withoutUpdated = (seed:TeamPlanningSeed) => ({...seed,stories:seed.stories.map(({updatedAt: _updatedAt,...story})=>story)});
  if (planningValueHash(withoutUpdated(planningHistorySeed(history))) !== planningValueHash(withoutUpdated(imported))) throw Error("Accepted planning differs from its original import. Automatic timestamp recovery cannot replace those changes.");
  const originals = new Map(imported.stories.map((story)=>[story.id,story.updatedAt]));
  const changes = history.stories.filter((story)=>story.updatedAt!==originals.get(story.id)).map((story)=>({id:story.id,from:story.updatedAt,to:originals.get(story.id)!}));
  if (changes.some((change)=>Date.parse(change.to)>Date.parse(change.from))) throw Error("Timestamp recovery cannot move original dates forward.");
  return changes;
}

/** Replace this shared project's canonical history only; all other projects and local execution survive. */
export function applyPlanningHistory(state: AppState, projectId: string, history: TeamPlanningHistory, binding: TeamIdentityBinding): void {
  if (history.import) state.planning.authoritativeProjects = [...new Set([...(state.planning.authoritativeProjects ?? []), projectId])];
  const local = (kind: Parameters<typeof localTeamId>[1], id: string) => {
    if (kind === "workflow") {
      if (id === backlogStatusId("memcode")) return backlogStatusId(projectId);
      if (id === plannedOutsideCycleId("memcode")) return plannedOutsideCycleId(projectId);
      if (binding.localIds && id.endsWith(":planned")) {
        // Joined projects have private IDs. Preserve the built-in Planned
        // role across older boards and map it back to its original wire ID.
        const standard = `${projectId}:planned`;
        binding.localIds.toLocal[`workflow:${id}`] = standard;
        binding.localIds.toRemote[`workflow:${standard}`] = id;
        return standard;
      }
    }
    return localTeamId(binding, kind, id);
  };
  for (const meta of history.stories) {
    const task = state.tasks.find((item) => item.projectId === projectId && item.id === local("story", meta.id));
    if (task) Object.assign(task, { createdAt: meta.createdAt, updatedAt: meta.updatedAt, archivedAt: meta.archivedAt, category: meta.category, checklist: structuredClone(meta.checklist), relatedIds: meta.relatedIds?.map((id) => local("story", id)), duplicateOf: meta.duplicateOf ? local("story", meta.duplicateOf) : meta.duplicateOf, statusId: meta.statusId ? local("workflow", meta.statusId) : undefined, customFields: meta.customFields ? Object.fromEntries(Object.entries(meta.customFields).map(([id, value]) => [local("field", id), value])) : undefined });
  }
  for (const meta of history.cycles) {
    const cycle = state.cycles.find((item) => item.projectId === projectId && item.id === local("cycle", meta.id));
    if (cycle) { const { id: _id, ...fields } = meta; Object.assign(cycle, structuredClone(fields)); }
  }
  for (const meta of history.comments) {
    const comment = state.storyComments?.find((item) => item.id === local("comment", meta.id));
    if (comment) { const { id: _id, ...fields } = meta; Object.assign(comment, fields); }
  }
  const translateObservation = (value: TeamPlanningSeed["events"][number]["after"]): TaskObservation => ({ ...value, projectId, cycleId: value.cycleId ? local("cycle", value.cycleId) : null });
  const events = history.events.map((event) => ({ ...event, id: binding.localIds ? `team-history:${history.workspaceId}:${event.id}` : event.id, projectId, taskId: local("story", event.taskId), before: event.before ? translateObservation(event.before) : undefined, after: translateObservation(event.after) }));
  state.planning.events = [...state.planning.events.filter((event) => event.projectId !== projectId), ...events].sort((a, b) => a.sequence - b.sequence);
  if (history.startedAt < state.planning.startedAt) state.planning.startedAt = history.startedAt;
  for (const task of state.tasks.filter((task) => task.projectId === projectId)) state.planning.observations[task.id] = { projectId, stage: task.stage, cycleId: task.cycleId ?? null, estimate: task.estimate ?? null, archived: !!task.archivedAt };
  state.workflowStates = [...state.workflowStates.filter((item) => item.projectId !== projectId), ...history.planning.workflowStates.map((value) => ({ ...value, id: local("workflow", value.id), projectId }))];
  state.customFields = [...state.customFields.filter((item) => item.projectId !== projectId), ...history.planning.customFields.map((value) => ({ ...value, id: local("field", value.id), projectId }))];
  state.savedViews = [...state.savedViews.filter((item) => item.projectId !== projectId), ...history.planning.savedViews.map((value) => ({ ...value, id: local("view", value.id), projectId, filters: { ...value.filters, epicId: value.filters.epicId === "all" ? "all" : local("epic", value.filters.epicId), cycleId: value.filters.cycleId === "all" ? "all" : local("cycle", value.filters.cycleId) } }))];
}

export const planningMetadata = (seed: TeamPlanningSeed): TeamPlanningMetadata => ({ stories: seed.stories.map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...value }) => value), planning: seed.planning });
