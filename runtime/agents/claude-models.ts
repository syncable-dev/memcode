import type { ModelOption, ModelTier } from "../../src/shared";

const families: Record<string, ModelTier> = {
  haiku: "fast", sonnet: "balanced", opus: "frontier", fable: "extreme",
};

/** The installed account supplies the version; aliases never imply latest. */
export function claudeModelLabel(id: string, label: string, resolvedId?: string): string {
  const match = /^claude-(haiku|sonnet|opus|fable)-(\d+(?:[-.]\d{1,2})*)(?:-\d{8})?(?:\[.*\])?$/.exec(resolvedId ?? id);
  if (!match) return label;
  const family = match[1][0].toUpperCase() + match[1].slice(1);
  const version = match[2].replaceAll("-", ".");
  return /\d/.test(label) ? label : `${label === id || label.toLowerCase() === family.toLowerCase() ? family : label} ${version}`;
}

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
      id, label: claudeModelLabel(id, typeof row.displayName === "string" ? row.displayName : id, row.resolvedModel), tier: families[id], source: "cli", isDefault: id === "default",
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
