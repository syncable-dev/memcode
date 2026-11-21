import { z } from "zod";
import type {
  TeamChange,
  TeamCommand,
  TeamEvent,
  TeamMember,
  TeamSnapshot,
} from "../../src/team";

export const teamId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const text = z.string().max(20000),
  title = z.string().trim().min(1).max(240);
const revision = z.number().int().nonnegative();
export const portablePath = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      !/[\x00-\x1f]/.test(value) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Use a project-relative path with forward slashes.",
  );
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const memberSchema = z
  .object({
    id: teamId,
    name: title,
    role: z.enum(["owner", "editor"]),
    devices: z.array(z.object({ id: teamId, name: title }).strict()).max(20),
    joinedAt: z.string().max(50),
  })
  .strict();
const storySchema = z
  .object({
    id: teamId,
    identifier: title,
    title,
    description: text,
    stage: z.enum(["planned", "working", "review", "done"]),
    priority: z.enum(["high", "medium", "low"]),
    kind: z.enum(["feature", "fix", "refactor", "research", "test"]).optional(),
    epicId: teamId.nullable().optional(),
    cycleId: teamId.nullable().optional(),
    parentId: teamId.nullable().optional(),
    estimate: z.number().finite().min(0).max(10000).nullable().optional(),
    startDate: date.nullable().optional(),
    dueDate: date.nullable().optional(),
    labels: z.array(z.string().max(100)).max(30).optional(),
    scope: z.array(portablePath).max(200).optional(),
    dependsOn: z.array(teamId).max(200).optional(),
    assignedMemberId: teamId.nullable().optional(),
    revision: revision.optional(),
  })
  .strict();
const epicSchema = z
  .object({
    id: teamId,
    identifier: title,
    title,
    description: text,
    phase: z.enum(["now", "next", "later"]),
    color: z.enum(["mint", "cyan", "lavender", "amber"]),
    order: z.number().finite(),
    branch: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (v) =>
          !v.startsWith("/") &&
          !v.includes("\\") &&
          !v.includes("..") &&
          !/^[A-Za-z]:/.test(v),
      )
      .optional(),
    baseRevision: z
      .string()
      .regex(/^[a-f0-9]{7,64}$/i)
      .optional(),
    revision: revision.optional(),
  })
  .strict();
const cycleSchema = z
  .object({
    id: teamId,
    name: title,
    description: text,
    startDate: date,
    endDate: date,
    state: z.enum(["upcoming", "active", "completed"]),
    timezone: z.string().max(100).optional(),
    capacity: z.number().finite().min(0).max(100000).nullable().optional(),
    calendar: z.enum(["weekdays", "calendar"]).optional(),
    revision: revision.optional(),
  })
  .strict();
export const teamReferenceSchema = z
  .object({
    kind: z.enum(["file", "artifact", "changes", "terminal"]),
    name: title,
    quote: z.string().max(20000),
    path: portablePath.optional(),
    resultId: teamId.optional(),
    revision: z.string().max(200).optional(),
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    page: z.number().int().positive().optional(),
    sheet: z.string().max(200).optional(),
    range: z.string().max(100).optional(),
    selector: z.string().max(1000).optional(),
  })
  .strict();
const commentSchema = z
  .object({
    id: teamId,
    storyId: teamId,
    body: text,
    parentId: teamId.optional(),
    memberId: teamId,
    createdAt: z.string().max(50),
    updatedAt: z.string().max(50),
    deletedAt: z.string().max(50).optional(),
    revision: revision.optional(),
    reference: teamReferenceSchema.optional(),
  })
  .strict();
const claimSchema = z
  .object({
    storyId: teamId,
    attemptId: teamId,
    epoch: z.number().int().positive(),
    memberId: teamId,
    deviceId: teamId,
    acquiredAt: z.string().max(50),
  })
  .strict();
export const resultDraftSchema = z
  .object({
    id: teamId,
    storyId: teamId,
    attemptId: teamId.optional(),
    name: title.refine(
      (v) => !/[\\/:\x00-\x1f]/.test(v) && v !== "." && v !== "..",
      "Use a filename, not a local path.",
    ),
    mime: z
      .string()
      .regex(/^[\w.+-]+\/[\w.+-]+$/)
      .max(100),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .min(0)
      .max(5 * 1024 * 1024),
    kind: z.enum(["report", "artifact", "patch"]),
    description: z.string().max(2000).optional(),
  })
  .strict();
