import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { SignInEnded, TrackerUnavailable } from "./api";

/**
 * MemCode's application at Linear. It is public by nature: a desktop app keeps no secret,
 * and Linear's sign-in with a proof key (PKCE) needs none, to sign in or to renew.
 */
export const LINEAR_CLIENT_ID = process.env.MEMCODE_LINEAR_CLIENT_ID ?? "4915ba31864b4ff291f2967e5bfe5517";
export const LINEAR_SCOPES = ["read", "write"];
const AUTHORIZE = "https://linear.app/oauth/authorize";
const TOKEN = "https://api.linear.app/oauth/token";
const REVOKE = "https://api.linear.app/oauth/revoke";
/** Linear compares the address letter for letter, so each of these is registered. */
export const CALLBACK_PORTS = [47215, 47216, 47217];
export const CALLBACK_PATH = "/linear/callback";
const signInMs = 5 * 60_000;
/** Renewed this long before it runs out. */
const renewBeforeMs = 5 * 60_000;

export interface LinearTokens {
  access: string;
  refresh?: string;
  /** When the access token runs out; a personal key does not. */
  expiresAt?: string;
  /** A personal API key is sent as it is, a sign-in as a bearer token. */
  kind: "sign-in" | "key";
}
/** Where a connection's tokens are kept: the operating system's credential store. */
export interface TokenStore {
  read(id: string): Promise<LinearTokens | undefined>;
  write(id: string, tokens: LinearTokens): Promise<void>;
  clear(id: string): Promise<void>;
}

export interface LinearAuthOptions {
  store: TokenStore;
  openExternal: (url: string) => Promise<void>;
  clientId?: string;
  fetch?: typeof fetch;
  clock?: () => number;
  ports?: number[];
}

