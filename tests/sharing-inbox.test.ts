import test from "node:test";
import assert from "node:assert/strict";
import {
  decisionEntry,
  inboxItems,
  requestFrom,
  type InboxLogEntry,
} from "../src/inbox";

const item = "5b0f7f40-62a6-5a8e-9b3f-0d8c4a1e2f11";
const entry = (payload: unknown, author = "usr_alex"): InboxLogEntry => ({
  author,
  payload: new TextEncoder().encode(JSON.stringify(payload)),
});

/** A report exactly as MemSync's crates/slack writes one (its inbox_entries test). */
const report = {
  format: "memcode-inbox/1",
  kind: "report",
  item,
  title: "On iPhone the discount code clears when they tap Apply.",
  text: "<@U0MEMCODE> On iPhone the discount code clears when they tap Apply.",
  reporter: { name: "Dana K.", slack_user: "U0DANA" },
  filed_by: { name: "Sam", slack_user: "U0SAM" },
  source: {
    team: "T1",
    channel: "C1",
    message_ts: "1764067320.000200",
    permalink: "https://acme.slack.com/archives/C1/p1764067320000200",
  },
  files: [
    {
      name: "apply-clears.mov",
      mime: "video/quicktime",
      size: 48_000_000,
      slack_url: "https://acme.slack.com/files/U0DANA/F1",
      not_kept: "too_big",
    },
    {
      name: "IMG_4471.png",
      mime: "image/png",
      size: 812_000,
      slack_url: "https://acme.slack.com/files/U0DANA/F2",
      sha256: "ab".repeat(32),
    },
  ],
  links: ["https://sentry.io/issues/4f2"],
  details: { expected: "The discount applies", where: "Checkout, iOS", how_bad: "blocked" },
  reported_at: "2025-11-25T10:42:00Z",
};

test("a report from Slack reads as a new Inbox item with its evidence", () => {
  const [read] = inboxItems([entry(report)]);
  assert.equal(read.id, item);
  assert.equal(read.state, "new");
  assert.equal(read.reporter.name, "Dana K.");
  assert.equal(read.filedBy?.name, "Sam");
  assert.equal(read.howBad, "blocked");
  assert.equal(read.where, "Checkout, iOS");
  assert.equal(read.files[0].notKept, "too_big");
  assert.equal(read.files[1].sha256, "ab".repeat(32));
  assert.deepEqual(read.links, ["https://sentry.io/issues/4f2"]);
});

test("replies and others hit by it join their report, each person once", () => {
  const reply = {
    format: "memcode-inbox/1",
    kind: "reply",
    item,
    text: "Also on iPad",
    author: { name: "Sam", slack_user: "U0SAM" },
    files: [],
    links: [],
    written_at: "2025-11-25T10:45:00Z",
  };
  const hit = {
    format: "memcode-inbox/1",
    kind: "also_hit",
    item,
    person: { name: "Lee", slack_user: "U0LEE" },
  };
  const [read] = inboxItems([entry(report), entry(reply), entry(hit), entry(hit)]);
  assert.equal(read.replies[0].text, "Also on iPad");
  assert.deepEqual(
    read.alsoHit.map((person) => person.name),
    ["Lee"],
  );
});

test("the latest decision is the item's state", () => {
  const decided = (decision: Parameters<typeof decisionEntry>[1], who: string) =>
    entry(decisionEntry(item, decision), who);
  const declined = inboxItems([
    entry(report),
    decided({ kind: "picked_up", goal: "g1", goalTitle: "Fix discounts" }, "usr_sam"),
    decided({ kind: "declined", reason: "Duplicate of an open goal" }, "usr_alex"),
  ])[0];
  assert.equal(declined.state, "declined");
  assert.equal(declined.reason, "Duplicate of an open goal");
  assert.equal(declined.goal, undefined);
  assert.equal(declined.decidedBy, "usr_alex");

  const picked = inboxItems([
    entry(report),
    decided({ kind: "declined", reason: "" }, "usr_alex"),
    decided({ kind: "reopened" }, "usr_alex"),
    decided({ kind: "picked_up", goal: "g1", goalTitle: "Fix discounts" }, "usr_sam"),
  ])[0];
  assert.equal(picked.state, "picked_up");
  assert.deepEqual(picked.goal, { id: "g1", title: "Fix discounts" });
});

test("entries that are not this format, or of an unknown kind, are skipped", () => {
  const read = inboxItems([
    { author: "x", payload: new TextEncoder().encode("not json") },
    entry({ ...report, format: "something-else/9" }),
    entry({ format: "memcode-inbox/1", kind: "teleported", item }),
    entry(report),
    entry(report),
  ]);
  assert.equal(read.length, 1);
});

test("newest report first", () => {
  const older = { ...report, item: "older", reported_at: "2025-11-24T09:00:00Z" };
  const read = inboxItems([entry(older), entry(report)]);
  assert.deepEqual(
    read.map((one) => one.id),
    [item, "older"],
  );
});

test("a goal starts from the report as someone would write it", () => {
  const [read] = inboxItems([entry({ ...report, text: "It clears.\nEvery time." })]);
  const request = requestFrom(read);
  assert.match(request, /^On iPhone the discount code clears/);
  assert.match(request, /Expected: The discount applies/);
  assert.match(request, /Reported in Slack: https:\/\/acme\.slack\.com/);
});