const resultSchema = resultDraftSchema.extend({
  memberId: teamId,
  deviceId: teamId,
  createdAt: z.string().max(50),
});
const activitySchema = z
  .object({
    id: teamId,
    sequence: revision,
    memberId: teamId,
    deviceId: teamId,
    type: z.string().max(80),
    entityId: teamId.optional(),
    summary: z.string().max(500),
    at: z.string().max(50),
  })
  .strict();
const cursorSchema = z.object({ memberId: teamId, through: revision }).strict();
export const teamSnapshotSchema = z
  .object({
    workspaceId: teamId,
    name: title,
    head: revision,
    members: z.array(memberSchema).max(100),
    stories: z.array(storySchema).max(2000),
    epics: z.array(epicSchema).max(500),
    cycles: z.array(cycleSchema).max(500),
    comments: z.array(commentSchema).max(5000),
    claims: z.array(claimSchema).max(2000),
    results: z.array(resultSchema).max(2000),
    activity: z.array(activitySchema).max(200),
    readCursors: z.array(cursorSchema).max(100),
  })
  .strict();
const changeSchema = z.discriminatedUnion("collection", [
  z
    .object({
      collection: z.literal("members"),
      id: teamId,
      value: memberSchema.nullable(),
    })
    .strict(),
  z
    .object({
      collection: z.literal("stories"),
      id: teamId,
      value: storySchema.nullable(),
    })
    .strict(),
  z
    .object({
      collection: z.literal("epics"),
      id: teamId,
      value: epicSchema.nullable(),
    })
    .strict(),
  z
    .object({
      collection: z.literal("cycles"),
      id: teamId,
      value: cycleSchema.nullable(),
    })
    .strict(),
  z
    .object({
      collection: z.literal("comments"),
      id: teamId,
      value: commentSchema.nullable(),
    })
    .strict(),
  z
    .object({
      collection: z.literal("claims"),
      id: teamId,
      value: claimSchema.nullable(),
    })
    .strict(),
  z
    .object({
      collection: z.literal("results"),
      id: teamId,
      value: resultSchema.nullable(),
    })
    .strict(),
  z
    .object({
      collection: z.literal("readCursors"),
      id: teamId,
      value: cursorSchema.nullable(),
    })
    .strict(),
]);
export const teamEventSchema = z
  .object({
    id: teamId,
    sequence: revision,
    opId: teamId,
    memberId: teamId,
    deviceId: teamId,
    at: z.string().max(50),
    changes: z.array(changeSchema).max(5000),
    activity: activitySchema.optional(),
  })
  .strict();
export const teamSyncReplySchema = z
  .object({
    version: z.literal(1),
    snapshot: teamSnapshotSchema.optional(),
    events: z.array(teamEventSchema).max(500),
    head: revision,
    cursor: revision,
    hasMore: z.boolean(),
  })
  .strict();
export const teamSessionReplySchema = z
  .object({
    credential: z
      .object({
        workspaceId: teamId,
        memberId: teamId,
        deviceId: teamId,
        capability: z.string().min(32).max(200),
      })
      .strict(),
    snapshot: teamSnapshotSchema,
    identity: z.enum(["invite-preview", "memtrace"]),
  })
  .strict();
