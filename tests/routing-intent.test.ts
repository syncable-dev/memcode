import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeRoutingIntent } from "../runtime/routing-intent.ts";

test("an explanation can mention changes without requesting an edit", () => {
  const result = analyzeRoutingIntent({
    title: "Explain how to rename the public API",
    description: "Please trace `planRoute` in `runtime/router.ts:143:5`.",
    kind: "feature",
  });
  assert.deepEqual(result.signals, {
    kinds: ["explain", "research"],
    readOnly: true,
    fileScopeOnly: false,
    preserveBehavior: false,
    publicContract: "unspecified",
  });
  assert.deepEqual(result.references.paths, [
    { file: "runtime/router.ts", line: 143, column: 5 },
  ]);
  assert.deepEqual(result.references.symbols, ["planRoute"]);
  assert.match(result.searchQuery, /runtime\/router\.ts planRoute/);
});

test("mixed requests carry the external contract and local scope separately", () => {
  const result = analyzeRoutingIntent({
    title: "Rename the exported function `getRoute`",
    description:
      "Only edit `./runtime\\router.ts`. Add tests, then explain the compatibility impact. Preserve behavior.",
  });
  assert.deepEqual(result.signals, {
    kinds: ["rename", "implement", "test", "explain"],
    readOnly: false,
    fileScopeOnly: true,
    preserveBehavior: true,
    publicContract: "change",
  });
  assert.deepEqual(result.references.paths, [{ file: "runtime/router.ts" }]);
});

test("negated edits and action words inside literal errors do not become requests", () => {
  const result = analyzeRoutingIntent({
    title: "Investigate the error “Rename public API failed”",
    description:
      "Do not fix or change the API. Don’t add tests; just check `useRoute`.",
  });
  assert.deepEqual(result.signals.kinds, ["research"]);
  assert.equal(result.signals.readOnly, true);
  assert.equal(result.signals.publicContract, "preserve");
  assert.deepEqual(result.references.errors, ["Rename public API failed"]);
  assert.deepEqual(result.references.symbols, ["useRoute"]);
});

test("exact local references are bounded and do not include absolute or remote paths", () => {
  const result = analyzeRoutingIntent({
    title: "Fix runtime/router.ts:143 and README.md.",
    description: [
      "Compare `runtime/router.ts:143` with `src/Quality views/Graph.tsx#L7` and Dockerfile.",
      "Look at function planRoute and formatRoute().",
      "Ignore `../other/file.ts`, /tmp/Root.ts, `C:\\Users\\Example\\private.ts` and https://example.test/src/Remote.ts.",
    ].join("\n"),
  });
  assert.deepEqual(result.references.paths, [
    { file: "runtime/router.ts", line: 143 },
    { file: "src/Quality views/Graph.tsx", line: 7 },
    { file: "README.md" },
    { file: "Dockerfile" },
  ]);
  assert.deepEqual(result.references.symbols, ["planRoute", "formatRoute"]);
  assert.doesNotMatch(result.searchQuery, /private\.ts|Remote\.ts/);
});

test("a classified work item is a fallback and an unclassified fragment stays unknown", () => {
  const fragment = { title: "Latency of the local worker", description: "" };
  assert.deepEqual(analyzeRoutingIntent(fragment).signals.kinds, ["unknown"]);
  assert.equal(analyzeRoutingIntent(fragment).signals.readOnly, false);
  assert.deepEqual(
    analyzeRoutingIntent({ ...fragment, kind: "test" }).signals.kinds,
    ["test"],
  );
  const bounded = analyzeRoutingIntent({
    title: "Fix router.ts",
    description: Array.from(
      { length: 200 },
      (_, index) => `file${index}.ts`,
    ).join(" "),
  });
  assert.equal(bounded.references.paths.length, 8);
  assert.ok(bounded.searchQuery.length <= 1000);
});

test("preserves native diagnostic literals without claiming an edit scope", () => {
  const result = analyzeRoutingIntent({
    title: "Diagnose `ERR_INVALID_ARG_TYPE` and HTTP 409",
    description: 'The worker is failing with "Something broke" during upload.',
  });
  assert.deepEqual(result.references.errors, [
    "ERR_INVALID_ARG_TYPE",
    "Something broke",
    "HTTP 409",
  ]);
  assert.deepEqual(result.references.symbols, []);
  assert.equal(result.signals.fileScopeOnly, false);
  assert.equal(result.signals.readOnly, true);
});
