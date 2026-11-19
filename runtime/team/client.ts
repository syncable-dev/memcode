import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { AppState, Artifact, Project, TeamWorkspaceState, WorkItem } from "../../src/shared";
import type { TeamClaim, TeamCommand, TeamCommandReply, TeamCredential, TeamInvite, TeamResult, TeamSessionReply, TeamSnapshot } from "../../src/team";
import { applyTeamEvent, teamSessionReplySchema, teamSyncReplySchema } from "./protocol";
import { startTeamRelay } from "./relay";
import type { TeamWorkerActivity } from "../../src/team";
import { reportWorker, workerReports } from "./worker-activity";
import { TeamSessionSync } from "./session-sync";
import type { SessionCommand, TeamSessions } from "../../src/team-session";
import type { StoryReviewRun } from "../../src/code-review";
import { applySharedSnapshot, emptySharedProjection, projectSharedState, sharedCommands, type SharedProjection } from "./projection";
import { replaceWorkspace } from "../persistence";
import { canonicalArtifactRoots } from "../files";
import { within } from "../local";
import type { TeamWorkerClaims } from "../workers";
import { emptyTeamLocalIds, localTeamId, localTeamProjection, localTeamSnapshot, remoteTeamId, remoteTeamProjection, type TeamLocalIds } from "./identity";
import type { AcceptedTeamInvitation, TeamDirectory, TeamInvitationPreview, TeamMemberInvitation, WorkspaceTeam } from "../../src/team-space";
import type { RepositoryDescriptor } from "../../src/repository";
import type { TeamIdentityChallenge, TeamIdentityProofProvider } from "../team-identity";
import type { TeamSpaceCredential, TeamSpaceSession } from "./spaces";
import { formatTeamInvitation, parseTeamInvitation } from "./invitation";
import { applyPlanningHistory, planningHistorySchema, planningHistoryUnchangedSchema, planningMetadata, planningValueHash, projectPlanningHistory, projectPlanningMetadata, remotePlanningMetadata, remotePlanningSeed, type ExpectedPlanningMetadata, type TeamPlanningHistory, type TeamPlanningMetadata, type TeamPlanningSeed } from "./history";
import { applyWorkflowRoles, remoteWorkflowRoles, workflowRolesSchema, type PendingWorkflowRoles, type TeamWorkflowRoles } from "./workflow-roles";
import { initializeCodeReviewWorkflow } from "../../src/code-review-workflow";
import type { ReviewWorkflowBinding } from "../../src/code-review";

interface PendingCommand { opId: string; command: TeamCommand; deletionId?: string }
interface DeletionBackup {
  id: string; operationIds: string[]; rejected?: boolean;
  tasks: WorkItem[]; artifacts: AppState["artifacts"];
  comments: NonNullable<AppState["storyComments"]>; reviews: NonNullable<AppState["reviewComments"]>;
  events: AppState["planning"]["events"]; observations: AppState["planning"]["observations"];
  epics: AppState["epics"]; cycles: AppState["cycles"];
}
interface SavedConnection {
  sessions?: TeamSessions;
  sessionOutbox?: Array<{path: string; input: Record<string, unknown>}>;
  projectId: string; endpoint: string; credential: TeamCredential;
  snapshot: TeamSnapshot; baseline: SharedProjection; outbox: PendingCommand[];
  cursor: number; readThrough: number;
  claimAttempts?: Record<string, { opId: string; attemptId: string; state: "requesting" | "owned" }>;
  rejected?: Array<{ opId: string; command: TeamCommand; message: string; at: string }>;
  deletions?: DeletionBackup[];
  /** Only invitation-created projects need a namespace for their local records. */
  localIds?: TeamLocalIds;
  /** Recovers the linked board if private credentials were saved before workspace.json. */
  linkedProject?: Project;
  teamId?: string;
  repository?: RepositoryDescriptor;
  history?: TeamPlanningHistory;
  pendingHistoryImport?: { opId: string; history: TeamPlanningSeed; expectedHead?: number };
  historyOutbox?: Array<{ opId: string; metadata: TeamPlanningMetadata; expected?: ExpectedPlanningMetadata }>;
  planningBaseline?: TeamPlanningMetadata;
  rejectedHistory?: Array<{ opId: string; metadata: TeamPlanningMetadata; message: string; at: string }>;
  retainedPlanningEvents?: AppState["planning"]["events"];
  workflowRoles?: TeamWorkflowRoles;
  workflowRoleBaseline?: ReviewWorkflowBinding | null;
  workflowRoleOutbox?: PendingWorkflowRoles[];
  rejectedWorkflowRoles?: Array<PendingWorkflowRoles & { message: string; at: string }>;
}
interface Connection extends SavedConnection {
  sessionsError?: string;
  sessionsUnsupported?: boolean;
  workerActivity?: TeamWorkerActivity[];
  activityRetryAt?: number;
  sendingActivity?: Promise<void>;
  readingActivity?: Promise<boolean>;
  lastActivity?: Map<string, { key: string; at: number }>;
  status: TeamWorkspaceState["connection"]; error?: string; lastSyncedAt?: string;
  flushing?: Promise<void>; leases: Map<string, TeamClaim>;
  preparingDeletionId?: string;
  historySupported?: boolean;
  historyError?: string;
  workflowRolesSupported?: boolean;
  workflowRolesError?: string;
}
interface SavedTeam { endpoint: string; credential: TeamSpaceCredential; snapshot: WorkspaceTeam; locked?: boolean }
interface PrivateProfile { version: 1; deviceId: string; host?: { port: number; bind?: string; advertisedEndpoint?: string }; connections: SavedConnection[]; teams?: SavedTeam[]; projectShares?: Record<string, string>; teamCreates?: Array<{name:string;opId:string}> }
export interface TeamClientOptions {
  onSessionCommand?: (task: WorkItem, command: SessionCommand) => Promise<void>;
  loadReview?: (taskId: string) => Promise<StoryReviewRun | null>;
  onWorkerActivity?: () => void;
  fetch?: typeof fetch;
  /** Tests can synchronize explicitly without a background long poll. */
  background?: boolean;
  identityProof?: TeamIdentityProofProvider;
  identityAvailable?: () => Promise<boolean>;
  /** Production injects official HTTPS discovery; tests/private installations need no network. */
  serviceDiscovery?: () => Promise<{ endpoint: string } | undefined>;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const mimeTypes: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".htm": "text/html", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".json": "application/json",
};
function endpointURL(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw Error("Use an HTTP or HTTPS Team relay address without credentials or query parameters.");
  return url.origin;
}
function optimistic(snapshot: TeamSnapshot, pending: PendingCommand[], baseline: SharedProjection, memberId: string): TeamSnapshot {
  const value = structuredClone(snapshot);
  for (const { command } of pending) {
    const put = <T extends { id: string }>(items: T[], item: T) => {
      const index = items.findIndex((value) => value.id === item.id);
      if (index < 0) items.push(item); else items[index] = item;
    };
    if (command.type === "story.put") put(value.stories, command.story);
    else if (command.type === "story.patch") {
      const story = value.stories.find((item) => item.id === command.storyId);
      if (story) Object.assign(story, command.patch);
    } else if (command.type === "story.delete") value.stories = value.stories.filter((item) => item.id !== command.storyId);
    else if (command.type === "epic.put") put(value.epics, command.epic);
    else if (command.type === "epic.delete") value.epics = value.epics.filter((item) => item.id !== command.epicId);
    else if (command.type === "cycle.put") put(value.cycles, command.cycle);
    else if (command.type === "cycle.delete") value.cycles = value.cycles.filter((item) => item.id !== command.cycleId);
    else if (command.type === "comment.add") {
      const local = baseline.comments.find((comment) => comment.id === command.commentId);
      put(value.comments, { id: command.commentId, storyId: command.storyId, body: command.body, parentId: command.parentId, reference: command.reference, memberId,
        createdAt: local?.createdAt ?? "", updatedAt: local?.updatedAt ?? "" });
    } else if (command.type === "comment.edit" || command.type === "comment.delete") {
      const comment = value.comments.find((comment) => comment.id === command.commentId);
      if (comment) {
        const local = baseline.comments.find((item) => item.id === command.commentId);
        comment.body = command.type === "comment.edit" ? command.body : "";
        comment.updatedAt = local?.updatedAt ?? comment.updatedAt;
        if (command.type === "comment.delete") comment.deletedAt = local?.deletedAt ?? comment.updatedAt;
      }
    }
  }
  return value;
}

