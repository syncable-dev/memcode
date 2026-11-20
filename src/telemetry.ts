import { z } from "zod";
import { publicModelIds } from "./public-models";

/** A versioned allowlist, never a channel for custom-model names or project text. */
export const telemetryModels = [
  "gpt-6-luna",
  "gpt-5.6-luna",
  "gpt-6.1-terra",
  "gpt-5.6-terra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-5.6-sol",
  "gpt-6-astra",
  "composer-2.5",
  "grok-4.7-high",
  "grok-4.7-xhigh",
  "haiku",
  "sonnet",
  "opus",
  "fable",
  "other",
] as const;
const count = z.number().int().min(0).max(10_000_000);
const nullableCount = count.nullable();
const harness = z.enum(["codex", "claude", "cursor", "copilot", "dsh"]);
const model = z.enum(telemetryModels);
const effort = z.enum(["low", "medium", "high", "xhigh"]);
const ref = z.string().uuid();
const common = {
  appVersion: z
    .string()
    .max(64)
    .regex(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/,
    ),
  eventId: ref,
  occurredAt: z.string().max(40).datetime(),
  workspaceRef: ref,
  projectRef: ref.nullable(),
};
export const telemetryEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...common,
      type: z.literal("attempt.started"),
      attemptRef: ref,
      storyRef: ref,
      pass: z.enum(["initial", "followup"]),
      historyComplete: z.boolean(),
      harness,
      requestedModel: model,
      requestedEffort: effort,
      routeMode: z.enum(["auto", "manual"]),
      policy: z.enum(["memcode-envelope-v2", "unknown"]),
      tier: z.enum(["fast", "balanced", "frontier", "extreme"]).nullable(),
      evidence: z
        .object({
          state: z.enum(["measured", "partial", "unknown"]),
          cognitive: nullableCount,
          cyclomatic: nullableCount,
          nesting: z.number().int().min(0).max(10000).nullable(),
          affectedSymbols: nullableCount,
          affectedProcesses: nullableCount,
          affectedFiles: nullableCount,
          symbolCount: nullableCount,
          declaredScopeCount: nullableCount,
          moduleRoots: nullableCount,
          impactLowerBound: z.boolean().nullable(),
          alignment: z.enum(["aligned", "not_aligned", "unknown"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("attempt.finished"),
      attemptRef: ref,
      storyRef: ref,
      processOutcome: z.enum([
        "exited",
        "failed",
        "stopped",
        "blocked",
        "interrupted",
      ]),
      durationMs: z.number().int().min(0).max(604800000).nullable(),
      exitCode: z.number().int().min(-2147483648).max(2147483647).nullable(),
      reportedHarness: harness.nullable(),
      reportedModel: model.nullable(),
      reportedEffort: effort.nullable(),
      reportedModelId: z.enum(publicModelIds).nullable().optional(),
      reportedModelIds: z.array(z.enum(publicModelIds)).max(16).optional(),
      reportedModels: z.array(model).max(16).optional(),
      reportedModelSource: z
        .enum([
          "codex-thread",
          "codex-rerouted",
          "claude-assistant",
          "cursor-stop-hook",
          "cursor-session",
          "copilot-session",
          "dsh-session",
        ])
        .nullable()
        .optional(),
      usage: z
        .object({
          inputTokens: z.number().int().min(0).max(1e9).nullable(),
          outputTokens: z.number().int().min(0).max(1e9).nullable(),
          cachedInputTokens: z.number().int().min(0).max(1e9).nullable(),
          cacheCreationInputTokens: z
            .number()
            .int()
            .min(0)
            .max(1e9)
            .nullable()
            .optional(),
          reasoningOutputTokens: z
            .number()
            .int()
            .min(0)
            .max(1e9)
            .nullable()
            .optional(),
          totalTokens: z.number().int().min(0).max(2e9).nullable().optional(),
          scope: z.enum(["attempt", "main_loop"]).optional(),
          source: z
            .enum([
              "codex-thread-total",
              "claude-model-total",
              "claude-main-loop",
              "cursor-stop-hook",
              "cursor-acp",
            ])
            .optional(),
        })
        .strict()
        .nullable(),
      verification: z
        .object({
          passed: nullableCount,
          failed: nullableCount,
          source: z.enum(["tool_reported", "memcode_check"]),
          exitCode: z
            .number()
            .int()
            .min(-2147483648)
            .max(2147483647)
            .nullable()
            .optional(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("story.review"),
      storyRef: ref,
      attemptRef: ref.nullable(),
      decision: z.enum(["accepted", "reopened"]),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("entity.lifecycle"),
      entity: z.enum(["project", "story", "epic", "cycle"]),
      entityRef: ref,
      action: z.enum(["created", "deleted", "completed", "reopened"]),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("planning.snapshot"),
      scope: z.literal("local_workspace"),
      counts: z
        .object({
          projects: count,
          stories: count,
          epics: count,
          cycles: count,
          doneStories: count,
          activeCycles: count,
        })
        .strict(),
    })
    .strict(),
]);
export const telemetryBatchSchema = z
  .object({
    version: z.literal(1),
    channel: z.enum(["production", "test"]),
    events: z.array(telemetryEventSchema).min(1).max(50),
  })
  .strict();
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;
export interface TelemetryStatus {
  enabled: boolean;
  eligible: boolean;
  excluded: boolean;
  pending: number;
  sent: number;
  lastUploadedAt: string | null;
  state:
    | "off"
    | "waiting-for-account"
    | "queued"
    | "sending"
    | "idle"
    | "unavailable"
    | "excluded";
}
