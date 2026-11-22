import test from "node:test";
import assert from "node:assert/strict";
import { SharingAccess } from "../runtime/sharing/access";
import {
  SharingSignedOut,
  SharingUnavailable,
} from "../runtime/sharing/problems";
import type { BetaSessionProof } from "../runtime/beta";

const tokenEndpoint = new URL(
  "https://www.memtrace.io/api/memcode/memsync/token",
);
const encoded = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
/** Shaped like memtrace.io's token. MemCode never checks the signature; MemSync does. */
const accessToken = (sub: unknown, serial = 0) =>
  [
    encoded({ alg: "EdDSA", typ: "JWT", kid: "test" }),
    encoded({ sub, purpose: "memsync-access", serial }),
    "c2lnbmF0dXJl",
  ].join(".");
const session = (
  changes: Partial<BetaSessionProof> = {},
): BetaSessionProof => ({
  refreshToken: "refresh-" + "r".repeat(40),
  deviceId: "device-1234567890abcdef",
  sessionId: "session-1234567890abcdef",
  accountId: "acct-1",
  ...changes,
});

function fixture() {
  const start = Date.parse("2026-11-21T12:00:00Z");
  let serial = 0;
  const state = {
    now: start,
    session: session() as BetaSessionProof | null,
    requests: [] as Array<{ url: string; init: RequestInit; body: any }>,
    answer: (async () =>
      Response.json({
        access_token: accessToken("acct-1", ++serial),
        token_type: "Bearer",
        expires_in: 600,
      })) as (body: any) => Promise<Response>,
  };
  const access = new SharingAccess({
    session: async () => state.session,
    tokenEndpoint: () => tokenEndpoint,
    now: () => state.now,
    fetcher: (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      state.requests.push({ url: String(url), init: init!, body });
      return state.answer(body);
    }) as typeof fetch,
  });
  return { access, state, start };
}

test("the first call exchanges the Memtrace session for an access token", async () => {
  const f = fixture();
  const access = await f.access.current();
  assert.equal(access.accountId, "acct-1");
  assert.equal(access.token, accessToken("acct-1", 1));
  assert.equal(f.state.requests.length, 1);
  const [{ url, init, body }] = f.state.requests;
  assert.equal(url, tokenEndpoint.href);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal, "the request is given up on after a while");
  assert.equal(
    (init.headers as Record<string, string>)["content-type"],
    "application/json",
  );
  // memtrace.io refuses a request with any other field in it.
  assert.deepEqual(body, {
    refresh_token: f.state.session!.refreshToken,
    device_id: f.state.session!.deviceId,
    session_id: f.state.session!.sessionId,
  });
});

test("a token is reused until a minute before it expires, then renewed", async () => {
  const f = fixture();
  const first = await f.access.current();
  f.state.now = f.start + 8 * 60000 + 59000;
  assert.equal((await f.access.current()).token, first.token);
  assert.equal(f.state.requests.length, 1);
  f.state.now = f.start + 9 * 60000 + 1000;
  const renewed = await f.access.current();
  assert.notEqual(renewed.token, first.token);
  assert.equal(f.state.requests.length, 2);
});

test("a token that lives under two minutes is renewed at half its life", async () => {
  const f = fixture();
  f.state.answer = async () =>
    Response.json({
      access_token: accessToken("acct-1", f.state.requests.length),
      token_type: "Bearer",
      expires_in: 60,
    });
  await f.access.current();
  f.state.now = f.start + 29000;
  await f.access.current();
  assert.equal(f.state.requests.length, 1);
  f.state.now = f.start + 31000;
  await f.access.current();
  assert.equal(f.state.requests.length, 2);
});

test("calls made together ask memtrace.io once", async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const answer = f.state.answer;
  f.state.answer = async (body) => {
    await held;
    return answer(body);
  };
  const together = [f.access.current(), f.access.current(), f.access.current()];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const tokens = await Promise.all(together);
  assert.equal(f.state.requests.length, 1);
  assert.equal(new Set(tokens.map((access) => access.token)).size, 1);
});

test("a token the sharing service would not take is forgotten, and only that one", async () => {
  const f = fixture();
  const first = await f.access.current();
  f.access.forget("some other token");
  assert.equal((await f.access.current()).token, first.token);
  f.access.forget(first.token);
  assert.notEqual((await f.access.current()).token, first.token);
  assert.equal(f.state.requests.length, 2);
});

test("without a Memtrace session nothing is sent and the person is told to sign in", async () => {
  const f = fixture();
  f.state.session = null;
  await assert.rejects(f.access.current(), SharingSignedOut);
  assert.equal(f.state.requests.length, 0);
});

test("a token is never handed to another sign-in, or kept after signing out", async () => {
  const f = fixture();
  const first = await f.access.current();
  f.state.session = session({
    sessionId: "session-of-someone-else-123",
    accountId: "acct-2",
  });
  f.state.answer = async () =>
    Response.json({
      access_token: accessToken("acct-2"),
      token_type: "Bearer",
      expires_in: 600,
    });
  const second = await f.access.current();
  assert.equal(second.accountId, "acct-2");
  assert.notEqual(second.token, first.token);
  f.state.session = null;
  await assert.rejects(f.access.current(), SharingSignedOut);
  assert.equal(f.state.requests.length, 2);
});

