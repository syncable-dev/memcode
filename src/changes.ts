import type { Harness } from "./shared";
export interface ChangeLine {
  kind: "context" | "add" | "delete";
  text: string;
  oldLine?: number;
  newLine?: number;
}
export interface ChangeHunk {
  oldStart: number;
  newStart: number;
  lines: ChangeLine[];
}
export interface ChangeFile {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: ChangeHunk[];
  beforeHash?: string;
  afterHash?: string;
}
export interface ChangeCheckpoint {
  id: string;
  runId: string;
  taskId: string;
  agentId: string;
  harness: Harness;
  branch: string;
  startedAt: string;
  at: string;
  basis: "fleet-reservation" | "scoped-baseline" | "native-edit" | "native-receipt";
  files: ChangeFile[];
}
export interface WorkerChanges {
  taskId: string;
  checkpoints: ChangeCheckpoint[];
  unverifiedEdits?: number;
  unverifiedRevision?: string;
  additions: number;
  deletions: number;
  files: number;
}
