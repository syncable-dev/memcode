import {
  collectEvidence,
  refreshEvidence,
  type EvidenceRefresh,
} from "./qualification";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Evidence, Project, WorkItem } from "../src/shared";
import {
  reportFromEngineLine,
  reportFromJob,
  type AnalysisReport,
} from "../src/analysis-progress";
import { childEnv, findCommand, now } from "./local";

/** A note for the person, and the step it belongs to when one is known. */
export type AnalysisUpdate = (note: string, report?: AnalysisReport) => void;
import {
  resolveMcpWorkspace,
  projectMcpWorkspace,
  standaloneMcpWorkspace,
  MemtraceAdmissionError,
  admitPrivateEpisodeRepository,
  waitForPrivateRepositoryDiscovery,
  normalizeMcpEnvironment,
  type MemtraceScopeBinding,
} from "./memtrace-workspace";
import { dirname, join } from "node:path";
import { ensureLocalRuntimeIgnored } from "./project-repository";
import {
  ManagedMemtraceOwners,
  pendingMemtraceOwner,
  disconnectedMemtraceClient,
  recordedOwnerState,
} from "./memtrace-owner";
import {
  certifiedPublication,
  currentSourceNeedsIndex,
  pathKey,
  exactRevisionSource,
  incompletePublication,
  verifiedIndexRevision,
  waitForIndexPublication,
  waitForPeerIndex,
  writingSourceRevision,
  verifyingSourceRevision,
} from "./memtrace-peer-index";
import {
  recoverablePublicationFailure,
  sourceChangedBeforePublication,
} from "../src/local-analysis";
import { appVersion } from "../src/version";
import {
  checkoutCapabilities,
  readCheckoutCapabilities,
  type CheckoutCapabilities,
} from "./memtrace-capabilities";

type Json = Record<string, any>;
function unwrap(value: unknown): any {
  const result = value as Json;
  if (result.isError)
    throw new Error(
      result.content?.map((x: Json) => x.text ?? "").join("\n") ||
        "Memtrace query failed",
    );
  for (const item of [...(result.content ?? [])].reverse()) {
    if (item.type === "text") {
      try {
        return JSON.parse(item.text);
      } catch {
        /* human-readable summary */
      }
    }
  }
  return result;
}
/** MemCode's record of the engine's live watch on one project folder. */
export interface MemtraceWatch {
  /** watching: the engine lists a watch on this folder. unavailable: see reason. */
  state: "watching" | "unavailable";
  path: string;
  repoId: string;
  /** The branch the engine reports for the watch. It follows the checkout. */
  branch: string;
  /**
   * memcode: this engine session created the watch, and close() stops it.
   * existing: it was already there, whoever created it, and is left alone.
   */
  origin: "memcode" | "existing";
  /**
   * When the engine process began this watch. A restarted engine restores the
   * watch with a new time, so this dates a process, not the watch.
   */
  startedAt?: string;
  verifiedAt: string;
  reason?: string;
}
const WATCH_VERIFY_MS = 30_000;

