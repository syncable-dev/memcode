import { createHash } from "node:crypto";
import * as Y from "yjs";
import { LARGEST_UPDATE } from "./document";

/**
 * Updates on their way to and from a board's log: the id each is sent under,
 * whether one that arrived may be applied, and what a document holds that the
 * log does not.
 */

/** How many ids the same bytes can be sent under. More than one, so a repair can be told from what it repairs. */
const IDS_PER_UPDATE = 8;
/** The service takes a hundred updates a call, and four mebibytes unless it is set up otherwise. */
const MOST_UPDATES_IN_A_CALL = 100,
  MOST_BYTES_IN_A_CALL = 3 * 1024 * 1024;

/**
 * The id an update is sent under: a UUID made from its bytes. A reader that
 * finds bytes which do not give their id knows they changed after they were
 * written. `again` gives the same bytes another id, for sending them a second
 * time when the log's copy of the first is damaged.
 */
export function idOf(payload: Uint8Array, again = 0): string {
  const hash = createHash("sha256").update(payload);
  if (again) hash.update(Uint8Array.of(again));
  const bytes = hash.digest().subarray(0, 16);
  // Version 8 is the one for ids made by a rule of the sender's own.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function isMadeFrom(id: string, payload: Uint8Array): boolean {
  const sent = id.toLowerCase();
  for (let again = 0; again < IDS_PER_UPDATE; again++)
    if (idOf(payload, again) === sent) return true;
  return false;
}

export type NotApplied = "too-large" | "changed" | "unreadable";

/**
 * Why an update from the log must not be applied, or nothing when it may be.
 * Reading it first matters: applying an update that does not read can leave
 * the document half changed.
 */
export function whyNotApplied(
  id: string,
  payload: Uint8Array,
): NotApplied | undefined {
  if (payload.length > LARGEST_UPDATE) return "too-large";
  if (!isMadeFrom(id, payload)) return "changed";
  try {
    Y.decodeUpdate(payload);
  } catch {
    return "unreadable";
  }
  return undefined;
}

type Deleted = Array<{ clock: number; len: number }>;
/** Whether every deleted stretch of one list lies inside the stretches of the other. */
function covers(theirs: Deleted | undefined, mine: Deleted): boolean {
  let at = 0;
  for (const range of mine) {
    let clock = range.clock;
    const end = range.clock + range.len;
    while (clock < end) {
      while (
        theirs &&
        at < theirs.length &&
        theirs[at].clock + theirs[at].len <= clock
      )
        at++;
      const cover = theirs?.[at];
      if (!cover || cover.clock > clock) return false;
      clock = cover.clock + cover.len;
    }
  }
  return true;
}

/** Whether a document holds a change or a deletion that another one lacks. */
export function holdsMore(mine: Y.Doc, theirs: Y.Doc): boolean {
  const known = Y.decodeStateVector(Y.encodeStateVector(theirs));
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(mine)))
    if (clock > (known.get(client) ?? 0)) return true;
  const deletedThere = Y.createDeleteSetFromStructStore(theirs.store).clients;
  for (const [client, deleted] of Y.createDeleteSetFromStructStore(mine.store)
    .clients)
    if (!covers(deletedThere.get(client), deleted)) return true;
  return false;
}

/** One update with everything `from` holds that `reader` lacks. */
export const missingFrom = (reader: Y.Doc, from: Y.Doc): Uint8Array =>
  Y.encodeStateAsUpdate(from, Y.encodeStateVector(reader));

/** The updates to send in the next call: from the front, as many as one call may hold. */
export function nextCall<Update extends { payload: Uint8Array }>(
  waiting: Update[],
): Update[] {
  const call: Update[] = [];
  let bytes = 0;
  for (const update of waiting) {
    if (call.length === MOST_UPDATES_IN_A_CALL) break;
    if (call.length && bytes + update.payload.length > MOST_BYTES_IN_A_CALL)
      break;
    call.push(update);
    bytes += update.payload.length;
  }
  return call;
}
