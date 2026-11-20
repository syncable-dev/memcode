import type {
  AgentMeasurement,
  ReportedTokenUsage,
  WorkerMeasurements,
} from "../../src/measurements";
import type { Harness } from "../../src/shared";

const count = (n: unknown): number | null =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 1e9
    ? n
    : null;
const modelId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id);
const modelSources = {
  codex: ["codex-thread", "codex-rerouted"],
  claude: ["claude-assistant"],
  cursor: ["cursor-stop-hook", "cursor-session"],
  copilot: ["copilot-session"],
  dsh: ["dsh-session"],
};
const usageSources = {
  codex: ["codex-thread-total"],
  claude: ["claude-model-total", "claude-main-loop"],
  cursor: ["cursor-stop-hook", "cursor-acp"],
  copilot: [] as string[],
  dsh: [] as string[],
};

export function applyAgentMeasurement(
  previous: WorkerMeasurements | undefined,
  event: AgentMeasurement,
  harness: Harness,
): WorkerMeasurements {
  const result: WorkerMeasurements = previous
    ? { ...previous, modelIds: [...previous.modelIds] }
    : { modelIds: [] };
  if (
    event.model &&
    modelSources[harness].includes(event.model.source) &&
    modelId(event.model.id)
  ) {
    result.modelId = event.model.id;
    result.modelSource = event.model.source;
    if (["low", "medium", "high", "xhigh"].includes(event.model.effort ?? ""))
      result.effort = event.model.effort;
    else delete result.effort;
  }
  result.modelIds = [
    ...new Set(
      [
        ...result.modelIds,
        ...(event.model ? [event.model.id] : []),
        ...(event.models ?? []),
      ].filter(modelId),
    ),
  ].slice(0, 16);
  const usage = event.usage;
  if (
    usage &&
    usageSources[harness].includes(usage.source) &&
    ["attempt", "main_loop"].includes(usage.scope) &&
    !(
      result.usage?.scope === "attempt" &&
      usage.scope === "main_loop" &&
      result.usage.source !== usage.source
    )
  ) {
    const normalized: ReportedTokenUsage = {
      inputTokens: count(usage.inputTokens),
      outputTokens: count(usage.outputTokens),
      cachedInputTokens: count(usage.cachedInputTokens),
      cacheCreationInputTokens: count(usage.cacheCreationInputTokens),
      reasoningOutputTokens: count(usage.reasoningOutputTokens),
      totalTokens: count(usage.totalTokens),
      scope: usage.scope,
      source: usage.source,
    };
    // A malformed or unrelated event must not replace a useful observation.
    if (normalized.inputTokens !== null || normalized.outputTokens !== null) {
      if (normalized.inputTokens !== null) {
        if (
          normalized.cachedInputTokens !== null &&
          normalized.cachedInputTokens > normalized.inputTokens
        )
          normalized.cachedInputTokens = null;
        if (
          normalized.cacheCreationInputTokens !== null &&
          normalized.cacheCreationInputTokens > normalized.inputTokens
        )
          normalized.cacheCreationInputTokens = null;
      }
      if (
        normalized.outputTokens !== null &&
        normalized.reasoningOutputTokens != null &&
        normalized.reasoningOutputTokens > normalized.outputTokens
      )
        normalized.reasoningOutputTokens = null;
      if (
        normalized.totalTokens !== null &&
        normalized.inputTokens !== null &&
        normalized.outputTokens !== null &&
        normalized.totalTokens !==
          normalized.inputTokens + normalized.outputTokens
      )
        normalized.totalTokens = null;
      result.usage = normalized;
    }
  }
  return result;
}
