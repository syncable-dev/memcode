import type { AppState, Project } from "../../src/shared";
import type {
  PendingInvitation,
  SharedPerson,
  SharedProject,
  SharedProjectLink,
  SharingOverview,
} from "../../src/sharing";
import type { BetaSessionProof } from "../beta";
import { SharingAccess } from "./access";
import { sharingAddresses } from "./addresses";
import { grpcChannel, type GrpcChannel } from "./memsync/grpc";
import {
  MemsyncProjects,
  type InvitationRecord,
  type PersonRecord,
  type ProjectRecord,
  type ProjectsApi,
} from "./memsync/projects-api";
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

/**
 * Sharing a project through the sharing service: who is signed in, the shared
 * projects and invitations of that person, and which shared project each local
 * project is connected to. The board itself is not synchronized here.
 */
export class Sharing {
  private service?: Service;
  private readonly now: () => string;
  constructor(private readonly options: SharingOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
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
    // Another connect may have finished while the service was being asked.
    this.assertFree(input, service);
    const link: SharedProjectLink = {
      projectId: input.projectId,
      sharedProjectId: shared.id,
      sharedProjectName: shared.name,
      accountId,
      service: service.address,
      connectedAt: this.now(),
    };
    (this.options.state().sharedProjectLinks ??= []).push(link);
    await this.options.changed();
    return link;
  }

  /** Forgets the link on this computer. The person stays on the shared project. */
  async disconnect(projectId: string): Promise<void> {
    const state = this.options.state();
    const kept = (state.sharedProjectLinks ?? []).filter(
      (link) => link.projectId !== projectId,
    );
    if (kept.length === (state.sharedProjectLinks ?? []).length) return;
    state.sharedProjectLinks = kept;
    await this.options.changed();
  }

  close() {
    this.service?.channel.close();
    this.service = undefined;
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
    this.close();
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
    this.service = {
      settingsKey,
      address: memsync.href,
      channel,
      access,
      projects: new MemsyncProjects(channel, access),
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
