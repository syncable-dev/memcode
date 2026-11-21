import { z } from "zod";
import type { SharingSettings } from "../../src/sharing";
import type { NativeHost } from "../host";
import { sharingAddresses } from "./addresses";
import type { Sharing } from "./sharing";

type Register = (
  method: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;

const id = z.string().min(1).max(200);

/** What the Settings dialog may save for sharing. The addresses are checked on save. */
export const sharingSettingsSchema = z
  .object({ memsyncUrl: z.string().max(2000), tokenUrl: z.string().max(2000) })
  .strict();

/**
 * What a save of Settings leaves for sharing. A save that says nothing about
 * sharing keeps what was there, and two empty addresses take sharing away.
 * Throws a sentence for the person when an address cannot be used.
 */
export function sharingSettingsToKeep(
  sent: SharingSettings | undefined,
  kept: SharingSettings | undefined,
): SharingSettings | undefined {
  if (!sent) return kept;
  return sharingAddresses(sent) ? sent : undefined;
}

/** What the app's window may ask of sharing. */
export function registerSharing(
  register: Register,
  sharing: Sharing,
  host: NativeHost,
) {
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
  register(
    "sharing:keep-both",
    z.object({ projectId: id }).strict(),
    ({ projectId }) => sharing.keepBoth(projectId),
  );
  // Starting, renaming and deleting a project and inviting people happen at memtrace.io.
  register("sharing:manage", z.undefined(), () =>
    host.call("open_memcode_projects", {}),
  );
}
