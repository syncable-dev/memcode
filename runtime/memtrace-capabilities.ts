import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { childEnv, findCommand, type Command } from "./commands";

const execute = promisify(execFile);

export interface CheckoutCapabilities {
  protocol_version: 1;
  owned_worktree_v1: boolean;
  checkout_modes: string[];
}

export function checkoutCapabilities(value: unknown): CheckoutCapabilities {
  const result = value as Partial<CheckoutCapabilities> | null;
  if (
    result?.protocol_version !== 1 ||
    typeof result.owned_worktree_v1 !== "boolean" ||
    !Array.isArray(result.checkout_modes) ||
    !result.checkout_modes.every((mode) => typeof mode === "string") ||
    (result.owned_worktree_v1 && !result.checkout_modes.includes("owned-worktree-v1"))
  )
    throw new Error(
      "Memtrace did not provide valid checkout capabilities. Reconnect the bundled Memtrace engine in Settings, then retry. Parallel epic support has not been verified.",
    );
  return result as CheckoutCapabilities;
}

/** A stateless process: capability discovery must never open the project graph.
 * Only an explicit old-command response permits the legacy MCP negotiation. */
export async function probeCheckoutCapabilities(
  command: Command,
  timeout = 5_000,
): Promise<CheckoutCapabilities | null> {
  let stdout: string;
  try {
    ({ stdout } = await execute(
      command.command,
      [...command.prefix, "capabilities", "--json"],
      {
        cwd: tmpdir(),
        env: { ...childEnv({ engine: true }), ...command.env },
        encoding: "utf8",
        windowsHide: true,
        timeout,
        maxBuffer: 32_000,
      },
    ));
  } catch (failure) {
    const error = failure as Error & { code?: number; stderr?: string; stdout?: string };
    if (
      (error.code === 1 || error.code === 2) &&
      /(?:unknown|unrecognized) (?:subcommand|command)[:\s'"]+capabilities\b|unexpected argument ['"]capabilities['"]/i.test(
        `${error.stderr ?? ""}\n${error.stdout ?? ""}`,
      )
    )
      return null;
    throw new Error("Memtrace could not verify epic isolation before startup. " + error.message);
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Memtrace did not provide valid checkout capabilities: invalid JSON.");
  }
  return checkoutCapabilities(value);
}

export async function readCheckoutCapabilities(
  configuredPath: string,
): Promise<CheckoutCapabilities | null> {
  const command = await findCommand("memtrace", configuredPath);
  if (!command) throw new Error("The connected Memtrace executable is unavailable. Reconnect Memtrace in Settings.");
  return probeCheckoutCapabilities(command);
}
