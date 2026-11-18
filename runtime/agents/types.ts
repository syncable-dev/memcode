import type { ChildProcess } from "node:child_process";
import type { Command } from "../commands";
import type { ReasoningEffort } from "../../src/shared";
import type {
  WorkerInputPrompt,
  WorkerInputResponse,
} from "../../src/worker-input";

export type AgentEvent =
  | import("../../src/measurements").AgentMeasurement
  | { type: "prompted" }
  | {
      type: "message";
      role: "assistant" | "tool" | "system";
      text: string;
      delta?: boolean;
      messageId?: string;
    }
  | {
      type: "activity";
      label: string;
      toolId?: string;
      toolResult?: "completed" | "failed";
      phase?: "working" | "tool" | "waiting" | "finishing";
    }
  | { type: "session"; sessionId: string }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "raw"; event: unknown };
export interface AgentSessionOptions {
  command: Command;
  cwd: string;
  env: NodeJS.ProcessEnv;
  model: string;
  effort: ReasoningEffort;
  automaticModelTier?: import("../../src/shared").ModelTier;
  prompt: string;
  briefPath: string;
  contextConfig?: string;
  toolArgs: string[];
  localModel?: boolean;
  permissionMode?: import("../../src/permissions").PermissionMode;
  onEvent(event: AgentEvent): void;
  requestInput(
    prompt: WorkerInputPrompt,
    signal?: AbortSignal,
  ): Promise<WorkerInputResponse>;
}
export interface AgentSession {
  child: ChildProcess;
  completion: Promise<{ exitCode: number | null; error?: string }>;
  stop(): void | Promise<void>;
}
