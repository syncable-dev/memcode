import assert from "node:assert/strict";

/** An explicit candidate replaces the old default, never the exact-source check. */
export function expectedEngineCommit(args) {
  const index = args.indexOf("--expected-engine-commit");
  const commit =
    index < 0 ? "6ec252fb65599d3a2aaae8df7daf5ae934c6a58a" : args[index + 1];
  assert.ok(
    typeof commit === "string" && /^[a-f0-9]{40}$/.test(commit),
    "--expected-engine-commit requires the complete reviewed Git commit.",
  );
  return commit;
}
