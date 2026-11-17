import { diffArrays } from "diff";

interface Span {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
}
interface Edit {
  before: string;
  after: string;
  startsFile: boolean;
  endsFile: boolean;
}
export type StoryProjection =
  { ok: true; baseline: string; hunks: number } | { ok: false; reason: string };

// Retain line endings and EOF exactly. No whitespace/newline normalization,
// fuzzy patch application, source writes or positional tie-breaking is allowed.
const lines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
function uniquePosition(
  text: string,
  needle: string,
  edit: Edit,
  deadline: number,
): number | undefined {
  if (!needle) return;
  let found: number | undefined;
  for (let from = 0; from <= text.length;) {
    if (Date.now() > deadline) return;
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    if (
      (at === 0 || text[at - 1] === "\n") &&
      (needle.endsWith("\n") || end === text.length)
    ) {
      if (found !== undefined) return;
      found = at;
    }
    from = at + 1;
  }
  if (
    found === undefined ||
    (edit.startsFile && found !== 0) ||
    (edit.endsFile && found + needle.length !== text.length)
  )
    return;
  return found;
}

function applyExact(
  text: string,
  edits: Edit[],
  reverse: boolean,
  deadline: number,
): string | undefined {
  const positions: Array<{
    at: number;
    expected: string;
    replacement: string;
  }> = [];
  for (const edit of edits) {
    const expected = reverse ? edit.after : edit.before;
    const at = uniquePosition(text, expected, edit, deadline);
    if (at === undefined) return;
    const previous = positions.at(-1);
    // The same own hunks cannot overlap, swap order, or reuse one match.
    if (previous && at < previous.at + previous.expected.length) return;
    positions.push({
      at,
      expected,
      replacement: reverse ? edit.before : edit.after,
    });
  }
  for (const { at, expected, replacement } of positions.reverse())
    text = text.slice(0, at) + replacement + text.slice(at + expected.length);
  return text;
}

/**
 * Build a counterfactual baseline with only this story's own edit removed.
 * Its changed lines and exact neighboring context must be unique in both the
 * saved story output and current source. Reapplying the exact own edits must
 * reproduce current source byte-for-byte. This proves a bounded projection,
 * not historical authorship of any peer edit or semantic independence.
 */
export function projectStoryContribution(
  before: string,
  after: string,
  current: string,
): StoryProjection {
  const rejected = (reason: string): StoryProjection => ({ ok: false, reason });
  if (
    [before, after, current].some(
      (text) => text.includes("\0") || text.length > 2_000_000,
    )
  )
    return rejected("The exact-context projection exceeds its text bounds.");
  const original = lines(before),
    saved = lines(after);
  if (original.length > 50_000 || saved.length > 50_000)
    return rejected("The exact-context projection exceeds its line bounds.");
  const deadline = Date.now() + 200;
  const parts = diffArrays(original, saved, {
    timeout: 100,
    maxEditLength: 4000,
  });
  if (!parts)
    return rejected("The own change exceeds the bounded exact-context diff.");
  const spans: Span[] = [];
  let oldLine = 0,
    newLine = 0,
    active: Span | undefined;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (active) {
        spans.push(active);
        active = undefined;
      }
      oldLine += part.value.length;
      newLine += part.value.length;
    } else {
      active ??= {
        beforeStart: oldLine,
        beforeEnd: oldLine,
        afterStart: newLine,
        afterEnd: newLine,
      };
      if (part.removed) oldLine += part.value.length;
      if (part.added) newLine += part.value.length;
      active.beforeEnd = oldLine;
      active.afterEnd = newLine;
    }
  }
  if (active) spans.push(active);
  if (!spans.length) return rejected("There is no net own change to project.");

  // One exact unchanged line on each available side keeps adjacent peer edits
  // out of the match. Nearby own edits share a single context window.
  const groups: Span[] = [];
  for (const span of spans) {
    const previous = groups.at(-1);
    if (previous && span.beforeStart - previous.beforeEnd <= 2) {
      previous.beforeEnd = span.beforeEnd;
      previous.afterEnd = span.afterEnd;
    } else groups.push({ ...span });
  }
  if (groups.length > 100)
    return rejected("Too many own hunks for bounded exact-context projection.");
  const edits: Edit[] = groups.map((span) => {
    const prefix = Math.min(1, span.beforeStart, span.afterStart);
    const suffix = Math.min(
      1,
      original.length - span.beforeEnd,
      saved.length - span.afterEnd,
    );
    return {
      before: original
        .slice(span.beforeStart - prefix, span.beforeEnd + suffix)
        .join(""),
      after: saved
        .slice(span.afterStart - prefix, span.afterEnd + suffix)
        .join(""),
      startsFile: span.afterStart - prefix === 0,
      endsFile: span.afterEnd + suffix === saved.length,
    };
  });
  const savedBaseline = applyExact(after, edits, true, deadline);
  if (Date.now() > deadline)
    return rejected(
      "The exact-context projection reached its bounded deadline.",
    );
  if (savedBaseline !== before)
    return rejected(
      "The story's saved hunks do not have unique exact context.",
    );
  const baseline = applyExact(current, edits, true, deadline);
  if (Date.now() > deadline)
    return rejected(
      "The exact-context projection reached its bounded deadline.",
    );
  if (baseline === undefined)
    return rejected(
      "Current source overlaps the own hunks, changed their exact context, or has ambiguous matches.",
    );
  const reapplied = applyExact(baseline, edits, false, deadline);
  if (Date.now() > deadline)
    return rejected(
      "The exact-context projection reached its bounded deadline.",
    );
  if (reapplied !== current)
    return rejected(
      "The projected baseline cannot reproduce current source with unique exact own hunks.",
    );
  return { ok: true, baseline, hunks: edits.length };
}
