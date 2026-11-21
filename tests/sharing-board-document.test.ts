import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  emptyBoard,
  LAYOUT,
  layoutOf,
  LOCAL,
  readBoard,
  textChange,
  writeChanges,
  type Board,
  type Entry,
} from "../runtime/sharing/board/document";

const entry = (changes: Partial<Entry> = {}): Entry => ({
  fields: {},
  texts: {},
  sets: {},
  ...changes,
});
const task = (title: string, changes: Partial<Entry> = {}): Entry =>
  entry({
    fields: { identifier: "MC-001", title, stage: "planned", lane: "planned" },
    texts: { description: "" },
    ...changes,
  });
const board = (changes: Partial<Board> = {}): Board => ({
  ...emptyBoard(),
  ...changes,
});

/** A computer: its own document, the board it last saw, and the updates it has made. */
function computer() {
  const doc = new Y.Doc();
  const made: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === LOCAL) made.push(update);
  });
  const self = {
    doc,
    made,
    seen: emptyBoard(),
    /** Changes the board on this computer, as an edit in the app does. */
    change(edit: (board: Board) => void) {
      const next = structuredClone(self.seen);
      edit(next);
      writeChanges(doc, self.seen, next);
      self.seen = next;
    },
    /** Takes what another computer made, and sees the board anew. */
    receive(from: { made: Uint8Array[] }) {
      for (const update of from.made) Y.applyUpdate(doc, update);
      self.seen = readBoard(doc);
    },
  };
  return self;
}
function meet(a: ReturnType<typeof computer>, b: ReturnType<typeof computer>) {
  a.receive(b);
  b.receive(a);
  assert.deepEqual(readBoard(a.doc), readBoard(b.doc));
  return readBoard(a.doc);
}

test("a board written into a document is read back as it was", () => {
  const whole = board({
    goals: {
      "goal-1": entry({
        fields: {
          identifier: "EP-01",
          title: "Reports",
          order: 0,
          closed: false,
        },
        texts: { description: "Customers can export reports." },
      }),
    },
    tasks: {
      "task-1": task("Export as CSV", {
        texts: { description: "Line one.\nLine two ✈" },
        sets: {
          label: { urgent: true, "needs design": true },
          depends: { "task-2": true },
          field: { "field-1": "blue", "field-2": 3, "field-3": null },
          step: { "step-1": { text: "Read the code", done: true, order: 0 } },
        },
      }),
      "task-2": task("Export as PDF"),
    },
    comments: {
      "comment-1": entry({
        fields: { task: "task-1", parent: null, text: "Looks right." },
      }),
    },
    lanes: {
      planned: entry({
        fields: { name: "Planned", stage: "planned", order: 1 },
      }),
    },
    views: {
      "view-1": entry({
        fields: { name: "Mine", filters: { priority: "all", archived: false } },
      }),
    },
  });
  const one = computer();
  one.change((next) => Object.assign(next, whole));
  assert.deepEqual(readBoard(one.doc), whole);
  const other = computer();
  other.receive(one);
  assert.deepEqual(readBoard(other.doc), whole);
  assert.equal(layoutOf(one.doc), LAYOUT);
  assert.equal(layoutOf(new Y.Doc()), undefined);
});

test("nothing is written when nothing changed, and one edit is one small update", () => {
  const one = computer();
  one.change((next) => {
    for (let number = 0; number < 50; number++)
      next.tasks[`task-${number}`] = task(`Task ${number}`, {
        texts: { description: "x".repeat(500) },
      });
  });
  assert.equal(one.made.length, 1);
  one.change(() => {});
  assert.equal(one.made.length, 1);
  one.change((next) => (next.tasks["task-7"].fields.stage = "done"));
  assert.equal(one.made.length, 2);
  assert.ok(one.made[1].length < 100, `${one.made[1].length} bytes`);
});

