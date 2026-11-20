import type { Harness } from "../../src/shared";
import type { AgentSessionOptions, AgentSession } from "./types";
import { startCodexSession } from "./codex";
import { startClaudeSession } from "./claude";
import { startCursorSession } from "./cursor";
import { startStandardSession } from "./standard-acp";
export function startHarnessSession(
  harness: Harness,
  options: AgentSessionOptions,
): AgentSession {
  switch (harness) {
    case "codex": return startCodexSession(options);
    case "claude": return startClaudeSession(options);
    case "cursor": return startCursorSession(options);
    case "copilot": case "dsh": return startStandardSession(harness, options);
    default: throw Error(`Unsupported worker harness: ${String(harness)}`);
  }
}
