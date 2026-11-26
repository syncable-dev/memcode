import assert from "node:assert/strict";
import test from "node:test";
import {
  clockLabel,
  elapsedLabel,
  isAnalysisFailure,
  markAnalysisFailure,
  nextProgress,
  progressNote,
  readableDetail,
  reportFromEngineLine,
  reportFromJob,
  stepOfStage,
} from "../src/analysis-progress";
import { restartSafeState } from "../src/domain";
import { initialState } from "../src/seed";

test("each engine stage belongs to one step a person can follow", () => {
  assert.equal(stepOfStage("scan"), "reading");
  assert.equal(stepOfStage("parse"), "reading");
  assert.equal(stepOfStage("resolve"), "linking");
  assert.equal(stepOfStage("community"), "linking");
  assert.equal(stepOfStage("persist"), "saving");
  assert.equal(stepOfStage("finalizing"), "saving");
  assert.equal(stepOfStage("embedding"), "search");
  assert.equal(stepOfStage("pending"), "starting");
  assert.equal(stepOfStage("something new"), undefined);
  assert.equal(stepOfStage(undefined), undefined);
});

test("a line the engine prints while it indexes gives its step, percent and detail", () => {
  assert.deepEqual(
    reportFromEngineLine(
      "Memtrace · ◆  Indexing memcode — persist · Writing 23518 symbols and 116212 relationships · 88% · 21s",
    ),
    {
      step: "saving",
      percent: 88,
      detail: "Writing 23518 symbols and 116212 relationships",
    },
  );
  assert.deepEqual(reportFromEngineLine("◆  Indexing app — scan · Scanning repository files"), {
    step: "reading",
    detail: "Scanning repository files",
  });
  assert.deepEqual(
    reportFromEngineLine("◆  Indexing app — community · Louvain iteration 9/100 (22740 nodes) · 47% · 30s"),
    { step: "linking", percent: 47, detail: "Grouping related code · pass 9 of 100" },
  );
  assert.deepEqual(reportFromEngineLine("✓  [1/1] app indexed: 23518 nodes - 116212 edges  (96090 ms)"), {
    step: "saving",
    percent: 100,
    detail: "Mapped 23518 symbols and 116212 links",
  });
  assert.equal(reportFromEngineLine("◆  [1/1] Embedding + replaying: app")?.step, "search");
  // Other lines say nothing about the steps.
  assert.equal(reportFromEngineLine("Watcher ready on C:\\code\\app (dev)"), undefined);
  assert.equal(
    reportFromEngineLine("Preparing the local Memtrace engine · 12s elapsed. Recovery can take several minutes."),
    undefined,
  );
});

test("an engine job gives a measured share only when it counted both sides", () => {
  assert.deepEqual(
    reportFromJob({
      status: "running",
      stage: "embedding",
      message: "Generating embeddings",
      progress: { completed: 250, total: 1000, unit: "symbols" },
    }),
    {
      step: "search",
      done: 250,
      total: 1000,
      percent: 25,
      unit: "symbols",
      detail: "Generating embeddings",
    },
  );
  // An unknown total is not zero: no share is made up.
  assert.deepEqual(
    reportFromJob({
      status: "running",
      stage: "persist",
      message: "Writing 15 symbols",
      progress: { completed: 15, total: null, unit: "symbols" },
    }),
    { step: "saving", detail: "Writing 15 symbols" },
  );
  assert.deepEqual(reportFromJob({ status: "pending", stage: "queued?" }), { step: "starting" });
  assert.equal(reportFromJob({ status: "running", stage: "odd" }), undefined);
  assert.equal(reportFromJob(null), undefined);
});

test("progress keeps its start, and within a step what the engine said last", () => {
  const first = nextProgress(undefined, { step: "starting" }, "2026-11-26T10:00:00.000Z");
  assert.equal(first.startedAt, "2026-11-26T10:00:00.000Z");
  const reading = nextProgress(
    first,
    { step: "saving", percent: 40, detail: "Writing 10 symbols" },
    "2026-11-26T10:01:00.000Z",
  );
  assert.equal(reading.startedAt, first.startedAt);
  const again = nextProgress(reading, { step: "saving" }, "2026-11-26T10:01:05.000Z");
  assert.equal(again.percent, 40);
  assert.equal(again.detail, "Writing 10 symbols");
  // A new step does not carry the last one's numbers.
  const search = nextProgress(again, { step: "search" }, "2026-11-26T10:02:00.000Z");
  assert.equal(search.percent, undefined);
  assert.equal(search.detail, undefined);
  // After a stop, the next run starts its own clock.
  const restarted = nextProgress(
    { ...search, stoppedAt: "2026-11-26T10:03:00.000Z" },
    { step: "starting" },
    "2026-11-26T10:05:00.000Z",
  );
  assert.equal(restarted.startedAt, "2026-11-26T10:05:00.000Z");
  assert.equal(restarted.stoppedAt, undefined);
});

test("notes and times read the way people read them", () => {
  assert.equal(
    progressNote({ step: "saving", percent: 88, detail: "Writing 23518 symbols" }),
    `Saving the code map · 88% · Writing ${(23518).toLocaleString()} symbols`,
  );
  assert.equal(readableDetail("Writing 23518 symbols", "en-US"), "Writing 23,518 symbols");
  assert.equal(elapsedLabel(42_000), "42 s");
  assert.equal(elapsedLabel(185_000), "3 min 05 s");
  assert.equal(elapsedLabel(3_720_000), "1 h 02 min");
  assert.equal(clockLabel(42_000), "0:42");
  assert.equal(clockLabel(185_000), "3:05");
  assert.equal(clockLabel(3_729_000), "1:02:09");
});

test("a failed analysis is told apart from other errors", () => {
  const failure = markAnalysisFailure(new Error("Memtrace indexing job failed"));
  assert.equal(isAnalysisFailure(failure), true);
  assert.equal(isAnalysisFailure(new Error("Memtrace indexing job failed")), false);
  assert.equal(isAnalysisFailure("text"), false);
});

test("an analysis that was under way when MemCode closed drops its progress", () => {
  const state = initialState();
  state.projects[0] = {
    ...state.projects[0],
    analysis: "indexing",
    analysisProgress: {
      step: "saving",
      startedAt: "2026-11-26T10:00:00.000Z",
      updatedAt: "2026-11-26T10:00:05.000Z",
    },
  };
  const [project] = restartSafeState(state).projects;
  assert.equal(project.analysis, "idle");
  assert.equal(project.analysisProgress, undefined);
});