export const teamCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("story.put"),
      story: storySchema,
      expectedRevision: revision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("story.patch"),
      storyId: teamId,
      patch: storySchema.omit({ id: true, revision: true }).partial(),
      expectedRevision: revision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("story.delete"),
      storyId: teamId,
      expectedRevision: revision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("epic.put"),
      epic: epicSchema,
      expectedRevision: revision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("epic.delete"),
      epicId: teamId,
      expectedRevision: revision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("cycle.put"),
      cycle: cycleSchema,
      expectedRevision: revision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("cycle.delete"),
      cycleId: teamId,
      expectedRevision: revision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("comment.add"),
      commentId: teamId,
      storyId: teamId,
      body: text.min(1),
      parentId: teamId.optional(),
      reference: teamReferenceSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("comment.edit"),
      commentId: teamId,
      body: text.min(1),
      expectedRevision: revision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("comment.delete"),
      commentId: teamId,
      expectedRevision: revision.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("claim.acquire"),
      storyId: teamId,
      attemptId: teamId,
    })
    .strict(),
  z
    .object({
      type: z.literal("claim.release"),
      storyId: teamId,
      attemptId: teamId,
      epoch: z.number().int().positive(),
    })
    .strict(),
  z
    .object({ type: z.literal("result.publish"), result: resultDraftSchema })
    .strict(),
  z.object({ type: z.literal("member.read"), through: revision }).strict(),
]);
export class TeamProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function emptyTeamSnapshot(
  workspaceId: string,
  name: string,
  owner: TeamMember,
): TeamSnapshot {
  return {
    workspaceId,
    name,
    head: 0,
    members: [owner],
    stories: [],
    epics: [],
    cycles: [],
    comments: [],
    claims: [],
    results: [],
    activity: [],
    readCursors: [],
  };
}
/** Apply only ordered portable changes; duplicate deliveries preserve object identity. */
export function applyTeamEvent(
  snapshot: TeamSnapshot,
  event: TeamEvent,
): TeamSnapshot {
  if (event.sequence <= snapshot.head) return snapshot;
  if (event.sequence !== snapshot.head + 1)
    throw new TeamProtocolError(
      "GAP",
      "Fetch missing workspace changes before applying this event.",
    );
  const next = { ...snapshot, head: event.sequence };
  const lists = next as unknown as Record<
    string,
    Array<Record<string, unknown>>
  >;
  for (const change of event.changes) {
    const key =
      change.collection === "claims"
        ? "storyId"
        : change.collection === "readCursors"
          ? "memberId"
          : "id";
    const list = lists[change.collection];
    const remaining = list.filter((value) => value[key] !== change.id);
    lists[change.collection] =
      change.value === null
        ? remaining
        : [...remaining, change.value as unknown as Record<string, unknown>];
  }
  if (event.activity)
    next.activity = [...snapshot.activity, event.activity].slice(-200);
  return next;
}
export function teamEvent(
  snapshot: TeamSnapshot,
  actor: { memberId: string; deviceId: string },
  opId: string,
  at: string,
  changes: TeamChange[],
  summary?: string,
  type = "changed",
  entityId?: string,
): TeamEvent {
  const sequence = snapshot.head + 1;
  const id = `event-${sequence}`;
  return {
    id,
    sequence,
    opId,
    ...actor,
    at,
    changes,
    ...(summary
      ? {
          activity: {
            id,
            sequence,
            ...actor,
            type,
            ...(entityId ? { entityId } : {}),
            summary,
            at,
          },
        }
      : {}),
  };
}
function availableIdentifier(value: string, used: string[]): string {
  if (!used.includes(value)) return value;
  const match = /^(.*?)(\d+)$/.exec(value);
  const prefix =
    match && Number.isSafeInteger(Number(match[2]) + 2001) ? match : undefined;
  let number = prefix ? Number(prefix[2]) + 1 : 2;
  const candidate = () => {
    const suffix = prefix
      ? String(number).padStart(prefix[2].length, "0")
      : `-${number}`;
    return (prefix ? prefix[1] : value).slice(0, 240 - suffix.length) + suffix;
  };
  while (used.includes(candidate())) number++;
  return candidate();
}
export function executeTeamCommand(
  snapshot: TeamSnapshot,
  actor: { memberId: string; deviceId: string },
  input: TeamCommand,
  opId: string,
  at: string,
): TeamEvent {
  const command = teamCommandSchema.parse(input) as TeamCommand;
  const changes: TeamChange[] = [];
  let summary = "",
    entityId: string | undefined;
  const error = (
    code: string,
    message: string,
    details?: unknown,
    status = 409,
  ): never => {
    throw new TeamProtocolError(code, message, details, status);
  };
  const story = (id: string) =>
    snapshot.stories.find((item) => item.id === id) ??
    error("NOT_FOUND", "Task not found.");
  const expected = (
    current: { revision?: number } | undefined,
    value?: number,
  ) => {
    if (value !== undefined && value !== (current?.revision ?? 0))
      error("REVISION", "This item changed. Refresh it before saving.", {
        revision: current?.revision ?? 0,
      });
  };
  const put = (
    collection: "stories" | "epics" | "cycles",
    value: Record<string, unknown>,
    expectedRevision?: number,
  ) => {
    const old = snapshot[collection].find((item) => item.id === value.id);
    expected(old, expectedRevision);
    if (
      !old &&
      snapshot[collection].length >= (collection === "stories" ? 2000 : 500)
    )
      error("LIMIT", "This workspace has reached the preview item limit.");
    changes.push({
      collection,
      id: String(value.id),
      value: {
        ...value,
        revision: (old?.revision ?? 0) + 1,
      } as unknown as TeamChange["value"],
    });
  };
  const checkStory = (value: (typeof snapshot.stories)[number]) => {
    if (
      value.epicId &&
      !snapshot.epics.some((item) => item.id === value.epicId)
    )
      error("REFERENCE", "Choose a goal in this workspace.");
    if (
      value.cycleId &&
      !snapshot.cycles.some((item) => item.id === value.cycleId)
    )
      error("REFERENCE", "Choose a cycle in this workspace.");
    if (
      value.parentId &&
      (value.parentId === value.id ||
        !snapshot.stories.some((item) => item.id === value.parentId))
    )
      error("REFERENCE", "Choose a different parent task in this workspace.");
    if (
      value.assignedMemberId &&
      !snapshot.members.some((item) => item.id === value.assignedMemberId)
    )
      error("REFERENCE", "Choose a member of this workspace.");
    if (
      snapshot.stories.some(
        (item) => item.id !== value.id && item.identifier === value.identifier,
      )
    )
      error("IDENTIFIER", "This task identifier is already used.");
  };
  switch (command.type) {
    case "story.put": {
      const value = { ...command.story };
      if (!snapshot.stories.some((item) => item.id === value.id))
        value.identifier = availableIdentifier(
          value.identifier,
          snapshot.stories.map((item) => item.identifier),
        );
      checkStory(value);
      put("stories", value, command.expectedRevision);
      entityId = value.id;
      summary = `Updated ${value.identifier}: ${value.title}`;
      break;
    }
    case "story.patch": {
      const current = story(command.storyId),
        value = { ...current, ...command.patch };
      checkStory(value);
      put("stories", value, command.expectedRevision);
      entityId = value.id;
      summary = `Updated ${value.identifier}: ${value.title}`;
      break;
    }
    case "story.delete": {
      const current = story(command.storyId);
      expected(current, command.expectedRevision);
      const claim = snapshot.claims.find((item) => item.storyId === current.id);
      if (claim)
        error("CLAIMED", "Release this task's worker before deleting it.", {
          claim,
        });
      changes.push({ collection: "stories", id: current.id, value: null });
      entityId = current.id;
      summary = `Deleted ${current.identifier}`;
      break;
    }
    case "epic.put": {
      const value = { ...command.epic };
      const others = snapshot.epics.filter((item) => item.id !== value.id);
      if (!snapshot.epics.some((item) => item.id === value.id))
        value.identifier = availableIdentifier(
          value.identifier,
          others.map((item) => item.identifier),
        );
      else if (others.some((item) => item.identifier === value.identifier))
        error("IDENTIFIER", "This goal identifier is already used.");
      put("epics", value, command.expectedRevision);
      entityId = value.id;
      summary = `Updated goal ${value.title}`;
      break;
    }
    case "cycle.put":
      if (command.cycle.endDate < command.cycle.startDate)
        error("VALIDATION", "Cycle end must follow its start.");
      put("cycles", { ...command.cycle }, command.expectedRevision);
      entityId = command.cycle.id;
      summary = `Updated cycle ${command.cycle.name}`;
      break;
    case "epic.delete":
    case "cycle.delete": {
      const epic = command.type === "epic.delete",
        collection = epic ? "epics" : "cycles",
        id = epic ? command.epicId : command.cycleId;
      const old = snapshot[collection].find((item) => item.id === id);
      if (!old) error("NOT_FOUND", "Planning item not found.");
      expected(old, command.expectedRevision);
      const field = epic ? "epicId" : "cycleId";
      for (const item of snapshot.stories.filter(
        (item) => item[field] === id,
      )) {
        if (epic && snapshot.claims.some((claim) => claim.storyId === item.id))
          error("CLAIMED", "Release this goal's active task workers first.");
        put("stories", { ...item, [field]: null });
      }
      changes.push({ collection, id, value: null });
      entityId = id;
      summary = `Deleted ${epic ? "goal" : "cycle"}`;
      break;
    }
    case "comment.add": {
      story(command.storyId);
      if (snapshot.comments.some((item) => item.id === command.commentId))
        error("EXISTS", "Comment already exists.");
      if (snapshot.comments.length >= 5000)
        error("LIMIT", "This workspace has reached its preview comment limit.");
      if (
        command.parentId &&
        !snapshot.comments.some(
          (item) =>
            item.id === command.parentId && item.storyId === command.storyId,
        )
      )
        error("REFERENCE", "Reply to a comment on this task.");
      changes.push({
        collection: "comments",
        id: command.commentId,
        value: {
          id: command.commentId,
          storyId: command.storyId,
          body: command.body,
          memberId: actor.memberId,
          createdAt: at,
          updatedAt: at,
          revision: 1,
          ...(command.parentId ? { parentId: command.parentId } : {}),
          ...(command.reference ? { reference: command.reference } : {}),
        },
      });
      entityId = command.storyId;
      summary = `Commented on ${story(command.storyId).identifier}`;
      break;
    }
    case "comment.edit":
    case "comment.delete": {
      const old =
        snapshot.comments.find(
          (item) => item.id === command.commentId && !item.deletedAt,
        ) ?? error("NOT_FOUND", "Comment not found.");
      if (old.memberId !== actor.memberId)
        error(
          "FORBIDDEN",
          "Only the comment author can edit it.",
          undefined,
          403,
        );
      expected(old, command.expectedRevision);
      changes.push({
        collection: "comments",
        id: old.id,
        value: {
          ...old,
          body: command.type === "comment.edit" ? command.body : "",
          updatedAt: at,
          revision: (old.revision ?? 0) + 1,
          ...(command.type === "comment.delete" ? { deletedAt: at } : {}),
        },
      });
      entityId = old.storyId;
      summary =
        command.type === "comment.edit"
          ? "Edited a comment"
          : "Deleted a comment";
      break;
    }
    case "claim.acquire": {
      story(command.storyId);
      const old = snapshot.claims.find(
        (item) => item.storyId === command.storyId,
      );
      if (
        old &&
        (old.memberId !== actor.memberId ||
          old.deviceId !== actor.deviceId ||
          old.attemptId !== command.attemptId)
      )
        error("CLAIMED", "Another worker owns this task.", { claim: old });
      const claim = old ?? {
        storyId: command.storyId,
        attemptId: command.attemptId,
        memberId: actor.memberId,
        deviceId: actor.deviceId,
        acquiredAt: at,
        epoch: snapshot.head + 1,
      };
      changes.push({ collection: "claims", id: command.storyId, value: claim });
      entityId = command.storyId;
      if (!old) summary = `Claimed ${story(command.storyId).identifier}`;
      break;
    }
    case "claim.release": {
      const old =
        snapshot.claims.find((item) => item.storyId === command.storyId) ??
        error("NOT_FOUND", "This task has no active claim.");
      if (
        old.memberId !== actor.memberId ||
        old.deviceId !== actor.deviceId ||
        old.attemptId !== command.attemptId ||
        old.epoch !== command.epoch
      )
        error(
          "FENCED",
          "Only the owning device and current attempt can release this claim.",
          { claim: old },
          403,
        );
      changes.push({ collection: "claims", id: command.storyId, value: null });
      entityId = command.storyId;
      summary = `Released ${story(command.storyId).identifier}`;
      break;
    }
    case "result.publish": {
      story(command.result.storyId);
      if (snapshot.results.some((item) => item.id === command.result.id))
        error("EXISTS", "This result has already been published.");
      if (snapshot.results.length >= 2000)
        error("LIMIT", "This workspace has reached its preview result limit.");
      changes.push({
        collection: "results",
        id: command.result.id,
        value: {
          ...command.result,
          memberId: actor.memberId,
          deviceId: actor.deviceId,
          createdAt: at,
        },
      });
      entityId = command.result.storyId;
      summary = `Published ${command.result.name}`;
      break;
    }
    case "member.read":
      if (command.through > snapshot.head)
        error("CURSOR", "Cannot mark future changes as read.");
      changes.push({
        collection: "readCursors",
        id: actor.memberId,
        value: {
          memberId: actor.memberId,
          through: Math.max(
            command.through,
            snapshot.readCursors.find(
              (item) => item.memberId === actor.memberId,
            )?.through ?? 0,
          ),
        },
      });
      break;
  }
  return teamEvent(
    snapshot,
    actor,
    opId,
    at,
    changes,
    summary || undefined,
    command.type,
    entityId,
  );
}
