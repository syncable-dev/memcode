import { test } from "node:test";
import assert from "node:assert/strict";
import { publicReport, reportExcerpt } from "../runtime/worker-report.ts";

const roots = {
  repositories: [
    "/Users/dev/Library/Application Support/MemCode/epic-checkouts/a33f",
    "/Users/dev/code/app",
  ],
  home: "/Users/dev",
};

test("links into the repository become repo-relative code, without line suffixes", () => {
  assert.equal(
    publicReport(
      "Updated [UI.tsx](/Users/dev/code/app/src/components/UI.tsx:12) and [Test file](</Users/dev/Library/Application Support/MemCode/epic-checkouts/a33f/tests/routing.test.ts>).",
      roots,
    ),
    "Updated `src/components/UI.tsx` and Test file (`tests/routing.test.ts`).",
  );
});

test("links outside the repository keep only their words", () => {
  assert.equal(
    publicReport(
      "Added the [logo](/Users/dev/code/app/.memcode/workers/f99/artifacts/logo.svg) and [notes](/tmp/notes.md).",
      roots,
    ),
    "Added the logo and notes.",
  );
});

test("web links are kept as they are", () => {
  const text = "See [the RFC](https://example.com/rfc) for details.";
  assert.equal(publicReport(text, roots), text);
});

test("bare local paths never reach the pull request", () => {
  const scrubbed = publicReport(
    "Smoke check hit EPERM creating `/Users/dev/code/app/target/x` and `/Users/dev/.cache/y`.",
    roots,
  );
  assert.equal(
    scrubbed,
    "Smoke check hit EPERM creating `target/x` and `~/.cache/y`.",
  );
  assert.doesNotMatch(scrubbed, /\/Users\/dev/);
});

test("long reports are cut at a paragraph boundary", () => {
  const text = ["First paragraph.", "Second paragraph.", "Third paragraph."].join(
    "\n\n",
  );
  assert.equal(reportExcerpt(text, 40), "First paragraph.\n\nSecond paragraph.\n\n…");
  assert.equal(reportExcerpt(text, 400), text);
});
