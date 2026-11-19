import test from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { workerCheckoutBrief, workerContextForPrompt, workerTurnContext } from "../runtime/worker-turn";
import { claimReviewContext } from "../runtime/review-context";
import type { Message } from "../src/shared";

const message = (
  id: string,
  role: Message["role"],
  text: string,
  fields: Partial<Message> = {},
): Message => ({ id, role, text, at: "2026-11-15T17:00:00Z", ...fields });
const sent = { promptedAt: "2026-11-15T16:00:00Z" };
const task = { description: "Implement the original latency module." };

test("a queued request ends the prompt after long historical replies to already-completed work", () => {
  const marker = "CSS-FIX-claude-real-failure-shape";
  const messages = [
    message("original", "user", task.description, sent),
    message(
      "large-history",
      "assistant",
      "Earlier implementation details. ".repeat(2300),
    ),
    message(
      "queued",
      "user",
      `Export followupReceipt = ${marker}; run tests.`,
      {
        followupState: "queued",
      },
    ),
    message(
      "previous-completion",
      "assistant",
      "The original latency function is implemented and all tests pass.",
    ),
  ];
  assert.ok(messages.map((item) => item.text).join("").length > 70000);
  const turn = workerTurnContext(task, claimReviewContext(messages, "picked"));
  const prompt = [
    turn.intro,
    task.description,
    turn.history,
    turn.current,
  ].join("\n\n");
  assert.match(turn.intro, /CURRENT WORKER PASS: follow-up/);
  assert.ok(prompt.endsWith(messages[2].text));
  assert.ok(
    prompt.lastIndexOf("CURRENT REQUESTS") > prompt.indexOf(messages[3].text),
  );
  assert.equal(prompt.split(marker).length - 1, 1);
  assert.ok(turn.history.length < 8300);
  assert.equal(messages[2].promptedAt, undefined);
});

test("all claimed requests and complete review selections retain order while cancelled and late input stay out", () => {
  const review =
    "Change this selected passage.\nReference 1: report.md lines 20–22\n> " +
    "Exact selected wording. ".repeat(900);
  const messages = [
    message("old", "user", "Old consumed request", sent),
    message("first", "user", review, { followupState: "queued" }),
    message("cancelled", "user", "CANCELLED-DO-NOT-SURFACE", {
      followupState: "cancelled",
    }),
    message("second", "user", "Then update cells B2:C4 and run the suite.", {
      followupState: "queued",
    }),
    message("assistant", "assistant", "Previous pass is finished."),
  ];
  const snapshot = claimReviewContext(messages, "picked");
  messages.push(
    message("late", "user", "LATE-NEXT-PASS", { followupState: "queued" }),
  );
  const turn = workerTurnContext(task, snapshot, 100);
  const prompt = [turn.intro, turn.history, turn.current].join("\n\n");
  assert.ok(
    turn.current.includes(review),
    "Current review context is never clipped to the history budget",
  );
  assert.ok(
    turn.current.indexOf(review) < turn.current.indexOf(messages[3].text),
  );
  assert.ok(prompt.endsWith(messages[3].text));
  assert.ok(!prompt.includes("CANCELLED-DO-NOT-SURFACE"));
  assert.ok(!prompt.includes("LATE-NEXT-PASS"));
  assert.ok(!turn.current.includes("Old consumed request"));
});

test("ordinary fresh input governs a pass and manual continuation uses the latest user request", () => {
  const old = message("old", "user", "Original goal", sent);
  const latest = message("latest", "user", "Revise the latest result.");
  const fresh = workerTurnContext(task, [old, latest]);
  assert.ok(fresh.current.endsWith(latest.text));
  assert.ok(!fresh.current.includes(old.text));
  const resumed = workerTurnContext(task, [
    old,
    { ...latest, ...sent },
    message("reply", "assistant", "Done"),
  ]);
  assert.match(resumed.intro, /CURRENT WORKER PASS: continuation/);
  assert.ok(resumed.current.endsWith(latest.text));
  assert.ok(workerTurnContext(task, []).current.endsWith(task.description));
});

test("the worker brief resolves declared edit targets inside the epic checkout", () => {
  const base = resolve("example-project");
  const checkout = resolve("owned-epics", "authentication");
  const target = join(checkout, "src", "login.ts");
  for (const declared of ["src/login.ts", join(base, "src", "login.ts"), target]) {
    const brief = workerCheckoutBrief(checkout, base, [declared]);
    assert.ok(brief.includes(`Source checkout: ${checkout}`));
    assert.ok(brief.includes(`Declared source scope:\n${target}`));
    assert.match(brief, /file::.*coordination identifiers/);
    assert.ok(!brief.includes(join(base, "src", "login.ts")));
  }
  const outside = resolve("another-project", "other.ts");
  assert.ok(!workerCheckoutBrief(checkout, base, [outside, "../other.ts"]).includes(outside));
});

test("host-owned evidence presents file keys and recalled paths in the editable epic checkout", () => {
  const base = resolve("shared QA [base]");
  const checkout = join(base, ".worktrees", "epic");
  const target = join("src", "average.js");
  const engineEvidence = {
    scope: [`file::${join(base, target)}`, "opaque-symbol-id", `file::${join(checkout, target)}`],
    recalled: JSON.stringify({ workspace_scope: base }),
    sibling: `${base}-other`,
  };
  const canonical = structuredClone(engineEvidence);
  const presented = JSON.parse(workerContextForPrompt(engineEvidence, checkout, base));
  assert.deepEqual(presented.scope, [`file::${join(checkout, target)}`, "opaque-symbol-id", `file::${join(checkout, target)}`]);
  assert.equal(JSON.parse(presented.recalled).workspace_scope, checkout);
  assert.equal(presented.sibling, engineEvidence.sibling);
  assert.deepEqual(engineEvidence, canonical);
});

test("escaped Windows paths in a recalled decision map to the worker checkout", () => {
  const base = String.raw`C:\Users\QA Agent\project`, checkout = String.raw`D:\epics\story`;
  const recalled = JSON.stringify({ workspace_scope: base, target: String.raw`c:\users\qa agent\project\src\work.ts` });
  const presented = JSON.parse(workerContextForPrompt({ recalled }, checkout, base));
  assert.deepEqual(JSON.parse(presented.recalled), { workspace_scope: checkout, target: checkout + String.raw`\src\work.ts` });
});
