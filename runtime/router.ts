import { cursorCatalogValue } from "../src/cursor-models";
import { codexDefaultModel, cursorDefaultModel } from "../src/shared";
import { selectCodexModel } from "./agents/codex-models";
import { selectClaudeModel } from "./agents/claude-models";
import {
  supportsPermissionMode,
  effectivePermissionMode,
} from "../src/permissions";
import type {
  Evidence,
  Harness,
  HarnessRuntime,
  ModelTier,
  ReasoningEffort,
  RouteDecision,
  Settings,
  WorkItem,
} from "../src/shared";

const tierOrder: ModelTier[] = ["fast", "balanced", "frontier", "extreme"];
const effort: Record<ModelTier, ReasoningEffort> = {
  fast: "low",
  balanced: "medium",
  frontier: "high",
  extreme: "xhigh",
};
// Ported from the existing dogfood envelope-v2 policy. These are transparent,
// provisional thresholds, not calibrated probabilities or model benchmarks.
export const envelopes = [
  {
    tier: "fast" as const,
    cognitive: 15,
    cyclomatic: 12,
    nesting: 3,
    affected: 8,
    processes: 1,
    roots: 1,
  },
  {
    tier: "balanced" as const,
    cognitive: 90,
    cyclomatic: 75,
    nesting: 5,
    affected: 50,
    processes: 6,
    roots: 1,
  },
  {
    tier: "frontier" as const,
    cognitive: 300,
    cyclomatic: 180,
    nesting: 9,
    affected: 150,
    processes: 14,
    roots: 2,
  },
];
function maximum(values: Array<number | undefined>): number | null {
  const measured = values.filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  );
  return measured.length ? Math.max(...measured) : null;
}
function moduleRoot(file: string): string {
  const parts = file.replaceAll("\\", "/").split("/");
  const at = parts.findIndex((part) =>
    ["src", "electron", "tests", "scripts", "crates"].includes(part),
  );
  const local = at < 0 ? parts.slice(-2) : parts.slice(at);
  return local[1]?.includes(".") ? local[0] : local.slice(0, 2).join("/");
}
export function routingInputs(evidence?: Evidence): RouteDecision["inputs"] {
  const symbols = evidence?.symbols ?? [];
  return {
    cognitive: maximum(
      symbols.map((s) => (s.metricSource === "ast" ? s.cognitive : undefined)),
    ),
    cyclomatic: maximum(
      symbols.map((s) => (s.metricSource === "ast" ? s.cyclomatic : undefined)),
    ),
    nesting: maximum(symbols.map((s) => s.nesting)),
    affected: evidence?.affected ?? null,
    processes: evidence?.affectedProcesses ?? null,
    moduleRoots: new Set(symbols.map((s) => moduleRoot(s.file))).size,
    incomplete:
      !evidence || evidence.incomplete || evidence.state !== "measured",
    sourceRevision: evidence?.sourceRevision,
    graphRevision: evidence?.graphRevision,
  };
}
export function qualifyTier(input: RouteDecision["inputs"]): ModelTier {
  for (const envelope of envelopes) {
    if (
      envelope.tier === "fast" &&
      (input.incomplete ||
        input.cognitive === null ||
        input.cyclomatic === null ||
        input.nesting === null ||
        input.affected === null ||
        input.processes === null ||
        input.moduleRoots === 0)
    )
      continue;
    if (
      (input.cognitive === null || input.cognitive <= envelope.cognitive) &&
      (input.cyclomatic === null || input.cyclomatic <= envelope.cyclomatic) &&
      (input.nesting === null || input.nesting <= envelope.nesting) &&
      (input.affected === null || input.affected <= envelope.affected) &&
      (input.processes === null || input.processes <= envelope.processes) &&
      input.moduleRoots <= envelope.roots
    )
      return envelope.tier;
  }
  return "extreme";
}
function surface(
  task: WorkItem,
  evidence?: Evidence,
): "ui" | "backend" | "verification" {
  if (task.kind === "test") return "verification";
  const paths = [
    ...(task.scope ?? []),
    ...(evidence?.symbols.map((s) => s.file) ?? []),
  ];
  if (
    paths.some((path) => /(?:^|[/\\])tests?[/\\]|\.(?:test|spec)\./i.test(path))
  )
    return "verification";
  if (paths.some((path) => /\.(?:tsx|jsx|css|scss|html)$/i.test(path)))
    return "ui";
  return "backend";
}
function preferredHarness(
  tier: ModelTier,
  kind: ReturnType<typeof surface>,
): Harness {
  if (kind === "verification") return "codex";
  if (tier === "extreme") return "claude";
  if (kind === "ui") return "cursor";
  return tier === "balanced" ? "codex" : "claude";
}

