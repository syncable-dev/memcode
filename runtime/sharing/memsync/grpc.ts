import {
  connect,
  constants,
  type ClientHttp2Session,
  type IncomingHttpHeaders,
} from "node:http2";

/** gRPC's status codes, by the names the protocol gives them. */
export const grpcStatus = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

/** A call that did not end in a reply: the service's own status, or one this client gave it. */
export class GrpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly metadata: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "GrpcFailure";
  }
}

export interface GrpcCall {
  /** `/package.Service/Method`. */
  path: string;
  request: Uint8Array;
  metadata?: Record<string, string>;
  timeoutMs?: number;
}
/** A call the service keeps answering until it ends the call or the caller hangs up. */
export interface GrpcStream {
  /** Settles when the stream is over: rejects with what ended it, unless the caller hung up. */
  finished: Promise<void>;
  cancel(): void;
}
export interface GrpcChannel {
  /** One request, one reply. */
  unary(call: GrpcCall): Promise<Uint8Array>;
  /**
   * One request, then a message at a time for as long as the service sends them.
   * `timeoutMs` is how long the service may take to begin. Messages are handed
   * over in order, the next one only when the one before has been dealt with.
   */
  serverStream(
    call: GrpcCall,
    onMessage: (message: Uint8Array) => void | Promise<void>,
  ): GrpcStream;
  close(): void;
}
export interface GrpcChannelOptions {
  /** How long an unused connection is kept. A stale one is the usual way a call hangs. */
  idleMs?: number;
  maxReplyBytes?: number;
  /** How often a connection with an open stream is asked whether it is still there. */
  keepAliveMs?: number;
}

const FRAME_HEADER_BYTES = 5,
  NOT_COMPRESSED = 0;
const DEFAULT_TIMEOUT_MS = 10_000,
  DEFAULT_IDLE_MS = 10_000,
  DEFAULT_KEEP_ALIVE_MS = 20_000,
  // A stream can be silent for hours, so a lost connection shows only when asked.
  KEEP_ALIVE_PATIENCE_MS = 10_000,
  // Messages read ahead of a slow reader before the service is asked to wait.
  HELD_FOR_A_SLOW_READER = 32,
  // What a gRPC server sends at most unless it is set up otherwise.
  DEFAULT_MAX_REPLY_BYTES = 4 * 1024 * 1024;

function frame(message: Uint8Array): Buffer {
  const framed = Buffer.alloc(FRAME_HEADER_BYTES + message.length);
  framed[0] = NOT_COMPRESSED;
  framed.writeUInt32BE(message.length, 1);
  framed.set(message, FRAME_HEADER_BYTES);
  return framed;
}

/** A reply to a unary call is exactly one uncompressed message. */
function soleMessage(body: Buffer): Uint8Array | GrpcFailure {
  const unreadable = (what: string) =>
    new GrpcFailure(
      grpcStatus.INTERNAL,
      `The sharing service sent a reply that ${what}.`,
    );
  if (body.length < FRAME_HEADER_BYTES) return unreadable("holds no message");
  if (body[0] !== NOT_COMPRESSED) return unreadable("is compressed");
  const length = body.readUInt32BE(1);
  if (body.length < FRAME_HEADER_BYTES + length)
    return unreadable("is cut short");
  if (body.length > FRAME_HEADER_BYTES + length)
    return unreadable("holds more than one message");
  return new Uint8Array(body.subarray(FRAME_HEADER_BYTES));
}

function metadataFrom(headers: IncomingHttpHeaders | undefined) {
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {}))
    if (!name.startsWith(":") && value !== undefined)
      metadata[name] = Array.isArray(value) ? value.join(", ") : value;
  return metadata;
}

