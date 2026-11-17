import test from "node:test";
import assert from "node:assert/strict";
import { projectStoryContribution } from "../runtime/code-review-projection";

const original = [
  "// Shared file",
  "// Both stories coordinate through Fleet",
  "",
  "export function first() {",
  "  const result = 1;",
  "  return result;",
  "}",
  "",
  "// Independent area",
  "",
  "export function second() {",
  "  return 10;",
  "}",
  "",
].join("\n");
const own = original.replace("result = 1", "result = 2");

test("exact projection keeps a later peer edit in both sides of the review", () => {
  const current = own.replace("return 10", "return 20");
  const projection = projectStoryContribution(original, own, current);
  assert.equal(projection.ok, true);
  if (!projection.ok) return;
  assert.equal(projection.baseline, original.replace("return 10", "return 20"));
  assert.equal(projection.hunks, 1);
});

test("unique own hunks can move with a peer insertion; line numbers are never tie-breakers", () => {
  const current = "// Added by another story\n" + own;
  const projection = projectStoryContribution(original, own, current);
  assert.equal(projection.ok, true);
  if (projection.ok)
    assert.equal(projection.baseline, "// Added by another story\n" + original);
});

test("overlapping own changes and edited exact context are rejected", () => {
  for (const current of [
    own.replace("result = 2", "result = 3"),
    own.replace("return result", "return result + 1"),
  ]) {
    const projection = projectStoryContribution(original, own, current);
    assert.equal(projection.ok, false);
    if (!projection.ok) assert.match(projection.reason, /overlaps|context/);
  }
});

test("a duplicated after-context is rejected in the saved output or current source", () => {
  const block =
    "export function first() {\n  const result = 2;\n  return result;\n}\n";
  for (const after of [own, own + block]) {
    const current = own + block + "// Peer addition\n";
    const projection = projectStoryContribution(original, after, current);
    assert.equal(projection.ok, false);
    if (!projection.ok) assert.match(projection.reason, /unique|ambiguous/);
  }
});

test("duplicate context at BOF is still ambiguous rather than resolved by its old position", () => {
  const before = "before\nanchor\nremaining\n",
    after = "after\nanchor\nremaining\n";
  const projection = projectStoryContribution(
    before,
    after,
    after + "after\nanchor\n",
  );
  assert.equal(projection.ok, false);
});

test("separate own hunks preserve a peer edit between them", () => {
  const before =
    original +
    "\n// Long gap\n// More context\nexport const last = 0;\n// EOF\n";
  const after = before
    .replace("result = 1", "result = 2")
    .replace("last = 0", "last = 1");
  const current = after.replace("return 10", "return 20");
  const projection = projectStoryContribution(before, after, current);
  assert.equal(projection.ok, true);
  if (projection.ok) {
    assert.equal(projection.hunks, 2);
    assert.equal(projection.baseline, before.replace("return 10", "return 20"));
  }
});

test("exact insertion and deletion projections retain CRLF and missing final newline", () => {
  const before = original.replaceAll("\n", "\r\n").replace(/\r\n$/, "");
  for (const after of [
    before.replace(
      "  return result;",
      "  const extra = 3;\r\n  return result;",
    ),
    before.replace("  const result = 1;\r\n", ""),
  ]) {
    const current = after.replace("return 10", "return 20");
    const projection = projectStoryContribution(before, after, current);
    assert.equal(projection.ok, true);
    if (projection.ok)
      assert.equal(
        projection.baseline,
        before.replace("return 10", "return 20"),
      );
  }
});

test("missing anchors, binary content, huge diffs and EOF context changes fail closed", () => {
  for (const [before, after, current] of [
    ["entire old file\n", "", "peer content\n"],
    [original, own, own.replaceAll("\n", "\r\n")],
    [original, own, own + "\0"],
    ["a\n".repeat(50001), "b\n", "peer\n"],
    ["first\nold\n", "first\nnew\n", "first\nnew\npeer\n"],
  ])
    assert.equal(projectStoryContribution(before, after, current).ok, false);
});
