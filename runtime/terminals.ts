import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { AppState } from "../src/shared";
import {
  terminalRequestSchema,
  type TerminalRequest,
  type TerminalReply,
  type TerminalShell,
  type TerminalSession,
} from "../src/terminal";
import type { NativeHost } from "./host";
import { childEnv, findCommand } from "./commands";
import { git, now, within } from "./local";

export async function installedShells(): Promise<TerminalShell[]> {
  const win = process.platform === "win32",
    home = homedir();
  const candidates: Array<[string, string, string | undefined, string[]]> = win
    ? [
        [
          "pwsh",
          "PowerShell",
          (await findCommand("pwsh"))?.command ??
            join(
              process.env.ProgramFiles ?? "C:\\Program Files",
              "PowerShell",
              "7",
              "pwsh.exe",
            ),
          ["-NoLogo"],
        ],
        [
          "powershell",
          "Windows PowerShell",
          join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          ["-NoLogo"],
        ],
        [
          "git-bash",
          "Git Bash",
          join(home, "scoop", "apps", "git", "current", "bin", "bash.exe"),
          ["--login", "-i"],
        ],
        [
          "git-bash-system",
          "Git Bash",
          join(
            process.env.ProgramFiles ?? "C:\\Program Files",
            "Git",
            "bin",
            "bash.exe",
          ),
          ["--login", "-i"],
        ],
        [
          "cmd",
          "Command Prompt",
          process.env.ComSpec ??
            join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "cmd.exe",
            ),
          [],
        ],
      ]
    : [
        ["default", "Default shell", process.env.SHELL, ["-l"]],
        ["zsh", "Zsh", "/bin/zsh", ["-l"]],
        ["bash", "Bash", "/bin/bash", ["-l"]],
        ["fish", "Fish", (await findCommand("fish"))?.command, ["-l"]],
        ["sh", "Shell", "/bin/sh", []],
      ];
  const shells: TerminalShell[] = [],
    seen = new Set<string>();
  for (const [id, name, command, args] of candidates) {
    if (!command) continue;
    try {
      const path = await realpath(command);
      await access(path, win ? constants.F_OK : constants.X_OK);
      if (!(await stat(path)).isFile() || seen.has(path)) continue;
      seen.add(path);
      shells.push({ id, name, command: path, args });
    } catch {
      /* Only show shells installed on this machine. */
    }
  }
  return shells;
}

