import type { Harness, Message } from "./shared";
import type { StoryAuthor } from "./story-comments";

export const codeReviewPhases = [
  {
    id: "capture",
    label: "Changes",
    description: "Capture this task’s contribution",
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
  /** Runtime digest of the saved detector evidence; never a native confidence score. */
  evidenceHash?: string;
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
export const codeReviewDismissalReasons = [
  { id: "false-positive", label: "False positive" },
  { id: "accepted-risk", label: "Accepted risk" },
  { id: "not-applicable", label: "Not applicable" },
  { id: "already-addressed", label: "Already addressed" },
  { id: "other", label: "Other reason" },
] as const;
export type CodeReviewDismissalReason =
  (typeof codeReviewDismissalReasons)[number]["id"];
export interface CodeReviewFindingDisposition {
  id: string;
  findingId: string;
  status: "dismissed" | "reopened";
  reason?: CodeReviewDismissalReason;
  explanation?: string;
  at: string;
  actor: StoryAuthor;
  snapshotId: string;
  patchHash: string;
  evidenceHash: string;
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
    source?: "ast" | "unavailable";
    cognitive: number | null;
    cyclomatic: number | null;
    nesting: number | null;
    maintainabilityIndex?: number | null;
    halsteadVolume?: number | null;
    line?: number;
  };
  comparison?: {
    status: "matched" | "added" | "removed" | "ambiguous" | "unavailable";
    reason?: string;
    beforeSourceHash?: string;
    afterSourceHash?: string;
    metricsVersion?: number;
    qualityMetricsVersion?: number;
  };
  source: "ast" | "estimated" | "unavailable";
}
export interface CodeReviewCheck {
  name: string;
  state: "passed" | "failed" | "unavailable";
  detail?: string;
  at?: string;
}
export interface CodeReviewComparisonCoverage {
  filesMeasured: number;
  filesUnavailable: number;
  omittedFiles: number;
  omittedFunctions: number;
  notes: string[];
}
export type ReviewFileAttribution = "reservation" | "native-edit" | "verified-edits" | "legacy" | "discontinuous";
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
      attribution: ReviewFileAttribution;
      /** Own journal hashes stay intact when later disjoint peer edits are present. */
      projection?: {
        method: "unique-exact-context";
        baselineHash: string;
        currentHash: string;
        hunks: number;
        journalSegments?: number;
      };
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
  /** Human decisions are per-run audit events; detector findings remain intact. */
  findingDispositions?: CodeReviewFindingDisposition[];
  metrics: CodeReviewMetric[];
  qualityComparison?: CodeReviewComparisonCoverage;
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
  startCodeReview(taskId: string): Promise<StoryReviewRun | null>;
  cancelCodeReview(taskId: string, runId: string): Promise<void>;
  dismissCodeReviewFinding(
    taskId: string,
    runId: string,
    findingId: string,
    reason: CodeReviewDismissalReason,
    explanation: string,
  ): Promise<StoryReviewRun>;
  reopenCodeReviewFinding(
    taskId: string,
    runId: string,
    findingId: string,
  ): Promise<StoryReviewRun>;
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

/** Only the latest decision bound to this exact snapshot and evidence applies. */
export function reviewFindingDisposition(
  run: Pick<StoryReviewRun, "findings" | "findingDispositions" | "snapshot">,
  findingId: string,
): CodeReviewFindingDisposition | undefined {
  const finding = run.findings.find((item) => item.id === findingId);
  if (!finding?.evidenceHash) return undefined;
  const events = run.findingDispositions ?? [];
  for (let index = events.length - 1; index >= 0; index--) {
    const item = events[index];
    if (
      item !== null &&
      typeof item === "object" &&
      item.findingId === findingId &&
      item.snapshotId === run.snapshot.id &&
      item.patchHash === run.snapshot.patchHash &&
      item.evidenceHash === finding.evidenceHash &&
      typeof item.id === "string" &&
      typeof item.at === "string" &&
      !!item.actor &&
      typeof item.actor.id === "string" &&
      typeof item.actor.name === "string" &&
      (item.actor.source === "local" || item.actor.source === "memtrace") &&
      (item.status !== "dismissed" ||
        (codeReviewDismissalReasons.some(
          (reason) => reason.id === item.reason,
        ) &&
          typeof item.explanation === "string" &&
          item.explanation.trim().length > 0 &&
          item.explanation.length <= 2000)) &&
      (item.status === "dismissed" || item.status === "reopened")
    )
      return item;
  }
  return undefined;
}

export function activeCodeReviewFindings(
  run: Pick<StoryReviewRun, "findings" | "findingDispositions" | "snapshot">,
): CodeReviewFinding[] {
  return run.findings.filter(
    (finding) =>
      reviewFindingDisposition(run, finding.id)?.status !== "dismissed",
  );
}

export function codeReviewTitle(
  run: Pick<StoryReviewRun, "state" | "outcome"> | null,
): string {
  if (!run) return "Understand the change. Then move forward.";
  if (run.state === "queued") return "Your review is queued.";
  if (run.state === "running") return "A closer look at this task.";
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
