import { Channel, invoke as nativeInvoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppState, MemCodeAPI } from "./shared";
import { errorMessage } from "./errors";
import { runtimeHealth } from "./runtime-health";
import { applyStatePatch, type StatePatch } from "./state-patch";

const traceWorkspace = (stage: number, sequence: number, value = 0) => {
  if (import.meta.env.VITE_MEMCODE_TRACE_TRANSPORT === "1")
    console.warn("[memcode-transport-js]", stage, Date.now(), sequence, value);
};

let invokeSequence = 0;
function commandCode(command: string) {
  return command === "rpc"
    ? 1
    : command.includes("__TAURI_CHANNEL__")
      ? 2
      : command === "workspace_ack"
        ? 3
        : command === "workspace_connect"
          ? 4
          : 0;
}
function invoke<T>(...args: Parameters<typeof nativeInvoke>): Promise<T> {
  if (import.meta.env.VITE_MEMCODE_TRACE_TRANSPORT !== "1")
    return nativeInvoke<T>(...args);
  const id = ++invokeSequence;
  const code = commandCode(args[0]);
  console.warn("[memcode-invoke]", 0, Date.now(), id, code);
  return nativeInvoke<T>(...args).finally(() =>
    console.warn("[memcode-invoke]", 1, Date.now(), id, code),
  );
}

function traceNativeFetch() {
  if (import.meta.env.VITE_MEMCODE_TRACE_TRANSPORT !== "1") return;
  const globals = window as Window & { __memcodeFetchTraced?: boolean };
  if (globals.__memcodeFetchTraced) return;
  globals.__memcodeFetchTraced = true;
  const originalFetch = window.fetch;
  window.fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.includes("ipc.localhost") && !url.startsWith("ipc:"))
      return originalFetch.call(window, input, init);
    const command = decodeURIComponent(url.split("/").at(-1) ?? "");
    const code = commandCode(command);
    const id = ++invokeSequence;
    console.warn("[memcode-fetch]", 0, Date.now(), id, code);
    return originalFetch
      .call(window, input, init)
      .finally(() => console.warn("[memcode-fetch]", 1, Date.now(), id, code));
  };
}

const call = async <T = void>(
  method: string,
  input: unknown = null,
): Promise<T> => {
  try {
    return await invoke<T>("rpc", { method, input });
  } catch (error) {
    // Native Tauri rejects with strings; renderer actions expect Error.message.
    const message = errorMessage(error);
    runtimeHealth.observeError(message);
    throw new Error(message, { cause: error });
  }
};
function wavBase64(wav: ArrayBuffer): string {
  const bytes = new Uint8Array(wav);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}
