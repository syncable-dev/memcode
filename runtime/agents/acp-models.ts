import type { ModelOption } from "../../src/shared";
import type { AgentMeasurement } from "../../src/measurements";

type Json = Record<string, any>;
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.filter(row => row && typeof row === "object") : [];
const configs = (session: Json) => rows(session.configOptions);
const modelConfig = (session: Json) => configs(session).find(option => option.category === "model" || option.id === "model");
function choices(option?: Json, group?: string): Json[] {
  return rows(option?.options).flatMap((row) => {
    if (Array.isArray(row.options)) {
      const nextGroup =
        typeof row.name === "string"
          ? row.name
          : typeof row.group === "string"
            ? row.group
            : group;
      return choices(row, nextGroup);
    }
    const leafGroup = typeof row.group === "string" ? row.group : group;
    return [leafGroup !== undefined ? { ...row, group: leafGroup } : row];
  });
}

/** Opaque ACP IDs come from this installed provider. No guessed model names. */
export function standardACPCatalog(session: Json): ModelOption[] {
  const option = modelConfig(session);
  const current = option?.currentValue ?? session.models?.currentModelId;
  const offered = option
    ? choices(option).map((row) => ({
        id: row.value,
        label: row.name ?? row.label,
        group: row.group,
      }))
    : rows(session.models?.availableModels).map((row) => ({
        id: row.modelId,
        label: row.name,
        group: row.group,
      }));
  const seen = new Set<string>();
  return offered.flatMap((row) => {
    if (typeof row.id !== "string" || !row.id || row.id.length > 256 || seen.has(row.id)) return [];
    seen.add(row.id);
    const group = typeof row.group === "string" && row.group ? row.group : undefined;
    return [{
      id: row.id,
      label: typeof row.label === "string" ? row.label : row.id,
      ...(group ? { group } : {}),
      source: "acp" as const,
      isDefault: row.id === current,
    }];
  });
}

export async function selectStandardACPModel(session: Json, requested: string,
  request: (method: string, params: Json) => Promise<Json>, brand: string,
): Promise<{ config: Json[]; legacyModel?: string; alternative?: string }> {
  let config = configs(session);
  const option = modelConfig(session);
  let current = option?.currentValue ?? session.models?.currentModelId;
  if (!requested || requested === current) return { config, legacyModel: current };
  if (!standardACPCatalog(session).some(model => model.id === requested))
    throw Error(`${brand} does not offer ${requested} in this session. Refresh Workers and select an available model.`);
  if (option) {
    const result = await request("session/set_config_option", { sessionId: session.sessionId, configId: option.id, value: requested });
    config = configs(result);
    if (!config.some(row => row.id === option.id && row.currentValue === requested))
      throw Error(`${brand} did not confirm the selected model.`);
  } else {
    await request("session/set_model", { sessionId: session.sessionId, modelId: requested });
    current = requested;
  }
  return { config, legacyModel: current };
}

export function standardModelMeasurement(id: "copilot" | "dsh", config: Json[], current?: string): AgentMeasurement | undefined {
  let value = modelConfig({ configOptions: config })?.currentValue ?? current;
  if (typeof value !== "string" || !value || value.length > 256 || /^(auto|default)$/i.test(value)) return;
  if (id === "dsh") {
    try {
      const route = JSON.parse(value);
      if (Array.isArray(route) && route.length === 2 && route.every(part => typeof part === "string")) value = route[1];
    } catch { /* Some DSH providers expose a plain opaque model ID. */ }
  }
  return { type: "measurement", model: { id: value, source: `${id}-session` }, models: [value] };
}
