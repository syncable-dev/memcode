import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import { appVersion } from "../src/version";

export const BETA_ORIGIN = "https://www.memtrace.io";
export const BETA_PROGRAM = "memcode-noncommercial-beta";
export const BETA_TERMS = "polyform-noncommercial-1.0.0/memcode-beta-v1";
const opaque = (value: unknown, minimum = 32): value is string =>
  typeof value === "string" &&
  value.length >= minimum &&
  value.length <= 200 &&
  /^[A-Za-z0-9_-]+$/.test(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value);
export interface BetaBinding {
  deviceId: string;
  sessionId: string;
}
export interface BetaAccount {
  id: string;
  name: string;
  email?: string;
}
export interface BetaPublicKey {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg?: string;
  use?: string;
  d?: never;
}
export interface BetaTokens {
  telemetry_token?: string;
  telemetry_expires_in?: number;
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  refresh_expires_at: string;
  terms_version: string;
  account: BetaAccount;
}
export interface VerifiedBetaAccess {
  account: BetaAccount;
  expiresAt: string;
  publicKey: BetaPublicKey;
}
export class BetaRequestError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 409
        ? "This beta session has expired or was revoked. Connect again."
        : status === 429
          ? "Too many beta requests. Try again in one minute."
          : status === 503
            ? "MemCode beta access is unavailable right now. Try again shortly."
            : "Memtrace could not complete the beta request. Try again.",
    );
  }
}

export async function boundedBetaJSON(response: Response): Promise<any> {
  if (!response.ok) throw new BetaRequestError(response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Memtrace returned an empty beta response.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 32768)
        throw new Error("The beta response exceeded its size limit.");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function betaClientMetadata() {
  const platform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : process.platform === "linux"
          ? "linux"
          : undefined;
  const arch =
    process.arch === "x64"
      ? "x86_64"
      : process.arch === "arm64"
        ? "aarch64"
        : undefined;
  return platform && arch ? { platform, arch, version: appVersion } : undefined;
}

export function betaTokens(value: any): BetaTokens {
  if (
    !value ||
    !text(value.access_token, 16384) ||
    value.token_type !== "Bearer" ||
    !opaque(value.refresh_token) ||
    !Number.isInteger(value.expires_in) ||
    value.expires_in <= 0 ||
    value.expires_in > 900 ||
    !text(value.refresh_expires_at, 60) ||
    !Number.isFinite(Date.parse(value.refresh_expires_at)) ||
    value.terms_version !== BETA_TERMS ||
    !text(value.account?.id, 200) ||
    !text(value.account?.name, 240) ||
    (value.account.email !== undefined &&
      (!text(value.account.email, 320) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.account.email)))
  )
    throw new Error("Memtrace returned an invalid beta grant. Connect again.");
  return {
    ...(text(value.telemetry_token, 16384) &&
    Number.isInteger(value.telemetry_expires_in) &&
    value.telemetry_expires_in > 0 &&
    value.telemetry_expires_in <= 900
      ? {
          telemetry_token: value.telemetry_token,
          telemetry_expires_in: value.telemetry_expires_in,
        }
      : {}),
    access_token: value.access_token,
    token_type: "Bearer",
    expires_in: value.expires_in,
    refresh_token: value.refresh_token,
    refresh_expires_at: value.refresh_expires_at,
    terms_version: BETA_TERMS,
    account: {
      id: value.account.id,
      name: value.account.name,
      ...(value.account.email ? { email: value.account.email } : {}),
    },
  };
}

