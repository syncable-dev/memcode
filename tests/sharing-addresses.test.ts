import test from "node:test";
import assert from "node:assert/strict";
import { sharingAddresses } from "../runtime/sharing/addresses";

const hosted = {
  memsyncUrl: "https://sync.memtrace.io",
  tokenUrl: "https://www.memtrace.io/api/memcode/memsync/token",
};

test("sharing is absent until both addresses are set", () => {
  assert.equal(sharingAddresses(undefined), null);
  assert.equal(sharingAddresses({ memsyncUrl: "", tokenUrl: "" }), null);
  assert.equal(sharingAddresses({ memsyncUrl: "  ", tokenUrl: "\t" }), null);
});

test("one address without the other is a mistake, not a setting", () => {
  for (const half of [
    { ...hosted, tokenUrl: "" },
    { ...hosted, memsyncUrl: " " },
  ])
    assert.throws(() => sharingAddresses(half), /both/);
});

test("a hosted sharing service and memtrace.io's token endpoint are accepted as typed", () => {
  const addresses = sharingAddresses({
    memsyncUrl: "  https://sync.memtrace.io  ",
    tokenUrl: hosted.tokenUrl,
  })!;
  assert.equal(addresses.memsync.href, "https://sync.memtrace.io/");
  assert.equal(addresses.tokenEndpoint.href, hosted.tokenUrl);
});

test("a sharing service behind a path keeps its path", () => {
  const addresses = sharingAddresses({
    ...hosted,
    memsyncUrl: "https://company.example/memsync/",
  })!;
  assert.equal(addresses.memsync.href, "https://company.example/memsync/");
});

test("an unencrypted sharing service is accepted on this computer only", () => {
  for (const local of [
    "http://127.0.0.1:50061",
    "http://localhost:50061",
    "http://[::1]:50061",
  ])
    assert.ok(sharingAddresses({ ...hosted, memsyncUrl: local }));
  for (const exposed of [
    "http://sync.memtrace.io",
    "http://192.168.1.20:50061",
    "http://localhost.example.com:50061",
  ])
    assert.throws(
      () => sharingAddresses({ ...hosted, memsyncUrl: exposed }),
      /https:\/\//,
    );
});

test("an address that is not a plain web address is refused", () => {
  for (const memsyncUrl of [
    "sync.memtrace.io",
    "grpc://sync.memtrace.io",
    "https://someone:secret@sync.memtrace.io",
    "https://sync.memtrace.io/?token=1",
    "https://sync.memtrace.io/#part",
    "not an address",
  ])
    assert.throws(() => sharingAddresses({ ...hosted, memsyncUrl }), Error);
  for (const tokenUrl of [
    "www.memtrace.io/api/memcode/memsync/token",
    "https://someone:secret@www.memtrace.io/api/memcode/memsync/token",
    "https://www.memtrace.io/api/memcode/memsync/token?next=1",
  ])
    assert.throws(() => sharingAddresses({ ...hosted, tokenUrl }), Error);
});

test("the Memtrace sign-in is shown to memtrace.io or to this computer, nobody else", () => {
  for (const tokenUrl of [
    "https://www.memtrace.io/api/memcode/memsync/token",
    "http://127.0.0.1:3000/api/memcode/memsync/token",
    "http://localhost:3000/api/memcode/memsync/token",
  ])
    assert.ok(sharingAddresses({ ...hosted, tokenUrl }));
  for (const tokenUrl of [
    "https://tokens.example.com/api/memcode/memsync/token",
    "https://www.memtrace.io.example.com/api/memcode/memsync/token",
    "https://memtrace.io.evil.example/token",
    "http://www.memtrace.io/api/memcode/memsync/token",
    "https://www.memtrace.io:8443/api/memcode/memsync/token",
  ])
    assert.throws(
      () => sharingAddresses({ ...hosted, tokenUrl }),
      /memtrace\.io/,
    );
});
