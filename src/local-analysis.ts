/** Device-local diagnostics. Never included in Team planning or result publication. */
export const sourceChangedBeforePublication = (message?: string) =>
  typeof message === "string" &&
  message
    .toLowerCase()
    .includes("owned source changed after verification; refusing publication");

export const recoverablePublicationFailure = (message?: string) =>
  sourceChangedBeforePublication(message) ||
  message ===
    "Memtrace get_query_revision did not respond while inspecting the existing index." ||
  message ===
    "Memtrace source verification did not respond before its deadline." ||
  message?.startsWith(
    "Memtrace's startup graph has not finished verifying this checkout and branch.",
  ) === true ||
  /^Memtrace is still verifying the graph for .+ after an index write\. Retry to follow the existing graph\.$/.test(message ?? "") ||
  /^Memtrace job completed, but current source on branch .+ is not verified(?: \((?:branch_publication_incomplete|index_write_in_progress)\))?\. Retry to follow its publication; no duplicate index was queued\.$/.test(
    message ?? "",
  );

export type DiagnosticValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | { [key: string]: DiagnosticValue };
export type DiagnosticMetadata = Record<string, DiagnosticValue>;
export interface LocalAnalysisDiagnostics {
  sourcePublication: "verified" | "publishing" | "incomplete" | "unverified";
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
