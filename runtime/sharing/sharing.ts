import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppState, Project } from "../../src/shared";
import type {
  PendingInvitation,
  SharedPerson,
  SharedProject,
  SharedProjectLink,
  SharingOverview,
} from "../../src/sharing";
import type { StoryAuthor } from "../../src/story-comments";
import type { BetaSessionProof } from "../beta";
import { SharingAccess } from "./access";
import { sharingAddresses } from "./addresses";
import { BoardStore } from "./board/store";
import { BoardSync } from "./board/sync";
import { MemsyncBoards, type BoardsApi } from "./memsync/boards-api";
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
}
/** Board sync running for one connected project. */
interface RunningBoard {
  link: SharedProjectLink;
  service: Service;
  sync: BoardSync;
}

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
  private readonly now: () => string;
  constructor(private readonly options: SharingOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    // The workspace file may hold how boards stood when MemCode last ran.
    options.state().sharedBoards = [];
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
    this.assertFree(input, service);
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
    return link;
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

  /** The person said to keep both boards: theirs is added to the shared one. */
  async keepBoth(projectId: string): Promise<void> {
    const running = this.boards.get(projectId);
    if (!running) throw new Error("This project's board is not being shared.");
    await running.sync.keepBoth();
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
    await this.matching;
    const running = [...this.boards.values()];
    this.boards.clear();
    await Promise.all(running.map(({ sync }) => sync.stop()));
    this.closeService();
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
    }
    for (const link of wanted)
      if (!this.boards.has(link.projectId)) this.startBoard(link, service!);
    this.showBoards();
  }

  private startBoard(link: SharedProjectLink, service: Service): void {
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
    this.boards.set(link.projectId, { link, service, sync });
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
    const channel = grpcChannel(memsync);
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
