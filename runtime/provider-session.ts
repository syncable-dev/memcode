import { realpath } from "node:fs/promises";
import type { Harness, WorkItem } from "../src/shared";

export interface ProviderSession {
  harness: Harness;
  sessionId: string;
  workspace: string;
  branch: string;
  epicId?: string | null;
}

/** Migrate an existing local run only when its actual route and checkout are known. */
export function previousProviderSession(
  task: WorkItem,
): ProviderSession | undefined {
  const { sessionId, workspace, branch } = task.run;
  const binding = task.run.sessionBinding;
  if (sessionId && binding && (binding.branch || branch))
    return {
      ...binding,
      sessionId,
      branch: binding.branch ?? branch!,
      epicId: binding.epicId === undefined ? task.epicId : binding.epicId,
    };
  // Legacy identity comes from a native observation, never the proposed route.
  const harness = task.run.measurements?.modelSource?.split("-")[0];
  if (
    sessionId &&
    workspace &&
    branch &&
    (harness === "codex" || harness === "claude" || harness === "cursor" || harness === "copilot" || harness === "dsh")
  )
    return { sessionId, workspace, branch, harness, epicId: task.epicId };
}

/** Native history belongs to one provider and physical checkout on this device. */
export async function resumableProviderSession(
  previous: ProviderSession | undefined,
  task: WorkItem,
  workspace: string,
): Promise<string | undefined> {
  if (
    !previous ||
    previous.harness !== task.harness ||
    previous.branch !== task.run.branch ||
    previous.epicId !== task.epicId
  )
    return;
  const canonical = (path: string) =>
    realpath(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  const [before, current] = await Promise.all([
    canonical(previous.workspace),
    canonical(workspace),
  ]);
  if (!before || !current) return;
  const key = (path: string) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  return key(before) === key(current) ? previous.sessionId : undefined;
}
