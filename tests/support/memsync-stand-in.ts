import { createServer, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import {
  decodeMessage,
  encodeMessage,
  type WireMessage,
} from "../../runtime/sharing/memsync/wire";
import { grpcStatus } from "../../runtime/sharing/memsync/grpc";
import { boardsCalls } from "../../runtime/sharing/memsync/boards-contract";
import { ownerCalls, ownerContract } from "./memsync-owner";
import { standInBoardLogs } from "./memsync-stand-in-boards";
import { cardsCalls } from "../../runtime/sharing/memsync/cards-contract";
import { standInCards } from "./memsync-stand-in-cards";

/** Someone a token signs in. `email` is their verified address, if they have one. */
export interface StandInPerson {
  accountId: string;
  name: string;
  email?: string;
}
interface Invitation {
  id: string;
  email: string;
  invitedBy: StandInPerson;
  sentAt: number;
}
interface Project {
  id: string;
  name: string;
  owner: StandInPerson;
  guests: StandInPerson[];
  invitations: Invitation[];
}

// A field number that never ends, which no reader takes for a message.
const NEVER_A_MESSAGE = Buffer.alloc(24, 0xff);
const GUEST_LIMIT = 2,
  INVITATION_LIFETIME_MS = 14 * 86400000;

/** A refusal as MemSync sends it: a status, and the rule's name as metadata. */
class Refused extends Error {
  constructor(
    readonly status: number,
    readonly rule?: string,
  ) {
    super(rule ?? "refused");
  }
}
const refusals = {
  no_such_project: grpcStatus.NOT_FOUND,
  no_such_invitation: grpcStatus.NOT_FOUND,
  no_such_guest: grpcStatus.NOT_FOUND,
  only_the_owner_invites: grpcStatus.PERMISSION_DENIED,
  not_the_owner: grpcStatus.PERMISSION_DENIED,
  the_owner_cannot_leave: grpcStatus.FAILED_PRECONDITION,
  guest_limit_reached: grpcStatus.RESOURCE_EXHAUSTED,
  already_on_project: grpcStatus.ALREADY_EXISTS,
  already_invited: grpcStatus.ALREADY_EXISTS,
  invitation_expired: grpcStatus.FAILED_PRECONDITION,
  email_not_verified: grpcStatus.FAILED_PRECONDITION,
  invalid_project_name: grpcStatus.INVALID_ARGUMENT,
  invalid_email: grpcStatus.INVALID_ARGUMENT,
  invalid_update_id: grpcStatus.INVALID_ARGUMENT,
  empty_update: grpcStatus.INVALID_ARGUMENT,
  update_too_large: grpcStatus.INVALID_ARGUMENT,
  too_many_updates: grpcStatus.INVALID_ARGUMENT,
  invalid_card_id: grpcStatus.INVALID_ARGUMENT,
  file_too_large: grpcStatus.INVALID_ARGUMENT,
  project_storage_full: grpcStatus.RESOURCE_EXHAUSTED,
  no_such_file: grpcStatus.NOT_FOUND,
  unknown_readers: grpcStatus.INVALID_ARGUMENT,
} as const;
const refuse = (rule: keyof typeof refusals): never => {
  throw new Refused(refusals[rule], rule);
};

const moment = (ms: number) => ({
  seconds: Math.floor(ms / 1000),
  nanos: (ms % 1000) * 1e6,
});
const personMessage = (person: StandInPerson): WireMessage => ({
  account_id: person.accountId,
  name: person.name,
  email: person.email ?? "",
});

/**
 * MemSync's Projects service with its rules for personal projects, kept in memory.
 * It speaks the real wire format over HTTP/2, so MemCode's own client talks to it.
 * `tests/sharing-real-memsync.test.ts` runs the same scenarios against the real server.
 */
export async function startStandInMemsync() {
  const projects = new Map<string, Project>();
  const signedIn = new Map<string, StandInPerson>();
  const calls: Array<{ method: string; token: string }> = [];
  let now = Date.parse("2026-11-21T12:00:00Z");
  let turnAway: Refused[] = [];
  let garbleNext = false;
  let stallNext = false;

  const isOn = (project: Project, person: StandInPerson) =>
    project.owner.accountId === person.accountId ||
    project.guests.some((guest) => guest.accountId === person.accountId);
  const isOpen = (invitation: Invitation) =>
    now < invitation.sentAt + INVITATION_LIFETIME_MS;
  const invitationMessage = (project: Project, invitation: Invitation) => ({
    id: invitation.id,
    project_id: project.id,
    project_name: project.name,
    email: invitation.email,
    invited_by: personMessage(invitation.invitedBy),
    sent_at: moment(invitation.sentAt),
    expires_at: moment(invitation.sentAt + INVITATION_LIFETIME_MS),
  });
  const projectMessage = (project: Project): WireMessage => ({
    id: project.id,
    name: project.name,
    owner: personMessage(project.owner),
    guests: project.guests.map(personMessage),
    open_invitations: project.invitations
      .filter(isOpen)
      .map((invitation) => invitationMessage(project, invitation)),
    guest_limit: GUEST_LIMIT,
  });
  const found = (id: unknown) =>
    projects.get(String(id)) ?? refuse("no_such_project");
  const sharedWith = (id: unknown, person: StandInPerson) => {
    const project = found(id);
    return isOn(project, person) ? project : refuse("no_such_project");
  };
  const ownedBy = (
    id: unknown,
    person: StandInPerson,
    guestsAreTold: keyof typeof refusals,
  ) => {
    const project = sharedWith(id, person);
    return project.owner.accountId === person.accountId
      ? project
      : refuse(guestsAreTold);
  };

  const boards = standInBoardLogs({
    isOnProject: (id, person) => {
      const project = projects.get(id);
      return !!project && isOn(project, person);
    },
    now: () => now,
    refuse,
  });

  const cards = standInCards({
    isOnProject: (id, person) => {
      const project = projects.get(id);
      return !!project && isOn(project, person);
    },
    now: () => now,
    refuse,
  });

  const handlers: Record<
    keyof typeof ownerCalls,
    (request: WireMessage, caller: StandInPerson) => WireMessage
  > = {
    StartProject({ name }, caller) {
      const trimmed = String(name).trim();
      if (!trimmed || [...trimmed].length > 240 || /\p{Cc}/u.test(trimmed))
        refuse("invalid_project_name");
      const project: Project = {
        id: randomUUID(),
        name: trimmed,
        owner: caller,
        guests: [],
        invitations: [],
      };
      projects.set(project.id, project);
      return projectMessage(project);
    },
    ListProjects(_request, caller) {
      const mine = [...projects.values()].filter((project) =>
        isOn(project, caller),
      );
      mine.sort((left, right) => (left.name < right.name ? -1 : 1));
      return { projects: mine.map(projectMessage) };
    },
    GetProject({ project_id }, caller) {
      return projectMessage(sharedWith(project_id, caller));
    },
    InvitePerson({ project_id, email }, caller) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email)))
        refuse("invalid_email");
      const project = ownedBy(project_id, caller, "only_the_owner_invites");
      const address = String(email).toLowerCase();
      if (
        [project.owner, ...project.guests].some(
          (person) => person.email === address,
        )
      )
        refuse("already_on_project");
      const open = project.invitations.filter(isOpen);
      if (open.some((invitation) => invitation.email === address))
        refuse("already_invited");
      if (project.guests.length + open.length >= GUEST_LIMIT)
        refuse("guest_limit_reached");
      const invitation: Invitation = {
        id: randomUUID(),
        email: address,
        invitedBy: caller,
        sentAt: now,
      };
      project.invitations.push(invitation);
      return invitationMessage(project, invitation);
    },
    ListInvitations(_request, caller) {
      const waiting = [...projects.values()].flatMap((project) =>
        project.invitations
          .filter(
            (invitation) =>
              isOpen(invitation) && invitation.email === caller.email,
          )
          .map((invitation) => invitationMessage(project, invitation)),
      );
      return { invitations: waiting };
    },
    AcceptInvitation({ project_id, invitation_id }, caller) {
      const project = found(project_id);
      const invitation =
        project.invitations.find((sent) => sent.id === invitation_id) ??
        refuse("no_such_invitation");
      if (isOn(project, caller)) refuse("already_on_project");
      if (!isOpen(invitation)) refuse("invitation_expired");
      if (!caller.email) refuse("email_not_verified");
      if (caller.email !== invitation.email) refuse("no_such_invitation");
      project.invitations = project.invitations.filter(
        (sent) => sent !== invitation,
      );
      project.guests.push(caller);
      return projectMessage(project);
    },
    CancelInvitation({ project_id, invitation_id }, caller) {
      const project = ownedBy(project_id, caller, "not_the_owner");
      if (!project.invitations.some((sent) => sent.id === invitation_id))
        refuse("no_such_invitation");
      project.invitations = project.invitations.filter(
        (sent) => sent.id !== invitation_id,
      );
      return projectMessage(project);
    },
    RemoveGuest({ project_id, account_id }, caller) {
      const project = ownedBy(project_id, caller, "not_the_owner");
      if (!project.guests.some((guest) => guest.accountId === account_id))
        refuse("no_such_guest");
      project.guests = project.guests.filter(
        (guest) => guest.accountId !== account_id,
      );
      boards.recheckWatchers();
      cards.recheckWatchers();
      return projectMessage(project);
    },
    LeaveProject({ project_id }, caller) {
      const project = sharedWith(project_id, caller);
      if (project.owner.accountId === caller.accountId)
        refuse("the_owner_cannot_leave");
      project.guests = project.guests.filter(
        (guest) => guest.accountId !== caller.accountId,
      );
      boards.recheckWatchers();
      cards.recheckWatchers();
      return {};
    },
    DeleteProject({ project_id }, caller) {
      const deleted = ownedBy(project_id, caller, "not_the_owner").id;
      projects.delete(deleted);
      // A board goes with its project, and whoever watched it is told it is gone.
      boards.recheckWatchers();
      boards.forget(deleted);
      cards.recheckWatchers();
      cards.forget(deleted);
      return {};
    },
  };

  const framed = (message: Uint8Array) => {
    const frame = Buffer.alloc(5 + message.length);
    frame.writeUInt32BE(message.length, 1);
    frame.set(message, 5);
    return frame;
  };
  const turnDown = (stream: ServerHttp2Stream, refused: Refused) =>
    stream.respond(
      {
        ":status": 200,
        "content-type": "application/grpc",
        "grpc-status": String(refused.status),
        "grpc-message": encodeURIComponent(refused.message),
        ...(refused.rule ? { "memsync-refusal": refused.rule } : {}),
      },
      { endStream: true },
    );
  function answer(
    stream: ServerHttp2Stream,
    path: string,
    bearer: string,
    body: Buffer,
  ) {
    const method = path.split("/").at(-1) as keyof typeof ownerCalls;
    const token = bearer.replace(/^Bearer /, "");
    calls.push({ method, token });
    if (stallNext) return void (stallNext = false);
    try {
      const forced = turnAway.shift();
      if (forced) throw forced;
      const caller = signedIn.get(token);
      if (!caller || !bearer.startsWith("Bearer "))
        throw new Refused(grpcStatus.UNAUTHENTICATED);
      if (method in cardsCalls)
        return cards.answer(
          stream,
          method as keyof typeof cardsCalls,
          caller,
          body,
        );
      if (method in boardsCalls)
        return boards.answer(
          stream,
          method as keyof typeof boardsCalls,
          caller,
          body,
        );
      const call = ownerCalls[method];
      if (!call) throw new Refused(grpcStatus.UNIMPLEMENTED);
      const reply = handlers[method](
        decodeMessage(ownerContract, call.request, body.subarray(5)),
        caller,
      );
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () =>
        stream.sendTrailers({ "grpc-status": "0" }),
      );
      const sent = encodeMessage(ownerContract, call.reply, reply);
      stream.end(framed(garbleNext ? NEVER_A_MESSAGE : sent));
      garbleNext = false;
    } catch (problem) {
      if (!(problem instanceof Refused)) throw problem;
      turnDown(stream, problem);
    }
  }

  const server = createServer();
  const sessions = new Set<import("node:http2").ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    const parts: Buffer[] = [];
    stream.on("error", () => {});
    stream.on("data", (part: Buffer) => parts.push(part));
    stream.on("end", () =>
      answer(
        stream as ServerHttp2Stream,
        String(headers[":path"]),
        String(headers.authorization ?? ""),
        Buffer.concat(parts),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    address: new URL(`http://127.0.0.1:${port}`),
    calls,
    /** A token that signs this person in. A person signed in twice has two tokens. */
    tokenFor(person: StandInPerson): string {
      const token = randomBytes(24).toString("base64url");
      signedIn.set(token, person);
      return token;
    },
    /** Takes a token someone else issued as this person's, as MemSync takes memtrace.io's. */
    admit(token: string, person: StandInPerson) {
      signedIn.set(token, person);
    },
    expire(token: string) {
      signedIn.delete(token);
    },
    /** Days pass, which is how an invitation expires. */
    daysPass(days: number) {
      now += days * 86400000;
    },
    /** The next call is turned away as not signed in, whatever token it carries. */
    turnAwayNextCall() {
      turnAway.push(new Refused(grpcStatus.UNAUTHENTICATED));
    },
    /** The next call is turned down by a rule, as a newer MemSync might. */
    refuseNextCallBy(
      rule: string,
      status: number = grpcStatus.FAILED_PRECONDITION,
    ) {
      turnAway.push(new Refused(status, rule));
    },
    failNextCall(status: number) {
      turnAway.push(new Refused(status));
    },
    garbleNextReply() {
      garbleNext = true;
    },
    stallNextCall() {
      stallNext = true;
    },
    /** The board logs, with what a test may do to them. */
    boards,
    /** The card logs and files, with what a test may do to them. */
    cards,
    async close() {
      sessions.forEach((session) => session.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export type StandInMemsync = Awaited<ReturnType<typeof startStandInMemsync>>;