function reasonSent(encoded: string | undefined): string {
  if (!encoded) return "The sharing service turned the call down.";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** What a proxy means when it answers itself, as gRPC maps HTTP statuses. */
function statusOfHttp(http: number): number {
  if (http === 401) return grpcStatus.UNAUTHENTICATED;
  if (http === 403) return grpcStatus.PERMISSION_DENIED;
  if (http === 404) return grpcStatus.UNIMPLEMENTED;
  if ([429, 502, 503, 504].includes(http)) return grpcStatus.UNAVAILABLE;
  return grpcStatus.UNKNOWN;
}

interface Received {
  headers?: IncomingHttpHeaders;
  trailers?: IncomingHttpHeaders;
  body: Buffer[];
  bytes: number;
}

function withoutStatus(
  headers: IncomingHttpHeaders,
  metadata: Record<string, string>,
) {
  const http = Number(headers[":status"]);
  if (http !== 200)
    return new GrpcFailure(
      statusOfHttp(http),
      `The address answered HTTP ${http} instead of a sharing reply.`,
      metadata,
    );
  if (!String(headers["content-type"] ?? "").startsWith("application/grpc"))
    return new GrpcFailure(
      grpcStatus.UNKNOWN,
      "The address answered, but it is not a sharing service.",
      metadata,
    );
  return new GrpcFailure(
    grpcStatus.UNAVAILABLE,
    "The connection was cut before the sharing service finished its answer.",
    metadata,
  );
}

/** Why the call did not succeed, or nothing when the service said it did. */
function failureOf({ headers, trailers }: Received): GrpcFailure | undefined {
  if (!headers)
    return new GrpcFailure(
      grpcStatus.UNAVAILABLE,
      "The sharing service closed the connection before it answered.",
    );
  // A call that is turned down at once carries its status in the first headers.
  const metadata = { ...metadataFrom(headers), ...metadataFrom(trailers) };
  const status = metadata["grpc-status"];
  if (status === undefined) return withoutStatus(headers, metadata);
  const code = Number(status);
  if (code === grpcStatus.OK) return undefined;
  return new GrpcFailure(
    Number.isInteger(code) ? code : grpcStatus.UNKNOWN,
    reasonSent(metadata["grpc-message"]),
    metadata,
  );
}

const outcome = (received: Received): Uint8Array | GrpcFailure =>
  failureOf(received) ?? soleMessage(Buffer.concat(received.body));

/** The first whole message in what has arrived so far, or nothing when more bytes are needed. */
function nextMessage(
  arrived: Buffer,
  maxMessageBytes: number,
): { message: Uint8Array; rest: Buffer } | GrpcFailure | undefined {
  if (arrived.length < FRAME_HEADER_BYTES) return undefined;
  if (arrived[0] !== NOT_COMPRESSED)
    return new GrpcFailure(
      grpcStatus.INTERNAL,
      "The sharing service sent a message that is compressed.",
    );
  const end = FRAME_HEADER_BYTES + arrived.readUInt32BE(1);
  if (end - FRAME_HEADER_BYTES > maxMessageBytes)
    return new GrpcFailure(
      grpcStatus.RESOURCE_EXHAUSTED,
      "The sharing service sent a larger message than MemCode reads.",
    );
  if (arrived.length < end) return undefined;
  return {
    message: new Uint8Array(arrived.subarray(FRAME_HEADER_BYTES, end)),
    rest: arrived.subarray(end),
  };
}

const notReached = (error: unknown) =>
  new GrpcFailure(
    grpcStatus.UNAVAILABLE,
    `The sharing service could not be reached (${
      (error as NodeJS.ErrnoException).code ?? (error as Error).message
    }).`,
  );

function exchange(
  session: ClientHttp2Session,
  path: string,
  call: GrpcCall,
  maxReplyBytes: number,
): Promise<Uint8Array> {
  const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const received: Received = { body: [], bytes: 0 };
    const stream = session.request({
      ...call.metadata,
      ":method": "POST",
      ":path": path,
      "content-type": "application/grpc",
      te: "trailers",
      "grpc-timeout": `${timeoutMs}m`,
    });
    let finished = false;
    const finish = (result: Uint8Array | GrpcFailure) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (!(result instanceof GrpcFailure)) return resolve(result);
      stream.close(constants.NGHTTP2_CANCEL);
      reject(result);
    };
    const deadline = setTimeout(
      () =>
        finish(
          new GrpcFailure(
            grpcStatus.DEADLINE_EXCEEDED,
            "The sharing service did not answer in time.",
          ),
        ),
      timeoutMs,
    );
    stream.on("response", (headers) => (received.headers = headers));
    stream.on("trailers", (trailers) => (received.trailers = trailers));
    stream.on("data", (part: Buffer) => {
      received.bytes += part.length;
      if (received.bytes <= maxReplyBytes + FRAME_HEADER_BYTES)
        return void received.body.push(part);
      finish(
        new GrpcFailure(
          grpcStatus.RESOURCE_EXHAUSTED,
          "The sharing service sent a larger reply than MemCode reads.",
        ),
      );
    });
    stream.on("error", (error) => finish(notReached(error)));
    stream.on("close", () => finish(outcome(received)));
    stream.end(frame(call.request));
  });
}

