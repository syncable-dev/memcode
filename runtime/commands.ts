import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  findMacCommand,
  findMacDesktopApp,
  macCommandDirectories,
  type MacCommandOptions,
} from "./mac-commands";

export interface Command {
  command: string;
  prefix: string[];
  env?: Record<string, string>;
  /** Provider identity, independent of the MemCode Node executable hosting it. */
  identity?: string;
}
export function commandIdentity(command: Command): string {
  const script = command.prefix[0];
  return (
    command.identity ??
    (script && isAbsolute(script) && /\.(?:cjs|mjs|js)$/i.test(script)
      ? script
      : command.command)
  );
}
export async function findDesktopApp(
  name: string,
  options: MacCommandOptions & {
    platform?: NodeJS.Platform;
    windowsCandidates?: readonly string[];
  } = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return findMacDesktopApp(name, options);
  if (platform !== "win32" || name !== "dsh") return null;

  const env = options.environment ?? process.env;
  const localAppData = env.LOCALAPPDATA ?? join(options.home ?? homedir(), "AppData", "Local");
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const candidates = options.windowsCandidates ?? [
    join(localAppData, "Programs", "DeepSeek Harness", "DeepSeek Harness.exe"),
    join(programFiles, "DeepSeek Harness", "DeepSeek Harness.exe"),
  ];
  for (const exePath of candidates) {
    try {
      if ((await stat(exePath)).isFile() && (await exists(join(dirname(exePath), "resources", "app.asar")))) {
        return exePath;
      }
    } catch {
      /* Candidate installation is absent. */
    }
  }
  return null;
}

function expandWindowsEnvVars(raw: string, env: NodeJS.ProcessEnv): string {
  const lookup = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) lookup.set(k.toLowerCase(), v);
  }
  return raw.replace(/%([^%]+)%/g, (match, name: string) => lookup.get(name.toLowerCase()) ?? match);
}

export async function refreshWindowsUserPath(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  try {
    const regExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
    const { stdout } = await promisify(execFile)(
      regExe,
      ["query", "HKCU\\Environment", "/v", "Path"],
      { shell: false, windowsHide: true, timeout: 5000, encoding: "utf8" },
    );
    const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im.exec(stdout);
    if (!match) return [];

    const discovered = expandWindowsEnvVars(match[1], process.env)
      .split(delimiter)
      .map((entry) => entry.replace(/^"|"$/g, "").trim())
      .filter(Boolean);

    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    const existing = (process.env[pathKey] ?? "")
      .split(delimiter)
      .map((entry) => entry.replace(/^"|"$/g, "").trim())
      .filter(Boolean);
    const seen = new Set(existing.map((entry) => entry.toLowerCase()));
    const added: string[] = [];
    for (const dir of discovered) {
      const lower = dir.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        existing.push(dir);
        added.push(dir);
      }
    }
    if (added.length > 0) {
      process.env[pathKey] = existing.join(delimiter);
    }
    return added;
  } catch {
    return [];
  }
}
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function childEnv(
  options: { engine?: boolean } = {},
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // A standalone worker does not inherit the desktop parent's package identity.
  // Keeping these hints makes Codex reject shell launches and sandboxed writes.
  delete env.CODEX_WINDOWS_REGISTERED_CORE;
  delete env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY;
  // Beta engine proofs belong only to MemCode's explicitly scoped engine.
  // Provider workers, terminals and tools never inherit these file/binding hints.
  for (const key of Object.keys(env))
    if (
      /^MEMCODE_ENGINE_/i.test(key) ||
      /^MEMCODE_TELEMETRY_/i.test(key) ||
      (!options.engine &&
        /^(MEMCORTEX_STORE_DIR|MEMTRACE_ENGINEER)$/i.test(key))
    )
      delete env[key];
  // Fleet's referee then settles what the workers involved agree on, and still asks
  // the person about removals and disagreements. A person's own setting is kept.
  if (options.engine) env.MEMTRACE_FLEET_MEDIATOR ??= "auto";
  const key =
    Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const parts = [
    ...new Set(
      (env[key] ?? "")
        .split(delimiter)
        .map((p) => p.replace(/^"|"$/g, ""))
        .filter(Boolean),
    ),
  ];
  if (process.platform === "darwin")
    parts.push(...macCommandDirectories(), dirname(process.execPath));
  const kept: string[] = [];
  for (const part of new Set(
    parts.map((part) => part.replace(/^"|"$/g, "")).filter(Boolean),
  ))
    if ([...kept, part].join(delimiter).length < 7000) kept.push(part);
  env[key] = kept.join(delimiter);
  return env;
}

