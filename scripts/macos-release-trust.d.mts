export interface MacReleasePolicy {
  mode: "public-release" | "private-candidate" | "manual-approval-beta";
  publicReady: false;
  manualApprovalRequired?: boolean;
  betaDistributionAllowed?: boolean;
  teamId?: string;
  identity?: string;
  authentication?: "api-key" | "apple-id";
}
export function macReleasePolicy(
  env?: Record<string, string | undefined>,
): MacReleasePolicy;
export function assertPublicMacTrust<T>(proof: T): T;
/** Native binaries in the bundled `dist-*` folders, other than Node, to sign for public release. */
export function bundledLibrariesToSign(root: string): Promise<string[]>;
/** Records signed files' fingerprints in their folder's provenance.json, keeping the unsigned ones. */
export function recordSignedFiles(root: string, signed: string[]): Promise<void>;
