import { z } from "zod";
import type {
  TeamSessions,
  TeamSession,
  SessionActor,
  SessionCommand,
} from "../../src/team-session";
import type { TeamSnapshot } from "../../src/team";
import { teamId, TeamProtocolError } from "./protocol";

const at = z.string().datetime();
const actor = z
  .object({
    memberId: teamId,
    deviceId: teamId,
    name: z.string().max(240),
    device: z.string().max(240),
  })
  .strict();
const message = z
  .object({
    id: teamId,
    role: z.enum(["user", "assistant", "system", "tool"]),
    text: z.string().max(100000),
    at,
    streamId: z.string().max(250).optional(),
    actor: actor.optional(),
    sourceCommandId: teamId.optional(),
    promptedAt: at.optional(),
    pickedUpAt: at.optional(),
    queuedAt: at.optional(),
    queueOrder: z.number().optional(),
    followupState: z
      .enum(["queued", "paused", "included", "cancelled"])
      .optional(),
  })
  .strict();
// Reports are saved JSON, never interpreted as code or used to select a local checkout.
const review = z.custom<NonNullable<TeamSession["review"]>>(
  (v: any) =>
    !!v &&
    v.version === 1 &&
    typeof v.id === "string" &&
    typeof v.taskId === "string" &&
    Array.isArray(v.metrics) &&
    Array.isArray(v.findings) &&
    Array.isArray(v.phases) &&
    Array.isArray(v.messages) &&
    !!v.snapshot &&
    !!v.coverage &&
    !!v.impact &&
    Array.isArray(v.checks) &&
    ["queued", "running", "completed", "cancelled", "failed", "stale"].includes(
      v.state,
    ) &&
    typeof v.updatedAt === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.coverage.complete === "boolean" &&
    Array.isArray(v.coverage.limitations) &&
    v.coverage.limitations.every((s: unknown) => typeof s === "string") &&
    Array.isArray(v.snapshot.files) &&
    typeof v.snapshot.id === "string" &&
    typeof v.snapshot.branch === "string" &&
    v.snapshot.files.every(
      (f: any) =>
        !!f && typeof f.path === "string" && typeof f.attribution === "string",
    ) &&
    v.metrics.length <= 10000 &&
    v.metrics.every(
      (m: any) =>
        !!m &&
        typeof m.symbol === "string" &&
        typeof m.path === "string" &&
        [m, ...(m.before ? [m.before] : [])].every((side: any) =>
          [
            "cognitive",
            "cyclomatic",
            "nesting",
            "maintainabilityIndex",
            "halsteadVolume",
          ].every(
            (k) =>
              side[k] == null ||
              (typeof side[k] === "number" && Number.isFinite(side[k])),
          ),
        ),
    ) &&
    v.messages.length <= 10000 &&
    v.messages.every(
      (m: any) =>
        !!m &&
        typeof m.id === "string" &&
        typeof m.text === "string" &&
        typeof m.at === "string" &&
        ["user", "assistant", "system", "tool"].includes(m.role),
    ) &&
    v.findings.every(
      (f: any) =>
        !!f &&
        typeof f.id === "string" &&
        typeof f.title === "string" &&
        typeof f.explanation === "string" &&
        ["critical", "high", "medium", "low", "info"].includes(f.severity),
    ) &&
    v.phases.every(
      (p: any) =>
        !!p && typeof p.id === "string" && typeof p.state === "string",
    ) &&
    v.checks.every(
      (c: any) =>
        !!c &&
        typeof c.name === "string" &&
        ["passed", "failed", "unavailable"].includes(c.state),
    ),
);
export const sessionPayload = z
  .object({
    id: teamId,
    storyId: teamId,
    epoch: z.number().int().positive(),
    harness: z.enum(["claude", "codex", "cursor", "copilot", "dsh"]),
    requestedModel: z.string().max(200).optional(),
    actualModel: z.string().max(200).optional(),
    route: z
      .custom<TeamSession["route"]>(
        (v: any) =>
          !!v &&
          v.policyVersion === "memcode-envelope-v2" &&
          !!v.inputs &&
          Array.isArray(v.reasons),
      )
      .optional(),
    state: z.enum([
      "idle",
      "preparing",
      "running",
      "stopping",
      "stopped",
      "blocked",
      "failed",
      "finished",
    ]),
    startedAt: at.optional(),
    finishedAt: at.optional(),
    error: z.string().max(8000).optional(),
    activity: z
      .object({
        phase: z.string().max(100),
        label: z.string().max(1000),
        updatedAt: at,
      })
      .strict()
      .optional(),
    messages: z.array(message).max(10000),
    review: review.optional(),
  })
  .strict();
