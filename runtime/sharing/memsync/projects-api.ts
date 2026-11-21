import type { AccessToken } from "../access";
import { refusalNamed, SharingUnavailable } from "../problems";
import { GrpcFailure, grpcStatus, type GrpcChannel } from "./grpc";
import {
  projectsCalls,
  projectsContract,
  projectsService,
  type ProjectsCall,
} from "./projects-contract";
import {
  decodeMessage,
  encodeMessage,
  WireError,
  type WireMessage,
} from "./wire";

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
}

/** Where access tokens come from, and where one the service refused is handed back. */
export interface AccessTokens {
  current(): Promise<AccessToken>;
  forget(token: string): void;
}

const REFUSAL_HEADER = "memsync-refusal";

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

function unavailable(failure: GrpcFailure): SharingUnavailable {
  const serviceAnswered = failure.metadata["grpc-status"] !== undefined;
  let sentence =
    "The sharing address did not answer as a sharing service. Check it in Settings.";
  if (failure.code === grpcStatus.UNAUTHENTICATED)
    sentence =
      "The sharing service did not accept this sign-in. Try again in a few minutes.";
  else if (failure.code === grpcStatus.DEADLINE_EXCEEDED)
    sentence =
      "The sharing service did not answer in time. Try again in a moment.";
  else if (serviceAnswered)
    sentence =
      "The sharing service is having trouble right now. Try again in a few minutes.";
  else if (failure.code === grpcStatus.UNAVAILABLE)
    sentence =
      "The sharing service could not be reached. Check your connection and try again.";
  return new SharingUnavailable(sentence, { cause: failure });
}

/** What to tell the person about a call that did not end in a reply. */
function problemWith(call: ProjectsCall, failure: unknown): Error {
  if (failure instanceof WireError)
    return new SharingUnavailable(
      "The sharing service sent a reply MemCode could not read. Updating MemCode may help.",
      { cause: failure },
    );
  if (!(failure instanceof GrpcFailure)) return failure as Error;
  const rule = failure.metadata[REFUSAL_HEADER];
  const refusal = refusalNamed(rule);
  if (refusal) return refusal;
  // The log keeps what the sentence leaves out: which call, and the service's own words.
  console.error(
    `[sharing] ${call} failed: status ${failure.code}${rule ? `, rule ${rule}` : ""}: ${failure.message}`,
  );
  if (rule)
    return new SharingUnavailable(
      "The sharing service turned this down for a reason this version of MemCode does not know. Updating MemCode may help.",
      { cause: failure },
    );
  return unavailable(failure);
}

const signInWasRefused = (failure: unknown) =>
  failure instanceof GrpcFailure &&
  failure.code === grpcStatus.UNAUTHENTICATED &&
  !failure.metadata[REFUSAL_HEADER];

/** The Projects API over gRPC, signed in with the caller's access token. */
export class MemsyncProjects implements ProjectsApi {
  constructor(
    private readonly channel: GrpcChannel,
    private readonly access: AccessTokens,
    private readonly timeoutMs?: number,
  ) {}

  listProjects() {
    return this.call("ListProjects", {}, (reply) =>
      messages(reply.projects).map(project),
    );
  }
  listInvitations() {
    return this.call("ListInvitations", {}, (reply) =>
      messages(reply.invitations).map(invitation),
    );
  }
  getProject(projectId: string) {
    return this.call("GetProject", { project_id: projectId }, project);
  }
  acceptInvitation(projectId: string, invitationId: string) {
    const request = { project_id: projectId, invitation_id: invitationId };
    return this.call("AcceptInvitation", request, project);
  }

  private async call<Answer>(
    name: ProjectsCall,
    request: WireMessage,
    read: (reply: WireMessage) => Answer,
  ): Promise<Answer> {
    // A token the service refuses is replaced once: its keys or the token may have just changed.
    const first = await this.attempt(name, request, read);
    if ("answer" in first) return first.answer;
    const second = await this.attempt(name, request, read);
    if ("answer" in second) return second.answer;
    throw problemWith(name, second.signInRefused);
  }

  /** One try, from the token to the reply as MemCode's own record. */
  private async attempt<Answer>(
    name: ProjectsCall,
    request: WireMessage,
    read: (reply: WireMessage) => Answer,
  ): Promise<{ answer: Answer } | { signInRefused: GrpcFailure }> {
    const { token } = await this.access.current();
    const shapes = projectsCalls[name];
    try {
      const sent = await this.channel.unary({
        path: `/${projectsService}/${name}`,
        request: encodeMessage(projectsContract, shapes.request, request),
        metadata: { authorization: `Bearer ${token}` },
        timeoutMs: this.timeoutMs,
      });
      return {
        answer: read(decodeMessage(projectsContract, shapes.reply, sent)),
      };
    } catch (failure) {
      if (signInWasRefused(failure)) {
        this.access.forget(token);
        return { signInRefused: failure as GrpcFailure };
      }
      const problem = problemWith(name, failure);
      // A newly verified address reaches the service only in a new token.
      if ("rule" in problem && problem.rule === "email_not_verified")
        this.access.forget(token);
      throw problem;
    }
  }
}
