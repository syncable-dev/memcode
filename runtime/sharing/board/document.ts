import * as Y from "yjs";

/**
 * A shared board as one Yjs document: docs/shared-board-layout-proposal.md.
 *
 * Every collection is a map at the top of the document. An entry is a map of
 * fields under the id of the thing it describes. This file knows how entries
 * are kept and merged, and nothing about what a task or a goal is.
 */
export const collections = [
  "goals",
  "cycles",
  "tasks",
  "comments",
  "lanes",
  "fields",
  "views",
  "trackers",
] as const;
export type Collection = (typeof collections)[number];
export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Entry {
  /** Plain values. Each is replaced whole, so the last change to one wins. */
  fields: Record<string, Json>;
  /** Long text. A change is written as the difference, so edits in different places both stay. */
  texts: Record<string, string>;
  /** Sets, kept as one key per member (`label:urgent`), so two additions both stay. */
  sets: Record<string, Record<string, Json>>;
}
/** Every entry of every collection that has not been deleted, by id. */
export type Board = Record<Collection, Record<string, Entry>>;

/** The number MemCode writes into a document it lays out, and the highest it will write to. */
export const LAYOUT = 1;
/** What marks a change this computer made, as opposed to one that came from the log. */
export const LOCAL = "local";
/** The sharing service takes no update larger than this. */
export const LARGEST_UPDATE = 1024 * 1024;
/**
 * How much is written as one change before the rest goes into the next. A
 * quarter of what the service takes, so that no update comes near the limit.
 */
const ROOM_IN_ONE_CHANGE = 256 * 1024;
/** One value this large would be an update the service refuses. It is not written. */
const LARGEST_VALUE = LARGEST_UPDATE - 64 * 1024;

const META = "meta",
  LAYOUT_KEY = "layout",
  DELETED = "deleted",
  MEMBER_OF = ":";

export const emptyBoard = (): Board =>
  Object.fromEntries(collections.map((name) => [name, {}])) as Board;

const same = (left: unknown, right: unknown) =>
  left === right || JSON.stringify(left) === JSON.stringify(right);

/** The layout the document was written in, or nothing for a document nobody has laid out. */
export function layoutOf(doc: Y.Doc): number | undefined {
  const layout = doc.getMap(META).get(LAYOUT_KEY);
  return typeof layout === "number" ? layout : undefined;
}

function readEntry(kept: Y.Map<unknown>): Entry & { deleted: boolean } {
  const entry: Entry = { fields: {}, texts: {}, sets: {} };
  let deleted = false;
  kept.forEach((value, key) => {
    if (key === DELETED) deleted = value === true;
    else if (value instanceof Y.Text) entry.texts[key] = value.toString();
    else if (value instanceof Y.AbstractType) return;
    else if (key.includes(MEMBER_OF)) {
      const at = key.indexOf(MEMBER_OF);
      (entry.sets[key.slice(0, at)] ??= {})[key.slice(at + 1)] = value as Json;
    } else entry.fields[key] = value as Json;
  });
  return { ...entry, deleted };
}

/** What the document holds now. Deleted entries are left out. */
export function readBoard(doc: Y.Doc): Board {
  const board = emptyBoard();
  for (const collection of collections)
    doc.getMap(collection).forEach((kept, id) => {
      if (!(kept instanceof Y.Map)) return;
      const { deleted, ...entry } = readEntry(kept);
      if (!deleted) board[collection][id] = entry;
    });
  return board;
}

/** Where two wordings differ: what to take out of the old one and what to put in its place. */
export function textChange(from: string, to: string) {
  let start = 0;
  const shortest = Math.min(from.length, to.length);
  while (start < shortest && from[start] === to[start]) start++;
  let end = 0;
  while (
    end < shortest - start &&
    from[from.length - 1 - end] === to[to.length - 1 - end]
  )
    end++;
  // Never cut between the two halves of one character.
  const isFirstHalf = (text: string, at: number) =>
    at >= 0 && text.charCodeAt(at) >= 0xd800 && text.charCodeAt(at) <= 0xdbff;
  if (isFirstHalf(from, start - 1)) start--;
  if (end > 0 && isFirstHalf(from, from.length - end - 1)) end--;
  return {
    at: start,
    remove: from.length - start - end,
    insert: to.slice(start, to.length - end),
  };
}

function writeText(kept: Y.Map<unknown>, name: string, wording: string) {
  const text = kept.get(name);
  if (!(text instanceof Y.Text))
    return void kept.set(name, new Y.Text(wording));
  const change = textChange(text.toString(), wording);
  if (change.remove) text.delete(change.at, change.remove);
  if (change.insert) text.insert(change.at, change.insert);
}

/** One thing to write, with a number its update will not be larger than. */
interface Write {
  bytes: number;
  run(): void;
}
const OVERHEAD = 48;
const bytesOf = (key: string, value: unknown) =>
  OVERHEAD +
  Buffer.byteLength(key) +
  Buffer.byteLength(JSON.stringify(value) ?? "");