export async function installNativeBridge(): Promise<void> {
  if (!isTauri())
    throw new Error("Open MemCode through its Tauri desktop app.");
  traceNativeFetch();
  const states = new Set<(state: AppState) => void>();
  const betaListeners = new Set<
    (status: import("./beta").MemCodeBetaStatus) => void
  >();
  await listen<import("./beta").MemCodeBetaStatus>("beta:status", (event) =>
    betaListeners.forEach((listener) => listener(event.payload)),
  );
  const previews = new Set<Parameters<MemCodeAPI["onPreview"]>[0]>();
  const terminals = new Set<Parameters<MemCodeAPI["onTerminal"]>[0]>();
  const reviews = new Set<Parameters<MemCodeAPI["onReview"]>[0]>();
  await listen<{ message: string }>("runtime:stopped", (event) =>
    runtimeHealth.stopped(event.payload.message),
  );
  await listen<{ state: "error" | "saved"; message?: string }>(
    "workspace:save-status",
    (event) => runtimeHealth.saveStatus(event.payload),
  );
  await listen<import("./review").ReviewEvent>("review:event", (event) =>
    reviews.forEach((listener) => listener(event.payload)),
  );
  await listen<import("./terminal").TerminalOutput>(
    "terminal:output",
    (event) => terminals.forEach((listener) => listener(event.payload)),
  );
  let workspaceToken = "";
  const connectWorkspace = async () => {
    const token = crypto.randomUUID();
    workspaceToken = token;
    let currentState: AppState | undefined;
    let currentSequence = 0;
    const channel = new Channel<
      { sequence: number; token: string } & (
        { base: number | null; change: StatePatch } | { state: AppState }
      )
    >();
    channel.onmessage = (message) => {
      if (message.token !== workspaceToken) return;
      if (
        "change" in message &&
        message.base !== null &&
        message.base !== currentSequence
      ) {
        void connectWorkspace().catch((error) =>
          runtimeHealth.observeError(errorMessage(error)),
        );
        return;
      }
      traceWorkspace(1, message.sequence);
      try {
        // Keep a hot-reloading renderer compatible until the native restart.
        currentState =
          "change" in message
            ? applyStatePatch(currentState, message.change)
            : message.state;
        currentSequence = message.sequence;
      } catch (error) {
        runtimeHealth.observeError(errorMessage(error));
        void connectWorkspace().catch((failure) =>
          runtimeHealth.observeError(errorMessage(failure)),
        );
        return;
      }
      for (const listener of states) {
        try {
          listener(currentState);
        } catch (error) {
          console.error("Workspace listener failed:", error);
        }
      }
      // A native UI callback alone does not mean JS consumed a large state.
      // Wait for a renderer turn before releasing the next latest snapshot.
      requestAnimationFrame(() => {
        if (workspaceToken !== token) return;
        traceWorkspace(2, message.sequence);
        void invoke<boolean>("workspace_ack", {
          sequence: message.sequence,
          token,
        })
          .then((accepted) => {
            traceWorkspace(3, message.sequence, Number(accepted));
            if (!accepted && workspaceToken === token)
              return connectWorkspace();
          })
          .catch((error) => {
            runtimeHealth.observeError(errorMessage(error));
            if (workspaceToken === token)
              void connectWorkspace().catch((failure) =>
                runtimeHealth.observeError(errorMessage(failure)),
              );
          });
      });
    };
    await invoke("workspace_connect", { channel, token });
    traceWorkspace(0, 0);
  };
  await connectWorkspace();
  await listen<Parameters<Parameters<MemCodeAPI["onPreview"]>[0]>[0]>(
    "preview:event",
    (event) => previews.forEach((listener) => listener(event.payload)),
  );
  const api: MemCodeAPI = {
    telemetryStatus: () => call("telemetry:status"),
    setTelemetryEnabled: (enabled) => call("telemetry:set", { enabled }),
    flushTelemetry: () => call("telemetry:flush"),
    openTelemetryPrivacy: () => call("telemetry:privacy"),
    betaStatus: () => call("beta:status"),
    connectBeta: () => call("beta:connect"),
    cancelBeta: () => call("beta:cancel"),
    signOutBeta: () => call("beta:sign-out"),
    refreshBeta: () => call("beta:refresh"),
    resumeBeta: () => call("beta:resume"),
    useExistingMemtraceCLI: () => call("beta:use-cli", { confirmed: true }),
    onBetaStatus: (listener) => {
      betaListeners.add(listener);
      return () => {
        betaListeners.delete(listener);
      };
    },
    localAnalysisDiagnostics: (projectId) =>
      call("project:local-diagnostics", { projectId }),
    teamsList: () => call("team:list"),
    createTeamWorkspace: (input) => call("team:create-workspace", input),
    shareTeamProject: (input) => call("team:share-project", input),
    openTeamProject: (input) => call("team:open-project", input),
    inviteTeamMember: (input) => call("team:invite-member", input),
    previewTeamInvitation: (input) => call("team:preview-invite", input),
    acceptTeamInvitation: (input) => call("team:accept-invite", input),
    revokeTeamMember: (input) => call("team:revoke-member", input),
    revokeTeamInvitation: (input) => call("team:revoke-invite", input),
    reauthenticateTeam: (input) => call("team:reconnect", input),
    cancelTeamSignIn: () => call("team:cancel-sign-in"),
    inspectProjectRepository: (projectId) =>
      call("repository:inspect", { projectId }),
    findProjectCheckouts: (repository) =>
      call("repository:find-checkouts", { repository }),
    repositoryAccess: (repository) => call("repository:access", { repository }),
    cloneProjectRepository: (input) => call("repository:clone", input),
    cancelRepositorySetup: (projectId) =>
      call("repository:cancel", { projectId }),
    repositorySetupStatus: (projectId) =>
      call("repository:status", { projectId }),
    githubRepositorySignIn: (action) =>
      call("repository:github-sign-in", { action }),
    teamStatus: (projectId) => call("team:status", { projectId }),
    importTeamHistory: (projectId) =>
      call("team:import-history", { projectId }),
    teamCreate: (input) => call("team:create", input),
    teamJoin: (input) => call("team:join", input),
    bindProjectFolder: (projectId, path) =>
      call("project:bind-folder", { projectId, path }),
    teamInvite: (projectId) => call("team:invite", { projectId }),
    teamLeave: (projectId) => call("team:leave", { projectId }),
    teamRelease: (projectId, taskId) =>
      call("team:release", { projectId, taskId }),
    teamRead: (projectId) => call("team:read", { projectId }),
    teamPublish: (input) => call("team:publish", input),
    teamDownloadResult: (projectId, resultId) =>
      call("team:download", { projectId, resultId }),
    deleteStory: (id, cascade) => call("story:delete", { id, cascade }),
    deleteEpic: (id) => call("epic:delete", { id }),
    deleteCycle: (id) => call("cycle:delete", { id }),
    respondToWorker: (taskId, requestId, response) =>
      call("worker:respond", { taskId, requestId, response }),
    updateOnboarding: (patch) => call("onboarding:update", patch),
    updateQueuedFollowup: (taskId, messageId, text, commentEdits) =>
      call("review:queue-update", { taskId, messageId, text, commentEdits }),
    cancelQueuedFollowup: (taskId, messageId) =>
      call("review:queue-cancel", { taskId, messageId }),
    storyCommentIdentity: () => call("story-comment:identity"),
    addStoryComment: (taskId, text, parentId) =>
      call("story-comment:add", { taskId, text, parentId }),
    editStoryComment: (taskId, id, text) =>
      call("story-comment:edit", { taskId, id, text }),
    deleteStoryComment: (taskId, id) =>
      call("story-comment:delete", { taskId, id }),
    refreshWorkerCatalog: () => call("connection:refresh-catalog"),
    installationStatus: () => call("installation:status"),
    showInstallationSource: () => call("installation:show-source"),
    showApplications: () => call("installation:show-applications"),
    openWorkerSetup: (harness) => call("connection:guide", { harness }),
    workerConnectionStatus: () => call("connection:status"),
    connectWorker: (harness, approved) =>
      call("connection:approve", { harness, approved }),
    disconnectWorker: (harness) => call("connection:disconnect", { harness }),
    accountStatus: () => call("account:status"),
    signInMemtrace: () => call("account:sign-in"),
    signOutMemtrace: () => call("account:sign-out"),
    switchMemtraceAccount: () => call("account:switch"),
    cancelMemtraceSignIn: () => call("account:cancel-sign-in"),
    speechStatus: () => call("speech:status"),
    prepareSpeech: () => call("speech:prepare"),
    installSpeech: () => call("speech:install"),
    stopSpeech: () => call("speech:stop"),
    retrievalStatus: () => call("retrieval:status"),
    installRetrieval: () => call("retrieval:setup"),
    configureRetrieval: (settings) => call("retrieval:configure", settings),
    sendFollowup: (taskId, text, ids) =>
      call("review:send", { taskId, text, ids }),
    saveReviewComment: (input) => call("review:save", input),
    deleteReviewComment: (taskId, id) => call("review:delete", { taskId, id }),
    shareReviewComments: (taskId, ids, text) =>
      call("review:share", { taskId, ids, text }),
    resolveFile: (taskId, href, basePath) =>
      call("file:resolve", { taskId, href, basePath }),
    onReview: (listener) => {
      reviews.add(listener);
      return () => {
        reviews.delete(listener);
      };
    },
    workerChanges: (taskId) => call("worker:changes", taskId),
    terminal: (taskId, request) =>
      call("terminal:request", { taskId, request }),
    onTerminal: (listener) => {
      terminals.add(listener);
      return () => {
        terminals.delete(listener);
      };
    },
    load: () => call("workspace:load"),
    onState: (listener) => {
      states.add(listener);
      return () => {
        states.delete(listener);
      };
    },
    onPreview: (listener) => {
      previews.add(listener);
      return () => {
        previews.delete(listener);
      };
    },
    selectFolder: () => call("project:select-folder"),
    createProject: (input) => call("project:create", input),
    selectProject: (id) => call("project:select", id),
    analyzeProject: (id) => call("project:analyze", id),
    createTask: (input) => call("task:create", input),
    updateTask: (id, patch) => call("task:update", { id, patch }),
    bulkUpdateTasks: (ids, patch) => call("task:bulk-update", { ids, patch }),
    refreshIntelligence: (projectId, refreshIndex) =>
      call("intelligence:refresh", { projectId, refreshIndex }),
    queryIntelligence: (projectId, section, input) =>
      call("intelligence:query", { projectId, section, input }),
    addMessage: (id, text, references) =>
      call("task:message", { id, text, references }),
    qualifyTask: (id) => call("task:qualify", id),
    startWorker: (id) => call("worker:start", id),
    getCodeReview: (taskId) => call("code-review:get", { taskId }),
    startCodeReview: (taskId) => call("code-review:start", { taskId }),
    cancelCodeReview: (taskId, runId) =>
      call("code-review:cancel", { taskId, runId }),
    sendCodeReviewMessage: (taskId, runId, text) =>
      call("code-review:discuss", { taskId, runId, text }),
    requestCodeReviewFixes: (taskId, runId, findingIds, text) =>
      call("code-review:request-fixes", { taskId, runId, findingIds, text }),
    acceptCodeReview: (taskId, runId, reason) =>
      call("code-review:accept", { taskId, runId, reason }),
    stopWorker: (id) => call("worker:stop", id),
    createEpic: (input) => call("epic:create", input),
    updateEpic: (id, patch) => call("epic:update", { id, patch }),
    refreshFleet: (id) => call("fleet:refresh", id),
    resolveFleetConflict: (id, resolution, winnerTaskId) =>
      call("fleet:resolve", { id, resolution, winnerTaskId }),
    createCycle: (input) => call("cycle:create", input),
    updateCycle: (id, patch) => call("cycle:update", { id, patch }),
    startCycle: (id) => call("cycle:start", id),
    completeCycle: (id, targetCycleId) =>
      call("cycle:complete", { id, targetCycleId }),
    saveView: (input) => call("view:save", input),
    deleteView: (id) => call("view:delete", id),
    saveWorkflow: (projectId, states) =>
      call("workflow:save", { projectId, states }),
    saveCustomFields: (projectId, fields) =>
      call("fields:save", { projectId, fields }),
    saveSettings: (settings) => call("settings:save", settings),
    setWorkerPermissionDefault: (harness, mode) =>
      call("worker:permission-default", { harness, mode }),
    showPreview: (input) => call("preview:show", input),
    browser: (taskId, request) => call("browser:request", { taskId, request }),
    hidePreview: () => call("preview:hide"),
    previewAction: (action) => call("preview:action", action),
    readArtifact: (id) => call("artifact:read", id),
    readArtifactThumbnail: (id) => call("artifact:thumbnail", id),
    openWorkerWorkspace: (id) => call("worker:open-folder", id),
    transcribe: (wav) => call("speech:transcribe", wavBase64(wav)),
    windowAction: (action) => call("window:action", action),
  };
  window.memcode = api;
  document.addEventListener("mousedown", (event) => {
    if (
      event.button !== 0 ||
      !(event.target instanceof Element) ||
      !event.target.closest(".desktop-titlebar") ||
      event.target.closest("button,input,textarea,a")
    )
      return;
    void getCurrentWindow().startDragging();
  });
}
