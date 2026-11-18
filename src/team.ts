/** Portable Team Sync preview data. Credentials and device-local settings stay outside AppState. */
export type TeamRole = "owner" | "editor";
export interface TeamMember {
  id: string;
  name: string;
  role: TeamRole;
  devices: Array<{ id: string; name: string }>;
  joinedAt: string;
}
export interface TeamStory {
  id: string;
  identifier: string;
  title: string;
  description: string;
  stage: "planned" | "working" | "review" | "done";
  priority: "high" | "medium" | "low";
  kind?: "feature" | "fix" | "refactor" | "research" | "test";
  epicId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  estimate?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  labels?: string[];
  scope?: string[];
  dependsOn?: string[];
  assignedMemberId?: string | null;
  revision?: number;
}
export interface TeamEpic {
  id: string;
  identifier: string;
  title: string;
  description: string;
  phase: "now" | "next" | "later";
  color: "mint" | "cyan" | "lavender" | "amber";
  order: number;
  branch?: string;
  baseRevision?: string;
  revision?: number;
}
export interface TeamCycle {
  id: string;
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  state: "upcoming" | "active" | "completed";
  timezone?: string;
  capacity?: number | null;
  calendar?: "weekdays" | "calendar";
  revision?: number;
}
export interface TeamComment {
  id: string;
  storyId: string;
  body: string;
  parentId?: string;
  memberId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  revision?: number;
  reference?: TeamReference;
}
export interface TeamReference {
  kind: "file" | "artifact" | "changes" | "terminal";
  name: string;
  quote: string;
  path?: string;
  resultId?: string;
  revision?: string;
  line?: number;
  endLine?: number;
  page?: number;
  sheet?: string;
  range?: string;
  selector?: string;
}
export const teamWorkerPhases = [
  "preparing", "joining", "starting", "responding", "reading", "editing",
  "testing", "working", "waiting", "finishing", "stopping",
] as const;
export type TeamWorkerPhase = typeof teamWorkerPhases[number];
/** Live, read-only progress attached to the device holding this claim. */
export interface TeamWorkerActivity {
  storyId: string;
  attemptId: string;
  epoch: number;
  phase: TeamWorkerPhase;
  harness?: "claude" | "cursor" | "codex";
  requestedModel?: string;
  actualModel?: string;
  startedAt: string;
  updatedAt: string;
  recent?: Array<{ phase: TeamWorkerPhase; at: string }>;
}
export interface TeamClaim {
  storyId: string;
  attemptId: string;
  epoch: number;
  memberId: string;
  deviceId: string;
  acquiredAt: string;
}
export interface TeamResult {
  id: string;
  storyId: string;
  attemptId?: string;
  name: string;
  mime: string;
  hash: string;
  size: number;
  kind: "report" | "artifact" | "patch";
  description?: string;
  memberId: string;
  deviceId: string;
  createdAt: string;
}
export interface TeamActivity {
  id: string;
  sequence: number;
  memberId: string;
  deviceId: string;
  type: string;
  entityId?: string;
  summary: string;
  at: string;
}
export interface TeamWorkspaceSnapshot {
  workspaceId: string;
  name: string;
  head: number;
  members: TeamMember[];
  stories: TeamStory[];
  epics: TeamEpic[];
  cycles: TeamCycle[];
  comments: TeamComment[];
  claims: TeamClaim[];
  results: TeamResult[];
  activity: TeamActivity[];
  readCursors: Array<{ memberId: string; through: number }>;
}
/** This secret is runtime-private and must never enter shared or renderer AppState. */
export interface TeamCredential {
  workspaceId: string;
  memberId: string;
  deviceId: string;
  capability: string;
}
export interface TeamSessionReply {
  credential: TeamCredential;
  snapshot: TeamWorkspaceSnapshot;
  identity: "invite-preview" | "memtrace";
}
export interface TeamInvitation {
  workspaceId: string;
  invitation: string;
  expiresAt: string;
}
export type TeamSnapshot = TeamWorkspaceSnapshot;
export interface TeamInvite extends TeamInvitation {
  endpoint: string;
}
export type TeamCommand =
  | { type: "story.put"; story: TeamStory; expectedRevision?: number }
  | {
      type: "story.patch";
      storyId: string;
      patch: Partial<Omit<TeamStory, "id" | "revision">>;
      expectedRevision?: number;
    }
  | { type: "story.delete"; storyId: string; expectedRevision?: number }
  | { type: "epic.put"; epic: TeamEpic; expectedRevision?: number }
  | { type: "epic.delete"; epicId: string; expectedRevision?: number }
  | { type: "cycle.put"; cycle: TeamCycle; expectedRevision?: number }
  | { type: "cycle.delete"; cycleId: string; expectedRevision?: number }
  | {
      type: "comment.add";
      commentId: string;
      storyId: string;
      body: string;
      parentId?: string;
      reference?: TeamReference;
    }
  | {
      type: "comment.edit";
      commentId: string;
      body: string;
      expectedRevision?: number;
    }
  | { type: "comment.delete"; commentId: string; expectedRevision?: number }
  | { type: "claim.acquire"; storyId: string; attemptId: string }
  | { type: "claim.release"; storyId: string; attemptId: string; epoch: number }
  | {
      type: "result.publish";
      result: Omit<TeamResult, "memberId" | "deviceId" | "createdAt">;
    }
  | { type: "member.read"; through: number };
export type TeamCollection =
  | "members"
  | "stories"
  | "epics"
  | "cycles"
  | "comments"
  | "claims"
  | "results"
  | "readCursors";
export interface TeamChange {
  collection: TeamCollection;
  id: string;
  value:
    | TeamMember
    | TeamStory
    | TeamEpic
    | TeamCycle
    | TeamComment
    | TeamClaim
    | TeamResult
    | { memberId: string; through: number }
    | null;
}
export interface TeamEvent {
  id: string;
  sequence: number;
  opId: string;
  memberId: string;
  deviceId: string;
  at: string;
  changes: TeamChange[];
  activity?: TeamActivity;
}
export interface TeamSyncReply {
  version: 1;
  snapshot?: TeamWorkspaceSnapshot;
  events: TeamEvent[];
  head: number;
  cursor: number;
  hasMore: boolean;
}
export interface TeamCommandReply {
  event: TeamEvent;
  replayed: boolean;
}
export interface TeamErrorBody {
  error: { code: string; message: string; details?: unknown };
}
