import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Local developer script is intentionally a plain Node module.
import { expectedEngineCommit } from "../scripts/memtrace-local-checks/source-selection.mjs";

test("local native gates keep the original exact source by default", () => {
  assert.equal(
    expectedEngineCommit([]),
    "6ec252fb65599d3a2aaae8df7daf5ae934c6a58a",
  );
});
test("an explicitly reviewed candidate must be a complete immutable revision", () => {
  assert.equal(
    expectedEngineCommit([
      "--expected-engine-commit",
      "5addbb2fa5d36975f2bff2d79ac58b7d0e86cc63",
    ]),
    "5addbb2fa5d36975f2bff2d79ac58b7d0e86cc63",
  );
  for (const value of [
    undefined,
    "dev",
    "5addbb2",
    "a".repeat(39),
    "G".repeat(40),
    "HEAD;echo bad",
  ])
    assert.throws(
      () => expectedEngineCommit(["--expected-engine-commit", value]),
      /complete reviewed Git commit/,
    );
});
