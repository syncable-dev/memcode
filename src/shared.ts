import type {
  Cycle,
  CreateCycle,
  CustomField,
  PlanningHistory,
  SavedView,
  TaskPlanningFields,
  WorkflowState,
} from "./planning/types";
import type { QualitySnapshot } from "./intelligence";
import type { ContextAssistantSettings } from "./context-settings";
import type { CodeReviewAPI } from "./code-review";
import type { BrowserRequest, BrowserReply } from "./browser";
import type { RoutingRequestSignals } from "./routing-signals";
import type { RoutingImpactEvidence, RoutingScopeCoverage } from "./routing-evidence";
export type { ContextAssistantSettings } from "./context-settings";
export type { QualitySnapshot, IntelligenceDetail } from "./intelligence";
export type {
  Cycle,
  CreateCycle,
  CustomField,
  PlanningHistory,
  SavedView,
  TaskPlanningFields,
  WorkflowState,
  ViewConfig,
  ViewMode,
  GroupBy,
  WorkFilters,
} from "./planning/types";
export const stages = ["planned", "working", "review", "done"] as const;
export type Stage = (typeof stages)[number];
export const harnessIds = ["codex", "claude", "cursor", "copilot", "dsh"] as const;
export type Harness = (typeof harnessIds)[number];
export const harnessNames: Record<Harness, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
  dsh: "DeepSeek Harness",
};
export type ModelTier = "fast" | "balanced" | "frontier" | "extreme";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export const codexDefaultModel = "Codex default";
export const cursorDefaultModel = "Cursor default";
export interface ModelOption {
  id: string;
  label: string;
  /** Unranked models remain available for explicit selection. */
  tier?: ModelTier;
  source: "cache" | "cli" | "alias" | "acp";
  efforts?: string[];
  isDefault?: boolean;
  resolvedId?: string;
}
export interface HarnessRuntime {
  id: Harness;
  name: string;
  available: boolean;
  path: string | null;
  /** Provider entry point identity; independent of MemCode's Node launcher. */
  runtimeIdentity?: string;
  /** Desktop application detected even when its agent CLI is not available. */
  desktopAppPath?: string;
  models: ModelOption[];
  /** An authenticated catalog was returned and every visible model was denied. */
  allModelsDenied?: boolean;
  note?: string;
}
export interface RouteDecision {
  policyVersion: "memcode-envelope-v2" | "memcode-evidence-v3" | "memcode-evidence-v4";
  tier: ModelTier;
  harness: Harness;
  model: string;
  /** Account-discovered presentation label; the opaque ID remains the request. */
  modelLabel?: string;
  effort: ReasoningEffort;
  localModel?: true;
  mode: "automatic" | "manual";
  status: "measured" | "provisional";
  reasons: string[];
  plannedAt: string;
  /** Decision evidence stays on the device that planned the route. */
  selection?: {
    method: "explicit" | "envelope" | "fallback" | "calibration";
    catalogFingerprint: string;
    eligibleConfigurations: number;
    effortBound: boolean;
    workTier: ModelTier;
    impactTier: ModelTier | null;
    calibrationDigest?: string;
    /** Concrete provider model to verify before sending a calibrated turn. */
    calibratedModel?: string;
  };
  inputs: {
    cognitive: number | null;
    cyclomatic: number | null;
    nesting: number | null;
    maintainability?: { lowest: number; measuredSymbols: number };
    affected: number | null;
    processes: number | null;
    moduleRoots: number;
    incomplete: boolean;
    sourceRevision?: string;
    graphRevision?: string;
    request?: RoutingRequestSignals;
    scope?: RoutingScopeCoverage;
    impact?: RoutingImpactEvidence;
  };
}
export type Priority = "high" | "medium" | "low";
export type RunState =
  | "idle"
  | "preparing"
  | "running"
  | "stopping"
  | "stopped"
  | "blocked"
  | "failed"
  | "finished";

