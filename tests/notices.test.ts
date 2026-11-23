import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import { tellPerson } from "../runtime/notices";
import { unseenNotices } from "../src/notices";

test("MemCode keeps the newest five things it told the person", () => {
  const state = initialState();
  for (let n = 1; n <= 7; n++) tellPerson(state, `notice ${n}`, `2026-11-23T10:0${n}:00Z`);
  assert.deepEqual(state.notices?.map((notice) => notice.text), [
    "notice 3",
    "notice 4",
    "notice 5",
    "notice 6",
    "notice 7",
  ]);
});

test("the window shows each notice once", () => {
  const state = initialState();
  tellPerson(state, "first");
  tellPerson(state, "second");
  const [first] = state.notices!;
  assert.deepEqual(
    unseenNotices(state.notices, new Set([first.id])).map((notice) => notice.text),
    ["second"],
  );
  assert.deepEqual(unseenNotices(undefined, new Set()), []);
});
