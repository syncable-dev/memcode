import type { ModelOption, ModelTier } from "./shared";

type Json = Record<string, any>;
const array = (value: unknown): Json[] => Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** ACP advertises canonical variant values, unlike the CLI's shorthand aliases. */
export function cursorModelValue(
  requested: string,
  choices: Json[],
): string | undefined {
  const flat = choices.flatMap((choice) =>
    Array.isArray(choice.options) ? array(choice.options) : [choice],
  );
  const exact = flat.find((choice) => choice.value === requested);
  if (exact) return text(exact.value);
  const byName = flat.filter(
    (choice) => text(choice.name).toLowerCase() === requested.toLowerCase(),
  );
  if (byName.length === 1) return text(byName[0].value);
  const fast = requested.endsWith("-fast"),
    withoutFast = requested.replace(/-fast$/, "");
  const effort = /^(.*)-(low|medium|high|xhigh|max|none)$/.exec(withoutFast);
  const base = (effort?.[1] ?? withoutFast).replace(/^cursor-(?=grok-)/, "");
  const matches = flat.filter((choice) => {
    const value = text(choice.value),
      match = /^([^\[]+)\[([^\]]*)\]$/.exec(value);
    if (
      !match ||
      (match[1] !== base && !(base === "auto" && match[1] === "default"))
    )
      return false;
    const parameters = Object.fromEntries(
      match[2]
        .split(",")
        .filter(Boolean)
        .map((entry) => entry.split("=")),
    );
    return (
      (!fast || parameters.fast === "true") &&
      (!effort ||
        [
          parameters.effort,
          parameters.reasoning,
          parameters.reasoning_effort,
        ].includes(effort[2]))
    );
  });
  return matches.length === 1 ? text(matches[0].value) : undefined;
}

/** Both revisions of ACP announce session-specific model choices. */
export function cursorChoices(session: Json): Json[] {
  const config = array(session.configOptions).find((item) => item.category === "model" || item.id === "model");
  if (config) return array(config.options).flatMap((item) => Array.isArray(item.options) ? array(item.options) : [item]);
  return array(session.models?.availableModels).map((item) => ({ value: item.modelId, name: item.name }));
}

const orderedTiers: ModelTier[] = ["fast", "balanced", "frontier", "extreme"];

/** Automatic routing policy applies only to known families in the live catalog. */
function cursorTier(family: string, effort: string): ModelTier | undefined {
  if (/^composer(?:-|$)/.test(family)) return "fast";
  if (/^grok-/.test(family)) {
    if (effort === "xhigh" || effort === "max") return "frontier";
    if (effort === "high") return "balanced";
  }
  if (/^claude-sonnet-/.test(family)) return "balanced";
  if (/^claude-opus-/.test(family) && ["high", "xhigh", "max"].includes(effort)) return "frontier";
  if (/^claude-fable-/.test(family) && ["high", "xhigh", "max"].includes(effort)) return "extreme";
}

export function cursorCatalog(session: Json): ModelOption[] {
  const seen = new Set<string>();
  const catalog: ModelOption[] = [];
  for (const choice of cursorChoices(session)) {
    const id = text(choice.value);
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const [family, variant] = id.split("[");
    const parameters = new URLSearchParams((variant ?? "").replace(/\]$/, "").replaceAll(",", "&"));
    const effort = parameters.get("reasoning_effort") ?? parameters.get("reasoning") ?? parameters.get("effort") ?? "";
    const tier = cursorTier(family, effort);
    const qualifiers = [effort, parameters.get("context"), parameters.get("fast")==="true" ? "fast" : ""].filter(Boolean);
    catalog.push({
      id, label: [text(choice.name) || family, ...qualifiers].join(" · "), tier, source: "acp",
      ...(effort ? { efforts: [effort] } : {}),
    });
  }
  // Keep the existing preferences among equally capable choices.
  const preferred = (id: string) => /^(composer|grok)-/.test(id) ? 0 : 1;
  return catalog.sort((a,b) => preferred(a.id) - preferred(b.id));
}

export function rankedCursorModel(session: Json, tier: ModelTier): ModelOption | undefined {
  const models = cursorCatalog(session);
  for (const eligible of orderedTiers.slice(orderedTiers.indexOf(tier))) {
    const model = models.find((option) => option.tier === eligible);
    if (model) return model;
  }
}

export function cursorCatalogValue(requested: string, catalog: ModelOption[]): string | undefined {
  return cursorModelValue(requested, catalog.map((item) => ({ value: item.id, name: item.label })));
}
