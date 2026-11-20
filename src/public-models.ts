/** Explicit public identifiers only. Unknown/private provider labels never leave the device. */
export const publicModelIds = [
  "gpt-6.2-astra",
  "gpt-6.2-sol",
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
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-5-5",
  "claude-fable-5-2",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
] as const;
export type PublicModelId = (typeof publicModelIds)[number];
export const publicModelId = (value: unknown): PublicModelId | null =>
  typeof value === "string" && publicModelIds.includes(value as PublicModelId)
    ? (value as PublicModelId)
    : null;
export function modelFamily(value: unknown): string {
  if (typeof value !== "string") return "other";
  const exact = publicModelId(value);
  if (exact?.startsWith("claude-")) return exact.split("-")[1];
  return (
    exact ??
    (["haiku", "sonnet", "opus", "fable"].includes(value) ? value : "other")
  );
}
