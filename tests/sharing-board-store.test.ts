import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyBoard } from "../runtime/sharing/board/document";
import {
  BoardStore,
  type BoardToKeep,
  type KeptBoard,
} from "../runtime/sharing/board/store";

async function folder(context: test.TestContext) {
  const made = await mkdtemp(join(tmpdir(), "memcode-board-store-"));
  context.after(() => rm(made, { recursive: true, force: true }));
  return join(made, "board");
}
const kept = (changes: Partial<KeptBoard> = {}): KeptBoard => ({
  cursor: 12,
  applied: 3,
  joined: true,
  seen: {
    ...emptyBoard(),
    tasks: {
      "task-1": {
        fields: { identifier: "MC-001", title: "Export as CSV" },
        texts: { description: "Line one." },
        sets: { label: { urgent: true } },
      },
    },
  },
  unsent: [
    {
      id: "0b0b0b0b-0000-8000-8000-000000000001",
      payload: Uint8Array.of(1, 2, 3),
    },
    {
      id: "0b0b0b0b-0000-8000-8000-000000000002",
      payload: Uint8Array.of(0, 255),
    },
  ],
  leftOut: [
    {
      sequence: 7,
      id: "0b0b0b0b-0000-8000-8000-000000000007",
      author: "acct-dana",
      loggedAt: "2026-11-21T12:00:00.000Z",
      reason: "unreadable",
    },
  ],
  log: Uint8Array.of(9, 8, 7, 6),
  ...changes,
});
const plain = (read: KeptBoard | undefined) =>
  read && {
    ...read,
    log: [...read.log],
    unsent: read.unsent.map((update) => ({
      id: update.id,
      payload: [...update.payload],
    })),
  };

test("a project that has kept nothing starts with nothing", async (context) => {
  const store = new BoardStore(await folder(context));
  assert.equal(await store.load(0), undefined);
});

test("what is saved for a board is read back as it was", async (context) => {
  const where = await folder(context);
  await new BoardStore(where).save(kept());
  assert.deepEqual(plain(await new BoardStore(where).load(3)), plain(kept()));
  assert.deepEqual((await readdir(where)).sort(), ["log.bin", "sync.json"]);
});

test("a save that leaves the document out keeps the document that was saved before", async (context) => {
  const where = await folder(context);
  const store = new BoardStore(where);
  await store.save(kept());
  const { log: _unchanged, ...rest } = kept({ cursor: 12, unsent: [] });
  await store.save(rest satisfies BoardToKeep);
  const read = await new BoardStore(where).load(3);
  assert.deepEqual(read?.unsent, []);
  assert.deepEqual([...read!.log], [9, 8, 7, 6]);
});

test("a save that waited for the workspace is taken once the workspace holds its number", async (context) => {
  const where = await folder(context);
  const store = new BoardStore(where);
  await store.save(kept());
  await store.prepare(kept({ cursor: 20, applied: 4, log: Uint8Array.of(1) }));
  // The workspace file was written and MemCode stopped before the save was put in place.
  const read = await new BoardStore(where).load(4);
  assert.equal(read?.cursor, 20);
  assert.deepEqual([...read!.log], [1]);
  assert.deepEqual((await readdir(where)).sort(), ["log.bin", "sync.json"]);
});

test("a save that waited for a workspace change that never happened is dropped", async (context) => {
  const where = await folder(context);
  const store = new BoardStore(where);
  await store.save(kept());
  await store.prepare(kept({ cursor: 20, applied: 4, log: Uint8Array.of(1) }));
  // MemCode stopped before the workspace file was written: it still holds 3.
  const read = await new BoardStore(where).load(3);
  assert.deepEqual(plain(read), plain(kept()));
  assert.deepEqual((await readdir(where)).sort(), ["log.bin", "sync.json"]);
});

test("a save that was cut off while being written is dropped", async (context) => {
  const where = await folder(context);
  const store = new BoardStore(where);
  await store.save(kept());
  await writeFile(join(where, "log.bin.next"), Uint8Array.of(1));
  await writeFile(join(where, "sync.json.next"), '{"version":1,"cursor":2');
  assert.deepEqual(plain(await new BoardStore(where).load(3)), plain(kept()));
  assert.deepEqual((await readdir(where)).sort(), ["log.bin", "sync.json"]);
});

test("a save whose document was put in place and whose description was not is finished on the next start", async (context) => {
  const where = await folder(context);
  const store = new BoardStore(where);
  await store.save(kept());
  await store.prepare(kept({ cursor: 20, applied: 4, log: Uint8Array.of(1) }));
  // Stopped half-way through putting the save in place.
  const { rename } = await import("node:fs/promises");
  await rename(join(where, "log.bin.next"), join(where, "log.bin"));
  const read = await new BoardStore(where).load(4);
  assert.equal(read?.cursor, 20);
  assert.deepEqual([...read!.log], [1]);
});

test("what was kept for another state of the workspace is not used", async (context) => {
  const where = await folder(context);
  await new BoardStore(where).save(kept());
  // A workspace file from a backup, or from another computer.
  assert.equal(await new BoardStore(where).load(9), undefined);
  assert.equal(await new BoardStore(where).load(0), undefined);
});

test("a document that is not the one that was saved is not used", async (context) => {
  const where = await folder(context);
  await new BoardStore(where).save(kept());
  await truncate(join(where, "log.bin"), 0);
  assert.equal(await new BoardStore(where).load(3), undefined);
  await writeFile(join(where, "log.bin"), Uint8Array.of(9, 8, 7, 5));
  assert.equal(await new BoardStore(where).load(3), undefined);
});

test("a file MemCode cannot read as its own is not used", async (context) => {
  const where = await folder(context);
  const store = new BoardStore(where);
  await store.save(kept());
  await writeFile(
    join(where, "sync.json"),
    JSON.stringify({ version: 2, cursor: 1 }),
  );
  assert.equal(await new BoardStore(where).load(3), undefined);
  await writeFile(join(where, "sync.json"), "not json");
  assert.equal(await new BoardStore(where).load(3), undefined);
});

test("removing forgets everything, and removing twice is fine", async (context) => {
  const where = await folder(context);
  const store = new BoardStore(where);
  await store.save(kept());
  await store.remove();
  await store.remove();
  assert.equal(await new BoardStore(where).load(3), undefined);
  await assert.rejects(readdir(where), { code: "ENOENT" });
});
