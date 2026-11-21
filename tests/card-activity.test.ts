import { test } from "node:test";
import assert from "node:assert/strict";
import { CardActivityFeed, cardActivity } from "../src/card-activity.ts";
import type { WorkItem } from "../src/shared.ts";

const task = (id: string, run: Partial<WorkItem["run"]>) =>
  ({ id, run: { state: "running", ...run } }) as unknown as WorkItem;
const doing = (label: string, phase: "working" | "tool" | "waiting_for_user" = "working") => ({
  activity: { phase, label, at: "2026-11-20T10:00:00.000Z" },
});

test("a card shows a calm one-line summary of what its worker is doing", () => {
  assert.deepEqual(cardActivity(task("a", doing("Opening the goal checkout"))), {
    label: "Opening the goal checkout",
  });
  assert.deepEqual(cardActivity(task("a", doing("Read src/auth/session.ts", "tool"))), {
    label: "Read src/auth/session.ts",
  });
  assert.deepEqual(
    cardActivity(
      task("a", doing("I should check how the session cookie is rotated before touching the refresh path, because")),
    ),
    { label: "Thinking" },
    "streamed thinking text becomes one steady word",
  );
  assert.deepEqual(cardActivity(task("a", { state: "preparing" })), { label: "Starting" });
  assert.equal(cardActivity(task("a", doing("Approve this?", "waiting_for_user"))), undefined);
  assert.equal(cardActivity(task("a", { state: "idle" as WorkItem["run"]["state"] })), undefined);
});

/** A clock and timer queue the test moves by hand. */
function fakeTime() {
  let now = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  return {
    clock: () => now,
    schedule: (run: () => void, delay: number) => {
      const timer = { at: now + delay, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((item) => item.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

test("each card's line changes at most once per interval, and the latest wins", () => {
  const time = fakeTime();
  const feed = new CardActivityFeed({ interval: 2000, clock: time.clock, schedule: time.schedule });
  let notified = 0;
  feed.subscribe("a", () => notified++);

  feed.publish([task("a", doing("Opening the goal checkout"))]);
  assert.equal(feed.get("a")?.label, "Opening the goal checkout");
  assert.equal(notified, 1, "the first line shows at once");

  time.advance(300);
  feed.publish([task("a", doing("Connecting to the goal code graph"))]);
  time.advance(300);
  feed.publish([task("a", doing("Preparing the worker brief"))]);
  assert.equal(feed.get("a")?.label, "Opening the goal checkout", "changes inside the interval wait");
  assert.equal(notified, 1);

  time.advance(1400);
  assert.equal(feed.get("a")?.label, "Preparing the worker brief", "one trailing update with the newest line");
  assert.equal(notified, 2);

  feed.publish([task("a", doing("Preparing the worker brief"))]);
  assert.equal(notified, 2, "an unchanged line never re-renders");
});

test("cards update on their own, and a finished task clears at once", () => {
  const time = fakeTime();
  const feed = new CardActivityFeed({ interval: 2000, clock: time.clock, schedule: time.schedule });
  const seen: string[] = [];
  feed.subscribe("a", () => seen.push("a"));
  feed.subscribe("b", () => seen.push("b"));

  feed.publish([task("a", doing("Starting Codex")), task("b", doing("Starting Cursor"))]);
  time.advance(2500);
  feed.publish([task("a", doing("Editing files", "tool")), task("b", doing("Starting Cursor"))]);
  assert.deepEqual(seen, ["a", "b", "a"], "only the card whose line changed is told");

  time.advance(100);
  feed.publish([task("a", { state: "finished" }), task("b", doing("Starting Cursor"))]);
  assert.equal(feed.get("a"), undefined, "no stale 'working' line on a finished task");

  feed.publish([task("b", doing("Starting Cursor"))]);
  assert.equal(feed.get("a"), undefined, "a task that left the board is forgotten");
});