export async function verifyBetaAccess(
  token: string,
  binding: BetaBinding,
  options: {
    loadKeys?: () => Promise<{ keys: BetaPublicKey[] }>;
    cachedKey?: BetaPublicKey;
    now?: () => number;
    accountId?: string;
  } = {},
): Promise<VerifiedBetaAccess> {
  try {
    const now = (options.now ?? Date.now)(),
      parts = token.split(".");
    if (
      token.length > 16384 ||
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      throw Error();
    const header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    );
    const claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    if (
      header.alg !== "EdDSA" ||
      header.typ !== "JWT" ||
      !text(header.kid, 120) ||
      header.jku ||
      header.jwk ||
      header.x5u ||
      header.crit ||
      claims.iss !== "https://memtrace.io" ||
      claims.aud !== "memcode-engine-beta" ||
      claims.purpose !== "memcode-engine-beta" ||
      claims.program !== BETA_PROGRAM ||
      claims.terms_version !== BETA_TERMS ||
      claims.device_id !== binding.deviceId ||
      claims.session_id !== binding.sessionId ||
      !text(claims.sub, 200) ||
      (options.accountId && claims.sub !== options.accountId) ||
      !text(claims.name, 240) ||
      !opaque(claims.jti) ||
      !Number.isInteger(claims.iat) ||
      !Number.isInteger(claims.exp) ||
      claims.iat * 1000 > now + 15000 ||
      claims.exp * 1000 <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 900 ||
      (claims.email !== undefined &&
        (!text(claims.email, 320) ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)))
    )
      throw Error();
    const entitlements = claims.entitlements;
    if (
      !entitlements ||
      Object.keys(entitlements).length !== 6 ||
      entitlements.local_engine !== true ||
      entitlements.graph_queries !== "unlimited" ||
      entitlements.cortex !== true ||
      entitlements.improve !== true ||
      entitlements.external_memdb !== false ||
      entitlements.provider_credits !== false
    )
      throw Error();
    let keys =
      options.cachedKey?.kid === header.kid
        ? [options.cachedKey]
        : (
            await (
              options.loadKeys ??
              (async () =>
                boundedBetaJSON(
                  await fetch(`${BETA_ORIGIN}/api/memcode/jwks`, {
                    redirect: "error",
                    signal: AbortSignal.timeout(10000),
                    headers: { accept: "application/json" },
                  }),
                ))
            )()
          ).keys;
    if (!Array.isArray(keys) || keys.length > 10) throw Error();
    const matching = keys.filter(
      (key) =>
        key.kid === header.kid &&
        key.kty === "OKP" &&
        key.crv === "Ed25519" &&
        !key.d &&
        (!key.alg || key.alg === "EdDSA") &&
        (!key.use || key.use === "sig"),
    );
    if (
      matching.length !== 1 ||
      Buffer.from(parts[2], "base64url").length !== 64 ||
      !verify(
        null,
        Buffer.from(parts[0] + "." + parts[1]),
        createPublicKey({ key: matching[0], format: "jwk" }),
        Buffer.from(parts[2], "base64url"),
      )
    )
      throw Error();
    return {
      account: {
        id: claims.sub,
        name: claims.name,
        ...(claims.email ? { email: claims.email } : {}),
      },
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      publicKey: {
        kty: "OKP",
        crv: "Ed25519",
        kid: matching[0].kid,
        x: matching[0].x,
        alg: "EdDSA",
        use: "sig",
      },
    };
  } catch {
    throw new Error(
      "Memtrace beta access could not be verified. Connect again.",
    );
  }
}

