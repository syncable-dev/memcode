import type { Contract } from "./wire";

/**
 * The part of projects.proto MemCode uses, written out by hand. A test reads
 * the .proto file beside this one and fails when the two disagree, so take a
 * newer contract by copying the file and following what the test says.
 */
const text = (number: number) => ({ number, kind: "string" }) as const;
const one = (number: number, message: string) =>
  ({ number, kind: { message } }) as const;
const many = (number: number, message: string) =>
  ({ number, kind: { message }, repeated: true }) as const;
const moment = "google.protobuf.Timestamp";

export const projectsService = "memsync.v1.Projects";

export const projectsContract = {
  [moment]: {
    seconds: { number: 1, kind: "int64" },
    nanos: { number: 2, kind: "int32" },
  },
  Person: { account_id: text(1), name: text(2), email: text(3) },
  Project: {
    id: text(1),
    name: text(2),
    owner: one(3, "Person"),
    guests: many(4, "Person"),
    open_invitations: many(5, "Invitation"),
    guest_limit: { number: 6, kind: "uint32" },
  },
  Invitation: {
    id: text(1),
    project_id: text(2),
    project_name: text(3),
    email: text(4),
    invited_by: one(5, "Person"),
    sent_at: one(6, moment),
    expires_at: one(7, moment),
  },
  ListProjectsRequest: {},
  ListProjectsResponse: { projects: many(1, "Project") },
  GetProjectRequest: { project_id: text(1) },
  ListInvitationsRequest: {},
  ListInvitationsResponse: { invitations: many(1, "Invitation") },
  AcceptInvitationRequest: { project_id: text(1), invitation_id: text(2) },
} satisfies Contract;

/** The calls MemCode makes. Starting, renaming, deleting and inviting happen at memtrace.io. */
export const projectsCalls = {
  ListProjects: {
    request: "ListProjectsRequest",
    reply: "ListProjectsResponse",
  },
  ListInvitations: {
    request: "ListInvitationsRequest",
    reply: "ListInvitationsResponse",
  },
  GetProject: { request: "GetProjectRequest", reply: "Project" },
  AcceptInvitation: { request: "AcceptInvitationRequest", reply: "Project" },
} as const;
export type ProjectsCall = keyof typeof projectsCalls;