/** Local-first metadata replication. Secrets live only in the private profile file. */
export class TeamSyncClient implements TeamWorkerClaims {
  private profile: PrivateProfile = { version: 1, deviceId: randomUUID(), connections: [] };
  private connections = new Map<string, Connection>();
  private unavailable = new Map<string, TeamWorkspaceState>();
  private pendingShares = new Set<string>();
  private pendingJoins = new Set<string>();
  private pendingOpens = new Map<string,Promise<TeamWorkspaceState>>();
  private creatingTeam = false;
  private accountEpoch = 0;
  private writes: Promise<void> = Promise.resolve();
  private requests = new Set<AbortController>();
  private closed = false;
  private relay?: Awaited<ReturnType<typeof startTeamRelay>>;
  private readonly requestFetch: typeof fetch;
  private readonly file: string;
  private readonly sessionSync: TeamSessionSync;
  constructor(private readonly state: () => AppState, private readonly dataDir: string, private readonly changed: () => Promise<void>, private readonly options: TeamClientOptions = {}) {
    this.requestFetch = options.fetch ?? fetch;
    this.file = join(dataDir, "team", "connections.json");
    this.sessionSync = new TeamSessionSync({state, persist: () => this.persist(), changed: async () => { this.publishState(); await this.changed(); },
      request: (connection, path, input) => this.request(connection.endpoint, path, connection.credential.capability, input),
      localId: (connection, id) => localTeamId(connection as Connection, "story", id),
      remoteId: (connection, id) => remoteTeamId(connection as Connection, "story", id),
      deliver: options.onSessionCommand, loadReview: options.loadReview});
  }
  async initialize(): Promise<void> {
    const previousBindings = this.state().team ?? [];
    await mkdir(join(this.dataDir, "team"), { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as PrivateProfile;
      if (saved.version !== 1 || !saved.deviceId || !Array.isArray(saved.connections)) throw Error("Unsupported Team profile.");
      this.profile = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("The private Team profile could not be read. Its saved credentials have been preserved.");
    }
    if (this.profile.host) {
      try { this.relay = await startTeamRelay({ dataDir: join(this.dataDir, "team", "relay"), port: this.profile.host.port, host: this.profile.host.bind ?? "127.0.0.1", ...(this.profile.host.advertisedEndpoint ? { advertisedUrl: this.profile.host.advertisedEndpoint } : {}) }); }
      catch { /* Existing team remains visibly offline; never switch its endpoint silently. */ }
    }
    this.state().team = [];
    for (const saved of this.profile.connections) {
      if (!this.state().projects.some((project) => project.id === saved.projectId) && saved.linkedProject) {
        this.state().projects.push(structuredClone(saved.linkedProject));
        this.state().activeProjectId = saved.projectId;
      }
      if (!this.state().projects.some((project) => project.id === saved.projectId)) continue;
      const connection: Connection = { ...saved, status: "connecting", leases: new Map() };
      this.connections.set(saved.projectId, connection);
      connection.deletions = connection.deletions?.filter((backup) => backup.rejected || backup.operationIds.length > 0);
      const previous = previousBindings.find((binding) => binding.projectId === saved.projectId)?.workspace;
      if (previous) {
        for (const collection of ["stories", "epics", "cycles"] as const) {
          const known = new Set(connection.baseline[collection].map((item) => item.id));
          // The old renderer snapshot is a managed-ID mask only. Canonical
          // values come from the durable private snapshot and pending outbox.
          const remotePrevious = remoteTeamProjection(connection, { ...emptySharedProjection(), [collection]: previous[collection] });
          (connection.baseline[collection] as Array<{ id: string }>).push(...remotePrevious[collection].filter((item) => !known.has(item.id)));
        }
      }
      this.apply(connection);
    }
    for (const previous of previousBindings) if (!this.connections.has(previous.projectId)) this.unavailable.set(previous.projectId, {
      ...previous, connection: "offline", error: "This project’s private Team credentials are missing. Restore the original profile, or explicitly disconnect and rejoin before running team workers.",
    });
    await this.capture();
    this.publishState();
    for (const connection of this.connections.values()) this.startLoop(connection);
  }
  private persist(): Promise<void> {
    const connections = [...this.connections.values()].map(({ projectId, endpoint, credential, snapshot, baseline, outbox, cursor, readThrough, claimAttempts, rejected, deletions, localIds, linkedProject, teamId, repository, history, pendingHistoryImport, historyOutbox, planningBaseline, rejectedHistory, retainedPlanningEvents, workflowRoles, workflowRoleBaseline, workflowRoleOutbox, rejectedWorkflowRoles, sessions, sessionOutbox }) => ({ projectId, endpoint, credential, snapshot, baseline, outbox, cursor, readThrough, claimAttempts, rejected, deletions, localIds, linkedProject, teamId, repository, history, pendingHistoryImport, historyOutbox, planningBaseline, rejectedHistory, retainedPlanningEvents, workflowRoles, workflowRoleBaseline, workflowRoleOutbox, rejectedWorkflowRoles, sessions, sessionOutbox }));
    const serialized = JSON.stringify({ ...this.profile, connections });
    const pending = this.writes.catch(() => {}).then(async () => {
      const temp = `${this.file}.next`;
      await writeFile(temp, serialized, { encoding: "utf8", mode: 0o600 });
      await replaceWorkspace(temp, this.file);
    });
    this.writes = pending;
    return pending;
  }
  private publishState(): void {
    for (const connection of this.connections.values()) this.sessionSync.apply(connection);
    this.state().team = [...this.unavailable.values(), ...[...this.connections.values()].map((connection) => ({
      projectId: connection.projectId, connection: connection.status, workspace: structuredClone(localTeamSnapshot(connection, connection.snapshot)),
      sessions: connection.sessions?.sessions.map(row => ({ ...row, storyId: localTeamId(connection, "story", row.storyId) })),
      sessionCommands: connection.sessions?.commands.map(row => ({ ...row, storyId: localTeamId(connection, "story", row.storyId) })),
      sessionsError: connection.sessionsError,
      workerActivity: connection.workerActivity?.map(row => ({ ...row, storyId: localTeamId(connection, "story", row.storyId) })),
      ...(connection.teamId ? {teamId:connection.teamId,teamName:this.profile.teams?.find((item)=>item.credential.teamId===connection.teamId)?.snapshot.name} : {}),
      memberId: connection.credential.memberId, deviceId: connection.credential.deviceId,
      pendingCount: connection.outbox.length + (connection.historyOutbox?.length ?? 0) + (connection.pendingHistoryImport ? 1 : 0) + (connection.workflowRoleOutbox?.length ?? 0),
      unreadCount: connection.snapshot.activity.filter((item) => item.sequence > connection.readThrough && item.memberId !== connection.credential.memberId).length,
      lastSyncedAt: connection.lastSyncedAt, error: connection.error ?? connection.workflowRolesError, mode: connection.teamId ? "memtrace" as const : "invite-preview" as const,
      planningHistory: {
        state: connection.historyError ? "error" as const : connection.historySupported === false ? "unsupported" as const : connection.pendingHistoryImport || connection.historyOutbox?.length || connection.outbox.length || !connection.history?.import || connection.history.through < connection.snapshot.head ? "pending" as const : "synced" as const,
        revision: connection.history?.through, hash: connection.history?.import?.hash,
        eventCount: connection.pendingHistoryImport?.history.events.length ?? connection.history?.events.length ?? 0,
        cycleSnapshotCount: (connection.pendingHistoryImport?.history ?? connection.history)?.cycles.reduce((total, cycle) => total + cycle.snapshots.length, 0) ?? 0,
        importAvailable: connection.historySupported === true && !connection.history?.import && !connection.pendingHistoryImport && connection.snapshot.members.find((member) => member.id === connection.credential.memberId)?.role === "owner",
        ...(connection.historyError ? { detail: connection.historyError } : connection.historySupported === false ? { detail: "This Team service syncs the board but does not yet preserve complete planning history. The original local history is retained; update the Team service before relying on another computer's charts." } : !connection.history?.import ? {detail:"The original planning history has not been imported. Existing local charts and runbooks are preserved; the project owner can import the authoritative history."} : {}),
      },
    }))];
  }
  status(projectId: string): TeamWorkspaceState | null {
    return this.state().team?.find((value) => value.projectId === projectId) ?? null;
  }
  private connection(projectId: string): Connection {
    const connection = this.connections.get(projectId);
    if (!connection) throw Error("Share or join this project from Team first.");
    return connection;
  }
  /** Called from workspace persistence. Comparing a bounded whitelist prevents token-event traffic. */
  async capture(): Promise<void> {
    let dirty = false;
    for (const connection of this.connections.values()) {
      if (this.options.background !== false && connection.leases.size) void this.sendWorkerActivity(connection);
      const nextPlanning = remotePlanningMetadata(connection, projectPlanningMetadata(this.state(), connection.projectId));
      const previousPlanning = connection.planningBaseline;
      if (previousPlanning) {
        const priorStories = new Map(previousPlanning.stories.map((item) => [item.id, item]));
        const stories = nextPlanning.stories.filter((item) => !priorStories.has(item.id) || planningValueHash(item) !== planningValueHash(priorStories.get(item.id)));
        const planning = planningValueHash(nextPlanning.planning) !== planningValueHash(previousPlanning.planning) ? nextPlanning.planning : undefined;
        if (stories.length || planning) {
          (connection.historyOutbox ??= []).push({ opId: randomUUID(), metadata: { stories, ...(planning ? { planning } : {}) }, expected: { stories: stories.map((item) => ({id:item.id,hash:priorStories.has(item.id) ? planningValueHash(priorStories.get(item.id)) : null})), ...(planning ? {planningHash:planningValueHash(previousPlanning.planning)} : {}) } });
          dirty = true;
        }
      }
      connection.planningBaseline = nextPlanning;
      const localRoles = this.state().reviewWorkflows?.[connection.projectId];
      if (connection.workflowRolesSupported === true && connection.history?.import && !connection.pendingHistoryImport && connection.workflowRoleBaseline !== undefined && localRoles) {
        const roles = remoteWorkflowRoles(connection, localRoles);
        if (planningValueHash(roles) !== planningValueHash(connection.workflowRoleBaseline)) {
          const operations = (connection.workflowRoleOutbox ??= []);
          operations.push({ opId: randomUUID(), binding: roles, expectedRevision: (connection.workflowRoles?.revision ?? 0) + operations.length, expectedPlanningHash: planningValueHash(nextPlanning.planning) });
          connection.workflowRoleBaseline = roles;
          dirty = true;
        }
      }
      const next = remoteTeamProjection(connection, projectSharedState(this.state(), connection.projectId));
      const rejectedCreates = new Map(connection.pendingHistoryImport
        ? (connection.rejected ?? []).flatMap(({ command }) => command.type === "story.put" && !connection.snapshot.stories.some(story => story.id === command.story.id) ? [[command.story.id, command] as const] : [])
        : []);
      const baseline = rejectedCreates.size ? { ...connection.baseline, stories: connection.baseline.stories.filter(story => !rejectedCreates.has(story.id)) } : connection.baseline;
      // A corrected initial story is a create, not a patch of a remote story
      // that does not exist. Do not repeatedly resend an unchanged rejection.
      const commands = sharedCommands(baseline, next).filter(command => command.type !== "story.put" || !rejectedCreates.has(command.story.id) || planningValueHash(command) !== planningValueHash(rejectedCreates.get(command.story.id)));
      if (!commands.length) continue;
      connection.baseline = next;
      const operations = commands.map((command) => ({ opId: randomUUID(), command, ...(connection.preparingDeletionId && ["story.delete", "epic.delete", "cycle.delete"].includes(command.type) ? { deletionId: connection.preparingDeletionId } : {}) }));
      connection.outbox.push(...operations);
      const backup = connection.deletions?.find((item) => item.id === connection.preparingDeletionId);
      if (backup) backup.operationIds.push(...operations.filter((operation) => operation.deletionId === backup.id).map((operation) => operation.opId));
      dirty = true;
    }
    if (!dirty) return;
    await this.persist();
    this.publishState();
    if (this.options.background !== false) for (const connection of this.connections.values()) void this.flush(connection).catch(() => {});
  }
  private async request<T>(endpoint: string, path: string, capability: string | undefined, body?: unknown, waitMs = 0, raw?: Uint8Array, rawMime = "application/octet-stream", binary = false): Promise<T> {
    if (capability && this.profile.teams?.some((team) => team.endpoint === endpoint && team.credential.capability === capability && team.locked)) throw Error("Reconnect this Team with your Memtrace account before syncing. Local work and queued changes are preserved.");
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), Math.max(10000, waitMs + 5000));
    try {
      const response = await this.requestFetch(endpoint + path, {
        method: raw || body !== undefined ? "POST" : "GET", signal: controller.signal,
        headers: { ...(capability ? { authorization: `Bearer ${capability}` } : {}), ...(raw ? { "content-type": rawMime } : body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(raw ? { body: raw as BodyInit } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: { message?: string; code?: string; details?: unknown } } | null;
        const error = new Error(failure?.error?.message || `Team relay returned ${response.status}.`) as Error & { code?: string; details?: unknown; status?: number };
        error.code = failure?.error?.code;
        error.details = failure?.error?.details;
        error.status = response.status;
        throw error;
      }
      if (!binary && response.headers.get("content-type")?.includes("application/json")) return await response.json() as T;
      if (!binary) return new Uint8Array(await response.arrayBuffer()) as T;
      const limit = 5 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw Error("This shared output exceeds the 5 MB preview limit."); }
      const reader = response.body?.getReader();
      if (!reader) return new Uint8Array() as T;
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > limit) { await reader.cancel(); throw Error("This shared output exceeds the 5 MB preview limit."); }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes as T;
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  private async fail(connection: Connection, error: unknown) {
    connection.status = "offline";
    connection.error = `Team sync is unavailable. Saved changes are queued; new team workers cannot start. ${message(error)}`;
    this.publishState();
    await this.changed();
  }
  private apply(connection: Connection): void {
    if (connection.history?.import) this.state().planning.authoritativeProjects = [...new Set([...(this.state().planning.authoritativeProjects ?? []), connection.projectId])];
    for (const backup of connection.deletions ?? []) if (backup.rejected) {
      this.restoreDeletion(connection, backup);
      const retained = (connection.retainedPlanningEvents ??= []), ids = new Set(retained.map((item) => item.id));
      retained.push(...structuredClone(backup.events.filter((item) => !ids.has(item.id))));
    }
    // An older service must never replace the owner's real chronology with
    // upload-time v1 dates. Its local history stays authoritative until imported.
    const localDates = !connection.localIds && (!connection.history?.import || connection.pendingHistoryImport)
      ? projectPlanningHistory(this.state(), connection.projectId) : undefined;
    // Before the original import is accepted, a partial remote board is not
    // authoritative for deletion. A rejected bootstrap command must never
    // discard the owner's story, conversation or local worker evidence.
    const previous = connection.pendingHistoryImport
      ? emptySharedProjection()
      : localTeamProjection(connection, connection.baseline);
    applySharedSnapshot(this.state(), connection.projectId, localTeamSnapshot(connection, optimistic(connection.snapshot, connection.outbox, connection.baseline, connection.credential.memberId)), previous);
    if (localDates) {
      for (const meta of localDates.stories) {
        const task = this.state().tasks.find((item) => item.id === meta.id && item.projectId === connection.projectId);
        if (task) Object.assign(task, {createdAt:meta.createdAt, updatedAt:meta.updatedAt});
      }
      for (const meta of localDates.comments) {
        const comment = this.state().storyComments?.find((item) => item.id === meta.id);
        if (comment) Object.assign(comment, {createdAt:meta.createdAt, updatedAt:meta.updatedAt, deletedAt:meta.deletedAt});
      }
    }
    if (connection.history?.import && connection.history.through === connection.snapshot.head && !connection.pendingHistoryImport && !connection.outbox.length && !connection.historyOutbox?.length) applyPlanningHistory(this.state(), connection.projectId, connection.history, connection);
    if (this.workflowAuthority(connection) && connection.workflowRoles?.binding && !connection.workflowRoleOutbox?.length) {
      try { applyWorkflowRoles(this.state(), connection.projectId, connection, connection.workflowRoles); connection.workflowRoleBaseline = connection.workflowRoles.binding; }
      catch (failure) { connection.workflowRolesError = `Review workflow roles could not be applied. ${message(failure)}`; }
    }
    if (connection.retainedPlanningEvents?.length) {
      const ids = new Set(this.state().planning.events.map((item) => item.id));
      this.state().planning.events.push(...structuredClone(connection.retainedPlanningEvents.filter((item) => !ids.has(item.id))));
    }
    connection.baseline = remoteTeamProjection(connection, projectSharedState(this.state(), connection.projectId));
    connection.planningBaseline = remotePlanningMetadata(connection, projectPlanningMetadata(this.state(), connection.projectId));
  }
  private async pullHistory(connection: Connection): Promise<void> {
    if (connection.historySupported === false) return;
    try {
      const raw = await this.request(connection.endpoint, `/v1/planning-history?workspaceId=${encodeURIComponent(connection.credential.workspaceId)}${connection.history ? `&after=${connection.history.through}` : ""}`, connection.credential.capability);
      const unchanged = planningHistoryUnchangedSchema.safeParse(raw);
      if (unchanged.success) {
        if (unchanged.data.workspaceId !== connection.credential.workspaceId || unchanged.data.through !== connection.history?.through) throw Error("The Team service returned an inconsistent planning history cursor.");
        connection.historySupported = true; connection.historyError = connection.rejectedHistory?.at(-1)?.message; return;
      }
      const history = planningHistorySchema.parse(raw);
      if (history.workspaceId !== connection.credential.workspaceId) throw Error("The Team service returned history for a different project.");
      if (!connection.history || history.through >= connection.history.through) connection.history = history;
      connection.historySupported = true; connection.historyError = connection.rejectedHistory?.at(-1)?.message;
    } catch (error) {
      if ([404, 405, 501].includes((error as Error & {status?: number}).status ?? 0)) { connection.historySupported = false; return; }
      connection.historyError = `Planning history could not synchronize. Its saved records were preserved. ${message(error)}`;
      throw error;
    }
  }
  private workflowAuthority(connection: Connection): boolean {
    return !!connection.history?.import && connection.history.through === connection.snapshot.head && (!connection.workflowRoles || connection.workflowRoles.through <= connection.history.through) && !connection.pendingHistoryImport && !connection.outbox.length && !connection.historyOutbox?.length;
  }
  private async pullWorkflowRoles(connection: Connection): Promise<void> {
    if (connection.workflowRolesSupported === false) return;
    try {
      const roles = workflowRolesSchema.parse(await this.request(connection.endpoint, `/v1/workflow-roles?workspaceId=${encodeURIComponent(connection.credential.workspaceId)}`, connection.credential.capability));
      if (roles.workspaceId !== connection.credential.workspaceId || roles.revision < (connection.workflowRoles?.revision ?? 0)) throw Error("The Team service returned inconsistent workflow role provenance.");
      connection.workflowRoles = roles;
      connection.workflowRolesSupported = true;
      if (connection.workflowRoleBaseline === undefined) connection.workflowRoleBaseline = roles.binding;
      connection.workflowRolesError = connection.rejectedWorkflowRoles?.at(-1)?.message;
    } catch (failure) {
      if ([404, 405, 501].includes((failure as Error & { status?: number }).status ?? 0)) { connection.workflowRolesSupported = false; return; }
      connection.workflowRolesError = `Review workflow roles could not synchronize. Saved bindings were preserved. ${message(failure)}`;
      throw failure;
    }
  }
  private async flushWorkflowRoles(connection: Connection): Promise<void> {
    await this.pullWorkflowRoles(connection);
    // An invitation/member event may advance history before this device has
    // consumed its ordinary board journal. Establish that boundary first.
    while (connection.history && connection.cursor < Math.max(connection.history.through, connection.workflowRoles?.through ?? 0) && !this.closed) await this.pull(connection);
    if (connection.workflowRolesSupported !== true || !this.workflowAuthority(connection) || this.closed) return;
    const owner = connection.snapshot.members.find((member) => member.id === connection.credential.memberId)?.role === "owner";
    // Legacy owners may have used the implicit default without saving any
    // workflow states. Imported boards still wait for accepted explicit roles.
    const workflow = this.state().workflowStates.filter((item) => item.projectId === connection.projectId);
    const builtInWorkflow = !workflow.length || workflow.some((item) => item.id === `${connection.projectId}:review`);
    if (owner && !connection.localIds && !connection.workflowRoles?.binding && !this.state().reviewWorkflows?.[connection.projectId] && builtInWorkflow) initializeCodeReviewWorkflow(this.state(), connection.projectId, { assignLegacyTasks: false });
    await this.capture();
    if (connection.historyOutbox?.length) await this.flushHistory(connection);
    if (!this.workflowAuthority(connection)) return;
    while (connection.workflowRoleOutbox?.length && !this.closed) {
      const operation = connection.workflowRoleOutbox[0];
      try {
        const response = await this.request<{ roles: unknown }>(connection.endpoint, "/v1/workflow-roles", connection.credential.capability, { version: 1, workspaceId: connection.credential.workspaceId, ...operation });
        const roles = workflowRolesSchema.parse(response.roles);
        if (roles.workspaceId !== connection.credential.workspaceId) throw Error("The accepted workflow roles belong to another project.");
        connection.workflowRoles = roles;
        connection.workflowRoleOutbox = connection.workflowRoleOutbox.filter((item) => item.opId !== operation.opId);
        await this.persist();
        while (connection.cursor < roles.through && !this.closed) await this.pull(connection);
      } catch (failure) {
        const status = (failure as Error & { status?: number }).status;
        if (status !== 409 && status !== 403) throw failure;
        const rejected = { ...operation, message: `A review workflow edit was rejected and retained on this computer. ${message(failure)}`, at: new Date().toISOString() };
        (connection.rejectedWorkflowRoles ??= []).push(rejected);
        connection.workflowRoleOutbox = connection.workflowRoleOutbox.filter((item) => item.opId !== operation.opId);
        connection.workflowRolesError = rejected.message;
        await this.pullWorkflowRoles(connection); await this.persist();
      }
    }
    this.apply(connection);
  }
  private activityUnavailable(connection: Connection, failure: unknown) {
    const status = (failure as { status?: number }).status;
    connection.activityRetryAt = Date.now() + ([404, 405, 501].includes(status ?? 0) ? 60000 : 3000);
  }
  private sendWorkerActivity(connection: Connection): Promise<void> {
    if (connection.sendingActivity) return connection.sendingActivity;
    if (this.closed || !connection.leases.size || Date.now() < (connection.activityRetryAt ?? 0)) return Promise.resolve();
    const sent = (connection.lastActivity ??= new Map());
    connection.sendingActivity = (async () => {
      for (const [taskId, claim] of connection.leases) {
        const task = this.state().tasks.find(t => t.id === taskId && t.projectId === connection.projectId);
        const report = task && reportWorker(task, claim, connection.credential.workspaceId);
        if (!report) continue;
        const key = JSON.stringify(report), previous = sent.get(taskId);
        if (previous?.key === key && Date.now() - previous.at < 15000) continue;
        try {
          await this.request(connection.endpoint, "/v1/worker-activity", connection.credential.capability, report);
        } catch (failure) {
          // A released claim must not block reports for other active stories.
          if ((failure as { status?: number }).status === 409) continue;
          throw failure;
        }
        if (connection.leases.get(taskId) === claim) sent.set(taskId, { key, at: Date.now() });
      }
    })().catch(error => this.activityUnavailable(connection, error)).finally(() => { connection.sendingActivity = undefined; });
    return connection.sendingActivity;
  }
  private readWorkerActivity(connection: Connection): Promise<boolean> {
    if (connection.readingActivity) return connection.readingActivity;
    if (!connection.snapshot.claims.some(c => c.deviceId !== connection.credential.deviceId)) {
      const changed = !!connection.workerActivity?.length;
      connection.workerActivity = undefined;
      return Promise.resolve(changed);
    }
    if (Date.now() < (connection.activityRetryAt ?? 0)) return Promise.resolve(false);
    connection.readingActivity = (async () => {
      const path = "/v1/worker-activity?workspaceId=" + encodeURIComponent(connection.credential.workspaceId);
      const raw = await this.request(connection.endpoint, path, connection.credential.capability);
      const { workers } = workerReports.parse(raw);
      if (this.closed || this.connections.get(connection.projectId) !== connection) return false;
      const visible = workers.filter(row => connection.snapshot.claims.some(claim => claim.storyId === row.storyId && claim.attemptId === row.attemptId && claim.epoch === row.epoch && claim.deviceId !== connection.credential.deviceId));
      if (JSON.stringify(visible) === JSON.stringify(connection.workerActivity ?? [])) return false;
      connection.workerActivity = visible;
      return true;
    })().catch(error => { this.activityUnavailable(connection, error); return false; }).finally(() => { connection.readingActivity = undefined; });
    return connection.readingActivity;
  }
  private async pull(connection: Connection, waitMs = 0): Promise<void> {
    const query = new URLSearchParams({ workspaceId: connection.credential.workspaceId, after: String(connection.cursor), waitMs: String(waitMs) });
    const reply = teamSyncReplySchema.parse(await this.request(connection.endpoint, `/v1/sync?${query}`, connection.credential.capability, undefined, waitMs));
    if (this.closed || this.connections.get(connection.projectId) !== connection) return;
    const previous = connection.cursor;
    const previousHistory = connection.history?.through;
    const previousRoles = connection.workflowRoles?.revision;
    if (reply.snapshot && reply.snapshot.head >= connection.snapshot.head) connection.snapshot = reply.snapshot as TeamSnapshot;
    for (const event of reply.events) if (event.sequence > connection.snapshot.head) {
      if (event.sequence !== connection.snapshot.head + 1) throw Error("Team history has a gap; reconnect to backfill the missing changes.");
      connection.snapshot = applyTeamEvent(connection.snapshot, event);
    }
    connection.cursor = Math.max(connection.cursor, reply.cursor);
    await this.pullHistory(connection);
    await this.pullWorkflowRoles(connection);
    connection.status = "online"; connection.error = connection.rejected?.length ? `A change was rejected: ${connection.rejected.at(-1)!.message}. Other changes continue syncing.` : undefined; connection.lastSyncedAt = new Date().toISOString();
    const activityChanged = await this.readWorkerActivity(connection);
    if (reply.snapshot || connection.cursor !== previous || connection.history?.through !== previousHistory || connection.workflowRoles?.revision !== previousRoles) {
      this.apply(connection);
      await this.persist();
      this.publishState();
      await this.changed();
    } else {
      this.publishState();
      if (activityChanged) {
        if (this.options.onWorkerActivity) this.options.onWorkerActivity();
        else await this.changed();
      }
    }
    if (reply.hasMore) await this.pull(connection);
  }
  private flush(connection: Connection): Promise<void> {
    if (connection.flushing) return connection.flushing;
    const pending = (async () => {
      try {
        while (connection.outbox.length && !this.closed) {
          const operation = connection.outbox[0];
          let reply: TeamCommandReply;
          try {
            reply = await this.request<TeamCommandReply>(connection.endpoint, "/v1/commands", connection.credential.capability, { workspaceId: connection.credential.workspaceId, opId: operation.opId, command: operation.command });
          } catch (error) {
            const status = (error as Error & { status?: number }).status;
            const code = (error as Error & { code?: string }).code;
            if (!status || status >= 500 || status === 408 || status === 429 || status === 401 || ["AUTH", "TEAM_AUTH", "TEAM_REVOKED"].includes(code ?? "")) throw error;
            // A semantic rejection must not hold unrelated later edits hostage.
            connection.rejected = [...(connection.rejected ?? []), { ...operation, message: message(error), at: new Date().toISOString() }].slice(-50);
            const backup = connection.deletions?.find((item) => item.id === operation.deletionId);
            if (backup) { backup.rejected = true; backup.operationIds = backup.operationIds.filter((id) => id !== operation.opId); }
            connection.outbox = connection.outbox.filter((item) => item.opId !== operation.opId);
            this.apply(connection); await this.persist();
            connection.error = `A change was rejected: ${message(error)}. The accepted shared state has been restored; other changes continue syncing.`;
            this.publishState(); await this.changed();
            if (backup && !connection.outbox.some((item) => item.deletionId === backup.id)) {
              connection.deletions = connection.deletions?.filter((item) => item.id !== backup.id);
              await this.persist();
            }
            continue;
          }
          // Backfill intervening accepted operations before consuming this ACK.
          while (connection.cursor < reply.event.sequence && !this.closed) await this.pull(connection);
          if (connection.pendingHistoryImport && operation.command.type === "story.put") {
            const storyId = operation.command.story.id;
            const unresolved = (connection.rejected ?? []).filter(item => item.command.type !== "story.put" || item.command.story.id !== storyId);
            if (unresolved.length !== (connection.rejected?.length ?? 0)) {
              connection.rejected = unresolved;
              // The original import was refused, never committed. Retry its
              // preserved history against the board containing this correction.
              connection.pendingHistoryImport.expectedHead = undefined;
            }
          }
          connection.outbox = connection.outbox.filter((item) => item.opId !== operation.opId);
          const backup = connection.deletions?.find((item) => item.id === operation.deletionId);
          if (backup) {
            backup.operationIds = backup.operationIds.filter((id) => id !== operation.opId);
            if (!backup.operationIds.length && !backup.rejected) connection.deletions = connection.deletions?.filter((item) => item.id !== backup.id);
          }
          this.apply(connection);
          await this.persist();
          if (backup?.rejected && !backup.operationIds.length) {
            await this.changed();
            connection.deletions = connection.deletions?.filter((item) => item.id !== backup.id);
            await this.persist();
          }
        }
        await this.flushHistory(connection);
        await this.flushWorkflowRoles(connection);
        connection.status = "online"; connection.error = connection.rejected?.length ? `A change was rejected: ${connection.rejected.at(-1)!.message}. Other changes continue syncing.` : undefined;
        this.publishState();
        await this.changed();
      } catch (error) { if (!this.closed) await this.fail(connection, error); throw error; }
    })().finally(() => { connection.flushing = undefined; });
    connection.flushing = pending;
    return pending;
  }
  private async flushHistory(connection: Connection): Promise<void> {
    await this.pullHistory(connection);
    if (connection.historySupported === false || this.closed) return;
    const pending = connection.pendingHistoryImport;
    if (pending) {
      // A teammate may have joined while this app still talked to a v1-only
      // service. Catch up its ordinary board journal before fixing the import
      // boundary, without replacing the queued original source history.
      while (connection.history && connection.cursor < connection.history.through && !this.closed) await this.pull(connection);
      pending.expectedHead ??= connection.snapshot.head;
      await this.persist();
      try {
        const reply = await this.request<{history:unknown}>(connection.endpoint, "/v1/planning-history", connection.credential.capability, {workspaceId:connection.credential.workspaceId,opId:pending.opId,expectedHead:pending.expectedHead,history:pending.history});
        connection.history = planningHistorySchema.parse(reply.history);
        connection.pendingHistoryImport = undefined; connection.historyError = undefined;
        await this.persist();
        while (connection.cursor < connection.history.through && !this.closed) await this.pull(connection);
      } catch (error) { connection.historyError = `Original planning history has not finished sharing. Its source records are preserved. ${message(error)}`; throw error; }
    }
    while (connection.historyOutbox?.length && !this.closed) {
      const operation = connection.historyOutbox[0];
      let reply: {history:unknown};
      try { reply = await this.request<{history:unknown}>(connection.endpoint, "/v1/planning-history/metadata", connection.credential.capability, {workspaceId:connection.credential.workspaceId,opId:operation.opId,...operation.metadata,expected:operation.expected}); }
      catch (error) {
        if ((error as Error & {status?:number}).status !== 409) throw error;
        const rejected = {...operation,message:`A planning edit was rejected and saved on this computer. ${message(error)}`,at:new Date().toISOString()};
        (connection.rejectedHistory ??= []).push(rejected);
        connection.historyOutbox = connection.historyOutbox.filter((item) => item.opId !== operation.opId);
        connection.historyError = rejected.message;
        await this.pullHistory(connection); await this.persist(); continue;
      }
      connection.history = planningHistorySchema.parse(reply.history);
      connection.historyOutbox = connection.historyOutbox.filter((item) => item.opId !== operation.opId);
      await this.persist();
      while (connection.cursor < connection.history.through && !this.closed) await this.pull(connection);
    }
    this.apply(connection);
  }
  private startLoop(connection: Connection) {
    if (this.options.background === false) return;
    void (async () => {
      let lastFlush = 0;
      while (!this.closed && this.connections.get(connection.projectId) === connection) {
        if (connection.teamId && this.profile.teams?.some((team) => team.credential.teamId === connection.teamId && team.locked)) {
          await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1500); timer.unref(); });
          continue;
        }
        try {
          const pendingEdits = connection.outbox.length || connection.historyOutbox?.length ||
            connection.workflowRoleOutbox?.length || connection.pendingHistoryImport;
          if (pendingEdits || Date.now() - lastFlush >= 10000) {
            await this.flush(connection);
            lastFlush = Date.now();
          }
          if (connection.leases.size) void this.sendWorkerActivity(connection);
          await this.sessionSync.sync(connection);
          const hosting = connection.sessions?.sessions.some(s => s.owner.memberId === connection.credential.memberId && s.owner.deviceId === connection.credential.deviceId &&
            (["preparing", "running", "stopping"].includes(s.state) || ["queued", "running"].includes(s.review?.state ?? "")));
          await this.pull(connection, connection.leases.size || hosting ? 1000 : 10000);
        }
        catch (error) {
          if (this.closed) break;
          await this.fail(connection, error).catch(() => {});
          await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1500); timer.unref(); });
        }
      }
    })();
  }
  async synchronize(projectId: string): Promise<void> {
    const connection = this.connection(projectId);
    // Explicit Refresh can discover a service upgraded while the app stayed
    // open. Background long polls keep their inexpensive negative cache.
    if (connection.historySupported === false) connection.historySupported = undefined;
    if (connection.workflowRolesSupported === false) connection.workflowRolesSupported = undefined;
    connection.sessionsUnsupported = false;
    connection.activityRetryAt = undefined;
    await this.capture(); await this.flush(connection); await this.sendWorkerActivity(connection); await this.pull(connection); await this.sessionSync.sync(connection);
  }
  /** Explicit upgrade path for a project shared by a pre-history client. */
  async importPlanningHistory(projectId: string): Promise<TeamWorkspaceState> {
    const connection = this.connection(projectId);
    if (connection.historySupported === false) connection.historySupported = undefined;
    if (connection.snapshot.members.find((member) => member.id === connection.credential.memberId)?.role !== "owner") throw Error("Only this project's owner can import its original planning history.");
    if (this.state().tasks.some((task) => task.projectId === projectId && ["preparing", "running", "stopping"].includes(task.run.state))) throw Error("Stop this project's workers before importing its original planning history.");
    if (!connection.pendingHistoryImport) {
      if (connection.history?.import) throw Error("This project's original planning history has already been imported. Its accepted history was preserved.");
      connection.pendingHistoryImport = {opId:randomUUID(),history:remotePlanningSeed(connection, projectPlanningHistory(this.state(), projectId))};
      await this.persist();
    }
    await this.capture(); await this.flush(connection); await this.pull(connection);
    return this.status(projectId)!;
  }
  async assertDeletionAllowed(method: string, id: string): Promise<void> {
    const collection = method === "story:delete" ? this.state().tasks : method === "epic:delete" ? this.state().epics : this.state().cycles;
    const entity = collection.find((item) => item.id === id);
    if (!entity) return;
    if (this.unavailable.has(entity.projectId)) throw Error("Restore this project’s private Team credentials before deleting shared planning.");
    if (!this.connections.has(entity.projectId)) return;
    // The safety refresh must preserve local historical evidence that predates
    // the canonical feed, so a rejected deletion can restore it as promised.
    const localEvents = structuredClone(this.state().planning.events.filter((event) => event.projectId === entity.projectId));
    await this.synchronize(entity.projectId);
    const guarded = this.connection(entity.projectId), known = new Set(this.state().planning.events.map((event) => event.id));
    const retained = (guarded.retainedPlanningEvents ??= []), saved = new Set(retained.map((event) => event.id));
    retained.push(...localEvents.filter((event) => !known.has(event.id) && !saved.has(event.id)));
    this.state().planning.events.push(...retained.filter((event) => !known.has(event.id)));
    await this.persist();
    const taskIds = new Set(this.state().tasks.filter((task) => method === "story:delete" ? task.id === id : method === "epic:delete" ? task.epicId === id : task.cycleId === id).map((task) => task.id));
    if (method === "story:delete") for (const taskId of taskIds) for (const task of this.state().tasks) if (task.parentId === taskId) taskIds.add(task.id);
    const connection = this.connection(entity.projectId);
    const claim = connection.snapshot.claims.find((claim) => taskIds.has(localTeamId(connection, "story", claim.storyId)));
    if (claim) {
      const owner = connection.snapshot.members.find((member) => member.id === claim.memberId)?.name ?? "A teammate";
      throw Error(`${owner} has an active story claim. Stop or hand off that worker before deleting this planning item.`);
    }
  }
  /** Persist just the records a metadata deletion can remove, before it mutates. */
  async beginDeletion(method: string, id: string): Promise<{ projectId: string; id: string } | undefined> {
    const state = this.state();
    const entity = (method === "story:delete" ? state.tasks : method === "epic:delete" ? state.epics : state.cycles).find((item) => item.id === id);
    const connection = entity && this.connections.get(entity.projectId);
    if (!connection) return;
    if (connection.preparingDeletionId) throw Error("Wait for the previous planning deletion to be saved.");
    const ids = new Set(state.tasks.filter((task) => method === "story:delete" ? task.id === id : method === "epic:delete" ? task.epicId === id : task.cycleId === id).map((task) => task.id));
    if (method === "story:delete") for (const owner of ids) for (const task of state.tasks) if (task.parentId === owner) ids.add(task.id);
    const backup: DeletionBackup = {
      id: randomUUID(), operationIds: [], tasks: state.tasks.filter((task) => ids.has(task.id)),
      artifacts: state.artifacts.filter((artifact) => ids.has(artifact.taskId)),
      comments: (state.storyComments ?? []).filter((comment) => ids.has(comment.taskId)),
      reviews: (state.reviewComments ?? []).filter((comment) => ids.has(comment.taskId)),
      events: state.planning.events.filter((event) => ids.has(event.taskId)),
      observations: Object.fromEntries(Object.entries(state.planning.observations).filter(([taskId]) => ids.has(taskId))),
      epics: method === "epic:delete" ? state.epics.filter((epic) => epic.id === id) : [],
      cycles: method === "cycle:delete" ? state.cycles.filter((cycle) => cycle.id === id) : [],
    };
    const serialized = JSON.stringify(backup);
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(connection.deletions ?? [])) + Buffer.byteLength(serialized) > 24 * 1024 * 1024) throw Error("Sync pending deletions first, or archive this large story to preserve its local history.");
    const frozen = JSON.parse(serialized) as DeletionBackup;
    (connection.deletions ??= []).push(frozen);
    connection.preparingDeletionId = frozen.id;
    try { await this.persist(); } catch (error) {
      connection.deletions = connection.deletions.filter((item) => item.id !== frozen.id);
      connection.preparingDeletionId = undefined; throw error;
    }
    return { projectId: connection.projectId, id: frozen.id };
  }
  async finishDeletion(token: { projectId: string; id: string } | undefined): Promise<void> {
    if (!token) return;
    const connection = this.connections.get(token.projectId); if (!connection) return;
    if (connection.preparingDeletionId === token.id) connection.preparingDeletionId = undefined;
    const backup = connection.deletions?.find((item) => item.id === token.id);
    if (backup && !backup.operationIds.length) connection.deletions = connection.deletions?.filter((item) => item.id !== token.id);
    await this.persist();
  }
  private restoreDeletion(connection: Connection, backup: DeletionBackup): void {
    const state = this.state();
    const retained = new Set(connection.snapshot.stories.map((story) => localTeamId(connection, "story", story.id)));
    const ids = new Set(backup.tasks.filter((task) => retained.has(task.id)).map((task) => task.id));
    for (const task of backup.tasks) if (ids.has(task.id)) {
      const index = state.tasks.findIndex((item) => item.id === task.id);
      if (index < 0) state.tasks.push(structuredClone(task));
      else if (!["preparing", "running", "stopping"].includes(state.tasks[index].run.state)) state.tasks[index] = structuredClone(task);
    }
    const restore = <T extends { id: string }>(target: T[], items: T[]) => {
      const existing = new Set(target.map((item) => item.id));
      target.push(...structuredClone(items.filter((item) => !existing.has(item.id))));
    };
    restore(state.artifacts, backup.artifacts.filter((item) => ids.has(item.taskId)));
    restore(state.storyComments ??= [], backup.comments.filter((item) => ids.has(item.taskId)));
    restore(state.reviewComments ??= [], backup.reviews.filter((item) => ids.has(item.taskId)));
    restore(state.planning.events, backup.events.filter((item) => ids.has(item.taskId)));
    for (const [taskId, observation] of Object.entries(backup.observations)) if (ids.has(taskId)) state.planning.observations[taskId] = structuredClone(observation);
    restore(state.epics, backup.epics.filter((item) => connection.snapshot.epics.some((epic) => localTeamId(connection, "epic", epic.id) === item.id)));
    restore(state.cycles, backup.cycles.filter((item) => connection.snapshot.cycles.some((cycle) => localTeamId(connection, "cycle", cycle.id) === item.id)));
  }
  private async attach(projectId: string, endpoint: string, reply: TeamSessionReply, baseline: SharedProjection, linkedProject?: Project, binding?: { teamId: string; repository?: RepositoryDescriptor }) {
    if ([...this.connections.values()].some((connection) => connection.credential.workspaceId === reply.credential.workspaceId && connection.endpoint === endpoint)) throw Error("This team is already connected to another local project in this profile. Open that project instead.");
    const connection: Connection = { projectId, endpoint, credential: reply.credential, snapshot: reply.snapshot, baseline, outbox: [], cursor: reply.snapshot.head, readThrough: 0, status: "online", leases: new Map(), ...(linkedProject ? { localIds: emptyTeamLocalIds(), linkedProject } : {}), ...binding };
    await this.pullHistory(connection);
    await this.pullWorkflowRoles(connection);
    // Validate the entire incoming projection before persisting credentials or
    // modifying the real workspace, so a failed binding leaves no half-join.
    const staged = structuredClone(this.state());
    if (linkedProject) staged.projects.push(structuredClone(linkedProject));
    applySharedSnapshot(staged, projectId, localTeamSnapshot(connection, reply.snapshot), localTeamProjection(connection, baseline));
    if (connection.history?.import && connection.history.through === connection.snapshot.head) applyPlanningHistory(staged, projectId, connection.history, connection);
    if (this.workflowAuthority(connection) && connection.workflowRoles?.binding) applyWorkflowRoles(staged, projectId, connection, connection.workflowRoles);
    this.connections.set(projectId, connection);
    try { await this.persist(); } catch (error) { this.connections.delete(projectId); throw error; }
    if (linkedProject) this.state().projects.push(linkedProject);
    this.state().activeProjectId = projectId;
    this.apply(connection); this.publishState(); await this.changed(); this.startLoop(connection);
    return this.status(projectId)!;
  }
  private device() { return { deviceId: this.profile.deviceId, deviceName: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Mac" : "Linux" }; }
  private serviceStatus?: { endpoint: string; selfServiceTeams: boolean; expires: number };
  private async serviceConfiguration(): Promise<{ endpoint: string; bootstrapSecret?: string; selfServiceTeams?: boolean } | undefined> {
    try {
      const value = JSON.parse(await readFile(join(this.dataDir, "team", "service.private.json"), "utf8")) as { endpoint: string; bootstrapSecret?: string };
      return { endpoint: endpointURL(value.endpoint), ...(value.bootstrapSecret ? { bootstrapSecret: value.bootstrapSecret } : {}) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("The private Team service configuration is invalid. Its file has been preserved."); }
    if (!this.options.serviceDiscovery) return undefined;
    let service: { endpoint: string } | undefined;
    try { service = await this.options.serviceDiscovery(); } catch { return undefined; }
    if (!service) return undefined;
    const endpoint = endpointURL(service.endpoint);
    if (this.serviceStatus?.endpoint === endpoint && this.serviceStatus.expires > Date.now()) return this.serviceStatus;
    try {
      const status = await this.request<{ version?: unknown; selfServiceTeams?: unknown }>(endpoint, "/v1/service", undefined);
      if (status.version !== 1 || typeof status.selfServiceTeams !== "boolean") return undefined;
      this.serviceStatus = { endpoint, selfServiceTeams: status.selfServiceTeams, expires: Date.now() + 30_000 };
      return this.serviceStatus;
    } catch { return undefined; }
  }
  private savedTeam(teamId: string, allowLocked = false): SavedTeam {
    const value = this.profile.teams?.find((team) => team.credential.teamId === teamId);
    if (!value) throw Error("Join this Team with your Memtrace account first.");
    if (value.locked && !allowLocked) throw Error("Reconnect this Team with your Memtrace account first. Local work and queued changes are preserved.");
    return value;
  }
  private async saveTeam(endpoint: string, session: TeamSpaceSession) {
    const prior = this.profile.teams ?? [];
    if(prior.some((item)=>item.credential.teamId===session.credential.teamId&&item.endpoint!==endpoint))throw Error("This Team identifier is already bound to a different service. Existing Team connections have been preserved.");
    const previous = prior.find((item)=>item.endpoint===endpoint&&item.credential.teamId===session.credential.teamId);
    if(previous&&previous.credential.subject!==session.credential.subject) throw Error("This local Team binding belongs to another Memtrace account. Its saved work has been preserved.");
    const credentials = new Map<string,TeamCredential>();
    for(const connection of this.connections.values()) if(connection.endpoint===endpoint&&connection.teamId===session.credential.teamId){
      credentials.set(connection.projectId,connection.credential);
      connection.credential={workspaceId:connection.credential.workspaceId,memberId:session.credential.memberId,deviceId:session.credential.deviceId,capability:session.credential.capability};
    }
    this.profile.teams = [...prior.filter((item) => item.credential.teamId !== session.credential.teamId || item.endpoint !== endpoint), { endpoint, credential: session.credential, snapshot: session.team }];
    try { await this.persist(); } catch (error) { this.profile.teams = prior;for(const[id,credential]of credentials)this.connection(id).credential=credential; throw error; }
  }
  private async accountProof(endpoint: string): Promise<{ proof: string; nonce: string }> {
    const epoch = this.accountEpoch;
    if (!this.options.identityProof) throw Error("Verified Team sign-in is not configured in this MemCode runtime. Your existing local work is preserved.");
    const challenge = await this.request<TeamIdentityChallenge>(endpoint, "/v1/team-auth/challenge", undefined);
    if (challenge.audience !== endpointURL(endpoint) || !/^[A-Za-z0-9_-]{32,200}$/.test(challenge.nonce) || !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) > Date.now() + 5 * 60 * 1000 + 10000) throw Error("The Team service returned an invalid identity challenge.");
    const proof = await this.options.identityProof(challenge);
    if (epoch !== this.accountEpoch) throw Error("The Memtrace account changed during sign-in. Retry with the account you want to use.");
    return { proof, nonce: challenge.nonce };
  }
  private decoratedTeam(saved: SavedTeam, connection: WorkspaceTeam["connection"] = "online", error?: string): WorkspaceTeam {
    const value = structuredClone(saved.snapshot);
    value.projects = value.projects.map((project) => ({ ...project, localProjectId: [...this.connections.values()].find((item) => item.endpoint === saved.endpoint && item.credential.workspaceId === project.workspaceId)?.projectId }));
    return { ...value, connection, ...(error ? { error } : {}) };
  }
  async teamsList(): Promise<TeamDirectory> {
    const service = await this.serviceConfiguration();
    const identityAvailable = !!this.options.identityProof && (this.options.identityAvailable ? await this.options.identityAvailable().catch(() => false) : true);
    const teams = await Promise.all((this.profile.teams ?? []).map(async (saved) => {
      if (saved.locked) return this.decoratedTeam(saved, "signed-out", "Reconnect with your Memtrace account to sync this Team. Local work and queued changes are preserved.");
      try { saved.snapshot = await this.request<WorkspaceTeam>(saved.endpoint, `/v1/teams?teamId=${encodeURIComponent(saved.credential.teamId)}`, saved.credential.capability); return this.decoratedTeam(saved); }
      catch (error) { return this.decoratedTeam(saved, (error as Error & { code?: string }).code === "TEAM_REVOKED" ? "revoked" : "offline", message(error)); }
    }));
    await this.persist();
    return { teams, configured: !!service || !!this.profile.teams?.length, canCreate: !!service?.bootstrapSecret || service?.selfServiceTeams === true, identityAvailable, ...(!identityAvailable ? {detail:"Verified Team sign-in is not available yet. Your local projects and existing preview rooms remain available."} : !service && !this.profile.teams?.length ? { detail: "The Team service is not available yet. Invitation links can still connect to their Team service." } : service && !service.bootstrapSecret && !service.selfServiceTeams ? {detail:"This Team service accepts invitations; new Team creation is managed by its operator."} : {}) };
  }
  async createTeamWorkspace(input: { name: string }): Promise<WorkspaceTeam> {
    if (this.creatingTeam) throw Error("A Team is already being created. Finish its Memtrace sign-in first.");
    this.creatingTeam = true;
    const epoch = this.accountEpoch;
    try {
    const service = await this.serviceConfiguration();
    if (!service || (!service.bootstrapSecret && !service.selfServiceTeams)) throw Error("A Team service with account-based creation is not available yet. You can still join an invitation.");
    const creates=(this.profile.teamCreates??=[]);
    let operation=creates.find((item)=>item.name===input.name);
    if(!operation){operation={name:input.name,opId:randomUUID()};creates.push(operation);await this.persist();}
    const session = await this.request<TeamSpaceSession>(service.endpoint, "/v1/teams", service.bootstrapSecret, { name: input.name, opId:operation.opId,...await this.accountProof(service.endpoint), ...this.device() });
    if (epoch !== this.accountEpoch) throw Error("The Memtrace account changed before Team creation finished. No Team connection was opened on this computer.");
    await this.saveTeam(service.endpoint, session);
    this.profile.teamCreates=this.profile.teamCreates?.filter((item)=>item.opId!==operation!.opId);await this.persist();
    return this.decoratedTeam(this.savedTeam(session.team.id));
    } finally { this.creatingTeam = false; }
  }
  async inviteTeamMember(input: { teamId: string; projectWorkspaceId?: string; email?: string }): Promise<TeamMemberInvitation> {
    const saved = this.savedTeam(input.teamId);
    const value = await this.request<{ invitation: string; expiresAt: string; invitedEmail?: string }>(saved.endpoint, "/v1/teams/invites", saved.credential.capability, input);
    return { url: formatTeamInvitation(saved.endpoint, input.teamId, value.invitation), expiresAt: value.expiresAt, ...(value.invitedEmail ? { invitedEmail: value.invitedEmail } : {}) };
  }
  async previewTeamInvitation(input: { invite: string }): Promise<TeamInvitationPreview> {
    const invite = parseTeamInvitation(input.invite);
    if (invite.kind !== "team") throw Error("This is an older project-preview invitation. Use the preview section to join it; it does not establish verified Team membership.");
    const existing = this.profile.teams?.find((item) => item.endpoint === invite.endpoint && item.credential.teamId === invite.id && !item.locked);
    const body={ teamId: invite.id, invitation: invite.invitation };
    try{return await this.request(invite.endpoint, "/v1/teams/invites/preview", existing?.credential.capability, body);}
    catch(error){
      if(!existing||!["TEAM_AUTH","TEAM_REVOKED"].includes((error as Error&{code?:string}).code??""))throw error;
      // A new targeted invitation may restore revoked membership. Preview it
      // as an invitation holder; acceptance still requires a fresh proof.
      return this.request(invite.endpoint,"/v1/teams/invites/preview",undefined,body);
    }
  }
  async acceptTeamInvitation(input: { invite: string }): Promise<AcceptedTeamInvitation> {
    const epoch = this.accountEpoch;
    const invite = parseTeamInvitation(input.invite);
    if (invite.kind !== "team") throw Error("Use the project-preview flow for this older invitation.");
    const key = `team:${invite.endpoint}/${invite.id}`;
    if (this.pendingJoins.has(key)) throw Error("This Team invitation is already being opened.");
    this.pendingJoins.add(key);
    try {
      const existing = this.profile.teams?.find((item) => item.endpoint === invite.endpoint && item.credential.teamId === invite.id);
      let saved = existing;
      let workspaceId: string | undefined;
      let usable = !!saved && !saved.locked;
      if (saved && usable) {
        try {
          const preview = await this.request<TeamInvitationPreview>(saved.endpoint, "/v1/teams/invites/preview", saved.credential.capability, {teamId:invite.id,invitation:invite.invitation});
          workspaceId = preview.projectWorkspaceId;
          saved.snapshot = await this.request<WorkspaceTeam>(saved.endpoint, `/v1/teams?teamId=${encodeURIComponent(invite.id)}`, saved.credential.capability);
        } catch(error) {
          if(!["TEAM_AUTH","TEAM_REVOKED"].includes((error as Error&{code?:string}).code??"")) throw error;
          usable=false;
        }
      }
      if (!usable) {
        const session = await this.request<TeamSpaceSession>(invite.endpoint, "/v1/teams/invites/accept", undefined, { teamId: invite.id, invitation: invite.invitation, ...await this.accountProof(invite.endpoint), ...this.device() });
        if (epoch !== this.accountEpoch) throw Error("The Memtrace account changed before joining finished. Reconnect with the intended account.");
        await this.saveTeam(invite.endpoint, session); saved = this.savedTeam(invite.id); workspaceId = session.projectWorkspaceId;
      }
      workspaceId ??= saved!.snapshot.projects[0]?.workspaceId;
      const project = workspaceId ? await this.openTeamProject({ teamId: invite.id, workspaceId }) : undefined;
      return { team: this.decoratedTeam(saved!), ...(project ? { project } : {}) };
    } finally { this.pendingJoins.delete(key); }
  }
  async openTeamProject(input: { teamId: string; workspaceId: string }): Promise<TeamWorkspaceState> {
    const key=input.teamId+"/"+input.workspaceId,previous=this.pendingOpens.get(key);
    if(previous)return previous;
    const pending=this.openProject(input).finally(()=>{if(this.pendingOpens.get(key)===pending)this.pendingOpens.delete(key);});
    this.pendingOpens.set(key,pending);return pending;
  }
  private async openProject(input: {teamId:string;workspaceId:string}):Promise<TeamWorkspaceState>{
    const saved = this.savedTeam(input.teamId);
    const reply = teamSessionReplySchema.parse(await this.request(saved.endpoint, "/v1/teams/projects/open", saved.credential.capability, input)) as TeamSessionReply;
    const existing = [...this.connections.values()].find((item) => item.endpoint === saved.endpoint && item.credential.workspaceId === input.workspaceId);
    const repository = saved.snapshot.projects.find((item) => item.workspaceId === input.workspaceId)?.repository;
    if (existing) {
      if (!existing.teamId) throw Error("This project still has a preview connection. Its owner must move it into the Team first.");
      existing.credential = reply.credential; existing.snapshot = reply.snapshot; existing.repository = repository; this.apply(existing); this.state().activeProjectId = existing.projectId;
      await this.persist(); this.publishState(); await this.changed(); return this.status(existing.projectId)!;
    }
    const project: Project = { id: randomUUID(), name: reply.snapshot.name, description: "Shared Team planning. Connect your local repository when you want to run workers.", path: null, branch: repository?.defaultBranch ?? "main", analysis: "idle", createdAt: new Date().toISOString() };
    return this.attach(project.id, saved.endpoint, reply, emptySharedProjection(), project, { teamId: input.teamId, repository });
  }
  repositoryForProject(projectId: string): RepositoryDescriptor | undefined { const value = this.connections.get(projectId)?.repository; return value ? structuredClone(value) : undefined; }
  async shareProject(input: { teamId: string; projectId: string; repository?: RepositoryDescriptor }): Promise<TeamWorkspaceState> {
    const saved = this.savedTeam(input.teamId), project = this.state().projects.find((item) => item.id === input.projectId && !item.example);
    if (!project) throw Error("Choose a local project to share.");
    if(this.unavailable.has(project.id))throw Error("Restore this project’s existing private Team credentials, or explicitly disconnect it before sharing it with another Team.");
    if (this.pendingShares.has(project.id)) throw Error("This project is already being shared.");
    if (this.state().tasks.some((task) => task.projectId === project.id && ["preparing", "running", "stopping"].includes(task.run.state))) throw Error("Stop this project’s active workers before sharing so future workers obtain Team story claims.");
    const previous = this.connections.get(project.id);
    if (previous?.teamId) {
      if (previous.teamId !== input.teamId) throw Error("This project already belongs to another Team.");
      return this.openTeamProject({ teamId: input.teamId, workspaceId: previous.credential.workspaceId });
    }
    if (previous && previous.endpoint !== saved.endpoint) throw Error("A project preview can only move into a Team on the same service. Its current planning has been preserved.");
    this.pendingShares.add(project.id);
    try {
      if (previous) await this.synchronize(project.id);
      const shares = (this.profile.projectShares ??= {}), key = input.teamId + "/" + project.id;
      shares[key] ??= randomUUID(); await this.persist();
      const raw = await this.request<TeamSessionReply & { project: { repository?: RepositoryDescriptor } }>(saved.endpoint, "/v1/teams/projects", saved.credential.capability, { teamId: input.teamId, opId: shares[key], name: project.name, ...(input.repository ? { repository: input.repository } : {}), ...(previous ? { workspaceId: previous.credential.workspaceId, legacyCapability: previous.credential.capability } : {}) });
      const { project: descriptor, ...session } = raw;
      const reply = teamSessionReplySchema.parse(session) as TeamSessionReply;
      if (previous) {
        previous.teamId = input.teamId; previous.credential = reply.credential; previous.snapshot = reply.snapshot; previous.repository = descriptor.repository; previous.status = "online";
        this.apply(previous); await this.persist(); this.publishState(); await this.changed();
      } else {
        const initial = projectSharedState(this.state(), project.id);
        const seed = projectPlanningHistory(this.state(), project.id);
        const connection: Connection = { projectId: project.id, endpoint: saved.endpoint, credential: reply.credential, snapshot: reply.snapshot, baseline: initial, outbox: sharedCommands(emptySharedProjection(), initial).map((command) => ({ opId: randomUUID(), command })), cursor: reply.snapshot.head, readThrough: 0, status: "syncing", leases: new Map(), teamId: input.teamId, repository: descriptor.repository, pendingHistoryImport: {opId:randomUUID(),history:seed}, planningBaseline:planningMetadata(seed) };
        this.connections.set(project.id, connection); await this.persist(); this.publishState(); await this.changed(); await this.flush(connection); this.startLoop(connection);
      }
      saved.snapshot = await this.request(saved.endpoint, `/v1/teams?teamId=${encodeURIComponent(input.teamId)}`, saved.credential.capability); await this.persist();
      return this.status(project.id)!;
    } finally { this.pendingShares.delete(project.id); }
  }
  async revokeTeamMember(input: { teamId: string; memberId: string }): Promise<WorkspaceTeam> {
    const saved = this.savedTeam(input.teamId); saved.snapshot = await this.request(saved.endpoint, "/v1/teams/members/revoke", saved.credential.capability, input); await this.persist(); return this.decoratedTeam(saved);
  }
  async revokeTeamInvitation(input: { teamId: string; invitationId: string }): Promise<WorkspaceTeam> {
    const saved = this.savedTeam(input.teamId); saved.snapshot = await this.request(saved.endpoint, "/v1/teams/invites/revoke", saved.credential.capability, input); await this.persist(); return this.decoratedTeam(saved);
  }
  async suspendAccount(): Promise<void> {
    this.accountEpoch++;
    for (const team of this.profile.teams ?? []) team.locked = true;
    // Persist the lock before account logout/switch can alter identity state.
    await this.persist();
    for (const controller of this.requests) controller.abort();
    for (const connection of this.connections.values()) if (connection.teamId) { connection.status = "offline"; connection.error = "Reconnect this Team with your Memtrace account. Local work and queued changes are preserved."; }
    this.publishState(); await this.changed();
  }
  async reauthenticateTeam(input: {teamId: string}): Promise<WorkspaceTeam> {
    const epoch = this.accountEpoch;
    const saved = this.savedTeam(input.teamId, true);
    const session = await this.request<TeamSpaceSession>(saved.endpoint, "/v1/teams/reconnect", undefined, {teamId:input.teamId,...await this.accountProof(saved.endpoint),...this.device()});
    if (epoch !== this.accountEpoch) throw Error("The Memtrace account changed before reconnecting finished. This Team remains locked.");
    if (session.credential.subject !== saved.credential.subject) throw Error("This local Team binding belongs to another Memtrace account. Sign in with its original account; local work has been preserved.");
    const previous = structuredClone(saved), oldCredentials = new Map<string, TeamCredential>();
    saved.credential = session.credential; saved.snapshot = session.team; saved.locked = false;
    for (const connection of this.connections.values()) if (connection.teamId === input.teamId && connection.endpoint === saved.endpoint) {
      oldCredentials.set(connection.projectId, connection.credential);
      connection.credential = {workspaceId:connection.credential.workspaceId,memberId:session.credential.memberId,deviceId:session.credential.deviceId,capability:session.credential.capability};
    }
    try { await this.persist(); } catch (error) { Object.assign(saved, previous); for (const [id,credential] of oldCredentials) this.connection(id).credential = credential; throw error; }
    this.publishState(); await this.changed(); return this.decoratedTeam(saved);
  }
  async create(input: { projectId: string; endpoint?: string; displayName: string; bootstrapSecret?: string; shareOnLAN?: boolean; advertisedHost?: string }): Promise<TeamWorkspaceState> {
    if (this.connections.has(input.projectId) || this.unavailable.has(input.projectId)) throw Error("This project is already connected to a team. Restore its private profile or disconnect before changing its team.");
    if (this.state().tasks.some((task) => task.projectId === input.projectId && ["preparing", "running", "stopping"].includes(task.run.state))) throw Error("Stop this project’s active workers before sharing it. Restart them after sharing so every worker has a confirmed team claim.");
    const project = this.state().projects.find((project) => project.id === input.projectId && !project.example);
    if (!project) throw Error("Choose a real local project to share.");
    if (this.pendingShares.has(project.id)) throw Error("This project is already being shared.");
    this.pendingShares.add(project.id);
    try {
    let endpoint = input.endpoint ? endpointURL(input.endpoint) : "";
    let bootstrap = input.bootstrapSecret;
    if (!endpoint) {
      if (this.relay && input.shareOnLAN && this.profile.host?.bind !== "0.0.0.0") throw Error("This profile is already hosting a local-only relay. Use a separate LAN relay address to share across computers.");
      const bind = input.shareOnLAN ? "0.0.0.0" : this.profile.host?.bind ?? "127.0.0.1";
      let advertisedUrl = this.profile.host?.advertisedEndpoint;
      if (input.shareOnLAN) {
        const address = input.advertisedHost?.trim() || Object.values(networkInterfaces()).flat().find((item) => item && !item.internal && item.family === "IPv4" && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
        if (!address || !/^[a-zA-Z0-9.-]+$/.test(address)) throw Error("Choose the reachable host name or IPv4 address for this trusted local network.");
        advertisedUrl = `http://${address}:${this.profile.host?.port ?? 0}`;
      }
      this.relay ??= await startTeamRelay({ dataDir: join(this.dataDir, "team", "relay"), ...(this.profile.host ? { port: this.profile.host.port } : {}), host: bind, ...(advertisedUrl ? { advertisedUrl } : {}) });
      endpoint = this.relay.url; bootstrap = this.relay.adminCapability;
      this.profile.host = { port: Number(new URL(this.relay.url).port), bind, advertisedEndpoint: endpoint };
    }
    if (!bootstrap) throw Error("This relay needs its private host bootstrap secret to create a workspace.");
    const reply = teamSessionReplySchema.parse(await this.request(endpoint, "/v1/workspaces", bootstrap, { name: project.name, memberName: input.displayName, deviceId: this.profile.deviceId, deviceName: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Mac" : "Linux" })) as TeamSessionReply;
    const initial = projectSharedState(this.state(), project.id);
    const seed = projectPlanningHistory(this.state(), project.id);
    const connection: Connection = { projectId: project.id, endpoint, credential: reply.credential, snapshot: reply.snapshot, baseline: initial, outbox: sharedCommands(emptySharedProjection(), initial).map((command) => ({ opId: randomUUID(), command })), cursor: reply.snapshot.head, readThrough: 0, status: "syncing", leases: new Map(), pendingHistoryImport: {opId:randomUUID(),history:seed}, planningBaseline:planningMetadata(seed) };
    this.connections.set(project.id, connection);
    await this.persist(); this.publishState(); await this.changed();
    await this.flush(connection); this.startLoop(connection);
    return this.status(project.id)!;
    } finally { this.pendingShares.delete(project.id); }
  }
  async join(input: { projectId?: string; invite: string; displayName: string }): Promise<TeamWorkspaceState> {
    let invite: TeamInvite;
    try { invite = JSON.parse(input.invite) as TeamInvite; } catch { throw Error("Paste the complete Team invitation."); }
    if (!invite || typeof invite.workspaceId !== "string" || typeof invite.invitation !== "string" || typeof invite.endpoint !== "string") throw Error("This Team invitation is incomplete.");
    const endpoint = endpointURL(invite.endpoint);
    const existing = [...this.connections.values()].find((connection) => connection.credential.workspaceId === invite.workspaceId && connection.endpoint === endpoint);
    if (existing) {
      if (input.projectId && input.projectId !== existing.projectId) throw Error("This team is already connected to another local project in this profile. Open that project instead.");
      this.state().activeProjectId = existing.projectId;
      await this.changed();
      return this.status(existing.projectId)!;
    }
    if ([...this.unavailable.values()].some((binding) => binding.workspace.workspaceId === invite.workspaceId)) throw Error("Restore this team’s private profile, or explicitly disconnect its saved binding before joining again.");
    if (input.projectId) {
      if (this.connections.has(input.projectId) || this.unavailable.has(input.projectId)) throw Error("This project is already connected to a team.");
      if (this.state().tasks.some((task) => task.projectId === input.projectId && ["preparing", "running", "stopping"].includes(task.run.state))) throw Error("Stop this project’s active workers before joining a team.");
      if (!this.state().projects.some((project) => project.id === input.projectId && !project.example)) throw Error("Choose a real local project to join.");
      if (this.state().tasks.some((task) => task.projectId === input.projectId && !task.example) || this.state().epics.some((epic) => epic.projectId === input.projectId) || this.state().cycles.some((cycle) => cycle.projectId === input.projectId)) throw Error("This local project has private planning. Join the invitation as a linked project instead.");
    }
    const joinKey = `${endpoint}/${invite.workspaceId}`;
    if (this.pendingJoins.has(joinKey)) throw Error("This workspace invitation is already being opened.");
    this.pendingJoins.add(joinKey);
    try {
    const reply = teamSessionReplySchema.parse(await this.request(endpoint, "/v1/join", undefined, { workspaceId: invite.workspaceId, invitation: invite.invitation, memberName: input.displayName, deviceId: this.profile.deviceId, deviceName: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Mac" : "Linux" })) as TeamSessionReply;
    if (input.projectId) {
      if (this.state().tasks.some((task) => task.projectId === input.projectId && !task.example) || this.state().epics.some((epic) => epic.projectId === input.projectId) || this.state().cycles.some((cycle) => cycle.projectId === input.projectId)) throw Error("This local project changed while joining. Its private planning has been preserved; open the invitation as a linked project.");
      return await this.attach(input.projectId, endpoint, reply, emptySharedProjection());
    }
    const linkedProject: Project = {
      id: randomUUID(), name: reply.snapshot.name, description: "Shared team planning. Connect a local code folder when you want to run workers.",
      path: null, branch: reply.snapshot.epics.find((epic) => epic.branch)?.branch ?? "main", analysis: "idle", createdAt: new Date().toISOString(),
    };
    return await this.attach(linkedProject.id, endpoint, reply, emptySharedProjection(), linkedProject);
    } finally { this.pendingJoins.delete(joinKey); }
  }
  async invite(projectId: string): Promise<TeamInvite> {
    const connection = this.connection(projectId);
    const value = await this.request<Omit<TeamInvite, "endpoint">>(connection.endpoint, "/v1/invites", connection.credential.capability, { workspaceId: connection.credential.workspaceId, role: "editor" });
    return { ...value, endpoint: connection.endpoint };
  }
  async leave(projectId: string): Promise<void> {
    if (this.state().tasks.some((task) => task.projectId === projectId && ["preparing", "running", "stopping"].includes(task.run.state))) throw Error("Stop this project’s workers before leaving the team.");
    if (this.unavailable.delete(projectId)) { this.state().planning.authoritativeProjects = this.state().planning.authoritativeProjects?.filter((id) => id !== projectId); this.publishState(); await this.changed(); return; }
    const connection = this.connection(projectId);
    if (connection.outbox.length || connection.historyOutbox?.length || connection.pendingHistoryImport || connection.sessionOutbox?.length) throw Error("Sync queued team changes, follow-ups and original planning history before leaving so your teammates do not miss them.");
    for (const claim of connection.snapshot.claims.filter((claim) => claim.memberId === connection.credential.memberId && claim.deviceId === connection.credential.deviceId)) await this.release(localTeamId(connection, "story", claim.storyId), projectId);
    if (connection.outbox.length) throw Error("The claim release is queued. Reconnect before leaving so teammates receive it.");
    this.connections.delete(projectId); this.state().planning.authoritativeProjects = this.state().planning.authoritativeProjects?.filter((id) => id !== projectId); this.publishState(); await this.persist(); await this.changed();
  }
  async read(projectId: string): Promise<TeamWorkspaceState> {
    const connection = this.connection(projectId);
    connection.readThrough = connection.cursor;
    connection.outbox.push({ opId: randomUUID(), command: { type: "member.read", through: connection.readThrough } });
    await this.persist(); this.publishState(); await this.changed();
    if (this.options.background !== false) void this.flush(connection).catch(() => {});
    return this.status(projectId)!;
  }
  async acquire(taskId: string, projectId: string): Promise<void> {
    if (this.pendingShares.has(projectId)) throw Error("Wait for this project’s Team connection before starting workers.");
    const connection = this.connections.get(projectId);
    if (!connection) {
      if (this.unavailable.has(projectId)) throw Error("This team project’s private credentials are missing. Restore its profile or explicitly disconnect and rejoin before starting a worker.");
      return;
    }
    if (connection.deletions?.some((backup) => backup.tasks.some((task) => task.id === taskId))) throw Error("Wait for this story’s pending deletion to finish syncing before starting a worker.");
    await this.synchronize(projectId);
    const remoteTaskId = remoteTeamId(connection, "story", taskId);
    const retained = connection.leases.get(taskId);
    if (retained) {
      const previous = connection.sessions?.sessions.find(session => session.id === retained.attemptId);
      const startedAt = this.state().tasks.find(task => task.id === taskId)?.run.startedAt;
      if (previous?.startedAt && startedAt && previous.startedAt !== startedAt)
        throw Error("A previous worker pass still owns this story’s claim. Release its claim in Team before starting another pass.");
      return;
    }
    const attempts = (connection.claimAttempts ??= {});
    let attempt = attempts[taskId];
    if (attempt?.state === "owned") throw Error("A previous worker on this device still owns this story’s claim. Verify that it has stopped, then release the claim in Team before starting again.");
    if (!attempt) {
      attempt = { opId: randomUUID(), attemptId: randomUUID(), state: "requesting" };
      attempts[taskId] = attempt;
      await this.persist();
    }
    const { attemptId, opId } = attempt;
    try {
      const reply = await this.request<TeamCommandReply>(connection.endpoint, "/v1/commands", connection.credential.capability, { workspaceId: connection.credential.workspaceId, opId, command: { type: "claim.acquire", storyId: remoteTaskId, attemptId } });
      const claim = reply.event.changes.find((item) => item.collection === "claims" && item.id === remoteTaskId)?.value as TeamClaim | undefined;
      if (!claim || claim.attemptId !== attemptId) throw Error("The relay did not confirm this worker’s story claim.");
      connection.leases.set(taskId, claim);
      attempt.state = "owned";
      try {
        await this.persist();
      } catch (error) {
        await this.release(taskId, projectId).catch(() => {});
        throw error;
      }
    } catch (error) {
      const details = (error as Error & { code?: string; details?: { claim?: TeamClaim } }).details;
      const claim = details?.claim;
      if (claim) {
        delete attempts[taskId]; await this.persist();
        const owner = connection.snapshot.members.find((member) => member.id === claim.memberId)?.name ?? "A teammate";
        throw Error(`${owner} already owns this story’s worker claim. Release or hand off that claim before starting another worker.`);
      }
      await this.fail(connection, error);
      throw Error(`A team worker requires a confirmed online story claim. ${message(error)}`);
    }
    // A transient board read cannot undo the relay's confirmed, durably saved grant.
    try {
      await this.pull(connection);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403 || status === 404) {
        await this.release(taskId, projectId);
        throw error;
      }
      await this.fail(connection, error);
    }
  }
  async release(taskId: string, projectId: string): Promise<void> {
    const connection = this.connections.get(projectId);
    if (!connection) {
      if (this.unavailable.has(projectId)) throw Error("The Team credentials are missing; this claim cannot be released from this profile.");
      return;
    }
    const remoteTaskId = remoteTeamId(connection, "story", taskId);
    const claim = connection.leases.get(taskId) ?? connection.snapshot.claims.find((claim) => claim.storyId === remoteTaskId && claim.memberId === connection.credential.memberId && claim.deviceId === connection.credential.deviceId);
    if (!claim) return;
    // Save the final model, messages and result before its execution claim ends.
    await this.sessionSync.sync(connection);
    connection.outbox.push({ opId: randomUUID(), command: { type: "claim.release", storyId: remoteTaskId, attemptId: claim.attemptId, epoch: claim.epoch } });
    connection.leases.delete(taskId);
    connection.lastActivity?.delete(taskId);
    if (connection.claimAttempts) delete connection.claimAttempts[taskId];
    await this.persist(); this.publishState();
    // A dropped transport does not release ownership. This durable command is
    // delivered on reconnection; peers continue seeing the last confirmed claim.
    await this.flush(connection).catch(() => {});
  }
  async publish(input: { projectId: string; taskId: string; artifactId: string }): Promise<TeamResult> {
    const connection = this.connection(input.projectId);
    const task = this.state().tasks.find((task) => task.id === input.taskId && task.projectId === input.projectId);
    const artifact = this.state().artifacts.find((artifact) => artifact.id === input.artifactId && artifact.taskId === task?.id);
    if (!task || !artifact) throw Error("Choose a saved output from this team project.");
    const path = await realpath(artifact.path);
    const roots = await canonicalArtifactRoots(this.dataDir, task);
    if (!roots.some((root) => within(root, path))) throw Error("Only this story’s saved outputs can be published.");
    const info = await stat(path);
    if (!info.isFile() || info.size > 5 * 1024 * 1024) throw Error("The Team preview supports individual saved outputs up to 5 MB.");
    const bytes = await readFile(path);
    const mime = mimeTypes[extname(artifact.name).toLowerCase()] ?? "application/octet-stream";
    const upload = await this.request<{ hash: string; size: number; mime: string }>(connection.endpoint, `/v1/blobs?workspaceId=${encodeURIComponent(connection.credential.workspaceId)}`, connection.credential.capability, undefined, 0, bytes, mime);
    const result = { id: randomUUID(), storyId: remoteTeamId(connection, "story", task.id), name: basename(artifact.name), mime: upload.mime, hash: upload.hash, size: upload.size, kind: artifact.purpose === "report" ? "report" as const : "artifact" as const };
    connection.outbox.push({ opId: randomUUID(), command: { type: "result.publish", result } });
    await this.persist(); await this.flush(connection);
    const published = connection.snapshot.results.find((item) => item.id === result.id);
    if (!published) throw Error("The published output has not been confirmed by the relay.");
    return { ...published, storyId: task.id };
  }
  async download(projectId: string, resultId: string): Promise<Artifact> {
    const connection = this.connection(projectId);
    const result = connection.snapshot.results.find((item) => item.id === resultId);
    if (!result) throw Error("Shared output not found. Refresh Team first.");
    const taskId = localTeamId(connection, "story", result.storyId);
    if (!this.state().tasks.some((task) => task.id === taskId && task.projectId === projectId)) throw Error("This output’s story has not synchronized yet.");
    const bytes = await this.request<Uint8Array>(connection.endpoint, `/v1/blobs/${encodeURIComponent(result.hash)}?workspaceId=${encodeURIComponent(connection.credential.workspaceId)}`, connection.credential.capability, undefined, 0, undefined, undefined, true);
    if (bytes.byteLength !== result.size || bytes.byteLength > 5 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== result.hash) throw Error("This shared output failed its integrity check.");
    const safeName = basename(result.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 160) || "shared-output";
    const root = resolve(this.dataDir, "captures");
    const directory = resolve(root, taskId);
    if (!within(root, directory)) throw Error("Invalid shared story location.");
    await mkdir(directory, { recursive: true });
    const resultKey = createHash("sha256").update(result.id).digest("hex").slice(0, 20);
    const path = join(directory, `team-${resultKey}-${safeName}`);
    if (!within(directory, path)) throw Error("Invalid shared output name.");
    await writeFile(path, bytes);
    const artifact: Artifact = { id: `team:${result.id}`, projectId, taskId, name: result.name,
      kind: result.mime.startsWith("image/") ? "image" : /html/.test(result.mime) ? "html" : "text",
      path, createdAt: result.createdAt, source: connection.snapshot.members.find((member) => member.id === result.memberId)?.name ?? "Teammate", purpose: result.kind === "report" ? "report" : "deliverable", revision: result.hash };
    const existing = this.state().artifacts.findIndex((item) => item.id === artifact.id);
    if (existing < 0) this.state().artifacts.push(artifact); else this.state().artifacts[existing] = artifact;
    await this.changed(); return artifact;
  }
  reviewSaved(run: StoryReviewRun) {
    this.sessionSync.reviewSaved(run);
    const item = this.state().tasks.find(t => t.id === run.taskId), connection = item && this.connections.get(item.projectId);
    if (connection && this.options.background !== false) void this.sessionSync.sync(connection);
  }
  remoteSession(taskId: string) {
    const task = this.state().tasks.find(t => t.id === taskId);
    const connection = task && this.connections.get(task.projectId);
    return connection ? this.sessionSync.remote(connection, taskId) : undefined;
  }
  sessionActor(projectId: string) {
    const connection = this.connections.get(projectId);
    if (!connection) return undefined;
    const member = connection.snapshot.members.find(m => m.id === connection.credential.memberId);
    return {memberId: connection.credential.memberId, name: member?.name ?? "Workspace member", deviceId: connection.credential.deviceId,
      device: member?.devices.find(d => d.id === connection.credential.deviceId)?.name ?? "This computer"};
  }
  async sendSessionCommand(taskId: string, kind: SessionCommand["kind"], text: string, reviewRunId?: string) {
    const task = this.state().tasks.find(t => t.id === taskId);
    if (!task) throw Error("Story not found.");
    return this.sessionSync.enqueue(this.connection(task.projectId), taskId, kind, text, reviewRunId);
  }
  async editSessionCommand(taskId: string, id: string, text?: string, cancel = false) {
    const task = this.state().tasks.find(t => t.id === taskId);
    if (!task) throw Error("Story not found.");
    await this.sessionSync.edit(this.connection(task.projectId), id, text, cancel);
  }
  async prepareFollowups(task: WorkItem) {
    const connection = this.connections.get(task.projectId);
    if (connection) await this.sessionSync.pickup(connection, task);
  }
  identity(projectId: string) {
    const connection = this.connections.get(projectId);
    if (!connection) return undefined;
    return { id: connection.credential.memberId, name: connection.snapshot.members.find((member) => member.id === connection.credential.memberId)?.name ?? "You", source: "local" as const };
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const request of this.requests) request.abort();
    await this.sessionSync.close();
    await Promise.allSettled([...this.connections.values()].map((connection) => connection.flushing));
    await this.persist();
    await this.relay?.close();
  }
}
