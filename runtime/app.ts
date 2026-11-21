import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import {
  basename,
  join,
  resolve,
  isAbsolute,
  extname,
  relative as relativePath,
} from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { newRunbook } from "../src/runbook";
import { repoRelativePath } from "./context/source";
import type { AppState, Project, WorkItem } from "../src/shared";
import { maxWorkerSlots } from "../src/worker-slots";
import { isActive } from "../src/domain";
import { LocalStore, exists, findCommand, git, now, within } from "./local";
import { observePersistence } from "./persistence";
import { MemtraceEngine } from "./memtrace";
import { ensureProjectRepository } from "./project-repository";
import { workerResponseSchema } from "./worker-input";
import { permissionModes, supportsPermissionMode } from "../src/permissions";
import { registerDeletion } from "./deletion";
import { readArtifactThumbnail } from "./artifact-thumbnail";
import { reconcileArtifacts } from "./artifact-catalog";
import { WorkerManager } from "./workers";
import { PreviewManager } from "./preview";
import { localURL } from "./urls";
import { discoverHarnesses } from "./catalog";
import { planDefinedStory, readRoutingCalibration, readRoutingLanguage } from "./story-route";
import { qualificationRequestFingerprint } from "./qualification";
import { registerPlanning } from "./planning";
import { registerPlanningControls } from "./planning-controls";
import { ensureTaskEpic } from "./epic-workspace";
import { createExampleArtifacts } from "./examples";
import { taskPlanningShape, applyTaskPatch } from "./task-planning";
import { registerIntelligence, ensureProjectWatch } from "./intelligence";
import type { NativeHost, Emit } from "./host";
import { contextAssistantDefaults } from "../src/context-settings";
import { browserRequestSchema } from "../src/browser";
import { AgentBrowserManager } from "./browser/manager";
import { TerminalManager } from "./terminals";
import { terminalRequestSchema } from "../src/terminal";
import { readDisplayedWorkerChanges, WorkerChangeJournal } from "./changes";
import { canonicalArtifactRoots, resolveFile } from "./files";
import { registerReview } from "./review";
import { registerOnboarding } from "./onboarding";
import { activateProjectGuide, beginProjectGuide } from "../src/onboarding";
import { registerCardComments } from "./card-comments";
import { handoffAttributionSchema, registerHandoff } from "./handoff";
import {
  createPullRequestService,
  registerPullRequests,
} from "./pull-request";
import { GoalUpdates, registerGoalUpdates } from "./goal-updates";
import { GoalPlacement, registerGoalPlacement } from "./goal-placement";
import { GoalPlanner, registerGoalPlanner } from "./goal-planner";
import { readWorkerChanges as readGoalChanges } from "./changes";
import { registerConnections } from "./worker-connections";
import { TeamSyncClient } from "./team/client";
import { registerRepositoryRoutes } from "./repository-routes";
import { registerLocalAnalysis } from "./local-analysis";
import { AppUpdateGate, registerAppUpdates } from "./app-updates";
import { createMemtraceIdentityProofProvider } from "./team-identity";
import { discoverOfficialTeamService } from "./team/discovery";
import { createBetaAuthorization } from "./beta-auth";
import { MemCodeBeta, nativeBetaStorage } from "./beta";
import { Sharing } from "./sharing/sharing";
import {
  registerSharing,
  sharingSettingsSchema,
  sharingSettingsToKeep,
} from "./sharing/routes";
import { ManagedMemcodeEngine } from "./managed-engine";
import { ManagedRetrievalAssistant } from "./context/managed-assistant";
import { ProductTelemetry, observeTelemetryMutation } from "./telemetry";
import { runTaskVerification } from "./verification";
import { CodeReviewManager } from "./code-review";
import { codeReviewDismissalReasons } from "../src/code-review";
import {
  prepareReviewAnalysis,
  repairReviewPublication,
} from "./review-analysis-prepare";
import {
  initializeCodeReviewWorkflow,
  isCodeReviewTask,
} from "../src/code-review-workflow";
import { epicAnalysisProject } from "./epic-checkout";
import { createReadonlyReviewAgent } from "./review-agent";
import { SpeechManager, registerSpeech } from "./speech";
import { speechSettingsSchema } from "../src/speech";
import {
  formatReviewMessage,
  reviewReferenceSchema,
  type ReviewReference,
} from "../src/review";

const identifier = z.string().min(1).max(200),
  nonempty = z.string().trim().min(1),
  stage = z.enum(["planned", "working", "review", "done"]),
  harness = z.enum(["codex", "claude", "cursor", "copilot", "dsh"]),
  kind = z.enum(["feature", "fix", "refactor", "research", "test"]),
  priority = z.enum(["high", "medium", "low"]);
const taskPatch = z
  .object({
    title: nonempty.max(160).optional(),
    description: z.string().max(20000).optional(),
    stage: stage.optional(),
    priority: priority.optional(),
    harness: harness.optional(),
    assignment: z.enum(["auto", "manual"]).optional(),
    modelOverride: z.string().max(200).nullable().optional(),
    permissionMode: z.enum(permissionModes).nullable().optional(),
    epicId: identifier.nullable().optional(),
    dependsOn: z.array(identifier).max(100).optional(),
    scope: z.array(z.string().max(1000)).max(20).optional(),
    kind: kind.optional(),
    checklist: z
      .array(
        z.object({
          id: identifier,
          text: nonempty.max(1000),
          done: z.boolean(),
        }),
      )
      .max(100)
      .optional(),
    ...taskPlanningShape,
  })
  .strict();
type Handler = { schema: z.ZodType; handle: (input: any) => unknown };
const acpPermissionMode = z.enum(["review", "full-access"]).optional();
const workerPermissionDefaults = z
  .object({
    codex: z.enum(permissionModes).optional(),
    claude: z.enum(permissionModes).optional(),
    cursor: acpPermissionMode,
    copilot: acpPermissionMode,
    dsh: acpPermissionMode,
  })
  .strict();

