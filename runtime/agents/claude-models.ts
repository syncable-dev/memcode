import type { ModelOption, ModelTier } from "../../src/shared";

const families: Record<string, ModelTier> = {
  haiku: "fast", sonnet: "balanced", opus: "frontier", fable: "extreme",
};

export function claudeCatalog(rows: unknown): ModelOption[] {
  if (!Array.isArray(rows)) return [];
  const models: ModelOption[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row?.value;
    if (typeof id !== "string" || !id || ids.has(id)) continue;
    ids.add(id);
    // Rank aliases first. Versioned variants stay available for deliberate selection.
    models.push({
      id, label: row.displayName || id, tier: families[id], source: "cli", isDefault: id === "default",
      resolvedId: typeof row.resolvedModel === "string" ? row.resolvedModel : undefined,
      efforts: Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels.filter((e: unknown) => typeof e === "string") : undefined,
    });
  }
  return models;
}

export function selectClaudeModel(models: ModelOption[], requested: string, pinned: boolean): string {
  if (requested && models.some(model => model.id === requested || model.resolvedId === requested)) return requested;
  if (pinned && requested) throw Error(`Claude Code cannot confirm access to ${requested}. Choose Match task complexity or an available model.`);
  return "default";
}
