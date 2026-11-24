import { imageData } from "../attachments";
import { spawn, execFile } from "node:child_process";
import { appVersion } from "../../src/version";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { cursorCatalog, cursorChoices, cursorModelValue, rankedCursorModel } from "../../src/cursor-models";
import { childEnv, type Command } from "../commands";
import { cursorDefaultModel, type ModelOption } from "../../src/shared";
export { cursorModelValue } from "../../src/cursor-models";
import { join } from "node:path";
import type { AgentSession, AgentSessionOptions } from "./types";
import { standardACPCatalog, selectStandardACPModel, standardModelMeasurement } from "./acp-models";
import { withoutPermissionArgs } from "./permissions";
import { assertCalibratedConfiguration } from "./calibrated-config";
import type { AgentMeasurement } from "../../src/measurements";
import type {
  WorkerInputOption,
  WorkerInputPrompt,
  WorkerInputResponse,
} from "../../src/worker-input";

type Json = Record<string, any>;
type RpcId = string | number;
const execute = promisify(execFile);
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const array = (value: unknown): Json[] =>
  Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const hasId = (message: Json): boolean =>
  typeof message.id === "number" || typeof message.id === "string";
const permissionKind = (kind: string): WorkerInputOption["kind"] =>
  kind === "allow_once"
    ? "allow-once"
    : kind === "allow_always"
      ? "allow-session"
      : kind.startsWith("reject")
        ? "deny"
        : "other";
const contentText = (content: unknown): string =>
  array(content)
    .map((item) => {
      if (item.type === "content") return text(item.content?.text);
      if (item.type === "diff")
        return `${text(item.path)}\n--- Before\n${text(item.oldText)}\n+++ After\n${text(item.newText)}`;
      return text(item.text);
    })
    .filter(Boolean)
    .join("\n");

/** Use only Cursor's acknowledged selection, never our routing request. Auto
 * names a routing policy and does not identify the model that served a task. */
export function cursorSessionModel(
  config: Json[],
  legacyModel?: unknown,
): AgentMeasurement | undefined {
  const selected = config.find(
    (option) => option.category === "model" || option.id === "model",
  );
  const value = text(selected?.currentValue ?? legacyModel);
  if (!value || value.length > 256 || /^(auto|default)(\[.*\])?$/i.test(value))
    return;
  const variant = /^([^\[]+)\[([^\]]*)\]$/.exec(value);
  const parameters = Object.fromEntries(
    (variant?.[2] ?? "")
      .split(",")
      .filter(Boolean)
      .map((entry) => entry.split("=")),
  );
  const effort = config.find(
    (option) => option.category === "thought_level" || /effort|reasoning/i.test(text(option.id)),
  )?.currentValue ?? parameters.effort ?? parameters.reasoning ?? parameters.reasoning_effort;
  return {
    type: "measurement",
    model: {
      id: variant?.[1] ?? value,
      source: "cursor-session",
      ...(["low", "medium", "high", "xhigh"].includes(effort)
        ? { effort }
        : {}),
    },
    models: [variant?.[1] ?? value],
  };
}

