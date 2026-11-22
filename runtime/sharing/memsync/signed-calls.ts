import type { AccessToken } from "../access";
import { refusalNamed, SharingUnavailable } from "../problems";
import {
  GrpcFailure,
  grpcStatus,
  type GrpcChannel,
  type GrpcStream,
} from "./grpc";
import {
  decodeMessage,
  encodeMessage,
  WireError,
  type Contract,
  type WireMessage,
} from "./wire";

/** Where access tokens come from, and where one the service refused is handed back. */
export interface AccessTokens {
  current(): Promise<AccessToken>;
  forget(token: string): void;
}

/** One call of one of the sharing service's APIs, with the shapes of what travels. */
export interface ServiceCall {
  service: string;
  name: string;
  contract: Contract;
  request: string;
  reply: string;
}

const REFUSAL_HEADER = "memsync-refusal";

function unavailable(failure: GrpcFailure): SharingUnavailable {
  const serviceAnswered = failure.metadata["grpc-status"] !== undefined;
  let sentence =
    "The address memtrace.io gave for sharing is not a sharing service. Try again later.";
  if (failure.code === grpcStatus.UNAUTHENTICATED)
    sentence =
      "The sharing service did not accept this sign-in. Try again in a few minutes.";
  else if (failure.code === grpcStatus.DEADLINE_EXCEEDED)
    sentence =
      "The sharing service did not answer in time. Try again in a moment.";
  else if (serviceAnswered)
    sentence =
      "The sharing service is having trouble right now. Try again in a few minutes.";
  else if (failure.code === grpcStatus.UNAVAILABLE)
    sentence =
      "The sharing service could not be reached. Check your connection and try again.";
  return new SharingUnavailable(sentence, { cause: failure });
}

/** What to tell the person about a call that did not end in a reply. */
function problemWith(call: ServiceCall, failure: unknown): Error {
  if (failure instanceof WireError)
    return new SharingUnavailable(
      "The sharing service sent a reply MemCode could not read. Updating MemCode may help.",
      { cause: failure },
    );
  if (!(failure instanceof GrpcFailure)) return failure as Error;
  const rule = failure.metadata[REFUSAL_HEADER];
  const refusal = refusalNamed(rule);
  if (refusal) return refusal;
  // The log keeps what the sentence leaves out: which call, and the service's own words.
  console.error(
    `[sharing] ${call.name} failed: status ${failure.code}${rule ? `, rule ${rule}` : ""}: ${failure.message}`,
  );
  if (rule)
    return new SharingUnavailable(
      "The sharing service turned this down for a reason this version of MemCode does not know. Updating MemCode may help.",
      { cause: failure },
    );
  return unavailable(failure);
}

const signInWasRefused = (failure: unknown) =>
  failure instanceof GrpcFailure &&
  failure.code === grpcStatus.UNAUTHENTICATED &&
  !failure.metadata[REFUSAL_HEADER];

/**
 * Calls to the sharing service made as the signed-in person. A token the service
 * refuses is replaced once, because its keys or the token may have just changed.
 * What goes wrong comes back as a problem the person can be told about.
 */
export class SignedCalls {
  constructor(
    private readonly channel: Pick<GrpcChannel, "unary" | "serverStream">,
    private readonly access: AccessTokens,
    private readonly timeoutMs?: number,
  ) {}

  async unary<Answer>(
    call: ServiceCall,
    request: WireMessage,
    read: (reply: WireMessage) => Answer,
  ): Promise<Answer> {
    const first = await this.attempt(call, request, read);
    if ("answer" in first) return first.answer;
    const second = await this.attempt(call, request, read);
    if ("answer" in second) return second.answer;
    throw problemWith(call, second.signInRefused);
  }

  /** A call the service keeps answering. Each message is read before it is handed over. */
  stream(
    call: ServiceCall,
    request: WireMessage,
    onMessage: (message: WireMessage) => void | Promise<void>,
  ): GrpcStream {
    let open: GrpcStream | undefined,
      hungUp = false;
    const follow = async (isLastTry: boolean): Promise<void> => {
      const { token } = await this.access.current();
      if (hungUp) return;
      open = this.channel.serverStream(
        this.sent(call, request, token),
        (bytes) => onMessage(decodeMessage(call.contract, call.reply, bytes)),
      );
      try {
        await open.finished;
      } catch (failure) {
        if (signInWasRefused(failure)) this.access.forget(token);
        if (signInWasRefused(failure) && !isLastTry) return follow(true);
        throw problemWith(call, failure);
      }
    };
    return {
      finished: follow(false),
      cancel() {
        hungUp = true;
        open?.cancel();
      },
    };
  }

  private sent(call: ServiceCall, request: WireMessage, token: string) {
    return {
      path: `/${call.service}/${call.name}`,
      request: encodeMessage(call.contract, call.request, request),
      metadata: { authorization: `Bearer ${token}` },
      timeoutMs: this.timeoutMs,
    };
  }

  /** One try, from the token to the reply as MemCode's own record. */
  private async attempt<Answer>(
    call: ServiceCall,
    request: WireMessage,
    read: (reply: WireMessage) => Answer,
  ): Promise<{ answer: Answer } | { signInRefused: GrpcFailure }> {
    const { token } = await this.access.current();
    try {
      const reply = await this.channel.unary(this.sent(call, request, token));
      return {
        answer: read(decodeMessage(call.contract, call.reply, reply)),
      };
    } catch (failure) {
      if (signInWasRefused(failure)) {
        this.access.forget(token);
        return { signInRefused: failure as GrpcFailure };
      }
      const problem = problemWith(call, failure);
      // A newly verified address reaches the service only in a new token.
      if ("rule" in problem && problem.rule === "email_not_verified")
        this.access.forget(token);
      throw problem;
    }
  }
}
