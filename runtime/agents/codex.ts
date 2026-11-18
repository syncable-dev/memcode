import { spawn } from "node:child_process";
import { appVersion } from "../../src/version";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { childEnv, type Command } from "../commands";
import { readCodexCatalog, recordCodexModelFailure, selectCodexModel, type CodexCatalog } from "./codex-models";
import type { AgentSession, AgentSessionOptions } from "./types";
import type { ReasoningEffort } from "../../src/shared";
import type { ReportedTokenUsage } from "../../src/measurements";
import { withoutPermissionArgs } from "./permissions";
import type {
  WorkerInputOption,
  WorkerInputPrompt,
  WorkerInputQuestion,
} from "../../src/worker-input";

type Json = Record<string, any>;
type Id = string | number;

/** One native Codex turn, with the app-server transport kept open for human replies. */
export function startCodexSession(options: AgentSessionOptions): AgentSession {
  return runCodexSession(options);
}

/** Same app-server as the worker. Probe only the authenticated catalog; no thread or turn. */
export async function probeCodexCatalog(command: Command, refresh = false): Promise<CodexCatalog> {
  let catalog: CodexCatalog = { models: [] };
  const probe = runCodexSession({
    command, cwd: tmpdir(), env: childEnv(), model: "", effort: "low", prompt: "", briefPath: "", toolArgs: [],
    onEvent: () => {}, requestInput: async () => ({ cancelled: true }),
  }, (result) => { catalog = result; }, refresh);
  const timer = setTimeout(() => { void probe.stop(); }, 10_000);
  try { await probe.completion; } finally { clearTimeout(timer); }
  return catalog;
}

