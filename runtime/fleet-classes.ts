import { breaksCallers, onlyAdds, type ChangeKind, type ConflictClass } from "../src/fleet";

/**
 * How one recorded edit relates to the peers' edits that overlapped it in time, by the
 * same rule Fleet's classifier uses: A is independent, B is compatible once re-read, C is
 * a breaking change meeting someone else's work.
 *
 * `peersBreak` holds one entry per overlapping peer: whether its change breaks callers.
 */
export function conflictClass(kind: ChangeKind, peersBreak: boolean[]): ConflictClass {
  if (!peersBreak.length) return "A";
  const breaking = breaksCallers(kind) || peersBreak.some(Boolean);
  return breaking && !onlyAdds(kind) ? "C" : "B";
}
