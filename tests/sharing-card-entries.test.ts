import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cardPayloads,
  publicMessage,
  publicText,
  readCardEntry,
  sessionIdOf,
  type CardRecord,
  type SessionPart,
} from "../runtime/sharing/cards/entries";
import type { Message } from "../src/shared";

const mac = { id: randomUUID(), name: "Mac" };
const at = "2026-11-22T10:00:00.000Z";
const turn = (
  id: string,
  text: string,
  role: Message["role"] = "assistant",
): Message => ({
  id,
  role,
  text,
  at,
});
const session = (changes: Partial<SessionPart> = {}): SessionPart => ({
  id: sessionIdOf(mac.id, "task-1", at),
  harness: "codex",
  state: "running",
  startedAt: at,
  messages: [turn("m1", "Read the export code.", "user"), turn("m2", "Done.")],
  ...changes,
});
const decoded = (payload: Uint8Array) => {
  const read = readCardEntry(payload);
  assert.equal(read.readable, true, JSON.stringify(read));
  return (read as Extract<typeof read, { readable: true }>).entry;
};

test("a run's id is the same for every entry of that run, and differs between runs and computers", () => {
  const id = sessionIdOf(mac.id, "task-1", at);
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(sessionIdOf(mac.id, "task-1", at), id);
  assert.notEqual(
    sessionIdOf(mac.id, "task-1", "2026-11-22T11:00:00.000Z"),
    id,
  );
  assert.notEqual(sessionIdOf(randomUUID(), "task-1", at), id);
});

test("a session, a review and a shared file are written and read back as they were", () => {
  const records: CardRecord[] = [
    { kind: "session", session: session() },
    {
      kind: "result",
      result: {
        id: randomUUID(),
        name: "report.html",
        mime: "text/html",
        sha256: "a".repeat(64),
        size: 1200,
        kind: "report",
      },
    },
  ];
  for (const record of records) {
    const [payload, ...more] = cardPayloads(record, mac);
    assert.equal(more.length, 0);
    assert.deepEqual(decoded(payload), {
      format: "memcode-card",
      version: 1,
      device: mac,
      ...record,
    });
  }
});

test("nothing local or secret leaves the computer in a shared turn", () => {
  const text =
    "Opened /Users/alex/work/website/src/export.ts and C:\\Users\\alex\\notes.txt with Bearer abc.def and eyJhbGc.eyJzdWI.c2ln";
  const shared = publicMessage({
    ...turn("m1", text),
    references: [{ kind: "file" } as never],
    commentIds: ["c1"],
    reviewText: "private review note",
    actor: { memberId: "x", name: "x", deviceId: "x", device: "x" },
  });
  assert.equal(
    shared.text,
    "Opened <local-home>/work/website/src/export.ts and <local-home>\\notes.txt with Bearer <redacted> and <redacted-token>",
  );
  assert.deepEqual(Object.keys(shared).sort(), ["at", "id", "role", "text"]);
  assert.equal(publicText("/home/dana/project"), "<local-home>/project");
});

test("a run whose turns do not fit in one entry is written as several, each small enough and each with the run's state", () => {
  const long = "x".repeat(90_000);
  const messages = Array.from({ length: 30 }, (_, at) => turn(`m${at}`, long));
  const payloads = cardPayloads(
    { kind: "session", session: session({ messages }) },
    mac,
  );
  assert.ok(payloads.length > 1);
  const read = payloads.map(decoded);
  for (const payload of payloads) assert.ok(payload.length < 1024 * 1024);
  for (const entry of read)
    assert.equal(entry.kind === "session" && entry.session.state, "running");
  assert.deepEqual(
    read.flatMap((entry) =>
      entry.kind === "session" ? entry.session.messages.map((m) => m.id) : [],
    ),
    messages.map((m) => m.id),
  );
});

test("a turn longer than the shared format holds is cut, says so, and still reads", () => {
  const shared = publicMessage(turn("m1", "y".repeat(150_000)));
  assert.equal(shared.text.length, 100_000);
  assert.match(shared.text, /The rest of this turn was too long to share\.\]$/);
  const [payload] = cardPayloads(
    { kind: "session", session: session({ messages: [shared] }) },
    mac,
  );
  assert.equal(readCardEntry(payload).readable, true);
});

test("what is not a card entry, or not one of this MemCode's, is left out", () => {
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const good = {
    format: "memcode-card",
    version: 1,
    device: mac,
    kind: "session",
    session: session(),
  };
  assert.equal(readCardEntry(encode(good)).readable, true);
  for (const bad of [
    { ...good, kind: "something-else" },
    { ...good, device: { id: "not-a-uuid", name: "Mac" } },
    { ...good, device: { ...mac, name: "alex-macbook.local" } },
    { ...good, session: { ...session(), state: "exploded" } },
    {
      ...good,
      session: { ...session(), messages: [{ ...turn("m1", "x"), extra: 1 }] },
    },
    { ...good, extra: "field" },
    {
      format: "memcode-card",
      version: 1,
      device: mac,
      kind: "result",
      result: { name: "../../etc/passwd" },
    },
    "a string",
  ])
    assert.deepEqual(
      readCardEntry(encode(bad)),
      { readable: false, newer: false },
      JSON.stringify(bad).slice(0, 80),
    );
  assert.deepEqual(readCardEntry(Uint8Array.of(0xff, 0xfe)), {
    readable: false,
    newer: false,
  });
  assert.deepEqual(readCardEntry(encode({ ...good, version: 2 })), {
    readable: false,
    newer: true,
  });
});

test("a shared file names a file, never a path, and is at most 5 MB", () => {
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const result = {
    id: randomUUID(),
    name: "report.html",
    mime: "text/html",
    sha256: "b".repeat(64),
    size: 10,
    kind: "artifact",
  };
  const entry = (changes: object) => ({
    format: "memcode-card",
    version: 1,
    device: mac,
    kind: "result",
    result: { ...result, ...changes },
  });
  assert.equal(readCardEntry(encode(entry({}))).readable, true);
  for (const changes of [
    { name: "src/report.html" },
    { name: "C:report" },
    { size: 5 * 1024 * 1024 + 1 },
    { size: 0 },
    { sha256: "B".repeat(64) },
    { kind: "binary" },
  ])
    assert.equal(
      readCardEntry(encode(entry(changes))).readable,
      false,
      JSON.stringify(changes),
    );
});