function runCodexSession(options: AgentSessionOptions, inspect?: (result: CodexCatalog) => void, refreshCatalog = false): AgentSession {
  const mode = options.permissionMode ?? "review";
  const policy = mode === "full-access" ? "never" : "on-request";
  const reviewer = mode === "auto" ? "auto_review" : "user";
  const child = spawn(
    options.command.command,
    [
      ...options.command.prefix,
      "app-server",
      "--stdio",
      "-c",
      "features.default_mode_request_user_input=true",
      ...withoutPermissionArgs("codex", options.toolArgs),
    ],
    {
      cwd: options.cwd,
      env: { ...options.env, ...options.command.env },
      windowsHide: true,
      stdio: "pipe",
    },
  );
  let nextId = 1,
    threadId = "",
    turnId = "",
    finished = false,
    stopped = false;
  let stderr = "",
    shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<
    number,
    {
      method: string;
      resolve(value: Json): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const inputs = new Map<Id, AbortController>();
  const resolvedInputs = new Set<Id>();
  const messageText = new Map<string, string>();
  const reportedModels = new Set<string>();
  const earlyTurnMeasurements: { method: string; params: Json }[] = [];
  let reportedEffort: ReasoningEffort | undefined;
  let threadOnlyUsage = false,
    latestUsage: ReportedTokenUsage | undefined;
  let settle!: (result: { exitCode: number | null; error?: string }) => void;
  const completion = new Promise<{ exitCode: number | null; error?: string }>(
    (resolve) => {
      settle = resolve;
    },
  );
  const emit = options.onEvent;
  let catalog: CodexCatalog = { models: [] };
  let selected = options.model;
  let selectedEffort: string | undefined = options.effort;
  let attemptedModel = "";
  const modelFailure = (error: unknown) => {
    if (attemptedModel) recordCodexModelFailure(catalog, attemptedModel, error);
  };
  const modelMeasurement = (
    id: unknown,
    source: "codex-thread" | "codex-rerouted",
  ) => {
    if (typeof id !== "string" || !id.length || id.length > 256) return;
    if (reportedModels.size < 32) reportedModels.add(id);
    emit({
      type: "measurement",
      model: {
        id,
        source,
        ...(reportedEffort ? { effort: reportedEffort } : {}),
      },
      models: [...reportedModels],
    });
  };
  const counter = (value: unknown): number | null =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1e9
      ? value
      : null;
  const write = (packet: Json) => {
    if (child.stdin?.writable && !child.stdin.destroyed)
      child.stdin.write(JSON.stringify(packet) + "\n");
  };
  const finish = (result: { exitCode: number | null; error?: string }) => {
    if (finished) return;
    finished = true;
    for (const controller of inputs.values()) controller.abort();
    inputs.clear();
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(result.error || "Codex turn ended."));
    }
    pending.clear();
    child.stdin?.end();
    if (child.exitCode === null) {
      shutdownTimer = setTimeout(() => {
        child.kill();
      }, 1500);
      shutdownTimer.unref();
    }
    settle(result);
  };
  const request = (method: string, params: Json, timeoutMs = 45_000): Promise<Json> =>
    new Promise((resolve, reject) => {
      if (finished) {
        reject(new Error("Codex session has ended."));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex did not respond to ${method}.`));
      }, timeoutMs);
      timer.unref();
      pending.set(id, { method, resolve, reject, timer });
      write({ id, method, params });
    });
  const input = async (id: Id, prompt: WorkerInputPrompt) => {
    const controller = new AbortController();
    inputs.set(id, controller);
    emit({ type: "activity", phase: "waiting", label: prompt.title });
    try {
      return await options.requestInput(prompt, controller.signal);
    } finally {
      if (inputs.get(id) === controller) inputs.delete(id);
    }
  };
  const approval = async (id: Id, params: Json, file: boolean) => {
    const decisions: unknown[] =
      Array.isArray(params.availableDecisions) &&
      params.availableDecisions.length
        ? params.availableDecisions
        : ["accept", "acceptForSession", "decline", "cancel"];
    const labels: Record<string, [string, WorkerInputOption["kind"]]> = {
      accept: ["Allow once", "allow-once"],
      acceptForSession: ["Allow for this session", "allow-session"],
      decline: ["Deny", "deny"],
      cancel: ["Deny and stop turn", "deny"],
    };
    const choices = decisions.map((decision, index): WorkerInputOption => {
      const known = typeof decision === "string" ? labels[decision] : undefined;
      const amendment =
        typeof decision === "object" && decision ? (decision as Json) : {};
      return {
        id: `decision:${index}`,
        label:
          known?.[0] ||
          (amendment.acceptWithExecpolicyAmendment
            ? "Allow and save this command rule"
            : "Apply the proposed network rule"),
        kind: known?.[1] || "other",
        ...(!known ? { description: JSON.stringify(decision) } : {}),
      };
    });
    const response = await input(id, {
      kind: "approval",
      title: file
        ? "Codex wants to change files"
        : "Codex wants to run a command",
      toolName: file ? "fileChange" : "commandExecution",
      description: params.reason || undefined,
      details: [
        params.command,
        params.cwd && `Directory: ${params.cwd}`,
        params.grantRoot && `Write access: ${params.grantRoot}`,
      ]
        .filter(Boolean)
        .join("\n"),
      options: choices,
    });
    const selected = response.cancelled
      ? undefined
      : choices.findIndex((choice) => choice.id === response.optionId);
    // Unknown, cancelled, or stale UI choices never become an approval.
    const decision =
      selected !== undefined && selected >= 0
        ? decisions[selected]
        : decisions.includes("cancel")
          ? "cancel"
          : "decline";
    return { decision };
  };
  const questions = async (id: Id, params: Json) => {
    const source: Json[] = Array.isArray(params.questions)
      ? params.questions
      : [];
    const questions: WorkerInputQuestion[] = source.map((q) => ({
      id: q.id,
      question: q.question,
      options: (q.options || []).map((option: Json, index: number) => ({
        id: `answer:${index}`,
        label: option.label,
        description: option.description,
      })),
      allowText: q.isOther === true || !q.options?.length,
      multiple: q.multiple === true,
      secret: q.isSecret === true,
    }));
    const response = await input(id, {
      kind: "question",
      title: "Codex needs your input",
      questions,
    });
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const value = response.cancelled
        ? []
        : (response.answers?.[question.id] ?? []);
      const values = Array.isArray(value) ? value : [value];
      answers[question.id] = {
        answers: values
          .map(
            (value) =>
              question.options.find((option) => option.id === value)?.label ??
              value,
          )
          .filter(
            (value) =>
              question.allowText ||
              question.options.some((option) => option.label === value),
          ),
      };
    }
    return { answers };
  };
  const elicit = async (id: Id, params: Json) => {
    if (params.mode === "url") {
      const response = await input(id, {
        kind: "approval",
        title: "Codex needs an external action",
        description: params.message,
        details: params.url,
        options: [
          { id: "done", label: "I completed this action", kind: "allow-once" },
          { id: "decline", label: "Decline", kind: "deny" },
        ],
      });
      return {
        action: response.cancelled
          ? "cancel"
          : response.optionId === "done"
            ? "accept"
            : "decline",
        content: null,
      };
    }
    const schema = params.requestedSchema;
    const entries = Object.entries(schema?.properties || {}) as [
      string,
      Json,
    ][];
    if (
      !schema ||
      schema.type !== "object" ||
      !entries.length ||
      entries.some(
        ([, field]) =>
          !["string", "boolean", "integer", "number"].includes(field.type),
      )
    ) {
      emit({
        type: "error",
        message:
          "Codex requested an unsupported input form. The form was declined; no permission was granted.",
      });
      return { action: "decline", content: null };
    }
    const questions = entries.map(([name, field]): WorkerInputQuestion => ({
      id: name,
      question: field.title || field.description || name,
      allowText: !field.enum && field.type !== "boolean",
      secret: field.format === "password",
      options: (
        field.enum || (field.type === "boolean" ? [true, false] : [])
      ).map((value: unknown, index: number) => ({
        id: `field:${index}`,
        label: String(value),
      })),
    }));
    const response = await input(id, {
      kind: "question",
      title: "Codex needs your input",
      description: params.message,
      questions,
    });
    if (response.cancelled) return { action: "cancel", content: null };
    const content: Json = {};
    for (const [name, field] of entries) {
      const answer = response.answers?.[name];
      const value = Array.isArray(answer) ? answer[0] : answer;
      if (value === undefined || value === "") {
        if (schema.required?.includes(name))
          return { action: "decline", content: null };
        continue;
      }
      const question = questions.find((q) => q.id === name)!;
      const text =
        question.options.find((option) => option.id === value)?.label ?? value;
      if (field.type === "boolean") {
        if (!["true", "false"].includes(text))
          return { action: "decline", content: null };
        content[name] = text === "true";
      } else if (field.type === "number" || field.type === "integer") {
        const number = Number(text);
        if (
          !Number.isFinite(number) ||
          (field.type === "integer" && !Number.isInteger(number))
        )
          return { action: "decline", content: null };
        content[name] = number;
      } else content[name] = text;
      if (field.enum && !field.enum.includes(content[name]))
        return { action: "decline", content: null };
    }
    return { action: "accept", content };
  };
  const serverRequest = async (packet: Json) => {
    const id = packet.id as Id,
      params = packet.params || {};
    if (params.threadId && threadId && params.threadId !== threadId) {
      write({
        id,
        error: {
          code: -32602,
          message: "Request belongs to a different worker thread.",
        },
      });
      return;
    }
    try {
      let result: Json;
      switch (packet.method) {
        case "item/commandExecution/requestApproval":
          result = await approval(id, params, false);
          break;
        case "item/fileChange/requestApproval":
          result = await approval(id, params, true);
          break;
        case "item/tool/requestUserInput":
          result = await questions(id, params);
          break;
        case "mcpServer/elicitation/request":
          result = await elicit(id, params);
          break;
        case "item/permissions/requestApproval": {
          const response = await input(id, {
            kind: "approval",
            title: "Codex requests additional permissions",
            description: params.reason,
            details: JSON.stringify(params.permissions, null, 2),
            options: [
              { id: "once", label: "Allow for this turn", kind: "allow-once" },
              { id: "deny", label: "Deny", kind: "deny" },
            ],
          });
          result = {
            permissions:
              !response.cancelled && response.optionId === "once"
                ? params.permissions
                : {},
            scope: "turn",
          };
          break;
        }
        default:
          write({
            id,
            error: {
              code: -32601,
              message: `MemCode does not support ${packet.method}.`,
            },
          });
          return;
      }
      if (!finished && !stopped && !resolvedInputs.has(id))
        write({ id, result });
    } catch (error) {
      if (!finished && !stopped && !resolvedInputs.has(id))
        write({
          id,
          error: {
            code: -32603,
            message:
              error instanceof Error
                ? error.message
                : "Human input could not be collected.",
          },
        });
    }
  };
  const notification = (method: string, params: Json) => {
    if (params.threadId && threadId && params.threadId !== threadId) return;
    if (params.turnId && turnId && params.turnId !== turnId) return;
    const collaborationItem =
      ["item/started", "item/completed"].includes(method) &&
      ["collabAgentToolCall", "collabToolCall", "subAgentActivity"].includes(
        params.item?.type,
      );
    if (
      [
        "thread/tokenUsage/updated",
        "model/rerouted",
        "turn/completed",
      ].includes(method) ||
      collaborationItem
    ) {
      const scopedTurnId =
        method === "turn/completed" ? params.turn?.id : params.turnId;
      if (
        !threadId ||
        params.threadId !== threadId ||
        typeof scopedTurnId !== "string" ||
        !scopedTurnId
      )
        return;
      // A response and following notifications can arrive in one stdout chunk,
      // before the turn/start promise continuation sets the authoritative ID.
      if (!turnId) {
        if (earlyTurnMeasurements.length < 64)
          earlyTurnMeasurements.push({ method, params });
        return;
      }
      if (scopedTurnId !== turnId) return;
    }
    if (collaborationItem) {
      // Thread counters are not proof of tokens spent by separately spawned
      // agents. Keep the measured numbers and downgrade their coverage.
      if (!threadOnlyUsage) {
        threadOnlyUsage = true;
        if (latestUsage) {
          latestUsage = { ...latestUsage, scope: "main_loop" };
          emit({ type: "measurement", usage: latestUsage });
        }
      }
      if (
        params.item.type === "subAgentActivity" &&
        typeof params.item.model === "string" &&
        params.item.model.length <= 256 &&
        reportedModels.size < 32
      ) {
        reportedModels.add(params.item.model);
        emit({ type: "measurement", models: [...reportedModels] });
      }
    }
    if (method === "thread/started" && params.thread?.id) {
      threadId = params.thread.id;
      emit({ type: "session", sessionId: threadId });
    } else if (method === "turn/started") {
      // turn/start's response, rather than an unrelated notification, owns turnId.
    } else if (method === "model/rerouted") {
      if (
        typeof params.fromModel === "string" &&
        params.fromModel.length <= 256 &&
        reportedModels.size < 32
      )
        reportedModels.add(params.fromModel);
      // The reroute event confirms the model, but does not report its effort.
      reportedEffort = undefined;
      modelMeasurement(params.toModel, "codex-rerouted");
    } else if (method === "thread/tokenUsage/updated") {
      const total = params.tokenUsage?.total;
      if (!total || typeof total !== "object" || Array.isArray(total)) return;
      emit({
        type: "raw",
        event: {
          type: "native-token-usage",
          harness: "codex",
          inputTokens: counter(total.inputTokens),
          outputTokens: counter(total.outputTokens),
          cachedInputTokens: counter(total.cachedInputTokens),
          cacheWriteInputTokens: counter(total.cacheWriteInputTokens),
          reasoningOutputTokens: counter(total.reasoningOutputTokens),
          totalTokens: counter(total.totalTokens),
        },
      });
      const usage: ReportedTokenUsage = {
        inputTokens: counter(total.inputTokens),
        outputTokens: counter(total.outputTokens),
        cachedInputTokens: counter(total.cachedInputTokens),
        cacheCreationInputTokens: counter(total.cacheWriteInputTokens),
        reasoningOutputTokens: counter(total.reasoningOutputTokens),
        totalTokens: counter(total.totalTokens),
        scope: threadOnlyUsage ? "main_loop" : "attempt",
        source: "codex-thread-total" as const,
      };
      if (usage.inputTokens !== null || usage.outputTokens !== null) {
        latestUsage = usage;
        emit({ type: "measurement", usage });
      }
    } else if (method === "serverRequest/resolved") {
      resolvedInputs.add(params.requestId);
      inputs.get(params.requestId)?.abort();
      inputs.delete(params.requestId);
    } else if (method === "item/agentMessage/delta" && params.delta) {
      const id = params.itemId || "assistant";
      messageText.set(id, (messageText.get(id) || "") + params.delta);
      emit({
        type: "message",
        role: "assistant",
        text: params.delta,
        delta: true,
        messageId: id,
      });
    } else if (
      method === "item/completed" &&
      params.item?.type === "agentMessage"
    ) {
      const item = params.item,
        seen = messageText.get(item.id) || "";
      if (!seen && item.text)
        emit({
          type: "message",
          role: "assistant",
          text: item.text,
          messageId: item.id,
        });
      else if (item.text?.startsWith(seen) && item.text.length > seen.length)
        emit({
          type: "message",
          role: "assistant",
          text: item.text.slice(seen.length),
          delta: true,
          messageId: item.id,
        });
    } else if (["item/started", "item/completed"].includes(method) && params.item) {
      const item = params.item;
      if (item.id && !["reasoning", "agentMessage", "userMessage", "plan"].includes(item.type)) {
        const label = item.type === "commandExecution" ? "Running a command"
          : item.type === "fileChange" ? "Editing files" : item.tool || item.type;
        emit({
          type: "activity",
          toolId: item.id,
          phase: "tool",
          label,
          ...(method === "item/completed" ? {
            toolResult: item.error || ["failed", "declined", "cancelled"].includes(item.status) ||
              (typeof item.exitCode === "number" && item.exitCode !== 0) ? "failed" : "completed",
          } : {}),
        });
      }
    } else if (method === "turn/plan/updated") {
      const current = Array.isArray(params.plan)
        ? params.plan.find((step: Json) => step.status === "inProgress" && typeof step.step === "string")
        : undefined;
      if (current) emit({ type: "activity", phase: "working", label: current.step.slice(0, 160) });
      const text = (params.plan || [])
        .map(
          (step: Json) =>
            `${step.status === "completed" ? "[x]" : "[ ]"} ${step.step}`,
        )
        .join("\n");
      if (text)
        emit({ type: "message", role: "system", text: `Plan\n${text}` });
    } else if (method === "error") {
      if (params.willRetry === false) modelFailure(params.error);
      const message =
        params.error?.message || params.message || "Codex reported an error.";
      emit({ type: "error", message, fatal: params.willRetry === false });
    } else if (
      method === "turn/completed" &&
      (!turnId || params.turn?.id === turnId)
    ) {
      const turn = params.turn || {},
        error = turn.error?.message;
      if (turn.status === "failed") modelFailure(turn.error);
      finish(
        turn.status === "completed"
          ? { exitCode: 0 }
          : {
              exitCode: turn.status === "interrupted" ? 130 : 1,
              error: error || `Codex turn ${turn.status || "failed"}.`,
            },
      );
    }
  };
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    if (finished || !line.trim()) return;
    let packet: Json;
    try {
      packet = JSON.parse(line);
    } catch {
      finish({
        exitCode: 1,
        error: "Codex app-server returned an invalid protocol message.",
      });
      return;
    }
    if (packet.method && packet.id !== undefined) void serverRequest(packet);
    else if (packet.method) notification(packet.method, packet.params || {});
    else if (packet.id !== undefined) {
      const item = pending.get(packet.id);
      if (item) {
        pending.delete(packet.id);
        clearTimeout(item.timer);
        if (packet.error && (item.method === "thread/start" || item.method === "turn/start")) modelFailure(packet.error);
        packet.error
          ? item.reject(
              new Error(packet.error.message || "Codex request failed."),
            )
          : item.resolve(packet.result || {});
      }
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-6000);
  });
  child.stdin?.on("error", (error) => {
    if (!finished)
      finish({
        exitCode: 1,
        error: `Codex input transport failed: ${error.message}`,
      });
  });
  child.on("error", (error) => {
    emit({ type: "error", message: error.message, fatal: true });
    finish({ exitCode: 1, error: error.message });
  });
  child.on("close", (code) => {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    lines.close();
    finish({
      exitCode: code === 0 ? 1 : code,
      error: stopped
        ? "Codex worker stopped."
        : stderr.trim() || "Codex app-server exited before the turn completed.",
    });
  });
  void (async () => {
    try {
      await request("initialize", {
        clientInfo: { name: "memcode", title: "MemCode", version: appVersion },
        capabilities: {
          experimentalApi: true,
          requiredHumanApproval: true,
          mcpServerOpenaiFormElicitation: true,
        },
      });
      write({ method: "initialized", params: {} });
      if (!options.localModel) {
        catalog = await readCodexCatalog(options.command, { ...options.env, ...options.command.env }, (method, params) => request(method, params, 4500), refreshCatalog);
        if (inspect) { inspect(catalog); finish({ exitCode: 0 }); return; }
        selected = selectCodexModel(catalog, options.model, !!options.automaticModelTier, options.automaticModelTier);
        const efforts = catalog.models.find(m => m.id === selected)?.efforts;
        if (!selected || (efforts?.length && !efforts.includes(options.effort))) selectedEffort = undefined;
        if (selected !== options.model && options.automaticModelTier)
          emit({ type: "message", role: "system", text: selected ? `Codex selected ${selected} from this account’s available models.` : "Codex will use this account’s default model." });
      }
      attemptedModel = selected;
      const thread = await request("thread/start", {
        cwd: options.cwd,
        ...(selected ? { model: selected } : {}),
        ...(selectedEffort ? { config: { model_reasoning_effort: selectedEffort } } : {}),
        ...(options.localModel ? { modelProvider: "ollama" } : {}),
        sandbox:
          mode === "full-access" ? "danger-full-access" : "workspace-write",
        approvalPolicy: policy,
        approvalsReviewer: reviewer,
        allowProviderModelFallback: false,
      });
      if (
        mode !== "review" &&
        (thread.approvalPolicy !== policy ||
          thread.approvalsReviewer !== reviewer ||
          thread.sandbox?.type !==
            (mode === "full-access" ? "dangerFullAccess" : "workspaceWrite"))
      )
        throw Error(
          `Codex did not activate the selected ${mode} permission mode. The worker was not prompted; choose a supported mode or check administrator policy.`,
        );
      threadId = thread.thread?.id;
      attemptedModel = selected || thread.model;
      if (!threadId) throw new Error("Codex did not return a thread ID.");
      if (["low", "medium", "high", "xhigh"].includes(thread.reasoningEffort))
        reportedEffort = thread.reasoningEffort;
      modelMeasurement(thread.model, "codex-thread");
      emit({ type: "session", sessionId: threadId });
      emit({ type: "prompted" });
      const turn = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: options.prompt }],
        ...(selected ? { model: selected } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
        approvalPolicy: policy,
        approvalsReviewer: reviewer,
        cwd: options.cwd,
      });
      turnId = turn.turn?.id || turnId;
      if (!turnId) throw new Error("Codex did not return a turn ID.");
      for (const event of earlyTurnMeasurements.splice(0)) {
        if (finished) break;
        notification(event.method, event.params);
      }
    } catch (error) {
      if (!finished) {
        const message =
          error instanceof Error ? error.message : "Codex could not start.";
        emit({ type: "error", message, fatal: true });
        finish({ exitCode: 1, error: message });
      }
    }
  })();
  return {
    child,
    completion,
    stop() {
      if (finished) return;
      stopped = true;
      if (threadId && turnId)
        write({
          id: nextId++,
          method: "turn/interrupt",
          params: { threadId, turnId },
        });
      finish({ exitCode: 130, error: "Codex worker stopped." });
    },
  };
}