export function assignedHarness(task: WorkItem, settings: Settings): Harness | undefined {
  if (settings.localModel) return "codex";
  if (settings.model && !task.modelOverride) return settings.defaultHarness;
  if (task.assignment !== "auto" || task.modelOverride) return task.harness;
}

export function planRoute(
  task: WorkItem,
  evidence: Evidence | undefined,
  runtimes: HarnessRuntime[],
  settings: Settings,
): RouteDecision {
  const inputs = routingInputs(evidence);
  const tier = qualifyTier(inputs);
  const reasons: string[] = [];
  if (inputs.cognitive !== null)
    reasons.push(
      `AST cognitive ${inputs.cognitive}; cyclomatic ${inputs.cyclomatic ?? "unknown"}; maximum nesting ${inputs.nesting ?? "unknown"}.`,
    );
  if (inputs.affected !== null)
    reasons.push(
      `${inputs.affected}${inputs.incomplete ? "+" : ""} observed affected symbols; ${inputs.processes ?? "unknown"} affected processes.`,
    );
  if (inputs.incomplete)
    reasons.push(
      "Evidence is incomplete. Missing values remain unknown; the fast tier is ineligible.",
    );
  const pinnedModel = task.modelOverride || settings.model;
  if (settings.localModel && !pinnedModel)
    throw new Error(
      "Enter an installed Ollama model name in Settings before enabling local-model routing.",
    );
  const requested = assignedHarness(task, settings);
  const manual = requested !== undefined;
  const wanted = requested ?? preferredHarness(tier, surface(task, evidence));
  const permissionMode = task.permissionMode;
  if (permissionMode === "auto")
    reasons.push(
      "Smart auto requires a harness with native automatic approval review; unsupported transports are excluded.",
    );
  if (
    manual &&
    !supportsPermissionMode(
      requested,
      effectivePermissionMode(task, settings, requested),
    )
  )
    throw new Error(
      "The assigned ACP connection does not support Smart auto. Choose Review or Full access, or select Codex or Claude Code.",
    );
  const ranked = [
    wanted,
    ...(["codex", "claude", "cursor", "copilot", "dsh"] as Harness[]).filter(
      (id) => id !== wanted,
    ),
  ];
  for (const id of ranked) {
    if (manual && id !== requested) continue;
    const candidateMode = effectivePermissionMode(task, settings, id);
    if (!supportsPermissionMode(id, candidateMode)) continue;
    const runtime = runtimes.find((r) => r.id === id && r.available);
    if (!runtime) continue;
    if (pinnedModel) {
      const cursorCatalog = id === "cursor";
      const selectedId = id === "codex" && !settings.localModel
        ? selectCodexModel(runtime, pinnedModel, false)
        : id === "claude" ? selectClaudeModel(runtime.models, pinnedModel, true)
        : cursorCatalog ? cursorCatalogValue(pinnedModel, runtime.models) : pinnedModel;
      if ((id === "copilot" || id === "dsh") && !runtime.models.some(model => model.id === selectedId))
        throw Error(`${runtime.name} does not advertise ${pinnedModel}. Refresh Workers and choose an available model.`);
      if (!selectedId)
        throw Error(`Cursor no longer offers ${pinnedModel}. Choose Match task complexity or another model in ${task.modelOverride ? "Worker assignment" : "Settings"}.`);
      const supportedEffort = cursorCatalog ? runtime.models.find((model) => model.id === selectedId)?.efforts?.[0] : undefined;
      reasons.push(
        settings.localModel
          ? "Explicit local-model override; capability is not inferred from its name."
          : "Explicit model override takes precedence over automatic selection.",
      );
      return {
        policyVersion: "memcode-envelope-v2",
        tier,
        harness: id,
        model: selectedId,
        modelLabel: runtime.models.find(model => model.id === selectedId || model.resolvedId === selectedId)?.label,
        effort: (["low","medium","high","xhigh"].includes(supportedEffort ?? "") ? supportedEffort : effort[tier]) as ReasoningEffort,
        mode: "manual",
        status: "provisional",
        inputs,
        reasons,
        plannedAt: new Date().toISOString(),
      };
    }
    const candidates = runtime.models
      .filter(
        (model) => model.tier && tierOrder.indexOf(model.tier) >= tierOrder.indexOf(tier),
      )
      .sort((a, b) =>
        tierOrder.indexOf(a.tier!) - tierOrder.indexOf(b.tier!) ||
        Number(!!b.isDefault) - Number(!!a.isDefault) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    let model = candidates[0];
    if (id === "codex" && !model) {
      if (runtime.allModelsDenied && !manual) continue;
      const selected = selectCodexModel(runtime, "", true, tier);
      model = runtime.models.find(m => m.id === selected) ?? { id: codexDefaultModel, label: codexDefaultModel, source: "cli" };
      reasons.push(selected ? "The measured tier is unavailable on this account. Codex will use an available model." : "The model catalog is unavailable. Codex will use its configured account default.");
    }
    if (id === "claude" && !model) {
      model = runtime.models.find(option => option.isDefault) ?? { id: "default", label: "Claude default", source: "cli" };
      reasons.push("Claude Code will use its configured default for this account.");
    }
    if (id === "cursor" && !model) {
      model = { id: cursorDefaultModel, label: cursorDefaultModel, source: "acp" };
      reasons.push("Cursor will use the current session’s configured model.");
    }
    if ((id === "copilot" || id === "dsh") && !model) {
      // New providers are uncalibrated. Use only their advertised default and
      // label it provisional, rather than infer capability from a model name.
      model = runtime.models.find(option => option.isDefault)!;
      if (model) reasons.push(`${runtime.name}'s advertised default is available; model capability is not yet calibrated against the measured envelope.`);
    }
    if (!model) continue;
    const desired = effort[tier];
    const level =
      model.efforts && !model.efforts.includes(desired)
        ? ((["xhigh", "high", "medium", "low"] as ReasoningEffort[]).find((e) =>
            model.efforts!.includes(e),
          ) ?? "medium")
        : desired;
    reasons.push(
      `${manual ? "The assigned harness" : id === wanted ? `The ${surface(task, evidence)} policy` : "The eligible-harness fallback"} selects ${runtime.name} / ${model.id} at ${level} effort.`,
    );
    return {
      policyVersion: "memcode-envelope-v2",
      tier,
      harness: id,
      model: model.id,
      modelLabel: model.label,
      effort: level,
      mode: manual ? "manual" : "automatic",
      status: inputs.incomplete || !candidates.length ? "provisional" : "measured",
      inputs,
      reasons,
      plannedAt: new Date().toISOString(),
    };
  }
  throw new Error(
    permissionMode === "auto" &&
      !runtimes.some(
        (r) =>
          r.available &&
          supportsPermissionMode(
            r.id,
            effectivePermissionMode(task, settings, r.id),
          ),
      )
      ? "No connected harness supports Smart auto. Connect Codex or Claude Code, or choose Review or Full access."
      : manual
        ? `The assigned worker is not connected or has no model for the ${tier} envelope. Connect it in Workers, choose Automatic, or choose an available model.`
        : "No eligible connected worker has a discovered model for this task. Connect a worker in Workers, then refresh its model catalog.",
  );
}
