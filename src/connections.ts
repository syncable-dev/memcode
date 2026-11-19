import type { Harness } from "./shared";

export interface WorkerConnection {
  harness: Harness;
  approvedAt: string;
  runtimePath: string;
  /** Provider entry/installation identity; never the desktop's Node launcher. */
  runtimeIdentity?: string;
  auth: "authenticated" | "local";
  accountLabel?: string;
  scopeVersion: 1;
}
export interface WorkerConnectionStatus {
  harness: Harness;
  installed: boolean;
  connected: boolean;
  runtimePath: string | null;
  runtimeIdentity?: string;
  /** The explicit local permission remains saved even if discovery/auth is unavailable. */
  approvalSaved?: boolean;
  desktopAppPath?: string;
  auth: "authenticated" | "not-authenticated" | "unknown" | "local";
  accountLabel?: string;
  approvedAt?: string;
  note: string;
  loginCommand: string;
}

export function workerPathKey(path: string) {
  return /\\|^[a-z]:/i.test(path)
    ? path.replaceAll("\\", "/").toLowerCase()
    : path;
}

export function hasWorkerApproval(
  receipt: WorkerConnection | undefined,
  harness: Harness,
): receipt is WorkerConnection {
  return (
    !!receipt &&
    receipt.scopeVersion === 1 &&
    receipt.harness === harness &&
    typeof receipt.runtimePath === "string" &&
    !!receipt.runtimePath &&
    typeof receipt.approvedAt === "string" &&
    !!receipt.approvedAt &&
    ["authenticated", "local"].includes(receipt.auth)
  );
}

function bundledNode(path: string) {
  const normalized = workerPathKey(path);
  return (
    /^(?:\/Applications|\/Users\/[^/]+\/(?:Applications|Downloads)|\/Volumes\/MemCode(?: [^/]*)?|\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/[^/]+\/AppTranslocation\/[^/]+\/d)\/MemCode\.app\/Contents\/Resources\/desktop-runtime\/node$/.test(
      normalized,
    ) ||
    /^[a-z]:\/(?:program files(?: \(x86\))?\/memcode|users\/[^/]+\/appdata\/local\/(?:programs\/)?memcode)\/desktop-runtime\/node\.exe$/.test(
      normalized,
    )
  );
}

function providerEntry(harness: Harness, identity: string) {
  const path = workerPathKey(identity);
  return harness === "codex"
    ? /\/node_modules\/@openai\/codex\/bin\/codex\.js$/.test(path)
    : harness === "claude"
      ? /\/node_modules\/@anthropic-ai\/claude-code\/cli\.js$/.test(path)
      : path.startsWith("cursor-agent-install:") &&
        /\/cursor-agent$/.test(path);
}

/** Match saved permission to a provider, not the host app that launches it. */
export function workerApprovalMatches(
  receipt: WorkerConnection | undefined,
  runtime: { id: Harness; path: string | null; runtimeIdentity?: string },
) {
  if (!hasWorkerApproval(receipt, runtime.id) || !runtime.path) return false;
  const identity = runtime.runtimeIdentity ?? runtime.path;
  if (receipt.runtimeIdentity)
    return workerPathKey(receipt.runtimeIdentity) === workerPathKey(identity);
  // Old receipts bound directly launched CLIs to their executable path.
  if (workerPathKey(receipt.runtimePath) === workerPathKey(runtime.path))
    return true;
  // Beta.10 and earlier accidentally recorded MemCode's bundled Node for npm
  // workers. Migrate only known provider entries and known MemCode launchers.
  if (bundledNode(receipt.runtimePath) && providerEntry(runtime.id, identity))
    return true;
  if (runtime.id === "cursor" && identity.startsWith("cursor-agent-install:")) {
    const aliasHome = workerPathKey(receipt.runtimePath).match(
      /^(\/.+)\/\.local\/bin\/(?:agent|cursor-agent)$/,
    )?.[1];
    if (
      aliasHome &&
      workerPathKey(identity) ===
        "cursor-agent-install:" + aliasHome + "/.local/share/cursor-agent"
    )
      return true;
    const previous = workerPathKey(receipt.runtimePath).match(
      /^(.*\/cursor-agent)\/versions\/[^/]+\/node(?:\.exe)?$/,
    )?.[1];
    return (
      !!previous &&
      workerPathKey(identity) === "cursor-agent-install:" + previous
    );
  }
  return false;
}
export interface MemtracePrincipal {
  id: string;
  name: string;
  source: "memtrace";
}
export interface MemtraceAccount {
  status: "connected" | "needs-sign-in" | "unavailable" | "unknown";
  /** A valid existing CLI session, even before a project owner is running. */
  sessionVerified?: boolean;
  label: string;
  detail: string;
  checkedAt?: string;
  principal?: MemtracePrincipal;
  organizationId?: string;
  loginPending: boolean;
  claimUrl?: string;
  authMode?: "session" | "environment";
  sessionAction?: "signing-out" | "switching" | "signing-in";
  signedOut?: boolean;
  reconnectRequired?: boolean;
  /** Environment variable names only. Values never enter renderer state. */
  managedBy?: string[];
}
