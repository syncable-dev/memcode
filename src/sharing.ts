/**
 * Sharing a project with your other computers and with guests.
 * What the app shows of it; nothing here is a credential.
 */

/** Where shared projects live. Both empty: sharing is absent from the app. */
export interface SharingSettings {
  /** The sharing service's address. */
  memsyncUrl: string;
  /** Where MemCode exchanges its Memtrace sign-in for an access token. */
  tokenUrl: string;
}

export const sharingIsSet = (settings: SharingSettings | undefined): boolean =>
  !!settings?.memsyncUrl.trim() && !!settings.tokenUrl.trim();

export interface SharedPerson {
  name: string;
  isYou: boolean;
}

/** A project as the sharing service knows it: a name and the people on it. */
export interface SharedProject {
  id: string;
  name: string;
  owner: SharedPerson;
  guests: SharedPerson[];
  youAreOwner: boolean;
  /** Invitations nobody has accepted yet. Each holds a guest place. */
  openInvitations: number;
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
