import { createHash } from "node:crypto";
import { codexDefaultModel, type ModelOption, type ModelTier } from "../../src/shared";
import { commandIdentity, type Command } from "../commands";

type Json = Record<string, any>;
type Request = (method: string, params: Json) => Promise<Json>;
export interface CodexCatalog {
  scope?: string;
  models: ModelOption[];
  allModelsDenied?: boolean;
}

const denied = new Map<string, Map<string, number>>();
export let codexCatalogGeneration = 0;
const tiers: ModelTier[] = ["fast", "balanced", "frontier", "extreme"];
const families: Record<string, ModelTier> = { luna: "fast", terra: "balanced", sol: "frontier", astra: "extreme" };

/** Filter only a model-specific provider refusal. Transport, quota, tool and
 * authentication failures do not imply that a model has disappeared. */
export function recordCodexModelFailure(catalog: CodexCatalog, model: string, error: unknown): boolean {
  if (!catalog.scope || !model || model === codexDefaultModel) return false;
  const detail = error instanceof Error ? error.message : JSON.stringify(error) ?? "";
  if (!/\bmodel_not_found\b|\bmodel\b.{0,180}(?:not supported when using Codex|does not exist or you do not have access to it|not available for (?:your|this) account)/is.test(detail))
    return false;
  const scoped = denied.get(catalog.scope) ?? new Map<string, number>();
  if ((scoped.get(model) ?? 0) > Date.now()) return true;
  scoped.set(model, Date.now() + 60 * 60_000);
  denied.set(catalog.scope, scoped);
  codexCatalogGeneration++;
  return true;
}

export async function readCodexCatalog(command: Command, env: NodeJS.ProcessEnv, request: Request): Promise<CodexCatalog> {
  try {
    const { account } = await request("account/read", { refreshToken: false });
    if (!account?.type) return { models: [] };
    const identity = account.id || account.email || (account.type === "apiKey" && (env.CODEX_API_KEY || env.OPENAI_API_KEY));
    const scope = identity ? createHash("sha256").update(JSON.stringify([
      commandIdentity(command), env.CODEX_HOME ?? "", account.type, identity, account.planType ?? "",
    ])).digest("hex") : undefined;
    const scoped = scope ? denied.get(scope) : undefined;
    let cursor: string | null = null;
    const seen = new Set<string>(), pages = new Set<string>(), models: ModelOption[] = [];
    do {
      const page: Json = await request("model/list", { includeHidden: false, limit: 100, cursor });
      if (!Array.isArray(page.data)) return { scope, models: [] };
      for (const row of page.data) {
        const id = row?.model;
        if (typeof id !== "string" || !id || row.hidden === true || seen.has(id)) continue;
        seen.add(id);
        if ((scoped?.get(id) ?? 0) > Date.now()) continue;
        scoped?.delete(id);
        const family = id.split("-").at(-1) ?? "";
        models.push({ id, label: row.displayName || id, tier: families[family],
          source: "cli", isDefault: row.isDefault === true,
          efforts: Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map((e: Json) => e.reasoningEffort).filter((e: unknown) => typeof e === "string") : undefined });
      }
      cursor = page.nextCursor || null;
      if (cursor && (pages.has(cursor) || pages.size >= 10)) return { scope, models: [] };
      if (cursor) pages.add(cursor);
    } while (cursor);
    return { scope, models, allModelsDenied: seen.size > 0 && !models.length };
  } catch {
    return { models: [] };
  }
}

/** A saved preference expresses user intent; a model logged on an earlier
 * automatic run is only a preference and can legitimately go out of scope. */
export function selectCodexModel(catalog: CodexCatalog, requested: string, automatic: boolean, tier?: ModelTier): string {
  const { models } = catalog;
  if (catalog.allModelsDenied) throw Error("Codex rejected every model advertised for this account. Check your Codex account or select another worker.");
  if (requested && requested !== codexDefaultModel && models.some(m => m.id === requested)) return requested;
  if (requested && requested !== codexDefaultModel && !automatic)
    throw Error(`Codex cannot confirm access to ${requested} for this account. Choose Match task complexity or an available model.`);
  const ranked = tier ? models.filter(m => m.tier && tiers.indexOf(m.tier) >= tiers.indexOf(tier))
    .sort((a, b) => tiers.indexOf(a.tier!) - tiers.indexOf(b.tier!)) : [];
  return ranked[0]?.id ?? models.find(m => m.isDefault)?.id ?? models[0]?.id ?? "";
}
