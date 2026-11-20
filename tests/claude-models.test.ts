import test from "node:test";
import assert from "node:assert/strict";
import { claudeCatalog, claudeModelLabel } from "../runtime/agents/claude-models";

test("Claude aliases display the installed account's resolved version", () => {
  const [opus, sonnet] = claudeCatalog([
    { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5-5" },
    { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5-2" },
  ]);
  assert.equal(opus.label, "Opus 5.5");
  assert.equal(sonnet.label, "Sonnet 5.2");
  assert.equal(opus.id, "opus");
  assert.equal(opus.resolvedId, "claude-opus-5-5");
});

test("unknown Claude versions are never invented and existing variant labels survive", () => {
  assert.equal(claudeModelLabel("opus", "Opus"), "Opus");
  assert.equal(claudeModelLabel("opus", "Opus 4.8 · Extended", "claude-opus-4-8"), "Opus 4.8 · Extended");
  assert.equal(claudeModelLabel("haiku", "Haiku", "claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(claudeModelLabel("opus", "Opus", "unrecognized-provider-version"), "Opus");
});
