import { createHash } from "node:crypto";
import { cursorCatalogValue } from "../src/cursor-models";
import {
  codexDefaultModel,
  cursorDefaultModel,
  harnessIds,
} from "../src/shared";
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
  ModelOption,
  ModelTier,
  ReasoningEffort,
  RouteDecision,
  Settings,
  WorkItem,
} from "../src/shared";
import { analyzeRoutingIntent } from "./routing-intent";
import type { RoutingRequestSignals } from "../src/routing-signals";
import {
  estimateRoutingCandidates,
  selectCalibratedCandidate,
  type RoutingCalibration,
} from "./routing-calibration";

const tierOrder: ModelTier[] = ["fast", "balanced", "frontier", "extreme"];
const effort: Record<ModelTier, ReasoningEffort> = {
  fast: "low",
  balanced: "medium",
  frontier: "high",
  extreme: "xhigh",
};
const effortOrder = Object.values(effort);
const reliabilityTarget = {
  fast: 0.8,
  balanced: 0.85,
  frontier: 0.9,
  extreme: 0.95,
};
const rank = (tier?: ModelTier) => (tier ? tierOrder.indexOf(tier) : -1);
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
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
    targets: 2,
    files: 4,
    modules: 1,
  },
  {
    tier: "balanced" as const,
    cognitive: 90,
    cyclomatic: 75,
    nesting: 5,
    affected: 50,
    processes: 6,
    roots: 1,
    targets: 5,
    files: 20,
    modules: 4,
  },
  {
    tier: "frontier" as const,
    cognitive: 300,
    cyclomatic: 180,
    nesting: 9,
    affected: 150,
    processes: 14,
    roots: 2,
    targets: 8,
    files: 70,
    modules: 12,
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
    ["src", "runtime", "src-tauri", "tests", "scripts", "crates"].includes(
      part,
    ),
  );
  const local = at < 0 ? parts.slice(-2) : parts.slice(at);
  return local[1]?.includes(".") ? local[0] : local.slice(0, 2).join("/");
}
export function routingInputs(
  evidence?: Evidence,
  request?: RoutingRequestSignals,
): RouteDecision["inputs"] {
  const symbols = evidence?.symbols ?? [];
  const ast = symbols.filter((symbol) => symbol.metricSource === "ast");
  return {
    cognitive: maximum(ast.map((s) => s.cognitive)),
    cyclomatic: maximum(ast.map((s) => s.cyclomatic)),
    nesting: maximum(ast.map((s) => s.nesting)),
    affected: evidence?.affected ?? null,
    processes: evidence?.affectedProcesses ?? null,
    moduleRoots: new Set(symbols.map((s) => moduleRoot(s.file))).size,
    incomplete:
      !evidence ||
      evidence.incomplete ||
      evidence.state !== "measured" ||
      !!evidence.scopeCoverage?.incomplete ||
      (!!evidence.impact?.incomplete && !request?.readOnly),
    sourceRevision: evidence?.sourceRevision,
    graphRevision: evidence?.graphRevision,
    ...(request ? { request } : {}),
    ...(evidence?.scopeCoverage ? { scope: evidence.scopeCoverage } : {}),
    ...(evidence?.impact ? { impact: evidence.impact } : {}),
  };
}

const within = (observed: number | null | undefined, limit: number) =>
  observed == null || observed <= limit;

function taskTiers(input: RouteDecision["inputs"]) {
  const workTier: ModelTier =
    envelopes.find(
      (envelope) =>
        within(input.cognitive, envelope.cognitive) &&
        within(input.cyclomatic, envelope.cyclomatic) &&
        within(input.nesting, envelope.nesting) &&
        within(input.scope?.confirmedTargets, envelope.targets) &&
        input.moduleRoots <= envelope.roots,
    )?.tier ?? "extreme";

  const impactTier: ModelTier | null = input.request?.readOnly
    ? null
    : (envelopes.find(
        (envelope) =>
          (input.request?.publicContract !== "change" ||
            envelope.tier === "frontier") &&
          (!input.scope?.publicContracts || envelope.tier !== "fast") &&
          within(input.affected, envelope.affected) &&
          within(input.processes, envelope.processes) &&
          within(input.impact?.affectedFiles, envelope.files) &&
          within(input.impact?.affectedModules, envelope.modules),
      )?.tier ?? "extreme");

  const complete =
    !input.incomplete &&
    input.cognitive !== null &&
    input.cyclomatic !== null &&
    input.nesting !== null &&
    input.moduleRoots > 0 &&
    (impactTier === null ||
      (input.affected !== null && input.processes !== null));
  const tier =
    tierOrder[
      Math.max(complete ? 0 : 1, rank(workTier), rank(impactTier ?? undefined))
    ];
  return { tier, workTier, impactTier, complete };
}

