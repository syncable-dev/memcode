import type { SharingSettings } from "../../src/sharing";
import { BETA_ORIGIN } from "../beta-auth";

/** The two places sharing talks to, checked and ready to use. */
export interface SharingAddresses {
  memsync: URL;
  tokenEndpoint: URL;
}

const thisComputer = ["localhost", "127.0.0.1", "[::1]"];

function webAddress(typed: string, what: string): URL {
  let address: URL;
  try {
    address = new URL(typed);
  } catch {
    throw new Error(`${what} is not a web address. Start it with https://.`);
  }
  if (
    !["http:", "https:"].includes(address.protocol) ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new Error(
      `${what} must be a plain https:// address, without a sign-in, a question mark or a # part.`,
    );
  return address;
}

const encryptedOrLocal = (address: URL) =>
  address.protocol === "https:" || thisComputer.includes(address.hostname);

/**
 * Reads where sharing lives from the settings. Null means sharing is not set up.
 * Throws a sentence for the person when an address cannot be used.
 */
export function sharingAddresses(
  settings: SharingSettings | undefined,
): SharingAddresses | null {
  const memsyncUrl = settings?.memsyncUrl.trim() ?? "",
    tokenUrl = settings?.tokenUrl.trim() ?? "";
  if (!memsyncUrl && !tokenUrl) return null;
  if (!memsyncUrl || !tokenUrl)
    throw new Error(
      "Sharing needs both addresses: the sharing service and the sign-in address. Enter both, or leave both empty.",
    );
  const memsync = webAddress(memsyncUrl, "The sharing service address");
  // Every call carries an access token, and the service itself speaks unencrypted HTTP/2.
  if (!encryptedOrLocal(memsync))
    throw new Error(
      "The sharing service address must start with https://. Plain http:// works only for a service on this computer.",
    );
  const tokenEndpoint = webAddress(tokenUrl, "The sign-in address for sharing");
  // The only sign-in MemCode holds is a memtrace.io one. It is shown to nobody else.
  if (
    tokenEndpoint.origin !== BETA_ORIGIN &&
    !thisComputer.includes(tokenEndpoint.hostname)
  )
    throw new Error(
      `MemCode shows your Memtrace sign-in only to ${new URL(BETA_ORIGIN).host}. The sign-in address for sharing must be there, or on this computer.`,
    );
  return { memsync, tokenEndpoint };
}