export async function selectCursorModel(
  session: Json,
  requested: string,
  request: (method: string, params: Json) => Promise<Json>,
  tier?: import("../../src/shared").ModelTier,
): Promise<{ config: Json[]; legacyModel?: string; alternative?: string }> {
  let config = array(session.configOptions);
  let legacyModel = text(session.models?.currentModelId);
  const model = config.find((item) => item.category === "model" || item.id === "model");
  const current = text(model?.currentValue) || legacyModel;
  if (!requested || requested === cursorDefaultModel) return { config, legacyModel };
  const choices = cursorChoices(session);
  let value = cursorModelValue(requested, choices) ?? (current === requested ? current : undefined);
  let alternative: string | undefined;
  if (!value && tier) {
    const candidate = rankedCursorModel(session, tier);
    if (candidate) {
      value = candidate.id;
      alternative = `Cursor no longer offers ${requested}. MemCode selected ${candidate.label} for this ${tier} task.`;
    } else {
      return { config, legacyModel, alternative: "Cursor will use the current session’s configured model." };
    }
  }
  if (!value)
    throw Error(`This Cursor session does not offer ${requested}. Choose Match task complexity or another model in Worker assignment.`);
  if (value !== current) {
    if (model) {
      const selected = await request("session/set_config_option", { sessionId: session.sessionId, configId: model.id, value });
      config = array(selected.configOptions);
      if (!config.some((item) => item.id === model.id && item.currentValue === value))
        throw Error("Cursor did not confirm the selected model. Refresh Workers and try again.");
    } else {
      await request("session/set_model", { sessionId: session.sessionId, modelId: value });
      legacyModel = value;
    }
  }
  return { config, legacyModel, alternative };
}

async function sessionServers(path?: string): Promise<Json[]> {
  if (!path) return [];
  const configuration = JSON.parse(await readFile(path, "utf8"));
  return Object.entries(record(configuration.mcpServers)).map(
    ([name, value]) => {
      const server = record(value);
      if (typeof server.command === "string")
        return {
          name,
          command: server.command,
          args: Array.isArray(server.args) ? server.args : [],
          env: Object.entries(record(server.env)).map(([name, value]) => ({
            name,
            value: String(value),
          })),
          ...(typeof server.cwd === "string" ? { cwd: server.cwd } : {}),
        };
      if (typeof server.url === "string")
        return {
          name,
          type: server.type === "sse" ? "sse" : "http",
          url: server.url,
          headers: Object.entries(record(server.headers)).map(
            ([name, value]) => ({ name, value: String(value) }),
          ),
        };
      throw Error(
        `The Cursor context server ${name} has no supported transport.`,
      );
    },
  );
}

/** Native ACP keeps stdin open for bound, bidirectional approval replies. */
export function startCursorSession(options: AgentSessionOptions): AgentSession {
  return runCursorSession(options);
}

/** Read exactly what this installed, authenticated ACP admits. No project,
 * MCP tools or worker prompt are supplied to the discovery session. */
