import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const brokerInstructions = [
  "Use memcode-context find, understand and assess for code discovery and change context. Select exact symbol/file candidates when ambiguous.",
  "The host binds repository, goal branch, worker identity and visibility. Request narrower scope; ask the host before expanding declared edit scope.",
  "Read all constraint continuation pages before acting. Unknown, stale or truncated coverage is not proof that a dependency or rule is absent.",
  "Fleet reservations, renewal, overlap decisions and human resolutions belong to the host. Stop when the host pauses you. Never grant yourself coordination permission.",
  "Before EVERY source edit, call MemCode coordinate(action=inspect, plan=your concrete implementation plan). Read earlier owners' intents. Only edit when canEdit=true. Workers take turns on shared files: the files are yours for one group of edits and checkpoint hands them back. When directed to adhere, adopt the earlier plan; then keep calling adopt with bounded waitMs until canEdit=true, and never end your turn because of a wait. You may inspect independent code while waiting. Propose a reasoned alternative only if you believe a different solution is better; the owner must respond accept/reject before further shared edits. Ordinary overlap is never a human conflict. Never invent another worker's agreement or override a wait directive.",
  "Native Read/Edit/Write and Bash support implementation and verification. Shell access can search files, so broker-first retrieval is cooperative, not hard fencing.",
].join("\n");

export async function writeClaudeProfile(
  directory: string,
  gatewayPath: string,
  sessionPath: string,
  browserSessionPath?: string,
): Promise<string> {
  const path = join(directory, "context-mcp.json");
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: {
        "memcode-context": {
          type: "stdio",
          command: process.execPath,
          args: [gatewayPath, sessionPath],
        },
        ...(browserSessionPath
          ? {
              "memcode-browser": {
                type: "stdio",
                command: process.execPath,
                args: [gatewayPath, browserSessionPath],
              },
            }
          : {}),
      },
    }),
    { mode: 0o600 },
  );
  return path;
}
/** Keeps auth, project rules, settings, hooks and managed policy. Never uses --bare/--safe-mode. */
export function claudeProfileArgs(configPath: string): string[] {
  return [
    "--strict-mcp-config",
    "--mcp-config",
    configPath,
    "--disable-slash-commands",
    "--tools",
    "Bash,Read,Edit,Write",
    "--allowedTools",
    "mcp__memcode-context__find,mcp__memcode-context__understand,mcp__memcode-context__assess,mcp__memcode-context__coordinate,mcp__memcode-context__terminal,mcp__memcode-browser__open,mcp__memcode-browser__observe,mcp__memcode-browser__act",
    "--append-system-prompt",
    brokerInstructions,
  ];
}