async function direct(
  candidates: string[],
  env?: Record<string, string>,
): Promise<Command | null> {
  for (const path of candidates)
    if (await exists(path)) return { command: path, prefix: [], env };
  return null;
}

const WINDOWS_DSH_SHIM =
  /^\s*"%~dp0\\?([^"%\r\n]+\.exe)"\s+--expose-internals\s+"%~dp0\\?([^"%\r\n]+\.(?:c|m)?js)"\s+%\*\s*$/i;

async function dshInstallCommand(
  executable: string,
  script: string,
): Promise<Command | null> {
  // Bind the entry to the installation that owns the executable, so a changed
  // .exe cannot keep a saved worker approval for the same script identity.
  if (basename(executable).toLowerCase() !== "deepseek harness.exe")
    return null;
  const appAsar = join(dirname(executable), "resources", "app.asar");
  if (!script.toLowerCase().startsWith((appAsar + sep).toLowerCase()))
    return null;
  // A leftover shim from an uninstall must not look "installed", and must not
  // block the node_modules fallback in the same directory.
  if (!(await exists(executable)) || !(await exists(appAsar))) return null;
  return {
    command: executable,
    prefix: ["--expose-internals", script],
    identity: script,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * A saved dsh identity points inside the installer's app.asar, which ordinary
 * filesystem access cannot read. Rebuild the command from the owning
 * installation before the configured-path existence check rejects it.
 */
async function savedArchiveCommand(
  name: string,
  configured: string,
): Promise<Command | null> {
  if (name !== "dsh" || process.platform !== "win32" || !isAbsolute(configured))
    return null;
  const normalized = normalize(configured);
  // A saved identity must be the exact entry the shim resolved. Reject `..`
  // segments that would redirect an approved identity to another installation.
  if (normalized.toLowerCase() !== configured.toLowerCase()) return null;
  const parts = normalized.split(sep);
  const archive = parts.findLastIndex(
    (part) => part.toLowerCase() === "app.asar",
  );
  if (
    archive < 2 ||
    parts[archive - 1]?.toLowerCase() !== "resources" ||
    archive === parts.length - 1 ||
    !/\.(?:c|m)?js$/i.test(parts[parts.length - 1])
  )
    return null;
  const install = parts.slice(0, archive - 1).join(sep);
  return dshInstallCommand(join(install, "DeepSeek Harness.exe"), normalized);
}

/**
 * The launcher installed by the official DeepSeek Harness CLI is a .cmd shim
 * that delegates to an Electron executable. Worker sessions spawn with
 * `shell: false`, which cannot run a batch file on Windows. Normalize the shim
 * into the executable, argument prefix and environment the installer declares,
 * so every existing argument-array spawn site works unchanged.
 */
async function windowsShimCommand(path: string): Promise<Command | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  // Only a line that fully matches the official launcher shape counts. A
  // comment or echo that merely mentions the flag cannot shadow the real line.
  let match: RegExpMatchArray | null = null;
  for (const line of text.split(/\r?\n/)) {
    match = line.match(WINDOWS_DSH_SHIM);
    if (match) break;
  }
  if (!match) return null;
  const base = dirname(path);
  const command = resolve(base, match[1]);
  const script = resolve(base, match[2]);
  return dshInstallCommand(command, script);
}

async function cursorRuntime(): Promise<Command | null> {
  const root = join(homedir(), "AppData", "Local", "cursor-agent", "versions");
  try {
    const candidates = await Promise.all(
      (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map(async (entry) => {
          const path = join(root, entry.name);
          return { path, modified: (await stat(path)).mtimeMs };
        }),
    );
    for (const { path } of candidates.sort((a, b) => b.modified - a.modified))
      if (
        (await exists(join(path, "node.exe"))) &&
        (await exists(join(path, "index.js")))
      )
        return {
          command: join(path, "node.exe"),
          prefix: [join(path, "index.js")],
          identity:
            "cursor-agent-install:" + root.replaceAll("\\", "/").toLowerCase(),
          env: { CURSOR_INVOKED_AS: "agent" },
        };
  } catch {
    /* The standalone Cursor agent may not be installed. */
  }
  return null;
}

async function claudeRuntime(): Promise<Command | null> {
  const home = homedir();
  const bash = await direct([
    "C:\\Program Files\\Git\\bin\\bash.exe",
    join(home, "scoop", "apps", "git", "current", "bin", "bash.exe"),
  ]);
  return direct(
    [
      join(
        home,
        ".local",
        "bin",
        process.platform === "win32" ? "claude.exe" : "claude",
      ),
      join(home, ".claude", "local", "claude.exe"),
      join(home, ".claude", "bin", "claude.exe"),
    ],
    bash ? { CLAUDE_CODE_GIT_BASH_PATH: bash.command } : undefined,
  );
}

async function codexAppx(): Promise<Command | null> {
  if (process.platform !== "win32") return null;
  const root = join(
    process.env.ProgramFiles ?? "C:\\Program Files",
    "WindowsApps",
  );
  try {
    const entries = (await readdir(root))
      .filter((name) => name.startsWith("OpenAI.Codex_"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const found = await direct(
      entries.map((name) => join(root, name, "app", "resources", "codex.exe")),
    );
    if (found) return found;
  } catch {
    /* WindowsApps enumeration can be denied for normal users. */
  }
  try {
    const { stdout } = await promisify(execFile)(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation",
      ],
      { windowsHide: true, timeout: 5000, env: childEnv(), encoding: "utf8" },
    );
    return direct(
      stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((path) => join(path, "app", "resources", "codex.exe")),
    );
  } catch {
    return null;
  }
}

export async function findCommand(
  name: string,
  configured = "",
  options: MacCommandOptions & { platform?: NodeJS.Platform } = {},
): Promise<Command | null> {
  if (configured) {
    const archived = await savedArchiveCommand(name, configured);
    if (archived) return archived;
    if (!isAbsolute(configured) || !(await exists(configured))) return null;
    if (/\.(cjs|mjs|js)$/i.test(configured))
      return {
        command: process.execPath,
        prefix: [configured],
        identity: configured,
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    if (process.platform === "win32" && !/\.exe$/i.test(configured))
      return null;
    return { command: configured, prefix: [] };
  }
  if ((options.platform ?? process.platform) === "darwin")
    return findMacCommand(name, options);
  if (name === "cursor") {
    const runtime = await cursorRuntime();
    if (runtime) return runtime;
  }
  if (name === "claude") {
    const runtime = await claudeRuntime();
    if (runtime) return runtime;
  }
  const dirs = [
    ...new Set(
      (process.env.PATH ?? process.env.Path ?? "")
        .split(delimiter)
        .map((d) => d.replace(/^"|"$/g, ""))
        .filter(Boolean),
    ),
  ];
  const extensions =
    process.platform === "win32"
      ? name === "dsh"
        ? [".exe", ".cmd"]
        : [".exe"]
      : [""];
  for (const dir of dirs) {
    if (name === "git" && !isAbsolute(dir)) continue;
    const names = name === "cursor" ? ["cursor-agent", "agent"] : [name];
    for (const candidate of names) {
      for (const extension of extensions) {
        const path = join(dir, candidate + extension);
        if (!((await exists(path)) && (await stat(path)).isFile())) continue;
        // A batch shim cannot be passed to spawn with `shell: false`.
        if (extension === ".cmd") {
          const normalized =
            name === "dsh" ? await windowsShimCommand(path) : null;
          if (normalized) return normalized;
          continue;
        }
        return {
          command: path,
          prefix: [],
          ...(name === "cursor" ? { env: { CURSOR_INVOKED_AS: "agent" } } : {}),
        };
      }
    }
    const packageEntry =
      name === "memtrace"
        ? "memtrace/bin/memtrace.js"
        : name === "claude"
          ? "@anthropic-ai/claude-code/cli.js"
          : name === "codex"
            ? "@openai/codex/bin/codex.js"
            : name === "copilot"
              ? "@github/copilot/npm-loader.js"
              : name === "dsh"
                ? "@deepseek-ai/dsh/lib/bin.js"
            : null;
    if (packageEntry)
      for (const base of [dir, dirname(dir)]) {
        const path = join(base, "node_modules", packageEntry);
        if (await exists(path))
          return {
            command: process.execPath,
            prefix: [path],
            identity: path,
            env: { ELECTRON_RUN_AS_NODE: "1" },
          };
      }
  }
  return name === "codex" ? codexAppx() : null;
}
