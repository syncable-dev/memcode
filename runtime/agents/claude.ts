import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import type { ModelOption } from "../../src/shared";
import { childEnv, type Command } from "../commands";
import { claudeCatalog, selectClaudeModel } from "./claude-models";
import { stripVTControlCharacters } from "node:util";
import { claudeProfileArgs } from "../context/profile";
import type {
  WorkerInputPrompt,
  WorkerInputResponse,
} from "../../src/worker-input";
import type { AgentSession, AgentSessionOptions } from "./types";
import { withoutPermissionArgs } from "./permissions";
import { ClaudeMeasurements } from "./claude-measurements";

type Frame = Record<string, any>;
const bounded = (value: unknown, limit = 16000): string =>
  (typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "")
  ).slice(0, limit);
const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part?.type === "text")
          .map((part) => part.text)
          .join("\n")
      : bounded(content);

/** Native SDK protocol:
 * https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py
 * https://code.claude.com/docs/en/agent-sdk/user-input
 * Keep stdin open: can_use_tool requests resume only after their matching response.
 */
export function startClaudeSession(options: AgentSessionOptions): AgentSession {
  return runClaudeSession(options);
}

export async function probeClaudeCatalog(command: Command): Promise<ModelOption[]> {
  let models: ModelOption[] = [];
  const session = runClaudeSession({
    command, cwd: tmpdir(), env: childEnv(), model: "", effort: "low", prompt: "", briefPath: "",
    toolArgs: ["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence"],
    onEvent: () => {}, requestInput: async () => ({ cancelled: true }),
  }, (offered) => { models = offered; });
  const timer = setTimeout(() => { void session.stop(); }, 10_000);
  try { await session.completion; } finally { clearTimeout(timer); }
  return models;
}

