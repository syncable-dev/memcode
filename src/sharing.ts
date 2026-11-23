/**
 * Sharing a project with your other computers and with guests.
 * What the app shows of it; nothing here is a credential.
 */

/** Where shared projects live, as memtrace.io lists it. */
export interface SharingSettings {
  /** The sharing service's address. */
  memsyncUrl: string;
  /** Where MemCode exchanges its Memtrace sign-in for an access token. */
  tokenUrl: string;
}

export interface SharedPerson {
  /** The account, as the sharing service names it. Only used to remove a guest. */
  id: string;
  name: string;
  isYou: boolean;
}
/** An invitation nobody has accepted yet. */
export interface OpenInvitation {
  id: string;
  /** Whom it is for. Empty for everyone but the project's owner. */
  email: string;
  sentAt: string;
}

/** A project as the sharing service knows it: a name and the people on it. */
export interface SharedProject {
  id: string;
  name: string;
  owner: SharedPerson;
  guests: SharedPerson[];
  youAreOwner: boolean;
  /** Invitations nobody has accepted yet. Each holds a guest place. */
  openInvitations: OpenInvitation[];
  guestLimit: number;
}

/** An invitation sent to the signed-in person's verified email address. */
export interface PendingInvitation {
  id: string;
  projectId: string;
  projectName: string;
  invitedBy: string;
  expiresAt: string;
}

/** Which shared project the board of a local project belongs to. Kept on this computer. */
export interface SharedProjectLink {
  projectId: string;
  sharedProjectId: string;
  /** As it was when last seen, so it can be named while offline. */
  sharedProjectName: string;
  /** The Memtrace account that connected it. */
  accountId: string;
  /** The sharing service it lives on. */
  service: string;
  connectedAt: string;
  /**
   * How many times the shared board has changed this workspace. Board sync
   * keeps the same number beside the workspace file, and compares the two to
   * tell whether a save was cut off.
   */
  applied?: number;
}

/** How the board of one connected project stands with the shared one. */
export interface SharedBoardStatus {
  projectId: string;
  /**
   * `starting`: reading what the shared board holds.
   * `synced`: both hold the same. `sending`: changes made here are on their way.
   * `offline`: the sharing service cannot be reached; changes wait on this computer.
   * `apart`: both boards have work on them. Boards are never merged, so nothing
   *   is exchanged.
   * `newer`: a newer MemCode laid the board out; it is shown here and not changed.
   * `gone`: the shared project is not there for this person any more.
   * `stopped`: sync cannot go on, and `detail` says why.
   */
  state:
    | "starting"
    | "synced"
    | "sending"
    | "offline"
    | "apart"
    | "newer"
    | "gone"
    | "stopped";
  /** A sentence for the person, when there is something to say. */
  detail?: string;
  /** Changes made on this computer that the shared board does not have yet. */
  waiting: number;
  /** Changes in the shared board's log that could not be read and were left out. */
  leftOut: Array<{ by: string; on: string; count: number }>;
  /** Changes are set aside until one they build on arrives. */
  setAside: boolean;
  /** Values too large for the sharing service. They stay on this computer. */
  tooLarge: number;
}

export type SharingOverview =
  | { state: "not-set" }
  | { state: "signed-out"; detail: string }
  | { state: "unavailable"; detail: string }
  | {
      state: "ready";
      /** The account the lists below belong to. */
      accountId: string;
      service: string;
      projects: SharedProject[];
      invitations: PendingInvitation[];
    };

type Workspace = Pick<
  import("./shared").AppState,
  "projects" | "team" | "sharedProjectLinks"
>;
type LocalProject = import("./shared").Project;
type Ready = Extract<SharingOverview, { state: "ready" }>;

/** How one local project stands with sharing, for the person signed in now. */
export type ProjectSharing =
  | { kind: "free" }
  | { kind: "example" }
  | { kind: "team" }
  | { kind: "connected"; shared: SharedProject }
  /** Connected, but the shared project is not among the person's projects any more. */
  | { kind: "gone"; name: string }
  /** Connected under another Memtrace account, or on another sharing service. */
  | { kind: "elsewhere"; name: string }
  /** Connected as far as this computer knows. The sharing service could not be asked. */
  | { kind: "remembered"; name: string };

export function projectSharing(
  project: LocalProject,
  workspace: Workspace,
  overview: Ready,
): ProjectSharing {
  const link = workspace.sharedProjectLinks?.find(
    (candidate) => candidate.projectId === project.id,
  );
  if (!link) {
    if (project.example) return { kind: "example" };
    const inTeam = workspace.team?.some(
      (room) => room.projectId === project.id,
    );
    return inTeam ? { kind: "team" } : { kind: "free" };
  }
  const madeHere =
    link.accountId === overview.accountId && link.service === overview.service;
  if (!madeHere) return { kind: "elsewhere", name: link.sharedProjectName };
  const shared = overview.projects.find(
    (candidate) => candidate.id === link.sharedProjectId,
  );
  return shared
    ? { kind: "connected", shared }
    : { kind: "gone", name: link.sharedProjectName };
}

/** The local project a shared project is connected to on this computer, if any. */
export function localProjectOf(
  shared: SharedProject,
  links: SharedProjectLink[],
  projects: LocalProject[],
  service: string,
): LocalProject | undefined {
  const link = links.find(
    (candidate) =>
      candidate.sharedProjectId === shared.id && candidate.service === service,
  );
  return link && projects.find((project) => project.id === link.projectId);
}

/** A message from someone else to a worker run on this computer, waiting to be allowed. */
export interface SharedAsk {
  id: string;
  /** Who sent it, and from which kind of computer. */
  from: string;
  device: string;
  kind: "message" | "answer";
  /** What they wrote, or what they answered. */
  text: string;
  sentAt: string;
}

/** A file someone shared from a card of a shared project. */
export interface SharedCardResult {
  id: string;
  name: string;
  mime: string;
  sha256: string;
  size: number;
  kind: "report" | "artifact" | "patch";
  description?: string;
  /** The name of whoever shared it, as the sharing service has it. */
  sharedBy: string;
  sharedAt: string;
  /** Shared from this computer: its own copy is already among the card's files. */
  sharedHere: boolean;
}
