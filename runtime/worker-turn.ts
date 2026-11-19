import { isAbsolute, relative, resolve } from "node:path";
import type { Message, WorkItem } from "../src/shared";
import { within } from "./local";

export function workerCheckoutBrief(checkout: string, projectRoot: string, scope: string[] = []): string {
  const targets = scope.map((entry) => {
    const path = isAbsolute(entry) && !within(checkout, entry) && within(projectRoot, entry)
      ? relative(projectRoot, entry)
      : entry;
    const target = resolve(checkout, path);
    return within(checkout, target) ? target : "(outside this checkout)";
  });
  return [
    `Source checkout: ${checkout}`,
    "Read, edit, and run project checks in that directory. Fleet file:: keys and workspace scopes in recalled decisions are coordination identifiers. Use paths inside this checkout for file operations.",
    ...(targets.length ? ["Declared source scope:\n" + targets.join("\n")] : []),
  ].join("\n");
}

/** Separate this pass's user requests from already-consumed conversation history. */
export function workerTurnContext(
  task: Pick<WorkItem, "description">,
  snapshot: Message[],
  historyLimit = 8000,
) {
  const visible = snapshot.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.followupState !== "cancelled",
  );
  const fresh = visible.filter(
    (message) => message.role === "user" && !message.promptedAt,
  );
  const latest = visible.findLast((message) => message.role === "user");
  const requests = fresh.length ? fresh : latest ? [latest] : [];
  const currentIds = new Set(requests.map((message) => message.id));
  const history: string[] = [];
  let remaining = Math.max(0, historyLimit);
  for (const message of [...visible].reverse()) {
    if (currentIds.has(message.id) || remaining === 0) continue;
    const text = `Previous ${message.role}: ${message.text}`;
    const entry = text.slice(-remaining);
    history.unshift(entry);
    remaining = Math.max(0, remaining - entry.length - 2);
  }
  const kind = fresh.length
    ? visible.some((message) => message.promptedAt)
      ? "follow-up"
      : "initial request"
    : "continuation";
  return {
    intro: `CURRENT WORKER PASS: ${kind}. Act on the CURRENT REQUESTS block at the end of this prompt. The original story brief, source evidence and historical conversation are background, not new requests to repeat. Preserve completed work and apply the current requests in order; a later current request supersedes an earlier one if they conflict. All host scope, coordination and permission rules still apply.`,
    history: history.length
      ? "HISTORICAL CONVERSATION — background only, bounded to recent context. Previous requests may already be complete; their assistant replies are not the instructions for this pass.\n\n" +
        history.join("\n\n")
      : "",
    current:
      "CURRENT REQUESTS — implement these in this worker pass.\n\n" +
      (requests.length
        ? requests
            .map(
              (message, index) => `User request ${index + 1}:\n${message.text}`,
            )
            .join("\n\n")
        : task.description),
  };
}
