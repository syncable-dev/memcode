import { createHash } from "node:crypto";
import { applyPatch, parsePatch } from "diff";
import type {
  CodeReviewMetric,
  CodeReviewComparisonCoverage,
} from "../src/code-review";
import type { StoryReviewCapture } from "./code-review-snapshot";

type Json = Record<string, any>;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const pathKey = (value: string) => {
  const path = value.replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
};
const identity = (row: Json) => `${row.kind}:${row.scope_path || row.name}`;
const absent = (reason: string): CodeReviewMetric["comparison"] => ({
  status: "unavailable",
  reason,
});
const measured = (row: Json) => ({
  cognitive: number(row.cognitive_complexity),
  cyclomatic: number(row.complexity),
  nesting: number(row.max_nesting),
  maintainabilityIndex: number(row.maintainability_index),
  halsteadVolume: number(row.halstead_volume),
});
function rows(value: Json, content: string, path: string): Json[] {
  if (value._workflow !== "immutable_source_quality_v1")
    throw Error(
      "This engine does not support immutable source comparisons yet.",
    );
  if (
    value.source_sha256 !== digest(content) ||
    value.source_bytes !== Buffer.byteLength(content) ||
    pathKey(value.file_path ?? "") !== pathKey(path)
  )
    throw Error(
      "The source measurement did not match the captured bytes and path.",
    );
  if (
    !Number.isInteger(value.metrics_version) ||
    value.metrics_version < 1 ||
    !Number.isInteger(value.quality_metrics_version) ||
    value.quality_metrics_version < 1 ||
    !Array.isArray(value.functions) ||
    value.functions.length > 512 ||
    value.matches !== value.functions.length ||
    value.truncated !== false
  )
    throw Error(
      "The engine did not provide complete, versioned source-function coverage.",
    );
  for (const row of value.functions) {
    if (
      !row ||
      typeof row !== "object" ||
      !["Function", "Method"].includes(row.kind) ||
      pathKey(row.file_path ?? "") !== pathKey(path) ||
      typeof row.name !== "string" ||
      !row.name ||
      (row.scope_path !== null &&
        row.scope_path !== undefined &&
        typeof row.scope_path !== "string") ||
      !Number.isInteger(row.start_line) ||
      row.start_line < 1 ||
      !Number.isInteger(row.end_line) ||
      row.end_line < row.start_line ||
      row.metrics_v !== value.metrics_version
    )
      throw Error("The engine returned an invalid source declaration.");
  }
  return value.functions;
}
function changedLines(patch: ReturnType<typeof parsePatch>[number]) {
  const before = new Set<number>(),
    after = new Set<number>();
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart,
      newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("-")) before.add(oldLine++);
      else if (line.startsWith("+")) after.add(newLine++);
      else if (line.startsWith(" ")) {
        oldLine++;
        newLine++;
      }
    }
  }
  return { before, after };
}
const touched = (row: Json, lines: Set<number>) =>
  [...lines].some((line) => line >= row.start_line && line <= row.end_line);
const grouped = (values: Json[]) => {
  const groups = new Map<string, Json[]>();
  for (const row of values)
    groups.set(identity(row), [...(groups.get(identity(row)) ?? []), row]);
  return groups;
};

