import type { WorkerActivity } from "../../src/worker-input";
import type { AgentEvent } from "./types";

/** Native call IDs pair actual tool starts and ends within one provider session. */
export function trackTurnActivity() {
  const tools = new Map<string, WorkerActivity>();
  let lastTool: WorkerActivity["lastTool"];
  return (event: AgentEvent, previous: WorkerActivity | undefined, at: string): WorkerActivity | undefined => {
    if (event.type === "activity" && event.toolId) {
      const start = tools.get(event.toolId);
      if (event.toolResult) {
        if (!start) return previous;
        lastTool = {
          label: start.label,
          durationMs: Math.max(0, Date.parse(at) - Date.parse(start.at)),
          failed: event.toolResult === "failed",
        };
        tools.delete(event.toolId);
      } else if (event.phase === "tool" && !start) {
        tools.set(event.toolId, { phase: "tool", label: event.label, toolId: event.toolId, at });
      }
    }
    const active = tools.values().next().value;
    if (active) return { ...active, lastTool };
    const change = event.type === "activity" && !event.toolResult
      ? { phase: event.phase === "waiting" ? "working" : event.phase ?? "working", label: event.label } as const
      : event.type === "message" && event.role === "assistant"
      ? { phase: "working", label: "Worker is responding" } as const
      : event.type === "activity" || event.type === "session"
      ? { phase: "working", label: "Waiting for a harness update" } as const
      : undefined;
    if (!change) return previous;
    return { ...change, lastTool, at: previous?.label === change.label && previous.phase === change.phase ? previous.at : at };
  };
}
