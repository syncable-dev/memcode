import { z } from "zod";
import type { Sharing } from "./sharing";

type Register = (
  method: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;

const id = z.string().min(1).max(200);

/** What the app's window may ask of sharing. */
export function registerSharing(register: Register, sharing: Sharing) {
  register("sharing:overview", z.undefined(), () => sharing.overview());
  register(
    "sharing:accept-invitation",
    z.object({ projectId: id, invitationId: id }).strict(),
    (input) => sharing.acceptInvitation(input),
  );
  register(
    "sharing:connect",
    z.object({ projectId: id, sharedProjectId: id }).strict(),
    (input) => sharing.connect(input),
  );
  register(
    "sharing:disconnect",
    z.object({ projectId: id }).strict(),
    ({ projectId }) => sharing.disconnect(projectId),
  );
  const task = z.object({ taskId: id }).strict();
  register("sharing:follow-card", task, ({ taskId }) =>
    sharing.followCard(taskId),
  );
  register("sharing:unfollow-card", task, ({ taskId }) =>
    sharing.unfollowCard(taskId),
  );
  register(
    "sharing:share-result",
    z.object({ taskId: id, artifactId: id }).strict(),
    (input) => sharing.shareResult(input),
  );
  register(
    "sharing:decide-message",
    z.object({ taskId: id, messageId: id, allow: z.boolean() }).strict(),
    (input) => sharing.decideMessage(input),
  );
  register(
    "sharing:open-result",
    z.object({ taskId: id, resultId: id }).strict(),
    (input) => sharing.openSharedResult(input),
  );
  const project = z.object({ projectId: id }).strict();
  register("sharing:inbox", project, ({ projectId }) =>
    sharing.inbox(projectId),
  );
  register(
    "sharing:link-slack",
    z
      .object({ projectId: id, code: z.string().trim().min(8).max(20) })
      .strict(),
    (input) => sharing.linkSlackChannel(input),
  );
  register(
    "sharing:unlink-slack",
    z.object({ projectId: id, teamId: id, channelId: id }).strict(),
    (input) => sharing.unlinkSlackChannel(input),
  );
  register(
    "sharing:decide-inbox-item",
    z
      .object({
        projectId: id,
        itemId: id,
        decision: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("picked_up"),
              goal: id,
              goalTitle: z.string().max(500),
            })
            .strict(),
          z
            .object({ kind: z.literal("declined"), reason: z.string().max(2000) })
            .strict(),
          z.object({ kind: z.literal("reopened") }).strict(),
        ]),
      })
      .strict(),
    (input) => sharing.decideInboxItem(input),
  );
  register(
    "sharing:inbox-file",
    z
      .object({ projectId: id, sha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict(),
    (input) => sharing.inboxFile(input),
  );
  register("sharing:share", project, ({ projectId }) =>
    sharing.shareProject(projectId),
  );
  register(
    "sharing:invite",
    z
      .object({ projectId: id, email: z.string().trim().min(3).max(320) })
      .strict(),
    (input) => sharing.invite(input),
  );
  register(
    "sharing:cancel-invitation",
    z.object({ projectId: id, invitationId: id }).strict(),
    (input) => sharing.cancelInvitation(input),
  );
  register(
    "sharing:remove-person",
    z.object({ projectId: id, personId: id }).strict(),
    (input) => sharing.removePerson(input),
  );
  register("sharing:leave", project, ({ projectId }) =>
    sharing.leave(projectId),
  );
  register(
    "sharing:open",
    z.object({ sharedProjectId: id }).strict(),
    ({ sharedProjectId }) => sharing.openShared(sharedProjectId),
  );
  register(
    "sharing:join",
    z.object({ sharedProjectId: id, invitationId: id }).strict(),
    (input) => sharing.join(input),
  );
}
