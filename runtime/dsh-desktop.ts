import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DshDesktopCliInfo } from "../src/shared";
import { childEnv, exists, refreshWindowsUserPath } from "./commands";

const execFileAsync = promisify(execFile);
const FINGERPRINT_RE = /^[a-f0-9]{64}$/i;
const SCRUB_ENV_RE = /KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$/i;

interface DesktopCliPaths {
  isMac: boolean;
  bundledNode: string;
  commandManagerPath: string;
  launcherPath: string;
}

interface CommandManagerResponse {
  ok: boolean;
  code?: string;
  message?: string;
  state?: {
    fingerprint?: unknown;
    managed?: unknown;
    available?: unknown;
    activeCommand?: unknown;
    launcher?: unknown;
    directory?: unknown;
  };
}

function resolveResourcesDir(desktopAppPath: string): { resourcesDir: string; isMac: boolean } {
  const isMac = /\.app(?:[\\/]?)$/i.test(desktopAppPath) || process.platform === "darwin";
  const clean = desktopAppPath.replace(/[\\/]+$/, "");
  return {
    isMac,
    resourcesDir: isMac ? join(clean, "Contents", "Resources") : join(dirname(clean), "resources"),
  };
}

function scrubbedCliEnv(): NodeJS.ProcessEnv {
  const env = childEnv();
  for (const key of Object.keys(env)) {
    if (SCRUB_ENV_RE.test(key)) delete env[key];
  }
  return env;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolveDesktopCliPaths(desktopAppPath: string): Promise<DesktopCliPaths | string> {
  const { resourcesDir, isMac } = resolveResourcesDir(desktopAppPath);
  const nodeNames = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  let bundledNode: string | null = null;
  for (const sub of ["runtime", ""]) {
    for (const nodeName of nodeNames) {
      const candidate = sub
        ? join(resourcesDir, sub, "primary-runtime", "dependencies", "node", "bin", nodeName)
        : join(resourcesDir, "primary-runtime", "dependencies", "node", "bin", nodeName);
      if (await isFile(candidate)) {
        bundledNode = candidate;
        break;
      }
    }
    if (bundledNode) break;
  }
  if (!bundledNode) {
    return "DeepSeek Harness Desktop bundled Node runtime was not found.";
  }

  const commandManagerPath = join(resourcesDir, "runtime", "cli", "command-manager.js");
  if (!(await isFile(commandManagerPath))) {
    return "DeepSeek Harness Desktop CLI manager was not found.";
  }

  const launcherCandidates = isMac && process.platform !== "win32"
    ? [join(resourcesDir, "runtime", "cli", "bin", "dsh")]
    : [
        join(resourcesDir, "runtime", "cli", "bin", "dsh.cmd"),
        join(resourcesDir, "runtime", "cli", "bin", "dsh"),
      ];
  let launcherPath: string | null = null;
  for (const candidate of launcherCandidates) {
    if (await exists(candidate)) {
      launcherPath = candidate;
      break;
    }
  }
  if (!launcherPath) {
    return "DeepSeek Harness Desktop CLI launcher was not found.";
  }

  return { isMac, bundledNode, commandManagerPath, launcherPath };
}

async function runCommandManager(
  paths: DesktopCliPaths,
  args: string[],
): Promise<{ parsed: CommandManagerResponse | null; errorMessage?: string }> {
  let stdout = "";
  let stderr = "";
  let thrownMessage: string | undefined;
  try {
    const result = await execFileAsync(paths.bundledNode, [paths.commandManagerPath, ...args], {
      shell: false,
      windowsHide: true,
      timeout: 15_000,
      encoding: "utf8",
      env: scrubbedCliEnv(),
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    stdout = typeof err.stdout === "string" ? err.stdout : "";
    stderr = typeof err.stderr === "string" ? err.stderr : "";
    thrownMessage = err.message;
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const candidate = JSON.parse(lines[i]) as CommandManagerResponse;
      if (candidate && typeof candidate === "object" && typeof candidate.ok === "boolean") {
        return { parsed: candidate };
      }
    } catch {
      /* Ignore non-JSON line and try earlier line. */
    }
  }
  return {
    parsed: null,
    errorMessage: stderr.trim() || thrownMessage || "Invalid response from Desktop CLI manager.",
  };
}

async function inspectInternal(
  desktopAppPath: string,
): Promise<{ info: DshDesktopCliInfo; fingerprint?: string; paths?: DesktopCliPaths }> {
  const resolved = await resolveDesktopCliPaths(desktopAppPath);
  if (typeof resolved === "string") {
    return {
      info: {
        desktopAppPath,
        canInstall: false,
        managed: false,
        available: false,
        reason: resolved,
      },
    };
  }

  const { parsed, errorMessage } = await runCommandManager(resolved, ["inspect"]);
  if (!parsed) {
    return {
      info: {
        desktopAppPath,
        canInstall: false,
        managed: false,
        available: false,
        reason: errorMessage ?? "Failed to inspect DeepSeek Harness Desktop CLI.",
      },
    };
  }
  if (!parsed.ok) {
    return {
      info: {
        desktopAppPath,
        canInstall: false,
        managed: false,
        available: false,
        reason: parsed.message || "Desktop CLI inspection returned an error.",
      },
    };
  }

  const state = parsed.state;
  if (
    !state ||
    typeof state.fingerprint !== "string" ||
    !FINGERPRINT_RE.test(state.fingerprint) ||
    typeof state.managed !== "boolean" ||
    typeof state.available !== "boolean"
  ) {
    return {
      info: {
        desktopAppPath,
        canInstall: false,
        managed: false,
        available: false,
        reason: "Desktop CLI inspection returned an unexpected response format.",
      },
    };
  }

  const launcherPath =
    typeof state.launcher === "string" && state.launcher.trim()
      ? state.launcher
      : resolved.launcherPath;

  return {
    fingerprint: state.fingerprint,
    paths: resolved,
    info: {
      desktopAppPath,
      canInstall: true,
      managed: state.managed,
      available: state.available,
      launcherPath,
      ...(typeof state.activeCommand === "string" && state.activeCommand
        ? { activeCommand: state.activeCommand }
        : {}),
    },
  };
}

export async function inspectDshDesktopCli(desktopAppPath: string): Promise<DshDesktopCliInfo> {
  return (await inspectInternal(desktopAppPath)).info;
}

function prependWindowsPathDir(dir: string): void {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const entries = (process.env[pathKey] ?? "")
    .split(delimiter)
    .map((part) => part.replace(/^"|"$/g, "").trim())
    .filter(Boolean);
  const lower = dir.toLowerCase();
  if (!entries.some((entry) => entry.toLowerCase() === lower)) {
    process.env[pathKey] = [dir, ...entries].join(delimiter);
  }
}

export async function installDshDesktopCli(
  desktopAppPath: string,
): Promise<{ installed: boolean; needsDesktopMenu?: boolean; message: string; launcherPath?: string }> {
  const inspected = await inspectInternal(desktopAppPath);
  if (!inspected.info.canInstall || !inspected.fingerprint || !inspected.paths) {
    return {
      installed: false,
      message: inspected.info.reason ?? "DeepSeek Harness Desktop CLI helper is unavailable.",
    };
  }

  const { parsed, errorMessage } = await runCommandManager(inspected.paths, [
    "install",
    inspected.fingerprint,
  ]);
  if (!parsed) {
    return {
      installed: false,
      message: errorMessage ?? "Failed to install DeepSeek Harness CLI.",
    };
  }

  if (!parsed.ok) {
    if (inspected.paths.isMac && (parsed.code === "EACCES" || parsed.code === "EPERM")) {
      return {
        installed: false,
        needsDesktopMenu: true,
        message: "Open DeepSeek Harness Desktop and choose Manage dsh Command… to authorize /usr/local/bin/dsh.",
      };
    }
    return {
      installed: false,
      message: parsed.message || "Failed to install DeepSeek Harness CLI.",
    };
  }

  const launcherPath =
    typeof parsed.state?.launcher === "string" && parsed.state.launcher.trim()
      ? parsed.state.launcher
      : inspected.info.launcherPath ?? inspected.paths.launcherPath;

  if (process.platform === "win32") {
    await refreshWindowsUserPath();
    prependWindowsPathDir(dirname(launcherPath));
  }

  return {
    installed: true,
    message: "DeepSeek Harness CLI installed.",
    launcherPath,
  };
}
