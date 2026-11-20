import { test } from "node:test";
import assert from "node:assert/strict";
import { looksSmall, suggestedPlace } from "../src/new-work.ts";

const placement = (goals: Array<{ epicId: string; title: string; shared: string[] }>) => ({
  files: goals.flatMap((goal) => goal.shared),
  goals,
});

test("a short single-line request looks like a quick change", () => {
  assert.equal(looksSmall("Fix the typo in the login banner"), true);
  assert.equal(looksSmall("Add dark mode to the dashboard and remember each person's choice. ".repeat(3)), false);
  assert.equal(looksSmall("Fix typo\nand also refactor the settings page"), false);
  assert.equal(
    looksSmall("Add dark mode to the dashboard and remember each person's choice"),
    false,
    "two asks joined by 'and' are a goal",
  );
});

test("a goal already changing the same code is suggested first", () => {
  assert.deepEqual(
    suggestedPlace(placement([{ epicId: "g1", title: "Sessions", shared: ["a.ts"] }]), "Rate-limit refresh"),
    { kind: "goal", epicId: "g1" },
  );
});

test("a goal chosen from its own card stays the choice", () => {
  assert.deepEqual(
    suggestedPlace(placement([{ epicId: "g1", title: "Sessions", shared: ["a.ts"] }]), "Anything", "g2"),
    { kind: "goal", epicId: "g2" },
  );
});

test("unrelated work is a quick change when small and a new goal when not", () => {
  assert.deepEqual(suggestedPlace(placement([]), "Fix the typo in the banner"), { kind: "quick" });
  assert.deepEqual(
    suggestedPlace(placement([]), "Build a CSV export for every report, with filters, scheduling and email delivery to admins."),
    { kind: "new" },
  );
});
