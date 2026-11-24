import test from "node:test";
import assert from "node:assert/strict";
import {
  decisionEntry,
  commentsSince,
  filesOf,
  inboxItems,
  opensOnThisComputer,
  reportDocument,
  requestFrom,
  shownHere,
  slackText,
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
  const picture = { ...reply, text: "<@U0MEMCODE>", files: [report.files[1]] };
  const [withPicture] = inboxItems([entry(report), entry(picture)]);
  assert.equal(withPicture.replies[0].text, "");
  assert.deepEqual(
    withPicture.replies[0].files.map((one) => one.name),
    ["IMG_4471.png"],
  );
  assert.equal(withPicture.files.length, 2, "the report keeps its own files");
  assert.equal(filesOf(withPicture).length, 3);
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

test("a title that opens the text is not said twice", () => {
  const [read] = inboxItems([
    entry({ ...report, title: "Search goes blank", text: "Search goes blank on iPhone. Every time." }),
  ]);
  const request = requestFrom(read);
  assert.equal(request.split("Search goes blank").length - 1, 1, request);
});

test("a Slack message reads as people wrote it, without Slack's codes", () => {
  const cases: Array<[string, string]> = [
    ["<@U0CLE0NL561> test, adding this issue", "test, adding this issue"],
    ["hey <@U0CLE0NL561> it broke", "hey it broke"],
    ["ask <@U0DANA|Dana K.> about it", "ask @Dana K. about it"],
    ["<@U0DANA|Dana>, look", "@Dana, look"],
    ["see <#C024|checkout> and <#C9>", "see #checkout and #channel"],
    ["<!here> down, <!subteam^S1|@oncall> look", "@here down, @oncall look"],
    ["<https://sentry.io/4f2>", "https://sentry.io/4f2"],
    ["<https://sentry.io/4f2|the crash>", "the crash (https://sentry.io/4f2)"],
    ["<http://acme.test|acme.test>", "acme.test (http://acme.test)"],
    ["<mailto:dana@acme.test|dana@acme.test>", "dana@acme.test"],
    ["if a &lt; b &amp;&amp; c &gt; d", "if a < b && c > d"],
    [":wink: nice :+1::skin-tone-3: :my-company-cat:", "😉 nice 👍 :my-company-cat:"],
    ["at 10:30:45 it broke", "at 10:30:45 it broke"],
    ["a <div> stays, and &lt;@U1&gt; was typed", "a <div> stays, and <@U1> was typed"],
    ["two\nlines", "two\nlines"],
  ];
  for (const [raw, shown] of cases) assert.equal(slackText(raw), shown, raw);
});

test("a report's text and replies have no Slack codes, and neither has a goal from it", () => {
  const raw = { ...report, title: "It clears", text: "<@U0MEMCODE> It clears, see <https://a.test|this>" };
  const reply = {
    format: "memcode-inbox/1",
    kind: "reply",
    item,
    text: "<@U0MEMCODE> also on iPad",
    author: { name: "Sam", slack_user: "U0SAM" },
    files: [],
    links: [],
    written_at: "2025-11-25T10:45:00Z",
  };
  const [read] = inboxItems([entry(raw), entry(reply)]);
  assert.equal(read.text, "It clears, see this (https://a.test)");
  assert.equal(read.replies[0].text, "also on iPad");
  assert.doesNotMatch(requestFrom(read), /<@/);
});

test("each kind of evidence opens where it can be seen", () => {
  const sha256 = "ab".repeat(32);
  const of = (name: string, mime: string, kept = true) => ({
    name,
    mime,
    size: 1,
    slackUrl: "https://acme.slack.com/f",
    sha256: kept ? sha256 : undefined,
  });
  const where = (file: ReturnType<typeof of>) => [shownHere(file), opensOnThisComputer(file)];
  assert.deepEqual(where(of("a.png", "image/png")), ["image", true]);
  assert.deepEqual(where(of("a.mp4", "video/mp4")), ["video", true]);
  assert.deepEqual(where(of("server.log", "application/octet-stream")), ["text", true]);
  for (const name of ["a.pdf", "a.docx", "a.xlsx", "a.pptx", "notes.md"])
    assert.deepEqual(where(of(name, "application/octet-stream")), ["document", true], name);
  assert.deepEqual(where(of("a.odt", "application/octet-stream")), [undefined, true]);
  // These can run, so they open in Slack alone.
  for (const name of ["a.exe", "a.pdf.exe", "a.docm", "a.lnk", "a.zip", "a"])
    assert.deepEqual(where(of(name, "application/octet-stream")), [undefined, false], name);
  assert.deepEqual(where(of("a.html", "text/html")), [undefined, false]);
  // A file the project keeps no copy of is in Slack.
  assert.deepEqual(where(of("a.png", "image/png", false)), [undefined, false]);
});

test("a comment brings its report to the top, is new until it is looked at, and is in the goal", () => {
  const older = { ...report, item: "older", reported_at: "2025-11-24T09:00:00Z" };
  const comment = (at: string, text: string) =>
    entry({
      format: "memcode-inbox/1",
      kind: "reply",
      item: "older",
      text,
      author: { name: "Sam", slack_user: "U0SAM" },
      files: [],
      links: ["https://sentry.io/issues/9"],
      written_at: at,
    });
  const log = [
    entry(older),
    entry(report),
    comment("2025-11-26T08:00:00Z", "Still broken"),
    comment("2025-11-26T09:00:00Z", "On Android too"),
  ];
  const [first, second] = inboxItems(log);
  assert.deepEqual([first.id, second.id], ["older", item]);
  assert.deepEqual(first.replies[0].links, ["https://sentry.io/issues/9"]);
  const since = (at?: string) => commentsSince(first, at).map((one) => one.text);
  assert.deepEqual(since("2025-11-24T09:00:00Z"), ["Still broken", "On Android too"]);
  assert.deepEqual(since("2025-11-26T08:00:00Z"), ["On Android too"]);
  assert.deepEqual(since("2025-11-26T09:00:00Z"), []);
  assert.deepEqual(since(undefined), [], "a report nobody opened is new itself");
  assert.match(requestFrom(first), /Comments in the thread:\n- Sam: Still broken\n- Sam: On Android too/);
});

test("a goal starts with the whole report: comments, links, and what could not be attached", () => {
  const comment = entry({
    format: "memcode-inbox/1",
    kind: "reply",
    item,
    text: "On Android too, see <https://sentry.io/issues/9>",
    author: { name: "Sam", slack_user: "U0SAM" },
    files: [{ name: "android.png", mime: "image/png", size: 1, slack_url: "https://s/F9", sha256: "cd".repeat(32) }],
    links: ["https://sentry.io/issues/9", "https://sentry.io/issues/4f2"],
    written_at: "2025-11-26T08:00:00Z",
  });
  const [read] = inboxItems([entry(report), comment]);
  const request = requestFrom(read);
  assert.match(request, /How bad: someone is blocked/);
  assert.match(request, /Comments in the thread:\n- Sam: On Android too/);
  assert.match(request, /Links:\n- https:\/\/sentry\.io\/issues\/4f2\n- https:\/\/sentry\.io\/issues\/9\n/);
  assert.match(request, /Too big to attach, in Slack:\n- apply-clears\.mov: https:\/\/acme/);

  const document = reportDocument(read);
  assert.match(document, /^# On iPhone the discount code clears/);
  assert.match(document, /Reported in Slack by Dana K\., 2025-11-25T10:42:00Z\./);
  assert.match(document, /## Expected\n\nThe discount applies/);
  assert.match(document, /Files: apply-clears\.mov, IMG_4471\.png/);
  assert.match(document, /### Sam, 2025-11-26T08:00:00Z\n\nOn Android too.*\n\nFiles: android\.png/);
  assert.equal(document.split("issues/4f2").length - 1, 1, "each link once");
});
