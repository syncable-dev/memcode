import { WireError, type WireMessage } from "./wire";
import {
  projectsCalls,
  projectsContract,
  projectsService,
  type ProjectsCall,
} from "./projects-contract";
import { SignedCalls, type ServiceCall } from "./signed-calls";

export interface PersonRecord {
  accountId: string;
  name: string;
  /** Their verified address, when they have one. */
  email?: string;
}
export interface InvitationRecord {
  id: string;
  projectId: string;
  projectName: string;
  email: string;
  /** Missing once the person who invited is no longer on the project. */
  invitedBy?: PersonRecord;
  sentAt: string;
  expiresAt: string;
}
export interface ProjectRecord {
  id: string;
  name: string;
  owner: PersonRecord;
  guests: PersonRecord[];
  openInvitations: InvitationRecord[];
  guestLimit: number;
}

/** The sharing service's Projects API, as far as MemCode uses it. */
export interface ProjectsApi {
  listProjects(): Promise<ProjectRecord[]>;
  listInvitations(): Promise<InvitationRecord[]>;
  getProject(projectId: string): Promise<ProjectRecord>;
  acceptInvitation(
    projectId: string,
    invitationId: string,
  ): Promise<ProjectRecord>;
  /** Starts a shared project owned by the caller. */
  startProject(name: string): Promise<ProjectRecord>;
  invitePerson(projectId: string, email: string): Promise<InvitationRecord>;
  cancelInvitation(
    projectId: string,
    invitationId: string,
  ): Promise<ProjectRecord>;
  removeGuest(projectId: string, accountId: string): Promise<ProjectRecord>;
  /** A guest leaves a project. The owner cannot. */
  leaveProject(projectId: string): Promise<void>;
}

const unreadable = () =>
  new WireError("A reply lacks something it always holds.");
const isMessage = (value: unknown): value is WireMessage =>
  !!value && typeof value === "object" && !Array.isArray(value);
const messages = (value: unknown) => (Array.isArray(value) ? value : []);

function person(sent: unknown): PersonRecord {
  if (!isMessage(sent) || !sent.account_id) throw unreadable();
  return {
    accountId: String(sent.account_id),
    name: String(sent.name),
    ...(sent.email ? { email: String(sent.email) } : {}),
  };
}

function moment(sent: unknown): string {
  if (!isMessage(sent)) throw unreadable();
  const at = new Date(Number(sent.seconds) * 1000 + Number(sent.nanos) / 1e6);
  if (Number.isNaN(at.getTime())) throw unreadable();
  return at.toISOString();
}

function invitation(sent: WireMessage): InvitationRecord {
  if (!sent.id || !sent.project_id) throw unreadable();
  return {
    id: String(sent.id),
    projectId: String(sent.project_id),
    projectName: String(sent.project_name),
    email: String(sent.email),
    ...(sent.invited_by ? { invitedBy: person(sent.invited_by) } : {}),
    sentAt: moment(sent.sent_at),
    expiresAt: moment(sent.expires_at),
  };
}

function project(sent: WireMessage): ProjectRecord {
  if (!sent.id) throw unreadable();
  return {
    id: String(sent.id),
    name: String(sent.name),
    owner: person(sent.owner),
    guests: messages(sent.guests).map(person),
    openInvitations: messages(sent.open_invitations).map(invitation),
    guestLimit: Number(sent.guest_limit),
  };
}

const call = (name: ProjectsCall): ServiceCall => ({
  service: projectsService,
  name,
  contract: projectsContract,
  ...projectsCalls[name],
});

/** The Projects API over gRPC, signed in with the caller's access token. */
export class MemsyncProjects implements ProjectsApi {
  constructor(private readonly calls: SignedCalls) {}

  listProjects() {
    return this.calls.unary(call("ListProjects"), {}, (reply) =>
      messages(reply.projects).map(project),
    );
  }
  listInvitations() {
    return this.calls.unary(call("ListInvitations"), {}, (reply) =>
      messages(reply.invitations).map(invitation),
    );
  }
  getProject(projectId: string) {
    return this.calls.unary(
      call("GetProject"),
      { project_id: projectId },
      project,
    );
  }
  acceptInvitation(projectId: string, invitationId: string) {
    const request = { project_id: projectId, invitation_id: invitationId };
    return this.calls.unary(call("AcceptInvitation"), request, project);
  }
  startProject(name: string) {
    return this.calls.unary(call("StartProject"), { name }, project);
  }
  invitePerson(projectId: string, email: string) {
    const request = { project_id: projectId, email };
    return this.calls.unary(call("InvitePerson"), request, invitation);
  }
  cancelInvitation(projectId: string, invitationId: string) {
    const request = { project_id: projectId, invitation_id: invitationId };
    return this.calls.unary(call("CancelInvitation"), request, project);
  }
  removeGuest(projectId: string, accountId: string) {
    const request = { project_id: projectId, account_id: accountId };
    return this.calls.unary(call("RemoveGuest"), request, project);
  }
  async leaveProject(projectId: string) {
    await this.calls.unary(
      call("LeaveProject"),
      { project_id: projectId },
      () => undefined,
    );
  }
}
