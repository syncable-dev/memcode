import { probeStandardACPCatalog, startStandardACPSession, type ACPTransport } from "./cursor";
import type { AgentSessionOptions } from "./types";
import type { Command } from "../commands";
import { normalizeDshProfile } from "../dsh-profiles";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

export type StandardHarness = "copilot" | "dsh";
export function standardTransport(
  id: StandardHarness,
  options?: Partial<Pick<AgentSessionOptions, "effort" | "permissionMode" | "dshProfile">> & {
    allowStaging?: boolean;
  },
): ACPTransport {
  return id === "copilot"
    ? {
        id,
        name: "GitHub Copilot",
        args: ["--acp", "--stdio", ...(options?.effort ? ["--effort", options.effort] : [])],
      }
    : {
        id,
        name: "DeepSeek Harness",
        args: [
          "--profile",
          normalizeDshProfile(options?.dshProfile, {
            allowStaging: options?.allowStaging,
          }),
        ],
      };
}
export function startStandardSession(id: StandardHarness, options: AgentSessionOptions) {
  if (options.localModel) throw Error("The local-model override currently supports Codex with Ollama.");
  if (options.permissionMode === "auto") throw Error(`${standardTransport(id).name}'s ACP connection supports Review and Full access. Smart auto is not advertised by this transport.`);
  return startStandardACPSession(standardTransport(id, options), {
    ...options,
    env: { ...options.env, ...(id === "dsh" ? { DSH_PERMISSION_MODE: options.permissionMode === "full-access" ? "danger-full-access" : "workspace-write" } : {}) },
  });
}
// Async, so an invalid profile name rejects instead of throwing before a
// caller's .catch() is attached.
export async function probeStandardCatalog(
  id: StandardHarness,
  command: Command,
  dshProfile?: string,
  options?: { strictStdout?: boolean; allowStaging?: boolean },
) {
  return probeStandardACPCatalog(
    standardTransport(
      id,
      id === "dsh" ? { dshProfile, allowStaging: options?.allowStaging } : undefined,
    ),
    command,
    options,
  );
}

/** Separate reviewer process, no MCP servers, shell, edits or agent tools. */
export async function readonlyACPTransport(
  id: StandardHarness,
  capsule: string,
  dshProfile?: string,
): Promise<ACPTransport> {
  if (id === "copilot") return {
    id, name: "GitHub Copilot", args: ["--acp", "--stdio", "--available-tools=view", "--disable-builtin-mcps", "--no-custom-instructions", "--no-auto-update"],
  };
  const plugin = join(capsule, "memcode-readonly.mjs");
  await writeFile(plugin, `export const name = 'memcode-readonly-review';
export const inject = ['agents', 'tools'];
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ allow: [] }); });
}
`, { mode: 0o600 });
  const patch = join(capsule, "memcode-readonly.json");
  await writeFile(patch, JSON.stringify([
    { id: "sandbox-policy", config: { mode: "read-only", workspaceRoot: capsule } },
    { insert: [{ id: "memcode-readonly-review", name: plugin }] },
  ]), { mode: 0o600 });
  return {
    id,
    name: "DeepSeek Harness",
    args: ["--profile", normalizeDshProfile(dshProfile), "--patch", patch],
  };
}