test("two computers that add different tasks, or edit different fields of one, both keep their change", () => {
  const mac = computer(),
    windows = computer();
  mac.change((next) => (next.tasks.shared = task("Shared")));
  windows.receive(mac);
  mac.made.length = 0;
  mac.change((next) => {
    next.tasks.fromMac = task("From the Mac");
    next.tasks.shared.fields.priority = "high";
  });
  windows.change((next) => {
    next.tasks.fromWindows = task("From Windows");
    next.tasks.shared.fields.estimate = 5;
  });
  const both = meet(mac, windows);
  assert.deepEqual(Object.keys(both.tasks).sort(), [
    "fromMac",
    "fromWindows",
    "shared",
  ]);
  assert.equal(both.tasks.shared.fields.priority, "high");
  assert.equal(both.tasks.shared.fields.estimate, 5);
});

test("two computers that set the same field end with one of the two values, the same on both", () => {
  const mac = computer(),
    windows = computer();
  mac.change((next) => (next.tasks.shared = task("Shared")));
  windows.receive(mac);
  mac.made.length = 0;
  mac.change((next) => (next.tasks.shared.fields.title = "The Mac's title"));
  windows.change((next) => (next.tasks.shared.fields.title = "The PC's title"));
  const title = meet(mac, windows).tasks.shared.fields.title;
  assert.ok(["The Mac's title", "The PC's title"].includes(String(title)));
});

test("a set keeps a member added on each computer, and loses the one a computer took out", () => {
  const mac = computer(),
    windows = computer();
  mac.change(
    (next) =>
      (next.tasks.shared = task("Shared", { sets: { label: { old: true } } })),
  );
  windows.receive(mac);
  mac.made.length = 0;
  mac.change((next) => {
    next.tasks.shared.sets.label.urgent = true;
    delete next.tasks.shared.sets.label.old;
  });
  windows.change((next) => (next.tasks.shared.sets.label.design = true));
  assert.deepEqual(meet(mac, windows).tasks.shared.sets.label, {
    urgent: true,
    design: true,
  });
});

test("a step ticked on one computer and another reworded on the second both stay", () => {
  const mac = computer(),
    windows = computer();
  const step = (text: string, order: number, done = false) => ({
    text,
    done,
    order,
  });
  mac.change(
    (next) =>
      (next.tasks.shared = task("Shared", {
        sets: { step: { a: step("Read the code", 0), b: step("Write it", 1) } },
      })),
  );
  windows.receive(mac);
  mac.made.length = 0;
  mac.change(
    (next) => (next.tasks.shared.sets.step.a = step("Read the code", 0, true)),
  );
  windows.change(
    (next) => (next.tasks.shared.sets.step.b = step("Write the fix", 1)),
  );
  assert.deepEqual(meet(mac, windows).tasks.shared.sets.step, {
    a: step("Read the code", 0, true),
    b: step("Write the fix", 1),
  });
});

test("edits to a description in different places are both kept", () => {
  const mac = computer(),
    windows = computer();
  const wording = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
  mac.change(
    (next) =>
      (next.tasks.shared = task("Shared", { texts: { description: wording } })),
  );
  windows.receive(mac);
  mac.made.length = 0;
  mac.change(
    (next) =>
      (next.tasks.shared.texts.description = wording.replace(
        "First",
        "The very first",
      )),
  );
  windows.change(
    (next) =>
      (next.tasks.shared.texts.description = wording.replace(
        "Third paragraph.",
        "Third, and last.",
      )),
  );
  assert.equal(
    meet(mac, windows).tasks.shared.texts.description,
    "The very first paragraph.\n\nSecond paragraph.\n\nThird, and last.",
  );
});

test("a move writes stage and lane together, so two moves at once never leave a mixed pair", () => {
  for (let round = 0; round < 60; round++) {
    const mac = computer(),
      windows = computer();
    mac.change((next) => (next.tasks.shared = task("Shared")));
    windows.receive(mac);
    mac.made.length = 0;
    mac.change((next) =>
      Object.assign(next.tasks.shared.fields, {
        stage: "review",
        lane: "code-review",
      }),
    );
    windows.change((next) =>
      Object.assign(next.tasks.shared.fields, { stage: "done", lane: "done" }),
    );
    const { stage, lane } = meet(mac, windows).tasks.shared.fields;
    assert.ok(
      ["review/code-review", "done/done"].includes(`${stage}/${lane}`),
      `${stage}/${lane}`,
    );
  }
});

