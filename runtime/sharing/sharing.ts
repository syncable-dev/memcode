import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AppState, Artifact, Project } from "../../src/shared";
import type { WorkerChanges } from "../../src/changes";
import type { StoryReviewRun } from "../../src/code-review";
import type {
  PendingInvitation,
  SharedPerson,
  SharedProject,
  SharedProjectLink,
  SharingOverview,
} from "../../src/sharing";
import { twoBoards } from "../../src/sharing-board";
import type { StoryAuthor } from "../../src/story-comments";
import type { BetaSessionProof } from "../beta";
import { SharingAccess } from "./access";
import { sharingAddresses } from "./addresses";
import { BoardStore } from "./board/store";
import { BoardSync } from "./board/sync";
import { CardActivity } from "./cards/activity";
import type { WritingDevice } from "./cards/entries";
import { LARGEST_SHARED_FILE, previewKindOf } from "./cards/files";
import { within } from "../local";
import { MemsyncBoards, type BoardsApi } from "./memsync/boards-api";
import { MemsyncCards, type CardsApi } from "./memsync/cards-api";
import { LARGEST_CARDS_MESSAGE } from "./memsync/cards-contract";
import { grpcChannel, type GrpcChannel } from "./memsync/grpc";
import {
  MemsyncProjects,
  type InvitationRecord,
  type PersonRecord,
  type ProjectRecord,
  type ProjectsApi,
} from "./memsync/projects-api";
import { SignedCalls } from "./memsync/signed-calls";
import {
  SharingRefused,
  SharingSignedOut,
  SharingUnavailable,
} from "./problems";

export interface SharingOptions {
  state(): AppState;
  /** Saves the workspace and tells the app's window. */
  changed(): Promise<unknown>;
  /** The Memtrace sign-in to show memtrace.io. Null: nobody is signed in. */
  session(): Promise<BetaSessionProof | null>;
  /** Where each connected board keeps what it needs between runs. */
  boardsFolder: string;
  /**
   * Saves the workspace as it is at the moment of the call, and writes it only
   * after `first` has finished. Board sync saves its own state through `first`.
   */
  saveWorkspace(first: () => Promise<void>): Promise<unknown>;
  /** What the window shows changed, and nothing needs saving. */
  shown?(): void;
  /** What sharing a card's activity needs of this computer. Without it, no file can be shared. */
  cards?: CardHost;
  fetcher?: typeof fetch;
  now?: () => string;
}

/** Everything that talks to one sharing service, built from one pair of addresses. */
interface Service {
  settingsKey: string;
  address: string;
  channel: GrpcChannel;
  access: SharingAccess;
  projects: ProjectsApi;
  boards: BoardsApi;
  cards: CardsApi;
}
export interface CardHost {
  /** The latest code review report of a task on this computer. */
  reviewOf(taskId: string): Promise<StoryReviewRun | null>;
  /** A file a task saved, when it may be shared. Throws a sentence when it may not. */
  shareableFile(
    taskId: string,
    artifactId: string,
  ): Promise<{
    name: string;
    mime: string;
    kind: "report" | "artifact";
    bytes: Uint8Array;
  }>;
  /** What a task changed, as the Changes tab shows it. */
  changesOf(taskId: string): Promise<WorkerChanges>;
  /** Where a file shared from a card is kept on this computer: a folder its previews may read. */
  filesFolder(taskId: string): string;
}
/** Board sync running for one connected project. */
interface RunningBoard {
  link: SharedProjectLink;
  service: Service;
  sync: BoardSync;
  cards: CardActivity;
}

/** A card's activity is written at most this often while a worker runs. */
const CARDS_EVERY_MS = 1000;
const platformName = (): WritingDevice["name"] =>
  process.platform === "win32"
    ? "Windows"
    : process.platform === "darwin"
      ? "Mac"
      : "Linux";
/** How long connecting waits for board sync to say how the two boards stand. */
const FIRST_WORD_MS = 8000;
const NOT_SET_UP =
  "Sharing is not set up. Enter the sharing addresses in Settings first.";

