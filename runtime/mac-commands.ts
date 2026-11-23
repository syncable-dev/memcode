import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { Command } from "./commands";

export interface MacCommandOptions {
  home?: string;
  environment?: NodeJS.ProcessEnv;
  /** Explicit fixture roots; production uses only the standard locations. */
  systemDirectories?: readonly string[];
  applicationDirectories?: readonly string[];
}

/** Finder-launched apps do not inherit a terminal's shell startup PATH. */
export function macCommandDirectories(
  options: MacCommandOptions = {},
): string[] {
  const home = options.home ?? homedir();
  const env = options.environment ?? process.env;
  return [
    ...new Set([
      ...(env.PATH ?? "").split(":").filter(Boolean),
      join(home, ".local", "bin"),
      ...(options.systemDirectories ?? ["/opt/homebrew/bin", "/usr/local/bin"]),
      join(home, ".npm-global", "bin"),
      join(home, ".volta", "bin"),
      join(home, ".asdf", "shims"),
      join(home, ".local", "share", "mise", "shims"),
      join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
      join(home, ".bun", "bin"),
    ]),
  ];
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function cursorInstallationIdentity(
  resolved: string,
  home: string,
  canonicalRoot = join(home, ".local", "share", "cursor-agent"),
): string | undefined {
  const root = join(home, ".local", "share", "cursor-agent");
  const parts = relative(join(canonicalRoot, "versions"), resolved).split(sep);
  return parts.length === 2 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[0]) &&
    parts[1] === "cursor-agent"
    ? "cursor-agent-install:" + root
    : undefined;
}

function appRoots(options: MacCommandOptions): readonly string[] {
  return (
    options.applicationDirectories ?? [
      "/Applications",
      join(options.home ?? homedir(), "Applications"),
    ]
  );
}

export async function findMacDesktopApp(
  name: string,
  options: MacCommandOptions = {},
): Promise<string | null> {
  const names =
    name === "codex"
      ? ["Codex.app", "ChatGPT.app"]
      : name === "cursor"
        ? ["Cursor.app"]
        : name === "dsh"
          ? ["DeepSeek Harness.app"]
          : [];
  for (const root of appRoots(options))
    for (const app of names) {
      const path = join(root, app);
      try {
        if ((await stat(path)).isDirectory()) {
          await access(join(path, "Contents", "Info.plist"));
          return path;
        }
      } catch {
        /* This specific application location is absent. */
      }
    }
  return null;
}

async function versionedDirectories(root: string): Promise<string[]> {
  try {
    // No recursive home or application scan. Only known package-manager roots.
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name),
      )
      .sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { numeric: true }),
      )
      .slice(0, 64);
    return entries.map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export async function findMacCommand(
  name: string,
  options: MacCommandOptions = {},
): Promise<Command | null> {
  const home = options.home ?? homedir();
  const directories = macCommandDirectories(options);
  const cursorRoot = join(home, ".local", "share", "cursor-agent");
  // realpath(agent) resolves /var -> /private/var and symlinked home/.local
  // directories too. Compare with the same canonical installation root while
  // retaining its stable user-facing identity, rather than rejecting its alias.
  const canonicalCursorRoot =
    name === "cursor"
      ? await realpath(cursorRoot).catch(() => cursorRoot)
      : undefined;
  // nvm does not expose its default installation in Finder's environment.
  directories.push(
    ...(await versionedDirectories(join(home, ".nvm", "versions", "node"))).map(
      (path) => join(path, "bin"),
    ),
  );
  const envFor = (path: string) => ({
    PATH: [
      ...new Set([...directories, dirname(path), dirname(process.execPath)]),
    ].join(":"),
  });
  for (const directory of directories) {
    for (const candidate of name === "cursor"
      ? ["cursor-agent", "agent"]
      : [name]) {
      const path = join(directory, candidate);
      if (await executable(path)) {
        let identity: string | undefined;
        if (name === "cursor") {
          try {
            identity = cursorInstallationIdentity(
              await realpath(path),
              home,
              canonicalCursorRoot,
            );
          } catch {
            continue;
          } // An automatic CLI update may replace the link mid-discovery.
        }
        // "agent" is not a provider-specific command. Cursor's installer
        // links it to its versioned runtime; an unrelated agent must not run.
        if (name === "cursor" && candidate === "agent" && !identity) continue;
        return {
          command: path,
          prefix: [],
          ...(identity ? { identity } : {}),
          env: {
            ...envFor(path),
            ...(name === "cursor" ? { CURSOR_INVOKED_AS: "agent" } : {}),
          },
        };
      }
    }
    const entry =
      name === "codex"
        ? "@openai/codex/bin/codex.js"
        : name === "claude"
          ? "@anthropic-ai/claude-code/cli.js"
          : name === "memtrace"
            ? "memtrace/bin/memtrace.js"
            : name === "copilot"
              ? "@github/copilot/npm-loader.js"
              : name === "dsh"
                ? "@deepseek-ai/dsh/lib/bin.js"
            : undefined;
    if (entry)
      for (const base of [
        directory,
        dirname(directory),
        join(dirname(directory), "lib"),
      ]) {
        const path = join(base, "node_modules", entry);
        try {
          if ((await stat(path)).isFile())
            return {
              command: process.execPath,
              prefix: [path],
              identity: path,
              env: envFor(path),
            };
        } catch {
          /* Continue to the next explicit installation location. */
        }
      }
  }
  if (name === "cursor") {
    const root = join(home, ".local", "share", "cursor-agent");
    for (const directory of await versionedDirectories(
      join(root, "versions"),
    )) {
      const path = join(directory, "cursor-agent");
      if (await executable(path))
        return {
          command: path,
          prefix: [],
          identity: "cursor-agent-install:" + root,
          env: { ...envFor(path), CURSOR_INVOKED_AS: "agent" },
        };
    }
  }
  if (name === "codex") {
    for (const root of appRoots(options))
      for (const app of ["Codex.app", "ChatGPT.app"])
        for (const entry of [join("codex-cli", "bin", "codex"), "codex"]) {
          // The current official Mac package declares codex-cli/bin/codex as
          // its CLI launcher. Older packages used Resources/codex directly.
          // Never launch the desktop UI executable in Contents/MacOS.
          const path = join(root, app, "Contents", "Resources", entry);
          if (await executable(path))
            return { command: path, prefix: [], env: envFor(path) };
        }
  }
  return null;
}