/** Parse both exact captured sides with the same native AST parser. No checkout or graph mutation. */
export async function compareCapturedQuality(
  capture: StoryReviewCapture,
  metrics: CodeReviewMetric[],
  call: (name: string, args: Json) => Promise<Json>,
  scope: Json,
  supported = true,
): Promise<{
  metrics: CodeReviewMetric[];
  coverage: CodeReviewComparisonCoverage;
}> {
  const result = metrics.map((metric) => ({
    ...metric,
    comparison: absent(
      "No immutable baseline measurement is available for this function.",
    ),
  }));
  const allFiles = capture.snapshot.files.filter((file) =>
    Object.hasOwn(capture.baseFiles, file.path),
  );
  const files = allFiles.slice(0, 24);
  const coverage: CodeReviewComparisonCoverage = {
    filesMeasured: 0,
    filesUnavailable: 0,
    omittedFiles: allFiles.length - files.length,
    omittedFunctions: 0,
    notes: [],
  };
  const notes = new Set<string>();
  const finish = () => {
    if (coverage.omittedFiles)
      notes.add(
        `${coverage.omittedFiles} additional files were outside the 24-file comparison budget.`,
      );
    if (coverage.omittedFunctions)
      notes.add(
        `${coverage.omittedFunctions} additional changed declarations were outside the 24-function comparison budget.`,
      );
    coverage.notes = [...notes].slice(0, 16);
    return { metrics: result, coverage };
  };
  if (!supported) {
    coverage.filesUnavailable = files.length;
    notes.add("This engine does not support immutable source comparisons yet.");
    return {
      ...finish(),
      metrics: result.map((metric) => ({
        ...metric,
        comparison: absent(
          "This engine does not support immutable source comparisons yet.",
        ),
      })),
    };
  }
  let patches: ReturnType<typeof parsePatch>;
  try {
    patches = parsePatch(capture.patch);
  } catch {
    coverage.filesUnavailable = files.length;
    notes.add("The captured patch could not be decoded for comparison.");
    return finish();
  }
  let unsupported = false;
  for (const file of files) {
    const existing = result.filter(
      (metric) => pathKey(metric.path) === pathKey(file.path),
    );
    if (unsupported) {
      coverage.filesUnavailable++;
      for (const metric of existing)
        metric.comparison = absent(
          "This engine does not support immutable source comparisons yet.",
        );
      continue;
    }
    try {
      const matches = patches.filter((patch) =>
        [patch.oldFileName, patch.newFileName].some(
          (path) => path?.replace(/^[ab]\//, "") === file.path,
        ),
      );
      if (matches.length !== 1)
        throw Error("The captured file patch could not be resolved uniquely.");
      const patch = matches[0],
        before = capture.baseFiles[file.path];
      const after = applyPatch(before, patch, { fuzzFactor: 0 });
      if (after === false)
        throw Error(
          "The captured patch did not apply exactly to its baseline.",
        );
      const beforeHash = digest(before),
        afterHash = digest(after);
      const expectedBefore = file.projection?.baselineHash ?? file.beforeHash;
      const expectedAfter = file.projection?.currentHash ?? file.afterHash;
      if (
        (before && !/^[a-f0-9]{64}$/.test(expectedBefore ?? "")) ||
        (after && !/^[a-f0-9]{64}$/.test(expectedAfter ?? ""))
      )
        throw Error(
          "The captured comparison is missing an immutable source hash.",
        );
      if (
        (expectedBefore && expectedBefore !== beforeHash) ||
        (expectedAfter && expectedAfter !== afterHash)
      )
        throw Error(
          "The captured comparison content no longer matches its immutable hashes.",
        );
      const oldAnswer = await call("get_function_quality_metrics", {
        ...scope,
        function_name: "*",
        file_path: file.path,
        source_content: before,
      });
      if (oldAnswer._workflow !== "immutable_source_quality_v1") {
        unsupported = true;
        throw Error(
          "This engine does not support immutable source comparisons yet.",
        );
      }
      const oldRows = rows(oldAnswer, before, file.path);
      const newAnswer = await call("get_function_quality_metrics", {
        ...scope,
        function_name: "*",
        file_path: file.path,
        source_content: after,
      });
      const newRows = rows(newAnswer, after, file.path);
      if (
        oldAnswer.metrics_version !== newAnswer.metrics_version ||
        oldAnswer.quality_metrics_version !== newAnswer.quality_metrics_version
      )
        throw Error(
          "Before and after were measured with different metric definitions.",
        );
      coverage.filesMeasured++;
      const oldGroups = grouped(oldRows),
        newGroups = grouped(newRows),
        changes = changedLines(patch);
      const ids = new Set([
        ...oldRows.filter((row) => touched(row, changes.before)).map(identity),
        ...newRows.filter((row) => touched(row, changes.after)).map(identity),
      ]);
      const hasAdded = [...ids].some(
        (id) => !oldGroups.has(id) && newGroups.has(id),
      );
      const hasRemoved = [...ids].some(
        (id) => oldGroups.has(id) && !newGroups.has(id),
      );
      for (const id of ids) {
        const oldGroup = oldGroups.get(id) ?? [],
          newGroup = newGroups.get(id) ?? [];
        const oldRow = oldGroup.length === 1 ? oldGroup[0] : undefined;
        const newRow = newGroup.length === 1 ? newGroup[0] : undefined;
        const symbol = String(
          newRow?.scope_path ||
            newRow?.name ||
            oldRow?.scope_path ||
            oldRow?.name ||
            id.slice(id.indexOf(":") + 1),
        );
        let metric = existing.find((row) => row.symbol === symbol);
        if (!metric && result.length >= 24) {
          coverage.omittedFunctions++;
          continue;
        }
        const duplicate = oldGroup.length > 1 || newGroup.length > 1;
        const renamed =
          !duplicate && (!oldRow || !newRow) && hasAdded && hasRemoved;
        const comparison: NonNullable<CodeReviewMetric["comparison"]> = {
          status:
            duplicate || renamed
              ? "ambiguous"
              : oldRow && newRow
                ? "matched"
                : oldRow
                  ? "removed"
                  : "added",
          beforeSourceHash: beforeHash,
          afterSourceHash: afterHash,
          metricsVersion: oldAnswer.metrics_version,
          qualityMetricsVersion: oldAnswer.quality_metrics_version,
          ...(duplicate
            ? {
                reason:
                  "More than one declaration has this exact scope and kind; no baseline was guessed.",
              }
            : renamed
              ? {
                  reason:
                    "Declarations were added and removed in this file. A rename or replacement cannot be paired safely.",
                }
              : {}),
        };
        if (!metric) {
          metric = {
            symbol,
            path: file.path,
            cognitive: null,
            cyclomatic: null,
            nesting: null,
            source: "unavailable",
            comparison,
          };
          result.push(metric);
        }
        metric.comparison = comparison;
        if (duplicate) continue;
        if (newRow) {
          Object.assign(metric, measured(newRow), {
            line: newRow.start_line,
            source: newRow.complexity_source === "ast" ? "ast" : "unavailable",
          });
        } else {
          Object.assign(metric, {
            cognitive: null,
            cyclomatic: null,
            nesting: null,
            maintainabilityIndex: null,
            halsteadVolume: null,
            source: oldRow?.complexity_source === "ast" ? "ast" : "unavailable",
          });
        }
        if (oldRow)
          metric.before = { ...measured(oldRow), line: oldRow.start_line };
        if (
          (oldRow && oldRow.complexity_source !== "ast") ||
          (newRow && newRow.complexity_source !== "ast")
        ) {
          metric.comparison = {
            ...comparison,
            status: "unavailable",
            reason:
              "The native parser did not report AST metrics for both declarations.",
          };
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      coverage.filesUnavailable++;
      notes.add(`${file.path}: ${message.slice(0, 300)}`);
      if (
        /no function named ['"]?\*|unknown field.*source_content/i.test(message)
      )
        unsupported = true;
      for (const metric of existing)
        metric.comparison = absent(
          unsupported
            ? "This engine does not support immutable source comparisons yet."
            : message,
        );
    }
  }
  return finish();
}
