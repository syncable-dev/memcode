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

/** Writes the values that differ between two records, and takes out the ones that are gone. */
function writeValues(
  kept: Y.Map<unknown>,
  was: Record<string, Json>,
  now: Record<string, Json>,
  keyOf: (name: string) => string,
) {
  for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (same(was[name], now[name])) continue;
    if (name in now) kept.set(keyOf(name), now[name]);
    else kept.delete(keyOf(name));
  }
}

function writeEntry(
  held: Y.Map<unknown>,
  id: string,
  before: Entry | undefined,
  after: Entry,
) {
  // An entry is made once. Putting a second map under an id that is already there
  // would replace the first one whole, with every edit anyone made to it.
  let kept = held.get(id);
  if (!(kept instanceof Y.Map)) {
    kept = new Y.Map<unknown>();
    held.set(id, kept);
  }
  const map = kept as Y.Map<unknown>;
  const known = before ?? readEntry(map);
  if (map.get(DELETED) === true) map.delete(DELETED);
  writeValues(map, known.fields, after.fields, (name) => name);
  for (const set of new Set([
    ...Object.keys(known.sets),
    ...Object.keys(after.sets),
  ]))
    writeValues(
      map,
      known.sets[set] ?? {},
      after.sets[set] ?? {},
      (member) => set + MEMBER_OF + member,
    );
  for (const [name, wording] of Object.entries(after.texts))
    if (known.texts[name] !== wording) writeText(map, name, wording);
}

/**
 * Writes what changed on this computer into the document, as one change.
 * `before` is the board as this computer last saw it and `after` as it is now:
 * only what differs between the two is written, so a change that arrived from
 * someone else in the meantime is not undone.
 */
export function writeChanges(doc: Y.Doc, before: Board, after: Board): void {
  doc.transact(() => {
    const meta = doc.getMap(META);
    if (meta.get(LAYOUT_KEY) === undefined) meta.set(LAYOUT_KEY, LAYOUT);
    for (const collection of collections) {
      const held = doc.getMap(collection);
      const was = before[collection],
        now = after[collection];
      for (const id of Object.keys(was))
        if (!(id in now)) {
          const gone = held.get(id);
          // Marked, not removed: an edit made elsewhere at the same moment is kept.
          if (gone instanceof Y.Map) gone.set(DELETED, true);
        }
      for (const [id, entry] of Object.entries(now))
        if (!same(was[id], entry)) writeEntry(held, id, was[id], entry);
    }
  }, LOCAL);
}