export async function probeCursorCatalog(command: Command): Promise<ModelOption[]> {
  const cwd = await mkdtemp(join(tmpdir(), "memcode-cursor-catalog-"));
  try {
    let models: ModelOption[] = [];
    const session = runCursorSession({
      command, cwd, env: childEnv(), model: "", effort: "low", prompt: "", briefPath: "", toolArgs: [],
      onEvent: () => {}, requestInput: async () => ({ cancelled: true }),
    }, (result) => { models = cursorCatalog(result); });
    const timeout = setTimeout(() => { void session.stop(); }, 12000);
    try { await session.completion; } finally { clearTimeout(timeout); }
    return models;
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

export interface ACPTransport {
  id: "copilot" | "dsh";
  name: string;
  args: string[];
}

export function startStandardACPSession(transport: ACPTransport, options: AgentSessionOptions): AgentSession {
  return runCursorSession(options, undefined, transport);
}

export async function probeStandardACPCatalog(
  transport: ACPTransport,
  command: Command,
  probeOptions?: { strictStdout?: boolean },
): Promise<ModelOption[]> {
  const cwd = await mkdtemp(join(tmpdir(), `memcode-${transport.id}-catalog-`));
  let models: ModelOption[] = [];
  let inspected = false;
  let stdoutNoiseError: string | undefined;
  try {
    const session = runCursorSession({
      command,
      cwd,
      env: childEnv(),
      model: "",
      effort: "low",
      prompt: "",
      briefPath: "",
      toolArgs: [],
      onEvent: (event) => {
        if (probeOptions?.strictStdout && event.type === "error" && !stdoutNoiseError) {
          stdoutNoiseError = event.message;
        }
      },
      requestInput: async () => ({ cancelled: true }),
    }, (result) => {
      inspected = true;
      models = standardACPCatalog(result);
    }, transport, probeOptions?.strictStdout === true);
    const timer = setTimeout(() => { void session.stop(); }, 25000);
    try {
      const result = await session.completion;
      if (result.exitCode !== 0) throw Error(result.error || `${transport.name}'s model catalog did not respond.`);
      if (probeOptions?.strictStdout) {
        if (stdoutNoiseError) throw Error(stdoutNoiseError);
        if (!inspected) throw Error(`${transport.name}'s model catalog did not respond cleanly.`);
        if (models.length === 0) throw Error(`${transport.name} returned an empty model catalog.`);
      }
    } finally { clearTimeout(timer); }
    return models;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** A JSON-RPC 2.0 request, notification or response, as ACP sends them. */
function isJsonRpcMessage(message: Json): boolean {
  if (message.jsonrpc !== "2.0") return false;
  if (typeof message.method === "string") return true;
  return hasId(message) && ("result" in message || "error" in message);
}

function runCursorSession(
  options: AgentSessionOptions,
  inspect?: (session: Json) => void,
  transport?: ACPTransport,
  /** Treat any stdout line that is not a JSON-RPC message as an error. */
  strictStdout = false,
): AgentSession {
  const brand = transport?.name ?? "Cursor";
  // Current ACP ignores --auto-review even though interactive Cursor supports it.
  // Never silently run an allowlist/bypass session labelled as Smart auto.
  if (options.permissionMode === "auto")
    throw Error(
      "This installed Cursor ACP transport does not support Smart auto. Choose Review or Full access, or use Codex/Claude for native automatic review.",
    );
  // Existing profile/plugin arguments are retained; the selected mode owns permissions.
  const toolArgs: string[] = [];
  const inheritedArgs = withoutPermissionArgs("cursor", options.toolArgs);
  for (let i = 0; i < inheritedArgs.length; i++) {
    const arg = inheritedArgs[i];
    if (
      [
        "--force",
        "--yolo",
        "--auto-review",
        "-f",
        "-p",
        "--print",
        "--stream-partial-output",
      ].includes(arg)
    )
      continue;
    if (arg === "--output-format") {
      i++;
      continue;
    }
    if (arg.startsWith("--output-format=")) continue;
    toolArgs.push(arg);
  }
  const child = spawn(
    options.command.command,
    transport ? [...options.command.prefix, ...transport.args, ...toolArgs] : [
      ...options.command.prefix,
      ...toolArgs,
      ...(options.permissionMode === "full-access"
        ? ["--force", "--sandbox", "disabled"]
        : []),
      "--workspace",
      options.cwd,
      "acp",
    ],
    {
      cwd: options.cwd,
      env: { ...options.env, ...options.command.env },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let loadingHistory = !!options.resumeSessionId;
  let sessionId = options.resumeSessionId ?? "",
    nextId = 0,
    stderr = "",
    messageNumber = 0,
    assistantId: string | undefined,
    ended = false,
    stopped = false;
  let settle!: (value: { exitCode: number | null; error?: string }) => void;
  const completion = new Promise<{ exitCode: number | null; error?: string }>(
    (resolve) => {
      settle = resolve;
    },
  );
  const pending = new Map<
    RpcId,
    {
      method: string;
      resolve(value: Json): void;
      reject(error: Error): void;
      timer?: NodeJS.Timeout;
    }
  >();
  const inputs = new Map<RpcId, () => void>();
  const toolTitles = new Map<string, string>();
  const emit = options.onEvent;
  const flush = () => {
    assistantId = undefined;
  };
  const write = (message: Json) => {
    if (child.stdin?.writable && !child.stdin.destroyed)
      child.stdin.write(JSON.stringify(message) + "\n");
  };
  const respond = (id: RpcId, result: Json) =>
    write({ jsonrpc: "2.0", id, result });
  const request = (
    method: string,
    params: Json,
    timeoutMs = 30_000,
  ): Promise<Json> =>
    new Promise((resolve, reject) => {
      if ((ended || stopped) && method !== "session/close") {
        reject(Error(`${brand} session is closed.`));
        return;
      }
      const id = ++nextId;
      const timer = timeoutMs
        ? setTimeout(() => {
            pending.delete(id);
            reject(Error(`${brand} did not answer ${method} in time.`));
          }, timeoutMs)
        : undefined;
      pending.set(id, { method, resolve, reject, timer });
      write({ jsonrpc: "2.0", id, method, params });
    });
  const rejectPending = (reason: string) => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(Error(reason));
    }
    pending.clear();
  };
  const shutdown = async () => {
    for (const cancel of [...inputs.values()]) cancel();
    if (sessionId && stopped)
      write({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      });
    if (transport?.id === "dsh" && sessionId && child.exitCode === null)
      await request("session/close", { sessionId }, 5000).catch(() => {});
    child.stdin?.end();
    if (child.exitCode !== null || child.signalCode !== null || !child.pid)
      return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      new Promise<void>((done) => child.once("close", () => done())),
      new Promise<void>((done) => {
        timer = setTimeout(done, 750);
      }),
    ]);
    clearTimeout(timer);
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      await execute(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000, maxBuffer: 16000 },
      ).catch(() => {
        child.kill();
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      // The owned process group includes a possible npm launcher/native child.
      const hard = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }, 1000);
      hard.unref();
      child.once("close", () => clearTimeout(hard));
    }
  };
  const finish = async (value: { exitCode: number | null; error?: string }) => {
    if (ended) return;
    ended = true;
    flush();
    rejectPending(value.error ?? `${brand} turn completed.`);
    await shutdown();
    lines.close();
    settle(value);
  };
  const ask = async (
    id: RpcId,
    prompt: WorkerInputPrompt,
    convert: (response: WorkerInputResponse) => Json,
  ) => {
    flush();
    const controller = new AbortController();
    if (inputs.has(id)) {
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Duplicate pending request id." },
      });
      return;
    }
    const cancel = () => {
      if (inputs.get(id) !== cancel) return;
      inputs.delete(id);
      controller.abort();
      respond(id, { outcome: { outcome: "cancelled" } });
    };
    inputs.set(id, cancel);
    emit({ type: "activity", label: prompt.title, phase: "waiting" });
    try {
      const answer = await options.requestInput(prompt, controller.signal);
      if (inputs.get(id) !== cancel) return; // A stale answer never targets a reused native id.
      inputs.delete(id);
      respond(
        id,
        answer.cancelled || stopped
          ? { outcome: { outcome: "cancelled" } }
          : convert(answer),
      );
      emit({
        type: "activity",
        label: inputs.size
          ? `${brand} needs your input.`
          : `${brand} is continuing…`,
        phase: inputs.size ? "waiting" : "working",
      });
    } catch {
      cancel();
    }
  };
  const permission = (id: RpcId, params: Json) => {
    const tool = record(params.toolCall),
      choices = array(params.options);
    if (transport && options.permissionMode === "full-access") {
      const allow = choices.find(choice => choice.kind === "allow_once");
      respond(id, { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } });
      return;
    }
    return ask(
      id,
      {
        kind: "approval",
        title: text(tool.title) || `${brand} needs permission`,
        toolName: text(tool.name) || text(tool.kind) || undefined,
        description: text(tool.kind)
          ? `Review this ${tool.kind} action before it runs.`
          : undefined,
        details:
          [
            contentText(tool.content),
            tool.rawInput ? JSON.stringify(tool.rawInput, null, 2) : "",
          ]
            .filter(Boolean)
            .join("\n\n") || undefined,
        options: choices.map((choice) => ({
          id: text(choice.optionId),
          label: text(choice.name) || text(choice.optionId),
          kind: permissionKind(text(choice.kind)),
        })),
      },
      (answer) =>
        choices.some((choice) => choice.optionId === answer.optionId)
          ? { outcome: { outcome: "selected", optionId: answer.optionId } }
          : { outcome: { outcome: "cancelled" } },
    );
  };
  const question = (id: RpcId, params: Json) => {
    const questions = array(params.questions);
    return ask(
      id,
      {
        kind: "question",
        title: text(params.title) || `A question from ${brand}`,
        questions: questions.map((question) => ({
          id: text(question.id),
          question: text(question.prompt),
          multiple: question.allowMultiple === true,
          allowText: false,
          options: array(question.options).map((choice) => ({
            id: text(choice.id),
            label: text(choice.label) || text(choice.id),
          })),
        })),
      },
      (answer) => {
        const answers = questions.map((question) => {
          const raw = answer.answers?.[question.id],
            selected = typeof raw === "string" ? [raw] : (raw ?? []);
          const valid =
            selected.length > 0 &&
            (question.allowMultiple === true || selected.length === 1) &&
            selected.every((id) =>
              array(question.options).some((choice) => choice.id === id),
            );
          return valid
            ? { questionId: question.id, selectedOptionIds: selected }
            : null;
        });
        return answers.some((answer) => !answer)
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: { outcome: "answered", answers } };
      },
    );
  };
  const plan = (id: RpcId, params: Json) =>
    ask(
      id,
      {
        kind: "plan",
        title: text(params.name) || `Review ${brand}’s plan`,
        description: text(params.overview) || undefined,
        details: text(params.plan),
        options: [
          { id: "accept", label: "Approve plan", kind: "allow-once" },
          { id: "reject", label: "Request a different plan", kind: "deny" },
        ],
      },
      (answer) => ({
        outcome:
          answer.optionId === "accept"
            ? { outcome: "accepted" }
            : answer.optionId === "reject"
              ? { outcome: "rejected", reason: "Plan rejected in MemCode." }
              : { outcome: "cancelled" },
      }),
    );

  let liveConfig: Json[] = [];
  let liveModel: string | undefined;
  const update = (params: Json) => {
    if (sessionId && params.sessionId && params.sessionId !== sessionId) return;
    const event = record(params.update);
    if (event.sessionUpdate === "config_option_update") {
      liveConfig = array(event.configOptions);
      const measured = transport ? standardModelMeasurement(transport.id, liveConfig, liveModel) : cursorSessionModel(liveConfig, liveModel);
      if (measured) emit(measured);
    } else if (event.sessionUpdate === "agent_thought_chunk") {
      const label = text(event.content?.text).trim().slice(-500);
      if (label) emit({ type: "activity", label, phase: "working" });
    } else if (event.sessionUpdate === "agent_message_chunk") {
      const content = record(event.content);
      const delta =
        content.type === "text"
          ? text(content.text)
          : content.type === "resource_link"
            ? `[${text(content.name) || text(content.uri)}](${text(content.uri)})`
            : "";
      if (delta) {
        assistantId ??= `${transport?.id ?? "cursor"}:${sessionId}:${++messageNumber}`;
        emit({
          type: "message",
          role: "assistant",
          text: delta,
          delta: true,
          messageId: assistantId,
        });
      }
    } else if (
      ["tool_call", "tool_call_update"].includes(event.sessionUpdate)
    ) {
      flush();
      const id = text(event.toolCallId),
        title =
          text(event.title) ||
          text(event.name) ||
          toolTitles.get(id) ||
          `${brand} tool`;
      toolTitles.set(id, title);
      const finished = event.status === "failed" || event.status === "completed";
      if (id) emit({ type: "activity", label: title, toolId: id, phase: "tool",
        ...(finished ? { toolResult: event.status } : {}) });
      if (finished) toolTitles.delete(id);
      const output = contentText(event.content).slice(-10000);
      if (event.status === "failed") {
        const message = `${title} failed${output ? ": " + output : "."}`;
        emit({ type: "error", message, fatal: false });
        emit({ type: "message", role: "tool", text: message });
      } else if (event.status === "completed" && output)
        emit({ type: "message", role: "tool", text: `${title}\n${output}` });
    }
  };
  const incoming = (message: Json) => {
    if (!message.method && hasId(message)) {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error)
        call.reject(
          Error(
            `${brand} ${call.method}: ${text(message.error.message) || "ACP request failed."}`,
          ),
        );
      else call.resolve(record(message.result));
      return;
    }
    // ACP load replays the entire conversation. These messages are already on the story.
    if (loadingHistory && !hasId(message)) return;
    if (message.method === "session/update") {
      update(record(message.params));
      return;
    }
    if (!hasId(message)) {
      if (message.method === "cursor/update_todos") {
        const todos = array(message.params?.todos);
        const active = todos.find((todo) => todo.status === "in_progress");
        if (active)
          emit({
            type: "activity",
            label: text(active.content),
            phase: "working",
          });
      }
      return;
    }
    if (ended || stopped || loadingHistory) {
      respond(message.id, { outcome: { outcome: "cancelled" } });
      return;
    }
    const params = record(message.params);
    if (sessionId && params.sessionId && params.sessionId !== sessionId) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "Wrong session." },
      });
      return;
    }
    if (message.method === "session/request_permission")
      void permission(message.id, params);
    else if (message.method === "cursor/ask_question")
      void question(message.id, params);
    else if (message.method === "cursor/create_plan")
      void plan(message.id, params);
    else
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Unsupported client method." },
      });
  };
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    try {
      const message = record(JSON.parse(line));
      // JSON log lines such as {"message":"starting"} are ignored by incoming();
      // a strict probe must still see that stdout is not a clean ACP stream.
      if (strictStdout && !isJsonRpcMessage(message)) {
        emit({
          type: "error",
          message: `${brand} wrote a JSON line that is not an ACP message to stdout.`,
          fatal: false,
        });
        return;
      }
      incoming(message);
    } catch {
      emit({
        type: "error",
        message: `${brand} emitted an unreadable ACP message.`,
        fatal: false,
      });
    }
  });
  child.stdin?.on("error", () => {});
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderr = (stderr + (options.resumeSessionId
      ? text.replaceAll(options.resumeSessionId, "[saved conversation]")
      : text)).slice(-16000);
  });
  child.once("error", (error) => {
    void finish({ exitCode: null, error: error.message });
  });
  child.once("close", (code) => {
    if (!ended)
      void finish({
        exitCode: code,
        ...(stopped
          ? {}
          : {
              error:
                stderr.trim() || `${brand} exited before completing this turn.`,
            }),
      });
  });

  void (async () => {
    try {
      emit({
        type: "activity",
        label: `Connecting to ${brand}…`,
        phase: "working",
      });
      const initialized = await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "memcode", version: appVersion },
      });
      if (
        array(initialized.authMethods).some(
          (method) => method.id === "cursor_login",
        )
      )
        await request("authenticate", { methodId: "cursor_login" });
      const context = {
        cwd: options.cwd,
        // Copilot receives scoped stdio tools through --additional-mcp-config.
        // Sending them again over ACP causes the provider to reject them.
        mcpServers: transport?.id === "copilot" ? [] : await sessionServers(options.contextConfig),
      };
      let session: Json;
      if (options.resumeSessionId !== undefined) {
        const resume = initialized.agentCapabilities?.sessionCapabilities?.resume != null;
        if (!sessionId || (!resume && initialized.agentCapabilities?.loadSession !== true))
          throw Error(`This ${brand} CLI cannot reopen the previous ${brand} conversation.`);
        try {
          // ACP acknowledges the requested ID with an empty or config-only load result.
          session = await request(resume ? "session/resume" : "session/load", { ...context, sessionId });
        } catch {
          throw Error(`Could not load the previous ${brand} conversation on this computer.`);
        }
        if (session.sessionId !== undefined && session.sessionId !== sessionId)
          throw Error(`${brand} did not confirm the previous ${brand} conversation.`);
        session = { ...session, sessionId };
        loadingHistory = false;
      } else {
        session = await request("session/new", context);
        sessionId = text(session.sessionId);
      }
      if (!sessionId) throw Error(`${brand} did not return a session identity.`);
      if (inspect) {
        inspect(session);
        await finish({ exitCode: 0 });
        return;
      }
      emit({ type: "session", sessionId });
      const selected = transport
        ? await selectStandardACPModel(session, options.model, request, brand)
        : await selectCursorModel(session, options.model, request, options.automaticModelTier);
      let config = selected.config;
      const legacyModel = selected.legacyModel;
      liveConfig = config;
      liveModel = legacyModel;
      if (selected.alternative)
        emit({ type: "message", role: "system", text: selected.alternative });
      const effort = config.find(
        (option) =>
          option.category === "thought_level" ||
          /effort|reasoning/i.test(text(option.id)),
      );
      const effortChoices = array(effort?.options).flatMap((option) =>
        Array.isArray(option.options) ? array(option.options) : [option],
      );
      const choice = effortChoices.find(
        (choice) => String(choice.value).toLowerCase() === options.effort,
      );
      if (effort && choice && effort.currentValue !== choice.value) {
        const selected = await request("session/set_config_option", {
          sessionId,
          configId: effort.id,
          value: choice.value,
        });
        config = array(selected.configOptions);
      }
      const modelMeasurement = transport
        ? standardModelMeasurement(transport.id, config, legacyModel)
        : cursorSessionModel(config, legacyModel);
      if (options.calibratedModel) {
        const confirmed = config.find(option => option.category === "model" || option.id === "model")?.currentValue ?? legacyModel;
        assertCalibratedConfiguration(options, confirmed === options.model ? modelMeasurement?.model?.id : undefined,
          modelMeasurement?.model?.effort);
      }
      if (modelMeasurement) emit(modelMeasurement);
      if (
        session.modes?.currentModeId !== "agent" &&
        array(session.modes?.availableModes).some((mode) => mode.id === "agent")
      )
        await request("session/set_mode", { sessionId, modeId: "agent" });
      emit({ type: "activity", label: `${brand} is working…`, phase: "working" });
      emit({ type: "prompted" });
      const result = await request(
        "session/prompt",
        {
          sessionId,
          prompt: acpPrompt(
            options,
            initialized.agentCapabilities?.promptCapabilities?.image === true,
          ),
        },
        0,
      );
      // Installed Cursor ACP reports logical completion but omits native token
      // usage. Do not substitute context occupancy or requested-model estimates.
      const reason = text(result.stopReason);
      if (reason && !["end_turn", "cancelled"].includes(reason)) {
        emit({
          type: "error",
          message: `${brand} stopped: ${reason}.`,
          fatal: false,
        });
        await finish({ exitCode: 1, error: `${brand} stopped: ${reason}.` });
      } else await finish({ exitCode: reason === "cancelled" ? null : 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!stopped && !ended) emit({ type: "error", message, fatal: true });
      await finish({
        exitCode: stopped ? null : 1,
        ...(stopped ? {} : { error: message }),
      });
    }
  })();
  return {
    child,
    completion,
    stop: async () => {
      stopped = true;
      await finish({ exitCode: null });
    },
  };
}

/** The prompt, with the request's images when the worker says it takes images. */
export function acpPrompt(
  options: Pick<AgentSessionOptions, "prompt" | "images" | "localModel">,
  takesImages: boolean,
) {
  const images =
    takesImages && !options.localModel ? (options.images ?? []) : [];
  return [
    { type: "text" as const, text: options.prompt },
    ...images.flatMap((image) => {
      const data = imageData(image);
      return data
        ? [{ type: "image" as const, mimeType: image.mime, data }]
        : [];
    }),
  ];
}
