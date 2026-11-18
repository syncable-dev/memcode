import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CodeReviewComparisonCoverage,
  CodeReviewMetric,
} from "../src/code-review";
import ReviewQualityComparison from "../src/components/ReviewQualityComparison";

const current = {
  cognitive: 0,
  cyclomatic: 3,
  nesting: 1,
  maintainabilityIndex: 70,
};
const baseline = {
  cognitive: 4,
  cyclomatic: 5,
  nesting: 2,
  maintainabilityIndex: 60,
};
const empty = {
  cognitive: null,
  cyclomatic: null,
  nesting: null,
  maintainabilityIndex: null,
};
const metric = (
  symbol: string,
  fields: Partial<CodeReviewMetric>,
): CodeReviewMetric => ({
  path: "src/functions.ts",
  symbol,
  line: 1,
  source: "ast",
  ...current,
  ...fields,
});
const render = (
  metrics: CodeReviewMetric[],
  coverage?: CodeReviewComparisonCoverage,
) =>
  renderToStaticMarkup(
    createElement(ReviewQualityComparison, {
      metrics,
      coverage,
      onOpenSource() {},
      onOpenChanges() {},
    }),
  );

test("all function rows show their available measurements even when just one declaration matched", () => {
  const metrics = [
    metric("matched", { before: baseline, comparison: { status: "matched" } }),
    metric("added", { comparison: { status: "added" } }),
    metric("removed", {
      ...empty,
      line: undefined,
      before: { ...baseline, line: 10 },
      comparison: { status: "removed" },
    }),
    metric("oldName", {
      ...empty,
      line: undefined,
      before: { ...baseline, line: 11, halsteadVolume: 0 },
      comparison: { status: "ambiguous" },
    }),
    metric("newName", { comparison: { status: "ambiguous" } }),
    ...Array.from({ length: 19 }, (_, n) => metric(`unpaired${n}`, {})),
  ];
  const html = render(metrics);
  const rows = html
    .split("<tbody>")[1]
    .split("</tbody>")[0]
    .match(/<tr>[\s\S]*?<\/tr>/g)!;
  assert.equal(rows.length, 24);
  assert.match(html, /24 functions/);
  assert.match(
    html,
    /1 matched · 1 added · 1 removed · 2 uncertain · 19 not compared/,
  );
  assert.match(html, /Halstead volume/);
  assert.match(rows[0], /Before 4, after 0/);
  assert.match(rows[1], /Before unavailable, after 0/);
  assert.match(rows[2], /Before 60, after unavailable/);
  assert.match(rows[3], /Before 0, after unavailable/);
  assert.match(rows[3], /View captured changes for oldName/);
  assert.match(rows[4], /Open current source for newName/);
  assert.match(rows[23], /unpaired18/);
  assert.match(rows[23], /Before unavailable, after 70/);
  assert.equal((html.match(/1 matched function · mean/g) ?? []).length, 4);
});

test("declaration counts stay independent of each metric’s paired mean and recorded omissions", () => {
  const html = render(
    [
      metric("cognitiveOnly", {
        before: { ...empty, cognitive: 2 },
        comparison: { status: "matched" },
      }),
      metric("nestingOnly", {
        before: { ...empty, nesting: 3 },
        comparison: { status: "matched" },
      }),
      ...Array.from({ length: 30 }, (_, n) =>
        metric(`addition${n}`, { comparison: { status: "added" } }),
      ),
    ],
    {
      filesMeasured: 1,
      filesUnavailable: 0,
      omittedFiles: 0,
      omittedFunctions: 2,
      notes: [],
    },
  );
  assert.match(html, /32 functions/);
  assert.match(html, /2 matched · 30 added/);
  assert.match(html, /This review omitted 2 additional functions/);
  assert.match(html, /addition29/);
  assert.equal((html.match(/1 matched function · mean/g) ?? []).length, 2);
});

test("unavailable scores stay distinct from measured zeroes when no comparisons exist", () => {
  const html = render([
    metric("estimated", { source: "estimated" }),
    metric("legacy", {}),
  ]);
  assert.match(html, /2 not compared/);
  assert.match(html, /Before unavailable, after unavailable/);
  assert.match(html, /Before unavailable, after 0/);
  assert.match(html, /No matched functions have measurements on both sides/);
  assert.doesNotMatch(html, /Matched function averages|Halstead volume/);
});
