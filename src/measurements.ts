import type { ReasoningEffort } from "./shared";

export type ModelMeasurementSource =
  | "codex-thread"
  | "codex-rerouted"
  | "claude-assistant"
  | "cursor-stop-hook"
  | "cursor-session"
  | "copilot-session"
  | "dsh-session";
export type UsageMeasurementSource =
  | "codex-thread-total"
  | "claude-model-total"
  | "claude-main-loop"
  | "cursor-stop-hook"
  | "cursor-acp";
/** Canonical counters. Input includes cache reads/writes; output includes reasoning.
 * Cache and reasoning counters are subsets, never additional totals.
 * Each observation replaces the previous cumulative snapshot for this pass. */
export interface ReportedTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  reasoningOutputTokens?: number | null;
  totalTokens?: number | null;
  scope: "attempt" | "main_loop";
  source: UsageMeasurementSource;
}
export interface AgentMeasurement {
  type: "measurement";
  model?: {
    id: string;
    source: ModelMeasurementSource;
    effort?: ReasoningEffort;
  };
  models?: string[];
  usage?: ReportedTokenUsage;
}
/** Device-local metadata. Public telemetry applies a separate model-ID allowlist. */
export interface WorkerMeasurements {
  modelId?: string;
  modelSource?: ModelMeasurementSource;
  effort?: ReasoningEffort;
  modelIds: string[];
  usage?: ReportedTokenUsage;
}
export interface WorkerCheckResult {
  runId: string;
  revision: string;
  sessionId: string;
  passed: number | null;
  failed: number | null;
  exitCode: number | null;
  source: "memcode_check";
  startedAt: string;
  finishedAt: string;
  linked: boolean;
  timedOut: boolean;
}
