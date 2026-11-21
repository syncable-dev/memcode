import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  emptyBoard,
  LARGEST_UPDATE,
  LOCAL,
  readBoard,
  writeChanges,
  type Board,
} from "../runtime/sharing/board/document";
import {
  holdsMore,
  idOf,
  isMadeFrom,
  missingFrom,
  nextCall,
  whyNotApplied,
} from "../runtime/sharing/board/updates";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const oneTask = (title: string): Board => ({
  ...emptyBoard(),
  tasks: {
    "task-1": {
      fields: { identifier: "MC-001", title, stage: "planned" },
      texts: { description: "Line one.\nLine two, with an é and a 🙂." },
      sets: { label: { urgent: true } },
    },
  },
});
/** A document, and every update a change to it made. */
function written(...boards: Board[]) {
  const doc = new Y.Doc();
  doc.clientID = 20261121;
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === LOCAL) updates.push(update);
  });
  let seen = emptyBoard();
  for (const board of boards) {
    writeChanges(doc, seen, board);
    seen = board;
  }
  return { doc, updates };
}
const copyOf = (doc: Y.Doc) => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};

test("an update's id is a UUID made from its bytes, the same wherever it is worked out", () => {
  const { updates } = written(oneTask("Export as CSV"));
  const id = idOf(updates[0]);
  assert.match(id, uuid);
  assert.equal(idOf(Uint8Array.from(updates[0])), id);
  assert.ok(isMadeFrom(id, updates[0]));
  assert.ok(isMadeFrom(id.toUpperCase(), updates[0]));
  const other = Uint8Array.from(updates[0]);
  other[other.length - 1] ^= 1;
  assert.notEqual(idOf(other), id);
  assert.equal(isMadeFrom(id, other), false);
});

test("the same bytes can be sent again under another id that is still made from them", () => {
  const { updates } = written(oneTask("Export as CSV"));
  const ids = [0, 1, 2, 7].map((again) => idOf(updates[0], again));
  assert.equal(new Set(ids).size, 4);
  for (const id of ids) {
    assert.match(id, uuid);
    assert.ok(isMadeFrom(id, updates[0]));
  }
  assert.equal(isMadeFrom(idOf(updates[0], 8), updates[0]), false);
});

test("an update is applied only when it is small enough, is what its id says, and reads as an update", () => {
  const { updates } = written(oneTask("Export as CSV"));
  const [update] = updates;
  assert.equal(whyNotApplied(idOf(update), update), undefined);
  const large = new Uint8Array(LARGEST_UPDATE + 1);
  assert.equal(whyNotApplied(idOf(large), large), "too-large");
  const flipped = Uint8Array.from(update);
  flipped[10] ^= 4;
  assert.equal(whyNotApplied(idOf(update), flipped), "changed");
  assert.equal(
    whyNotApplied("2f1f5f3a-5a52-4c1e-9d3e-5d3a2f0e9c11", update),
    "changed",
  );
  const nonsense = Uint8Array.from([255, 255, 255, 255, 7, 1, 2, 3]);
  assert.equal(whyNotApplied(idOf(nonsense), nonsense), "unreadable");
  assert.equal(
    whyNotApplied(idOf(new Uint8Array()), new Uint8Array()),
    "unreadable",
  );
});

test("a damaged update that someone sends under its own id is refused, or applies without harm", () => {
  // What the layout proposal measured, kept as a test: cut short or with one
  // byte inverted, an update never applies; and nothing that is let through throws.
  const { updates } = written(oneTask("Export as CSV"));
  const [update] = updates;
  const damaged: Uint8Array[] = [];
  for (let length = 0; length < update.length; length++)
    damaged.push(update.subarray(0, length));
  for (let at = 0; at < update.length; at++) {
    const inverted = Uint8Array.from(update);
    inverted[at] ^= 0xff;
    damaged.push(inverted);
  }
  let refused = 0;
  for (const bytes of damaged) {
    if (whyNotApplied(idOf(bytes), bytes)) {
      refused++;
      continue;
    }
    const reader = new Y.Doc();
    assert.doesNotThrow(() => Y.applyUpdate(reader, bytes));
    assert.doesNotThrow(() => readBoard(reader));
  }
  assert.ok(refused >= update.length, `${refused} of ${damaged.length}`);
});

test("a flipped bit that still reads as an update is caught by the id, which is what the id is for", () => {
  const { updates } = written(oneTask("Export as CSV"));
  const [update] = updates;
  const id = idOf(update);
  let readable = 0;
  for (let bit = 0; bit < update.length * 8; bit++) {
    const flipped = Uint8Array.from(update);
    flipped[bit >> 3] ^= 1 << (bit & 7);
    assert.equal(whyNotApplied(id, flipped), "changed");
    if (!whyNotApplied(idOf(flipped), flipped)) readable++;
  }
  // Most single flipped bits give bytes that would apply as a real change.
  assert.ok(readable > update.length, `${readable} still read as an update`);
});