export interface BetaAuthorizationOptions {
  telemetryOptIn?: () => boolean;
  openExternal(url: string): Promise<unknown>;
  fetcher?: typeof fetch;
  now?: () => number;
}
export function createBetaAuthorization(options: BetaAuthorizationOptions) {
  const fetcher = options.fetcher ?? fetch,
    clock = options.now ?? Date.now;
  let pending = false,
    cancel: (() => void) | undefined;
  const request = async (
    path: "token" | "refresh" | "revoke",
    body: object,
    signal?: AbortSignal,
  ) => {
    const response = await fetcher(`${BETA_ORIGIN}/api/memcode/beta/${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(15000),
      ]),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return path === "revoke" && response.status === 204
      ? null
      : boundedBetaJSON(response);
  };
  const available = async (signal?: AbortSignal) => {
    const data = await boundedBetaJSON(
      await fetcher(`${BETA_ORIGIN}/api/memcode/beta/status`, {
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(8000),
          ...(signal ? [signal] : []),
        ]),
        headers: { accept: "application/json" },
      }),
    );
    return (
      data.available === true &&
      data.program === BETA_PROGRAM &&
      data.terms_version === BETA_TERMS
    );
  };
  return {
    available,
    cancel: () => cancel?.(),
    refresh: async (refreshToken: string, binding: BetaBinding) =>
      betaTokens(
        await request("refresh", {
          refresh_token: refreshToken,
          device_id: binding.deviceId,
          session_id: binding.sessionId,
          ...(options.telemetryOptIn?.() ? { telemetry_opt_in: true } : {}),
          ...(betaClientMetadata() ? { client: betaClientMetadata() } : {}),
        }),
      ),
    revoke: async (refreshToken: string, binding: BetaBinding) => {
      await request("revoke", {
        refresh_token: refreshToken,
        device_id: binding.deviceId,
        session_id: binding.sessionId,
      });
    },
    authorize: async (binding: BetaBinding): Promise<BetaTokens> => {
      if (pending)
        throw new Error("Finish or cancel the current beta sign-in first.");
      pending = true;
      const state = randomBytes(32).toString("base64url"),
        nonce = randomBytes(32).toString("base64url"),
        verifier = randomBytes(32).toString("base64url");
      const path = "/memcode-beta/" + state,
        abort = new AbortController();
      let resolveCode!: (code: string) => void,
        rejectCode!: (error: Error) => void,
        cancelled = false,
        timer: ReturnType<typeof setTimeout> | undefined;
      const result = new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
      });
      void result.catch(() => {});
      cancel = () => {
        cancelled = true;
        const error = new Error("MemCode beta sign-in was cancelled.");
        abort.abort(error);
        rejectCode(error);
      };
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (
          request.method !== "GET" ||
          url.pathname !== path ||
          url.searchParams.getAll("state").length !== 1 ||
          url.searchParams.get("state") !== state ||
          [...url.searchParams.keys()].some(
            (key) => !["state", "code", "error"].includes(key),
          )
        ) {
          response.writeHead(404);
          response.end();
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
        if (
          url.searchParams.has("error") ||
          url.searchParams.getAll("code").length !== 1 ||
          !opaque(code)
        ) {
          response.end(
            "<title>Return to MemCode</title><p>Beta sign-in was cancelled. Return to MemCode.</p>",
          );
          rejectCode(new Error("MemCode beta sign-in was cancelled."));
          return;
        }
        response.end(
          "<title>Return to MemCode</title><body style='font:17px system-ui;padding:48px;background:#f8fbf7;color:#153b2d'><h1>Approval received.</h1><p>Return to MemCode to finish connecting. You can close this tab.</p></body>",
        );
        resolveCode(code);
      });
      try {
        if (!(await available(abort.signal)))
          throw new Error(
            "MemCode noncommercial beta access is not enabled on the service yet.",
          );
        if (cancelled) throw new Error("MemCode beta sign-in was cancelled.");
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        abort.signal.throwIfAborted();
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("The local sign-in callback could not start.");
        const redirect = `http://127.0.0.1:${address.port}${path}`,
          expiresAt = new Date(clock() + 300000).toISOString(),
          authorize = new URL(`${BETA_ORIGIN}/api/memcode/beta/authorize`);
        for (const [key, value] of Object.entries({
          device_id: binding.deviceId,
          session_id: binding.sessionId,
          nonce,
          expires_at: expiresAt,
          redirect_uri: redirect,
          state,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
        }))
          authorize.searchParams.set(key, value);
        timer = setTimeout(
          () =>
            rejectCode(
              new Error(
                "MemCode beta sign-in timed out. Connect again when you're ready.",
              ),
            ),
          300000,
        );
        void options
          .openExternal(authorize.href)
          .catch(() =>
            rejectCode(
              new Error(
                "Could not open Memtrace beta sign-in. Check your default browser and retry.",
              ),
            ),
          );
        const code = await result;
        if (cancelled) throw new Error("MemCode beta sign-in was cancelled.");
        const tokens = betaTokens(
          await request(
            "token",
            {
              code,
              code_verifier: verifier,
              redirect_uri: redirect,
              ...(options.telemetryOptIn?.() ? { telemetry_opt_in: true } : {}),
              ...(betaClientMetadata() ? { client: betaClientMetadata() } : {}),
            },
            abort.signal,
          ),
        );
        if (cancelled) throw new Error("MemCode beta sign-in was cancelled.");
        return tokens;
      } finally {
        pending = false;
        cancel = undefined;
        if (timer) clearTimeout(timer);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
