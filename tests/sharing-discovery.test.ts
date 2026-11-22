import test from "node:test";
import assert from "node:assert/strict";
import { sharingFinder, sharingInList } from "../runtime/sharing/discovery";

const list = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

test("the sharing service is found in memtrace.io's list of MemCode services", async () => {
  const asked: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    asked.push(url);
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    return new Response(
      JSON.stringify({
        version: 1,
        teamRelay: null,
        sharing: {
          endpoint: "https://sync.memtrace.io",
          tokenEndpoint: "https://www.memtrace.io/api/memcode/memsync/token",
        },
      }),
    );
  }) as unknown as typeof fetch;
  const find = sharingFinder({ fetcher, environment: {} });
  assert.deepEqual(await find(), {
    memsyncUrl: "https://sync.memtrace.io",
    tokenUrl: "https://www.memtrace.io/api/memcode/memsync/token",
  });
  assert.deepEqual(asked, ["https://www.memtrace.io/api/memcode/services"]);
  // Asked again within a minute, the list is not read again.
  await find();
  assert.equal(asked.length, 1);
});

test("a list without sharing, or one MemCode cannot read, means sharing is not offered", async (context) => {
  context.mock.method(console, "error", () => {});
  assert.equal(sharingInList({ version: 1, teamRelay: null }), undefined);
  assert.equal(sharingInList({ version: 1, sharing: null }), undefined);
  for (const fetcher of [
    list({ version: 1 }),
    list({ version: 2, sharing: { endpoint: "x", tokenEndpoint: "y" } }),
    list({ version: 1, sharing: { endpoint: "https://sync.memtrace.io" } }),
    list({}, 503),
    (async () => new Response("not json")) as typeof fetch,
    (async () => {
      throw new Error("offline");
    }) as typeof fetch,
  ])
    assert.equal(
      await sharingFinder({ fetcher, environment: {} })(),
      undefined,
    );
});

test("a list that could not be read is asked again after a minute", async (context) => {
  context.mock.method(console, "error", () => {});
  let clock = 0,
    asked = 0;
  const fetcher = (async () => {
    asked++;
    throw new Error("offline");
  }) as typeof fetch;
  const find = sharingFinder({ fetcher, environment: {}, now: () => clock });
  await find();
  await find();
  assert.equal(asked, 1);
  clock = 61_000;
  await find();
  assert.equal(asked, 2);
});

test("for tests and a local demo, two environment variables name local servers instead", async () => {
  const fetcher = (async () => {
    throw new Error("the list is not read");
  }) as typeof fetch;
  const find = sharingFinder({
    fetcher,
    environment: {
      MEMCODE_DEV_SHARING_SERVICE: "http://127.0.0.1:50081",
      MEMCODE_DEV_SHARING_TOKEN_ADDRESS:
        "http://127.0.0.1:3461/api/memcode/memsync/token",
    },
  });
  assert.deepEqual(await find(), {
    memsyncUrl: "http://127.0.0.1:50081",
    tokenUrl: "http://127.0.0.1:3461/api/memcode/memsync/token",
  });
});
