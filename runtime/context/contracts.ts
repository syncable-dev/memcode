import { z } from "zod";
import type { Project } from "../../src/shared";

const common = {
  budgetChars: z.number().int().min(4000).max(48000).default(16000),
  continuation: z.string().max(100).optional(),
};
export const targetSchema = z
  .object({
    symbol: z.string().min(1).max(240),
    file: z.string().max(600).optional(),
  })
  .strict();
export const findSchema = z
  .object({
    ...common,
    query: z.string().min(1).max(1000),
    scope: z.string().max(600).optional(),
    mode: z.enum(["hybrid", "text"]).default("hybrid"),
    fallbackReason: z
      .enum(["exact-string", "generated-file", "incomplete-graph"])
      .optional(),
  })
  .strict();
export const understandSchema = z
  .object({
    ...common,
    target: targetSchema,
    question: z.string().max(1000).optional(),
  })
  .strict();
export const assessSchema = z
  .object({
    ...common,
    targets: z.array(targetSchema).min(1).max(4),
    change: z.enum(["implementation", "signature", "move", "remove", "export"]),
    intent: z.string().min(1).max(1000),
  })
  .strict();
export const requestSchema = z.discriminatedUnion("capability", [
  findSchema.extend({ capability: z.literal("find") }),
  understandSchema.extend({ capability: z.literal("understand") }),
  assessSchema.extend({ capability: z.literal("assess") }),
]);
export type ContextRequest = z.infer<typeof requestSchema>;
export interface GraphClient {
  call(
    project: Project,
    name: string,
    args: Record<string, unknown>,
  ): Promise<any>;
}
export interface ContextBinding {
  project: Project;
  /** Repository-wide accepted decisions stay shared while source facts are epic-local. */
  governanceProject?: Project;
  workerId: string;
  branch: string;
  /** Read visibility, not a filesystem write fence. Empty means the repository. */
  scope: string[];
}
export interface SourceRef {
  file: string;
  startLine: number;
  endLine: number;
  sha256: string;
}
export interface EvidenceItem {
  id: string;
  kind: "source" | "relationships" | "assessment" | "decision";
  handle?: { symbol: string; file: string; nodeId?: string };
  ref?: SourceRef;
  /** Literal source or literal tool JSON, never model-authored facts. */
  text: string;
  origin: string;
}
export interface Constraint {
  id: string;
  origin: string;
  text: string;
  ref?: SourceRef;
}
export interface SourceRevision {
  head: string;
  branch: string;
  dirty: boolean;
  fingerprint: string;
  files: number;
}
export interface ContextPack {
  version: 1;
  capability: ContextRequest["capability"];
  requestId: string;
  binding: {
    repoId: string;
    workerId: string;
    branch: string;
    scope: string[];
  };
  revision: SourceRevision & {
    graph: string | null;
    graphSource: string | null;
    graphReady: boolean;
    stable: boolean;
    constraintsDigest: string;
  };
  constraints: Constraint[];
  evidence: EvidenceItem[];
  candidates: Array<{
    symbol: string;
    file: string;
    line?: number;
    nodeId?: string;
  }>;
  coverage: {
    status: "partial" | "observed" | "ambiguous" | "constraints-pending";
    unknown: string[];
    truncated: string[];
    constraintsRemaining: number;
    continuation?: string;
    /** All constraints must be read before acting; Fleet authority stays in the host. */
    canAct: boolean;
  };
  telemetry: {
    cacheHit: boolean;
    durationMs: number;
    backendCalls: string[];
    fallback: { reason: string; scope: string; filesScanned: number } | null;
    localModel: {
      state: "disabled" | "not-requested" | "used" | "fallback";
      model?: string;
      note?: string;
      durationMs?: number;
      usage?: unknown;
      planQuery?: string;
      rankedIds?: string[];
    };
    responseChars: number;
    estimatedTokens: number;
    tokenMethod: "ceil(characters/4), not provider usage";
  };
}
