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
export interface GrpcChannel {
  /** One request, one reply. */
  unary(call: GrpcCall): Promise<Uint8Array>;
  close(): void;
}
export interface GrpcChannelOptions {
  /** How long an unused connection is kept. A stale one is the usual way a call hangs. */
  idleMs?: number;
  maxReplyBytes?: number;
}

const FRAME_HEADER_BYTES = 5,
  NOT_COMPRESSED = 0;
const DEFAULT_TIMEOUT_MS = 10_000,
  DEFAULT_IDLE_MS = 10_000,
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

function outcome({
  headers,
  trailers,
  body,
}: Received): Uint8Array | GrpcFailure {
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
  if (code === grpcStatus.OK) return soleMessage(Buffer.concat(body));
  return new GrpcFailure(
    Number.isInteger(code) ? code : grpcStatus.UNKNOWN,
    reasonSent(metadata["grpc-message"]),
    metadata,
  );
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
    maxReplyBytes = options.maxReplyBytes ?? DEFAULT_MAX_REPLY_BYTES;
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
    close() {
      closed = true;
      clearTimeout(idle);
      session?.close();
      session = undefined;
    },
  };
}