/** The values that differ between two records, and the ones that are gone. */
function valueWrites(
  kept: () => Y.Map<unknown>,
  was: Record<string, Json>,
  now: Record<string, Json>,
  keyOf: (name: string) => string,
): Write[] {
  const writes: Write[] = [];
  for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (same(was[name], now[name])) continue;
    const key = keyOf(name);
    if (name in now)
      writes.push({
        bytes: bytesOf(key, now[name]),
        run: () => kept().set(key, now[name]),
      });
    else
      writes.push({ bytes: bytesOf(key, null), run: () => kept().delete(key) });
  }
  return writes;
}

/** What it takes to make the document's entry say what `after` says. */
function entryWrites(
  held: Y.Map<unknown>,
  id: string,
  before: Entry | undefined,
  after: Entry,
): Write[] {
  // An entry is made once. Putting a second map under an id that is already there
  // would replace the first one whole, with every edit anyone made to it.
  const kept = () => {
    let entry = held.get(id);
    if (!(entry instanceof Y.Map)) {
      entry = new Y.Map<unknown>();
      held.set(id, entry);
    }
    return entry as Y.Map<unknown>;
  };
  const there = held.get(id);
  const known =
    before ??
    (there instanceof Y.Map
      ? readEntry(there)
      : { fields: {}, texts: {}, sets: {} });
  const writes: Write[] = [
    {
      bytes: bytesOf(id, null),
      run: () => {
        const entry = kept();
        if (entry.get(DELETED) === true) entry.delete(DELETED);
      },
    },
    ...valueWrites(kept, known.fields, after.fields, (name) => name),
  ];
  for (const set of new Set([
    ...Object.keys(known.sets),
    ...Object.keys(after.sets),
  ]))
    writes.push(
      ...valueWrites(
        kept,
        known.sets[set] ?? {},
        after.sets[set] ?? {},
        (member) => set + MEMBER_OF + member,
      ),
    );
  for (const [name, wording] of Object.entries(after.texts))
    if (known.texts[name] !== wording)
      writes.push({
        bytes: bytesOf(name, wording),
        run: () => writeText(kept(), name, wording),
      });
  return writes;
}

/**
 * Writes entries as few changes as will stay small. An entry goes into one
 * change whole unless it is too large for that by itself.
 * Answers how many values were too large to write at all.
 */
function writeEntries(doc: Y.Doc, entries: Write[][]): number {
  let together: Write[] = [],
    room = ROOM_IN_ONE_CHANGE,
    tooLarge = 0;
  const written = () => {
    const writes = together;
    together = [];
    room = ROOM_IN_ONE_CHANGE;
    if (!writes.length) return;
    doc.transact(() => {
      const meta = doc.getMap(META);
      if (meta.get(LAYOUT_KEY) === undefined) meta.set(LAYOUT_KEY, LAYOUT);
      for (const write of writes) write.run();
    }, LOCAL);
  };
  const add = (writes: Write[], bytes: number) => {
    if (bytes > room) written();
    together.push(...writes);
    room -= bytes;
  };
  for (const all of entries) {
    const writes = all.filter((write) => write.bytes <= LARGEST_VALUE);
    tooLarge += all.length - writes.length;
    const bytes = writes.reduce((sum, write) => sum + write.bytes, 0);
    if (bytes <= ROOM_IN_ONE_CHANGE) add(writes, bytes);
    else for (const write of writes) add([write], write.bytes);
  }
  written();
  return tooLarge;
}

/**
 * Writes what changed on this computer into the document. `before` is the
 * board as this computer last saw it and `after` as it is now: only what
 * differs between the two is written, so a change that arrived from someone
 * else in the meantime is not undone.
 * Answers how many values were too large for the sharing service to take.
 */
export function writeChanges(doc: Y.Doc, before: Board, after: Board): number {
  const entries: Write[][] = [];
  for (const collection of collections) {
    const held = doc.getMap(collection);
    const was = before[collection],
      now = after[collection];
    for (const id of Object.keys(was))
      if (!(id in now))
        entries.push([
          {
            bytes: bytesOf(id, true),
            run: () => {
              const gone = held.get(id);
              // Marked, not removed: an edit made elsewhere at the same moment is kept.
              if (gone instanceof Y.Map) gone.set(DELETED, true);
            },
          },
        ]);
    for (const [id, entry] of Object.entries(now))
      if (!same(was[id], entry))
        entries.push(entryWrites(held, id, was[id], entry));
  }
  return writeEntries(doc, entries);
}

/** Writes one entry as a change of its own, as when a whole board is first written out. */
export function writeEntryAlone(
  doc: Y.Doc,
  collection: Collection,
  id: string,
  entry: Entry,
): number {
  return writeEntries(doc, [
    entryWrites(doc.getMap(collection), id, undefined, entry),
  ]);
}