test("a document holds more than another when it has a change or a deletion the other lacks", () => {
  const mine = written(oneTask("Export as CSV"));
  const theirs = copyOf(mine.doc);
  assert.equal(holdsMore(mine.doc, theirs), false);
  assert.equal(holdsMore(theirs, mine.doc), false);

  writeChanges(mine.doc, oneTask("Export as CSV"), oneTask("Export as PDF"));
  assert.equal(holdsMore(mine.doc, theirs), true);
  // The one that is behind does not hold more.
  assert.equal(holdsMore(theirs, mine.doc), false);

  Y.applyUpdate(theirs, missingFrom(theirs, mine.doc));
  assert.equal(holdsMore(mine.doc, theirs), false);
  assert.deepEqual(readBoard(theirs), oneTask("Export as PDF"));
});

test("what one document is missing can be sent as one update, and changes that waited for it take effect", () => {
  // The proposal's measurement: two changes to a task, applied without the update
  // that made the task, change nothing and wait.
  const author = written(
    oneTask("Export as CSV"),
    oneTask("Export as PDF"),
    oneTask("Export as PDF and CSV"),
  );
  const [made, ...later] = author.updates;
  assert.equal(later.length, 2);
  const reader = new Y.Doc();
  for (const update of later) Y.applyUpdate(reader, update);
  assert.deepEqual(readBoard(reader), emptyBoard());
  assert.notEqual(reader.store.pendingStructs, null);
  assert.equal(holdsMore(author.doc, reader), true);

  const difference = missingFrom(reader, author.doc);
  assert.ok(difference.length < made.length + 200);
  Y.applyUpdate(reader, difference);
  assert.equal(reader.store.pendingStructs, null);
  assert.deepEqual(readBoard(reader), oneTask("Export as PDF and CSV"));
  assert.equal(holdsMore(author.doc, reader), false);
});

test("applying a damaged update can throw and still change the document, so it is read first and applied inside a guard", () => {
  // Measured with Yjs 13.6.33 and kept here. The client id is fixed so that the
  // bytes, and with them the counts, are the same on every run.
  const { updates } = written(
    oneTask("Export as CSV"),
    oneTask("Export as PDF"),
  );
  let changedAfterBeingRefused = 0,
    changedThoughItRead = 0,
    threwThoughItRead = 0;
  for (const update of updates)
    for (let at = 0; at < update.length; at++)
      for (const mask of [0xff, 0x80, 0x40, 0x20, 0x10, 8, 4, 2, 1]) {
        const damaged = Uint8Array.from(update);
        damaged[at] ^= mask;
        const reader = new Y.Doc();
        Y.applyUpdate(reader, updates[0]);
        const before = Buffer.from(Y.encodeStateAsUpdate(reader));
        try {
          Y.applyUpdate(reader, damaged);
          continue;
        } catch {
          // Applying threw. What is the document now?
        }
        const changed =
          Buffer.compare(before, Buffer.from(Y.encodeStateAsUpdate(reader))) !==
          0;
        const refused = whyNotApplied(idOf(damaged), damaged) !== undefined;
        if (refused && changed) changedAfterBeingRefused++;
        if (!refused) threwThoughItRead++;
        if (!refused && changed) changedThoughItRead++;
      }
  // Applying is not all or nothing: this is why an update that does not read is never applied.
  assert.ok(changedAfterBeingRefused > 0, String(changedAfterBeingRefused));
  // Reading first is not enough either: some bytes read as an update and cannot
  // be applied. The log reader guards every apply and reloads the document.
  assert.ok(threwThoughItRead > 0, String(threwThoughItRead));
  assert.equal(changedThoughItRead, 0);
});

test("updates go to the service in calls of at most a hundred and at most three mebibytes", () => {
  const small = Array.from({ length: 250 }, (_, at) => ({
    id: `id-${at}`,
    payload: new Uint8Array(1000),
  }));
  assert.equal(nextCall(small).length, 100);
  assert.equal(nextCall(small.slice(200)).length, 50);
  assert.deepEqual(nextCall([]), []);

  const large = Array.from({ length: 9 }, (_, at) => ({
    id: `id-${at}`,
    payload: new Uint8Array(700 * 1024),
  }));
  // 4 × 700 KiB is 2.8 MiB. A fifth would pass three.
  assert.equal(nextCall(large).length, 4);
  // One update is always sent, whatever its size: the service says if it is too large.
  const huge = [{ id: "huge", payload: new Uint8Array(4 * 1024 * 1024) }];
  assert.equal(nextCall(huge).length, 1);
});
