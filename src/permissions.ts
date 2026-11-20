import type { Harness, Settings, WorkItem } from "./shared";

export const permissionModes = ["review", "auto", "full-access"] as const;
export type PermissionMode = (typeof permissionModes)[number];

export function effectivePermissionMode(
  task: Pick<WorkItem, "permissionMode" | "harness">,
  settings: Pick<Settings, "workerPermissionDefaults">,
  harness: Harness = task.harness,
): PermissionMode {
  return (
    task.permissionMode ??
    settings.workerPermissionDefaults?.[harness] ??
    "review"
  );
}

export const permissionLabels: Record<PermissionMode, string> = {
  review: "Review",
  auto: "Smart auto",
  "full-access": "Full access",
};

export function supportsPermissionMode(
  harness: Harness,
  mode: PermissionMode,
): boolean {
  // Cursor's installed ACP transport does not run its CLI Smart Auto classifier.
  return mode !== "auto" || harness === "codex" || harness === "claude";
}

export function permissionDescription(
  harness: Harness,
  mode: PermissionMode,
): string {
  if (harness === "copilot" || harness === "dsh")
    return mode === "auto"
      ? "This ACP connection supports Review and Full access. Native Smart auto is not advertised."
      : mode === "full-access"
        ? "MemCode allows permission requests for this worker. Provider sandbox and administrator rules still apply; questions and Fleet decisions come to you."
        : "Provider permission requests appear beside the conversation. Your existing provider rules remain in effect.";
  if (mode === "full-access")
    return "Bypasses tool approvals and the harness sandbox where supported. Installed deny rules and administrator policies may still apply. Questions and Fleet decisions still come to you.";
  if (mode === "auto")
    return harness === "claude"
      ? "Claude’s native classifier reviews actions automatically and asks you when it needs a decision. Requires a model and account that support Auto mode."
      : harness === "cursor"
        ? "Cursor’s interactive ACP connection does not support Smart Auto yet. Choose Review or Full access."
        : "Codex’s native automatic reviewer evaluates permission requests; remaining decisions come to you. Workspace sandbox stays enabled.";
  return harness === "claude"
    ? "Allows file edits. Other actions follow Claude’s permission rules and ask you when approval is needed."
    : harness === "cursor"
      ? "Follows your Cursor permission rules. Actions needing approval are sent to you."
      : "Workspace sandbox stays enabled. Codex asks you when an action needs additional approval.";
}
