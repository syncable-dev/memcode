import test from "node:test";
import assert from "node:assert/strict";
import type { WorkItem } from "../src/shared";
import {
  readableSummary,
  summaryOf,
  SUMMARY_HEADING,
} from "../runtime/sharing/cards/summary";

const CHECKOUT =
  "/Users/alex/Library/Application Support/MemCode/epic-checkouts/e476d57e";

const finishedWith = (text: string, run: Partial<WorkItem["run"]> = {}) =>
  ({
    run: {
      state: "finished",
      startedAt: "2026-11-23T13:30:00.000Z",
      workspace: CHECKOUT,
      ...run,
    },
    messages: [
      {
        id: "m1",
        role: "user",
        text: "Count nonblank lines.",
        at: "2026-11-23T13:30:00.000Z",
      },
      { id: "m2", role: "assistant", text, at: "2026-11-23T13:38:00.000Z" },
    ],
  }) as unknown as WorkItem;

test("the summary is the section the worker headed for the project, not the whole message", () => {
  const summary = summaryOf(
    finishedWith(
      `Implemented it in [count](${CHECKOUT}/count).\n\nVerified: empty input gives 0.\n\n${SUMMARY_HEADING}\nAdded a command that counts nonblank lines. Checked empty and whitespace-only input. Nothing is left open.`,
    ),
  );
  assert.deepEqual(summary, {
    text: "Added a command that counts nonblank lines. Checked empty and whitespace-only input. Nothing is left open.",
    at: "2026-11-23T13:38:00.000Z",
  });
});

test("a worker that heads its summary in bold or as a heading is understood too", () => {
  for (const heading of [
    `**${SUMMARY_HEADING}**`,
    `## ${SUMMARY_HEADING.replace(":", "")}`,
    "Project summary:",
  ])
    assert.equal(
      summaryOf(finishedWith(`Long details.\n\n${heading} Added the export.`))!
        .text,
      "Added the export.",
    );
});

test("without a heading the worker's whole last message is the summary", () => {
  assert.equal(
    summaryOf(finishedWith("Added the export and its test."))!.text,
    "Added the export and its test.",
  );
});

test("a run that has not finished, or never answered, has no summary", () => {
  assert.equal(
    summaryOf(finishedWith("Halfway there.", { state: "running" })),
    undefined,
  );
  const silent = finishedWith("x");
  silent.messages = silent.messages.slice(0, 1);
  assert.equal(summaryOf(silent), undefined);
});

test("links to files on the worker's computer become the files' names; web links stay", () => {
  assert.equal(
    readableSummary(
      `See [README.md](${CHECKOUT.replaceAll(" ", "%20")}/README.md:5) and [the issue](https://github.com/o/r/issues/1).`,
      [CHECKOUT],
    ),
    "See README.md and [the issue](https://github.com/o/r/issues/1).",
  );
});

test("a path in the project reads as the path in the project; any other local path as the file's name", () => {
  assert.equal(
    readableSummary(
      `Changed ${CHECKOUT}/src/count.ts and noted it in /Users/alex/notes/today.md.`,
      [CHECKOUT],
    ),
    "Changed src/count.ts and noted it in today.md.",
  );
});

test("a secret never reaches the summary", () => {
  assert.equal(
    readableSummary("Used Bearer abc.def to call the API.", []),
    "Used Bearer <redacted> to call the API.",
  );
});
