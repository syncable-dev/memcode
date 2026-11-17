import type { Harness, Message } from "./shared";

export const codeReviewPhases = [
  {
    id: "capture",
    label: "Changes",
    description: "Capture this story’s contribution",
  },
  { id: "review", label: "Review", description: "Check rules and correctness" },
  { id: "quality", label: "Quality", description: "Measure changed code" },
  {
    id: "impact",
    label: "Impact",
    description: "Trace affected code and flows",
  },
  {
    id: "verification",
    label: "Checks",
    description: "Link the actual verification",
  },
] as const;

export type CodeReviewPhaseId = (typeof codeReviewPhases)[number]["id"];
export type CodeReviewState =
  "queued" | "running" | "completed" | "cancelled" | "failed" | "stale";
export type CodeReviewOutcome =
  "changes-requested" | "ready" | "incomplete" | "not-applicable";
export interface ReviewWorkflowBinding {
  version: 1;
  codeReviewStatusId: string;
  acceptanceStatusId: string;
}
export interface CodeReviewSummary {
  runId: string;
  state: CodeReviewState;
  outcome?: CodeReviewOutcome;
  updatedAt: string;
  findingCount: number;
  phase?: CodeReviewPhaseId;
}
export type CodeReviewProvenance = "ast" | "yaml" | "cross_module" | "online";
export type CodeReviewEvidence =
  | null
  | boolean
  | number
  | string
  | CodeReviewEvidence[]
  | { [key: string]: CodeReviewEvidence };
export interface CodeReviewEngineAudit {
  reviewMode?: "strict" | "online";
  policy?: string;
  rawCount?: number;
  filteredCount?: number;
  maxCandidates?: number;
  sourceCounts?: Partial<Record<CodeReviewProvenance, number>>;
  detectors?: Record<
    string,
    {
      status: string;
      reason?: string;
      details?: CodeReviewEvidence;
      detailsTruncated?: boolean;
    }
  >;
}
export interface CodeReviewFinding {
  id: string;
  title: string;
  explanation: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category:
    "correctness" | "quality" | "maintainability" | "security" | "refactor";
  path?: string;
  line?: number;
  endLine?: number;
  checkpointId?: string;
  ruleId?: string;
  provenance?: CodeReviewProvenance;
  /** A graph finding can be located in an affected consumer, not authored here. */
  locationScope?: "story-change" | "affected-code";
  relatedCapturedPaths?: string[];
  /** Earlier saved runs may contain only the text representation. */
  evidence?: string;
  evidenceData?: CodeReviewEvidence;
  evidenceTruncated?: boolean;
  recommendation?: string;
}
export interface CodeReviewMetric {
  symbol: string;
  path: string;
  line?: number;
  cognitive: number | null;
  cyclomatic: number | null;
  nesting: number | null;
  maintainabilityIndex?: number | null;
  halsteadVolume?: number | null;
  riskLevel?: string;
  before?: {
    cognitive: number | null;
    cyclomatic: number | null;
    nesting: number | null;
  };
  source: "ast" | "estimated" | "unavailable";
}
export interface CodeReviewCheck {
  name: string;
  state: "passed" | "failed" | "unavailable";
  detail?: string;
  at?: string;
}
export interface StoryReviewRun {
  version: 1;
  id: string;
  taskId: string;
  implementationRunIds: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  state: CodeReviewState;
  outcome?: CodeReviewOutcome;
  note?: string;
  phases: Array<{
    id: CodeReviewPhaseId;
    state: "queued" | "running" | "complete" | "unavailable" | "failed";
    note?: string;
  }>;
  snapshot: {
    id: string;
    patchHash: string;
    journalRevision: string;
    branch: string;
    commit: string | null;
    sourceRevision: string | null;
    graphRevision: string | null;
    files: Array<{
      path: string;
      beforeHash?: string;
      afterHash?: string;
      attribution: "reservation" | "legacy" | "discontinuous";
    }>;
    additions: number;
    deletions: number;
  };
  engine: {
    version: string;
    rulesVersion?: string;
    audit?: CodeReviewEngineAudit;
  };
  coverage: { complete: boolean; limitations: string[] };
  findings: CodeReviewFinding[];
  metrics: CodeReviewMetric[];
  impact: {
    symbols: number | null;
    files: number | null;
    processes: number | null;
    complete: boolean;
    note?: string;
  };
  checks: CodeReviewCheck[];
  messages: Message[];
  reviewer?: {
    harness: Harness;
    model: string;
    state: "idle" | "running" | "unavailable";
    note?: string;
  };
}
export interface CodeReviewAPI {
  getCodeReview(taskId: string): Promise<StoryReviewRun | null>;
  startCodeReview(taskId: string): Promise<StoryReviewRun>;
  cancelCodeReview(taskId: string, runId: string): Promise<void>;
  sendCodeReviewMessage(
    taskId: string,
    runId: string,
    text: string,
  ): Promise<StoryReviewRun>;
  requestCodeReviewFixes(
    taskId: string,
    runId: string,
    findingIds: string[],
    text?: string,
  ): Promise<void>;
  acceptCodeReview(
    taskId: string,
    runId: string,
    reason?: string,
  ): Promise<void>;
}

export function codeReviewTitle(
  run: Pick<StoryReviewRun, "state" | "outcome"> | null,
): string {
  if (!run) return "Understand the change. Then move forward.";
  if (run.state === "queued") return "Your review is queued.";
  if (run.state === "running") return "A closer look at this story.";
  if (run.state === "stale") return "The code changed after this review.";
  if (run.state === "failed") return "The review needs attention.";
  if (run.state === "cancelled") return "The review was stopped.";
  return {
    "changes-requested": "A few things to resolve.",
    ready: "Ready for your final look.",
    incomplete: "There’s more to verify.",
    "not-applicable": "No source changes to review.",
  }[run.outcome ?? "incomplete"];
}

export function reviewIsBusy(
  run: Pick<StoryReviewRun, "state"> | null,
): boolean {
  return run?.state === "queued" || run?.state === "running";
}
