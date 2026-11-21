import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";
import { createServer as createPlainServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  GrpcFailure,
  grpcChannel,
  grpcStatus,
} from "../runtime/sharing/memsync/grpc";

type Answer = (
  stream: ServerHttp2Stream,
  headers: IncomingHttpHeaders,
  request: Buffer,
) => void;

const framed = (message: Uint8Array, compressed = 0) => {
  const frame = Buffer.alloc(5 + message.length);
  frame[0] = compressed;
  frame.writeUInt32BE(message.length, 1);
  frame.set(message, 5);
  return frame;
};
const reply = (stream: ServerHttp2Stream, message: Uint8Array) => {
  stream.respond(
    { ":status": 200, "content-type": "application/grpc" },
    { waitForTrailers: true },
  );
  stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
  stream.end(framed(message));
};
const refuse = (
  stream: ServerHttp2Stream,
  status: number,
  message: string,
  metadata: Record<string, string> = {},
) =>
  stream.respond(
    {
      ":status": 200,
      "content-type": "application/grpc",
      "grpc-status": String(status),
      "grpc-message": encodeURIComponent(message),
      ...metadata,
    },
    { endStream: true },
  );

async function listening(answer: Answer) {
  const server: Http2Server = createServer();
  let sessions = 0;
  const open = new Set<import("node:http2").ServerHttp2Session>();
  server.on("session", (session) => {
    sessions++;
    open.add(session);
    session.on("close", () => open.delete(session));
  });
  server.on("stream", (stream, headers) => {
    const parts: Buffer[] = [];
    stream.on("error", () => {});
    stream.on("data", (part: Buffer) => parts.push(part));
    stream.on("end", () =>
      answer(stream as ServerHttp2Stream, headers, Buffer.concat(parts)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    address: new URL(`http://127.0.0.1:${port}`),
    get sessions() {
      return sessions;
    },
    hangUp: () => open.forEach((session) => session.destroy()),
    close: async () => {
      open.forEach((session) => session.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const failure = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof GrpcFailure, String(error));
    return error;
  }
  assert.fail("The call was expected to fail.");
};
const say = (text: string) => new Uint8Array(Buffer.from(text));

test("a call sends one framed message to the method's path and reads the framed reply", async () => {
  let seen: IncomingHttpHeaders = {};
  const server = await listening((stream, headers, request) => {
    seen = headers;
    assert.equal(request[0], 0);
    assert.equal(request.readUInt32BE(1), request.length - 5);
    reply(stream, say(request.subarray(5).toString().toUpperCase()));
  });
  const channel = grpcChannel(server.address);
  try {
    const answer = await channel.unary({
      path: "/memsync.v1.Projects/ListProjects",
      request: say("hello"),
      metadata: { authorization: "Bearer token-1" },
      timeoutMs: 2500,
    });
    assert.equal(Buffer.from(answer).toString(), "HELLO");
    assert.equal(seen[":method"], "POST");
    assert.equal(seen[":path"], "/memsync.v1.Projects/ListProjects");
    assert.equal(seen["content-type"], "application/grpc");
    assert.equal(seen.te, "trailers");
    assert.equal(seen["grpc-timeout"], "2500m");
    assert.equal(seen.authorization, "Bearer token-1");
  } finally {
    channel.close();
    await server.close();
  }
});

test("an empty request and an empty reply are both whole messages", async () => {
  const server = await listening((stream, _headers, request) => {
    assert.equal(request.length, 5);
    reply(stream, new Uint8Array());
  });
  const channel = grpcChannel(server.address);
  try {
    const answer = await channel.unary({
      path: "/s/m",
      request: new Uint8Array(),
    });
    assert.equal(answer.length, 0);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a call that is turned down fails with its status, reason and metadata", async () => {
  const server = await listening((stream) =>
    refuse(stream, grpcStatus.NOT_FOUND, "there is no such project — 100%", {
      "memsync-refusal": "no_such_project",
    }),
  );
  const channel = grpcChannel(server.address);
  try {
    const refused = await failure(
      channel.unary({ path: "/s/m", request: say("") }),
    );
    assert.equal(refused.code, grpcStatus.NOT_FOUND);
    assert.equal(refused.message, "there is no such project — 100%");
    assert.equal(refused.metadata["memsync-refusal"], "no_such_project");
  } finally {
    channel.close();
    await server.close();
  }
});

test("a status sent after the reply still fails the call", async () => {
  const server = await listening((stream) => {
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () =>
      stream.sendTrailers({
        "grpc-status": String(grpcStatus.UNAVAILABLE),
        "grpc-message": "the%20database%20is%20away",
      }),
    );
    stream.end(framed(say("half an answer")));
  });
  const channel = grpcChannel(server.address);
  try {
    const failed = await failure(
      channel.unary({ path: "/s/m", request: say("") }),
    );
    assert.equal(failed.code, grpcStatus.UNAVAILABLE);
    assert.equal(failed.message, "the database is away");
  } finally {
    channel.close();
    await server.close();
  }
});

test("a service that does not answer in time is given up on, and told so", async () => {
  let cancelled!: () => void;
  const serverSawCancel = new Promise<void>((resolve) => (cancelled = resolve));
  const server = await listening((stream) => stream.on("close", cancelled));
  const channel = grpcChannel(server.address);
  try {
    const started = Date.now();
    const late = await failure(
      channel.unary({ path: "/s/m", request: say(""), timeoutMs: 120 }),
    );
    assert.equal(late.code, grpcStatus.DEADLINE_EXCEEDED);
    assert.ok(Date.now() - started < 2000);
    await serverSawCancel;
  } finally {
    channel.close();
    await server.close();
  }
});

test("nothing listening at the address reads as unavailable", async () => {
  const server = await listening(() => {});
  const { address } = server;
  await server.close();
  const channel = grpcChannel(address);
  try {
    const down = await failure(
      channel.unary({ path: "/s/m", request: say(""), timeoutMs: 2000 }),
    );
    assert.equal(down.code, grpcStatus.UNAVAILABLE);
  } finally {
    channel.close();
  }
});

test("a proxy's own answer is read by its HTTP status", async () => {
  const expected: Array<[number, number]> = [
    [401, grpcStatus.UNAUTHENTICATED],
    [403, grpcStatus.PERMISSION_DENIED],
    [404, grpcStatus.UNIMPLEMENTED],
    [502, grpcStatus.UNAVAILABLE],
    [503, grpcStatus.UNAVAILABLE],
    [504, grpcStatus.UNAVAILABLE],
    [500, grpcStatus.UNKNOWN],
  ];
  for (const [http, code] of expected) {
    const server = await listening((stream) => {
      stream.respond({ ":status": http, "content-type": "text/html" });
      stream.end("<h1>Bad gateway</h1>");
    });
    const channel = grpcChannel(server.address);
    try {
      const failed = await failure(
        channel.unary({ path: "/s/m", request: say("") }),
      );
      assert.equal(failed.code, code, `HTTP ${http}`);
    } finally {
      channel.close();
      await server.close();
    }
  }
});

test("a web page at the address is not mistaken for an answer", async () => {
  const server = await listening((stream) => {
    stream.respond({ ":status": 200, "content-type": "text/html" });
    stream.end("<h1>Welcome</h1>");
  });
  const channel = grpcChannel(server.address);
  try {
    const failed = await failure(
      channel.unary({ path: "/s/m", request: say("") }),
    );
    assert.equal(failed.code, grpcStatus.UNKNOWN);
    assert.match(failed.message, /not a sharing service/i);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a server that only speaks HTTP/1.1 reads as unavailable", async () => {
  const server = createPlainServer((_request, response) =>
    response.end("hello"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const channel = grpcChannel(new URL(`http://127.0.0.1:${port}`));
  try {
    const failed = await failure(
      channel.unary({ path: "/s/m", request: say(""), timeoutMs: 2000 }),
    );
    assert.equal(failed.code, grpcStatus.UNAVAILABLE);
  } finally {
    channel.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a reply that is cut short, compressed, doubled or missing is refused", async () => {
  const broken: Array<[string, (stream: ServerHttp2Stream) => void]> = [
    ["cut short", (stream) => stream.end(framed(say("whole")).subarray(0, 7))],
    ["compressed", (stream) => stream.end(framed(say("squeezed"), 1))],
    [
      "doubled",
      (stream) =>
        stream.end(Buffer.concat([framed(say("a")), framed(say("b"))])),
    ],
    ["missing", (stream) => stream.end()],
  ];
  for (const [name, send] of broken) {
    const server = await listening((stream) => {
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () =>
        stream.sendTrailers({ "grpc-status": "0" }),
      );
      send(stream);
    });
    const channel = grpcChannel(server.address);
    try {
      const failed = await failure(
        channel.unary({ path: "/s/m", request: say("") }),
      );
      assert.equal(failed.code, grpcStatus.INTERNAL, name);
    } finally {
      channel.close();
      await server.close();
    }
  }
});

test("a reply larger than the limit is refused before it is all read", async () => {
  const server = await listening((stream) =>
    reply(stream, new Uint8Array(70000)),
  );
  const channel = grpcChannel(server.address, { maxReplyBytes: 4096 });
  try {
    const failed = await failure(
      channel.unary({ path: "/s/m", request: say("") }),
    );
    assert.equal(failed.code, grpcStatus.RESOURCE_EXHAUSTED);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a reply that ends without any status reads as unavailable", async () => {
  const server = await listening((stream) => {
    stream.respond({ ":status": 200, "content-type": "application/grpc" });
    stream.end(framed(say("no trailers follow")));
  });
  const channel = grpcChannel(server.address);
  try {
    const failed = await failure(
      channel.unary({ path: "/s/m", request: say("") }),
    );
    assert.equal(failed.code, grpcStatus.UNAVAILABLE);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a path in the service's address goes in front of every call", async () => {
  let path = "";
  const server = await listening((stream, headers) => {
    path = String(headers[":path"]);
    reply(stream, say("ok"));
  });
  const behindProxy = new URL("/memsync/", server.address);
  const channel = grpcChannel(behindProxy);
  try {
    await channel.unary({
      path: "/memsync.v1.Projects/GetProject",
      request: say(""),
    });
    assert.equal(path, "/memsync/memsync.v1.Projects/GetProject");
  } finally {
    channel.close();
    await server.close();
  }
});

test("calls made together share a connection, and a lost connection is replaced", async () => {
  const server = await listening((stream, _headers, request) =>
    reply(stream, request.subarray(5)),
  );
  const channel = grpcChannel(server.address);
  try {
    const answers = await Promise.all(
      ["one", "two", "three"].map((text) =>
        channel.unary({ path: "/s/m", request: say(text) }),
      ),
    );
    assert.deepEqual(
      answers.map((answer) => Buffer.from(answer).toString()),
      ["one", "two", "three"],
    );
    assert.equal(server.sessions, 1);
    server.hangUp();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const again = await channel.unary({ path: "/s/m", request: say("four") });
    assert.equal(Buffer.from(again).toString(), "four");
    assert.equal(server.sessions, 2);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a connection nobody has used for a while is closed, and the next call opens another", async () => {
  const server = await listening((stream) => reply(stream, say("ok")));
  const channel = grpcChannel(server.address, { idleMs: 40 });
  try {
    await channel.unary({ path: "/s/m", request: say("") });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await channel.unary({ path: "/s/m", request: say("") });
    assert.equal(server.sessions, 2);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a closed channel makes no more calls", async () => {
  const server = await listening((stream) => reply(stream, say("ok")));
  const channel = grpcChannel(server.address);
  try {
    await channel.unary({ path: "/s/m", request: say("") });
    channel.close();
    const failed = await failure(
      channel.unary({ path: "/s/m", request: say("") }),
    );
    assert.equal(failed.code, grpcStatus.CANCELLED);
    assert.equal(server.sessions, 1);
  } finally {
    await server.close();
  }
});
