import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AppState, Artifact, Message, Project } from "../../src/shared";
import type { WorkerInputResponse } from "../../src/worker-input";
import type { WorkerChanges } from "../../src/changes";
import type { StoryReviewRun } from "../../src/code-review";
import type {
  SharingSettings,
  PendingInvitation,
  SharedPerson,
  SharedProject,
  InboxLink,
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
import { diskName } from "../attachments";
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
  MemsyncSlackChannels,
  type SlackChannelsApi,
} from "./memsync/slack-api";
import {
  decisionEntry,
  filesOf,
  INBOX_CARD,
  inboxItems,
  OPENABLE,
  type InboxDecision,
  type InboxLogEntry,
  type ProjectInbox,
} from "../../src/inbox";
import {
  SharingRefused,
  SharingSignedOut,
  SharingUnavailable,
} from "./problems";

export interface SharingOptions {
  state(): AppState;
  /** Opens Slack's install page in the person's browser. */
  openSlackInstall?(url: string): Promise<unknown>;
  /** Where files that reports brought are put before they are opened, and how each is. */
  inboxFiles?: {
    folder: string;
    openFile(path: string): Promise<unknown>;
    openLink(url: string): Promise<unknown>;
  };
  /** Saves the workspace and tells the app's window. */
  changed(): Promise<unknown>;
  /**
   * A connected shared project is not there for this person any more: its
   * owner deleted it or took them off it. The app removes it here.
   */
  projectGone?(link: SharedProjectLink): Promise<void>;
  /** The Memtrace sign-in to show memtrace.io. Null: nobody is signed in. */
  session(): Promise<BetaSessionProof | null>;
  /** Where the sharing service is, as memtrace.io lists it. Nothing: sharing is not offered. */
  addresses(): Promise<SharingSettings | undefined>;
  /** Makes an empty project on this computer for a shared board, and opens it. */
  makeProject?(name: string): Promise<Project>;
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
  slack: SlackChannelsApi;
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
  /** Continues a worker run here with a follow-up sent from another computer. */
  continueWorker?(taskId: string, message: Message): Promise<void>;
  /** Answers what a worker run here waits for, with an answer sent from another computer. */
  answerWorker?(
    taskId: string,
    inputId: string,
    response: WorkerInputResponse,
  ): Promise<void>;
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
const NOT_OFFERED = "Sharing is not available right now. Try again later.";
/** One file of a report: its bytes by their hash, and the name it came with. */
export interface InboxFileInput {
  projectId: string;
  sha256: string;
  name: string;
}
/** What a project Slack was never connected to shows. */
const NO_INBOX = (): ProjectInbox => ({
  items: [],
  channels: [],
  workspaces: [],
  channelsUnavailable: false,
});
const isGone = (problem: unknown) =>
  problem instanceof SharingRefused && problem.rule === "no_such_project";

const shownPerson = (
  person: PersonRecord,
  accountId: string,
): SharedPerson => ({
  id: person.accountId,
  name: person.name,
  isYou: person.accountId === accountId,
});
function shownProject(
  project: ProjectRecord,
  accountId: string,
): SharedProject {
  const youAreOwner = project.owner.accountId === accountId;
  return {
    id: project.id,
    name: project.name,
    owner: shownPerson(project.owner, accountId),
    guests: project.guests.map((guest) => shownPerson(guest, accountId)),
    youAreOwner,
    // Only the owner, who sent them, sees whom the invitations are for.
    openInvitations: project.openInvitations.map((invitation) => ({
      id: invitation.id,
      email: youAreOwner ? invitation.email : "",
      sentAt: invitation.sentAt,
    })),
    guestLimit: project.guestLimit,
  };
}
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
  /** Projects already reported gone, so each is reported once. */
  private readonly toldGone = new Set<string>();
  private readonly keepingFiles = new Map<string, Promise<void>>();
  private readonly startingInboxes = new Map<
    string,
    ReturnType<Sharing["startInbox"]>
  >();
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
    // Addresses typed in Settings by an earlier build: MemCode now finds the service itself.
    delete (state.settings as { sharing?: unknown }).sharing;
    for (const task of state.tasks)
      if (
        task.sharedFromLog ||
        task.sharedResults ||
        task.sharedInputs ||
        task.sharedAsks
      ) {
        delete task.sharedSession;
        delete task.sharedFromLog;
        delete task.sharedResults;
        delete task.sharedRunIsYours;
        delete task.sharedInputs;
        delete task.sharedAsks;
      }
  }

  /** What the Share panel and the switcher show. A problem is part of the answer, with what to do about it. */
  async overview(): Promise<SharingOverview> {
    try {
      const service = await this.serviceInUse();
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
        projects: projects
          .filter((project) => !this.isOnlyAnInbox(project.id, service))
          .map((project) => shownProject(project, accountId)),
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
    await (
      await this.requiredService()
    ).projects.acceptInvitation(input.projectId, input.invitationId);
    return this.overview();
  }

  // ── Sharing a project from inside MemCode ─────────────────────────────────

  /**
   * Shares a project on this computer: the first time, a shared project of
   * the same name is started for it and its board is written there. A project
   * that already has an Inbox of its own is shared where that Inbox is, so its
   * reports and Slack connections stay. After that, it answers the link it has.
   */
  async shareProject(projectId: string): Promise<SharedProjectLink> {
    const service = await this.requiredService();
    const known = this.linkOf(projectId, service);
    if (known) return known;
    const state = this.options.state();
    const local = state.projects.find((project) => project.id === projectId);
    if (!local) throw new Error("Project not found.");
    assertMayBeShared(local, state);
    const { accountId } = await service.access.current();
    const inbox = this.inboxLinkOf(projectId, service, accountId);
    if (inbox && !(await this.stillThere(inbox, service)))
      await this.forgetInbox(inbox);
    const sharedProjectId =
      this.inboxLinkOf(projectId, service, accountId)?.sharedProjectId ??
      (await service.projects.startProject(local.name)).id;
    const link = await this.connect({ projectId, sharedProjectId });
    const own = this.inboxLinkOf(projectId, service, accountId);
    if (own) await this.forgetInbox(own);
    return link;
  }

  /** Invites someone by email, sharing the project first if it is not shared yet. */
  async invite(input: { projectId: string; email: string }) {
    const link = await this.shareProject(input.projectId);
    const service = await this.requiredService();
    await service.projects.invitePerson(
      link.sharedProjectId,
      input.email.trim(),
    );
    return this.overview();
  }

  async cancelInvitation(input: { projectId: string; invitationId: string }) {
    const { service, link } = await this.linkedProject(input.projectId);
    await service.projects.cancelInvitation(
      link.sharedProjectId,
      input.invitationId,
    );
    return this.overview();
  }

  async removePerson(input: { projectId: string; personId: string }) {
    const { service, link } = await this.linkedProject(input.projectId);
    await service.projects.removeGuest(link.sharedProjectId, input.personId);
    return this.overview();
  }

  /**
   * Before a shared project is deleted on this computer: its owner deletes it
   * for everyone, anyone else leaves it. When it is already gone, or was
   * connected under another account, only the link here goes.
   */
  async removeForAccount(projectId: string): Promise<void> {
    await this.removeInbox(projectId);
    const link = (this.options.state().sharedProjectLinks ?? []).find(
      (candidate) => candidate.projectId === projectId,
    );
    if (!link) return;
    const service = await this.serviceInUse();
    if (service && service.address === link.service) {
      const { accountId } = await service.access.current();
      if (accountId === link.accountId)
        await this.endSharing(service, link.sharedProjectId, accountId);
    }
    await this.disconnect(projectId);
  }

  private async endSharing(service: Service, sharedProjectId: string, accountId: string) {
    try {
      const shared = await service.projects.getProject(sharedProjectId);
      if (shared.owner.accountId === accountId)
        await service.projects.deleteProject(sharedProjectId);
      else await service.projects.leaveProject(sharedProjectId);
    } catch (problem) {
      if (!isGone(problem)) throw problem;
    }
  }

  /** A guest leaves a shared project. The board stays on this computer, no longer shared. */
  async leave(projectId: string) {
    const { service, link } = await this.linkedProject(projectId);
    await service.projects.leaveProject(link.sharedProjectId);
    await this.disconnect(projectId);
    return this.overview();
  }

  /**
   * Opens a shared project on this computer: the project that already holds
   * its board, or a new, empty one that takes the board from the log.
   */
  async openShared(sharedProjectId: string): Promise<{ projectId: string }> {
    const service = await this.requiredService();
    const state = this.options.state();
    const here = (state.sharedProjectLinks ?? []).find(
      (link) =>
        link.sharedProjectId === sharedProjectId &&
        link.service === service.address &&
        state.projects.some((project) => project.id === link.projectId),
    );
    if (here) {
      state.activeProjectId = here.projectId;
      await this.options.changed();
      return { projectId: here.projectId };
    }
    if (!this.options.makeProject)
      throw new Error("A shared project cannot be opened in this MemCode.");
    const shared = await service.projects.getProject(sharedProjectId);
    const made = await this.options.makeProject(shared.name);
    try {
      await this.connect({ projectId: made.id, sharedProjectId: shared.id });
    } catch (problem) {
      // Nothing was on the new project. It goes, and the reason is said.
      state.projects = state.projects.filter(
        (project) => project.id !== made.id,
      );
      await this.options.changed();
      throw problem;
    }
    return { projectId: made.id };
  }

  /** Accepts an invitation and opens the shared project on this computer. */
  async join(input: { sharedProjectId: string; invitationId: string }) {
    await (
      await this.requiredService()
    ).projects.acceptInvitation(input.sharedProjectId, input.invitationId);
    return this.openShared(input.sharedProjectId);
  }

  private linkOf(projectId: string, service: Service) {
    return this.options
      .state()
      .sharedProjectLinks?.find(
        (link) =>
          link.projectId === projectId && link.service === service.address,
      );
  }

  private async linkedProject(projectId: string) {
    const service = await this.requiredService();
    const link = this.linkOf(projectId, service);
    if (!link) throw new Error("This project is not shared.");
    return { service, link };
  }

  // ── The Inbox ─────────────────────────────────────────────────────────────

  private inboxLinkOf(projectId: string, service: Service, accountId: string) {
    return this.options
      .state()
      .inboxLinks?.find(
        (link) =>
          link.projectId === projectId &&
          link.service === service.address &&
          link.accountId === accountId,
      );
  }

  /** Whether a project on the sharing service only holds the Inbox of a project here. */
  private isOnlyAnInbox(sharedProjectId: string, service: Service) {
    return !!this.options
      .state()
      .inboxLinks?.some(
        (link) =>
          link.sharedProjectId === sharedProjectId &&
          link.service === service.address,
      );
  }

  private async stillThere(link: InboxLink, service: Service) {
    try {
      await service.projects.getProject(link.sharedProjectId);
      return true;
    } catch (problem) {
      if (isGone(problem)) return false;
      throw problem;
    }
  }

  private async forgetInbox(gone: InboxLink) {
    const state = this.options.state();
    state.inboxLinks = (state.inboxLinks ?? []).filter((link) => link !== gone);
    await this.options.changed();
  }

  /** Where a project's Inbox is: its shared project, or one that is only its Inbox. */
  private async inboxHome(projectId: string) {
    const state = this.options.state();
    const known = (link: { projectId: string }) => link.projectId === projectId;
    if (!state.sharedProjectLinks?.some(known) && !state.inboxLinks?.some(known))
      return null;
    const service = await this.requiredService();
    const link = this.linkOf(projectId, service);
    if (link) return { service, sharedProjectId: link.sharedProjectId };
    const { accountId } = await service.access.current();
    const own = this.inboxLinkOf(projectId, service, accountId);
    return own && { service, sharedProjectId: own.sharedProjectId, own };
  }

  private async requiredInbox(projectId: string) {
    const home = await this.inboxHome(projectId);
    if (!home)
      throw new Error("This project has no Inbox yet. Connect Slack to it first.");
    return home;
  }

  /**
   * The project's Inbox, started if it has none. It is a project of the person's own on
   * the sharing service with no board in it, so connecting Slack shares nothing else.
   */
  private async startedInbox(projectId: string) {
    const known = await this.inboxHome(projectId);
    if (known && (!known.own || (await this.stillThere(known.own, known.service))))
      return known;
    if (known?.own) await this.forgetInbox(known.own);
    // Two presses start one Inbox.
    let starting = this.startingInboxes.get(projectId);
    if (!starting) {
      starting = this.startInbox(projectId).finally(() =>
        this.startingInboxes.delete(projectId),
      );
      this.startingInboxes.set(projectId, starting);
    }
    return starting;
  }

  private async startInbox(projectId: string) {
    const service = await this.requiredService();
    const { accountId } = await service.access.current();
    const state = this.options.state();
    const local = state.projects.find((project) => project.id === projectId);
    if (!local) throw new Error("Project not found.");
    if (local.example)
      throw new Error(
        "The example project cannot get reports. Open one of your own projects first.",
      );
    const { id } = await service.projects.startProject(local.name);
    const own: InboxLink = {
      projectId,
      sharedProjectId: id,
      accountId,
      service: service.address,
      startedAt: this.now(),
    };
    (state.inboxLinks ??= []).push(own);
    await this.options.changed();
    return { service, sharedProjectId: id, own };
  }

  /**
   * Before a project is deleted on this computer: an Inbox that is only its own goes
   * with its reports and Slack connections, when it belongs to whoever is signed in.
   */
  private async removeInbox(projectId: string) {
    const links = (this.options.state().inboxLinks ?? []).filter(
      (link) => link.projectId === projectId,
    );
    if (!links.length) return;
    const service = await this.serviceInUse();
    if (service) {
      const { accountId } = await service.access.current();
      const own = this.inboxLinkOf(projectId, service, accountId);
      if (own) await this.endSharing(service, own.sharedProjectId, accountId);
    }
    for (const link of links) await this.forgetInbox(link);
  }

  /**
   * A project's Inbox: what people reported from Slack, and the channels that report
   * into it. The Inbox is the card log of the nil card (MemSync ADR-0020). A project
   * Slack was never connected to has none, and nobody is asked about it.
   */
  async inbox(projectId: string): Promise<ProjectInbox> {
    const home = await this.inboxHome(projectId);
    if (!home) return NO_INBOX();
    try {
      return await this.readInbox(home.service, home.sharedProjectId);
    } catch (problem) {
      if (!home.own || !isGone(problem)) throw problem;
      // It was deleted from another computer.
      await this.forgetInbox(home.own);
      return NO_INBOX();
    }
  }

  private async readInbox(
    service: Service,
    sharedProjectId: string,
  ): Promise<ProjectInbox> {
    const entries: InboxLogEntry[] = [];
    for (let after = 0; ; ) {
      const page = await service.cards.readAfter(
        sharedProjectId,
        INBOX_CARD,
        after,
      );
      if (!page.length) break;
      entries.push(...page);
      after = page[page.length - 1].sequence;
    }
    // An older MemSync has no Slack connections; the Inbox still reads.
    const slack = await service.slack.list(sharedProjectId).catch(() => null);
    return {
      items: inboxItems(entries),
      channels: slack?.channels ?? [],
      workspaces: slack?.workspaces ?? [],
      channelsUnavailable: slack === null,
    };
  }

  /**
   * Opens Slack's page for adding MemCode to a workspace, in the person's browser.
   * Approving it there connects the workspace to this project (MemSync ADR-0021).
   * The project does not have to be shared: one that is not gets an Inbox of its own.
   */
  async addToSlack(projectId: string) {
    if (!this.options.openSlackInstall)
      throw new Error("This copy of MemCode cannot open Slack. Update MemCode.");
    const { service, sharedProjectId } = await this.startedInbox(projectId);
    const url = await service.slack.startInstall(sharedProjectId);
    await this.options.openSlackInstall(url);
  }

  /** Stops a Slack workspace, and every channel of it, sending reports here. */
  async disconnectSlack(input: { projectId: string; teamId: string }) {
    const { service, sharedProjectId } = await this.requiredInbox(input.projectId);
    await service.slack.disconnect(sharedProjectId, input.teamId);
    return this.inbox(input.projectId);
  }

  /** Links the Slack channel that gave this code with `/memcode link`. */
  async linkSlackChannel(input: { projectId: string; code: string }) {
    const { service, sharedProjectId } = await this.requiredInbox(input.projectId);
    await service.slack.link(sharedProjectId, input.code);
    return this.inbox(input.projectId);
  }

  async unlinkSlackChannel(input: {
    projectId: string;
    teamId: string;
    channelId: string;
  }) {
    const { service, sharedProjectId } = await this.requiredInbox(input.projectId);
    await service.slack.unlink(
      sharedProjectId,
      input.teamId,
      input.channelId,
    );
    return this.inbox(input.projectId);
  }

  /** Records what became of a report: picked up as a goal, declined, or reopened. */
  async decideInboxItem(input: {
    projectId: string;
    itemId: string;
    decision: InboxDecision;
  }) {
    const { service, sharedProjectId } = await this.requiredInbox(input.projectId);
    const entry = decisionEntry(input.itemId, input.decision);
    const payload = new TextEncoder().encode(JSON.stringify(entry));
    await service.cards.append(sharedProjectId, INBOX_CARD, [
      { id: randomUUID(), payload },
    ]);
    return this.inbox(input.projectId);
  }

  /** A file a report brought, from the project's files, to show in the window. */
  async inboxFile(input: { projectId: string; sha256: string }) {
    const { service, sharedProjectId } = await this.requiredInbox(input.projectId);
    const { content } = await service.cards.download(
      sharedProjectId,
      input.sha256,
    );
    return { base64: Buffer.from(content).toString("base64") };
  }

  /**
   * A file a report brought, kept on this computer to be previewed or opened. Only kinds
   * of files that hold no program of their own, and marked as having come from outside.
   */
  async keptInboxFile(input: InboxFileInput): Promise<{
    path: string;
    name: string;
    folder: string;
  }> {
    const place = this.options.inboxFiles;
    const name = diskName(input.name);
    if (!place || !OPENABLE.test(name))
      throw new Error("MemCode does not open this kind of file. Open it in Slack.");
    const folder = join(place.folder, input.sha256);
    const path = join(folder, name);
    // A preview and a click may ask for the same file at once.
    let keeping = this.keepingFiles.get(path);
    if (!keeping) {
      keeping = this.keepInboxFile(input, folder, path).finally(() =>
        this.keepingFiles.delete(path),
      );
      this.keepingFiles.set(path, keeping);
    }
    await keeping;
    return { path, name, folder };
  }

  private async keepInboxFile(
    input: InboxFileInput,
    folder: string,
    path: string,
  ) {
    const here = await readFile(path).catch(() => null);
    if (here && createHash("sha256").update(here).digest("hex") === input.sha256)
      return;
    const { service, sharedProjectId } = await this.requiredInbox(input.projectId);
    const { content } = await service.cards.download(
      sharedProjectId,
      input.sha256,
    );
    await mkdir(folder, { recursive: true });
    await writeFile(path, content);
    // Windows then warns about it, and Office opens it protected, like a download.
    if (process.platform === "win32")
      await writeFile(
        `${path}:Zone.Identifier`,
        "[ZoneTransfer]\r\nZoneId=3\r\n",
      ).catch(() => {});
  }

  /** Opens a file a report brought in this computer's own program for it. */
  async openInboxFile(input: InboxFileInput) {
    const { path } = await this.keptInboxFile(input);
    await this.options.inboxFiles!.openFile(path);
  }

  /** Opens a link a report holds, and no other, in the person's browser. */
  async openInboxLink(input: { projectId: string; url: string }) {
    const { items } = await this.inbox(input.projectId);
    const held = items.some(
      (item) =>
        item.permalink === input.url ||
        item.links.includes(input.url) ||
        item.replies.some((reply) => reply.links.includes(input.url)) ||
        filesOf(item).some((file) => file.slackUrl === input.url),
    );
    if (!held || !this.options.inboxFiles)
      throw new Error("That link is not in this project's Inbox.");
    await this.options.inboxFiles.openLink(input.url);
  }

  /** Records that a local project's board belongs to a shared project the person is on. */
  async connect(input: {
    projectId: string;
    sharedProjectId: string;
  }): Promise<SharedProjectLink> {
    const service = await this.requiredService();
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

  /** Says once that a connected project's board found it gone. */
  private tellGone(link: SharedProjectLink): void {
    if (this.toldGone.has(link.projectId)) return;
    this.toldGone.add(link.projectId);
    void this.options.projectGone?.(link).catch((problem) => {
      console.error("A gone shared project could not be removed here:", problem);
    });
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

  /** Whether a card shows a worker run from another computer. What is sent to it goes through the card's log. */
  showsRunElsewhere(taskId: string): boolean {
    return !!this.taskNamed(taskId)?.sharedFromLog;
  }

  /** Sends a follow-up to the worker a card shows from another computer. Its id is the message's. */
  messageWorker(taskId: string, text: string): Promise<string> {
    return this.requiredBoardOfTask(taskId).cards.messageWorker(taskId, text);
  }

  /** Answers what the worker a card shows from another computer waits for. */
  async answerWorker(
    taskId: string,
    inputId: string,
    response: WorkerInputResponse,
  ): Promise<void> {
    await this.requiredBoardOfTask(taskId).cards.answerWorker(
      taskId,
      inputId,
      response,
    );
  }

  /** Allows or declines a message someone else sent to a worker run here. */
  decideMessage(input: {
    taskId: string;
    messageId: string;
    allow: boolean;
  }): Promise<void> {
    return this.requiredBoardOfTask(input.taskId).cards.decide(
      input.taskId,
      input.messageId,
      input.allow,
    );
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
    // No shared project on this computer: the service is not even looked for.
    if (state.sharedProjectLinks?.length)
      try {
        service = await this.serviceInUse();
      } catch {
        // An address that cannot be used: nothing is synchronized.
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
      shown: () => {
        this.showBoards();
        if (sync.status().state === "gone") this.tellGone(link);
      },
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
      changesOf: async (taskId) => {
        const changes = await this.cardHost().changesOf(taskId);
        if (!changes.checkpoints.length) return undefined;
        return new TextEncoder().encode(JSON.stringify(changes));
      },
      savedFileOf: (taskId, artifactId) =>
        this.cardHost().shareableFile(taskId, artifactId),
      nameOf: (account) => sync.nameOf(account),
      learnName: (account) => sync.learnName(account),
      shown: () => this.options.shown?.(),
      me: link.accountId,
      deliver: (taskId, message) =>
        this.cardHost().continueWorker?.(taskId, message) ??
        Promise.reject(new Error("Workers cannot be continued from here.")),
      answer: (taskId, inputId, response) =>
        this.cardHost().answerWorker?.(taskId, inputId, response) ??
        Promise.reject(new Error("Workers cannot be answered from here.")),
    });
    this.boards.set(link.projectId, { link, service, sync, cards });
    sync.start();
    // Messages sent to workers here while MemCode was closed are read now.
    void cards
      .capture()
      .catch((problem) =>
        console.error("Card activity could not start:", problem),
      );
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

  private async requiredService(): Promise<Service> {
    const service = await this.serviceInUse();
    if (!service) throw new Error(NOT_OFFERED);
    return service;
  }

  /** The service at the addresses memtrace.io lists now. Changed addresses start a new one. */
  private async serviceInUse(): Promise<Service | null> {
    const settings = await this.options.addresses();
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
      slack: new MemsyncSlackChannels(calls),
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
