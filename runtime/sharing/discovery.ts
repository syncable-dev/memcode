import type { SharingSettings } from "../../src/sharing";
import { BETA_ORIGIN } from "../beta-auth";

/**
 * Where MemCode finds the sharing service: in memtrace.io's list of MemCode
 * services, the same list Team Sync reads, under `sharing`. A list without it
 * means sharing is not offered, and MemCode shows no Share button.
 *
 * For tests and a local demo only, two environment variables name local
 * servers instead. No screen offers them.
 */
export const DEVELOPER_SHARING_SERVICE = "MEMCODE_DEV_SHARING_SERVICE",
  DEVELOPER_SHARING_TOKEN_ADDRESS = "MEMCODE_DEV_SHARING_TOKEN_ADDRESS";
const SERVICES_PATH = "/api/memcode/services";
const LONGEST_LIST = 16 * 1024,
  KEPT_FOR_MS = 60_000;

export interface SharingFinderOptions {
  fetcher?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
}

async function readList(fetcher: typeof fetch): Promise<unknown> {
  // Public: nothing about the person or their projects is sent.
  const response = await fetcher(BETA_ORIGIN + SERVICES_PATH, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`The service list answered ${response.status}.`);
  const text = await response.text();
  if (text.length > LONGEST_LIST)
    throw new Error("The service list is too long.");
  return JSON.parse(text);
}

/** The sharing addresses in a service list, or nothing when sharing is not offered. */
export function sharingInList(list: unknown): SharingSettings | undefined {
  const read = list as { version?: unknown; sharing?: unknown } | null;
  if (!read || read.version !== 1)
    throw new Error("The service list is not one MemCode reads.");
  if (read.sharing === undefined || read.sharing === null) return undefined;
  const sharing = read.sharing as {
    endpoint?: unknown;
    tokenEndpoint?: unknown;
  };
  if (
    typeof sharing.endpoint !== "string" ||
    typeof sharing.tokenEndpoint !== "string"
  )
    throw new Error(
      "The service list names sharing without its two addresses.",
    );
  return { memsyncUrl: sharing.endpoint, tokenUrl: sharing.tokenEndpoint };
}

/** Finds the sharing service when asked, at most once a minute. */
export function sharingFinder(options: SharingFinderOptions = {}) {
  const fetcher = options.fetcher ?? fetch,
    environment = options.environment ?? process.env,
    now = options.now ?? Date.now;
  let kept: { until: number; value: SharingSettings | undefined } | undefined;
  let finding: Promise<SharingSettings | undefined> | undefined;
  return (): Promise<SharingSettings | undefined> => {
    const service = environment[DEVELOPER_SHARING_SERVICE],
      tokenAddress = environment[DEVELOPER_SHARING_TOKEN_ADDRESS];
    if (service && tokenAddress)
      return Promise.resolve({ memsyncUrl: service, tokenUrl: tokenAddress });
    if (kept && kept.until > now()) return Promise.resolve(kept.value);
    finding ??= readList(fetcher)
      .then(sharingInList)
      .catch((problem) => {
        console.error(
          "[sharing] The sharing service could not be found:",
          problem,
        );
        return undefined;
      })
      .then((value) => {
        kept = { until: now() + KEPT_FOR_MS, value };
        return value;
      })
      .finally(() => {
        finding = undefined;
      });
    return finding;
  };
}