export class MemtraceEngine {
  private owners = new ManagedMemtraceOwners();
  private readonly connecting = new Set<Client>();
  private watches = new Map<string, MemtraceWatch>();
  private watchChecked = new Map<string, number>();
  private watching = new Map<string, Promise<MemtraceWatch>>();
  private watchingPaths = new Map<string, string>();
  private closing = false;
  private opening = new Map<string, Promise<Client>>();
  private bindingPaths = new Map<string, string>();
  private connectionProgress = new Map<string, Set<AnalysisUpdate>>();
  private scopes = new Map<string, MemtraceScopeBinding>();
  private bindingGenerations = new Map<string, number>();
  private retiring = new Set<string>();
  private retirements = new Map<string, Promise<void>>();
  private clients = new Map<
    string,
    { client: Client; transport: StdioClientTransport; projectPath: string }
  >();
  constructor(
    private readonly configuredPath: () => string,
    private readonly options: {
      environment?: () => Promise<Record<string, string>>;
      privateProject?: () => boolean;
      managedGraphRoot?: string;
      checkoutCapabilities?: (
        path: string,
      ) => Promise<CheckoutCapabilities | null>;
    } = {},
  ) {}
  scopeFor(projectId: string): MemtraceScopeBinding | null {
    const scope = this.scopes.get(projectId);
    return scope ? { ...scope } : null;
  }
  /** Guard a multi-call observation against owner replacement or retirement. */
  bindingStillCurrent(projectId: string): () => boolean {
    const owner = this.clients.get(projectId);
    return () =>
      !!owner &&
      !this.closing &&
      !this.retiring.has(projectId) &&
      this.clients.get(projectId) === owner;
  }
  /** Version advertised by the connected engine, never inferred from an install pin. */
  versionFor(projectId: string): string | undefined {
    const value = this.clients
      .get(projectId)
      ?.client.getServerVersion()?.version;
    return typeof value === "string" && value.length > 0 && value.length <= 100
      ? value
      : undefined;
  }
  certificateDiagnosticsFor(projectId: string): string[] {
    const scope = this.scopes.get(projectId);
    return scope ? this.owners.certificateDiagnostics(scope.dataDirectory) : [];
  }
  async ownedWorktreeSupport(project: Project): Promise<boolean> {
    try {
      const advertised = await (
        this.options.checkoutCapabilities ?? readCheckoutCapabilities
      )(this.configuredPath());
      const capabilities = checkoutCapabilities(
        advertised ??
          (await this.call(project, "get_checkout_capabilities", {})),
      );
      return (
        capabilities?.protocol_version === 1 &&
        capabilities?.owned_worktree_v1 === true &&
        capabilities?.checkout_modes?.includes("owned-worktree-v1") === true
      );
    } catch (error) {
      if (
        /unknown tool|tool.*not found|unrecognized.*tool|method not found/i.test(
          (error as Error).message,
        )
      )
        return false;
      throw error;
    }
  }
  /** Release our idle epic owner; the graph cache and checkout stay on disk. */
  async releaseEpic(project: Project): Promise<void> {
    if (
      !project.analysisCurrentSource &&
      project.analysisCheckout !== "owned-worktree-v1"
    )
      return;
    const previous = this.retirements.get(project.id);
    if (previous) return previous;
    this.retiring.add(project.id);
    this.bindingGenerations.set(
      project.id,
      (this.bindingGenerations.get(project.id) ?? 0) + 1,
    );
    const retirement = this.retireEpic(project).finally(() => {
      if (this.retirements.get(project.id) === retirement) {
        this.retirements.delete(project.id);
        this.retiring.delete(project.id);
      }
    });
    this.retirements.set(project.id, retirement);
    return retirement;
  }
  /** Explicit new review/start authority may reopen an idle owner after it drains.
   * An earlier in-flight query still cannot resurrect a retired binding. */
  async activateEpic(
    project: Project,
    update?: (note: string) => void,
  ): Promise<void> {
    const retirement = this.retirements.get(project.id);
    if (retirement) {
      update?.("Finishing the previous goal engine session…");
      await retirement;
    }
    await this.connect(project, update);
  }
  private async retireEpic(project: Project): Promise<void> {
    await this.opening.get(project.id)?.catch(() => {});
    const store = this.scopes.get(project.id)?.dataDirectory;
    try {
      await this.releaseBinding(project.id);
    } finally {
      if (
        store &&
        ![...this.scopes.values()].some(
          (scope) => scope.dataDirectory === store,
        )
      )
        await this.owners.release(store);
    }
    this.bindingPaths.delete(project.id);
    this.watching.delete(project.id);
    this.watchingPaths.delete(project.id);
  }
  watcherFor(projectId: string): MemtraceWatch | null {
    const watch = this.watches.get(projectId);
    return watch ? { ...watch } : null;
  }
  /**
   * Watcher lifecycle. One native Memtrace watch per connected project keeps
   * the index following the shared checkout while workers edit. MemCode does
   * not poll the tree or re-index the repository to stay fresh.
   *
   * 1. Start. analyze() binds a repository identity and then asks the engine
   *    to watch exactly project.path. On an unchanged branch the engine
   *    publishes saves it had missed when a watch starts. It rejects a second
   *    watch on a folder, so the watch list is read first and a watch that
   *    already exists is adopted.
   * 2. Verify. qualify() and refresh() re-read the watch list at most once per
   *    WATCH_VERIFY_MS and start the watch if the engine does not list one,
   *    which covers a project analyzed in an earlier session. The engine's
   *    list is the authority; the record kept here is only a claim about it.
   * 3. Branch change. The engine's watch follows the checkout, so it is
   *    re-verified, not restarted. Whether the new branch is indexed is the
   *    engine's answer: after a switch it can stay not ready, most often when
   *    uncommitted files came along, and neither restarting the watch nor
   *    another index job reliably changes that. MemCode therefore does not
   *    loop either one. analyze(force), run when an epic branch is activated
   *    from a clean tree, stays the single index pass, and stories on a
   *    branch the engine has not confirmed carry a stale binding
   *    (see qualification.ts).
   * 4. Owner stop or restart. The engine persists a watch and restores it
   *    when it starts again, except under MEMTRACE_NO_WATCH_RESTORE, which
   *    MemCode sets for its private project owner. Either way a dropped
   *    connection discards the verification; after reconnecting the watch
   *    list is read again and the watch is started only if it is missing.
   * 5. Stop. close() stops a watch this session created, because a watch left
   *    behind would be restored by a later engine start. A watch that already
   *    existed is left to whoever created it.
   *
   * A watch keeps the index fresh; it does not prove it. Evidence is checked
   * against get_query_revision separately. Never throws: a missing watch is
   * recorded as unavailable with the engine's reason.
   */
  async watch(
    project: Project,
    repoId = project.repoId,
  ): Promise<MemtraceWatch | null> {
    if (this.closing || !project.path || !repoId) return null;
    const claim = this.watches.get(project.id);
    if (
      claim &&
      claim.repoId === repoId &&
      claim.branch === project.branch &&
      pathKey(claim.path) === pathKey(project.path) &&
      Date.now() - (this.watchChecked.get(project.id) ?? 0) < WATCH_VERIFY_MS
    )
      return { ...claim };
    const snapshot = { ...project },
      key = pathKey(project.path);
    let pending =
      this.watchingPaths.get(project.id) === key
        ? this.watching.get(project.id)
        : undefined;
    if (!pending) {
      pending = this.bindWatch(snapshot, repoId).finally(() => {
        if (this.watching.get(project.id) === pending) {
          this.watching.delete(project.id);
          this.watchingPaths.delete(project.id);
        }
      });
      this.watching.set(project.id, pending);
      this.watchingPaths.set(project.id, key);
    }
    return pending;
  }
  private async bindWatch(
    project: Project,
    repoId: string,
  ): Promise<MemtraceWatch> {
    const path = project.path!,
      previous = this.watches.get(project.id);
    const generation = this.bindingGenerations.get(project.id) ?? 0;
    const current = () =>
      generation === (this.bindingGenerations.get(project.id) ?? 0) &&
      (!this.bindingPaths.has(project.id) ||
        this.bindingPaths.get(project.id) === pathKey(path));
    const call = async (name: string, args: Json) => {
      if (!current())
        throw Error(
          "The project's local folder changed while its watch was being checked.",
        );
      const value = await this.call(project, name, args);
      if (!current())
        throw Error(
          "The project's local folder changed while its watch was being checked.",
        );
      return value;
    };
    // Ownership is "this session created the watch on this folder". It
    // survives a failed verification and an engine restart that restores it.
    let origin: MemtraceWatch["origin"] = previous?.origin ?? "existing",
      startedAt = previous?.startedAt;
    const record = (
      watch: Pick<MemtraceWatch, "state" | "branch" | "reason">,
    ) => {
      const claim: MemtraceWatch = {
        ...watch,
        path,
        repoId,
        origin,
        ...(startedAt ? { startedAt } : {}),
        verifiedAt: now(),
      };
      if (current()) {
        this.watches.set(project.id, claim);
        this.watchChecked.set(project.id, Date.now());
      }
      return { ...claim };
    };
    const listed = async (): Promise<Json | undefined> =>
      ((await call("list_watched_paths", {}))?.watches ?? []).find(
        (row: Json) => pathKey(row.path ?? "") === pathKey(path),
      );
    try {
      let row = await listed();
      if (row && row.repo_id !== repoId) {
        if (origin !== "memcode")
          throw Error(
            `Memtrace already watches this folder as ${row.repo_id}.`,
          );
        await call("unwatch_directory", { path });
        row = undefined;
      }
      if (!row) {
        try {
          await call("watch_directory", {
            path,
            repo_id: repoId,
            branch: project.branch,
          });
          origin = "memcode";
        } catch (error) {
          // The watch appeared between the list and here: restored by the
          // engine, or created by another client. Ownership is unchanged.
          if (!/already watching/i.test((error as Error).message)) throw error;
        }
        startedAt = undefined;
        row = await listed();
        if (!row)
          throw Error("Memtrace accepted the watch but does not list it.");
      }
      startedAt =
        typeof row.started_at === "string" ? row.started_at : undefined;
      const branch =
        typeof row.branch === "string" ? row.branch : project.branch;
      return record({
        state: "watching",
        branch,
        ...(branch === project.branch
          ? {}
          : {
              reason: `The watch follows the checkout on ${branch}; this project is recorded on ${project.branch}.`,
            }),
      });
    } catch (error) {
      return record({
        state: "unavailable",
        branch: project.branch,
        reason: ((error as Error).message || "Memtrace did not respond.").slice(
          0,
          400,
        ),
      });
    }
  }
  async connect(
    project: Project,
    update?: AnalysisUpdate,
  ): Promise<Client> {
    if (this.closing) throw Error("The Memtrace connection is closing.");
    if (this.retiring.has(project.id))
      throw Error(
        "This idle goal graph is retiring. Retry after it has closed.",
      );
    if (!project.path) throw Error("Choose a local project folder first.");
    const key = pathKey(project.path);
    if (this.options.environment) await this.options.environment();
    if (this.retiring.has(project.id))
      throw Error(
        "This idle goal graph is retiring. Retry after it has closed.",
      );
    if (!project.path || pathKey(project.path) !== key)
      throw Error(
        "The project's local folder changed during connection. Retry on its current folder.",
      );
    const opening = this.opening.get(project.id);
    if (opening) {
      if (this.bindingPaths.get(project.id) === key) return opening;
      await opening.catch(() => {});
      return this.connect(project, update);
    }
    const existing = this.clients.get(project.id);
    if (existing && pathKey(existing.projectPath) === key) {
      if (!(await this.ownerLost(project.id))) return existing.client;
      // Reading the owner record yields, so another request may have begun the
      // reconnect meanwhile. Join that one rather than opening a second session.
      const reconnecting =
        this.opening.has(project.id) ||
        this.clients.get(project.id) !== existing;
      if (reconnecting) return this.connect(project, update);
    }
    const oldWatch = existing && this.watching.get(project.id);
    if (oldWatch) {
      // Let its already-issued operation settle before removing the old client,
      // so a successful watch creation is owned and can be stopped correctly.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          oldWatch.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 5000);
          }),
        ]);
        if (!settled)
          throw Error(
            "The previous folder's watch is still being checked. Wait for it to finish before reconnecting this project.",
          );
      } finally {
        if (timer) clearTimeout(timer);
      }
      return this.connect(project, update);
    }
    if (update) {
      let listeners = this.connectionProgress.get(project.id);
      if (!listeners)
        this.connectionProgress.set(project.id, (listeners = new Set()));
      listeners.add(update);
    }
    try {
      const changed =
        this.bindingPaths.has(project.id) &&
        this.bindingPaths.get(project.id) !== key;
      const privateProject =
        !changed && this.scopes.get(project.id)?.mode === "project";
      this.bindingPaths.set(project.id, key);
      const snapshot = { ...project };
      const connection = (async () => {
        if (existing || changed)
          await this.releaseBinding(project.id, existing);
        const client = await this.open(snapshot, privateProject);
        if (!project.path || pathKey(project.path) !== key)
          throw Error(
            "The project's local folder changed during connection. Retry on its current folder.",
          );
        return client;
      })().finally(() => {
        if (this.opening.get(project.id) === connection)
          this.opening.delete(project.id);
      });
      this.opening.set(project.id, connection);
      return await connection;
    } finally {
      if (update) {
        const listeners = this.connectionProgress.get(project.id);
        listeners?.delete(update);
        if (!listeners?.size) this.connectionProgress.delete(project.id);
      }
    }
  }
  /**
   * An attached session whose owner process has died would wait out every request on
   * nobody. Reconnecting starts a proper owner for the store again.
   */
  private async ownerLost(projectId: string): Promise<boolean> {
    const scope = this.scopes.get(projectId);
    return (
      !!scope?.attached &&
      (await recordedOwnerState(scope.dataDirectory)) === "gone"
    );
  }
  private async releaseBinding(
    projectId: string,
    connection = this.clients.get(projectId),
  ): Promise<void> {
    const watch = this.watches.get(projectId);
    if (watch?.origin === "memcode") {
      const store = this.scopes.get(projectId)?.dataDirectory;
      const alias = [...this.clients].find(
        ([id, other]) =>
          id !== projectId &&
          pathKey(other.projectPath) === pathKey(watch.path) &&
          !!store &&
          pathKey(this.scopes.get(id)?.dataDirectory ?? "") === pathKey(store),
      );
      if (alias) {
        const peer = this.watches.get(alias[0]);
        this.watches.set(
          alias[0],
          peer ? { ...peer, origin: "memcode" } : { ...watch },
        );
      } else if (connection) {
        // A timed-out unwatch must not leave this owned MCP/graph alive.
        // Closing the session remains mandatory; native owner retirement below
        // drains the exact graph process this app started.
        await connection.client
          .callTool(
            { name: "unwatch_directory", arguments: { path: watch.path } },
            undefined,
            { timeout: 5000 },
          )
          .catch(() => undefined);
      }
    }
    this.watches.delete(projectId);
    this.watchChecked.delete(projectId);
    this.scopes.delete(projectId);
    if (connection && this.clients.get(projectId) === connection) {
      this.clients.delete(projectId);
      await connection.client.close().catch(() => {});
    }
  }
  private async open(
    project: Project,
    privateProject = false,
  ): Promise<Client> {
    if (!project.path) throw new Error("Choose a local project folder first.");
    const authentication = await this.options.environment?.();
    const managed = this.options.privateProject?.() === true;
    privateProject ||=
      managed ||
      project.analysisCurrentSource === true ||
      project.analysisCheckout === "owned-worktree-v1";
    const command = await findCommand("memtrace", this.configuredPath());
    if (!command)
      throw new Error(
        "Memtrace was not found. Install it or choose its executable in Settings.",
      );
    await ensureLocalRuntimeIgnored(project.path);
    const scope = await resolveMcpWorkspace(project.path);
    const ownedCheckout = project.analysisCheckout === "owned-worktree-v1";
    const currentSource =
      ownedCheckout || project.analysisCurrentSource === true;
    const managedGraphRoot = managed
      ? this.options.managedGraphRoot
      : undefined;
    let useManagedOwner = currentSource || !!managedGraphRoot;
    const local = privateProject
      ? await projectMcpWorkspace(project.path, {
          checkoutMode: project.analysisCheckout,
          managedGraphRoot,
          currentSourceOnly: currentSource,
        })
      : null;
    const launchDirectory =
      local && managedGraphRoot && !ownedCheckout
        ? dirname(local.workspaceFile)
        : (local?.directory ?? scope.directory);
    const env = normalizeMcpEnvironment(
      Object.fromEntries(
        Object.entries({
          ...childEnv({ engine: true }),
          ...command.env,
          ...authentication,
        }).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    );
    const standaloneWorkspace = () =>
      !local && !scope.workspace && this.options.managedGraphRoot
        ? standaloneMcpWorkspace(
            scope.directory,
            this.options.managedGraphRoot,
            env,
          )
        : null;
    let standalone = await standaloneWorkspace();
    if (standalone) useManagedOwner = true;
    if (local) {
      env.MEMTRACE_MEMDB_DATA_DIR = local.dataDirectory;
      env.MEMTRACE_DATA_DIR = local.jobDirectory;
      env.MEMTRACE_NO_WATCH_RESTORE = "1";
      // Each epic needs current structure, not another embedding-model copy.
      // Its retrieval uses the checkout's lexical/AST graph; facts never fall
      // back to another branch's semantic index.
      if (currentSource) {
        env.MEMTRACE_SKIP_EMBED = "1";
        // Git history belongs to the primary project graph. Replaying it in
        // every epic duplicates work and holds its current-source publication
        // while workers and reviews need that exact checkout's live structure.
        // This is process-local; the primary graph and installed CLI keep their
        // history, and the epic still records its own live edit episodes.
        env.MEMTRACE_NO_REPLAY = "1";
      }
      // The SDK stops stdio children after a two-second EOF budget. A native
      // graph owner needs a durable flush. Managed graphs attach as clients
      // and ready() starts a separately tracked headless owner when cold.
    }
    if (useManagedOwner) env.MEMTRACE_MCP_ATTACH_ONLY = "1";
    let active: { client: Client; transport: StdioClientTransport } | undefined;
    const disconnect = async () => {
      if (!active) return;
      const previous = active;
      active = undefined;
      this.connecting.delete(previous.client);
      await previous.client.close().catch(() => {});
    };
    const attach = async () => {
      if (this.closing) throw Error("The Memtrace connection is closing.");
      await disconnect();
      const manifest = standalone?.workspaceFile ?? local?.workspaceFile;
      const transport = new StdioClientTransport({
        command: command.command,
        args: [
          ...command.prefix,
          "mcp",
          ...(useManagedOwner ? ["--attach-only"] : []),
          ...(manifest
            ? ["--workspace-file", manifest]
            : scope.workspace
              ? ["--workspace", scope.workspace]
              : []),
        ],
        cwd: standalone ? dirname(standalone.workspaceFile) : launchDirectory,
        env: standalone
          ? {
              ...env,
              MEMTRACE_MEMDB_DATA_DIR: standalone.dataDirectory,
              MEMTRACE_DATA_DIR: standalone.jobDirectory,
            }
          : env,
        stderr: "pipe",
      });
      const client = new Client(
        { name: "memcode", version: appVersion },
        { capabilities: {} },
      );
      active = { client, transport };
      this.connecting.add(client);
      transport.stderr?.on("data", () => {});
      const timer = setTimeout(() => void transport.close(), 30_000);
      try {
        await client.connect(transport);
      } finally {
        clearTimeout(timer);
      }
    };
    const discover = async () =>
      unwrap(
        await active!.client.callTool(
          { name: "list_indexed_repositories", arguments: {} },
          undefined,
          { timeout: 15_000 },
        ),
      );
    const reportProgress = (note: string) => {
      // The engine prints its first index while it starts: follow its steps.
      const report = reportFromEngineLine(note);
      for (const listener of this.connectionProgress.get(project.id) ?? []) {
        try {
          listener(note, report);
        } catch {
          /* Progress cannot change connection ownership. */
        }
      }
    };
    try {
      let discovered: any;
      let probedRepository: string | undefined, probedAdmission: any;
      const probe = async () => {
        probedRepository = undefined;
        probedAdmission = undefined;
        await attach();
        discovered = await discover();
        // Discovery can read the saved workspace manifest before a cold MCP
        // session has attached to its store owner. Probe a real graph read too,
        // so that this state enters the normal owner bootstrap below instead
        // of failing later at the admission check.
        const rows: Json[] = Array.isArray(discovered)
          ? discovered
          : (discovered?.repos ?? []);
        const selected = rows.find(
          (repo) =>
            pathKey(repo.repo_path ?? repo.path ?? "") ===
            pathKey(project.path!),
        );
        if (selected?.repo_id) {
          probedAdmission = await active!.client
            .callTool(
              {
                name: "get_repository_stats",
                arguments: {
                  repo_id: selected.repo_id,
                  branch: project.branch,
                },
              },
              undefined,
              { timeout: 30_000 },
            )
            .then(unwrap);
          probedRepository = selected.repo_id;
        }
      };
      const readyBoundOwner = async () => {
        const binding = standalone ?? local;
        if (!binding) throw Error("A project graph binding is required.");
        useManagedOwner = true;
        env.MEMTRACE_MCP_ATTACH_ONLY = "1";
        // Guard the initial attachment too: an endpoint can still answer while
        // a preceding project binding is shutting down this store.
        await this.owners.ready(
          {
            ...binding,
            directory: standalone
              ? dirname(standalone.workspaceFile)
              : launchDirectory,
          },
          command,
          env,
          probe,
          reportProgress,
        );
      };
      if (local || standalone) {
        await readyBoundOwner();
      } else {
        try {
          await probe();
          // A first-time CLI boot can publish the original folder scope during
          // discovery. Bind it before the application issues any source writes.
          if (!standalone) {
            standalone = await standaloneWorkspace();
            if (standalone) await readyBoundOwner();
          }
        } catch (error) {
          if (
            !pendingMemtraceOwner(error) &&
            !disconnectedMemtraceClient(error)
          )
            throw error;
          // A cold CLI can publish the folder binding before the graph read
          // attaches. Keep that original store and journal; attach through a
          // tracked owner rather than abandoning its history for a fresh graph.
          standalone ??= await standaloneWorkspace();
          if (standalone) {
            await readyBoundOwner();
          } else {
            // ClientPending is not a wrong store. Bootstrap only the selected
            // project, never the broad Folder Group or an unmarked parent.
            await disconnect();
            return this.open(project, true);
          }
        }
      }
      discovered = await waitForPrivateRepositoryDiscovery(
        discovered,
        local,
        discover,
        reportProgress,
        { isCancelled: () => this.closing },
      );
      const repos: Json[] = Array.isArray(discovered)
        ? discovered
        : (discovered?.repos ?? []);
      let admitted = repos.find(
        (repo) =>
          pathKey(repo.repo_path ?? repo.path ?? "") === pathKey(project.path!),
      );
      let privateEpisodeAdmitted = false;
      if (!admitted && local) {
        admitted =
          (await admitPrivateEpisodeRepository(
            repos,
            local,
            project.branch,
            async (name, args) =>
              unwrap(
                await active!.client.callTool(
                  { name, arguments: args },
                  undefined,
                  { timeout: 30_000 },
                ),
              ),
          )) ?? undefined;
        privateEpisodeAdmitted = !!admitted;
      }
      // A healthy, explicit one-member private owner may have no index yet.
      // Let analyze submit its first job; unrelated/partial stores still fail.
      if (!admitted && !(local && repos.length === 0))
        throw new MemtraceAdmissionError(
          `Memtrace's workspace does not include ${project.name}. Reconnect to a workspace that includes this project.`,
        );
      const repoId =
        admitted?.repo_id ?? (admitted ? project.repoId : undefined);
      if (repoId && !privateEpisodeAdmitted) {
        const admission =
          probedRepository === repoId
            ? probedAdmission
            : unwrap(
                await active!.client.callTool(
                  {
                    name: "get_repository_stats",
                    arguments: { repo_id: repoId, branch: project.branch },
                  },
                  undefined,
                  { timeout: 30_000 },
                ),
              );
        if (
          admission?.repo_in_store === false ||
          admission?.diagnostic?.kind === "wrong_store"
        )
          throw new MemtraceAdmissionError(
            `Memtrace's workspace does not include ${project.name} (${project.repoId}). Start Memtrace with a workspace that includes this project, then reconnect. Project: ${project.path}`,
          );
      }
    } catch (error) {
      await disconnect();
      if (
        error instanceof MemtraceAdmissionError &&
        !privateProject &&
        !standalone
      ) {
        return this.open(project, true);
      }
      throw error;
    }
    if (this.closing) {
      await disconnect();
      throw Error("The Memtrace connection is closing.");
    }
    this.scopes.set(
      project.id,
      local
        ? {
            mode: "project",
            dataDirectory: local.dataDirectory,
            workspaceFile: local.workspaceFile,
            ...(useManagedOwner && { attached: true as const }),
          }
        : {
            mode: "workspace",
            dataDirectory:
              env.MEMTRACE_MEMDB_DATA_DIR ?? join(scope.directory, ".memdb"),
            ...(useManagedOwner && { attached: true as const }),
          },
    );
    const connection = active!;
    this.connecting.delete(connection.client);
    this.clients.set(project.id, { ...connection, projectPath: project.path });
    return connection.client;
  }
  async call(
    project: Project,
    name: string,
    args: Json,
    signal?: AbortSignal,
  ): Promise<any> {
    signal?.throwIfAborted();
    const generation = this.bindingGenerations.get(project.id) ?? 0;
    const client = await this.connect(project);
    const query = (connection: Client) =>
      connection
        .callTool({ name, arguments: args }, undefined, {
          timeout: 120_000,
          signal,
        })
        .then((result) => {
          if (generation !== (this.bindingGenerations.get(project.id) ?? 0))
            throw Error(
              "This goal graph was retired; its earlier query was not adopted.",
            );
          return unwrap(result);
        });
    try {
      signal?.throwIfAborted();
      return await query(client);
    } catch (error) {
      signal?.throwIfAborted();
      if (generation !== (this.bindingGenerations.get(project.id) ?? 0))
        throw Error(
          "This goal graph was retired; its earlier query was not retried.",
        );
      if (!pendingMemtraceOwner(error) && !disconnectedMemtraceClient(error))
        throw error;
      if (this.clients.get(project.id)?.client === client)
        this.clients.delete(project.id);
      // Watcher lifecycle step 4: verify the watch again on the next owner.
      this.watchChecked.delete(project.id);
      await client.close().catch(() => {});
      // A disconnected mutation could already have run. Reconnect reads and
      // definitely-not-executed pending-owner requests, without replaying writes.
      if (
        !pendingMemtraceOwner(error) &&
        !/^(get_|list_|find_|check_|query_)/.test(name)
      )
        throw error;
      const result = await query(await this.connect(project));
      if (this.watches.has(project.id))
        void this.watch(project).catch(() => {});
      return result;
    }
  }
  async analyze(
    project: Project,
    update: AnalysisUpdate,
    force = false,
    previousFailure = project.analysis === "error"
      ? project.analysisNote
      : undefined,
    signal?: AbortSignal,
    beforeIndex?: (repoId?: string) => Promise<void>,
  ): Promise<string> {
    signal?.throwIfAborted();
    const repoId = await this.index(
      project,
      update,
      force,
      recoverablePublicationFailure(previousFailure),
      signal,
      beforeIndex,
    );
    signal?.throwIfAborted();
    // Watcher lifecycle step 1. Analysis is complete without waiting for it.
    void this.watch(project, repoId).catch(() => {});
    return repoId;
  }
  private async index(
    project: Project,
    update: AnalysisUpdate,
    force: boolean,
    retryPublication: boolean,
    signal?: AbortSignal,
    beforeIndex?: (repoId?: string) => Promise<void>,
  ): Promise<string> {
    const selectedPath = project.path,
      selectedBranch = project.branch;
    update("Connecting to the local Memtrace engine…", { step: "starting" });
    await this.connect(project, update);
    signal?.throwIfAborted();
    const result = await this.call(
      project,
      "list_indexed_repositories",
      {},
      signal,
    );
    const repos: Json[] = Array.isArray(result)
      ? result
      : (result.repos ?? result.repositories ?? []);
    const match = repos.find(
      (repo) =>
        pathKey(repo.repo_path ?? repo.path ?? "") === pathKey(project.path!),
    );
    const connection = this.clients.get(project.id),
      scope = this.scopes.get(project.id);
    const isCancelled = () =>
      signal?.aborted ||
      this.closing ||
      project.path !== selectedPath ||
      project.branch !== selectedBranch ||
      this.clients.get(project.id) !== connection ||
      this.scopes.get(project.id) !== scope;
    const assertActive = () => {
      if (isCancelled())
        throw Error(
          "Memtrace analysis was cancelled or its engine binding changed. Its result was not adopted.",
        );
    };
    assertActive();
    const wait = { isCancelled, signal, requireCertificate: retryPublication };
    if (
      match?.repo_id &&
      (!force || retryPublication) &&
      (match.index_state === "current" ||
        match.index_state === "catching_up" ||
        retryPublication)
    ) {
      const revision = await this.call(
        project,
        "get_query_revision",
        { repo_id: match.repo_id, branch: project.branch },
        signal,
      );
      assertActive();
      if (retryPublication) {
        if (
          (project.repoId && project.repoId !== match.repo_id) ||
          !exactRevisionSource(revision, project, match.repo_id)
        )
          throw Error(
            "Memtrace could not verify the repository, branch and checkout for this retry.",
          );
        if (certifiedPublication(revision, project, match.repo_id))
          return match.repo_id;
      } else if (verifiedIndexRevision(revision, project, match.repo_id))
        return match.repo_id;
      if (
        writingSourceRevision(revision, project, match.repo_id) ||
        (project.analysisCurrentSource &&
          verifyingSourceRevision(revision, project, match.repo_id))
      )
        return waitForIndexPublication(
          this,
          project,
          match.repo_id,
          update,
          wait,
          revision,
        );
      // Native startup can publish the repository summary before its independent
      // source certificate. Follow that publication without enqueueing a duplicate.
      // A published source view may be behind a peer's completed save. No
      // startup job will arrive for it: request ordinary incremental indexing.
      // index_directory arbitrates a concurrent writer, and its exact source
      // certificate is still mandatory before any worker can proceed.
      const catchUp =
        !retryPublication &&
        currentSourceNeedsIndex(revision, project, match.repo_id);
      if (!catchUp && (!retryPublication || !incompletePublication(revision)))
        return waitForPeerIndex(
          this,
          project,
          { repo_id: match.repo_id, branch: project.branch },
          match.repo_id,
          update,
          wait,
        );
    }
    update("Reading the project structure and building its code graph…", {
      step: "reading",
    });
    const queueIndex = () =>
      this.call(
        project,
        "index_directory",
        {
          path: project.path,
          repo_id: match?.repo_id ?? project.repoId,
          incremental: !!match,
          skip_embed:
            project.analysisCurrentSource === true ||
            project.analysisCheckout === "owned-worktree-v1",
          branch: project.branch,
        },
        signal,
      );
    if (beforeIndex) {
      await beforeIndex(match?.repo_id);
      assertActive();
    }
    const job = await queueIndex();
    assertActive();
    if (
      (job.skipped && job.reason === "peer_indexing") ||
      job.reason === "repository_busy" ||
      job.alreadyUpToDate === true
    )
      return waitForPeerIndex(
        this,
        project,
        job,
        match?.repo_id ?? project.repoId,
        update,
        wait,
      );
    if (job.skipped)
      throw new Error(
        "Another Memtrace index is running for this project. Reconnect when it completes.",
      );
    if (!job.job_id)
      throw new Error(
        "Memtrace did not return an indexing job. Check the engine connection.",
      );
    for (let i = 0; i < 600; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assertActive();
      const status = await this.call(
        project, "check_job_status", { job_id: job.job_id }, signal,
      );
      assertActive();
      update(
        `Analyzing code · ${status.stage ?? status.status ?? "working"}`,
        reportFromJob(status),
      );
      if (status.status === "failed") {
        // A later replay can already have certified the same checkout. The
        // original failed job remains available in engine diagnostics.
        const repoId = match?.repo_id ?? status.repo_id ?? project.repoId;
        if (
          sourceChangedBeforePublication(status.error) &&
          typeof repoId === "string" &&
          (!project.repoId || project.repoId === repoId)
        ) {
          const revision = await this.call(
            project,
            "get_query_revision",
            { repo_id: repoId, branch: project.branch },
            signal,
          ).catch(() => null);
          assertActive();
          if (certifiedPublication(revision, project, repoId)) return repoId;
          if (writingSourceRevision(revision, project, repoId))
            return waitForIndexPublication(
              this,
              project,
              repoId,
              update,
              wait,
              revision,
            );
        }
        throw new Error(status.error ?? "Project analysis failed");
      }
      if (status.status === "completed") {
        const indexed = await this.call(
          project,
          "list_indexed_repositories",
          {},
          signal,
        );
        const current: Json[] = Array.isArray(indexed)
          ? indexed
          : (indexed.repos ?? indexed.repositories ?? []);
        const admitted = current.find(
          (repo) =>
            pathKey(repo.repo_path ?? repo.path ?? "") ===
            pathKey(project.path!),
        );
        const repoId =
          admitted?.repo_id ??
          status.repo_id ??
          status.result?.repo_id ??
          match?.repo_id;
        if (typeof repoId !== "string")
          throw new Error(
            "The index completed without a verified repository identity. Reconnect before planning workers.",
          );
        return waitForIndexPublication(this, project, repoId, update, {
          ...wait,
          completedJob: true,
        });
      }
    }
    throw new Error(
      "Analysis is still running. Reconnect to inspect its progress.",
    );
  }
  async qualify(project: Project, task: WorkItem): Promise<Evidence> {
    await this.watch(project);
    return collectEvidence(this, project, task);
  }
  /**
   * Re-measure only the stories a change is relevant to. Pass the files a
   * worker edited to limit the pass to stories bound to them. Returns the
   * outcome per considered story; the caller applies replacement evidence.
   */
  async refresh(
    project: Project,
    tasks: WorkItem[],
    changed?: string[],
  ): Promise<EvidenceRefresh[]> {
    await this.watch(project);
    return refreshEvidence(this, project, tasks, changed);
  }
  async close(): Promise<void> {
    this.closing = true;
    // A watch start already in flight gets a moment to finish, so it can be
    // stopped below. A hung engine call must not hold up shutdown.
    await Promise.race([
      Promise.allSettled([...this.watching.values()]),
      new Promise((resolve) => setTimeout(resolve, 3_000).unref()),
    ]);
    // Watcher lifecycle step 5. The engine reports "Not watching" for a watch
    // that is already gone, which needs no handling here.
    await Promise.allSettled(
      [...this.watches].map(([id, watch]) => {
        const client = this.clients.get(id)?.client;
        return watch.origin === "memcode" && client
          ? client.callTool(
              { name: "unwatch_directory", arguments: { path: watch.path } },
              undefined,
              { timeout: 5_000 },
            )
          : undefined;
      }),
    );
    this.watches.clear();
    this.watchChecked.clear();
    await Promise.allSettled(
      [...this.connecting].map((client) => client.close()),
    );
    await Promise.allSettled(
      [...this.clients.values()].map((c) => c.client.close()),
    );
    // No attached MCP may remain to elect itself after a forced owner exit.
    // Close transports first; then abort bootstrap and drain owned native trees.
    await this.owners.close();
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled([...this.retirements.values()]);
    this.clients.clear();
    this.scopes.clear();
    this.bindingPaths.clear();
    this.watchingPaths.clear();
  }
  /** An account switch closes our own clients/watches/owners, never borrowed owners. */
  async reconnect(): Promise<void> {
    await this.close();
    this.owners = new ManagedMemtraceOwners();
    this.connecting.clear();
    this.opening.clear();
    this.watching.clear();
    this.connectionProgress.clear();
    this.closing = false;
  }
}
