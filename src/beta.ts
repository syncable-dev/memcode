/** Public status only. Access/refresh credentials never cross into the renderer. */
export interface MemCodeBetaStatus {
  state:
    "disconnected" | "connecting" | "connected" | "expired" | "unavailable";
  accessMode: "beta" | "installed-cli";
  detail: string;
  account?: { id: string; name: string; email?: string };
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  termsVersion?: string;
  loginPending: boolean;
  connectionPhase?: "starting" | "browser" | "finishing";
  canCancel?: boolean;
  revocationPending?: boolean;
}