function runClaudeSession(options: AgentSessionOptions, inspect?: (models: ModelOption[]) => void): AgentSession {
  if (options.localModel)
    throw Error("The local-model option currently supports Codex with Ollama.");
  const nativeMode =
    options.permissionMode === "full-access"
      ? "bypassPermissions"
      : options.permissionMode === "auto"
        ? "auto"
        : "acceptEdits";
  const profile = options.contextConfig
    ? claudeProfileArgs(options.contextConfig)
    : [];
  const tools = profile.indexOf("--tools");
  if (tools >= 0)
    profile[tools + 1] += ",AskUserQuestion,EnterPlanMode,ExitPlanMode";
  const child = spawn(
    options.command.command,
    [
      ...options.command.prefix,
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      nativeMode,
      ...(options.model && options.model !== "default" ? ["--effort", options.effort, "--model", options.model] : []),
      ...profile,
      ...withoutPermissionArgs("claude", options.toolArgs),
    ],
    {
      cwd: options.cwd,
      env: {
        ...options.env,
        ...options.command.env,
        CLAUDE_CODE_SDK_READS_SESSION_STATE: "1",
      },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const initId = randomUUID();
  const pending = new Map<string, AbortController>();
  const toolNames = new Map<string, string>();
  const background = new Set<string>();
  let initialized = false,
    closed = false,
    inputEnded = false,
    stopping = false;
  let lastAssistant = "",
    stderr = "",
    failure: string | undefined;
  let state: string | undefined;
  let result: { exitCode: number; error?: string } | undefined;
  let shutdownTimer: NodeJS.Timeout | undefined;
  let runEndTimer: NodeJS.Timeout | undefined;
  let resolveCompletion!: (result: {
    exitCode: number | null;
    error?: string;
  }) => void;
  const completion = new Promise<{ exitCode: number | null; error?: string }>(
    (resolve) => {
      resolveCompletion = resolve;
    },
  );
  const emit = options.onEvent;
  const measurements = new ClaudeMeasurements();
  const activity = (
    label: string,
    phase: "working" | "tool" | "waiting" | "finishing",
    toolId?: string,
  ) => emit({ type: "activity", label, phase, ...(toolId ? { toolId } : {}) });
  const write = (frame: Frame) => {
    if (closed || inputEnded || child.stdin!.destroyed) return;
    child.stdin!.write(JSON.stringify(frame) + "\n");
  };
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32" && child.pid) {
      const killer = spawn(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore", shell: false },
      );
      killer.once("error", () => child.kill());
      killer.once("close", (code) => {
        if (code !== 0) child.kill();
      });
    } else {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
    }
  };
  const abortInputs = () => {
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  };
  const endInput = () => {
    if (inputEnded || closed) return;
    inputEnded = true;
    clearTimeout(runEndTimer);
    child.stdin!.end();
    shutdownTimer = setTimeout(terminate, 2000);
    shutdownTimer.unref();
  };
  const endWhenIdle = () => {
    if (!result || pending.size || background.size || stopping) return;
    if (state === undefined || state === "idle" || result.error) endInput();
    else if (!runEndTimer) {
      // Match the SDK's bounded wait between turns; a local subagent may wake its parent.
      runEndTimer = setTimeout(endInput, 600000);
      runEndTimer.unref();
    }
  };
  const fail = (message: string) => {
    if (closed || failure) return;
    failure = message;
    emit({ type: "error", message, fatal: true });
    abortInputs();
    endInput();
    terminate();
  };
  const initTimeout = setTimeout(
    () =>
      fail("Claude Code did not initialize its interactive control channel."),
    30000,
  );
  initTimeout.unref();

  const answerQuestions = (
    input: Frame,
    response: WorkerInputResponse,
  ): Frame => {
    const answers: Record<string, string | string[]> = {};
    for (const [index, question] of input.questions.entries()) {
      const value = response.answers?.[`question-${index}`];
      if (
        value === undefined ||
        (Array.isArray(value) ? !value.length : !value.trim())
      )
        return {
          behavior: "deny",
          message: "The user did not answer every question.",
        };
      const selected = Array.isArray(value) ? value : [value];
      if (!question.multiSelect && selected.length > 1)
        return {
          behavior: "deny",
          message: "This question accepts one answer.",
        };
      const labels = selected.map((answer) => {
        const match = /^option-(\d+)$/.exec(answer);
        return match && question.options?.[Number(match[1])]
          ? String(question.options[Number(match[1])].label)
          : answer;
      });
      answers[question.question] = question.multiSelect ? labels : labels[0];
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  };
  const handleControl = async (frame: Frame) => {
    const id = frame.request_id;
    if (typeof id !== "string" || pending.has(id)) return;
    const request = frame.request ?? {};
    if (request.subtype !== "can_use_tool") {
      write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: id,
          error: `Unsupported Claude control request: ${String(request.subtype)}`,
        },
      });
      return;
    }
    const name = String(request.tool_name ?? "Tool");
    const input =
      request.input && typeof request.input === "object" ? request.input : {};
    const controller = new AbortController();
    pending.set(id, controller);
    clearTimeout(runEndTimer);
    runEndTimer = undefined;
    const isQuestion = name === "AskUserQuestion";
    const prompt: WorkerInputPrompt = isQuestion
      ? {
          kind: "question",
          title: request.title || "Claude needs your input",
          toolName: name,
          questions: (Array.isArray(input.questions)
            ? input.questions
            : []
          ).map((question: Frame, index: number) => ({
            id: `question-${index}`,
            question: String(question.question ?? ""),
            multiple: question.multiSelect === true,
            allowText: true,
            options: (Array.isArray(question.options)
              ? question.options
              : []
            ).map((option: Frame, optionIndex: number) => ({
              id: `option-${optionIndex}`,
              label: String(option.label ?? ""),
              ...(option.description
                ? { description: String(option.description) }
                : {}),
            })),
          })),
        }
      : {
          kind: name === "ExitPlanMode" ? "plan" : "approval",
          title:
            request.title ||
            (name === "ExitPlanMode"
              ? "Review Claude’s plan"
              : `Allow Claude to use ${name}?`),
          toolName: name,
          description: bounded(
            request.description ||
              request.decision_reason ||
              "This request is waiting in the running Claude session.",
          ),
          details: bounded(
            name === "ExitPlanMode"
              ? input.plan || lastAssistant || input
              : input,
          ),
          options: [
            {
              id: "allow-once",
              label: name === "ExitPlanMode" ? "Approve plan" : "Allow once",
              kind: "allow-once",
            },
            {
              id: "deny",
              label: name === "ExitPlanMode" ? "Request changes" : "Deny",
              kind: "deny",
            },
          ],
        };
    activity(
      isQuestion ? "Waiting for your answer" : "Waiting for your approval",
      "waiting",
      request.tool_use_id,
    );
    let decision: Frame;
    try {
      if (isQuestion && !prompt.questions?.length)
        throw Error("Claude sent an empty question request.");
      const response = await options.requestInput(prompt, controller.signal);
      decision = response.cancelled
        ? { behavior: "deny", message: "The user cancelled this request." }
        : isQuestion
          ? answerQuestions(input, response)
          : response.optionId === "allow-once"
            ? { behavior: "allow", updatedInput: input }
            : {
                behavior: "deny",
                message:
                  "The user declined this request. Ask for clarification or adjust the approach.",
              };
    } catch (error) {
      decision = {
        behavior: "deny",
        message: `Unable to collect user input: ${(error as Error).message}`,
      };
    }
    if (controller.signal.aborted || closed || inputEnded) return;
    pending.delete(id);
    write({
      type: "control_response",
      response: { subtype: "success", request_id: id, response: decision },
    });
    activity(
      pending.size ? "Waiting for your input" : "Claude is continuing",
      pending.size ? "waiting" : "working",
    );
    endWhenIdle();
  };
  const observe = (frame: Frame) => {
    emit({ type: "raw", event: frame });
    const measurement = measurements.observe(frame);
    if (measurement) emit(measurement);
    if (typeof frame.session_id === "string")
      emit({ type: "session", sessionId: frame.session_id });
    if (frame.type === "control_request") {
      void handleControl(frame).catch((error) =>
        fail(`Claude control request failed: ${(error as Error).message}`),
      );
      return;
    }
    if (frame.type === "control_cancel_request") {
      const controller = pending.get(frame.request_id);
      controller?.abort();
      pending.delete(frame.request_id);
      if (!pending.size) activity("Claude is continuing", "working");
      endWhenIdle();
      return;
    }
    if (
      frame.type === "control_response" &&
      frame.response?.request_id === initId
    ) {
      if (initialized) return;
      clearTimeout(initTimeout);
      if (frame.response.subtype !== "success") {
        fail(bounded(frame.response.error || "Claude initialization failed."));
        return;
      }
      if (closed || stopping || inputEnded || child.stdin!.destroyed) return;
      initialized = true;
      const offered = claudeCatalog(frame.response.response?.models);
      if (inspect) {
        inspect(offered);
        result = { exitCode: 0 };
        endInput();
        return;
      }
      if (options.model && options.model !== "default") {
        try { selectClaudeModel(offered, options.model, true); }
        catch (error) { fail(error instanceof Error ? error.message : String(error)); return; }
      }
      emit({ type: "prompted" });
      write({
        type: "user",
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: options.prompt },
      });
      activity("Claude is working", "working");
      return;
    }
    if (frame.type === "system") {
      if (frame.subtype === "status" && frame.status === "compacting")
        activity("Compacting the conversation", "working");
      if (
        options.permissionMode &&
        options.permissionMode !== "review" &&
        (frame.subtype === "init" ||
          (frame.subtype === "status" &&
            ["default", "manual"].includes(frame.permissionMode))) &&
        frame.permissionMode !== nativeMode
      ) {
        fail(
          `Claude did not activate the selected ${options.permissionMode} permission mode (reported ${frame.permissionMode ?? "unknown"}). Choose a supported mode or check the model and administrator policy.`,
        );
        return;
      }
      if (frame.subtype === "session_state_changed") state = frame.state;
      if (
        frame.subtype === "task_started" &&
        ["local_agent", "local_workflow"].includes(frame.task_type)
      )
        background.add(frame.task_id);
      if (
        frame.subtype === "task_notification" &&
        ["completed", "failed", "stopped"].includes(frame.status)
      )
        background.delete(frame.task_id);
      endWhenIdle();
    }
    if (frame.type === "stream_event") {
      const block = frame.event?.content_block;
      if (frame.event?.type === "message_start") {
        clearTimeout(runEndTimer);
        runEndTimer = undefined;
        result = undefined;
      }
      if (
        frame.event?.type === "content_block_start" &&
        block?.type === "tool_use"
      ) {
        toolNames.set(block.id, block.name);
        activity(`Using ${block.name}`, "tool", block.id);
      }
    }
    if (frame.type === "assistant") {
      const content = frame.message?.content;
      const text = contentText(content);
      if (text && text !== lastAssistant) {
        lastAssistant = text;
        emit({
          type: "message",
          role: "assistant",
          text: bounded(text, 30000),
        });
      }
      for (const block of Array.isArray(content) ? content : [])
        if (block.type === "tool_use") {
          toolNames.set(block.id, block.name);
          activity(`Using ${block.name}`, "tool", block.id);
          emit({
            type: "message",
            role: "tool",
            text: `${block.name}\n${bounded(block.input)}`,
          });
        }
    }
    if (frame.type === "user" && Array.isArray(frame.message?.content)) {
      for (const block of frame.message.content)
        if (block.type === "tool_result") {
          const name = toolNames.get(block.tool_use_id) || "Tool";
          const text = contentText(block.content);
          emit({
            type: "message",
            role: "tool",
            text: `${name}${block.is_error ? " failed" : " result"}\n${bounded(text)}`,
          });
          if (block.is_error)
            emit({
              type: "error",
              message: `${name}: ${bounded(text)}`,
              fatal: false,
            });
          emit({ type: "activity", label: name, toolId: block.tool_use_id,
            phase: "tool", toolResult: block.is_error ? "failed" : "completed" });
          toolNames.delete(block.tool_use_id);
        }
    }
    if (frame.type === "error")
      fail(
        bounded(
          frame.error?.message ||
            frame.error ||
            frame.message ||
            "Claude Code reported an error.",
        ),
      );
    if (frame.type === "result") {
      const error =
        frame.is_error || String(frame.subtype).startsWith("error")
          ? bounded(
              frame.errors?.join("\n") ||
                frame.result ||
                "Claude Code reported an unsuccessful result.",
            )
          : undefined;
      const text = typeof frame.result === "string" ? frame.result : "";
      if (!error && text && text !== lastAssistant) {
        lastAssistant = text;
        emit({
          type: "message",
          role: "assistant",
          text: bounded(text, 30000),
        });
      }
      if (error) {
        emit({ type: "error", message: error, fatal: true });
        abortInputs();
      }
      result = { exitCode: error ? 1 : 0, ...(error ? { error } : {}) };
      activity("Collecting Claude’s result", "finishing");
      endWhenIdle();
    }
  };
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    if (!line.trim() || closed) return;
    let frame: Frame;
    try {
      frame = JSON.parse(line);
    } catch {
      emit({
        type: "message",
        role: "tool",
        text: bounded(stripVTControlCharacters(line)),
      });
      return;
    }
    if (frame && typeof frame === "object") {
      try {
        observe(frame);
      } catch (error) {
        fail(`Claude protocol error: ${(error as Error).message}`);
      }
    }
  });
  child.stderr!.on("data", (data) => {
    const text = stripVTControlCharacters(String(data));
    stderr = (stderr + text).slice(-16000);
    if (text.trim())
      emit({
        type: "message",
        role: "tool",
        text: `Claude diagnostics\n${bounded(text)}`,
      });
  });
  child.stdin!.on("error", (error) => {
    if (!inputEnded && !closed)
      fail(`Claude input channel closed: ${error.message}`);
  });
  child.once("error", (error) => {
    failure = error.message;
    emit({ type: "error", message: failure, fatal: true });
  });
  child.once("close", (code) => {
    closed = true;
    abortInputs();
    lines.close();
    clearTimeout(initTimeout);
    clearTimeout(shutdownTimer);
    clearTimeout(runEndTimer);
    resolveCompletion(
      failure
        ? { exitCode: code, error: failure }
        : stopping
          ? { exitCode: code }
          : (result ?? {
              exitCode: code,
              error:
                (initialized
                  ? "Claude Code closed before returning a result."
                  : "Claude Code closed before initialization.") +
                (stderr ? "\n" + stderr : ""),
            }),
    );
  });
  child.once("spawn", () => {
    write({
      type: "control_request",
      request_id: initId,
      request: { subtype: "initialize", hooks: null },
    });
  });
  return {
    child,
    completion,
    stop: () => {
      if (closed || stopping) return;
      stopping = true;
      abortInputs();
      write({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "interrupt" },
      });
      endInput();
      terminate();
    },
  };
}
