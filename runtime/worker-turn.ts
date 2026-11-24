import { isAbsolute, relative, resolve } from "node:path";
import type { Message, WorkItem } from "../src/shared";
import { within } from "./local";

/** Present host-owned evidence in the worker's checkout. Fleet keeps its canonical IDs. */
export function workerContextForPrompt(value: unknown, checkout: string, projectRoot: string): string {
  if (checkout === projectRoot) return JSON.stringify(value);
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(projectRoot);
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = (path: string) => windows ? path.split(/[\\/]/).map(escape).join("[\\\\/]") : escape(path);
  const roots = [checkout, projectRoot]
    .sort((left, right) => right.length - left.length)
    .map(pattern)
    .join("|");
  // Match whole root names, starting with the longest to keep nested worktrees intact.
  const startBoundary = /(?<![\w./\\~-])/.source;
  const endBoundary = /(?=[/\\\s"'`),}:;\]]|$)/.source;
  const reference = new RegExp(startBoundary + "(?:" + roots + ")" + endBoundary, windows ? "gi" : "g");
  const base = new RegExp("^" + pattern(projectRoot) + "$", windows ? "i" : "");
  const present = (_key: string, item: unknown): unknown => {
    if (typeof item !== "string") return item;
    // Recall evidence can itself be JSON encoded as a string, including escaped Windows paths.
    if (/^\s*[\[{]/.test(item)) {
      try {
        const parsed = JSON.parse(item);
        const normalized = JSON.stringify(parsed, present);
        if (normalized !== JSON.stringify(parsed)) return normalized;
      } catch { /* Unstructured context can still contain a file reference. */ }
    }
    return item.replace(reference, (root) => base.test(root) ? checkout : root);
  };
  return JSON.stringify(value, present);
}

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
    "Read, edit, and run project checks in that directory. Fleet file:: keys and workspace scopes in recalled decisions are coordination identifiers. Resolve source paths against this checkout on every turn, including paths mentioned earlier in the conversation.",
    ...(targets.length ? ["Declared source scope:\n" + targets.join("\n")] : []),
  ].join("\n");
}

/** Separate this pass's user requests from already-consumed conversation history. */
export function workerTurnContext(
  task: Pick<WorkItem, "description">,
  snapshot: Message[],
  historyLimit = 8000,
  /** What to say about a message's attached files. */
  attached: (message: Message) => string = () => "",
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
    requests,
    intro: `CURRENT WORKER PASS: ${kind}. Act on the CURRENT REQUESTS block at the end of this prompt. The original task brief, source evidence and historical conversation are background, not new requests to repeat. Preserve completed work and apply the current requests in order; a later current request supersedes an earlier one if they conflict. All host scope, coordination and permission rules still apply.`,
    history: history.length
      ? "HISTORICAL CONVERSATION — background only, bounded to recent context. Previous requests may already be complete; their assistant replies are not the instructions for this pass.\n\n" +
        history.join("\n\n")
      : "",
    current:
      "CURRENT REQUESTS — implement these in this worker pass.\n\n" +
      (requests.length
        ? requests
            .map(
              (message, index) =>
                [`User request ${index + 1}:\n${message.text}`, attached(message)]
                  .filter(Boolean)
                  .join("\n\n"),
            )
            .join("\n\n")
        : task.description),
  };
}