export function qualifyTier(input: RouteDecision["inputs"]): ModelTier {
  return taskTiers(input).tier;
}
function surface(
  task: WorkItem,
  evidence: Evidence | undefined,
  request: RoutingRequestSignals,
): "ui" | "backend" | "verification" {
  if (
    task.kind === "test" ||
    (request.kinds.length === 1 && request.kinds[0] === "test")
  )
    return "verification";
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

const storyAssignment = (task: WorkItem) =>
  task.assignment !== "auto" || !!task.modelOverride;

export function assignedHarness(
  task: WorkItem,
  settings: Settings,
): Harness | undefined {
  if (storyAssignment(task)) return task.harness;
  if (settings.localModel) return "codex";
  if (settings.model) return settings.defaultHarness;
}

function explicitModel(task: WorkItem, settings: Settings, local: boolean) {
  if (task.modelOverride) return task.modelOverride;
  if (local || !storyAssignment(task)) return settings.model || undefined;
}

type Configuration = {
  runtime: HarnessRuntime;
  model: ModelOption;
  effort: ReasoningEffort;
  effortBound: boolean;
};

function supportedEfforts(model: ModelOption, tier: ModelTier) {
  const advertised = effortOrder.filter((level) =>
    model.efforts?.includes(level),
  );
  return advertised.length ? advertised : [effort[tier]];
}

function configurations(
  runtime: HarnessRuntime,
  model: ModelOption,
  tier: ModelTier,
): Configuration[] {
  return supportedEfforts(model, tier).map((level) => ({
    runtime,
    model,
    effort: level,
    effortBound:
      runtime.id !== "dsh" &&
      (runtime.id !== "cursor" || !!model.efforts?.includes(level)) &&
      ![codexDefaultModel, cursorDefaultModel, "default"].includes(model.id),
  }));
}

function matchExplicitModel(
  runtime: HarnessRuntime,
  model: string,
  local: boolean,
): ModelOption {
  if (local) return { id: model, label: model, source: "alias" };
  const id = runtime.id;
  if (id === "codex" && model === codexDefaultModel)
    return { id: model, label: model, source: "cli" };
  const selected =
    id === "codex"
      ? selectCodexModel(runtime, model, false)
      : id === "claude"
        ? selectClaudeModel(runtime.models, model, true)
        : id === "cursor"
          ? cursorCatalogValue(model, runtime.models)
          : model;
  const offered = runtime.models.find(
    (option) => option.id === selected || option.resolvedId === selected,
  );
  if (offered && selected) return { ...offered, id: selected };
  throw Error(
    id === "cursor"
      ? `Cursor no longer offers ${model}. Choose Match task complexity or another model in Worker assignment or Settings.`
      : `${runtime.name} does not advertise ${model}. Refresh Workers and choose an available model.`,
  );
}

function defaults(runtime: HarnessRuntime): ModelOption[] {
  const advertised = runtime.models.filter((model) => model.isDefault);
  if (advertised.length) return advertised;
  if (runtime.id === "codex")
    return [{ id: codexDefaultModel, label: codexDefaultModel, source: "cli" }];
  if (runtime.id === "claude")
    return [{ id: "default", label: "Claude default", source: "cli" }];
  if (runtime.id === "cursor")
    return [
      { id: cursorDefaultModel, label: cursorDefaultModel, source: "acp" },
    ];
  return [];
}

function fingerprint(
  runtimes: HarnessRuntime[],
  task: WorkItem,
  settings: Settings,
) {
  const catalog = runtimes
    .map((runtime) => [
      runtime.id,
      effectivePermissionMode(task, settings, runtime.id),
      !!runtime.allModelsDenied,
      runtime.models
        .map((model) => [
          model.id,
          model.resolvedId,
          model.tier,
          !!model.isDefault,
          model.source,
          [...new Set(model.efforts)].sort(compareText),
        ])
        .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))),
    ])
    .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