function follow(
  session: ClientHttp2Session,
  path: string,
  call: GrpcCall,
  maxMessageBytes: number,
  onMessage: (message: Uint8Array) => void | Promise<void>,
): GrpcStream {
  const received: Received = { body: [], bytes: 0 };
  const stream = session.request({
    ...call.metadata,
    ":method": "POST",
    ":path": path,
    "content-type": "application/grpc",
    te: "trailers",
  });
  let arrived: Buffer = Buffer.alloc(0),
    handling: Promise<void> = Promise.resolve(),
    held = 0,
    hungUp = false,
    failure: unknown;
  const fail = (problem: unknown) => {
    if (failure !== undefined || hungUp) return;
    failure = problem;
    clearTimeout(silence);
    stream.close(constants.NGHTTP2_CANCEL);
  };
  const silence = setTimeout(
    () =>
      fail(
        new GrpcFailure(
          grpcStatus.DEADLINE_EXCEEDED,
          "The sharing service did not answer in time.",
        ),
      ),
    call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const handOver = (message: Uint8Array) => {
    if (++held > HELD_FOR_A_SLOW_READER) stream.pause();
    handling = handling
      .then(() =>
        failure === undefined && !hungUp ? onMessage(message) : undefined,
      )
      .then(() => {
        if (--held <= HELD_FOR_A_SLOW_READER / 2) stream.resume();
      }, fail);
  };
  stream.on("response", (headers) => {
    received.headers = headers;
    clearTimeout(silence);
  });
  stream.on("trailers", (trailers) => (received.trailers = trailers));
  stream.on("data", (part: Buffer) => {
    arrived = arrived.length ? Buffer.concat([arrived, part]) : part;
    for (;;) {
      const next = nextMessage(arrived, maxMessageBytes);
      if (!next) return;
      if (next instanceof GrpcFailure) return fail(next);
      arrived = next.rest;
      handOver(next.message);
    }
  });
  stream.on("error", (error) => fail(notReached(error)));
  const finished = new Promise<void>((resolve, reject) => {
    stream.on("close", () => {
      clearTimeout(silence);
      void handling.then(() => {
        const ended = hungUp
          ? undefined
          : (failure ?? endOf(received, arrived));
        if (ended === undefined) resolve();
        else reject(ended);
      });
    });
  });
  stream.end(frame(call.request));
  return {
    finished,
    cancel() {
      hungUp = true;
      clearTimeout(silence);
      stream.close(constants.NGHTTP2_CANCEL);
    },
  };
}

/** Why a stream that closed did not end well, or nothing when the service ended it properly. */
function endOf(received: Received, unread: Buffer): GrpcFailure | undefined {
  const failure = failureOf(received);
  if (failure || !unread.length) return failure;
  return new GrpcFailure(
    grpcStatus.INTERNAL,
    "The sharing service ended in the middle of a message.",
  );
}

/** After one of these the connection itself is in doubt, so the next call opens another. */
const connectionInDoubt = (failure: unknown) =>
  failure instanceof GrpcFailure &&
  (
    [
      grpcStatus.UNAVAILABLE,
      grpcStatus.DEADLINE_EXCEEDED,
      grpcStatus.INTERNAL,
      grpcStatus.UNKNOWN,
    ] as number[]
  ).includes(failure.code);

/**
 * gRPC over Node's own HTTP/2: `http://` is unencrypted HTTP/2, `https://` is TLS.
 * One connection is opened when first needed and kept while it is in use.
 */
export function grpcChannel(
  address: URL,
  options: GrpcChannelOptions = {},
): GrpcChannel {
  const pathPrefix = address.pathname.replace(/\/+$/, "");
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS,
    maxReplyBytes = options.maxReplyBytes ?? DEFAULT_MAX_REPLY_BYTES,
    keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  let session: ClientHttp2Session | undefined,
    idle: ReturnType<typeof setTimeout> | undefined,
    callsInFlight = 0,
    closed = false;
  const retire = (retired: ClientHttp2Session) => {
    if (session === retired) session = undefined;
  };
  const connected = (): ClientHttp2Session => {
    if (session && !session.closed && !session.destroyed) return session;
    const opened = connect(address.origin);
    // Each call reports what went wrong with it; the connection only steps aside.
    opened.on("error", () => retire(opened));
    opened.on("goaway", () => retire(opened));
    opened.on("close", () => retire(opened));
    session = opened;
    return opened;
  };
  /** Asks a connection that carries a stream whether it is still there, and drops one that is not. */
  const keptAlive = (carrying: ClientHttp2Session) => {
    const asking = setInterval(() => {
      const gaveUp = setTimeout(
        () => carrying.destroy(),
        KEEP_ALIVE_PATIENCE_MS,
      );
      gaveUp.unref();
      const asked = carrying.ping((unanswered) => {
        clearTimeout(gaveUp);
        if (unanswered) carrying.destroy();
      });
      if (!asked) clearTimeout(gaveUp);
    }, keepAliveMs);
    asking.unref();
    return () => clearInterval(asking);
  };
  const restWhenUnused = () => {
    if (--callsInFlight > 0 || !session) return;
    const resting = session;
    idle = setTimeout(() => {
      retire(resting);
      resting.close();
    }, idleMs);
    idle.unref();
  };
  return {
    async unary(call) {
      if (closed)
        throw new GrpcFailure(
          grpcStatus.CANCELLED,
          "Sharing was closed before the call was made.",
        );
      clearTimeout(idle);
      callsInFlight++;
      let using: ClientHttp2Session | undefined;
      try {
        using = connected();
        return await exchange(
          using,
          pathPrefix + call.path,
          call,
          maxReplyBytes,
        );
      } catch (failure) {
        if (using && connectionInDoubt(failure)) {
          retire(using);
          using.close();
        }
        throw failure instanceof GrpcFailure ? failure : notReached(failure);
      } finally {
        restWhenUnused();
      }
    },
    serverStream(call, onMessage) {
      if (closed)
        return {
          finished: Promise.reject(
            new GrpcFailure(
              grpcStatus.CANCELLED,
              "Sharing was closed before the call was made.",
            ),
          ),
          cancel() {},
        };
      clearTimeout(idle);
      callsInFlight++;
      let using: ClientHttp2Session;
      try {
        using = connected();
      } catch (failure) {
        restWhenUnused();
        return { finished: Promise.reject(notReached(failure)), cancel() {} };
      }
      const stream = follow(
        using,
        pathPrefix + call.path,
        call,
        maxReplyBytes,
        onMessage,
      );
      const stopAsking = keptAlive(using);
      const finished = stream.finished
        .catch((failure) => {
          if (connectionInDoubt(failure)) {
            retire(using);
            using.close();
          }
          throw failure;
        })
        .finally(() => {
          stopAsking();
          restWhenUnused();
        });
      return { finished, cancel: stream.cancel };
    },
    close() {
      closed = true;
      clearTimeout(idle);
      session?.close();
      session = undefined;
    },
  };
}