const shownPerson = (
  person: PersonRecord,
  accountId: string,
): SharedPerson => ({
  name: person.name,
  isYou: person.accountId === accountId,
});
const shownProject = (
  project: ProjectRecord,
  accountId: string,
): SharedProject => ({
  id: project.id,
  name: project.name,
  owner: shownPerson(project.owner, accountId),
  guests: project.guests.map((guest) => shownPerson(guest, accountId)),
  youAreOwner: project.owner.accountId === accountId,
  openInvitations: project.openInvitations.length,
  guestLimit: project.guestLimit,
});
const shownInvitation = (invitation: InvitationRecord): PendingInvitation => ({
  id: invitation.id,
  projectId: invitation.projectId,
  projectName: invitation.projectName,
  invitedBy: invitation.invitedBy?.name ?? "The project's owner",
  expiresAt: invitation.expiresAt,
});

/** A folder name for a link that no other link on this computer gets. */
const folderOf = (link: SharedProjectLink) =>
  createHash("sha256")
    .update([link.service, link.sharedProjectId, link.projectId].join("\n"))
    .digest("hex")
    .slice(0, 32);

/**
 * Sharing a project through the sharing service: who is signed in, the shared
 * projects and invitations of that person, which shared project each local
 * project is connected to, and the board sync that runs for each of those.
 */
export class Sharing {
  private service?: Service;
  private readonly boards = new Map<string, RunningBoard>();
  private matching: Promise<void> = Promise.resolve();
  private device?: Promise<WritingDevice>;
  private cardsTimer?: NodeJS.Timeout;
  private cardsLookedAt = 0;
  private readonly changes = new Map<string, WorkerChanges>();
  private readonly now: () => string;
  constructor(private readonly options: SharingOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    // The workspace file may hold how boards stood when MemCode last ran,
    // and what cards showed from other computers. Both are read again.
    const state = options.state();
    state.sharedBoards = [];
    for (const task of state.tasks)
      if (task.sharedFromLog || task.sharedResults) {
        delete task.sharedSession;
        delete task.sharedFromLog;
        delete task.sharedResults;
      }
  }

  /** What the Sharing view shows. A problem is part of the answer, with what to do about it. */
  async overview(): Promise<SharingOverview> {
    try {
      const service = this.serviceInUse();
      if (!service) return { state: "not-set" };
      const [{ accountId }, projects, invitations] = await Promise.all([
        service.access.current(),
        service.projects.listProjects(),
        service.projects.listInvitations(),
      ]);
      return {
        state: "ready",
        accountId,
        service: service.address,
        projects: projects.map((project) => shownProject(project, accountId)),
        invitations: invitations.map(shownInvitation),
      };
    } catch (problem) {
      if (problem instanceof SharingSignedOut)
        return { state: "signed-out", detail: problem.message };
      if (
        problem instanceof SharingUnavailable ||
        problem instanceof SharingRefused
      )
        return { state: "unavailable", detail: problem.message };
      throw problem;
    }
  }

  async acceptInvitation(input: {
    projectId: string;
    invitationId: string;
  }): Promise<SharingOverview> {
    await this.requiredService().projects.acceptInvitation(
      input.projectId,
      input.invitationId,
    );
    return this.overview();
  }

  /** Records that a local project's board belongs to a shared project the person is on. */
  async connect(input: {
    projectId: string;
    sharedProjectId: string;
  }): Promise<SharedProjectLink> {
    const service = this.requiredService();
    const local = this.assertFree(input, service);
    const [{ accountId }, shared] = await Promise.all([
      service.access.current(),
      service.projects.getProject(input.sharedProjectId),
    ]);
    const link: SharedProjectLink = {
      projectId: input.projectId,
      sharedProjectId: shared.id,
      sharedProjectName: shared.name,
      accountId,
      service: service.address,
      connectedAt: this.now(),
    };
    // Whatever an earlier connection left behind belongs to another moment of this board.
    await new BoardStore(this.boardFolder(link)).remove();
    // Another connect may have finished while the service was being asked.
    this.assertFree(input, service);
    (this.options.state().sharedProjectLinks ??= []).push(link);
    await this.options.changed();
    await this.syncBoards();
    // Both boards have work on them: they stay two, and the project is not connected.
    if ((await this.firstWordOn(link.projectId)) === "apart") {
      await this.disconnect(link.projectId);
      throw new Error(twoBoards({ local: local.name, shared: shared.name }));
    }
    return link;
  }

