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
function measured(row?: Json) {
  const native = row?.complexity_source === "ast" ? row : undefined;
  return {
    cognitive: number(native?.cognitive_complexity),
    cyclomatic: number(native?.complexity),
    nesting: number(native?.max_nesting),
    maintainabilityIndex: number(native?.maintainability_index),
    halsteadVolume: number(native?.halstead_volume),
  };
}
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
  if (value.truncated === true)
    throw Error(
      "The engine truncated the source declarations. Complete function coverage could not be verified.",
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
function touched(row: Json, lines: Set<number>) {
  for (const line of lines)
    if (line >= row.start_line && line <= row.end_line) return true;
  return false;
}
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
  let fallback = metrics.map((metric) => ({
    ...metric,
    comparison: absent(
      "No immutable baseline measurement is available for this function.",
    ),
  }));
  const captured: CodeReviewMetric[] = [];
  const allFiles = capture.snapshot.files.filter((file) =>
    Object.hasOwn(capture.baseFiles, file.path),
  );
  const missingSources = capture.snapshot.files.length - allFiles.length;
  const files = allFiles.slice(0, 24);
  const coverage: CodeReviewComparisonCoverage = {
    filesMeasured: 0,
    filesUnavailable: missingSources,
    omittedFiles: allFiles.length - files.length,
    omittedFunctions: 0,
    notes: [],
  };
  const notes = new Set<string>();
  const finish = () => {
    const summary: string[] = [];
    if (missingSources)
      summary.push(
        `Captured source was unavailable for ${missingSources} changed ${missingSources === 1 ? "file" : "files"}.`,
      );
    if (coverage.omittedFiles)
      summary.push(
        `${coverage.omittedFiles} additional files were outside the 24-file comparison budget.`,
      );
    coverage.notes = [...summary, ...notes].slice(0, 16);
    return { metrics: [...captured, ...fallback], coverage };
  };
  if (!supported) {
    coverage.filesUnavailable += files.length;
    notes.add("This engine does not support immutable source comparisons yet.");
    return {
      ...finish(),
      metrics: fallback.map((metric) => ({
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
    coverage.filesUnavailable += files.length;
    notes.add("The captured patch could not be decoded for comparison.");
    return finish();
  }
  let unsupported = false;
  for (const file of files) {
    const existing = fallback.filter(
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
      const changedOld = oldRows.filter((row) => touched(row, changes.before));
      const changedNew = newRows.filter((row) => touched(row, changes.after));
      const ids = new Set([...changedNew, ...changedOld].map(identity));
      const hasAdded = changedNew.some((row) => !oldGroups.has(identity(row)));
      const hasRemoved = changedOld.some(
        (row) => !newGroups.has(identity(row)),
      );

      // Immutable declarations supersede graph rows for this file, including
      // unchanged context. Preserve unresolved graph lookups as fallbacks.
      const names = new Set(
        [...oldRows, ...newRows].map((row) => row.scope_path || row.name),
      );
      fallback = fallback.filter(
        (row) =>
          pathKey(row.path) !== pathKey(file.path) || !names.has(row.symbol),
      );
      const evidence = {
        beforeSourceHash: beforeHash,
        afterSourceHash: afterHash,
        metricsVersion: oldAnswer.metrics_version,
        qualityMetricsVersion: oldAnswer.quality_metrics_version,
      };
      function addMeasurement(
        oldRow: Json | undefined,
        newRow: Json | undefined,
        status: NonNullable<CodeReviewMetric["comparison"]>["status"],
        reason?: string,
      ) {
        const row = newRow ?? oldRow!;
        const symbol = row.scope_path || row.name;
        const source = row.complexity_source === "ast" ? "ast" : "unavailable";
        const baselineSource =
          oldRow?.complexity_source === "ast" ? "ast" : "unavailable";
        const graphRow =
          newRow &&
          existing.find(
            (item) => item.symbol === symbol && item.line === newRow.start_line,
          );
        if (
          status === "matched" &&
          (source !== "ast" || baselineSource !== "ast")
        ) {
          status = "unavailable";
          reason =
            "The native parser did not report AST metrics for both declarations.";
        }
        captured.push({
          symbol,
          path: file.path,
          source,
          ...measured(newRow),
          ...(newRow ? { line: newRow.start_line } : {}),
          ...(graphRow?.riskLevel ? { riskLevel: graphRow.riskLevel } : {}),
          ...(oldRow
            ? {
                before: {
                  ...measured(oldRow),
                  source: baselineSource,
                  line: oldRow.start_line,
                },
              }
            : {}),
          comparison: { ...evidence, status, ...(reason ? { reason } : {}) },
        });
      }
      for (const id of ids) {
        const oldGroup = oldGroups.get(id) ?? [];
        const newGroup = newGroups.get(id) ?? [];
        if (oldGroup.length > 1 || newGroup.length > 1) {
          // Even when overloads share a scope, each changed occurrence has
          // its own measurements. Keep the sides independent.
          const reason =
            "Multiple declarations share this scope and kind. The changed occurrences are shown separately.";
          for (const row of newGroup.filter((row) =>
            touched(row, changes.after),
          ))
            addMeasurement(undefined, row, "ambiguous", reason);
          for (const row of oldGroup.filter((row) =>
            touched(row, changes.before),
          ))
            addMeasurement(row, undefined, "ambiguous", reason);
        } else if (oldGroup.length && newGroup.length) {
          addMeasurement(oldGroup[0], newGroup[0], "matched");
        } else if (hasAdded && hasRemoved) {
          addMeasurement(
            oldGroup[0],
            newGroup[0],
            "ambiguous",
            "Declarations were added and removed in this file. A rename or replacement cannot be paired safely.",
          );
        } else {
          addMeasurement(
            oldGroup[0],
            newGroup[0],
            newGroup.length ? "added" : "removed",
          );
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
