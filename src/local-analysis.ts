/** Device-local diagnostics. Never included in Team planning or result publication. */
export const sourceChangedBeforePublication = (message?: string) =>
  typeof message === "string" &&
  message
    .toLowerCase()
    .includes("owned source changed after verification; refusing publication");

export type DiagnosticValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | { [key: string]: DiagnosticValue };
export type DiagnosticMetadata = Record<string, DiagnosticValue>;
export interface LocalAnalysisDiagnostics {
  sourcePublication: "verified" | "incomplete" | "unverified";
  platform: string;
  project: {
    name: string;
    path: string | null;
    branch: string;
    analysis: string;
    note?: string;
    repoId?: string;
  };
  scope: {
    mode: "workspace" | "project";
    dataDirectory: string;
    workspaceFile?: string;
  } | null;
  repoMetadata: DiagnosticMetadata | null;
  indexRevision: DiagnosticMetadata | null;
  watch: DiagnosticMetadata[];
  jobs: DiagnosticMetadata[];
  /** Filtered, redacted certificate messages from this project's current owned engine only. */
  engineDiagnostics?: string[];
  failures: Array<{ operation: string; reason: string; timeout: boolean }>;
  capturedAt: string;
}
