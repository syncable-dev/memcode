import {
  projectsCalls,
  projectsContract,
  projectsService,
} from "../../runtime/sharing/memsync/projects-contract";
import { grpcChannel } from "../../runtime/sharing/memsync/grpc";
import {
  decodeMessage,
  encodeMessage,
  type Contract,
  type WireMessage,
} from "../../runtime/sharing/memsync/wire";

/**
 * What an owner does at memtrace.io, which MemCode itself never does: start a
 * project, invite, cancel, remove, delete. Tests need these to set a scene.
 * `sharing-wire.test.ts` checks these shapes against the .proto file too.
 */
const text = (number: number) => ({ number, kind: "string" }) as const;
export const ownerContract = {
  ...projectsContract,
  StartProjectRequest: { name: text(1) },
  InvitePersonRequest: { project_id: text(1), email: text(2) },
  CancelInvitationRequest: { project_id: text(1), invitation_id: text(2) },
  RemoveGuestRequest: { project_id: text(1), account_id: text(2) },
  DeleteProjectRequest: { project_id: text(1) },
  DeleteProjectResponse: {},
} satisfies Contract;
export const ownerCalls = {
  ...projectsCalls,
  StartProject: { request: "StartProjectRequest", reply: "Project" },
  InvitePerson: { request: "InvitePersonRequest", reply: "Invitation" },
  CancelInvitation: { request: "CancelInvitationRequest", reply: "Project" },
  RemoveGuest: { request: "RemoveGuestRequest", reply: "Project" },
  DeleteProject: {
    request: "DeleteProjectRequest",
    reply: "DeleteProjectResponse",
  },
} as const;

/** One signed-in person acting on the sharing service the way the website does. */
export function actingAs(address: URL, token: string) {
  const call = async (
    name: keyof typeof ownerCalls,
    request: WireMessage,
  ): Promise<WireMessage> => {
    const channel = grpcChannel(address);
    try {
      const reply = await channel.unary({
        path: `/${projectsService}/${name}`,
        request: encodeMessage(
          ownerContract,
          ownerCalls[name].request,
          request,
        ),
        metadata: { authorization: `Bearer ${token}` },
      });
      return decodeMessage(ownerContract, ownerCalls[name].reply, reply);
    } finally {
      channel.close();
    }
  };
  return {
    startProject: async (name: string) =>
      String((await call("StartProject", { name })).id),
    invite: async (projectId: string, email: string) =>
      String((await call("InvitePerson", { project_id: projectId, email })).id),
    cancelInvitation: (projectId: string, invitationId: string) =>
      call("CancelInvitation", {
        project_id: projectId,
        invitation_id: invitationId,
      }),
    removeGuest: (projectId: string, accountId: string) =>
      call("RemoveGuest", { project_id: projectId, account_id: accountId }),
    deleteProject: (projectId: string) =>
      call("DeleteProject", { project_id: projectId }),
  };
}
