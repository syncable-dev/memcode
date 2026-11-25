import { operations, type Operation } from "./operations";

export const LINEAR_API = "https://api.linear.app/graphql";
const timeoutMs = 30_000;
const longestAnswer = 12_000_000;

/** The tracker cannot be reached or is not well. Trying again later is right. */
export class TrackerUnavailable extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
/** The sign-in is over: someone has to connect again. */
export class SignInEnded extends Error {
  constructor(message = "The sign-in to Linear has ended. Connect again.") {
    super(message);
  }
}
/** The tracker said no to this one thing, in words a person can read. */
export class TrackerRefused extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
/** What was asked for is not there, or not for this person to see. */
export class NotThere extends TrackerRefused {}

export interface LinearApiOptions {
  /** The Authorization header. Asked again with `renew` when the last one was refused. */
  authorization: (renew?: boolean) => Promise<string>;
  fetch?: typeof fetch;
  url?: string;
}

interface GraphQLError {
  message?: string;
  extensions?: {
    code?: string;
    type?: string;
    userPresentableMessage?: string;
    userError?: boolean;
    http?: { status?: number };
  };
}
interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}
export interface Page<Node> {
  nodes: Node[];
  pageInfo: PageInfo;
}

/** Linear's GraphQL API, with its ways of failing told apart. */
export class LinearApi {
  constructor(private options: LinearApiOptions) {}

  async call<Data = any>(
    operation: Operation,
    variables: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Data> {
    const first = await this.send(operation, variables, false, signal);
    if (first !== "unauthorized") return first as Data;
    const second = await this.send(operation, variables, true, signal);
    if (second === "unauthorized") throw new SignInEnded();
    return second as Data;
  }

  /** Every page of a list. Linear's pages are followed, never guessed at. */
  async all<Node>(
    operation: Operation,
    variables: Record<string, unknown>,
    list: (data: any) => Page<Node> | undefined,
    options: { most?: number; signal?: AbortSignal; onPage?: (nodes: Node[]) => void } = {},
  ): Promise<Node[]> {
    const nodes: Node[] = [];
    let after: string | null = null;
    for (let page = 0; page < 400; page++) {
      const data: any = await this.call(operation, { ...variables, after }, options.signal);
      const found = list(data);
      if (!found) return nodes;
      nodes.push(...found.nodes);
      options.onPage?.(found.nodes);
      if (!found.pageInfo?.hasNextPage || !found.pageInfo.endCursor) return nodes;
      if (options.most && nodes.length >= options.most) return nodes;
      after = found.pageInfo.endCursor;
    }
    return nodes;
  }

  private async send(
    operation: Operation,
    variables: Record<string, unknown>,
    renew: boolean,
    signal?: AbortSignal,
  ): Promise<unknown | "unauthorized"> {
    const authorization = await this.options.authorization(renew);
    let response: Response;
    let text: string;
    try {
      response = await (this.options.fetch ?? fetch)(this.options.url ?? LINEAR_API, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({
          operationName: operation,
          query: operations[operation],
          variables,
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
      text = await bounded(response);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TrackerUnavailable("Linear cannot be reached right now.");
    }
    if (response.status === 401) return "unauthorized";
    if (response.status === 429) throw busy(response);
    let body: { data?: any; errors?: GraphQLError[] } = {};
    try {
      body = JSON.parse(text);
    } catch {
      // An answer that is not JSON is the service being unwell, whatever it says.
    }
    const [problem] = body.errors ?? [];
    if (problem) {
      const code = problem.extensions?.code ?? problem.extensions?.type ?? "";
      if (/RATELIMITED/i.test(code)) throw busy(response);
      if (/AUTHENTICATION/i.test(code)) return "unauthorized";
      if (response.status >= 500 || /INTERNAL/i.test(code))
        throw new TrackerUnavailable("Linear is having trouble right now.");
      const message =
        problem.extensions?.userPresentableMessage || problem.message || "Linear refused this.";
      if (/not found/i.test(problem.message ?? "") || /ENTITY_NOT_FOUND|NOT_FOUND/i.test(code))
        throw new NotThere(message, code);
      throw new TrackerRefused(message, code);
    }
    if (!response.ok || !body.data)
      throw new TrackerUnavailable("Linear is having trouble right now.");
    return body.data;
  }
}

function busy(response: Response): TrackerUnavailable {
  const seconds = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-requests-reset"));
  const wait =
    Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : Number.isFinite(reset) && reset > Date.now()
        ? reset - Date.now()
        : 60_000;
  return new TrackerUnavailable(
    "Linear is limiting how often MemCode may ask. It goes on by itself.",
    Math.min(wait, 3_600_000),
  );
}

async function bounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > longestAnswer) {
      await reader.cancel().catch(() => {});
      throw new Error("The answer is too long.");
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