function addressOf(path: string | undefined): URL | undefined {
  try {
    return new URL(path ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

export class LinearAuth {
  private renewing = new Map<string, Promise<LinearTokens>>();
  private cancelPending?: () => void;
  constructor(private options: LinearAuthOptions) {}

  get clientId(): string {
    return this.options.clientId ?? LINEAR_CLIENT_ID;
  }
  private now() {
    return (this.options.clock ?? Date.now)();
  }

  /** Opens Linear in the browser and waits for the person to allow it. */
  async signIn(): Promise<LinearTokens> {
    if (!this.clientId)
      throw new Error("This MemCode has no Linear application yet. Use an API key instead.");
    if (this.cancelPending) throw new Error("Finish or cancel the sign-in that is open first.");
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    let settle!: { code: (code: string) => void; failed: (error: Error) => void };
    const answer = new Promise<string>((resolve, reject) => {
      settle = { code: resolve, failed: reject };
    });
    void answer.catch(() => {});
    this.cancelPending = () => settle.failed(new Error("Connecting Linear was cancelled."));
    const server = createServer((request, response) => {
      // Anything on this computer, a web page too, can ask here: it may be no address at all.
      const url = addressOf(request.url);
      if (
        request.method !== "GET" ||
        !url ||
        url.pathname !== CALLBACK_PATH ||
        url.searchParams.get("state") !== state
      ) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      });
      const code = url.searchParams.get("code");
      const allowed = !!code && /^[\x21-\x7e]{8,2000}$/.test(code);
      response.end(
        page(
          allowed ? "Linear is connected." : "Linear was not connected.",
          "Return to MemCode. You can close this tab.",
        ),
      );
      if (allowed) settle.code(code);
      else settle.failed(new Error("Linear was not connected."));
    });
    const timer = setTimeout(
      () => settle.failed(new Error("Connecting Linear took too long. Try again.")),
      signInMs,
    );
    try {
      const port = await listen(server, this.options.ports ?? CALLBACK_PORTS);
      const redirect = `http://localhost:${port}${CALLBACK_PATH}`;
      const url = new URL(AUTHORIZE);
      for (const [key, value] of Object.entries({
        client_id: this.clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: LINEAR_SCOPES.join(","),
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        // A person with several workspaces chooses, also when one is connected already.
        prompt: "consent",
      }))
        url.searchParams.set(key, value);
      await this.options.openExternal(url.href);
      const code = await answer;
      return await this.token({
        grant_type: "authorization_code",
        client_id: this.clientId,
        redirect_uri: redirect,
        code,
        code_verifier: verifier,
      });
    } finally {
      clearTimeout(timer);
      this.cancelPending = undefined;
      server.close();
      server.closeAllConnections();
    }
  }
  cancel(): void {
    this.cancelPending?.();
  }

  /** The header for a connection's next call, renewed when it is about to run out. */
  async authorization(id: string, renew = false): Promise<string> {
    const stored = await this.options.store.read(id);
    if (!stored) throw new SignInEnded();
    if (stored.kind === "key") {
      if (renew) throw new SignInEnded("Linear no longer accepts this API key. Connect again.");
      return stored.access;
    }
    const runsOut = stored.expiresAt ? Date.parse(stored.expiresAt) : Infinity;
    if (!renew && runsOut - this.now() > renewBeforeMs) return "Bearer " + stored.access;
    return "Bearer " + (await this.renew(id, stored)).access;
  }

  /** One renewal at a time: the second would use a token the first has replaced. */
  private renew(id: string, stored: LinearTokens): Promise<LinearTokens> {
    const under = this.renewing.get(id);
    if (under) return under;
    if (!stored.refresh) return Promise.reject(new SignInEnded());
    const renewal = this.token({
      grant_type: "refresh_token",
      client_id: this.clientId,
      refresh_token: stored.refresh,
    })
      .then(async (tokens) => {
        // Kept before it is used: a token that is lost here cannot be had again.
        const kept = { ...tokens, refresh: tokens.refresh ?? stored.refresh };
        await this.options.store.write(id, kept);
        return kept;
      })
      .finally(() => this.renewing.delete(id));
    this.renewing.set(id, renewal);
    return renewal;
  }

  /** Forgets the tokens here and ends them at Linear. Answers whether Linear took it. */
  async revoke(id: string): Promise<boolean> {
    const stored = await this.options.store.read(id).catch(() => undefined);
    await this.options.store.clear(id);
    // A personal key is the person's own: it is ended where it was made.
    if (stored?.kind !== "sign-in") return true;
    let told = true;
    // Ending one does not end the other.
    for (const [token, hint] of [
      [stored.refresh, "refresh_token"],
      [stored.access, "access_token"],
    ]) {
      if (!token) continue;
      const ended = await this.post(REVOKE, { token, token_type_hint: hint! }).then(
        // 400 and 401: it is no token any more.
        (response) => response.ok || response.status === 400 || response.status === 401,
        () => false,
      );
      told &&= ended;
    }
    return told;
  }

  private async token(form: Record<string, string>): Promise<LinearTokens> {
    const response = await this.post(TOKEN, form);
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
    };
    if (response.status >= 500 || response.status === 429)
      throw new TrackerUnavailable("Linear cannot sign in right now. Try again shortly.");
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token)
      throw new SignInEnded(
        form.grant_type === "refresh_token"
          ? undefined
          : "Linear did not accept the sign-in. Try again.",
      );
    return {
      kind: "sign-in",
      access: body.access_token,
      ...(typeof body.refresh_token === "string" ? { refresh: body.refresh_token } : {}),
      ...(typeof body.expires_in === "number"
        ? { expiresAt: new Date(this.now() + body.expires_in * 1000).toISOString() }
        : {}),
    };
  }

  private async post(url: string, form: Record<string, string>): Promise<Response> {
    try {
      return await (this.options.fetch ?? fetch)(url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new TrackerUnavailable("Linear cannot be reached right now.");
    }
  }
}

async function listen(server: Server, ports: number[]): Promise<number> {
  for (const port of ports) {
    const open = await new Promise<boolean>((resolve) => {
      const failed = () => resolve(false);
      server.once("error", failed);
      // Only this computer can reach it.
      server.listen(port, "127.0.0.1", () => {
        server.off("error", failed);
        resolve(true);
      });
    });
    if (open) {
      const address = server.address();
      return typeof address === "object" && address ? address.port : port;
    }
  }
  throw new Error("The sign-in could not wait for Linear on this computer. Close other sign-ins and try again.");
}

const page = (title: string, text: string) =>
  `<!doctype html><title>${title}</title><body style="font:17px system-ui;padding:48px;background:#f8fbf7;color:#153b2d"><h1>${title}</h1><p>${text}</p></body>`;