function describeInputs(inputs: RouteDecision["inputs"]): string[] {
  const reasons: string[] = [];
  const request = inputs.request;
  if (request) {
    const kinds = request.kinds.filter((kind) => kind !== "unknown");
    if (kinds.length) reasons.push(`Request intent · ${kinds.join(", ")}.`);
    if (request.fileScopeOnly)
      reasons.push("The brief limits edits to its named scope.");
    if (request.preserveBehavior)
      reasons.push("The brief asks to preserve behavior.");
    if (request.publicContract === "change")
      reasons.push(
        "A requested public contract change raises the impact tier.",
      );
    if (request.publicContract === "preserve")
      reasons.push("The brief asks to preserve the public contract.");
  }
  if (inputs.scope) {
    const { confirmedTargets, inferredTargets, unresolvedReferences } =
      inputs.scope;
    reasons.push(
      `Source targets · ${confirmedTargets} confirmed, ${inferredTargets} inferred, ${unresolvedReferences} unresolved.`,
    );
  }
  if (inputs.cognitive !== null)
    reasons.push(
      `AST maxima · cognitive ${inputs.cognitive}, cyclomatic ${inputs.cyclomatic ?? "unknown"}, nesting ${inputs.nesting ?? "unknown"}.`,
    );
  if (request?.readOnly)
    reasons.push(
      "This request is read-only. Source complexity informs the route.",
    );
  else if (inputs.impact) {
    const impact = inputs.impact;
    const count = (unit: string, value?: number) => {
      const amount =
        value === undefined
          ? "unknown"
          : `${value}${impact.incomplete ? "+" : ""}`;
      return `${amount} ${unit}${value === 1 && !impact.incomplete ? "" : "s"}`;
    };
    reasons.push(
      `Observed impact across ${impact.observedTargets} of ${impact.targetCount} ${impact.basis} targets · ${count("symbol", impact.affectedSymbols)}, ${count("file", impact.affectedFiles)}, ${count("flow", impact.affectedProcesses)}.`,
    );
  } else if (inputs.affected !== null)
    reasons.push(
      `${inputs.affected}${inputs.incomplete ? "+" : ""} observed affected symbols, ${inputs.processes ?? "unknown"} affected processes.`,
    );
  if (inputs.incomplete)
    reasons.push(
      "Evidence is partial. Missing values remain unknown and the fast tier is ineligible.",
    );
  return reasons;
}