test("a call that joins an exchange begun for the sign-in before it asks again for its own", async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.state.answer = async (body) => {
    await held;
    return Response.json({
      access_token: accessToken(
        body.session_id === session().sessionId ? "acct-1" : "acct-2",
      ),
      token_type: "Bearer",
      expires_in: 600,
    });
  };
  const before = f.access.current();
  await new Promise((resolve) => setImmediate(resolve));
  f.state.session = session({
    sessionId: "session-of-someone-else-123",
    accountId: "acct-2",
  });
  const after = f.access.current();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await after).accountId, "acct-2");
  assert.equal((await before).accountId, "acct-1");
});

test("a refresh token that was rotated while the request travelled is replaced once", async () => {
  const f = fixture();
  const rotated = "rotated-" + "n".repeat(40);
  const answer = f.state.answer;
  f.state.answer = async (body) => {
    if (body.refresh_token === rotated) return answer(body);
    f.state.session = session({ refreshToken: rotated });
    return Response.json({ error: "Session not found" }, { status: 401 });
  };
  const access = await f.access.current();
  assert.equal(access.accountId, "acct-1");
  assert.deepEqual(
    f.state.requests.map((request) => request.body.refresh_token),
    [session().refreshToken, rotated],
  );
});

test("a session memtrace.io no longer knows means signing in again, without asking twice", async () => {
  const f = fixture();
  f.state.answer = async () =>
    Response.json({ error: "Session not found" }, { status: 401 });
  await assert.rejects(f.access.current(), SharingSignedOut);
  assert.equal(f.state.requests.length, 1);
});

test("memtrace.io's other answers each say what the person can do", async () => {
  const f = fixture();
  const cases: Array<[number, RegExp]> = [
    [422, /name or email/i],
    [503, /switched off|not set up/i],
    [400, /HTTP 400/],
    [404, /HTTP 404/],
    [429, /HTTP 429/],
    [500, /HTTP 500/],
  ];
  for (const [status, sentence] of cases) {
    f.state.answer = async () => new Response("{}", { status });
    await assert.rejects(f.access.current(), (error) => {
      assert.ok(error instanceof SharingUnavailable, `HTTP ${status}`);
      assert.match(error.message, sentence);
      // memtrace.io names the sign-in address; there is nothing in Settings to check.
      assert.doesNotMatch(error.message, /Settings/);
      return true;
    });
  }
  f.state.answer = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(f.access.current(), (error) => {
    assert.ok(error instanceof SharingUnavailable);
    assert.match(error.message, /could not be reached/);
    return true;
  });
});

test("a reply that is not the token it should be is not used", async () => {
  const f = fixture();
  const good = {
    access_token: accessToken("acct-1"),
    token_type: "Bearer",
    expires_in: 600,
  };
  const wrong: unknown[] = [
    { ...good, token_type: "MAC" },
    { ...good, expires_in: 0 },
    { ...good, expires_in: 901 },
    { ...good, expires_in: 1.5 },
    { ...good, expires_in: "600" },
    { ...good, access_token: undefined },
    { ...good, access_token: "not-a-token" },
    { ...good, access_token: "a.b" },
    { ...good, access_token: "a.!!.c" },
    { ...good, access_token: accessToken(undefined) },
    { ...good, access_token: accessToken("") },
    { ...good, access_token: accessToken(17) },
    { ...good, access_token: accessToken("x".repeat(201)) },
    { ...good, access_token: accessToken("acct-1") + "A".repeat(16384) },
    null,
    [],
    "token",
  ];
  for (const reply of wrong) {
    f.state.answer = async () => Response.json(reply);
    await assert.rejects(
      f.access.current(),
      SharingUnavailable,
      JSON.stringify(reply)?.slice(0, 80),
    );
  }
  f.state.answer = async () =>
    new Response("<!doctype html><title>Memtrace</title>", {
      headers: { "content-type": "text/html" },
    });
  await assert.rejects(f.access.current(), (error) => {
    assert.ok(error instanceof SharingUnavailable);
    assert.match(error.message, /Try again later/);
    assert.doesNotMatch(error.message, /Settings/);
    return true;
  });
  f.state.answer = async () => new Response("x".repeat(40000));
  await assert.rejects(f.access.current(), SharingUnavailable);
});

test("the token belongs to the account that is signed in, or it is not used", async () => {
  const f = fixture();
  f.state.answer = async () =>
    Response.json({
      access_token: accessToken("acct-of-someone-else"),
      token_type: "Bearer",
      expires_in: 600,
    });
  await assert.rejects(f.access.current(), SharingUnavailable);
});

test("no failure repeats the refresh token", async () => {
  const f = fixture();
  const secret = f.state.session!.refreshToken;
  for (const answer of [
    async () =>
      new Response(JSON.stringify({ echoed: secret }), { status: 401 }),
    async () =>
      new Response(JSON.stringify({ echoed: secret }), { status: 500 }),
    async () => Response.json({ echoed: secret }),
    async () => {
      throw new Error("could not send " + secret);
    },
  ]) {
    f.state.answer = answer as () => Promise<Response>;
    await assert.rejects(f.access.current(), (error: Error) => {
      assert.ok(!error.message.includes(secret));
      assert.ok(!String(error.cause ?? "").includes(secret));
      return true;
    });
  }
});