export const sessionPublish = z
  .object({
    workspaceId: teamId,
    expectedRevision: z.number().int().nonnegative(),
    delta: z.boolean().optional(),
    session: sessionPayload,
  })
  .strict();
export const sessionCommandInput = z
  .object({
    workspaceId: teamId,
    id: teamId,
    sessionId: teamId,
    kind: z.enum(["followup", "review-question", "review-start"]),
    text: z.string().trim().min(1).max(100000),
    reviewRunId: teamId.optional(),
  })
  .strict();
export const sessionCommandEdit = z
  .object({
    workspaceId: teamId,
    id: teamId,
    expectedRevision: z.number().int().positive(),
    text: z.string().trim().min(1).max(100000).optional(),
    cancel: z.boolean().optional(),
  })
  .strict();
export const sessionReceipt = z
  .object({
    workspaceId: teamId,
    id: teamId,
    state: z.enum(["received", "picked-up", "failed"]),
    error: z.string().max(2000).optional(),
  })
  .strict();
export type SessionRecord =
  | { kind: "worker_session"; session: TeamSession; delta?: boolean }
  | { kind: "worker_command"; command: SessionCommand };
export const emptySessions = (): TeamSessions => ({
  version: 1,
  cursor: 0,
  sessions: [],
  commands: [],
});
export function applySessionRecord(state: TeamSessions, record: SessionRecord) {
  if (record.kind === "worker_session") {
    const index = state.sessions.findIndex((s) => s.id === record.session.id);
    if (index < 0) state.sessions.push(record.session);
    else if (record.delta) {
      const previous = state.sessions[index];
      const incoming = new Map(record.session.messages.map((m) => [m.id, m]));
      const messages = previous.messages.map((m) => {
        const next = incoming.get(m.id);
        incoming.delete(m.id);
        return next ?? m;
      });
      messages.push(...incoming.values());
      state.sessions[index] = {
        ...previous,
        ...record.session,
        messages,
        review: record.session.review ?? previous.review,
      };
    } else state.sessions[index] = record.session;
    state.cursor = record.session.sequence;
  } else {
    const index = state.commands.findIndex((c) => c.id === record.command.id);
    if (index < 0) state.commands.push(record.command);
    else state.commands[index] = record.command;
    state.cursor = record.command.sequence;
  }
}
function reject(code: string, text: string, status = 409): never {
  throw new TeamProtocolError(code, text, undefined, status);
}
export function sessionActor(
  board: TeamSnapshot,
  identity: { memberId: string; deviceId: string },
): SessionActor {
  const member = board.members.find((m) => m.id === identity.memberId);
  const device = member?.devices.find((d) => d.id === identity.deviceId);
  if (!member || !device)
    reject(
      "SESSION_MEMBER",
      "This Team membership or device is no longer active.",
      403,
    );
  return {
    memberId: member.id,
    name: member.name,
    deviceId: device.id,
    device: device.name,
  };
}
function same(a: SessionActor, b: SessionActor) {
  return a.memberId === b.memberId && a.deviceId === b.deviceId;
}
export function latestSession(state: TeamSessions, storyId: string) {
  return state.sessions
    .filter((s) => s.storyId === storyId)
    .sort((a, b) => b.epoch - a.epoch)[0];
}
function currentSession(
  state: TeamSessions,
  board: TeamSnapshot,
  id: string,
  continuation = false,
): TeamSession {
  const session = state.sessions.find((s) => s.id === id);
  const latest = session && latestSession(state, session.storyId);
  if (
    !session ||
    (latest?.id !== id &&
      !(continuation && latest && same(latest.owner, session.owner)))
  )
    reject(
      "SESSION_CHANGED",
      "This worker session has been replaced. Open the current session before sending.",
    );
  const claim = board.claims.find((c) => c.storyId === session.storyId);
  if (
    claim &&
    (claim.attemptId !== session.id || claim.epoch !== session.epoch) &&
    !(
      continuation &&
      claim.memberId === session.owner.memberId &&
      claim.deviceId === session.owner.deviceId
    )
  )
    reject("SESSION_CHANGED", "Another worker now owns this task.");
  if (!board.stories.some((s) => s.id === session.storyId))
    reject("SESSION_STORY", "This task was removed.", 404);
  return session;
}
export function publishSession(
  state: TeamSessions,
  board: TeamSnapshot,
  who: SessionActor,
  input: z.infer<typeof sessionPublish>,
  now: string,
): SessionRecord {
  const value = input.session,
    previous = state.sessions.find((s) => s.id === value.id);
  const claim = board.claims.find((c) => c.storyId === value.storyId);
  if (!previous) {
    if (
      !claim ||
      claim.attemptId !== value.id ||
      claim.epoch !== value.epoch ||
      claim.memberId !== who.memberId ||
      claim.deviceId !== who.deviceId
    )
      reject(
        "SESSION_OWNER",
        "A confirmed task claim is required to publish its worker session.",
        403,
      );
  } else {
    currentSession(state, board, previous.id);
    if (
      !same(previous.owner, who) ||
      previous.storyId !== value.storyId ||
      previous.epoch !== value.epoch
    )
      reject(
        "SESSION_OWNER",
        "Only this session's executing device may publish it.",
        403,
      );
  }
  if ((previous?.revision ?? 0) !== input.expectedRevision)
    reject(
      "SESSION_REVISION",
      "A newer worker update is already saved; refresh before publishing.",
    );
  if (new Set(value.messages.map((m) => m.id)).size !== value.messages.length)
    reject(
      "SESSION_MESSAGES",
      "A message identifier may occur only once.",
      400,
    );
  const messages = value.messages.map((m) => {
    const command =
      m.sourceCommandId &&
      state.commands.find(
        (c) =>
          c.id === m.sourceCommandId &&
          c.storyId === value.storyId &&
          c.kind === "followup",
      );
    const prior = previous?.messages.find((p) => p.id === m.id);
    // The relay stamps authors. An executing device cannot impersonate another teammate.
    if (m.sourceCommandId && (!command || m.role !== "user"))
      reject(
        "SESSION_COMMAND",
        "A shared input must reference its authenticated follow-up.",
        400,
      );
    return { ...m, actor: command ? command.author : (prior?.actor ?? who) };
  });
  const report = value.review && {
    ...value.review,
    messages: value.review.messages.map((m) => {
      const command = state.commands.find(
        (c) =>
          c.id === m.id &&
          c.kind === "review-question" &&
          c.storyId === value.storyId &&
          c.reviewRunId === value.review!.id,
      );
      return {
        ...m,
        actor: command
          ? command.author
          : (previous?.review?.messages.find((p) => p.id === m.id)?.actor ??
            who),
      };
    }),
  };
  return {
    kind: "worker_session",
    delta: input.delta,
    session: {
      ...value,
      messages,
      ...(report ? { review: report } : {}),
      owner: previous?.owner ?? who,
      revision: (previous?.revision ?? 0) + 1,
      sequence: state.cursor + 1,
      updatedAt: now,
    },
  };
}
export function addSessionCommand(
  state: TeamSessions,
  board: TeamSnapshot,
  who: SessionActor,
  input: z.infer<typeof sessionCommandInput>,
  now: string,
): SessionRecord {
  const prior = state.commands.find((c) => c.id === input.id);
  if (prior) {
    if (
      prior.author.memberId !== who.memberId ||
      prior.author.deviceId !== who.deviceId ||
      prior.sessionId !== input.sessionId ||
      prior.kind !== input.kind ||
      prior.reviewRunId !== input.reviewRunId
    )
      reject(
        "SESSION_COMMAND_ID",
        "This follow-up identifier was already used.",
      );
    return { kind: "worker_command", command: prior };
  }
  const session = currentSession(state, board, input.sessionId);
  if (
    input.kind === "review-question" &&
    (!input.reviewRunId || session.review?.id !== input.reviewRunId)
  )
    reject(
      "SESSION_REVIEW",
      "Open the current review before asking a question.",
    );
  if (
    state.commands.filter(
      (c) =>
        c.sessionId === session.id && ["queued", "received"].includes(c.state),
    ).length >= 200
  )
    reject(
      "SESSION_QUEUE_LIMIT",
      "This session already has 200 waiting follow-ups. Edit or cancel one first.",
    );
  return {
    kind: "worker_command",
    command: {
      id: input.id,
      sessionId: session.id,
      storyId: session.storyId,
      epoch: session.epoch,
      kind: input.kind,
      text: input.text,
      reviewRunId: input.reviewRunId,
      author: who,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      sequence: state.cursor + 1,
      state: "queued",
    },
  };
}
export function editSessionCommand(
  state: TeamSessions,
  who: SessionActor,
  input: z.infer<typeof sessionCommandEdit>,
  now: string,
): SessionRecord {
  const command = state.commands.find((c) => c.id === input.id);
  if (!command) reject("SESSION_COMMAND", "Follow-up not found.", 404);
  if (command.author.memberId !== who.memberId)
    reject(
      "SESSION_AUTHOR",
      "Only its author may edit or cancel this follow-up.",
      403,
    );
  if (
    (input.cancel && command.state === "cancelled") ||
    (!input.cancel &&
      input.text === command.text &&
      command.revision > input.expectedRevision)
  )
    return { kind: "worker_command", command };
  if (!["queued", "received"].includes(command.state))
    reject(
      "SESSION_PICKED_UP",
      "The worker already picked up this follow-up. Send a new one instead.",
    );
  if (command.revision !== input.expectedRevision)
    reject(
      "SESSION_REVISION",
      "This follow-up changed. Refresh its latest version before editing.",
    );
  return {
    kind: "worker_command",
    command: {
      ...command,
      text: input.text ?? command.text,
      state: input.cancel ? "cancelled" : command.state,
      updatedAt: now,
      revision: command.revision + 1,
      sequence: state.cursor + 1,
    },
  };
}
export function receiptSessionCommand(
  state: TeamSessions,
  board: TeamSnapshot,
  who: SessionActor,
  input: z.infer<typeof sessionReceipt>,
  now: string,
): SessionRecord {
  const command = state.commands.find((c) => c.id === input.id);
  if (!command) reject("SESSION_COMMAND", "Follow-up not found.", 404);
  const session = currentSession(state, board, command.sessionId, true);
  if (!same(session.owner, who))
    reject(
      "SESSION_OWNER",
      "Only the executing device may acknowledge this follow-up.",
      403,
    );
  if (
    command.state === "cancelled" ||
    command.state === "failed" ||
    command.state === input.state ||
    (command.state === "picked-up" && input.state === "received")
  )
    return { kind: "worker_command", command };
  return {
    kind: "worker_command",
    command: {
      ...command,
      state: input.state,
      updatedAt: now,
      ...(input.state === "received"
        ? { receivedAt: now }
        : input.state === "picked-up"
          ? { pickedUpAt: now }
          : {
              error:
                input.error ?? "The host could not deliver this follow-up.",
            }),
      revision: command.revision + 1,
      sequence: state.cursor + 1,
    },
  };
}
