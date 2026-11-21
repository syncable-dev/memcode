import { BetaRequestError, boundedBetaJSON } from "../beta-auth";
import type { BetaSessionProof } from "../beta";
import { SharingSignedOut, SharingUnavailable } from "./problems";

/** Proof of who is calling, for one call to the sharing service after another. */
export interface AccessToken {
  token: string;
  /** The account the sharing service will answer for. */
  accountId: string;
}

export interface SharingAccessOptions {
  /** The Memtrace sign-in, once a rotation in flight has landed. Null: nobody is signed in. */
  session(): Promise<BetaSessionProof | null>;
  tokenEndpoint(): URL;
  fetcher?: typeof fetch;
  now?: () => number;
}

interface HeldToken extends AccessToken {
  sessionId: string;
  renewAt: number;
}

const EXCHANGE_TIMEOUT_MS = 15_000,
  RENEW_AHEAD_MS = 60_000,
  // The sharing service refuses a token that lives longer than this.
  LONGEST_LIFE_SECONDS = 900,
  LONGEST_TOKEN = 16384,
  LONGEST_ACCOUNT_ID = 200;
const tokenForm = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const unexpectedReply = () =>
  new SharingUnavailable(
    "The sign-in address for sharing did not answer with an access token. Check the address in Settings.",
  );

function refusedExchange(status: number): Error {
  if (status === 401)
    return new SharingSignedOut(
      "Your Memtrace sign-in has ended. Sign in again to see the projects you share.",
    );
  if (status === 422)
    return new SharingUnavailable(
      "The name or email on your Memtrace account cannot be used for sharing. Change it at memtrace.io, then try again.",
    );
  if (status === 503)
    return new SharingUnavailable(
      "Sharing is switched off or not set up at memtrace.io right now. Try again later.",
    );
  return new SharingUnavailable(
    `The sign-in address for sharing answered HTTP ${status}. Check the address in Settings, or try again later.`,
  );
}

/** Who the token says it is for. Its signature is the sharing service's to check. */
function accountNamedIn(token: string): string {
  let account: unknown;
  try {
    account = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    )?.sub;
  } catch {
    throw unexpectedReply();
  }
  if (
    typeof account !== "string" ||
    !account ||
    account.length > LONGEST_ACCOUNT_ID
  )
    throw unexpectedReply();
  return account;
}

function issuedToken(
  reply: any,
  sentAt: number,
  session: BetaSessionProof,
): HeldToken {
  const token = reply?.access_token,
    lifeSeconds = reply?.expires_in;
  if (
    typeof token !== "string" ||
    token.length > LONGEST_TOKEN ||
    !tokenForm.test(token) ||
    reply.token_type !== "Bearer" ||
    !Number.isInteger(lifeSeconds) ||
    lifeSeconds <= 0 ||
    lifeSeconds > LONGEST_LIFE_SECONDS
  )
    throw unexpectedReply();
  const accountId = accountNamedIn(token);
  if (accountId !== session.accountId)
    throw new SharingUnavailable(
      "memtrace.io answered for another account than the one signed in here. Sign out and in again.",
    );
  const lifeMs = lifeSeconds * 1000;
  return {
    token,
    accountId,
    sessionId: session.sessionId,
    renewAt: sentAt + lifeMs - Math.min(RENEW_AHEAD_MS, lifeMs / 2),
  };
}

/**
 * Gets an access token for the sharing service from memtrace.io and renews it
 * before it expires. The token is kept in memory only.
 */
export class SharingAccess {
  private held?: HeldToken;
  private exchanging?: Promise<HeldToken>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly options: SharingAccessOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async current(): Promise<AccessToken> {
    const session = await this.options.session();
    if (!session) {
      this.held = undefined;
      throw new SharingSignedOut();
    }
    const held = this.held;
    if (
      held &&
      held.sessionId === session.sessionId &&
      this.now() < held.renewAt
    )
      return { token: held.token, accountId: held.accountId };
    const fresh = await (this.exchanging ??= this.exchange(session).finally(
      () => (this.exchanging = undefined),
    ));
    // An exchange already under way may have been for the sign-in before this one.
    if (fresh.sessionId !== session.sessionId) return this.current();
    this.held = fresh;
    return { token: fresh.token, accountId: fresh.accountId };
  }

  /** Call when the sharing service would not take a token, so the next call asks for another. */
  forget(token: string) {
    if (this.held?.token === token) this.held = undefined;
  }

  private async exchange(session: BetaSessionProof): Promise<HeldToken> {
    try {
      return await this.request(session);
    } catch (problem) {
      if (!(problem instanceof SharingSignedOut)) throw problem;
      // MemCode's own refresh may have spent that refresh token while the request travelled.
      const latest = await this.options.session();
      if (!latest || latest.refreshToken === session.refreshToken)
        throw problem;
      return this.request(latest);
    }
  }

  private async request(session: BetaSessionProof): Promise<HeldToken> {
    const sentAt = this.now();
    const response = await this.send(session);
    return issuedToken(await replyOf(response), sentAt, session);
  }

  private async send(session: BetaSessionProof): Promise<Response> {
    try {
      // memtrace.io refuses a request that holds anything but these three fields.
      return await this.fetcher(this.options.tokenEndpoint(), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          refresh_token: session.refreshToken,
          device_id: session.deviceId,
          session_id: session.sessionId,
        }),
      });
    } catch {
      // The failure may quote the request, so none of it is passed on.
      throw new SharingUnavailable(
        "memtrace.io could not be reached to sign in to sharing. Check your connection and try again.",
      );
    }
  }
}

async function replyOf(response: Response): Promise<unknown> {
  try {
    return await boundedBetaJSON(response);
  } catch (failure) {
    throw failure instanceof BetaRequestError
      ? refusedExchange(failure.status)
      : unexpectedReply();
  }
}