test("deleting marks the entry: it is gone from the board, and an edit made elsewhere at that moment is not lost", () => {
  const mac = computer(),
    windows = computer();
  mac.change((next) => {
    next.tasks.kept = task("Kept");
    next.tasks.gone = task("Gone");
  });
  windows.receive(mac);
  mac.made.length = 0;
  mac.change((next) => void delete next.tasks.gone);
  windows.change(
    (next) => (next.tasks.gone.fields.title = "Edited while it was deleted"),
  );
  assert.deepEqual(Object.keys(meet(mac, windows).tasks), ["kept"]);
  // Putting it back finds the entry that was marked, with the edit still in it.
  mac.made.length = 0;
  windows.made.length = 0;
  windows.change(
    (next) => (next.tasks.gone = task("Edited while it was deleted")),
  );
  const back = meet(mac, windows).tasks.gone;
  assert.equal(back.fields.title, "Edited while it was deleted");
  assert.equal(mac.doc.getMap("tasks").size, 2);
});

test("an entry is made once: a computer that brings an id the document already holds writes into that entry", () => {
  const mac = computer(),
    windows = computer();
  mac.change((next) => (next.tasks.same = task("One board, two computers")));
  // Windows has the same task from before and has not seen the document's copy as its own.
  windows.receive(mac);
  windows.seen = emptyBoard();
  mac.made.length = 0;
  windows.change(
    (next) => (next.tasks.same = task("One board, two computers")),
  );
  assert.equal(
    windows.made.length,
    0,
    "nothing differs, so nothing is written",
  );
  // An edit on the Mac to the entry it made is still there afterwards.
  mac.change((next) => (next.tasks.same.fields.priority = "high"));
  windows.seen = emptyBoard();
  windows.change(
    (next) =>
      (next.tasks.same = task("One board, two computers", {
        sets: { label: { pc: true } },
      })),
  );
  const merged = meet(mac, windows).tasks.same;
  assert.equal(merged.fields.priority, "high");
  assert.deepEqual(merged.sets.label, { pc: true });
});

test("the difference between two wordings is the smallest cut that turns one into the other", () => {
  const apply = (from: string, to: string) => {
    const { at, remove, insert } = textChange(from, to);
    return from.slice(0, at) + insert + from.slice(at + remove);
  };
  const pairs: Array<[string, string]> = [
    ["", "new"],
    ["old", ""],
    ["same", "same"],
    ["one two three", "one 2 three"],
    ["aaa", "aaaa"],
    ["aaaa", "aaa"],
    ["abcabc", "abc"],
    ["begin middle end", "begin end"],
    ["a✈b", "a🚀b"],
    ["👍 fine", "👎 fine"],
    ["fine 👍", "fine 👎"],
    ["👨‍👩‍👧 family", "👨‍👩‍👦 family"],
  ];
  for (const [from, to] of pairs) {
    assert.equal(apply(from, to), to, `${from} → ${to}`);
    const { at, remove, insert } = textChange(from, to);
    const lone =
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (const piece of [
      from.slice(0, at),
      from.slice(at, at + remove),
      insert,
    ])
      assert.doesNotMatch(piece, lone, `half a character in ${from} → ${to}`);
  }
  assert.deepEqual(textChange("one two three", "one 2 three"), {
    at: 4,
    remove: 3,
    insert: "2",
  });
});

test("what MemCode did not put in a document is read past, never tripped over", () => {
  const doc = new Y.Doc();
  doc.transact(() => {
    const tasks = doc.getMap("tasks");
    tasks.set("not-an-entry", "just text");
    tasks.set("a-list", new Y.Array());
    const odd = new Y.Map<unknown>();
    tasks.set("odd", odd);
    odd.set("title", "Still a task");
    odd.set("nested", new Y.Array());
    odd.set("deleted", "yes");
    odd.set(":", 1);
    odd.set("label:", true);
    doc.getArray("something-newer").push([1]);
    doc.getMap("meta").set("layout", "two");
  });
  const read = readBoard(doc);
  assert.deepEqual(Object.keys(read.tasks), ["odd"]);
  assert.equal(read.tasks.odd.fields.title, "Still a task");
  assert.equal(layoutOf(doc), undefined);
});
