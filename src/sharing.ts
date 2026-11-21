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