export async function createRuntime(
  dataDir: string,
  appPath: string,
  host: NativeHost,
  emit: Emit,
  options?: { discoverHarnesses?: typeof discoverHarnesses },
) {
  const discover = options?.discoverHarnesses ?? discoverHarnesses;
  const store = new LocalStore(dataDir);
  await store.load();
  const state = () => store.state;
  let beta: MemCodeBeta | undefined;
  let betaNeedsAnalysis = false;
  let betaReady = false;
  let requireFreshWorkerContext = false;
  const qaProfile =
    process.env.MEMCODE_NATIVE_TEST_PROFILE === "1" ||
    !!process.env.NODE_TEST_CONTEXT;
  const telemetryTestChannel =
    qaProfile && process.env.MEMCODE_TELEMETRY_TEST_CHANNEL === "1";
  const telemetry = new ProductTelemetry(store.dir, state, {
    authorization: () =>
      beta?.telemetryAuthorization() ?? Promise.resolve(null),
    eligible: () => beta?.snapshot().state === "connected",
    clearAuthorization: () => beta?.clearTelemetryAuthorization(),
    channel: telemetryTestChannel ? "test" : "production",
    excluded: qaProfile && !telemetryTestChannel,
  });
  await telemetry.initialize();
  const managedEngine = new ManagedMemcodeEngine(store.dir, {
    bundledDirectory: join(appPath, "memtrace-engine"),
    progress: (note) => beta?.reportEngineProgress(note),
  });
  const engine = new MemtraceEngine(
    () =>
      beta?.usesBeta()
        ? managedEngine.executable()
        : store.state.settings.memtracePath,
    {
      environment: async () => {
        const environment = await (beta?.environment() ?? Promise.resolve({}));
        return beta?.usesBeta()
          ? { ...managedEngine.executionEnvironment(), ...environment }
          : environment;
      },
      privateProject: () => beta?.usesBeta() === true,
      managedGraphRoot: join(store.dir, "memtrace-projects"),
    },
  );
  const appUpdateGate = new AppUpdateGate(state);
  let dispatchQueued = () => {};
  let closed = false;
  let team: TeamSyncClient | undefined;
  let persistenceFailed = false;
  const changed = () => {
    const pending = (async () => {
      await team?.capture();
      await store.save();
      emit("workspace:state", store.state);
      dispatchQueued();
      if (persistenceFailed) {
        persistenceFailed = false;
        emit("workspace:save-status", { state: "saved" });
      }
    })();
    return observePersistence(pending, (error) => {
      persistenceFailed = true;
      console.error(
        "Workspace save failed; the runtime is still running:",
        error,
      );
      emit("workspace:save-status", {
        state: "error",
        message:
          "Changes could not be saved. The last saved workspace is preserved; free disk space or release the file lock, then retry the action.",
      });
    });
  };
  let reconcilingArtifacts: Promise<void> | undefined;
  let artifactsCheckedAt = 0;
  const reconcileCatalog = () => {
    if (reconcilingArtifacts) return reconcilingArtifacts;
    if (Date.now() - artifactsCheckedAt < 5000) return Promise.resolve();
    reconcilingArtifacts = (async () => {
      const removed = await reconcileArtifacts(store.state, store.dir);
      artifactsCheckedAt = Date.now();
      if (removed.length) await changed();
    })().finally(() => {
      reconcilingArtifacts = undefined;
    });
    return reconcilingArtifacts;
  };
  const browsers = new AgentBrowserManager(state, store.dir, changed, 16, host);
  const terminals = new TerminalManager(state, host);
  const retrieval = new ManagedRetrievalAssistant(store.dir, {
    runtimeDirectory: join(appPath, "retriever-runtime"),
  });
  let codeReviews: CodeReviewManager;
  const workers = new WorkerManager(
      state,
      changed,
      engine,
      store.dir,
      undefined,
      undefined,
      browsers,
      terminals,
      undefined,
      {
        prepareFollowups: (item) => team?.prepareFollowups(item) ?? Promise.resolve(),
        acquire: (taskId, projectId) =>
          team?.acquire(taskId, projectId) ?? Promise.resolve(),
        release: (taskId, projectId) =>
          team?.release(taskId, projectId) ?? Promise.resolve(),
      },
      () => {
        appUpdateGate.assertMayStart();
        beta?.assertMayStart();
        if (!beta?.usesBeta()) connections.account.assertMayStart();
      },
      (project) =>
        betaReady &&
        !appUpdateGate.preparing &&
        !beta?.isChanging() &&
        (!project ||
          !requireFreshWorkerContext ||
          (project.analysis === "ready" && !!project.repoId)),
      telemetry,
      () => retrieval.assistant(),
      async (item) => {
        if (item.messages.some((message) => message.followupState === "queued"))
          return;
        const binding = state().reviewWorkflows?.[item.projectId];
        if (!binding) return;
        item.stage = "review";
        item.statusId = binding.codeReviewStatusId;
        await changed();
        await codeReviews.start(item.id);
      },
      async (item) => {
        await codeReviews.beforeWorker(item.id);
      },
      (item) => codeReviews?.occupiedSlots(item) ?? 0,
      (id) => analyze(id),
    ),
    preview = new PreviewManager(
      host,
      state,
      store.dir,
      changed,
      emit,
      appPath,
    );
  dispatchQueued = () => workers.dispatchQueued();
  const selectedFolders = new Set<string>(),
    handlers = new Map<string, Handler>();
  const task = (id: string) => {
    const item = store.state.tasks.find((task) => task.id === id);
    if (!item) throw new Error("Task not found.");
    return item;
  };
  const project = (id: string) => {
    const item = store.state.projects.find((project) => project.id === id);
    if (!item) throw new Error("Project not found.");
    return item;
  };
  const register = (
    name: string,
    schema: z.ZodType,
    handle: (input: any) => unknown,
  ) => {
    handlers.set(name, {
      schema,
      handle: (input) =>
        observeTelemetryMutation(telemetry, name, input, handle),
    });
  };
  const teamIdentity = createMemtraceIdentityProofProvider({
    openExternal: (url) => host.call("open_memcode_identity", { url }),
  });
  team = new TeamSyncClient(state, store.dir, changed, {
    loadReview: (taskId) => codeReviews?.get(taskId) ?? Promise.resolve(null),
    onSessionCommand: async (item, command) => {
      if (command.kind === "followup") {
        let message = item.messages.find(m => m.id === command.id);
        if (message?.promptedAt || message?.pickedUpAt) return;
        if (!message) {
          message = {id: command.id, role: "user", text: command.text, at: command.createdAt,
            actor: command.author, sourceCommandId: command.id};
          item.messages.push(message);
          workers.enqueue(item, message.id);
        } else { message.text = command.text; message.actor = command.author; }
        item.updatedAt = command.updatedAt;
        await changed();
      } else if (command.kind === "review-start") {
        if (!isCodeReviewTask(state(), item)) throw Error("Move this task to Code review before starting its review.");
        await codeReviews.start(item.id);
      } else {
        await codeReviews.discuss(item.id, command.reviewRunId!, command.text, {id: command.id, actor: command.author});
      }
    },
    onWorkerActivity: () => emit("workspace:state", store.state),
    identityProof: teamIdentity,
    identityAvailable: teamIdentity.available,
    serviceDiscovery: () => discoverOfficialTeamService(),
  });
  const teamProject = z.object({ projectId: identifier }).strict();
  register("team:list", z.undefined(), () => team!.teamsList());
  register(
    "team:create-workspace",
    z.object({ name: nonempty.max(80) }).strict(),
    (input) => team!.createTeamWorkspace(input),
  );
  register(
    "team:share-project",
    z
      .object({
        teamId: identifier,
        projectId: identifier,
        repository: z
          .object({
            url: nonempty.max(3000),
            identity: nonempty.max(3000),
            provider: z.enum(["github", "gitlab", "bitbucket", "git"]),
            name: nonempty.max(500),
            defaultBranch: nonempty.max(250).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    (input) => team!.shareProject(input),
  );
  register(
    "team:open-project",
    z.object({ teamId: identifier, workspaceId: identifier }).strict(),
    (input) => team!.openTeamProject(input),
  );
  register(
    "team:invite-member",
    z
      .object({
        teamId: identifier,
        projectWorkspaceId: identifier.optional(),
        email: z.string().email().max(320).optional(),
      })
      .strict(),
    (input) => team!.inviteTeamMember(input),
  );
  register(
    "team:preview-invite",
    z.object({ invite: nonempty.max(10000) }).strict(),
    (input) => team!.previewTeamInvitation(input),
  );
  register(
    "team:accept-invite",
    z.object({ invite: nonempty.max(10000) }).strict(),
    (input) => team!.acceptTeamInvitation(input),
  );
  register(
    "team:revoke-member",
    z.object({ teamId: identifier, memberId: identifier }).strict(),
    async (input) => {
      await team!.revokeTeamMember(input);
    },
  );
  register(
    "team:revoke-invite",
    z.object({ teamId: identifier, invitationId: identifier }).strict(),
    async (input) => {
      await team!.revokeTeamInvitation(input);
    },
  );
  register(
    "team:reconnect",
    z.object({ teamId: identifier }).strict(),
    (input) => team!.reauthenticateTeam(input),
  );
  register("team:cancel-sign-in", z.undefined(), () => teamIdentity.cancel());
  register("team:status", teamProject, async ({ projectId }) => {
    project(projectId);
    if (team!.status(projectId))
      await team!.synchronize(projectId).catch(() => {});
    return team!.status(projectId);
  });
  register("team:import-history", teamProject, ({ projectId }) => {
    project(projectId);
    return team!.importPlanningHistory(projectId);
  });
  register(
    "team:create",
    z
      .object({
        projectId: identifier,
        endpoint: z.string().max(2000).optional(),
        displayName: nonempty.max(100),
        bootstrapSecret: z.string().max(1000).optional(),
        shareOnLAN: z.boolean().optional(),
        advertisedHost: z.string().max(250).optional(),
      })
      .strict(),
    (input) => team!.create(input),
  );
  register(
    "team:join",
    z
      .object({
        projectId: identifier.optional(),
        invite: nonempty.max(10000),
        displayName: nonempty.max(100),
      })
      .strict(),
    (input) => team!.join(input),
  );
  register("team:invite", teamProject, ({ projectId }) =>
    team!.invite(projectId),
  );
  register("team:leave", teamProject, ({ projectId }) =>
    team!.leave(projectId),
  );
  register("team:read", teamProject, ({ projectId }) => team!.read(projectId));
  register(
    "team:publish",
    z
      .object({
        projectId: identifier,
        taskId: identifier,
        artifactId: identifier,
      })
      .strict(),
    (input) => team!.publish(input),
  );
  register(
    "team:download",
    z.object({ projectId: identifier, resultId: identifier }).strict(),
    ({ projectId, resultId }) => team!.download(projectId, resultId),
  );
  register(
    "team:claim",
    z.object({ projectId: identifier, taskId: identifier }).strict(),
    async ({ projectId, taskId }) => {
      if (task(taskId).projectId !== projectId)
        throw Error("Choose a task in this project.");
      await team!.acquire(taskId, projectId);
      return team!.status(projectId);
    },
  );
  register(
    "team:release",
    z.object({ projectId: identifier, taskId: identifier }).strict(),
    async ({ projectId, taskId }) => {
      if (task(taskId).projectId !== projectId)
        throw Error("Choose a task in this project.");
      if (isActive(task(taskId)))
        throw Error("Stop this worker before releasing its team claim.");
      await team!.release(taskId, projectId);
      return team!.status(projectId);
    },
  );
  const connections = registerConnections(
    register,
    state,
    changed,
    () => store.state.settings.memtracePath,
    host,
    undefined,
    {
      stateFile: join(store.dir, "account-session.json"),
      beforeChange: async () => {
        teamIdentity.cancel();
        await team!.suspendAccount();
      },
    },
  );
  const speech = new SpeechManager(
    () => store.state.settings,
    store.dir,
    async (value) => {
      store.state.settings.speech = value;
      await changed();
    },
  );
  const analyses = new Map<string, Promise<void>>();
  let analysisAccount = new AbortController();
  const runAnalysis = async (id: string, signal: AbortSignal) => {
    const item = project(id);
    if (item.example || !item.path)
      throw new Error("Choose a local project folder first.");
    await beta?.initialize();
    const missingEngine =
      !beta?.usesBeta() &&
      !(await findCommand("memtrace", store.state.settings.memtracePath));
    signal.throwIfAborted();
    if (missingEngine) {
      item.analysis = "idle";
      item.analysisNote =
        "Connect Memtrace beta from your account or project setup to prepare the local engine. You can keep planning while it connects.";
      await changed();
      return;
    }
    const previousFailure =
      item.analysis === "error" ? item.analysisNote : undefined;
    item.analysis = "connecting";
    item.analysisNote = "Connecting to local Memtrace…";
    await changed();
    try {
      signal.throwIfAborted();
      await ensureProjectRepository(item, signal);
      signal.throwIfAborted();
      const repoId = await engine.analyze(
        item,
        (note) => {
          if (signal.aborted) return;
          item.analysis = "indexing";
          item.analysisNote = note;
          void changed();
        },
        false,
        previousFailure,
        signal,
      );
      signal.throwIfAborted();
      item.repoId = repoId;
      item.analysis = "ready";
      item.analysisNote = "Project code context is connected.";
      await changed();
    } catch (error) {
      signal.throwIfAborted();
      item.analysis = "error";
      item.analysisNote = (error as Error).message;
      await changed();
      throw error;
    }
  };
  const analyze = (id: string): Promise<void> => {
    if (beta?.isChanging())
      return Promise.reject(
        new Error("Finish or cancel beta sign-in before refreshing code analysis."),
      );
    const existing = analyses.get(id);
    if (existing) return existing;
    const pending = runAnalysis(id, analysisAccount.signal).finally(() => {
      if (analyses.get(id) === pending) analyses.delete(id);
    });
    analyses.set(id, pending);
    return pending;
  };
  const resumedWatches = new Map<string, Promise<void>>();
  const resumeProjectWatch = (id: string): Promise<void> => {
    const item = store.state.projects.find((candidate) => candidate.id === id);
    if (
      closed ||
      !item ||
      item.example ||
      !item.path ||
      !item.repoId ||
      item.analysis !== "ready"
    )
      return Promise.resolve();
    const pending = resumedWatches.get(id);
    if (pending) return pending;
    const signal = analysisAccount.signal;
    const path = item.path,
      repoId = item.repoId;
    const reconnect = (async () => {
      const branch = await git(path, ["branch", "--show-current"]).catch(
        () => "",
      );
      await beta?.initialize();
      const stillCurrent = () =>
        !closed &&
        !signal.aborted &&
        item.path === path &&
        item.repoId === repoId &&
        item.analysis === "ready";
      if (!stillCurrent()) return;
      if (branch) item.branch = branch;
      // An older installation can report Ready from its checkout-local graph.
      // Validate the profile's graph on the first connection and build it if
      // needed. The saved board and the old graph do not need a migration.
      if (beta?.usesBeta() && !engine.scopeFor(id)) {
        await beta.environment();
        if (stillCurrent()) await analyze(id);
        return;
      }
      const watch = await ensureProjectWatch(engine, item);
      if (!stillCurrent()) return;
      item.analysisNote =
        watch.state === "watching"
          ? "Code context connected. Local changes are watched."
          : `Code context saved; live watch needs attention. ${watch.reason ?? "Refresh analysis to reconnect."}`;
      await changed();
    })()
      .catch((error) => {
        console.error(
          "Local code watch could not reconnect:",
          error instanceof Error ? error.message : "Unknown error",
        );
      })
      .finally(() => resumedWatches.delete(id));
    resumedWatches.set(id, reconnect);
    return reconnect;
  };
  const repositories = registerRepositoryRoutes(
    register,
    state,
    project,
    selectedFolders,
    changed,
    analyze,
    (id) => team?.repositoryForProject(id),
    () => host.call("open_github_device", {}),
  );
  beta = new MemCodeBeta({
    telemetryOptIn: () => telemetry.requested(),
    storage: nativeBetaStorage(host),
    authorization: createBetaAuthorization({
      telemetryOptIn: () => telemetry.requested(),
      openExternal: (url) => host.call("open_memcode_beta", { url }),
    }),
    assertMayChange: () => {
      if (closed || appUpdateGate.preparing)
        throw Error("Finish the app update before changing beta access.");
      if (store.state.tasks.some((item) => !item.example && isActive(item)))
        throw Error(
          "Finish or stop running workers before changing the beta account.",
        );
    },
    beforeIdentityChange: async () => {
      analysisAccount.abort(
        new Error("Memtrace access changed during code analysis."),
      );
      analysisAccount = new AbortController();
      analyses.clear();
      await telemetry.accountChanged();
      requireFreshWorkerContext = true;
      teamIdentity.cancel();
      await team?.suspendAccount();
      // Drain owned engine clients before binding the new account. Retired
      // requests cannot publish even if an external analysis outlives its client.
      await engine.reconnect();
      for (const item of store.state.projects)
        if (!item.example && item.path) {
          item.analysis = "idle";
          item.repoId = undefined;
          item.analysisNote =
            "The engine account changed. Refresh local code context.";
        }
      betaNeedsAnalysis = true;
      await changed();
    },
    afterConnected: async () => {
      await managedEngine.prepare();
    },
    beforeEngineUse: async () => {
      await managedEngine.prepare();
    },
    changed: (status) => {
      emit("beta:status", status);
      if (!status.loginPending && !closed) {
        if (
          betaNeedsAnalysis &&
          (!beta?.usesBeta() || status.state === "connected")
        ) {
          betaNeedsAnalysis = false;
          const pendingProjects = new Set([
            store.state.activeProjectId,
            ...store.state.tasks
              .filter((item) =>
                item.messages.some(
                  (message) => message.followupState === "queued",
                ),
              )
              .map((item) => item.projectId),
          ]);
          void (async () => {
            for (const id of pendingProjects) {
              const item = store.state.projects.find(
                (project) => project.id === id,
              );
              if (item?.path && !item.example)
                await analyze(id).catch(() => {});
            }
          })();
        }
        workers.dispatchQueued();
      }
    },
  });
  // Sharing shows memtrace.io the same session, and holds no credential of its own.
  const sharing = new Sharing({
    state,
    changed,
    session: () => beta!.sessionProof(),
  });
  registerSharing(register, sharing, host);
  register("beta:status", z.undefined(), () => beta!.status());
  register("beta:connect", z.undefined(), () => beta!.connect());
  register("beta:cancel", z.undefined(), () => beta!.cancel());
  register("beta:sign-out", z.undefined(), () => beta!.signOut());
  register("beta:refresh", z.undefined(), () => beta!.refresh());
  register("beta:resume", z.undefined(), () => beta!.resume());
  register("telemetry:status", z.undefined(), () => telemetry.status());
  register("telemetry:privacy", z.undefined(), () =>
    host.call("open_memcode_telemetry_privacy", {}),
  );
  register(
    "telemetry:set",
    z.object({ enabled: z.boolean() }).strict(),
    async ({ enabled }) => {
      const status = await telemetry.setEnabled(enabled);
      if (enabled) void telemetry.flush();
      return status;
    },
  );
  register("telemetry:flush", z.undefined(), async () => {
    await telemetry.flush();
    return telemetry.status();
  });
  register(
    "beta:use-cli",
    z.object({ confirmed: z.literal(true) }).strict(),
    () => beta!.useExistingCLI(),
  );
  void beta.initialize().then(() => {
    betaReady = true;
    workers.dispatchQueued();
  });
  const assigning = new Map<string, Promise<void>>();
  const activeRouteError =
    "This worker is active. Its current route stays bound to the running attempt.";
  // Measure a defined story and record who will pick it up. Never starts work.
  const measureStory = async (id: string) => {
    const item = task(id);
    if (item.example)
      throw new Error(
        "Example context is not measured. Connect a project to gather real evidence.",
      );
    if (isActive(item)) throw new Error(activeRouteError);
    const parent = project(item.projectId);
    if (parent.analysis !== "ready") await analyze(parent.id);
    const current = task(id);
    if (isActive(current)) throw new Error(activeRouteError);
    const measurement = { ...current, scope: current.scope?.slice() };
    const measuredRequest = qualificationRequestFingerprint(measurement);
    const [installed, evidence, calibration, languageModel] = await Promise.all([
      discover(),
      engine.qualify(
        epicAnalysisProject(project(measurement.projectId), measurement),
        measurement,
      ),
      readRoutingCalibration(store.dir),
      readRoutingLanguage(store.dir),
    ]);
    const latest = task(id);
    if (isActive(latest)) throw new Error(activeRouteError);
    if (latest.epicId !== measurement.epicId ||
      qualificationRequestFingerprint(latest) !== measuredRequest)
      throw Error("The story changed during measurement. Plan the worker again for the new scope.");
    const route = planDefinedStory(
      latest,
      evidence,
      installed,
      store.state,
      calibration,
      languageModel,
    );
    latest.evidence = evidence;
    latest.route = route;
    latest.harness = route.harness;
    latest.updatedAt = now();
    await changed();
  };
  const assignStory = (id: string) => {
    const existing = assigning.get(id);
    if (existing) return existing;
    const pending = measureStory(id).finally(() => {
      if (assigning.get(id) === pending) assigning.delete(id);
    });
    assigning.set(id, pending);
    return pending;
  };
  // The platform-independent routes retained from the original desktop runtime.
  register("installation:status", z.undefined(), () =>
    host.call("installation_status", {}),
  );
  register("installation:show-source", z.undefined(), () =>
    host.call("installation_show_source", {}),
  );
  register("installation:show-applications", z.undefined(), () =>
    host.call("installation_show_applications", {}),
  );
  register("connection:refresh-catalog", z.undefined(), async () => {
    await discoverHarnesses(true);
    return store.runtime();
  });
  register("connection:guide", z.object({ harness }).strict(), ({ harness }) =>
    host.call("open_worker_setup", { harness }),
  );
  register("connection:terminal", z.undefined(), () =>
    host.call("open_worker_terminal", {}),
  );
  register("workspace:load", z.undefined(), async () => {
    await reconcileCatalog();
    return { state: store.state, runtime: await store.runtime() };
  });
  register("project:select", identifier, async (id) => {
    project(id);
    store.state.activeProjectId = id;
    activateProjectGuide(store.state, id);
    await changed();
    void resumeProjectWatch(id);
    if (beta?.usesBeta() && project(id).path && project(id).analysis === "idle")
      void analyze(id).catch(() => {});
  });
  register(
    "project:create",
    z.object({
      mode: z.enum(["existing", "new"]),
      parent: nonempty,
      name: nonempty.max(80),
      description: z.string().max(10000),
    }),
    async (input) => {
      const parent = await realpath(input.parent);
      if (!selectedFolders.has(parent))
        throw new Error("Choose the folder with the project picker first.");
      if (!(await stat(parent)).isDirectory())
        throw new Error("Choose a project folder.");
      let path = parent;
      if (input.mode === "new") {
        const slug = input.name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-|-$/g, "");
        if (!slug)
          throw new Error("Use a project name containing letters or numbers.");
        path = join(parent, slug);
        if (!within(parent, path) || (await exists(path)))
          throw new Error(
            "A folder with that name already exists. Choose a different name.",
          );
        await mkdir(path);
        await git(path, ["init", "--initial-branch=main"]);
        await writeFile(
          join(path, "README.md"),
          `# ${input.name}\n\n${input.description || "A new project, started in MemCode."}\n`,
        );
        await writeFile(
          join(path, ".gitignore"),
          ".memcode/\n.memdb/\n.memtrace/\nnode_modules/\n.env\n",
        );
        await git(path, ["add", "--", "README.md", ".gitignore"]);
        await git(path, [
          "-c",
          "user.name=MemCode",
          "-c",
          "user.email=local@memcode.invalid",
          "commit",
          "-m",
          "Start project from MemCode brief",
        ]);
      }
      const existing = store.state.projects.find(
        (p) =>
          p.path &&
          resolve(p.path).toLowerCase() === resolve(path).toLowerCase(),
      );
      if (existing) {
        store.state.activeProjectId = existing.id;
        activateProjectGuide(store.state, existing.id);
        await changed();
        return existing;
      }
      let branch = "main";
      try {
        branch = (await git(path, ["branch", "--show-current"])) || "main";
      } catch {
        /* A folder can be analyzed before Git is set up. */
      }
      const item: Project = {
        id: randomUUID(),
        name: input.name,
        description: input.description,
        path,
        branch,
        analysis: "idle",
        createdAt: now(),
      };
      store.state.projects.push(item);
      initializeCodeReviewWorkflow(store.state, item.id);
      store.state.activeProjectId = item.id;
      beginProjectGuide(store.state, item);
      await changed();
      void analyze(item.id).catch(() => {});
      return item;
    },
  );
  register("project:analyze", identifier, analyze);
  register(
    "task:message",
    z
      .object({
        id: identifier,
        text: nonempty.max(20000),
        references: z.array(reviewReferenceSchema).max(8).optional(),
      })
      .strict(),
    async ({ id, text, references }) => {
      const item = task(id);
      if (references?.some((ref: ReviewReference) => ref.taskId !== id))
        throw Error("Comments must belong to this work item.");
      const body = references?.length
        ? formatReviewMessage(text, references)
        : text;
      if (body.length > 48000)
        throw Error(
          "This follow-up is too long. Use fewer or shorter selections.",
        );
      item.messages.push({
        id: randomUUID(),
        role: "user",
        text: body,
        at: now(),
        ...(references?.length ? { references } : {}),
      });
      item.updatedAt = now();
      await changed();
    },
  );
  register("task:qualify", identifier, (id) => assignStory(id));
  register("worker:start", identifier, async (id) => {
    const item = task(id);
    await workers.start(item, project(item.projectId));
  });
  register("worker:stop", identifier, (id) => workers.stop(id));
  register(
    "task:verify",
    z
      .object({
        id: identifier,
        program: nonempty.max(2000),
        args: z.array(z.string().max(8000)).max(80),
        format: z.enum(["tap", "memcode-json", "exit-code"]),
        timeoutMs: z.number().int().min(1000).max(300000).default(60000),
        cwd: z.string().max(2000).optional(),
      })
      .strict(),
    async (input) => {
      const result = await runTaskVerification(state, terminals, input);
      if (result.linked)
        try {
          telemetry.verified(task(input.id), result);
        } catch {
          /* Reporting cannot change the completed check result. */
        }
      await changed();
      return result;
    },
  );
  register(
    "worker:respond",
    z
      .object({
        taskId: identifier,
        requestId: identifier,
        response: workerResponseSchema,
      })
      .strict(),
    ({ taskId, requestId, response }) =>
      workers.inputs.respond(taskId, requestId, response),
  );
  register("fleet:refresh", identifier, (id) =>
    workers.fleet.refresh(project(id)),
  );
  register(
    "fleet:resolve",
    z.object({
      id: identifier,
      resolution: nonempty.max(10000),
      winnerTaskId: identifier.optional(),
    }),
    async ({ id, resolution, winnerTaskId }) => {
      const conflict = store.state.fleetConflicts.find(
        (item) => item.id === id,
      );
      if (!conflict) throw new Error("Fleet decision not found.");
      // Running workers hear the decision at their next call; paused ones are brought back with it.
      await workers.decide(id, resolution, winnerTaskId);
    },
  );
  register(
    "worker:permission-default",
    z.object({ harness, mode: z.enum(permissionModes) }).strict(),
    async ({ harness: id, mode }) => {
      if (!supportsPermissionMode(id, mode))
        throw Error("This worker supports Review and Full access.");
      const defaults = workerPermissionDefaults.parse({
        ...state().settings.workerPermissionDefaults,
        [id]: mode,
      });
      state().settings.workerPermissionDefaults = defaults;
      await changed();
    },
  );
  register(
    "settings:save",
    z
      .object({
        workerPermissionDefaults: workerPermissionDefaults.optional(),
        handoffAttribution: handoffAttributionSchema.optional(),
        automaticUpdateDownloads: z.boolean().optional(),
        sharing: sharingSettingsSchema.optional(),
        memtracePath: z.string().max(1000),
        speechEndpoint: z.string().max(1000),
        speech: speechSettingsSchema.optional(),
        defaultHarness: harness,
        model: z.string().max(200),
        localModel: z.boolean(),
        maxWorkers: z.number().int().min(1).max(maxWorkerSlots),
        contextAssistant: z
          .object({
            enabled: z.boolean(),
            provider: z.enum(["onnx", "openai-compatible"]),
            packageDirectory: z.string().max(2000),
            baseUrl: z.string().max(2000),
            model: z.string().max(500),
          })
          .strict()
          .optional(),
      })
      .strict(),
    async (settings) => {
      localURL(settings.speechEndpoint);
      const sharingSettings = sharingSettingsToKeep(
        settings.sharing,
        store.state.settings.sharing,
      );
      if (settings.contextAssistant?.enabled) {
        const helper = settings.contextAssistant;
        if (!helper.model.trim())
          throw new Error("Choose an installed model for context assistance.");
        if (helper.provider === "openai-compatible") localURL(helper.baseUrl);
        else {
          if (helper.model !== contextAssistantDefaults.model)
            throw new Error(
              "The cached ONNX pilot uses Qwen2.5-Coder-0.5B-Instruct. Select that model or use a local model server.",
            );
          if (!helper.packageDirectory.trim()) {
            if ((await retrieval.status()).status !== "ready")
              throw new Error(
                "Choose Set up local retrieval before enabling the local assistant.",
              );
          } else {
            if (!isAbsolute(helper.packageDirectory))
              throw new Error(
                "Choose the absolute installed Transformers package directory for local context assistance.",
              );
            let manifest: { name?: string };
            try {
              manifest = JSON.parse(
                await readFile(
                  join(helper.packageDirectory, "package.json"),
                  "utf8",
                ),
              );
            } catch {
              throw new Error(
                "The Transformers package directory could not be read.",
              );
            }
            if (manifest.name !== "@huggingface/transformers")
              throw new Error(
                "Choose the @huggingface/transformers package directory with your cached model.",
              );
          }
        }
      }
      if (settings.localModel && !settings.model.trim())
        throw new Error(
          "Enter the name of an installed Ollama model for local-model mode.",
        );
      if (store.state.tasks.some((t) => isActive(t) && !t.example))
        throw new Error(
          "Stop active workers before changing runtime settings.",
        );
      // Saving speech, retrieval or worker preferences must not permanently
      // close the shared engine. Only its executable changes the connection;
      // reconnect resets the owner lifecycle so the next project can open it.
      if (settings.memtracePath !== store.state.settings.memtracePath)
        await engine.reconnect();
      // A Settings dialog opened before a worker-default or handoff choice must not erase it.
      store.state.settings = {
        ...store.state.settings,
        ...settings,
        speech: settings.speech ?? store.state.settings.speech,
        sharing: sharingSettings,
        contextAssistant:
          settings.contextAssistant ?? store.state.settings.contextAssistant,
        workerPermissionDefaults: state().settings.workerPermissionDefaults,
        handoffAttribution: state().settings.handoffAttribution,
      };
      await changed();
      return store.runtime();
    },
  );
  register("artifact:thumbnail", identifier, async (id) => {
    const artifact = store.state.artifacts.find(
      (artifact) => artifact.id === id,
    );
    if (!artifact) throw Error("Artifact not found.");
    const item = task(artifact.taskId);
    return readArtifactThumbnail(
      artifact,
      await canonicalArtifactRoots(store.dir, item),
    );
  });
  register("artifact:read", identifier, async (id) => {
    const artifact = store.state.artifacts.find((a) => a.id === id);
    if (!artifact || artifact.kind === "html")
      throw new Error("Inline artifact not found.");
    const path = await realpath(artifact.path);
    const item = task(artifact.taskId);
    const roots = await canonicalArtifactRoots(store.dir, item);
    if (!roots.some((root) => within(root, path)))
      throw new Error("Artifact path is outside the output folders.");
    if (
      (await stat(path)).size >
      (artifact.kind === "image" ? 25_000_000 : 1_000_000)
    )
      throw new Error("This artifact is too large for inline preview.");
    if (artifact.kind === "image") {
      const mime: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
      };
      const type = mime[extname(path).toLowerCase()];
      if (!type) throw Error("Unsupported inline image format.");
      return `data:${type};base64,${(await readFile(path)).toString("base64")}`;
    }
    return readFile(path, "utf8");
  });
  register(
    "file:resolve",
    z
      .object({
        taskId: identifier,
        href: z.string().min(1).max(6000),
        basePath: z.string().max(4000).optional(),
      })
      .strict(),
    ({ taskId, href, basePath }) =>
      resolveFile(store.state, store.dir, taskId, href, basePath),
  );

  registerPlanning(register, state, project, changed);
  registerOnboarding(register, state, changed);
  registerDeletion(register, state, changed);
  registerCardComments(register, state, changed, (taskId) => {
    const projectId = taskId
      ? state().tasks.find((task) => task.id === taskId)?.projectId
      : state().activeProjectId;
    return (
      (projectId ? team?.identity(projectId) : undefined) ??
      connections.account.current.principal
    );
  });
  registerSpeech(register, speech);
  registerHandoff(register, state, changed);
  registerPullRequests(
    register,
    createPullRequestService({
      state,
      changed,
      openUrl: (url) => host.call<void>("open_github_pull_request", { url }),
    }),
  );
  /** Repo-relative files Memtrace associates with a request, for placement and planning. */
  const relatedFiles = async (projectId: string, request: string) => {
    const target = project(projectId);
    if (target.analysis !== "ready" || !target.path) return [];
    const result = await engine.call(target, "find_code", {
      repo_id: target.repoId,
      branch: target.branch,
      query: request.slice(0, 1000),
      limit: 12,
    });
    return [
      ...new Set(
        ((result?.results ?? []) as Array<{ file_path?: string }>)
          .map((row) => String(row.file_path ?? ""))
          .filter(Boolean)
          .map((file) => repoRelativePath(target, file))
          .filter((file) => !file.startsWith("..") && !isAbsolute(file)),
      ),
    ];
  };
  registerGoalPlacement(
    register,
    new GoalPlacement({ state, readChanges: readGoalChanges, relatedFiles }),
  );
  registerGoalPlanner(
    register,
    new GoalPlanner({ dataDir: store.dir, state, relatedFiles }),
  );
  registerGoalUpdates(
    register,
    new GoalUpdates({
      state,
      changed,
      refreshGraph: async (epicId) => {
        const task = state().tasks.find(
          (item) => item.epicId === epicId && item.run.analysisProjectId,
        );
        if (!task) return;
        const analysis = epicAnalysisProject(project(task.projectId), task);
        await engine.activateEpic(analysis);
        await engine.analyze(analysis, () => {});
      },
    }),
  );
  register("retrieval:status", z.undefined(), () => retrieval.status());
  register("retrieval:setup", z.undefined(), () => retrieval.install());
  register(
    "retrieval:configure",
    z
      .object({
        enabled: z.boolean(),
        provider: z.literal("onnx"),
        packageDirectory: z.literal(""),
        baseUrl: z.string().max(2000),
        model: z.literal(contextAssistantDefaults.model),
      })
      .strict(),
    async (settings) => {
      store.state.settings.contextAssistant = settings;
      await changed();
      return settings;
    },
  );
  registerReview(
    register,
    state,
    changed,
    () => preview.publishComments(),
    workers,
    {
      remoteSend: (item, body) => team?.remoteSession(item.id) ? team.sendSessionCommand(item.id, "followup", body) : Promise.resolve(undefined),
      actor: (item) => team?.sessionActor(item.projectId),
      edit: async (item, messageId, text, cancel) => {
        if (!team?.remoteSession(item.id) && !item.messages.some(m => m.id === messageId && m.sourceCommandId)) return false;
        await team!.editSessionCommand(item.id, messageId, text, cancel);
        return true;
      },
    },
  );
  codeReviews = new CodeReviewManager(store.dir, state, engine, changed, {
    onSaved: (run) => team?.reviewSaved(run),
    actor: (item) =>
      team?.identity(item.projectId) ?? connections.account.current.principal,
    reviewProject: (item, parent) => epicAnalysisProject(parent, item),
    engineVersion: (item) => engine.versionFor(item.id) ?? "Not reported",
    reviewer: createReadonlyReviewAgent(store.dir, state),
    implementationCount: () => workers.implementationCount(),
    implementationStarting: (taskId) => workers.implementationStarting(taskId),
    capacityChanged: () => workers.dispatchQueued(),
    prepare: async (item, selected, update, assertActive, capturedPaths) => {
      const prepared = await prepareReviewAnalysis(
        engine,
        selected,
        update,
        assertActive,
        capturedPaths,
      );
      if (prepared.analysisCheckout === "owned-worktree-v1")
        item.run.analysisRepoId = prepared.repoId;
      return prepared;
    },
    repairPublication: async (
      _item,
      selected,
      update,
      assertActive,
      expectedSourceRevision,
    ) => {
      await repairReviewPublication(
        engine,
        selected,
        update,
        assertActive,
        expectedSourceRevision,
      );
    },
    settled: async (item) =>
      workers.releaseIdleAnalysis(item, project(item.projectId), {
        reviewSettled: true,
      }),
    queueFixes: async (taskId, text) => {
      await handlers.get("review:send")!.handle({ taskId, text });
    },
    accept: async (taskId) => {
      const item = task(taskId),
        binding = state().reviewWorkflows?.[item.projectId];
      if (!binding)
        throw Error(
          "Set this project's Code review and acceptance lanes before accepting a review.",
        );
      applyTaskPatch(state(), item, { statusId: binding.acceptanceStatusId });
      await changed();
    },
  });
  const reviewTask = z.object({ taskId: identifier }).strict();
  const reviewRun = reviewTask.extend({ runId: identifier }).strict();
  const requireReviewLane = (taskId: string) => {
    if (!isCodeReviewTask(state(), task(taskId)))
      throw Error(
        "Move this task to the Code review lane to run a review or change its outcome.",
      );
  };
  register("code-review:get", reviewTask, ({ taskId }) => {
    const remote = team?.remoteSession(taskId);
    return remote ? task(taskId).sharedSession?.review ?? (remote.review ? {...remote.review, taskId} : null) : codeReviews.get(taskId);
  });
  register("code-review:start", reviewTask, async ({ taskId }) => {
    requireReviewLane(taskId);
    const remote = team?.remoteSession(taskId);
    if (remote) {
      await team!.sendSessionCommand(taskId, "review-start", "Run code review for this task's recorded changes.");
      return task(taskId).sharedSession?.review ?? null;
    }
    return codeReviews.start(taskId);
  });
  register("code-review:cancel", reviewRun, ({ taskId, runId }) =>
    codeReviews.cancel(taskId, runId),
  );
  register(
    "code-review:dismiss-finding",
    reviewRun
      .extend({
        findingId: identifier,
        reason: z.enum(codeReviewDismissalReasons.map((item) => item.id)),
        explanation: nonempty.max(2000),
      })
      .strict(),
    ({ taskId, runId, findingId, reason, explanation }) => {
      requireReviewLane(taskId);
      return codeReviews.dismissFinding(
        taskId,
        runId,
        findingId,
        reason,
        explanation,
      );
    },
  );
  register(
    "code-review:reopen-finding",
    reviewRun.extend({ findingId: identifier }).strict(),
    ({ taskId, runId, findingId }) => {
      requireReviewLane(taskId);
      return codeReviews.reopenFinding(taskId, runId, findingId);
    },
  );
  register(
    "code-review:discuss",
    reviewRun.extend({ text: nonempty.max(20000) }).strict(),
    async ({ taskId, runId, text }) => {
      const remote = team?.remoteSession(taskId);
      if (!remote) return codeReviews.discuss(taskId, runId, text);
      await team!.sendSessionCommand(taskId, "review-question", text, runId);
      return task(taskId).sharedSession?.review ?? {...remote.review!, taskId};
    },
  );
  register(
    "code-review:request-fixes",
    reviewRun
      .extend({
        findingIds: z.array(identifier).max(100),
        text: z.string().max(20000).optional(),
      })
      .strict(),
    ({ taskId, runId, findingIds, text }) => {
      requireReviewLane(taskId);
      return codeReviews.requestFixes(taskId, runId, findingIds, text);
    },
  );
  register(
    "code-review:accept",
    reviewRun
      .extend({ reason: z.string().trim().min(1).max(2000).optional() })
      .strict(),
    ({ taskId, runId, reason }) => {
      requireReviewLane(taskId);
      return codeReviews.accept(taskId, runId, reason);
    },
  );
  registerPlanningControls(register, state, project, changed);
  registerIntelligence(register, state, project, changed, engine, analyze);
  registerLocalAnalysis(register, project, engine, async (item, repoId) => {
    if (closed || analyses.has(item.id)) return;
    item.repoId = repoId;
    item.analysis = "ready";
    item.analysisNote =
      "Memtrace verified the current source and graph for this checkout.";
    await changed();
  });
  registerAppUpdates(register, appUpdateGate, changed, () =>
    workers.dispatchQueued(),
  );
  register("project:select-folder", z.undefined(), async () => {
    await preview.hide();
    const selected = await host.call<string | null>("select_folder", {});
    if (!selected) return null;
    const path = await realpath(selected);
    selectedFolders.add(path);
    return path;
  });
  register(
    "task:create",
    z.object({
      projectId: identifier,
      title: nonempty.max(160),
      description: z.string().max(20000),
      priority,
      harness,
      assignment: z.enum(["auto", "manual"]).optional(),
      permissionMode: z.enum(permissionModes).nullable().optional(),
      epicId: identifier.nullable().optional(),
      kind: kind.optional(),
      runbook: z.array(z.string().max(2000)).max(100).optional(),
      scope: z.array(z.string().max(1000)).max(20).optional(),
      ...taskPlanningShape,
    }),
    async (input) => {
      const parent = project(input.projectId);
      if (
        input.cycleId &&
        !state().cycles.some(
          (cycle) =>
            cycle.id === input.cycleId &&
            cycle.projectId === parent.id &&
            cycle.state !== "completed",
        )
      )
        throw new Error("Choose an unfinished cycle in this project.");
      const count =
        state()
          .tasks.filter((task) => task.projectId === parent.id)
          .reduce(
            (max, task) =>
              Math.max(max, Number(task.identifier.split("-").at(-1)) || 0),
            0,
          ) + 1;
      const item: WorkItem = {
        id: randomUUID(),
        identifier: `MC-${String(count).padStart(3, "0")}`,
        projectId: parent.id,
        title: input.title,
        description: input.description,
        priority: input.priority,
        harness: input.harness,
        assignment: input.assignment ?? "auto",
        kind: input.kind ?? "feature",
        epicId: input.epicId,
        category: "Work",
        stage: "planned",
        checklist: newRunbook(input.runbook, randomUUID),
        messages: [
          {
            id: randomUUID(),
            role: "user",
            text: input.description || input.title,
            at: now(),
          },
        ],
        run: { state: "idle" },
        createdAt: now(),
        updatedAt: now(),
        ...(parent.example ? { example: true } : {}),
      };
      const { projectId, runbook, ...fields } = input;
      applyTaskPatch(state(), item, taskPatch.parse(fields));
      ensureTaskEpic(state(), item);
      state().tasks.push(item);
      await changed();
      if (!item.example) void assignStory(item.id).catch(() => {});
      return item;
    },
  );
  register(
    "task:update",
    z.object({ id: identifier, patch: taskPatch }),
    async ({ id, patch }) => {
      const item = task(id),
        wasReview = isCodeReviewTask(state(), item);
      applyTaskPatch(state(), item, patch);
      await changed();
      if (wasReview && !isCodeReviewTask(state(), item))
        await codeReviews.leaveLane(id);
      if (!wasReview && isCodeReviewTask(state(), item) && !isActive(item))
        await codeReviews.start(id);
    },
  );
  register(
    "task:bulk-update",
    z.object({ ids: z.array(identifier).min(1).max(500), patch: taskPatch }),
    async ({ ids, patch }) => {
      const unique = [...new Set(ids)] as string[],
        previouslyReviewing = new Set(
          unique.filter((id) => {
            const item = state().tasks.find((item) => item.id === id);
            return !!item && isCodeReviewTask(state(), item);
          }),
        ),
        candidate = structuredClone(state());
      const depth = (id: string) => {
        let count = 0,
          parent = candidate.tasks.find((task) => task.id === id)?.parentId;
        while (parent && count < 100) {
          count++;
          parent = candidate.tasks.find((task) => task.id === parent)?.parentId;
        }
        return count;
      };
      unique.sort((a, b) => depth(b) - depth(a));
      for (const id of unique) {
        const item = candidate.tasks.find((task) => task.id === id);
        if (!item) throw new Error("A selected task no longer exists.");
        applyTaskPatch(candidate, item, patch);
      }
      for (const id of unique)
        Object.assign(
          task(id),
          candidate.tasks.find((task) => task.id === id),
        );
      await changed();
      for (const id of previouslyReviewing)
        if (!isCodeReviewTask(state(), task(id)))
          await codeReviews.leaveLane(id);
      if (patch.statusId)
        for (const id of unique) {
          const item = task(id);
          if (isCodeReviewTask(state(), item) && !isActive(item))
            await codeReviews.start(id);
        }
    },
  );
  register("worker:open-folder", identifier, async (id) => {
    const item = task(id),
      path = item.run.workspace ?? item.run.worktree;
    if (!path) throw new Error("This task has no goal workspace yet.");
    await host.call("open_path", { path });
  });
  register(
    "preview:show",
    z.object({
      taskId: identifier,
      url: z.string().max(2000).optional(),
      artifactId: identifier.optional(),
      filePath: z.string().max(4000).optional(),
      fileRevision: z.string().max(200).optional(),
      commentId: identifier.optional(),
      commentFocus: z.number().int().min(0).optional(),
      line: z.number().int().min(1).max(10000000).optional(),
      bounds: z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      }),
    }),
    (input) => preview.show(input),
  );
  register(
    "browser:request",
    z.object({ taskId: identifier, request: browserRequestSchema }).strict(),
    ({ taskId, request }) => browsers.execute(taskId, request),
  );
  register("preview:hide", z.undefined(), () => preview.hide());
  register("worker:changes", identifier, async (id) => {
    const item = task(id);
    let changes = await readDisplayedWorkerChanges(item);
    if (
      !changes.checkpoints.length &&
      item.run.baseline &&
      !item.run.changeRunId &&
      item.run.finishedAt
    ) {
      const scopes = item.scope ?? [];
      const overlap = state().tasks.some(
        (peer) =>
          peer.id !== id &&
          peer.projectId === item.projectId &&
          peer.run.startedAt &&
          peer.run.finishedAt &&
          peer.run.startedAt <= item.run.finishedAt! &&
          peer.run.finishedAt >= (item.run.startedAt ?? item.createdAt) &&
          (peer.scope ?? []).some((a) =>
            scopes.some(
              (b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/"),
            ),
          ),
      );
      if (!overlap) {
        await new WorkerChangeJournal().importScopedBaseline(
          project(item.projectId),
          item,
        );
        changes = await readDisplayedWorkerChanges(item);
        await changed();
      }
    }
    return changes;
  });
  register(
    "terminal:request",
    z.object({ taskId: identifier, request: terminalRequestSchema }).strict(),
    ({ taskId, request }) => terminals.execute(taskId, request),
  );
  register(
    "preview:action",
    z.enum(["back", "forward", "reload", "capture", "clear-selection"]),
    (input) => preview.action(input),
  );
  register(
    "window:action",
    z.enum(["minimize", "maximize", "close"]),
    (action) => host.call("window_action", { action }),
  );
  await createExampleArtifacts(store);
  await reconcileCatalog();
  await team.initialize();
  for (const parent of state().projects)
    if (!team.status(parent.id))
      initializeCodeReviewWorkflow(state(), parent.id);
  await changed();
  const artifactMaintenance = setInterval(() => {
    void reconcileCatalog().catch((error) =>
      console.error("Artifact catalog check failed:", error),
    );
  }, 30000);
  artifactMaintenance.unref();
  if (store.state.activeProjectId)
    void resumeProjectWatch(store.state.activeProjectId);
  return {
    store,
    async openProject(path: string, name?: string, description = "") {
      const parent = await realpath(path);
      if (!(await stat(parent)).isDirectory())
        throw Error("Choose a project folder.");
      // A path supplied to the desktop launch command is explicit folder intent,
      // equivalent to selecting that folder in the native picker.
      selectedFolders.add(parent);
      return handlers.get("project:create")!.handle({
        mode: "existing",
        parent,
        name: name || basename(parent),
        description,
      }) as Promise<Project>;
    },
    async request(method: string, input?: unknown) {
      const route = handlers.get(method);
      if (!route) throw new Error(`Unknown MemCode method: ${method}`);
      const value =
        input === null && route.schema.safeParse(undefined).success
          ? undefined
          : input;
      const parsed = route.schema.parse(value);
      if (["story:delete", "epic:delete", "cycle:delete"].includes(method)) {
        await team?.assertDeletionAllowed(
          method,
          (parsed as { id: string }).id,
        );
        const deletedId = (parsed as { id: string }).id;
        const affected =
          method === "epic:delete"
            ? state().tasks.filter((item) => item.epicId === deletedId)
            : method === "story:delete"
              ? [task(deletedId)]
              : [];
        if (
          method === "story:delete" &&
          (parsed as { cascade?: boolean }).cascade
        ) {
          for (const owner of affected)
            for (const child of state().tasks.filter(
              (item) => item.parentId === owner.id,
            ))
              if (!affected.some((item) => item.id === child.id))
                affected.push(child);
        }
        if (affected.some(isActive))
          throw Error(
            "Stop or finish the active workers before deleting this item.",
          );
        for (const item of affected) {
          await workers.stop(item.id, "cancelled");
          if (item.codeReview)
            await codeReviews.interruptForWorker(
              item.id,
              "The task or its goal is being removed. The saved review is preserved but no reviewer continues running.",
            );
        }
        const deletion = await team?.beginDeletion(
          method,
          (parsed as { id: string }).id,
        );
        try {
          return await route.handle(parsed);
        } finally {
          await team?.finishDeletion(deletion);
          for (const item of affected)
            await workers
              .releaseIdleAnalysis(item, project(item.projectId))
              .catch(() => {});
        }
      }
      return route.handle(parsed);
    },
    async close() {
      if (closed) return;
      closed = true;
      const betaClosing = beta?.close();
      clearInterval(artifactMaintenance);
      await reconcilingArtifacts?.catch((error) =>
        console.error("Artifact catalog check failed:", error),
      );
      await workers.close();
      await codeReviews.close();
      await telemetry.close();
      teamIdentity.cancel();
      await repositories.close();
      await team?.close();
      sharing.close();
      await speech.close();
      await retrieval.close();
      await connections.close();
      await terminals.close();
      await browsers.close();
      await preview.close();
      await engine.close();
      await betaClosing;
      await store.save();
    },
  };
}
