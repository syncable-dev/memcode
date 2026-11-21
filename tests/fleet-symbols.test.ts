import { test } from "node:test";
import assert from "node:assert/strict";
import { engineIntent, fileOf, symbolIdentity } from "../runtime/fleet-symbols.ts";
import { breaksCallers, changeKinds, onlyAdds } from "../src/fleet.ts";

const roots = {
  workspace: "/work/goal",
  project: { path: "/repo/acme", repoId: "acme" },
};
const identity = (raw: string) => symbolIdentity(raw, roots);

test("a symbol is named by its file and its name, however the worker wrote the path", () => {
  for (const written of [
    "src/cart.js::cartTotal",
    "./src/cart.js::cartTotal",
    " src\\cart.js :: cartTotal ",
    "/work/goal/src/cart.js::cartTotal",
    "/repo/acme/src/cart.js::cartTotal",
    "acme/src/cart.js::cartTotal",
  ])
    assert.equal(identity(written), "src/cart.js::cartTotal", written);
  assert.equal(identity("src/cart.js::Cart::total"), "src/cart.js::Cart::total", "a member keeps its owner");
});

test("a file changed as a whole is named by its path alone", () => {
  assert.equal(identity("README.md"), "README.md");
  assert.equal(identity("/work/goal/docs/guide.md"), "docs/guide.md");
  assert.equal(fileOf("docs/guide.md"), "docs/guide.md");
  assert.equal(fileOf("src/cart.js::Cart::total"), "src/cart.js");
});

test("a bare symbol name is refused, saying how to write it", () => {
  assert.throws(() => identity("cartTotal"), /file::cartTotal/);
});

test("a path outside the project is refused", () => {
  assert.throws(() => identity("../other/cart.js::cartTotal"), /outside/);
  assert.throws(() => identity("/etc/hosts"), /outside/);
});

test("only a signature change, a move or a removal can break another worker's edit", () => {
  assert.deepEqual(
    changeKinds.filter(breaksCallers),
    ["signature", "move", "remove"],
  );
  assert.deepEqual(changeKinds.filter(onlyAdds), ["add", "docs", "test"]);
});

test("each kind of change is declared to Fleet as its typed intent", () => {
  const symbols = ["src/cart.js::cartTotal"];
  assert.deepEqual(engineIntent("add", symbols), { feature_add: { surface: "new_symbol" } });
  assert.deepEqual(engineIntent("change", symbols), { bug_fix: { defect: "logic_error" } });
  assert.deepEqual(engineIntent("fix", symbols), { bug_fix: { defect: "logic_error" } });
  assert.deepEqual(engineIntent("rename", symbols), { refactor: { pattern: "rename_symbol" } });
  assert.deepEqual(engineIntent("signature", symbols), { refactor: { pattern: "change_signature" } });
  assert.deepEqual(engineIntent("move", symbols), { refactor: { pattern: "move_symbol" } });
  assert.deepEqual(engineIntent("remove", symbols), { cleanup: { kind: "dead_code" } });
  assert.deepEqual(engineIntent("format", symbols), { cleanup: { kind: "format_only" } });
  assert.deepEqual(engineIntent("test", symbols), { test_add: { covers: symbols } });
  assert.equal(engineIntent("docs", symbols), "docs_only");
});

test("edits that overlapped in time are independent, compatible after a re-read, or a real disagreement", async () => {
  const { conflictClass } = await import("../runtime/fleet-classes.ts");
  const nobody: boolean[] = [];
  const peerEditing = [false];
  const peerBreaking = [true];
  assert.equal(conflictClass("signature", nobody), "A", "nobody else was on the symbol");
  assert.equal(conflictClass("fix", peerEditing), "B");
  assert.equal(conflictClass("rename", peerEditing), "B");
  assert.equal(conflictClass("signature", peerEditing), "C", "this change breaks the peer's edit");
  assert.equal(conflictClass("fix", peerBreaking), "C", "the peer's change breaks this edit");
  assert.equal(conflictClass("add", peerBreaking), "B", "an addition never conflicts");
  assert.equal(conflictClass("fix", [false, true, false]), "C");
});