export function planRoute(
  task: WorkItem,
  evidence: Evidence | undefined,
  runtimes: HarnessRuntime[],
  settings: Settings,
  calibration?: RoutingCalibration,
): RouteDecision {
  const request = analyzeRoutingIntent(task).signals;
  const inputs = routingInputs(evidence, request);
  const { tier, workTier, impactTier, complete } = taskTiers(inputs);
  const reasons = describeInputs(inputs);
  const requested = assignedHarness(task, settings);
  const local = requested === "codex" && settings.localModel;
  const pinned = explicitModel(task, settings, local);
  if (local && !pinned?.trim())
    throw Error(
      "Enter an installed Ollama model name in Settings before enabling local-model routing.",
    );

  const permissionSupported = (id: Harness) =>
    supportsPermissionMode(id, effectivePermissionMode(task, settings, id));
  if (requested && !permissionSupported(requested))
    throw Error(
      "The assigned ACP connection does not support Smart auto. Choose Review or Full access, or select Codex or Claude Code.",
    );
  const approved = runtimes.filter(
    (runtime) =>
      runtime.available && !!runtime.path && permissionSupported(runtime.id),
  );
  const eligible = approved.filter(
    (runtime) => !requested || requested === runtime.id,
  );
  const pickedRuntime = requested
    ? eligible.find((runtime) => runtime.id === requested)
    : undefined;
  if (pickedRuntime?.allModelsDenied && !local)
    throw Error(
      `${pickedRuntime.name} rejected every model advertised for this account. Refresh Workers or choose another harness.`,
    );

  const wanted = preferredHarness(tier, surface(task, evidence, request));
  const harnessRank = (id: Harness) =>
    id === wanted
      ? -2
      : id === settings.defaultHarness
        ? -1
        : harnessIds.indexOf(id);
  const desired = effortOrder.indexOf(effort[tier]);
  const effortDistance = (level: ReasoningEffort) => {
    const delta = effortOrder.indexOf(level) - desired;
    return delta >= 0 ? delta : effortOrder.length - delta;
  };
  const effortFit = (option: Configuration) =>
    option.effortBound ? effortDistance(option.effort) : 0;
  const compare = (a: Configuration, b: Configuration) =>
    effortFit(a) - effortFit(b) ||
    harnessRank(a.runtime.id) - harnessRank(b.runtime.id) ||
    Number(!!b.model.isDefault) - Number(!!a.model.isDefault) ||
    compareText(a.model.id, b.model.id);

  const active = eligible.filter(
    (runtime) => !runtime.allModelsDenied || local,
  );
  const advertised = active.flatMap((runtime) =>
    runtime.models.flatMap((model) => configurations(runtime, model, tier)),
  );
  const ranked = advertised.filter(({ model }) => !!model.tier);
  const provisioned = active.flatMap((runtime) =>
    defaults(runtime).flatMap((model) => configurations(runtime, model, tier)),
  );
  const matches = ranked
    .filter(({ model }) => rank(model.tier) >= rank(tier))
    .sort((a, b) => rank(a.model.tier) - rank(b.model.tier) || compare(a, b));
  const below = ranked
    .filter(({ model }) => rank(model.tier) < rank(tier))
    .sort((a, b) => rank(b.model.tier) - rank(a.model.tier) || compare(a, b));
  const byPolicy = matches[0] ?? below[0] ?? provisioned.sort(compare)[0];
  const explicit =
    pinned && pickedRuntime
      ? configurations(
          pickedRuntime,
          matchExplicitModel(pickedRuntime, pinned, local),
          tier,
        ).sort(compare)[0]
      : undefined;

  // A calibrated route requires model-specific effort and a provider that can
  // confirm the selected configuration before the first prompt.
  const calibratedOptions =
    calibration && !pinned && !local
      ? advertised
          .filter(
            ({ runtime, model, effort, effortBound }) =>
              effortBound &&
              model.efforts?.includes(effort) &&
              (runtime.id === "codex" ||
                runtime.id === "claude" ||
                runtime.id === "cursor"),
          )
          .map((option) => {
            const { runtime, model, effort } = option;
            const cursorVariant =
              runtime.id === "cursor" && model.id.includes("[")
                ? model.id.split("[", 1)[0]
                : undefined;
            return {
              option,
              candidate: {
                harness: runtime.id,
                model: model.id,
                effort,
                resolvedModel: model.resolvedId ?? cursorVariant,
              },
            };
          })
      : [];
  const candidates = calibratedOptions.map((row) => row.candidate);
  const kinds = request.kinds.filter((kind) => kind !== "unknown");
  const cohort = {
    kind: kinds.length > 1 ? "mixed" : (kinds[0] ?? "unknown"),
    tier,
    coverage: complete ? ("measured" as const) : ("partial" as const),
  };
  const target = reliabilityTarget[tier];
  const estimate =
    calibration && candidates.length
      ? selectCalibratedCandidate(
          estimateRoutingCandidates(calibration, cohort, candidates),
          candidates,
          target,
        )
      : undefined;
  const calibrated = estimate
    ? calibratedOptions.find(
        ({ candidate }) =>
          candidate.harness === estimate.candidate.harness &&
          candidate.model === estimate.candidate.model &&
          candidate.resolvedModel === estimate.candidate.resolvedModel &&
          candidate.effort === estimate.candidate.effort,
      )?.option
    : undefined;
  const selected = explicit ?? calibrated ?? byPolicy;
  if (!selected)
    throw Error(
      task.permissionMode === "auto" && !approved.length
        ? "No connected harness supports Smart auto. Connect Codex or Claude Code, or choose Review or Full access."
        : requested
          ? `The assigned worker is not connected or has no model for the ${tier} envelope. Connect it in Workers, choose Automatic, or choose an available model.`
          : "No eligible connected worker has a discovered model for this task. Connect a worker in Workers, then refresh its model catalog.",
    );

  const { runtime, model, effort: level, effortBound } = selected;
  const method = explicit
    ? "explicit"
    : calibrated
      ? "calibration"
      : matches.length
        ? "envelope"
        : "fallback";
  if (explicit)
    reasons.push(
      local
        ? "The configured Ollama model runs locally through Codex."
        : task.modelOverride
          ? "The story’s model override takes precedence."
          : "The workspace model override applies to this automatic story.",
    );
  else if (requested && storyAssignment(task))
    reasons.push(`The story’s assignment limits routing to ${runtime.name}.`);
  if (calibrated && estimate)
    reasons.push(
      `Controlled trials met the ${Math.round(target * 100)}% reliability target for this cohort. ${estimate.samples} matched outcomes across ${estimate.repositories} repositories.`,
    );
  else if (method === "envelope")
    reasons.push(
      `The ${tier} envelope was compared across the eligible catalog.`,
    );
  else if (method === "fallback")
    reasons.push(
      `The eligible catalog has no ranked model that meets the ${tier} envelope. This is a provisional fallback.`,
    );
  reasons.push(
    `${runtime.name} / ${model.label}${effortBound ? ` at ${level} effort` : " with provider-configured effort"}.`,
  );
  return {
    policyVersion: "memcode-evidence-v3",
    tier,
    harness: runtime.id,
    model: model.id,
    modelLabel: model.label,
    effort: level,
    ...(local ? { localModel: true as const } : {}),
    mode: requested ? "manual" : "automatic",
    status:
      !complete || method === "explicit" || method === "fallback"
        ? "provisional"
        : "measured",
    inputs,
    reasons,
    plannedAt: new Date().toISOString(),
    selection: {
      method,
      catalogFingerprint: fingerprint(eligible, task, settings),
      eligibleConfigurations: explicit
        ? 1
        : new Set(
            [...advertised, ...provisioned].map(({ runtime, model, effort }) =>
              JSON.stringify([runtime.id, model.id, effort]),
            ),
          ).size,
      effortBound,
      workTier,
      impactTier,
      ...(calibrated && calibration && estimate
        ? {
            calibrationDigest: calibration.digest,
            calibratedModel:
              estimate.candidate.resolvedModel ?? estimate.candidate.model,
          }
        : {}),
    },
  };
}