  /**
   * How a board that just started stands once it has read the log, or
   * `starting` when the service takes longer than a person should wait.
   */
  private async firstWordOn(projectId: string) {
    const patience = Date.now() + FIRST_WORD_MS;
    for (;;) {
      const state = this.boards.get(projectId)?.sync.status().state;
      if (state !== "starting" || Date.now() > patience) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Forgets the link on this computer. The person stays on the shared project. */
  async disconnect(projectId: string): Promise<void> {
    const state = this.options.state();
    const kept = (state.sharedProjectLinks ?? []).filter(
      (link) => link.projectId !== projectId,
    );
    if (kept.length === (state.sharedProjectLinks ?? []).length) return;
    const running = this.boards.get(projectId);
    this.boards.delete(projectId);
    await running?.sync.stop();
    await running?.cards.stop();
    for (const link of state.sharedProjectLinks ?? [])
      if (link.projectId === projectId)
        await new BoardStore(this.boardFolder(link)).remove();
    state.sharedProjectLinks = kept;
    this.showBoards();
    await this.options.changed();
  }

  /**
   * Makes board sync run for exactly the projects the signed-in person has
   * connected to the sharing service in use. For when MemCode starts, and when
   * the sign-in, the addresses or the links change.
   */
  syncBoards(): Promise<void> {
    const matched = this.matching.then(() => this.matchBoardsToLinks());
    this.matching = matched.catch((problem) =>
      console.error("Board sync could not be started:", problem),
    );
    return this.matching;
  }

  /** The workspace was saved. Changes made on this computer to connected boards are found now. */
  async workspaceSaved(): Promise<void> {
    this.workerActivity();
    const projects = this.options.state().projects;
    await Promise.all(
      [...this.boards.values()].map(({ link, sync }) =>
        projects.some((project) => project.id === link.projectId)
          ? sync
              .capture()
              .catch((problem) =>
                console.error("A board change was not picked up:", problem),
              )
          : undefined,
      ),
    );
  }

  /** Who a comment written in a connected project is by: the person signed in to Memtrace. */
  author(projectId: string): StoryAuthor | undefined {
    const running = this.boards.get(projectId);
    if (!running) return undefined;
    const { accountId } = running.link;
    return {
      id: accountId,
      name: running.sync.nameOf(accountId) ?? "You",
      source: "memtrace",
    };
  }

  async close(): Promise<void> {
    clearTimeout(this.cardsTimer);
    await this.matching;
    const running = [...this.boards.values()];
    this.boards.clear();
    await Promise.all(
      running.map(({ sync, cards }) =>
        Promise.all([sync.stop(), cards.stop()]),
      ),
    );
    this.closeService();
  }

  // ── What happens on a card ───────────────────────────────────────────────

  /**
   * A worker did something, or the workspace was saved: what changed in a run
   * on this computer is written to its card's log, at most once a second.
   */
  workerActivity(): void {
    if (this.cardsTimer) return;
    const wait = Math.max(0, this.cardsLookedAt + CARDS_EVERY_MS - Date.now());
    this.cardsTimer = setTimeout(() => {
      this.cardsTimer = undefined;
      this.cardsLookedAt = Date.now();
      void this.captureCards();
    }, wait);
    this.cardsTimer.unref?.();
  }

  /** Writes what changed in every run on this computer, now. */
  async captureCards(): Promise<void> {
    await Promise.all(
      [...this.boards.values()].map(({ cards }) =>
        cards
          .capture()
          .catch((problem) =>
            console.error("A card's activity was not written:", problem),
          ),
      ),
    );
  }

  /** A card was opened: its activity on other computers is read and followed. */
  followCard(taskId: string): void {
    this.boardOfTask(taskId)?.cards.follow(taskId);
  }
  unfollowCard(taskId: string): void {
    this.boardOfTask(taskId)?.cards.unfollow(taskId);
  }

  /** Whether a card shows a worker run from another computer, which nothing can be sent to. */
  showsRunElsewhere(taskId: string): boolean {
    return !!this.taskNamed(taskId)?.sharedFromLog;
  }

  /** Shares a file a task saved with everyone on the shared project. */
  async shareResult(input: { taskId: string; artifactId: string }) {
    const running = this.requiredBoardOfTask(input.taskId);
    const file = await this.cardHost().shareableFile(
      input.taskId,
      input.artifactId,
    );
    const result = await running.cards.shareResult(input.taskId, file);
    return { id: result.id, name: result.name };
  }

  /** Shares what a task changed, as its Changes tab shows it. */
  async shareChanges(taskId: string) {
    const running = this.requiredBoardOfTask(taskId);
    const task = this.taskNamed(taskId)!;
    const changes = await this.cardHost().changesOf(taskId);
    if (!changes.checkpoints.length)
      throw new Error("This task has no recorded changes to share yet.");
    const bytes = new TextEncoder().encode(JSON.stringify(changes));
    if (bytes.length > LARGEST_SHARED_FILE)
      throw new Error(
        "These changes are larger than 5 MB, which is the most a project can share in one file.",
      );
    const result = await running.cards.shareResult(taskId, {
      name: `${task.identifier}-changes.json`,
      mime: "application/json",
      kind: "patch",
      bytes,
    });
    return { id: result.id, name: result.name };
  }

  /** Fetches a file shared from a card and keeps it beside the card, to open like its own. */
  async openSharedResult(input: {
    taskId: string;
    resultId: string;
  }): Promise<Artifact> {
    const running = this.requiredBoardOfTask(input.taskId);
    const task = this.taskNamed(input.taskId)!;
    const result = task.sharedResults?.find(
      (item) => item.id === input.resultId,
    );
    if (!result) throw new Error("That shared file is no longer on this card.");
    const content = await this.fetchShared(running, result.sha256, result.size);
    const folder = this.cardHost().filesFolder(task.id);
    const safeName =
      basename(result.name)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .slice(0, 160) || "shared-file";
    const path = join(
      folder,
      `shared-${createHash("sha256").update(result.id).digest("hex").slice(0, 20)}-${safeName}`,
    );
    if (!within(folder, path))
      throw new Error("That shared file has an unusable name.");
    await mkdir(folder, { recursive: true });
    await writeFile(path, content);
    const artifact: Artifact = {
      id: `shared:${result.id}`,
      projectId: task.projectId,
      taskId: task.id,
      name: result.name,
      kind: previewKindOf(result.mime),
      path,
      createdAt: result.sharedAt,
      source: result.sharedBy,
      purpose: result.kind === "report" ? "report" : "deliverable",
      revision: result.sha256,
    };
    const state = this.options.state();
    state.artifacts = [
      ...state.artifacts.filter((item) => item.id !== artifact.id),
      artifact,
    ];
    await this.options.changed();
    return artifact;
  }

  /** The changes last shared from a card whose run is shown from another computer. */
  async sharedChanges(taskId: string): Promise<WorkerChanges | undefined> {
    const running = this.boardOfTask(taskId);
    const task = this.taskNamed(taskId);
    const latest = task?.sharedResults
      ?.filter((result) => result.kind === "patch")
      .sort((left, right) => left.sharedAt.localeCompare(right.sharedAt))
      .at(-1);
    if (!running || !task || !latest) return undefined;
    const known = this.changes.get(latest.sha256);
    if (known) return { ...known, taskId };
    const content = await this.fetchShared(running, latest.sha256, latest.size);
    let read: WorkerChanges;
    try {
      read = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(content),
      );
    } catch {
      throw new Error("The changes shared from this card could not be read.");
    }
    if (!isChanges(read))
      throw new Error("The changes shared from this card could not be read.");
    this.changes.set(latest.sha256, read);
    return { ...read, taskId };
  }

  private async fetchShared(
    running: RunningBoard,
    sha256: string,
    size: number,
  ): Promise<Uint8Array> {
    const { content } = await running.service.cards.download(
      running.link.sharedProjectId,
      sha256,
    );
    if (
      content.length !== size ||
      createHash("sha256").update(content).digest("hex") !== sha256
    )
      throw new Error("That shared file did not arrive whole. Try again.");
    return content;
  }

  private taskNamed(taskId: string) {
    return this.options.state().tasks.find((task) => task.id === taskId);
  }

  private boardOfTask(taskId: string): RunningBoard | undefined {
    const task = this.taskNamed(taskId);
    return task ? this.boards.get(task.projectId) : undefined;
  }

  private requiredBoardOfTask(taskId: string): RunningBoard {
    const running = this.boardOfTask(taskId);
    if (!running) throw new Error("This card's project is not being shared.");
    return running;
  }

  private cardHost(): CardHost {
    if (!this.options.cards)
      throw new Error("Files cannot be shared from this MemCode.");
    return this.options.cards;
  }

  /** This computer, as card logs name it: an id of its own and its kind. */
  private thisComputer(): Promise<WritingDevice> {
    this.device ??= (async () => {
      const path = join(this.options.boardsFolder, "computer.json");
      try {
        const kept = JSON.parse(await readFile(path, "utf8"));
        if (typeof kept.id === "string" && /^[0-9a-f-]{36}$/.test(kept.id))
          return { id: kept.id, name: platformName() };
      } catch {
        // None yet.
      }
      const made = { id: randomUUID(), name: platformName() };
      await mkdir(this.options.boardsFolder, { recursive: true });
      await writeFile(path, JSON.stringify({ id: made.id }), "utf8");
      return made;
    })();
    return this.device;
  }

  private closeService() {
    this.service?.channel.close();
    this.service = undefined;
  }

  private boardFolder(link: SharedProjectLink) {
    return join(this.options.boardsFolder, folderOf(link));
  }

  private async matchBoardsToLinks(): Promise<void> {
    const state = this.options.state();
    let service: Service | null = null;
    try {
      service = this.serviceInUse();
    } catch {
      // An address that cannot be used: nothing is synchronized, and the Sharing view says why.
    }
    const session = service
      ? await this.options.session().catch(() => null)
      : null;
    const wanted = (state.sharedProjectLinks ?? []).filter(
      (link) =>
        link.service === service?.address &&
        link.accountId === session?.accountId &&
        state.projects.some(
          (project) => project.id === link.projectId && !project.example,
        ),
    );
    for (const [projectId, running] of this.boards) {
      const stays = wanted.some(
        (link) =>
          link.projectId === projectId &&
          link.sharedProjectId === running.link.sharedProjectId &&
          running.service === service,
      );
      if (stays) continue;
      this.boards.delete(projectId);
      await running.sync.stop();
      await running.cards.stop();
    }
    const device = wanted.length ? await this.thisComputer() : undefined;
    for (const link of wanted)
      if (!this.boards.has(link.projectId))
        this.startBoard(link, service!, device!);
    this.showBoards();
  }

  private startBoard(
    link: SharedProjectLink,
    service: Service,
    device: WritingDevice,
  ): void {
    const sync = new BoardSync({
      projectId: link.projectId,
      sharedProjectId: link.sharedProjectId,
      folder: this.boardFolder(link),
      state: this.options.state,
      boards: service.boards,
      saveWorkspace: this.options.saveWorkspace,
      shown: () => this.showBoards(),
      people: async () => {
        const shared = await service.projects.getProject(link.sharedProjectId);
        return new Map(
          [shared.owner, ...shared.guests].map((person) => [
            person.accountId,
            person.name,
          ]),
        );
      },
    });
    const cards = new CardActivity({
      projectId: link.projectId,
      sharedProjectId: link.sharedProjectId,
      device,
      folder: this.boardFolder(link),
      state: this.options.state,
      cards: service.cards,
      reviewOf: (taskId) =>
        this.options.cards?.reviewOf(taskId) ?? Promise.resolve(null),
      nameOf: (account) => sync.nameOf(account),
      shown: () => this.options.shown?.(),
    });
    this.boards.set(link.projectId, { link, service, sync, cards });
    sync.start();
  }

  /** Puts how each board stands where the window reads it. */
  private showBoards(): void {
    this.options.state().sharedBoards = [...this.boards.values()].map(
      ({ sync }) => sync.status(),
    );
    this.options.shown?.();
  }

  private assertFree(
    input: { projectId: string; sharedProjectId: string },
    service: Service,
  ) {
    const state = this.options.state();
    const local = state.projects.find(
      (project) => project.id === input.projectId,
    );
    if (!local) throw new Error("Project not found.");
    assertMayBeShared(local, state);
    const links = state.sharedProjectLinks ?? [];
    const existing = links.find((link) => link.projectId === local.id);
    if (existing)
      throw new Error(
        `This project is already connected to “${existing.sharedProjectName}”. Disconnect it first.`,
      );
    const taken = links.find(
      (link) =>
        link.sharedProjectId === input.sharedProjectId &&
        link.service === service.address,
    );
    const takenBy =
      taken && state.projects.find((project) => project.id === taken.projectId);
    if (taken && takenBy)
      throw new Error(
        `“${taken.sharedProjectName}” is already connected to “${takenBy.name}” on this computer.`,
      );
    return local;
  }

  private requiredService(): Service {
    const service = this.serviceInUse();
    if (!service) throw new Error(NOT_SET_UP);
    return service;
  }

  /** The service for the addresses in Settings now. A changed address starts a new one. */
  private serviceInUse(): Service | null {
    const settings = this.options.state().settings.sharing;
    const settingsKey = JSON.stringify([
      settings?.memsyncUrl ?? "",
      settings?.tokenUrl ?? "",
    ]);
    if (this.service?.settingsKey === settingsKey) return this.service;
    this.closeService();
    let addresses: ReturnType<typeof sharingAddresses>;
    try {
      addresses = sharingAddresses(settings);
    } catch (mistyped) {
      throw new SharingUnavailable((mistyped as Error).message);
    }
    if (!addresses) return null;
    const { memsync, tokenEndpoint } = addresses;
    // A file from a card comes back in one reply of up to 6 MiB.
    const channel = grpcChannel(memsync, {
      maxReplyBytes: LARGEST_CARDS_MESSAGE,
    });
    const access = new SharingAccess({
      session: this.options.session,
      tokenEndpoint: () => tokenEndpoint,
      fetcher: this.options.fetcher,
    });
    const calls = new SignedCalls(channel, access);
    this.service = {
      settingsKey,
      address: memsync.href,
      channel,
      access,
      projects: new MemsyncProjects(calls),
      boards: new MemsyncBoards(calls),
      // A whole file goes in one call, so a call is given longer.
      cards: new MemsyncCards(new SignedCalls(channel, access, 60_000)),
    };
    return this.service;
  }
}

function assertMayBeShared(local: Project, state: AppState) {
  if (local.example)
    throw new Error(
      "The example project cannot be connected. Open one of your own projects first.",
    );
  // Team Sync keeps its own copy of this board in step. Two services must not both do that.
  if (state.team?.some((room) => room.projectId === local.id))
    throw new Error(
      "This project is shared through Team Sync. Leave its team before connecting it to a shared project.",
    );
}

/** Whether what was read has the shape of a task's changes. */
function isChanges(value: unknown): value is WorkerChanges {
  const read = value as WorkerChanges | null;
  return (
    !!read &&
    typeof read === "object" &&
    Array.isArray(read.checkpoints) &&
    read.checkpoints.length <= 1000 &&
    read.checkpoints.every(
      (checkpoint) =>
        !!checkpoint &&
        typeof checkpoint.id === "string" &&
        Array.isArray(checkpoint.files) &&
        checkpoint.files.every(
          (file) =>
            !!file &&
            typeof file.path === "string" &&
            Array.isArray(file.hunks) &&
            file.hunks.every(
              (hunk) =>
                !!hunk &&
                Array.isArray(hunk.lines) &&
                hunk.lines.every(
                  (line) =>
                    !!line &&
                    typeof line.text === "string" &&
                    ["context", "add", "delete"].includes(line.kind),
                ),
            ),
        ),
    ) &&
    typeof read.additions === "number" &&
    typeof read.deletions === "number" &&
    typeof read.files === "number"
  );
}
