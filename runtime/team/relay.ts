import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { TeamSpaceStore } from "./spaces";
import { acceptWorkerReport, workerReport } from "./worker-activity";
import { emptySessions, applySessionRecord, sessionPublish, sessionCommandInput, sessionCommandEdit, sessionReceipt, sessionActor, publishSession, addSessionCommand, editSessionCommand, receiptSessionCommand, type SessionRecord } from "./session-protocol";
import type { TeamSessions } from "../../src/team-session";
import { createMemtraceIdentityVerifier, teamIdentityAudience, type TeamIdentityChallenge, type TeamIdentityProofVerifier } from "../team-identity";
import { sanitizeRepositoryURL } from "../repository-onboarding";
import { teamInvitationLanding } from "./landing";
import { advancePlanningHistory, emptyPlanningHistory, planningImportSchema, planningMetadataSchema, planningMetadata, planningMetadataHasChanges, planningTimestampRepairSchema, planningHistorySeed, originalTimestampRepairs, planningValueHash, validatePlanningImport, updatePlanningMetadata, type TeamPlanningHistory, type TeamPlanningMetadata, type TeamPlanningSeed } from "./history";
import { emptyWorkflowRoles, validateWorkflowRoles, workflowRolesUpdateSchema, type TeamWorkflowRoles } from "./workflow-roles";
import type {
  TeamCredential,
  TeamEvent,
  TeamMember,
  TeamSessionReply,
  TeamSnapshot,
  TeamSyncReply,
  TeamWorkerActivity,
} from "../../src/team";
import {
  applyTeamEvent,
  emptyTeamSnapshot,
  executeTeamCommand,
  TeamProtocolError,
  teamCommandSchema,
  teamEvent,
  teamId,
  teamSnapshotSchema,
} from "./protocol";

type Actor = { memberId: string; deviceId: string };
type RecordEntry =
  | SessionRecord
  | {
      kind: "create";
      snapshot: TeamSnapshot;
      credentialHash: string;
      actor: Actor;
    }
  | { kind: "invite"; hash: string; expiresAt: string }
  | {
      kind: "join";
      invitationHash: string;
      credentialHash: string;
      actor: Actor;
      event: TeamEvent;
    }
  | { kind: "command"; dedup: string; commandHash: string; event: TeamEvent }
  | { kind: "planning_import"; dedup: string; commandHash: string; event: TeamEvent; history: TeamPlanningSeed; importedAt: string; opId: string }
  | { kind: "planning_metadata"; dedup: string; commandHash: string; event: TeamEvent; metadata: TeamPlanningMetadata; preserveUnchangedTimestamps?: true }
  | { kind: "workflow_roles"; dedup: string; commandHash: string; event: TeamEvent; roles: TeamWorkflowRoles; assignLegacyReview?: true }
  | { kind: "planning_timestamps_repair"; dedup: string; commandHash: string; event: TeamEvent; sourceImportOpId: string; sourceImportHash: string; corrections: Array<{id:string;from:string;to:string}> };
interface Room {
  sessions: TeamSessions;
  workerActivity?: Map<string, TeamWorkerActivity>;
  snapshot: TeamSnapshot;
  history: TeamPlanningHistory;
  workflowRoles: TeamWorkflowRoles;
  /** Retained only until a genuine post-import edit; used for constrained recovery. */
  importedPlanning?: TeamPlanningSeed;
  timestampRepairs: Map<string,number>;
  events: TeamEvent[];
  credentials: Map<string, Actor>;
  invitations: Map<string, { expiresAt: string; used: boolean }>;
  operations: Map<string, { commandHash: string; event: TeamEvent }>;
  pending: Promise<unknown>;
  waiters: Set<() => void>;
}
export interface TeamRelayOptions {
  dataDir: string;
  host?: string;
  port?: number;
  /** Explicit endpoint teammates can reach; requires a trusted network or TLS gateway. */
  advertisedUrl?: string;
  adminCapability?: string;
  /** Acceptance-test hook after durable commit and before HTTP acknowledgement. */
  afterCommit?: (event: TeamEvent) => void | Promise<void>;
  verifyIdentity?: TeamIdentityProofVerifier;
  /** Opt-in hosted mode. Every creation still requires a fresh verified Memtrace identity. */
  selfServiceTeams?: boolean;
  maxTeamsPerAccount?: number;
}
export interface TeamRelay {
  url: string;
  adminCapability: string;
  adminFile: string;
  readyFile: string;
  close(): Promise<void>;
}
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const label = z.string().trim().min(1).max(160);
const participant = { memberName: label, deviceId: teamId, deviceName: label };
const createSchema = z.object({ name: label, ...participant }).strict();
const joinSchema = z
  .object({
    workspaceId: teamId,
    invitation: z.string().min(32).max(200),
    ...participant,
  })
  .strict();
const inviteSchema = z
  .object({ workspaceId: teamId, role: z.literal("editor").default("editor") })
  .strict();
const commandSchema = z
  .object({ workspaceId: teamId, opId: teamId, command: teamCommandSchema })
  .strict();
const MAX_BLOB = 5 * 1024 * 1024;
const error = (
  code: string,
  message: string,
  status = 400,
  details?: unknown,
): never => {
  throw new TeamProtocolError(code, message, details, status);
};

