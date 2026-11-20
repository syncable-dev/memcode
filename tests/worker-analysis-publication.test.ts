import test from "node:test";
import assert from "node:assert/strict";
import { prepareWorkerAnalysis } from "../runtime/worker-analysis";
import { SourcePublicationChanged } from "../runtime/memtrace-peer-index";
import type { Project, WorkItem } from "../src/shared";

const project = {
  id: "source",
  path: "/repo",
  branch: "epic/shared",
  analysisCurrentSource: true,
} as Project;
const task = {} as WorkItem;
const options = () => ({
  changedBranch: false,
  update: (_note: string) => {},
  signal: new AbortController().signal,
});
const engine = (
  analyze: Parameters<typeof prepareWorkerAnalysis>[0]["analyze"],
) => ({
  analyze,
  call: async () => {
    throw Error("unexpected source mutation");
  },
  watch: async () => {
    throw Error("unexpected repair");
  },
  releaseEpic: async () => {},
});

test("worker preparation follows peer saves by asking ordinary analysis for a fresh certificate", async () => {
  let calls = 0;
  const progress: string[] = [];
  const repoId = await prepareWorkerAnalysis(
    engine(async (p, _update, force) => {
      assert.equal(p, project);
      assert.equal(force, false);
      if (++calls === 1) throw new SourcePublicationChanged("peer save");
      return "certified-current-source";
    }),
    project,
    task,
    { ...options(), update: (note) => progress.push(note) },
  );
  assert.equal(repoId, "certified-current-source");
  assert.equal(calls, 2);
  assert.match(progress.join(" "), /Another Fleet worker updated/);
});

test("primary analysis, foreign bindings and arbitrary failures are never retried as peer saves", async () => {
  for (const [p, error] of [
    [
      { ...project, analysisCurrentSource: undefined },
      new SourcePublicationChanged("primary changed"),
    ],
    [project, Error("different checkout")],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      prepareWorkerAnalysis(
        engine(async () => {
          calls++;
          throw error;
        }),
        p,
        task,
        options(),
      ),
      error,
    );
    assert.equal(calls, 1);
  }
});

test("a stop during publication retry prevents another analysis request", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    prepareWorkerAnalysis(
      engine(async () => {
        calls++;
        throw new SourcePublicationChanged("peer save");
      }),
      project,
      task,
      {
        ...options(),
        signal: controller.signal,
        update: () => controller.abort(),
      },
    ),
    /abort/i,
  );
  assert.equal(calls, 1);
});

test("continuous peer saves have a bounded retry count and never waive publication", async () => {
  let calls = 0;
  await assert.rejects(
    prepareWorkerAnalysis(
      engine(async () => {
        calls++;
        throw new SourcePublicationChanged("still changing");
      }),
      project,
      task,
      options(),
    ),
    /still changing/,
  );
  assert.equal(calls, 8);
});
