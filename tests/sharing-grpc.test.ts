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

const trailersWhenDone = (stream: ServerHttp2Stream, status = "0") => {
  stream.respond(
    { ":status": 200, "content-type": "application/grpc" },
    { waitForTrailers: true },
  );
  stream.on("wantTrailers", () =>
    stream.sendTrailers({ "grpc-status": status }),
  );
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (message: Uint8Array) => Buffer.from(message).toString();

test("a watched call hands over each message as it arrives, in order, until the service ends it", async () => {
  const server = await listening(async (stream) => {
    trailersWhenDone(stream);
    // Two messages in one piece, then one message in two pieces.
    stream.write(Buffer.concat([framed(say("one")), framed(say("two"))]));
    await pause(20);
    const third = framed(say("three"));
    stream.write(third.subarray(0, 3));
    await pause(20);
    stream.write(third.subarray(3));
    await pause(20);
    stream.end(framed(new Uint8Array()));
  });
  const channel = grpcChannel(server.address);
  try {
    const seen: string[] = [];
    const watching = channel.serverStream(
      { path: "/s/watch", request: say("from 41") },
      (message) => void seen.push(text(message)),
    );
    await watching.finished;
    assert.deepEqual(seen, ["one", "two", "three", ""]);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a watched call sends its request and metadata like any other, with no deadline on the stream", async () => {
  let seen: IncomingHttpHeaders = {},
    asked = "";
  const server = await listening((stream, headers, request) => {
    seen = headers;
    asked = request.subarray(5).toString();
    trailersWhenDone(stream);
    stream.end();
  });
  const channel = grpcChannel(new URL("/memsync/", server.address));
  try {
    await channel.serverStream(
      {
        path: "/memsync.v1.Boards/WatchUpdates",
        request: say("after 7"),
        metadata: { authorization: "Bearer token-1" },
      },
      () => {},
    ).finished;
    assert.equal(asked, "after 7");
    assert.equal(seen[":path"], "/memsync/memsync.v1.Boards/WatchUpdates");
    assert.equal(seen.authorization, "Bearer token-1");
    assert.equal(seen["content-type"], "application/grpc");
    assert.equal(seen["grpc-timeout"], undefined);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a stream the service ends with a status fails with it, after the messages before it", async () => {
  const server = await listening((stream) => {
    trailersWhenDone(stream, String(grpcStatus.UNAVAILABLE));
    stream.end(framed(say("last one")));
  });
  const channel = grpcChannel(server.address);
  try {
    const seen: string[] = [];
    const ended = await failure(
      channel.serverStream(
        { path: "/s/watch", request: say("") },
        (message) => {
          seen.push(text(message));
        },
      ).finished,
    );
    assert.equal(ended.code, grpcStatus.UNAVAILABLE);
    assert.deepEqual(seen, ["last one"]);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a watched call that is turned down at once fails with the rule's name", async () => {
  const server = await listening((stream) =>
    refuse(stream, grpcStatus.NOT_FOUND, "there is no such project", {
      "memsync-refusal": "no_such_project",
    }),
  );
  const channel = grpcChannel(server.address);
  try {
    const refused = await failure(
      channel.serverStream({ path: "/s/watch", request: say("") }, () => {})
        .finished,
    );
    assert.equal(refused.code, grpcStatus.NOT_FOUND);
    assert.equal(refused.metadata["memsync-refusal"], "no_such_project");
  } finally {
    channel.close();
    await server.close();
  }
});

test("hanging up ends a watched call quietly, and the service sees it go", async () => {
  let gone!: () => void;
  const serviceSawItGo = new Promise<void>((resolve) => (gone = resolve));
  const server = await listening((stream) => {
    trailersWhenDone(stream);
    stream.write(framed(say("first")));
    stream.on("close", gone);
  });
  const channel = grpcChannel(server.address);
  try {
    const seen: string[] = [];
    const watching = channel.serverStream(
      { path: "/s/watch", request: say("") },
      (message) => void seen.push(text(message)),
    );
    await pause(40);
    watching.cancel();
    await watching.finished;
    await serviceSawItGo;
    assert.deepEqual(seen, ["first"]);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a slow reader gets one message at a time and none is lost", async () => {
  const count = 200;
  const server = await listening((stream) => {
    trailersWhenDone(stream);
    for (let number = 0; number < count; number++)
      stream.write(framed(say(String(number))));
    stream.end();
  });
  const channel = grpcChannel(server.address);
  try {
    const seen: number[] = [];
    let inHand = 0,
      mostInHand = 0;
    await channel.serverStream(
      { path: "/s/watch", request: say("") },
      async (message) => {
        mostInHand = Math.max(mostInHand, ++inHand);
        await pause(1);
        seen.push(Number(text(message)));
        inHand--;
      },
    ).finished;
    assert.equal(mostInHand, 1);
    assert.deepEqual(
      seen,
      Array.from({ length: count }, (_, number) => number),
    );
  } finally {
    channel.close();
    await server.close();
  }
});

test("a reader that fails ends the stream with its own failure", async () => {
  const server = await listening((stream) => {
    trailersWhenDone(stream);
    stream.write(
      Buffer.concat([
        framed(say("fine")),
        framed(say("bad")),
        framed(say("never")),
      ]),
    );
  });
  const channel = grpcChannel(server.address);
  try {
    const seen: string[] = [];
    await assert.rejects(
      channel.serverStream(
        { path: "/s/watch", request: say("") },
        (message) => {
          seen.push(text(message));
          if (text(message) === "bad") throw new Error("could not keep it");
        },
      ).finished,
      /could not keep it/,
    );
    assert.deepEqual(seen, ["fine", "bad"]);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a streamed message that is too large, compressed or cut short ends the stream", async () => {
  const broken: Array<[string, number, (stream: ServerHttp2Stream) => void]> = [
    [
      "too large",
      grpcStatus.RESOURCE_EXHAUSTED,
      (stream) => stream.end(framed(new Uint8Array(5000))),
    ],
    [
      "compressed",
      grpcStatus.INTERNAL,
      (stream) => stream.end(framed(say("squeezed"), 1)),
    ],
    [
      "cut short",
      grpcStatus.INTERNAL,
      (stream) => stream.end(framed(say("whole")).subarray(0, 7)),
    ],
  ];
  for (const [name, code, send] of broken) {
    const server = await listening((stream) => {
      trailersWhenDone(stream);
      send(stream);
    });
    const channel = grpcChannel(server.address, { maxReplyBytes: 4096 });
    try {
      const ended = await failure(
        channel.serverStream({ path: "/s/watch", request: say("") }, () => {})
          .finished,
      );
      assert.equal(ended.code, code, name);
    } finally {
      channel.close();
      await server.close();
    }
  }
});

test("a service that never begins to answer a watched call is given up on", async () => {
  const server = await listening(() => {});
  const channel = grpcChannel(server.address);
  try {
    const late = await failure(
      channel.serverStream(
        { path: "/s/watch", request: say(""), timeoutMs: 100 },
        () => {},
      ).finished,
    );
    assert.equal(late.code, grpcStatus.DEADLINE_EXCEEDED);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a quiet stream keeps its connection, and a connection lost under it ends it as unavailable", async () => {
  let send!: (message: string) => void;
  const server = await listening((stream) => {
    trailersWhenDone(stream);
    stream.write(framed(say("first")));
    send = (message) => stream.write(framed(say(message)));
  });
  const channel = grpcChannel(server.address, { idleMs: 30, keepAliveMs: 25 });
  try {
    const seen: string[] = [];
    const watching = channel.serverStream(
      { path: "/s/watch", request: say("") },
      (message) => void seen.push(text(message)),
    );
    // Longer than an unused connection is kept, with a call made and finished in between.
    await pause(150);
    send("after a long silence");
    await pause(40);
    assert.deepEqual(seen, ["first", "after a long silence"]);
    assert.equal(server.sessions, 1);
    server.hangUp();
    const lost = await failure(watching.finished);
    assert.equal(lost.code, grpcStatus.UNAVAILABLE);
  } finally {
    channel.close();
    await server.close();
  }
});

test("a closed channel starts no watched call", async () => {
  const server = await listening((stream) => trailersWhenDone(stream));
  const channel = grpcChannel(server.address);
  channel.close();
  try {
    const refused = await failure(
      channel.serverStream({ path: "/s/watch", request: say("") }, () => {})
        .finished,
    );
    assert.equal(refused.code, grpcStatus.CANCELLED);
    assert.equal(server.sessions, 0);
  } finally {
    await server.close();
  }
});