export interface Message {
  actor?: import("./team-session").SessionActor;
  sourceCommandId?: string;
  deliveryState?: import("./team-session").SessionCommand["state"];
  deliveryError?: string;
  /** Where a message sent to a worker on another computer stands, in words. */
  deliveryLine?: string;
  streamId?: string;
  pickedUpAt?: string;
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  at: string;
  references?: import("./review").ReviewReference[];
  commentIds?: string[];
  reviewText?: string;
  /** Included in a successfully spawned worker brief, not proof it was applied. */
  promptedAt?: string;
  /** Automatic continuation is authorized only by explicit Send. */
  followupState?: "queued" | "paused" | "included" | "cancelled";
  queuedAt?: string;
  queueOrder?: number;
}
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}
export interface Artifact {
  /** Explicit producer intent takes precedence over filename-based grouping. */
  purpose?: "deliverable" | "report" | "evidence";
  revision?: string;
  id: string;
  name: string;
  kind: "html" | "image" | "text";
  path: string;
  taskId: string;
  projectId: string;
  createdAt: string;
  source: string;
}
export interface Evidence {
  state: "unavailable" | "measured" | "partial";
  symbols: Array<{
    name: string;
    file: string;
    line: number;
    nodeId?: string;
    cognitive?: number;
    cyclomatic?: number;
    nesting?: number;
    /** Native AST index for this function, on a verified graph publication. */
    maintainabilityIndex?: number;
    metricSource?: "ast" | "estimated";
  }>;
  affected?: number;
  affectedProcesses?: number;
  affectedFiles?: number;
  impact?: RoutingImpactEvidence;
  scopeCoverage?: RoutingScopeCoverage;
  sourceRevision?: string;
  graphRevision?: string;
  incomplete: boolean;
  note: string;
  measuredAt: string;
}
export interface WorkItem extends TaskPlanningFields {
  /** Read-only projection; never grants this device execution authority. */
  sharedSession?: import("./team-session").TeamSession;
  /** The shared session came from the card's log at the sharing service: nothing can be sent to it. */
  sharedFromLog?: boolean;
  /** Files shared from this card at the sharing service. */
  sharedResults?: import("./sharing").SharedCardResult[];
  /** The worker the card shows from another computer runs under this person's own account. */
  sharedRunIsYours?: boolean;
  /** What the worker on another computer waits for, from the card's log. */
  sharedInputs?: import("./worker-input").WorkerInputRequest[];
  /** Messages from someone else to a worker run here. Nothing runs until they are allowed. */
  sharedAsks?: import("./sharing").SharedAsk[];
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  description: string;
  stage: Stage;
  priority: Priority;
  category: string;
  harness: Harness;
  assignment?: "auto" | "manual";
  modelOverride?: string | null;
  permissionMode?: import("./permissions").PermissionMode | null;
  route?: RouteDecision;
  epicId?: string | null;
  dependsOn?: string[];
  scope?: string[];
  sourceKey?: string;
  kind?: "feature" | "fix" | "refactor" | "research" | "test";
  checklist: ChecklistItem[];
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  run: {
    state: RunState;
    activity?: import("./worker-input").WorkerActivity;
    permissionMode?: import("./permissions").PermissionMode;
    startedAt?: string;
    finishedAt?: string;
    worktree?: string;
    workspace?: string;
    baseline?: string;
    branch?: string;
    /** Local graph binding for this epic checkout; never shared as planning. */
    analysisProjectId?: string;
    analysisRepoId?: string;
    exitCode?: number;
    error?: string;
    sessionId?: string;
    /** Device-local provenance for sessionId, including across failed preparations. */
    sessionBinding?: { harness: Harness; workspace: string; branch?: string; epicId?: string | null };
    changeRunId?: string;
    nativeEditCapture?: boolean;
    measurements?: import("./measurements").WorkerMeasurements;
    checks?: import("./measurements").WorkerCheckResult;
    finishedSourceBinding?: string | null;
    /** The disagreement this worker stopped to wait on. It carries on when the person decides. */
    waitingOnDecision?: string;
  };
  evidence?: Evidence;
  diff?: string;
  changesRevision?: string;
  codeReview?: import("./code-review").CodeReviewSummary;
  example?: boolean;
}
export interface Project {
  /** Ephemeral local query scope, not a shared project identity. */
  analysisCheckout?: "owned-worktree-v1";
  /** Ephemeral epic source view; Git history stays in the primary project graph. */
  analysisCurrentSource?: boolean;
  id: string;
  name: string;
  description: string;
  path: string | null;
  branch: string;
  repoId?: string;
  analysis: "idle" | "connecting" | "indexing" | "ready" | "error";
  analysisNote?: string;
  createdAt: string;
  example?: boolean;
}
export interface Settings {
  automaticUpdateDownloads?: boolean;
  workerPermissionDefaults?: Partial<
    Record<Harness, import("./permissions").PermissionMode>
  >;
  speech?: import("./speech").SpeechSettings;
  contextAssistant?: ContextAssistantSettings;
  handoffAttribution?: import("./handoff").HandoffAttribution;
  memtracePath: string;
  speechEndpoint: string;
  defaultHarness: Harness;
  model: string;
  localModel: boolean;
  maxWorkers: number;
}
export interface Epic {
  branch?: string;
  baseRevision?: string;
  /** The integration branch this work started from and will open its PR into. */
  baseBranch?: string;
  /** Set when the goal's pull request merged; a closed goal takes no new tasks. */
  closedAt?: string;
  /** Another goal merged code this goal uses, or dev moved under a Quick changes batch. */
  updateNeeded?: { reason: string; files: string[]; since: string };
  id: string;
  projectId: string;
  identifier: string;
  title: string;
  description: string;
  phase: "now" | "next" | "later";
  color: "mint" | "cyan" | "lavender" | "amber";
  order: number;
  sourceKey?: string;
}
export interface CreateEpic {
  projectId: string;
  title: string;
  description: string;
  phase: Epic["phase"];
}
/** Public collaboration state. Invitation and member credentials never enter renderer state. */
export interface TeamWorkspaceState {
  sessions?: import("./team-session").TeamSession[];
  sessionCommands?: import("./team-session").SessionCommand[];
  sessionsError?: string;
  projectId: string;
  teamId?: string;
  teamName?: string;
  connection: "online" | "syncing" | "offline" | "connecting";
  workspace: import("./team").TeamSnapshot;
  workerActivity?: import("./team").TeamWorkerActivity[];
  memberId: string;
  deviceId: string;
  pendingCount: number;
  unreadCount: number;
  lastSyncedAt?: string;
  error?: string;
  mode?: "invite-preview" | "memtrace";
  planningHistory?: {
    state: "synced" | "pending" | "unsupported" | "error";
    revision?: number;
    hash?: string;
    importAvailable?: boolean;
    eventCount: number;
    cycleSnapshotCount: number;
    detail?: string;
  };
}
export interface TeamInvite {
  endpoint: string;
  workspaceId: string;
  invitation: string;
  expiresAt: string;
}
export interface AppState {
  /** Which shared project each local project's board belongs to, on this computer. */
  sharedProjectLinks?: import("./sharing").SharedProjectLink[];
  /** How each connected board stands right now. Worked out again on every start. */
  sharedBoards?: import("./sharing").SharedBoardStatus[];
  reviewWorkflows?: Record<
    string,
    import("./code-review").ReviewWorkflowBinding
  >;
  team?: TeamWorkspaceState[];
  workerInputs?: import("./worker-input").WorkerInputRequest[];
  onboarding?: import("./onboarding").OnboardingProgress;
  projectOnboarding?: Record<string, import("./onboarding").OnboardingProgress>;
  onboardingPreferences?: { showForNewProjects?: boolean };
  storyComments?: import("./story-comments").StoryComment[];
  workerConnections?: Partial<
    Record<Harness, import("./connections").WorkerConnection>
  >;
  /** Saved by earlier versions, when workers took turns on shared files. No longer written. */
  fleetPlans?: FleetPlan[];
  /** What each worker is changing right now, and what it changed lately. */
  fleetDeclarations?: import("./fleet").FleetDeclaration[];
  pullRequests?: import("./pull-request").EpicPullRequest[];
  fleetProposals?: FleetProposal[];
  qualitySnapshots: QualitySnapshot[];
  cycles: Cycle[];
  savedViews: SavedView[];
  workflowStates: WorkflowState[];
  customFields: CustomField[];
  planning: PlanningHistory;
  version: 1;
  projects: Project[];
  tasks: WorkItem[];
  epics: Epic[];
  fleetConflicts: FleetConflict[];
  artifacts: Artifact[];
  reviewComments?: import("./review").ReviewComment[];
  activeProjectId: string;
  settings: Settings;
}
export interface FleetPlan {
  taskId: string;
  projectId: string;
  branch: string;
  scope: string[];
  plan: string;
  publishedAt: string;
  inspectedAt?: string;
  active: boolean;
  adoptedFrom?: string;
  adoptedPlan?: string;
}
export interface FleetProposal {
  id: string;
  projectId: string;
  branch: string;
  proposerTaskId: string;
  ownerTaskId: string;
  alternative: string;
  reason: string;
  state: "pending" | "accepted" | "rejected" | "withdrawn";
  createdAt: string;
  respondedAt?: string;
  response?: string;
}
export interface RuntimeInfo {
  appVersion: string;
  harnesses: HarnessRuntime[];
  memtraceAvailable: boolean;
  dataPath: string;
}
export interface CreateTask extends TaskPlanningFields {
  projectId: string;
  title: string;
  description: string;
  priority: Priority;
  harness: Harness;
  assignment?: "auto" | "manual";
  permissionMode?: import("./permissions").PermissionMode | null;
  epicId?: string | null;
  kind?: WorkItem["kind"];
  /** The task's planned steps; without them it starts with the standard runbook. */
  runbook?: string[];
  /** Files the task plans to change. Its edits to them are recorded as its own. */
  scope?: string[];
}
export interface ProjectInput {
  mode: "existing" | "new";
  parent: string;
  name: string;
  description: string;
}
export interface PreviewInput {
  taskId: string;
  url?: string;
  artifactId?: string;
  filePath?: string;
  fileRevision?: string;
  commentId?: string;
  commentFocus?: number;
  line?: number;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface MemCodeAPI extends CodeReviewAPI {
  telemetryStatus(): Promise<import("./telemetry").TelemetryStatus>;
  setTelemetryEnabled(
    enabled: boolean,
  ): Promise<import("./telemetry").TelemetryStatus>;
  flushTelemetry(): Promise<import("./telemetry").TelemetryStatus>;
  openTelemetryPrivacy(): Promise<void>;
  betaStatus(): Promise<import("./beta").MemCodeBetaStatus>;
  connectBeta(): Promise<import("./beta").MemCodeBetaStatus>;
  cancelBeta(): Promise<import("./beta").MemCodeBetaStatus>;
  signOutBeta(): Promise<import("./beta").MemCodeBetaStatus>;
  refreshBeta(): Promise<import("./beta").MemCodeBetaStatus>;
  resumeBeta(): Promise<import("./beta").MemCodeBetaStatus>;
  onBetaStatus(
    listener: (status: import("./beta").MemCodeBetaStatus) => void,
  ): () => void;
  useExistingMemtraceCLI(): Promise<import("./beta").MemCodeBetaStatus>;
  localAnalysisDiagnostics(
    projectId: string,
  ): Promise<import("./local-analysis").LocalAnalysisDiagnostics>;
  /** The signed-in person's shared projects and invitations, or why they cannot be shown. */
  sharingOverview(): Promise<import("./sharing").SharingOverview>;
  acceptSharedInvitation(input: {
    projectId: string;
    invitationId: string;
  }): Promise<import("./sharing").SharingOverview>;
  connectSharedProject(input: {
    projectId: string;
    sharedProjectId: string;
  }): Promise<import("./sharing").SharedProjectLink>;
  disconnectSharedProject(projectId: string): Promise<void>;
  /** A card of a shared project was opened or closed: its activity elsewhere is followed while open. */
  followSharedCard(taskId: string): Promise<void>;
  unfollowSharedCard(taskId: string): Promise<void>;
  /** Allows or declines a message someone else sent to a worker run on this computer. */
  decideSharedMessage(input: {
    taskId: string;
    messageId: string;
    allow: boolean;
  }): Promise<void>;
  /** Shares a file a task saved, or its changes, with everyone on the shared project. */
  shareCardFile(input: {
    taskId: string;
    artifactId: string;
  }): Promise<{ id: string; name: string }>;
  /** Fetches a file shared from a card, to open it like the card's own. */
  openSharedCardFile(input: {
    taskId: string;
    resultId: string;
  }): Promise<Artifact>;
  /** Shares a project: the first time, a shared project of the same name is started for it. */
  shareProject(
    projectId: string,
  ): Promise<import("./sharing").SharedProjectLink>;
  /** Invites someone by email, sharing the project first if it is not shared yet. */
  inviteToProject(input: {
    projectId: string;
    email: string;
  }): Promise<import("./sharing").SharingOverview>;
  cancelProjectInvitation(input: {
    projectId: string;
    invitationId: string;
  }): Promise<import("./sharing").SharingOverview>;
  removeFromProject(input: {
    projectId: string;
    personId: string;
  }): Promise<import("./sharing").SharingOverview>;
  /** A guest leaves a shared project. Its board stays on this computer, no longer shared. */
  leaveProject(projectId: string): Promise<import("./sharing").SharingOverview>;
  /** Opens a shared project on this computer, making a project for its board when there is none. */
  openSharedProject(sharedProjectId: string): Promise<{ projectId: string }>;
  /** Accepts an invitation and opens the shared project on this computer. */
  joinSharedProject(input: {
    sharedProjectId: string;
    invitationId: string;
  }): Promise<{ projectId: string }>;
  teamsList(): Promise<import("./team-space").TeamDirectory>;
  createTeamWorkspace(input: {
    name: string;
  }): Promise<import("./team-space").WorkspaceTeam>;
  shareTeamProject(input: {
    teamId: string;
    projectId: string;
    repository?: import("./repository").RepositoryDescriptor;
  }): Promise<TeamWorkspaceState>;
  openTeamProject(input: {
    teamId: string;
    workspaceId: string;
  }): Promise<TeamWorkspaceState>;
  inviteTeamMember(input: {
    teamId: string;
    projectWorkspaceId?: string;
    email?: string;
  }): Promise<import("./team-space").TeamMemberInvitation>;
  previewTeamInvitation(input: {
    invite: string;
  }): Promise<import("./team-space").TeamInvitationPreview>;
  acceptTeamInvitation(input: {
    invite: string;
  }): Promise<import("./team-space").AcceptedTeamInvitation>;
  revokeTeamMember(input: { teamId: string; memberId: string }): Promise<void>;
  revokeTeamInvitation(input: {
    teamId: string;
    invitationId: string;
  }): Promise<void>;
  reauthenticateTeam(input: {
    teamId: string;
  }): Promise<import("./team-space").WorkspaceTeam>;
  cancelTeamSignIn(): Promise<void>;
  inspectProjectRepository(
    projectId: string,
  ): Promise<import("./repository").RepositoryInspection>;
  findProjectCheckouts(
    repository: import("./repository").RepositoryDescriptor,
  ): Promise<import("./repository").RepositoryInspection[]>;
  repositoryAccess(
    repository: import("./repository").RepositoryDescriptor,
  ): Promise<import("./repository").RepositoryAccess>;
  cloneProjectRepository(input: {
    projectId: string;
    repository: import("./repository").RepositoryDescriptor;
    parent: string;
    name: string;
  }): Promise<Project>;
  cancelRepositorySetup(projectId: string): Promise<void>;
  repositorySetupStatus(
    projectId: string,
  ): Promise<import("./repository").RepositoryProgress | null>;
  githubRepositorySignIn(
    action: "start" | "status" | "cancel",
  ): Promise<import("./repository").RepositoryGitHubSignIn>;
  teamStatus(projectId: string): Promise<TeamWorkspaceState | null>;
  importTeamHistory(projectId: string): Promise<TeamWorkspaceState>;
  teamCreate(input: {
    projectId: string;
    endpoint?: string;
    displayName: string;
    bootstrapSecret?: string;
    shareOnLAN?: boolean;
    advertisedHost?: string;
  }): Promise<TeamWorkspaceState>;
  teamJoin(input: {
    projectId?: string;
    invite: string;
    displayName: string;
  }): Promise<TeamWorkspaceState>;
  bindProjectFolder(projectId: string, path: string): Promise<Project>;
  teamInvite(projectId: string): Promise<TeamInvite>;
  teamLeave(projectId: string): Promise<void>;
  teamRelease(
    projectId: string,
    taskId: string,
  ): Promise<TeamWorkspaceState | null>;
  teamRead(projectId: string): Promise<TeamWorkspaceState>;
  teamPublish(input: {
    projectId: string;
    taskId: string;
    artifactId: string;
  }): Promise<import("./team").TeamResult>;
  teamDownloadResult(projectId: string, resultId: string): Promise<Artifact>;
  deleteStory(
    id: string,
    cascade?: boolean,
  ): Promise<import("./deletion").DeletionResult>;
  deleteEpic(id: string): Promise<import("./deletion").DeletionResult>;
  deleteCycle(id: string): Promise<import("./deletion").DeletionResult>;
  respondToWorker(
    taskId: string,
    requestId: string,
    response: import("./worker-input").WorkerInputResponse,
  ): Promise<void>;
  updateOnboarding(
    patch: import("./onboarding").OnboardingPatch,
  ): Promise<import("./onboarding").OnboardingProgress>;
  updateQueuedFollowup(
    taskId: string,
    messageId: string,
    text: string,
    commentEdits?: Array<{ id: string; text: string }>,
  ): Promise<void>;
  cancelQueuedFollowup(taskId: string, messageId: string): Promise<void>;
  storyCommentIdentity(): Promise<import("./story-comments").StoryAuthor>;
  addStoryComment(
    taskId: string,
    text: string,
    parentId?: string,
  ): Promise<import("./story-comments").StoryComment>;
  editStoryComment(taskId: string, id: string, text: string): Promise<void>;
  deleteStoryComment(taskId: string, id: string): Promise<void>;
  refreshWorkerCatalog(): Promise<RuntimeInfo>;
  installationStatus(): Promise<{
    state: string;
    needsInstall: boolean;
    canUpdate: boolean;
  }>;
  showInstallationSource(): Promise<void>;
  showApplications(): Promise<void>;
  openWorkerSetup(harness: Harness): Promise<void>;
  openWorkerTerminal(): Promise<void>;
  workerConnectionStatus(): Promise<
    import("./connections").WorkerConnectionStatus[]
  >;
  connectWorker(
    harness: Harness,
    approved: true,
  ): Promise<import("./connections").WorkerConnectionStatus>;
  disconnectWorker(harness: Harness): Promise<void>;
  accountStatus(): Promise<import("./connections").MemtraceAccount>;
  signInMemtrace(): Promise<import("./connections").MemtraceAccount>;
  signOutMemtrace(): Promise<import("./connections").MemtraceAccount>;
  switchMemtraceAccount(): Promise<import("./connections").MemtraceAccount>;
  cancelMemtraceSignIn(): Promise<import("./connections").MemtraceAccount>;
  speechStatus(): Promise<import("./speech").SpeechStatus>;
  prepareSpeech(): Promise<import("./speech").SpeechStatus>;
  installSpeech(): Promise<import("./speech").SpeechStatus>;
  stopSpeech(): Promise<void>;
  retrievalStatus(): Promise<
    import("./context-settings").ContextAssistantSetupState
  >;
  installRetrieval(): Promise<
    import("./context-settings").ContextAssistantSetupState
  >;
  configureRetrieval(
    settings: ContextAssistantSettings,
  ): Promise<ContextAssistantSettings>;
  sendFollowup(
    taskId: string,
    text: string,
    commentIds?: string[],
  ): Promise<{ messageId: string }>;
  saveReviewComment(input: {
    id?: string;
    taskId: string;
    reference: import("./review").ReviewReference;
    text: string;
  }): Promise<import("./review").ReviewComment>;
  deleteReviewComment(taskId: string, id: string): Promise<void>;
  shareReviewComments(
    taskId: string,
    ids: string[],
    text: string,
  ): Promise<string>;
  resolveFile(
    taskId: string,
    href: string,
    basePath?: string,
  ): Promise<import("./file-reference").FileReference>;
  onReview(
    listener: (event: import("./review").ReviewEvent) => void,
  ): () => void;
  workerChanges(taskId: string): Promise<import("./changes").WorkerChanges>;
  terminal(
    taskId: string,
    request: import("./terminal").TerminalRequest,
  ): Promise<import("./terminal").TerminalReply>;
  onTerminal(
    listener: (event: import("./terminal").TerminalOutput) => void,
  ): () => void;
  refreshIntelligence(
    projectId: string,
    refreshIndex?: boolean,
  ): Promise<QualitySnapshot>;
  queryIntelligence(
    projectId: string,
    section: string,
    input?: Record<string, unknown>,
  ): Promise<unknown>;
  createCycle(input: CreateCycle): Promise<Cycle>;
  updateCycle(
    id: string,
    patch: Partial<Omit<CreateCycle, "projectId">>,
  ): Promise<void>;
  startCycle(id: string): Promise<void>;
  completeCycle(
    id: string,
    targetCycleId?: string | null,
  ): Promise<{ moved: number }>;
  saveView(input: Omit<SavedView, "id"> & { id?: string }): Promise<SavedView>;
  deleteView(id: string): Promise<void>;
  saveWorkflow(projectId: string, states: WorkflowState[]): Promise<void>;
  saveCustomFields(projectId: string, fields: CustomField[]): Promise<void>;
  bulkUpdateTasks(ids: string[], patch: TaskPatch): Promise<void>;
  refreshFleet(projectId: string): Promise<void>;
  resolveFleetConflict(
    id: string,
    resolution: string,
    winnerTaskId?: string,
  ): Promise<void>;
  load(): Promise<{ state: AppState; runtime: RuntimeInfo }>;
  onState(listener: (state: AppState) => void): () => void;
  selectFolder(): Promise<string | null>;
  createProject(input: ProjectInput): Promise<Project>;
  selectProject(id: string): Promise<void>;
  analyzeProject(id: string): Promise<void>;
  createTask(input: CreateTask): Promise<WorkItem>;
  createEpic(input: CreateEpic): Promise<Epic>;
  updateEpic(
    id: string,
    patch: Partial<Pick<Epic, "title" | "description" | "phase">>,
  ): Promise<void>;
  updateTask(id: string, patch: TaskPatch): Promise<void>;
  addMessage(
    id: string,
    text: string,
    references?: import("./review").ReviewReference[],
  ): Promise<void>;
  qualifyTask(id: string): Promise<void>;
  startWorker(id: string): Promise<void>;
  stopWorker(id: string): Promise<void>;
  saveSettings(settings: Settings): Promise<RuntimeInfo>;
  pullRequestPlan(
    epicId: string,
  ): Promise<import("./pull-request").PullRequestPlan>;
  createPullRequest(
    input: import("./pull-request").CreatePullRequest,
  ): Promise<import("./pull-request").PullRequestResult>;
  openPullRequest(epicId: string): Promise<void>;
  mergePullRequest(
    epicId: string,
  ): Promise<import("./pull-request").MergeResult>;
  placeWork(
    projectId: string,
    request: string,
  ): Promise<import("./goal-plan").Placement>;
  planGoal(input: {
    projectId: string;
    request: string;
    harness: Harness;
  }): Promise<import("./goal-plan").WorkPlan>;
  updateGoalFromBase(epicId: string): Promise<{
    merged: boolean;
    savedWork: boolean;
    conflicts?: string[];
  }>;
  setHandoffAttribution(
    attribution: import("./handoff").HandoffAttribution,
  ): Promise<void>;
  setWorkerPermissionDefault(
    harness: Harness,
    mode: import("./permissions").PermissionMode,
  ): Promise<void>;
  showPreview(input: PreviewInput): Promise<void>;
  browser(taskId: string, request: BrowserRequest): Promise<BrowserReply>;
  hidePreview(): Promise<void>;
  previewAction(
    action: "back" | "forward" | "reload" | "capture" | "clear-selection",
  ): Promise<void>;
  onPreview(
    listener: (event: { url: string; title: string; error?: string }) => void,
  ): () => void;
  readArtifact(id: string): Promise<string>;
  readArtifactThumbnail(
    id: string,
  ): Promise<import("./artifact-thumbnail").ArtifactThumbnail>;
  openWorkerWorkspace(id: string): Promise<void>;
  transcribe(wav: ArrayBuffer): Promise<string>;
  windowAction(action: "minimize" | "maximize" | "close"): Promise<void>;
}
export type TaskPatch = Partial<
  Pick<
    WorkItem,
    | "title"
    | "description"
    | "stage"
    | "priority"
    | "harness"
    | "checklist"
    | "assignment"
    | "modelOverride"
    | "permissionMode"
    | "epicId"
    | "dependsOn"
    | "scope"
    | "kind"
  > &
    TaskPlanningFields
>;

export interface FleetConflict {
  /** Who settled it: the person, the workers agreeing, or an earlier version's bookkeeping. */
  resolutionKind?: "human" | "coordination" | "agents";
  /** What each task involved wants. */
  positions?: import("./fleet").FleetPosition[];
  /** Set once the person is needed: to confirm the workers' recommendation, or to decide. */
  needs?: "confirm" | "decide";
  /** Why the workers could not settle it themselves. */
  needsReason?: string;
  /** The task the workers recommend should go ahead. */
  recommendedTaskId?: string;
  id: string;
  projectId: string;
  epicId?: string;
  branch: string;
  taskIds: string[];
  agentIds: string[];
  scope: string[];
  severity: "B" | "C" | "unknown";
  source: "preflight" | "publish" | "episode" | "remote" | "runtime";
  summary: string;
  status: "open" | "resolved";
  createdAt: string;
  escalationId?: string;
  resolution?: string;
  winnerTaskId?: string;
  resolvedAt?: string;
}

declare global {
  interface Window {
    memcode: MemCodeAPI;
  }
}
