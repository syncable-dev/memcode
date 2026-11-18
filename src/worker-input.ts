import type { Harness } from "./shared";

export interface WorkerActivity {
  phase:
    | "working"
    | "tool"
    | "waiting_for_user"
    | "waiting_for_worker"
    | "finishing";
  label: string;
  at: string;
  toolId?: string;
  lastTool?: { label: string; durationMs: number; failed: boolean };
  relatedTaskId?: string;
}

export interface WorkerInputOption {
  id: string;
  label: string;
  description?: string;
  kind?: "allow-once" | "allow-session" | "deny" | "other";
}
export interface WorkerInputQuestion {
  id: string;
  question: string;
  options: WorkerInputOption[];
  multiple?: boolean;
  allowText?: boolean;
  secret?: boolean;
}
export interface WorkerInputPrompt {
  kind: "approval" | "question" | "plan";
  title: string;
  description?: string;
  toolName?: string;
  details?: string;
  options?: WorkerInputOption[];
  questions?: WorkerInputQuestion[];
}
export interface WorkerInputResponse {
  optionId?: string;
  answers?: Record<string, string | string[]>;
  cancelled?: boolean;
}
export interface WorkerInputRequest extends WorkerInputPrompt {
  id: string;
  taskId: string;
  runId: string;
  harness: Harness;
  createdAt: string;
  status: "pending" | "answered" | "cancelled";
  answeredAt?: string;
  response?: WorkerInputResponse;
}