async function durableFile(path: string, content: string | Buffer) {
  const temporary = path + ".next";
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
async function body(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit)
      error(
        "PAYLOAD_TOO_LARGE",
        "This upload exceeds the preview size limit.",
        413,
      );
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function json(request: IncomingMessage, limit = 256 * 1024) {
  try {
    return JSON.parse((await body(request, limit)).toString("utf8"));
  } catch (failure) {
    if (failure instanceof TeamProtocolError) throw failure;
    return error("JSON", "Send a valid JSON request.");
  }
}
function reply(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
function applyRecord(room: Room, record: RecordEntry) {
  if (record.kind === "worker_session" || record.kind === "worker_command") {
    applySessionRecord(room.sessions, record);
    return;
  }
  const before = room.snapshot;
  if (record.kind === "invite")
    room.invitations.set(record.hash, {
      expiresAt: record.expiresAt,
      used: false,
    });
  if (record.kind === "join") {
    const invitation = room.invitations.get(record.invitationHash);
    if (!invitation)
      throw Error("Team journal contains an unknown invitation.");
    invitation.used = true;
    room.credentials.set(record.credentialHash, record.actor);
    room.snapshot = applyTeamEvent(room.snapshot, record.event);
    room.events.push(record.event);
  }
  if (record.kind === "command" || record.kind === "planning_import" || record.kind === "planning_metadata" || record.kind === "planning_timestamps_repair" || record.kind === "workflow_roles") {
    room.operations.set(record.dedup, {
      commandHash: record.commandHash,
      event: record.event,
    });
    room.snapshot = applyTeamEvent(room.snapshot, record.event);
    room.events.push(record.event);
  }
  if (room.workerActivity?.size && room.snapshot.claims !== before.claims) {
    for (const [storyId, row] of room.workerActivity) {
      if (!room.snapshot.claims.some(c => c.storyId === storyId && c.attemptId === row.attemptId && c.epoch === row.epoch))
        room.workerActivity.delete(storyId);
    }
  }
  if (record.kind === "planning_import") {
    room.history = { ...structuredClone(record.history), version: 1, workspaceId: room.snapshot.workspaceId, through: record.event.sequence, import: { opId: record.opId, hash: record.commandHash, at: record.importedAt } };
    room.importedPlanning = structuredClone(record.history);
  } else if (record.kind === "workflow_roles") {
    // A first binding is bookkeeping, not a new edit of every old handoff.
    // The explicit journal marker makes this migration replayable without
    // changing the meaning of role records written before it was introduced.
    if (record.assignLegacyReview === true) {
      if (room.workflowRoles.binding || record.roles.revision !== 1 || !record.roles.binding)
        throw Error("Legacy review assignment requires this project's first workflow role binding.");
      validateWorkflowRoles(record.roles.binding, room.history.planning.workflowStates);
      const valid = new Set(room.history.planning.workflowStates.map((item) => item.id));
      const reviews = new Set(room.snapshot.stories.filter((item) => item.stage === "review").map((item) => item.id));
      for (const story of room.history.stories) {
        if (reviews.has(story.id) && (!story.statusId || !valid.has(story.statusId)))
          story.statusId = record.roles.binding.acceptanceStatusId;
      }
    }
    room.workflowRoles = structuredClone(record.roles);
    // Role assignment does not change any story date, metric or occurrence.
    room.history.through = record.event.sequence;
  } else if (record.kind === "planning_metadata") {
    if (planningMetadataHasChanges(room.history,record.metadata)) room.importedPlanning = undefined;
    // Old journal entries retain their original interpretation. Corrections
    // use a separate durable, authenticated record instead of rewriting replay.
    updatePlanningMetadata(room.history, room.snapshot, record.metadata, record.event, record.preserveUnchangedTimestamps === true);
  } else if (record.kind === "planning_timestamps_repair") {
    if (room.history.import?.opId !== record.sourceImportOpId || room.history.import.hash !== record.sourceImportHash || !room.importedPlanning) throw Error("Timestamp recovery journal provenance is invalid.");
    const original = new Map(room.importedPlanning.stories.map((story)=>[story.id,story.updatedAt]));
    for (const correction of record.corrections) {
      const story = room.history.stories.find((story)=>story.id===correction.id);
      if (!story || story.updatedAt !== correction.from || original.get(story.id) !== correction.to) throw Error("Timestamp recovery journal does not match its immutable import.");
      story.updatedAt=correction.to;
    }
    room.history.through=record.event.sequence;
    room.timestampRepairs.set(record.dedup,record.corrections.length);
    room.importedPlanning=undefined;
  } else if (record.kind === "command" || record.kind === "join") {
    if (record.event.changes.some((change)=>change.collection!=="members"&&change.collection!=="readCursors")) room.importedPlanning=undefined;
    advancePlanningHistory(room.history, before, room.snapshot, record.event);
  }
}
function roomFrom(record: Extract<RecordEntry, { kind: "create" }>): Room {
  return {
    sessions: emptySessions(),
    snapshot: teamSnapshotSchema.parse(record.snapshot),
    history: emptyPlanningHistory(record.snapshot.workspaceId, record.snapshot.members[0]?.joinedAt ?? new Date(0).toISOString()),
    workflowRoles: emptyWorkflowRoles(record.snapshot.workspaceId),
    timestampRepairs:new Map(),
    events: [],
    credentials: new Map([[record.credentialHash, record.actor]]),
    invitations: new Map(),
    operations: new Map(),
    pending: Promise.resolve(),
    waiters: new Set(),
  };
}

/** A private, invite-capability preview relay. It never opens a project or starts an agent. */
export async function startTeamRelay(
  options: TeamRelayOptions,
): Promise<TeamRelay> {
  const accountTeamLimit = options.maxTeamsPerAccount ?? 3;
  if (!Number.isSafeInteger(accountTeamLimit) || accountTeamLimit < 1 || accountTeamLimit > 10)
    throw Error("Use a Team creation limit between 1 and 10 per account.");
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host))
    throw Error(
      "Bind the Team relay to loopback or explicitly to 0.0.0.0 for a private-network pilot.",
    );
  const advertised = options.advertisedUrl
    ? new URL(options.advertisedUrl)
    : undefined;
  if (
    advertised &&
    (!["http:", "https:"].includes(advertised.protocol) ||
      advertised.username ||
      advertised.password ||
      advertised.pathname !== "/" ||
      advertised.search ||
      advertised.hash)
  )
    throw Error("Use a plain HTTP(S) origin as the advertised Team endpoint.");
  if (host === "0.0.0.0" && !advertised)
    throw Error(
      "An explicit advertisedUrl is required when sharing the relay on a private network.",
    );
  const allowedHosts = new Set([
    "127.0.0.1",
    "[::1]",
    "localhost",
    ...(advertised ? [advertised.hostname] : []),
  ]);
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const roomsDir = join(options.dataDir, "workspaces");
  await mkdir(roomsDir, { recursive: true, mode: 0o700 });
  const spaces = new TeamSpaceStore(join(options.dataDir, "teams"));
  await spaces.initialize();
  const challenges = new Map<string, TeamIdentityChallenge>();
  const verifyIdentity = options.verifyIdentity ?? createMemtraceIdentityVerifier();
  let canonicalOrigin = advertised?.origin ?? "";
  const adminFile = join(options.dataDir, "admin.private.json"),
    readyFile = join(options.dataDir, "ready.private.json"),
    lockFile = join(options.dataDir, "relay.lock");
  const lockNonce = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      const lock = await open(lockFile, "wx", 0o600);
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, nonce: lockNonce }),
      );
      await lock.close();
      break;
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "EEXIST" || attempt)
        throw Error("This private Team relay profile is already open.", {
          cause: failure,
        });
      const prior = JSON.parse(await readFile(lockFile, "utf8")) as {
        pid: number;
      };
      try {
        process.kill(prior.pid, 0);
        throw Error("This private Team relay profile is already open.");
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
        await unlink(lockFile);
      }
    }
  }
  let adminCapability = options.adminCapability;
  const rooms = new Map<string, Room>();
  let closing = false;
  const releaseLock = async () => {
    try {
      const current = JSON.parse(await readFile(lockFile, "utf8"));
      if (current.nonce === lockNonce) await unlink(lockFile);
    } catch {}
  };
  try {
    if (!adminCapability) {
      try {
        adminCapability = JSON.parse(
          await readFile(adminFile, "utf8"),
        ).capability;
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
      }
    }
    adminCapability ??= secret();
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(adminCapability))
      throw Error("Invalid private relay setup capability.");
    await durableFile(
      adminFile,
      JSON.stringify({ capability: adminCapability }),
    );
    for (const item of await readdir(roomsDir, { withFileTypes: true })) {
      if (!item.isFile() || !/^[a-f0-9-]{36}\.jsonl$/.test(item.name)) continue;
      const path = join(roomsDir, item.name),
        content = await readFile(path, "utf8");
      const boundary = content.lastIndexOf("\n");
      if (boundary !== content.length - 1)
        await truncate(path, Buffer.byteLength(content.slice(0, boundary + 1)));
      const records = content
        .slice(0, boundary + 1)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordEntry);
      if (!records.length || records[0].kind !== "create")
        throw Error("Team workspace journal is incomplete.");
      const first = records[0],
        room = roomFrom(first);
      if (first.snapshot.workspaceId + ".jsonl" !== item.name)
        throw Error("Team workspace journal identity mismatch.");
      for (const record of records.slice(1)) {
        if (record.kind === "create")
          throw Error("Duplicate Team workspace creation.");
        applyRecord(room, record);
      }
      rooms.set(room.snapshot.workspaceId, room);
    }
    const append = async (workspaceId: string, record: RecordEntry) => {
      const file = await open(
        join(roomsDir, workspaceId + ".jsonl"),
        "a",
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify(record) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
    };
    const checkpoint = async (room: Room) => {
      try {
        await durableFile(
          join(roomsDir, room.snapshot.workspaceId + ".snapshot.json"),
          JSON.stringify(room.snapshot),
        );
      } catch {
        /* The fsynced journal remains authoritative. */
      }
    };
    const serialized = <T>(
      room: Room,
      action: () => Promise<T>,
    ): Promise<T> => {
      const task = room.pending.catch(() => {}).then(action);
      room.pending = task;
      return task;
    };
    const commit = async (
      room: Room,
      record: Exclude<RecordEntry, { kind: "create" }>,
    ) => {
      await append(room.snapshot.workspaceId, record);
      applyRecord(room, record);
      await checkpoint(room);
      for (const wake of [...room.waiters]) wake();
    };
    const roomFor = (workspaceId: string) =>
      rooms.get(workspaceId) ?? error("NOT_FOUND", "Workspace not found.", 404);
    const bearer = (request: IncomingMessage) => {
      const value = request.headers.authorization;
      if (!value?.startsWith("Bearer "))
        return error("AUTH", "A private Team capability is required.", 401);
      return value.slice(7);
    };
    const authenticate = (request: IncomingMessage, workspaceId: string) => {
      const token = bearer(request), room = roomFor(workspaceId);
      const teamId = spaces.projectTeam(workspaceId);
      const actor = teamId ? spaces.authenticate(teamId, token).actor : room.credentials.get(digest(token));
      if (!actor)
        return error(
          "AUTH",
          "This capability cannot access this workspace.",
          403,
        );
      return { room, actor };
    };
    const verified = async (input: { proof: string; nonce: string }) => {
      const challenge = challenges.get(input.nonce);
      if (!challenge || Date.parse(challenge.expiresAt) <= Date.now()) return error("IDENTITY_CHALLENGE", "This identity handoff expired. Sign in again.", 403);
      challenges.delete(input.nonce);
      try { return await verifyIdentity(input.proof, challenge); }
      catch { return error("IDENTITY", "Memtrace could not verify this account. Complete sign-in and try again.", 403); }
    };
    const creatingTeamRooms = new Map<string, Promise<Room>>();
    const ensureTeamRoom = async (teamId: string, workspaceId: string, capability: string) => {
      const project = spaces.project(teamId, workspaceId, capability), team = spaces.read(teamId, capability), { actor } = spaces.authenticate(teamId, capability);
      let room = rooms.get(workspaceId);
      const asMember = (member: typeof team.members[number]): TeamMember => ({ id: member.id, name: member.name, role: member.role === "owner" ? "owner" : "editor", devices: member.devices, joinedAt: member.joinedAt });
      if (!room) {
        let creating = creatingTeamRooms.get(workspaceId);
        if (!creating) {
        creating = (async () => {
        const owner = team.members.find((member) => member.role === "owner" && member.status === "active")!;
        const snapshot = emptyTeamSnapshot(workspaceId, project.name, asMember(owner));
        snapshot.members = team.members.filter((member) => member.status === "active").map(asMember);
        const record: Extract<RecordEntry, { kind: "create" }> = { kind: "create", snapshot, credentialHash: digest(capability), actor };
        await append(workspaceId, record); const created = roomFrom(record); rooms.set(workspaceId, created); await checkpoint(created); return created;
        })();
        creatingTeamRooms.set(workspaceId, creating);
        void creating.finally(() => { if (creatingTeamRooms.get(workspaceId) === creating) creatingTeamRooms.delete(workspaceId); }).catch(() => {});
        }
        room = await creating;
      }
      const target = room;
      await serialized(target, async () => {
        spaces.authenticate(teamId, capability);
        const member = asMember(team.members.find((member) => member.id === actor.memberId)!);
        const prior = target.snapshot.members.find((item) => item.id === member.id);
        if (JSON.stringify(prior) !== JSON.stringify(member)) await commit(target, { kind: "command", dedup: `team-member/${member.id}/${team.revision}`, commandHash: digest(JSON.stringify(member)), event: teamEvent(target.snapshot, actor, randomUUID(), new Date().toISOString(), [{ collection: "members", id: member.id, value: member }], `${member.name} connected to the project`, "member.joined", member.id) });
      });
      return { room: target, actor };
    };
    const memberFor = (room: Room, actor: Actor) =>
      room.snapshot.members.find((item) => item.id === actor.memberId) ??
      error("AUTH", "Workspace membership is unavailable.", 403);
    const blobsDir = (workspaceId: string) =>
      join(roomsDir, workspaceId + ".blobs");
    const blobMeta = async (workspaceId: string, hash: string) => {
      if (!/^[a-f0-9]{64}$/.test(hash))
        return error("HASH", "Invalid result content hash.");
      try {
        return JSON.parse(
          await readFile(join(blobsDir(workspaceId), hash + ".json"), "utf8"),
        ) as {
          hash: string;
          size: number;
          mime: string;
          memberId: string;
          uploaders?: string[];
        };
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT")
          return error(
            "NOT_FOUND",
            "Upload this result's content before publishing it.",
            404,
          );
        throw failure;
      }
    };
    const server = createServer(async (request, response) => {
      try {
        if (closing) return error("CLOSED", "The Team relay is closing.", 503);
        if (request.headers.origin)
          return error(
            "ORIGIN",
            "Use the private MemCode runtime client for Team Sync.",
            403,
          );
        const url = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? "127.0.0.1"}`,
        );
        if (!allowedHosts.has(url.hostname))
          return error("HOST", "Unrecognized relay host.", 403);
        if (request.method === "GET" && url.pathname === "/v1/service")
          return reply(response, 200, { version: 1, selfServiceTeams: options.selfServiceTeams === true, accountTeamLimit, workflowRoles: 1, workerActivity: 1, workerSessions: 1 });
        if (request.method === "GET" && url.pathname === "/v1/team-auth/challenge") {
          for (const [key, value] of challenges) if (Date.parse(value.expiresAt) <= Date.now()) challenges.delete(key);
          if (challenges.size >= 500) return error("LIMIT", "Too many pending identity requests. Try again shortly.", 429);
          const challenge: TeamIdentityChallenge = { audience: teamIdentityAudience(canonicalOrigin), nonce: secret(), expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
          challenges.set(challenge.nonce, challenge); return reply(response, 200, challenge);
        }
        const proof = { proof: z.string().min(1).max(16000), nonce: z.string().min(32).max(200) };
        const teamDevice = { deviceId: teamId, deviceName: label };
        if (request.method === "POST" && url.pathname === "/v1/teams") {
          const operator = !!request.headers.authorization && digest(bearer(request)) === digest(adminCapability!);
          if (!operator && options.selfServiceTeams !== true) return error("AUTH", "This relay’s private setup capability is required to create a Team.", 403);
          const input = z.object({ name: label, opId:teamId.optional(), ...proof, ...teamDevice }).strict().parse(await json(request));
          return reply(response, 201, await spaces.create(input.name, await verified(input), { id: input.deviceId, name: input.deviceName },input.opId, operator ? undefined : accountTeamLimit));
        }
        if (request.method === "GET" && url.pathname === "/v1/teams") {
          const id = teamId.parse(url.searchParams.get("teamId")); return reply(response, 200, spaces.read(id, bearer(request)));
        }
        if (request.method === "POST" && url.pathname === "/v1/teams/invites") {
          const input = z.object({ teamId, email: z.string().email().max(250).optional(), projectWorkspaceId: teamId.optional() }).strict().parse(await json(request));
          return reply(response, 201, await spaces.invite(input.teamId, bearer(request), input));
        }
        if (request.method === "POST" && url.pathname === "/v1/teams/invites/preview") {
          const input = z.object({ teamId, invitation: z.string().min(32).max(200) }).strict().parse(await json(request)); return reply(response, 200, spaces.preview(input.teamId, input.invitation, request.headers.authorization ? bearer(request) : undefined));
        }
        if (request.method === "POST" && url.pathname === "/v1/teams/invites/accept") {
          const input = z.object({ teamId, invitation: z.string().min(32).max(200), ...proof, ...teamDevice }).strict().parse(await json(request));
          return reply(response, 200, await spaces.accept(input.teamId, input.invitation, await verified(input), { id: input.deviceId, name: input.deviceName }));
        }
        if (request.method === "POST" && url.pathname === "/v1/teams/reconnect") {
          const input = z.object({teamId, ...proof, ...teamDevice}).strict().parse(await json(request));
          return reply(response, 200, await spaces.reconnect(input.teamId, await verified(input), {id:input.deviceId,name:input.deviceName}));
        }
        if (request.method === "POST" && url.pathname === "/v1/teams/members/revoke") {
          const input = z.object({ teamId, memberId: teamId }).strict().parse(await json(request));
          const team = await spaces.revoke(input.teamId, bearer(request), input.memberId);
          for (const project of team.projects) for (const wake of [...(rooms.get(project.workspaceId)?.waiters ?? [])]) wake();
          return reply(response, 200, team);
        }
        if (request.method === "POST" && url.pathname === "/v1/teams/invites/revoke") {
          const input = z.object({ teamId, invitationId: teamId }).strict().parse(await json(request)); return reply(response, 200, await spaces.revokeInvitation(input.teamId, bearer(request), input.invitationId));
        }
        if (request.method === "POST" && url.pathname === "/v1/teams/projects") {
          const repository = z.object({ url: z.string().max(3000), identity: z.string().max(1000), provider: z.enum(["github", "gitlab", "bitbucket", "git"]), name: z.string().max(500), defaultBranch: z.string().max(250).optional() }).strict();
          const input = z.object({ teamId, opId: teamId, name: label, repository: repository.optional(), workspaceId: teamId.optional(), legacyCapability: z.string().min(32).max(200).optional() }).strict().parse(await json(request));
          const capability = bearer(request), team = spaces.read(input.teamId, capability);
          if (team.role !== "owner") return error("TEAM_FORBIDDEN", "Only a Team owner can share projects.", 403);
          let safeRepository = input.repository ? sanitizeRepositoryURL(input.repository.url, input.repository.defaultBranch) : undefined;
          if (input.repository && safeRepository!.identity !== input.repository.identity) return error("REPOSITORY", "This repository identity does not match its URL.");
          if (input.workspaceId) {
            const room = roomFor(input.workspaceId), existingTeam = spaces.projectTeam(input.workspaceId);
            if (!existingTeam) {
              const actor = input.legacyCapability && room.credentials.get(digest(input.legacyCapability));
              if (!actor || memberFor(room, actor).role !== "owner") return error("TEAM_FORBIDDEN", "Only this project’s existing owner can move it into a Team.", 403);
            }
          }
          const project = await spaces.addProject(input.teamId, capability, { opId: input.opId, workspaceId: input.workspaceId ?? randomUUID(), name: input.name, ...(safeRepository ? { repository: safeRepository } : {}) });
          const { room, actor } = await ensureTeamRoom(input.teamId, project.workspaceId, capability);
          return reply(response, 201, { project, credential: { workspaceId: project.workspaceId, memberId: actor.memberId, deviceId: actor.deviceId, capability }, snapshot: room.snapshot, identity: "memtrace" });
        }
        if (request.method === "POST" && url.pathname === "/v1/teams/projects/open") {
          const input = z.object({ teamId, workspaceId: teamId }).strict().parse(await json(request)), capability = bearer(request);
          const { room, actor } = await ensureTeamRoom(input.teamId, input.workspaceId, capability);
          return reply(response, 200, { credential: { workspaceId: input.workspaceId, memberId: actor.memberId, deviceId: actor.deviceId, capability }, snapshot: room.snapshot, identity: "memtrace" });
        }
        if (request.method === "GET" && /^\/join\/(team|project)\/[A-Za-z0-9._:-]+$/.test(url.pathname)) {
          const page=teamInvitationLanding(); response.writeHead(200,page.headers); response.end(page.html); return;
        }
        if (request.method === "POST" && url.pathname === "/v1/workspaces") {
          if (digest(bearer(request)) !== digest(adminCapability!))
            return error(
              "AUTH",
              "The private relay setup capability is required.",
              403,
            );
          const input = createSchema.parse(await json(request));
          if (rooms.size >= 100)
            return error(
              "LIMIT",
              "This relay has reached its preview workspace limit.",
              409,
            );
          const workspaceId = randomUUID(),
            memberId = randomUUID(),
            capability = secret(),
            at = new Date().toISOString();
          const member: TeamMember = {
            id: memberId,
            name: input.memberName,
            role: "owner",
            devices: [{ id: input.deviceId, name: input.deviceName }],
            joinedAt: at,
          };
          const actor = { memberId, deviceId: input.deviceId },
            snapshot = emptyTeamSnapshot(workspaceId, input.name, member),
            record: RecordEntry = {
              kind: "create",
              snapshot,
              credentialHash: digest(capability),
              actor,
            };
          await append(workspaceId, record);
          const room = roomFrom(record);
          rooms.set(workspaceId, room);
          await checkpoint(room);
          return reply(response, 201, {
            credential: {
              workspaceId,
              memberId,
              deviceId: input.deviceId,
              capability,
            },
            snapshot: room.snapshot,
            identity: "invite-preview",
          } satisfies TeamSessionReply);
        }
        if (request.method === "POST" && url.pathname === "/v1/invites") {
          const input = inviteSchema.parse(await json(request)),
            { room, actor } = authenticate(request, input.workspaceId);
          if (spaces.projectTeam(input.workspaceId)) return error("TEAM_INVITE", "Invite this person through the Team membership controls.", 409);
          if (memberFor(room, actor).role !== "owner")
            return error(
              "FORBIDDEN",
              "Only a workspace owner can create invitations.",
              403,
            );
          return await serialized(room, async () => {
            if (
              [...room.invitations.values()].filter(
                (item) => !item.used && Date.parse(item.expiresAt) > Date.now(),
              ).length >= 100
            )
              return error(
                "LIMIT",
                "Use or expire an existing invitation first.",
                409,
              );
            const invitation = secret(),
              expiresAt = new Date(
                Date.now() + 24 * 60 * 60 * 1000,
              ).toISOString();
            await commit(room, {
              kind: "invite",
              hash: digest(invitation),
              expiresAt,
            });
            return reply(response, 201, {
              workspaceId: input.workspaceId,
              invitation,
              expiresAt,
            });
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/join") {
          const input = joinSchema.parse(await json(request)),
            room = roomFor(input.workspaceId);
          if (spaces.projectTeam(input.workspaceId)) return error("TEAM_INVITE", "This project now belongs to a Team. Ask its owner for a Team invitation.", 403);
          return await serialized(room, async () => {
            const hash = digest(input.invitation),
              invitation = room.invitations.get(hash);
            if (
              !invitation ||
              invitation.used ||
              Date.parse(invitation.expiresAt) <= Date.now()
            )
              return error(
                "INVITE",
                "This invitation is expired or has already been used.",
                403,
              );
            if (room.snapshot.members.length >= 100)
              return error(
                "LIMIT",
                "This workspace has reached its preview member limit.",
                409,
              );
            const capability = secret(),
              memberId = randomUUID(),
              at = new Date().toISOString(),
              actor = { memberId, deviceId: input.deviceId };
            const member: TeamMember = {
              id: memberId,
              name: input.memberName,
              role: "editor",
              devices: [{ id: input.deviceId, name: input.deviceName }],
              joinedAt: at,
            };
            const event = teamEvent(
              room.snapshot,
              actor,
              randomUUID(),
              at,
              [{ collection: "members", id: memberId, value: member }],
              `${member.name} joined the workspace`,
              "member.joined",
              memberId,
            );
            await commit(room, {
              kind: "join",
              invitationHash: hash,
              credentialHash: digest(capability),
              actor,
              event,
            });
            return reply(response, 200, {
              credential: {
                workspaceId: input.workspaceId,
                memberId,
                deviceId: input.deviceId,
                capability,
              },
              snapshot: room.snapshot,
              identity: "invite-preview",
            } satisfies TeamSessionReply);
          });
        }
        // A separately negotiated resource keeps strict board/history v1 payloads intact.
        if (url.pathname === "/v1/workflow-roles" && request.method === "GET") {
          const workspaceId = teamId.parse(url.searchParams.get("workspaceId")), { room } = authenticate(request, workspaceId);
          return reply(response, 200, room.workflowRoles);
        }
        if (url.pathname === "/v1/workflow-roles" && request.method === "POST") {
          const input = workflowRolesUpdateSchema.parse(await json(request));
          const { room, actor } = authenticate(request, input.workspaceId);
          return await serialized(room, async () => {
            authenticate(request, input.workspaceId);
            if (memberFor(room, actor).role !== "owner") return error("FORBIDDEN", "Only this project's owner can assign its code review workflow roles.", 403);
            const hash = planningValueHash(input), key = `workflow-roles/${actor.memberId}/${actor.deviceId}/${input.opId}`;
            const prior = room.operations.get(key);
            if (prior) {
              if (prior.commandHash !== hash) return error("OP_ID_REUSE", "This workflow role update ID was used for different data.", 409);
              return reply(response, 200, { roles: room.workflowRoles, replayed: true });
            }
            if (!room.history.import || room.history.through !== room.snapshot.head) return error("WORKFLOW_AUTHORITY", "Finish verifying the project's original planning history before assigning review workflow roles.", 409);
            const planningHash = planningValueHash(planningMetadata(room.history).planning);
            if (input.expectedRevision !== room.workflowRoles.revision || input.expectedPlanningHash !== planningHash) return error("WORKFLOW_CONFLICT", "The accepted workflow changed on another computer. Refresh before assigning its review roles.", 409);
            try { validateWorkflowRoles(input.binding, room.history.planning.workflowStates); }
            catch (failure) { return error("WORKFLOW_SCOPE", (failure as Error).message, 409); }
            const event = teamEvent(room.snapshot, actor, input.opId, new Date().toISOString(), [], "Code review workflow configured", "workflow.roles.updated");
            const roles: TeamWorkflowRoles = { version: 1, workspaceId: input.workspaceId, revision: room.workflowRoles.revision + 1, through: event.sequence, binding: input.binding, planningHash };
            await commit(room, { kind: "workflow_roles", dedup: key, commandHash: hash, event, roles, ...(!room.workflowRoles.binding ? { assignLegacyReview: true as const } : {}) });
            return reply(response, 200, { roles: room.workflowRoles, replayed: false });
          });
        }
        if (url.pathname === "/v1/planning-history" && request.method === "GET") {
          const workspaceId = teamId.parse(url.searchParams.get("workspaceId")), { room } = authenticate(request, workspaceId);
          if (url.searchParams.get("after") === String(room.history.through)) return reply(response, 200, {version:1,workspaceId,through:room.history.through,unchanged:true});
          return reply(response, 200, room.history);
        }
        if (url.pathname === "/v1/planning-history" && request.method === "POST") {
          const input = planningImportSchema.parse(JSON.parse((await body(request, 8 * 1024 * 1024)).toString("utf8")));
          const { room, actor } = authenticate(request, input.workspaceId);
          return await serialized(room, async () => {
            authenticate(request, input.workspaceId);
            if (memberFor(room, actor).role !== "owner") return error("FORBIDDEN", "Only this project's owner can import its original planning history.", 403);
            const hash = digest(JSON.stringify(input.history)), key = `history/${actor.memberId}/${actor.deviceId}/${input.opId}`;
            const prior = room.operations.get(key);
            if (prior) {
              if (prior.commandHash !== hash) return error("OP_ID_REUSE", "This history import ID was used for different planning data.", 409);
              return reply(response, 200, { history: room.history, replayed: true });
            }
            if (room.history.import) return error("HISTORY_IMPORTED", "This project's original planning history has already been imported. Its accepted history was preserved.", 409);
            if (input.expectedHead !== room.snapshot.head) return error("HISTORY_HEAD", "The board changed before its history import. Refresh and verify the source planning before retrying.", 409);
            const exactIds = (ids: string[], expected: string[]) => ids.length === expected.length && [...ids].sort().every((id, i) => id === [...expected].sort()[i]);
            if (!exactIds(input.history.stories.map((item) => item.id), room.snapshot.stories.map((item) => item.id)) || !exactIds(input.history.cycles.map((item) => item.id), room.snapshot.cycles.map((item) => item.id)) || input.history.comments.some((item) => !room.snapshot.comments.some((comment) => comment.id === item.id)))
              return error("HISTORY_SCOPE", "The imported planning must match this project's current tasks, cycles and discussions.", 409);
            const at = new Date().toISOString();
            try { validatePlanningImport(input.history, room.snapshot, at); } catch (failure) { return error("HISTORY_SOURCE", (failure as Error).message, 409); }
            const event = teamEvent(room.snapshot, actor, input.opId, at, [], "Original project planning history imported", "planning.imported");
            await commit(room, { kind: "planning_import", dedup: key, commandHash: hash, event, history: input.history, importedAt: at, opId: input.opId });
            return reply(response, 200, { history: room.history, replayed: false });
          });
        }
        if (url.pathname === "/v1/planning-history/metadata" && request.method === "POST") {
          const input = planningMetadataSchema.parse(JSON.parse((await body(request, 8 * 1024 * 1024)).toString("utf8")));
          const { room, actor } = authenticate(request, input.workspaceId);
          return await serialized(room, async () => {
            authenticate(request, input.workspaceId);
            const metadata = { stories: input.stories, planning: input.planning }, hash = planningValueHash({metadata,expected:input.expected}), key = `planning/${actor.memberId}/${actor.deviceId}/${input.opId}`;
            const prior = room.operations.get(key);
            if (prior) {
              if (prior.commandHash !== hash) return error("OP_ID_REUSE", "This planning update ID was used for different data.", 409);
              return reply(response, 200, { history: room.history, replayed: true });
            }
            if (metadata.stories.some((item) => !room.snapshot.stories.some((story) => story.id === item.id))) return error("HISTORY_SCOPE", "A task in this planning update no longer exists.", 409);
            if (input.expected) {
              const current = planningMetadata(room.history);
              for (const value of input.expected.stories) {
                const meta = current.stories.find((item) => item.id === value.id);
                const expected = value.hash ?? planningValueHash({id:value.id,category:"Work",checklist:[],archivedAt:null});
                if (!meta || planningValueHash(meta) !== expected) return error("PLANNING_CONFLICT", "This runbook or task planning changed on another computer. Its accepted version was preserved; review your saved local edit before trying again.", 409);
              }
              if (metadata.planning && input.expected.planningHash !== planningValueHash(current.planning)) return error("PLANNING_CONFLICT", "Project workflow or saved views changed on another computer. Its accepted version was preserved; review your saved local edit.", 409);
            }
            const at = new Date().toISOString(), event = teamEvent(room.snapshot, actor, input.opId, at, [], "Task runbooks and planning updated", "planning.updated");
            await commit(room, { kind: "planning_metadata", dedup: key, commandHash: hash, event, metadata, preserveUnchangedTimestamps:true });
            return reply(response, 200, { history: room.history, replayed: false });
          });
        }
        if (url.pathname === "/v1/planning-history/repair-timestamps" && request.method === "POST") {
          const input = planningTimestampRepairSchema.parse(await json(request));
          const {room,actor}=authenticate(request,input.workspaceId);
          return await serialized(room,async()=>{
            authenticate(request,input.workspaceId);
            if(memberFor(room,actor).role!=="owner")return error("FORBIDDEN","Only this project's owner can recover original import timestamps.",403);
            const key=`timestamp-repair/${actor.memberId}/${actor.deviceId}/${input.opId}`,hash=planningValueHash(input),prior=room.operations.get(key);
            if(prior){
              if(prior.commandHash!==hash)return error("OP_ID_REUSE","This recovery operation ID was used for a different boundary.",409);
              return reply(response,200,{history:room.history,corrected:room.timestampRepairs.get(key)??0,replayed:true});
            }
            if(room.snapshot.head!==input.expectedHead||room.history.through!==input.expectedHead)return error("HISTORY_HEAD","The project changed since this recovery was prepared. No timestamps were changed.",409);
            if(!room.importedPlanning||room.history.import?.hash!==input.expectedImportHash)return error("HISTORY_RECOVERY","A genuine post-import change occurred, or the immutable import does not match. No timestamps were changed.",409);
            if(planningValueHash(planningHistorySeed(room.history))!==input.expectedHistoryHash)return error("HISTORY_RECOVERY","The saved history changed since this recovery was prepared. No timestamps were changed.",409);
            let corrections:Array<{id:string;from:string;to:string}>;
            try{corrections=originalTimestampRepairs(room.history,room.importedPlanning);}catch(failure){return error("HISTORY_RECOVERY",(failure as Error).message,409);}
            if(!corrections.length)return error("HISTORY_RECOVERY","Original import timestamps already match; no recovery is needed.",409);
            const event=teamEvent(room.snapshot,actor,input.opId,new Date().toISOString(),[],`Recovered ${corrections.length} original task timestamps from the immutable planning import`,"planning.timestamps-recovered");
            await commit(room,{kind:"planning_timestamps_repair",dedup:key,commandHash:hash,event,sourceImportOpId:room.history.import!.opId,sourceImportHash:room.history.import!.hash,corrections});
            return reply(response,200,{history:room.history,corrected:corrections.length,replayed:false});
          });
        }
        if (url.pathname === "/v1/worker-sessions" && request.method === "GET") {
          const { room } = authenticate(request, teamId.parse(url.searchParams.get("workspaceId")));
          const after = Math.max(0, Number(url.searchParams.get("after") ?? 0));
          if (!Number.isSafeInteger(after)) return error("SESSION_CURSOR", "Invalid worker session cursor.", 400);
          return reply(response, 200, {version: 1, cursor: room.sessions.cursor,
            sessions: room.sessions.sessions.filter(s => s.sequence > after),
            commands: room.sessions.commands.filter(c => c.sequence > after)});
        }
        const sessionRoutes = ["/v1/worker-sessions", "/v1/session-commands", "/v1/session-commands/edit", "/v1/session-commands/receipt"];
        if (request.method === "POST" && sessionRoutes.includes(url.pathname)) {
          const path = url.pathname;
          const schema = path === "/v1/worker-sessions" ? sessionPublish : path === "/v1/session-commands" ? sessionCommandInput : path.endsWith("/edit") ? sessionCommandEdit : sessionReceipt;
          const input: any = schema.parse(await json(request, 8 * 1024 * 1024));
          const { room, actor } = authenticate(request, input.workspaceId);
          return await serialized(room, async () => {
            const who = sessionActor(room.snapshot, actor), now = new Date().toISOString();
            const record = path === "/v1/worker-sessions" ? publishSession(room.sessions, room.snapshot, who, input, now)
              : path === "/v1/session-commands" ? addSessionCommand(room.sessions, room.snapshot, who, input, now)
              : path.endsWith("/edit") ? editSessionCommand(room.sessions, who, input, now)
              : receiptSessionCommand(room.sessions, room.snapshot, who, input, now);
            const value = record.kind === "worker_session" ? record.session : record.command;
            if (value.sequence > room.sessions.cursor) await commit(room, record);
            return reply(response, 200, record.kind === "worker_session" ? room.sessions.sessions.find(s => s.id === record.session.id) : value);
          });
        }
        if (url.pathname === "/v1/worker-activity" && request.method === "GET") {
          const { room } = authenticate(request, teamId.parse(url.searchParams.get("workspaceId")));
          return reply(response, 200, { workers: [...(room.workerActivity?.values() ?? [])] });
        }
        if (url.pathname === "/v1/worker-activity" && request.method === "POST") {
          const input = workerReport.parse(await json(request, 4096));
          const { room, actor } = authenticate(request, input.workspaceId);
          const claim = room.snapshot.claims.find(c => c.storyId === input.storyId);
          if (!claim || claim.attemptId !== input.attemptId || claim.epoch !== input.epoch)
            return error("CLAIM_CHANGED", "This worker claim has ended.", 409);
          if (claim.deviceId !== actor.deviceId || claim.memberId !== actor.memberId)
            return error("CLAIM_OWNER", "Only the device running this worker can report activity.", 403);
          const rows = (room.workerActivity ??= new Map());
          const previous = rows.get(input.storyId);
          const worker = acceptWorkerReport(input, previous, new Date().toISOString());
          rows.set(input.storyId, worker);
          if (worker.phase !== previous?.phase || worker.actualModel !== previous?.actualModel || worker.harness !== previous?.harness || worker.requestedModel !== previous?.requestedModel)
            for (const wake of room.waiters) wake();
          return reply(response, 200, { worker });
        }
        if (request.method === "GET" && url.pathname === "/v1/sync") {
          const workspaceId = teamId.parse(url.searchParams.get("workspaceId")),
            { room } = authenticate(request, workspaceId);
          const after = Number(url.searchParams.get("after") ?? 0),
            waitMs = Math.min(
              25000,
              Math.max(0, Number(url.searchParams.get("waitMs") ?? 0)),
            );
          if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isFinite(waitMs)
          )
            return error("CURSOR", "Invalid synchronization cursor.");
          if (after > room.snapshot.head)
            return error(
              "CURSOR",
              "This cursor is ahead of the workspace. Reconnect from a snapshot.",
              409,
            );
          if (after === room.snapshot.head && waitMs)
            await new Promise<void>((resolve) => {
              if (room.waiters.size >= 100)
                return error("LIMIT", "Too many waiting connections.", 429);
              let timer: ReturnType<typeof setTimeout>;
              const wake = () => {
                clearTimeout(timer);
                room.waiters.delete(wake);
                response.off("close", wake);
                resolve();
              };
              room.waiters.add(wake);
              response.once("close", wake);
              timer = setTimeout(wake, waitMs);
              timer.unref();
            });
          if (response.destroyed) return;
          if (closing)
            return error("CLOSED", "The Team relay is closing.", 503);
          authenticate(request, workspaceId);
          const events =
            after === 0
              ? []
              : room.events
                  .filter((item) => item.sequence > after)
                  .slice(0, 100);
          const cursor =
            after === 0
              ? room.snapshot.head
              : (events.at(-1)?.sequence ?? after);
          return reply(response, 200, {
            version: 1,
            ...(after === 0 ? { snapshot: room.snapshot } : {}),
            events,
            head: room.snapshot.head,
            cursor,
            hasMore: cursor < room.snapshot.head,
          } satisfies TeamSyncReply);
        }
        if (request.method === "POST" && url.pathname === "/v1/commands") {
          const input = commandSchema.parse(await json(request)),
            { room, actor } = authenticate(request, input.workspaceId);
          return await serialized(room, async () => {
            authenticate(request, input.workspaceId);
            const key = `${actor.memberId}/${actor.deviceId}/${input.opId}`,
              hash = digest(JSON.stringify(input.command)),
              prior = room.operations.get(key);
            if (prior) {
              if (prior.commandHash !== hash)
                return error(
                  "OP_ID_REUSE",
                  "This operation ID was already used for a different command.",
                  409,
                );
              return reply(response, 200, {
                event: prior.event,
                replayed: true,
              });
            }
            if (input.command.type === "result.publish") {
              const metadata = await blobMeta(
                input.workspaceId,
                input.command.result.hash,
              );
              if (
                metadata.size !== input.command.result.size ||
                metadata.mime !== input.command.result.mime
              )
                return error(
                  "BLOB",
                  "The uploaded result does not match its published metadata.",
                  409,
                );
              if (
                ![metadata.memberId, ...(metadata.uploaders ?? [])].includes(
                  actor.memberId,
                ) &&
                !room.snapshot.results.some(
                  (item) => item.hash === metadata.hash,
                )
              )
                return error(
                  "FORBIDDEN",
                  "Upload this result's content before publishing it.",
                  403,
                );
            }
            const event = executeTeamCommand(
              room.snapshot,
              actor,
              input.command,
              input.opId,
              new Date().toISOString(),
            );
            await commit(room, {
              kind: "command",
              dedup: key,
              commandHash: hash,
              event,
            });
            await options.afterCommit?.(event);
            return reply(response, 200, { event, replayed: false });
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/blobs") {
          const workspaceId = teamId.parse(url.searchParams.get("workspaceId")),
            { room, actor } = authenticate(request, workspaceId);
          const bytes = await body(request, MAX_BLOB),
            hash = digest(bytes),
            requestedHash = request.headers["x-content-sha256"],
            mime = String(
              request.headers["content-type"] ?? "application/octet-stream",
            ).split(";")[0];
          if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime) || mime.length > 100)
            return error("MIME", "Invalid result media type.");
          if (requestedHash && requestedHash !== hash)
            return error(
              "HASH",
              "The upload does not match its content hash.",
              409,
            );
          await serialized(room, async () => {
            authenticate(request, workspaceId);
            const directory = blobsDir(workspaceId);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            let existing: Awaited<ReturnType<typeof blobMeta>> | undefined;
            try {
              existing = await blobMeta(workspaceId, hash);
            } catch (failure) {
              if (
                !(failure instanceof TeamProtocolError) ||
                failure.code !== "NOT_FOUND"
              )
                throw failure;
            }
            if (existing) {
              if (existing.mime !== mime || existing.size !== bytes.length)
                return error(
                  "BLOB",
                  "This content hash already has a different media type.",
                  409,
                );
              await durableFile(
                join(directory, hash + ".json"),
                JSON.stringify({
                  ...existing,
                  uploaders: [
                    ...new Set([...(existing.uploaders ?? []), actor.memberId]),
                  ],
                }),
              );
              return;
            }
            const metadataFiles = (await readdir(directory)).filter((name) =>
              /^[a-f0-9]{64}\.json$/.test(name),
            );
            const metadata = await Promise.all(
              metadataFiles.map(
                async (name) =>
                  JSON.parse(await readFile(join(directory, name), "utf8")) as {
                    size: number;
                  },
              ),
            );
            if (
              metadata.length >= 1000 ||
              metadata.reduce((sum, item) => sum + item.size, 0) +
                bytes.length >
                50 * 1024 * 1024
            )
              return error(
                "LIMIT",
                "This workspace has reached its 50 MiB shared-output preview limit.",
                409,
              );
            await durableFile(join(directory, hash + ".bin"), bytes);
            await durableFile(
              join(directory, hash + ".json"),
              JSON.stringify({
                hash,
                size: bytes.length,
                mime,
                memberId: actor.memberId,
              }),
            );
          });
          return reply(response, 201, { hash, size: bytes.length, mime });
        }
        const blob = /^\/v1\/blobs\/([a-f0-9]{64})$/.exec(url.pathname);
        if (request.method === "GET" && blob) {
          const workspaceId = teamId.parse(url.searchParams.get("workspaceId")),
            { room, actor } = authenticate(request, workspaceId),
            metadata = await blobMeta(workspaceId, blob[1]);
          if (
            ![metadata.memberId, ...(metadata.uploaders ?? [])].includes(
              actor.memberId,
            ) &&
            !room.snapshot.results.some((item) => item.hash === blob[1])
          )
            return error(
              "FORBIDDEN",
              "This result has not been published.",
              403,
            );
          const bytes = await readFile(
            join(blobsDir(workspaceId), blob[1] + ".bin"),
          );
          authenticate(request, workspaceId);
          if (digest(bytes) !== metadata.hash || bytes.length !== metadata.size)
            return error(
              "BLOB",
              "The saved result failed its content-integrity check.",
              500,
            );
          response.writeHead(200, {
            "content-type": metadata.mime,
            "content-length": bytes.length,
            "content-disposition": "attachment",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(bytes);
          return;
        }
        return error("NOT_FOUND", "Team endpoint not found.", 404);
      } catch (failure) {
        if (failure instanceof TeamProtocolError)
          reply(response, failure.status, {
            error: {
              code: failure.code,
              message: failure.message,
              ...(failure.details ? { details: failure.details } : {}),
            },
          });
        else if (failure instanceof z.ZodError)
          reply(response, 400, {
            error: {
              code: "VALIDATION",
              message:
                "The Team request contains invalid or unsupported fields.",
            },
          });
        else
          reply(response, 500, {
            error: {
              code: "STORAGE",
              message:
                "The relay could not confirm this change. Keep it pending and retry with the same operation ID.",
            },
          });
      }
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    let port = options.port;
    if (port === undefined) {
      try {
        const prior = JSON.parse(await readFile(readyFile, "utf8"));
        const previous = new URL(prior.url);
        if (["127.0.0.1", "[::1]"].includes(previous.hostname))
          port = Number(previous.port);
      } catch {}
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port ?? 0, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Could not bind the Team relay.");
    if (advertised?.port === "0") advertised.port = String(address.port);
    const url = advertised
      ? advertised.origin
      : `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
    canonicalOrigin = url;
    await durableFile(
      readyFile,
      JSON.stringify({
        url,
        adminFile,
        pid: process.pid,
        identity: "invite-preview",
      }),
    );
    let closePromise: Promise<void> | undefined;
    return {
      url,
      adminCapability,
      adminFile,
      readyFile,
      close: () =>
        (closePromise ??= (async () => {
          closing = true;
          for (const room of rooms.values())
            for (const wake of [...room.waiters]) wake();
          await Promise.allSettled(
            [...rooms.values()].map((room) => room.pending),
          );
          await spaces.settled();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeIdleConnections();
          });
          await releaseLock();
        })()),
    };
  } catch (failure) {
    await releaseLock();
    throw failure;
  }
}