export class TerminalManager {
  private started = false;
  constructor(
    private state: () => AppState,
    private host: NativeHost,
  ) {}
  async execute(
    taskId: string,
    raw: TerminalRequest,
    origin: "user" | "worker" = "user",
  ): Promise<TerminalReply> {
    const request = terminalRequestSchema.parse(raw);
    const task = this.state().tasks.find((t) => t.id === taskId);
    const project = this.state().projects.find((p) => p.id === task?.projectId);
    if (!task || !project?.path || project.example || task.example)
      throw Error("Connect a local project to use its terminal.");
    const root = await realpath(task.run.workspace ?? project.path);
    const shells =
      request.action === "list" || request.action === "start"
        ? await installedShells()
        : [];
    if (request.action === "start") {
      let suppliedArgs: unknown = request.args;
      if (typeof suppliedArgs === "string") {
        try {
          suppliedArgs = JSON.parse(suppliedArgs);
        } catch {
          throw Error(
            "args must be an array of argument strings, or a JSON-encoded array. Shell command strings are not accepted.",
          );
        }
      }
      const argv =
        terminalRequestSchema.options[1].shape.args.safeParse(suppliedArgs);
      if (
        !argv.success ||
        !Array.isArray(argv.data) ||
        argv.data.some((v) => typeof v !== "string" || v.length > 8000)
      )
        throw Error("args must be an array of at most 80 argument strings.");
      const argumentsList = argv.data as string[];
      const cwd = await realpath(
        request.cwd ? resolve(root, request.cwd) : root,
      );
      if (!within(root, cwd) || !(await stat(cwd)).isDirectory())
        throw Error("Terminal folder must be inside this project.");
      if (
        origin === "worker" &&
        task.run.branch &&
        (await git(root, ["branch", "--show-current"])).trim() !==
          task.run.branch
      )
        throw Error(
          "The goal branch changed. Reconcile Fleet before launching a process.",
        );
      if (request.shellId && request.program)
        throw Error("Choose a shell or an executable.");
      let program: string, args: string[];
      if (!request.program) {
        const shell =
          shells.find((s) => s.id === request.shellId) ??
          (!request.shellId ? shells[0] : undefined);
        if (!shell) throw Error("This shell is not installed.");
        program = shell.command;
        args = [...shell.args, ...argumentsList];
      } else if (request.program === "node") {
        program = process.execPath;
        args = argumentsList;
      } else if (request.program === "npm" || request.program === "npx") {
        const cli = join(
          dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          request.program + "-cli.js",
        );
        await access(cli);
        program = process.execPath;
        args = [cli, ...argumentsList];
      } else {
        program = isAbsolute(request.program)
          ? await realpath(request.program)
          : ((await findCommand(request.program))?.command ?? "");
        if (!program || !(await stat(program)).isFile())
          throw Error(
            "Executable was not found. Supply an installed executable path.",
          );
        args = argumentsList;
      }
      const id = randomUUID();
      const path = Object.entries(childEnv()).find(
        ([key]) => key.toLowerCase() === "path",
      )?.[1];
      const session = await this.host.call<TerminalSession>("terminal_start", {
        id,
        taskId,
        cwd,
        program,
        args,
        label: request.label,
        origin,
        startedAt: now(),
        cols: request.cols,
        rows: request.rows,
        env: {
          // Native PTYs may rebuild their environment from the Windows registry.
          // Retain the runtime's prepared tool paths without forwarding secrets.
          ...(path === undefined ? {} : { PATH: path }),
          MEMCODE_TASK_ID: taskId,
          MEMCODE_TERMINAL_ID: id,
          MEMCODE_HARNESS: task.harness,
        },
      });
      this.started = true;
      await this.audit(root, taskId, {
        action: "start",
        sessionId: id,
        origin,
        program,
        args,
        cwd,
      });
      return { sessions: [session], session, shells };
    }
    if (request.action === "list") {
      const sessions = await this.host.call<TerminalSession[]>(
        "terminal_list",
        { taskId },
      );
      sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return { sessions, shells };
    }
    if (request.action === "observe") {
      const result = await this.host.call<
        Pick<TerminalReply, "session" | "chunks" | "truncated">
      >("terminal_observe", { taskId, ...request });
      const text = stripVTControlCharacters(
        Buffer.concat(
          (result.chunks ?? []).map((c) => Buffer.from(c.data, "base64")),
        ).toString("utf8"),
      );
      if (origin === "worker")
        await this.audit(root, taskId, {
          action: "observe",
          origin,
          sessionId: request.sessionId,
          after: request.after,
          seq: result.session?.seq,
        });
      return {
        ...result,
        sessions: result.session ? [result.session] : [],
        shells,
        text: text.slice(-16000),
      };
    }
    await this.host.call("terminal_" + request.action, {
      taskId,
      ...request,
      ...(request.action === "write"
        ? {
            data: Buffer.from(
              request.data + (request.submit ? "\r" : ""),
              "utf8",
            ).toString("base64"),
          }
        : {}),
    });
    if (request.action === "stop" || request.action === "close")
      await this.audit(root, taskId, {
        action: request.action,
        sessionId: request.sessionId,
        origin,
      });
    return { sessions: [], shells };
  }
  private async audit(root: string, taskId: string, record: object) {
    const directory = join(root, ".memcode", "workers", taskId);
    await mkdir(directory, { recursive: true });
    // Interactive keystrokes are intentionally not copied into a durable audit log.
    await appendFile(
      join(directory, "terminal-activity.jsonl"),
      JSON.stringify({ at: now(), ...record }) + "\n",
      { mode: 0o600 },
    );
  }
  async close() {
    if (this.started) await this.host.call("terminal_close_all");
  }
}
