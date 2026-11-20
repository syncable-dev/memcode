import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import {
  childEnv,
  commandIdentity,
  findCommand,
  findDesktopApp,
  type Command,
} from "./commands";
import { MemtraceAccountManager, type MemtraceAccountOptions } from "./account";
import { probeStandardCatalog } from "./agents/standard-acp";
import type { NativeHost } from "./host";
import {
  harnessNames,
  type AppState,
  type Harness,
  type HarnessRuntime,
} from "../src/shared";
import {
  hasWorkerApproval,
  workerApprovalMatches,
  type WorkerConnectionStatus,
} from "../src/connections";
const execute = promisify(execFile);
const clean = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const loginArguments = {
  codex: ["login"],
  claude: ["auth", "login"],
  cursor: ["login"],
  copilot: ["login"],
  dsh: ["web"],
};
export const loginCommands = {
  codex: "codex login",
  claude: "claude auth login",
  cursor: "agent login",
  copilot: "copilot login",
  dsh: "dsh web",
};
function workerLoginCommand(harness: Harness, command: Command) {
  if (process.platform !== "darwin") return loginCommands[harness];
  return [command.command, ...command.prefix, ...loginArguments[harness]]
    .map((word) =>
      !word || /[^\w./-]/.test(word)
        ? "'" + word.replaceAll("'", "'\\''") + "'"
        : word,
    )
    .join(" ");
}
function accountLabel(value: unknown) {
  return typeof value === "string" &&
    /^[^\s@<>]{1,80}@[^\s@<>]{1,80}$/.test(value)
    ? value
    : undefined;
}
export function parseWorkerAuth(
  harness: Harness,
  stdout: string,
  stderr = "",
): Pick<WorkerConnectionStatus, "auth" | "accountLabel"> {
  if (harness === "codex")
    return /Logged in using (ChatGPT|an API key|API key)/i.test(
      clean(stdout + "\n" + stderr),
    )
      ? {
          auth: "authenticated",
          accountLabel: /ChatGPT/i.test(stdout + stderr)
            ? "ChatGPT account"
            : "Configured API key",
        }
      : {
          auth: /not logged in/i.test(stdout + stderr)
            ? "not-authenticated"
            : "unknown",
        };
  try {
    const data = JSON.parse(clean(stdout));
    const authenticated =
      harness === "claude" ? data?.loggedIn : data?.isAuthenticated;
    if (typeof authenticated !== "boolean") return { auth: "unknown" };
    return {
      auth: authenticated ? "authenticated" : "not-authenticated",
      accountLabel: authenticated
        ? accountLabel(harness === "claude" ? data.email : data.userInfo?.email)
        : undefined,
    };
  } catch {
    return { auth: "unknown" };
  }
}
export function assertWorkerConnected(
  state: AppState,
  harness: Harness,
  path?: string,
  runtimeIdentity?: string,
) {
  const receipt = state.workerConnections?.[harness];
  if (
    !hasWorkerApproval(receipt, harness) ||
    (path &&
      !workerApprovalMatches(receipt, { id: harness, path, runtimeIdentity }))
  )
    throw Error(
      `Connect ${harnessNames[harness]} in Workers before starting a worker.`,
    );
}
export function connectedRuntimes(state: AppState, runtimes: HarnessRuntime[]) {
  return runtimes.filter((runtime) => {
    try {
      if (!runtime.available || !runtime.path) return false;
      assertWorkerConnected(
        state,
        runtime.id,
        runtime.path,
        runtime.runtimeIdentity,
      );
      return true;
    } catch {
      return false;
    }
  });
}
type Register = (
  name: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
export function registerConnections(
  register: Register,
  state: () => AppState,
  changed: () => Promise<void>,
  configuredPath: () => string,
  host: NativeHost,
  commandFor: typeof findCommand = findCommand,
  accountOptions: MemtraceAccountOptions = {},
) {
  const account = new MemtraceAccountManager(configuredPath, host, {
      ...accountOptions,
      beforeChange: () => {
        if (
          state().tasks.some(
            (task) =>
              !task.example &&
              ["preparing", "running", "stopping"].includes(task.run.state),
          )
        )
          throw Error(
            "Stop active workers before changing the Memtrace account.",
          );
        return accountOptions.beforeChange?.();
      },
    }),
    id = z.enum(["codex", "claude", "cursor", "copilot", "dsh"]);
  // Reuse the existing Memtrace session for host-owned author attribution.
  // This is a read-only status check, not a worker connection or login action.
  void account.refresh().catch(() => {});
  const status = async (harness: Harness): Promise<WorkerConnectionStatus> => {
    const receipt = state().workerConnections?.[harness];
    let command = await commandFor(harness);
    // A GUI launch can have a narrower PATH than the terminal that originally
    // connected the provider. Reuse its explicitly approved provider entry.
    if (!command && hasWorkerApproval(receipt, harness)) {
      const saved = receipt.runtimeIdentity ?? receipt.runtimePath;
      if (isAbsolute(saved) && !/[/\\]node(?:\.exe)?$/i.test(saved))
        command = await commandFor(harness, saved);
    }
    if (!command)
      return {
        harness,
        installed: false,
        connected: false,
        runtimePath: null,
        approvalSaved: hasWorkerApproval(receipt, harness),
        approvedAt: hasWorkerApproval(receipt, harness)
          ? receipt.approvedAt
          : undefined,
        desktopAppPath: (await findDesktopApp(harness)) ?? undefined,
        auth: "unknown",
        note: hasWorkerApproval(receipt, harness)
          ? "Your worker approval is saved. Its command-line runtime could not be found; refresh discovery or restore the runtime."
          : "Install the standalone CLI, then connect it here.",
        loginCommand: loginCommands[harness],
      };
    let auth: Pick<WorkerConnectionStatus, "auth" | "accountLabel"> = {
      auth: "unknown",
    };
    if (harness === "codex" && state().settings.localModel)
      auth = { auth: "local", accountLabel: "Configured local model" };
    else if (harness === "copilot" || harness === "dsh") {
      // A catalog proves transport availability, not account access. These CLIs
      // own provider authentication and confirm access at the first model call.
      const models = await probeStandardCatalog(harness, command).catch(() => []);
      auth = models.length
        ? { auth: "provider-managed" }
        : { auth: "unknown" };
    }
    else {
      const args =
        harness === "codex"
          ? ["login", "status"]
          : harness === "claude"
            ? ["auth", "status"]
            : ["status", "--format", "json"];
      try {
        const { stdout, stderr } = await execute(
          command.command,
          [...command.prefix, ...args],
          {
            env: { ...childEnv(), ...command.env },
            windowsHide: true,
            timeout: 12000,
            maxBuffer: 128000,
            encoding: "utf8",
          },
        );
        auth = parseWorkerAuth(harness, stdout, stderr);
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        auth = parseWorkerAuth(
          harness,
          failure.stdout ?? "",
          failure.stderr ?? "",
        );
        /* No raw CLI output or credentials reach the renderer. */
      }
    }
    const identity = commandIdentity(command);
    const approved = workerApprovalMatches(receipt, {
        id: harness,
        path: command.command,
        runtimeIdentity: identity,
      }),
      connected =
        approved && ["authenticated", "local", "provider-managed"].includes(auth.auth);
    if (
      approved &&
      receipt &&
      (receipt.runtimeIdentity !== identity ||
        receipt.runtimePath !== command.command)
    ) {
      receipt.runtimeIdentity = identity;
      receipt.runtimePath = command.command;
      await changed();
    }
    return {
      harness,
      installed: true,
      connected,
      approvalSaved: approved,
      runtimePath: command.command,
      runtimeIdentity: identity,
      ...auth,
      approvedAt: approved ? receipt?.approvedAt : undefined,
      note: connected
        ? auth.auth === "provider-managed"
          ? "Connected. This CLI manages its provider sign-in; model access is confirmed when work starts."
          : "Approved for projects you select. No worker starts until you send work."
        : approved
          ? auth.auth === "unknown"
            ? "Your worker approval is saved. Sign-in status could not be checked; check again before starting work."
            : "Your worker approval is saved. Sign in to use this worker again."
          : receipt && !approved
            ? "The installed runtime changed. Review and approve its connection again."
            : auth.auth === "local"
              ? "A local model is configured. Review and approve the connection."
              : auth.auth === "provider-managed"
                ? "ACP is available. Connect this CLI using its existing provider setup. Model access has not yet been verified."
              : auth.auth === "authenticated"
                ? "Installed and signed in. Review and approve the connection."
                : auth.auth === "unknown"
                  ? "MemCode couldn’t check your sign-in. Open Connect to check again."
                  : "Installed. Sign in to connect this worker.",
      loginCommand: workerLoginCommand(harness, command),
    };
  };
  register("connection:status", z.undefined(), () =>
    Promise.all((["codex", "claude", "cursor", "copilot", "dsh"] as Harness[]).map(status)),
  );
  register(
    "connection:approve",
    z.object({ harness: id, approved: z.literal(true) }).strict(),
    async (input) => {
      const result = await status(input.harness);
      if (!result.installed || !result.runtimePath)
        throw Error("Install the worker CLI before connecting it.");
      if (!["authenticated", "local", "provider-managed"].includes(result.auth))
        throw Error(
          result.auth === "not-authenticated"
            ? `Sign in to ${harnessNames[result.harness]} before approving the connection.`
            : `MemCode couldn’t verify your ${harnessNames[result.harness]} sign-in.`,
        );
      (state().workerConnections ??= {})[input.harness as Harness] = {
        harness: input.harness,
        approvedAt: new Date().toISOString(),
        runtimePath: result.runtimePath,
        runtimeIdentity: result.runtimeIdentity ?? result.runtimePath,
        auth: result.auth as "authenticated" | "local" | "provider-managed",
        accountLabel: result.accountLabel,
        scopeVersion: 1,
      };
      await changed();
      return status(input.harness);
    },
  );
  register(
    "connection:disconnect",
    z.object({ harness: id }).strict(),
    async ({ harness }) => {
      if (
        state().tasks.some(
          (t) =>
            t.harness === harness &&
            ["preparing", "running", "stopping"].includes(t.run.state),
        )
      )
        throw Error(
          "Stop this adapter's active workers before disconnecting it.",
        );
      delete state().workerConnections?.[harness as Harness];
      await changed();
    },
  );
  register("account:status", z.undefined(), () => account.refresh());
  register("account:sign-in", z.undefined(), () => account.signIn());
  register("account:sign-out", z.undefined(), () => account.signOut());
  register("account:switch", z.undefined(), () => account.switchAccount());
  register("account:cancel-sign-in", z.undefined(), () =>
    account.cancelSignIn(),
  );
  return { account, close: () => account.close() };
}
