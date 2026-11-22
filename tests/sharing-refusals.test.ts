import test from "node:test";
import assert from "node:assert/strict";
import {
  isRefusalRule,
  refusalRules,
  refusalSentences,
} from "../src/sharing-refusals";

// The table in MemSync's docs/08_crosscutting_concepts.md, as of 21 November 2026,
// and the four the Cards service added on 22 November (ADR-0014).
const namedByMemsync = [
  "no_such_project",
  "no_such_invitation",
  "no_such_guest",
  "only_the_owner_invites",
  "not_the_owner",
  "the_owner_cannot_leave",
  "guest_limit_reached",
  "already_on_project",
  "already_invited",
  "invitation_expired",
  "email_not_verified",
  "invalid_project_name",
  "invalid_email",
  "invalid_update_id",
  "empty_update",
  "update_too_large",
  "too_many_updates",
  "invalid_card_id",
  "file_too_large",
  "project_storage_full",
  "no_such_file",
];

test("every rule MemSync can refuse by is known by name", () => {
  assert.deepEqual([...refusalRules].sort(), [...namedByMemsync].sort());
  for (const rule of namedByMemsync) assert.equal(isRefusalRule(rule), true);
  assert.equal(isRefusalRule("a_rule_from_a_newer_memsync"), false);
  assert.equal(isRefusalRule(""), false);
});

test("every rule has one plain sentence of its own", () => {
  const sentences = refusalRules.map((rule) => refusalSentences[rule]);
  assert.equal(new Set(sentences).size, refusalRules.length);
  for (const sentence of sentences) {
    assert.match(sentence, /^[A-Z].*\.$/s, sentence);
    assert.doesNotMatch(
      sentence,
      /[a-z]_[a-z]/,
      "no rule names in " + sentence,
    );
    assert.doesNotMatch(
      sentence,
      /\b(gRPC|status|metadata|MemSync)\b/,
      sentence,
    );
    assert.ok(sentence.length <= 220, sentence);
  }
});

test("the sentences keep to the words of the product", () => {
  const all = Object.values(refusalSentences).join(" ");
  assert.doesNotMatch(all, /\bteam\b/i);
  assert.doesNotMatch(all, /\bPro\b|\bPro\+/);
});
