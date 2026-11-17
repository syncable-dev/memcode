import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, WorkItem } from "../src/shared";
import type { StoryReviewCapture } from "../runtime/code-review-snapshot";
import type { ReadonlyReviewAgent } from "../runtime/review-agent";
import { initialState } from "../src/seed";
import { CodeReviewManager } from "../runtime/code-review";
import { epicAnalysisProject } from "../runtime/epic-checkout";
import { WorkerManager } from "../runtime/workers";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Review did not reach the expected state.");
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "memcode-review-concurrency-")),
    state = initialState();
  state.settings.maxWorkers = 2;
  state.tasks = [];
  state.reviewWorkflows = {};
  const project: Project = {
    id: "p",
    name: "Project",
    description: "",
    path: join(dir, "canonical"),
    branch: "main",
    repoId: "canonical",
    analysis: "ready",
    createdAt: new Date().toISOString(),
  };
  state.projects = [project];
  const bindings = new Map<string, string>(),
    starting = new Set<string>(),
    captures: string[] = [],
    prepared: string[] = [],
    retired: string[] = [],
    calls: string[] = [],
    fixes: string[] = [];
  const add = (id: string, epic = "a") => {
    const root = join(dir, epic),
      binding = `source-${epic}-1`;
    bindings.set(root, binding);
    const task: WorkItem = {
      id,
      projectId: "p",
      epicId: epic,
      identifier: id,
      title: id,
      description: "",
      stage: "review",
      priority: "medium",
      category: "Work",
      harness: "codex",
      checklist: [],
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      changesRevision: `changes-${id}`,
      run: {
        state: "finished",
        workspace: root,
        branch: `epic/${epic}`,
        analysisProjectId: `owned-${epic}`,
        analysisRepoId: `repo-${epic}`,
        changeRunId: `implementation-${id}`,
        finishedSourceBinding: binding,
        checks: {
          runId: `implementation-${id}`,
          revision: `changes-${id}`,
          sessionId: `check-${id}`,
          passed: 1,
          failed: 0,
          exitCode: 0,
          linked: true,
          timedOut: false,
          source: "memcode_check",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      },
    };
    state.tasks.push(task);
    return task;
  };
  const a = add("a"),
    aPeer = add("a-peer"),
    b = add("b", "b"),
    c = add("c", "c");
  let intercept:
    ((project: Project, name: string) => Promise<void>) | undefined;
  const meta = {
    graph_revision: {
      token: "publication",
      publication_unchanged_during_call: true,
    },
  };
  const engine = {
    call: async (
      selected: Project,
      name: string,
      args: Record<string, any>,
    ) => {
      calls.push(`${selected.id}:${name}`);
      await intercept?.(selected, name);
      const evidence = { _meta: meta };
      if (name === "get_query_revision")
        return {
          ...evidence,
          ready: true,
          repo_id: selected.repoId,
          branch: selected.branch,
          worktree: selected.path,
          checkout_mode: "owned-worktree-v1",
          scope: "owned_worktree_graph",
          token: "query",
          source_revision: bindings.get(selected.path!),
          source_unchanged_during_observation: true,
        };
      if (name === "find_code_review_issues")
        return {
          ...evidence,
          _workflow: "deterministic_code_review",
          _policy: "memtrace_review_confidence_v1",
          _review_mode: "online",
          _graph_state: "ready",
          issues: [],
        };
      const path =
        [...(args.diff?.matchAll(/\+\+\+ b\/(.+)/g) ?? [])][0]?.[1] ??
        `${state.tasks.find((t) => t.run.analysisProjectId === selected.id)!.id}.ts`;
      if (name === "detect_changes")
        return {
          ...evidence,
          changed_files: [
            {
              file_path: path,
              matched: true,
              affected_symbols: [
                { id: path, name: "main", kind: "Function", start_line: 1 },
              ],
            },
          ],
        };
      if (name === "get_function_quality_metrics")
        return {
          ...evidence,
          matches: 1,
          function: {
            name: "main",
            file_path: args.file_path,
            start_line: 1,
            complexity: 2,
            cognitive_complexity: 1,
            max_nesting: 1,
            complexity_source: "ast",
            quality_metrics_v: 1,
            maintainability_index: 80,
          },
        };
      if (name === "get_impact")
        return {
          ...evidence,
          found: true,
          risk: "LOW",
          truncated: false,
          total_affected: 0,
          by_depth: {},
          affected_files: [],
          affected_processes: [],
        };
      throw Error(`Unexpected ${name}`);
    },
  };
  const capture = async (task: WorkItem): Promise<StoryReviewCapture> => {
    captures.push(task.id);
    assert.equal(
      state.tasks.some(
        (t) =>
          t.run.analysisProjectId === task.run.analysisProjectId &&
          ["preparing", "running", "stopping"].includes(t.run.state),
      ),
      false,
      "Never capture source while an epic worker edits",
    );
    return {
      snapshot: {
        id: `snapshot-${captures.length}`,
        patchHash: `patch-${captures.length}`,
        journalRevision: task.changesRevision!,
        branch: task.run.branch!,
        commit: null,
        sourceRevision: null,
        graphRevision: null,
        files: [
          {
            path: `${task.id}.ts`,
            beforeHash: "before",
            afterHash: "after",
            attribution: "reservation",
          },
        ],
        additions: 1,
        deletions: 1,
      },
      patch: `diff --git a/${task.id}.ts b/${task.id}.ts\n--- a/${task.id}.ts\n+++ b/${task.id}.ts\n@@ -1 +1 @@\n-return false;\n+return true;\n`,
      baseFiles: { [`${task.id}.ts`]: "return false;\n" },
      implementationRunIds: [task.run.changeRunId!],
      limitations: [],
      sourceBinding: bindings.get(task.run.workspace!)!,
    };
  };
  const make = (
    hooks: Partial<ConstructorParameters<typeof CodeReviewManager>[4]> = {},
  ) =>
    new CodeReviewManager(
      dir,
      () => state,
      engine,
      () => {},
      {
        reviewProject: (task, parent) => epicAnalysisProject(parent, task),
        implementationCount: () =>
          state.tasks.filter((t) =>
            ["preparing", "running", "stopping"].includes(t.run.state),
          ).length + starting.size,
        implementationStarting: (id) => starting.has(id),
        prepare: async (_task, selected) => {
          prepared.push(selected.id);
          return selected;
        },
        settled: async (_task, selected) => {
          retired.push(selected.id);
        },
        queueFixes: async (id) => {
          fixes.push(id);
        },
        accept: async () => {},
        ...hooks,
      },
      { capture, sourceBinding: async (root) => bindings.get(root) ?? null },
    );
  const manager = make();
  const settled = async (client = manager, id = "a") => {
    await until(async () => {
      const run = await client.get(id);
      return !!run && !["queued", "running"].includes(run.state);
    });
    return (await client.get(id))!;
  };
  return {
    dir,
    state,
    project,
    a,
    aPeer,
    b,
    c,
    bindings,
    starting,
    captures,
    prepared,
    retired,
    calls,
    fixes,
    manager,
    make,
    settled,
    intercept: (value: typeof intercept) => {
      intercept = value;
    },
    close: async () => {
      await manager.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("same-epic preparing/running/stopping workers defer capture while an unrelated epic completes", async () => {
  const f = await fixture();
  try {
    f.state.settings.maxWorkers = 3;
    f.aPeer.run.state = "preparing";
    await f.manager.start("a");
    await f.manager.start("b");
    assert.equal((await f.settled(f.manager, "b")).state, "completed");
    await until(async () =>
      /finish editing/.test((await f.manager.get("a"))?.note ?? ""),
    );
    for (const state of ["preparing", "running", "stopping"] as const) {
      f.aPeer.run.state = state;
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(f.captures.includes("a"), false);
      assert.equal(f.prepared.includes("owned-a"), false);
    }
    f.aPeer.run.state = "finished";
    assert.equal((await f.settled()).state, "completed");
    assert.deepEqual(f.captures, ["b", "a"]);
  } finally {
    await f.close();
  }
});

test("a queued review retires its idle graph before admission can prepare the exact cached checkout", async () => {
  const f = await fixture(),
    retirement = gate();
  let retired = false;
  const client = f.make({
    settled: async () => {
      await retirement.promise;
      retired = true;
    },
    prepare: async (_task, project) => {
      assert.equal(retired, true);
      f.prepared.push(project.id);
      return project;
    },
  });
  try {
    await client.start("a");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.prepared.length, 0);
    assert.equal(f.captures.length, 0);
    retirement.resolve();
    assert.equal((await f.settled(client)).state, "completed");
    assert.deepEqual(f.prepared, ["owned-a"]);
  } finally {
    retirement.resolve();
    await client.close();
    await f.close();
  }
});

test("queueing a second story never retires an admitted peer's graph and preserves per-epic FIFO", async () => {
  const f = await fixture(),
    held = gate();
  let began = false;
  f.intercept(async (selected, name) => {
    if (
      selected.id === "owned-a" &&
      name === "find_code_review_issues" &&
      !began
    ) {
      began = true;
      await held.promise;
    }
  });
  try {
    await f.manager.start("a");
    await until(() => began);
    assert.equal(f.retired.length, 1);
    await f.manager.start("a-peer");
    await until(async () =>
      /earlier review/.test((await f.manager.get("a-peer"))?.note ?? ""),
    );
    assert.equal(
      f.retired.length,
      1,
      "The waiting story cannot evict the graph held by an admitted review",
    );
    assert.deepEqual(f.captures, ["a"]);
    held.resolve();
    await f.settled();
    const completedPeer = await f.settled(f.manager, "a-peer");
    assert.equal(
      completedPeer.note,
      undefined,
      "A completed review must not retain its queued waiting message",
    );
    assert.deepEqual(f.captures, ["a", "a-peer"]);
    assert.equal(f.retired.length, 3);
  } finally {
    held.resolve();
    await f.close();
  }
});

test("saved-evidence Q&A and initial reviews share the selected capacity with implementation workers", async () => {
  const f = await fixture(),
    held = gate();
  let asking = false;
  const reviewer: ReadonlyReviewAgent = {
    ask: async (input) => {
      if (input.question === "Explain this") {
        asking = true;
        await held.promise;
      }
      return {
        harness: "codex",
        model: "verified-model",
        text: "Captured evidence only.",
      };
    },
  };
  const client = f.make({ reviewer });
  try {
    await client.start("a");
    const run = await f.settled(client);
    const answer = client.discuss("a", run.id, "Explain this");
    await until(() => asking);
    f.b.run.state = "running";
    await client.start("c");
    await until(async () =>
      /local capacity/.test((await client.get("c"))?.note ?? ""),
    );
    assert.equal(client.occupiedSlots(), 1);
    assert.equal(f.captures.includes("c"), false);
    held.resolve();
    await answer;
    assert.equal((await f.settled(client, "c")).state, "completed");
    await until(() => client.occupiedSlots() === 0);
  } finally {
    held.resolve();
    await client.close();
    await f.close();
  }
});

test("an intervening epic writer drains review and queues one fresh snapshot after quiet, never infinite retries", async () => {
  const f = await fixture(),
    first = gate(),
    second = gate();
  let passes = 0,
    drained = false;
  f.intercept(async (selected, name) => {
    if (selected.id === "owned-a" && name === "find_code_review_issues") {
      passes++;
      if (passes === 1) await first.promise;
      else if (passes === 2) await second.promise;
    }
  });
  try {
    const original = await f.manager.start("a");
    await until(() => passes === 1);
    // A new story has not activated its epic checkout or private graph yet.
    delete f.aPeer.run.analysisProjectId;
    delete f.aPeer.run.analysisRepoId;
    delete f.aPeer.run.workspace;
    f.starting.add("a-peer");
    const start = f.manager.beforeWorker("a-peer").then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(drained, false);
    first.resolve();
    await start;
    await until(async () => {
      const run = await f.manager.get("a");
      return run?.id !== original.id && run?.state === "queued";
    });
    assert.equal(f.captures.length, 1);
    f.aPeer.run.state = "preparing";
    f.starting.clear();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(f.captures.length, 1);
    f.bindings.set(f.a.run.workspace!, "source-a-2");
    f.aPeer.run.state = "finished";
    await until(() => passes === 2);
    const retried = (await f.manager.get("a"))!;
    f.starting.add("a-peer");
    const another = f.manager.beforeWorker("a-peer");
    second.resolve();
    await another;
    f.starting.clear();
    const final = await f.settled();
    assert.equal(final.id, retried.id);
    assert.equal(final.state, "stale");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(f.captures.length, 2);
    assert.equal(passes, 2);
    const taskDirs = await readdir(join(f.dir, "code-reviews"));
    assert.equal(
      (await readdir(join(f.dir, "code-reviews", taskDirs[0]))).filter(
        (name) => name.endsWith(".json") && name !== "latest.json",
      ).length,
      2,
      "Both immutable pass reports remain on disk",
    );
  } finally {
    first.resolve();
    second.resolve();
    await f.close();
  }
});

test("explicit cancellation and lane exit cannot restart a pending automatic review", async () => {
  for (const action of ["cancel", "leave"] as const) {
    const f = await fixture(),
      held = gate();
    let began = false;
    f.intercept(async (_selected, name) => {
      if (name === "find_code_review_issues") {
        began = true;
        await held.promise;
      }
    });
    try {
      const run = await f.manager.start("a");
      await until(() => began);
      f.starting.add("a-peer");
      const start = f.manager.beforeWorker("a-peer");
      if (action === "cancel") await f.manager.cancel("a", run.id);
      else {
        f.a.stage = "planned";
        await f.manager.leaveLane("a");
      }
      held.resolve();
      await start;
      f.starting.clear();
      assert.equal((await f.settled()).state, "cancelled");
      await new Promise((resolve) => setTimeout(resolve, 140));
      assert.equal(f.captures.length, 1);
    } finally {
      held.resolve();
      await f.close();
    }
  }
});

test("a Stop click racing automatic recovery also stops the newly queued child pass", async () => {
  const f = await fixture(),
    held = gate();
  let began = false;
  f.intercept(async (_selected, name) => {
    if (name === "find_code_review_issues") {
      began = true;
      await held.promise;
    }
  });
  try {
    const original = await f.manager.start("a");
    await until(() => began);
    f.starting.add("a-peer");
    const start = f.manager.beforeWorker("a-peer");
    held.resolve();
    await start;
    await until(async () => {
      const run = await f.manager.get("a");
      return !!run && run.id !== original.id && run.state === "queued";
    });
    await f.manager.cancel("a", original.id);
    f.starting.clear();
    assert.equal((await f.settled()).state, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(f.captures.length, 1);
  } finally {
    held.resolve();
    await f.close();
  }
});

test("worker admission includes occupied review slots and reserves a slot during review cancellation", async () => {
  const f = await fixture(),
    starting = gate();
  let cancellation = false;
  f.state.settings.maxWorkers = 1;
  f.a.assignment = "auto";
  f.b.assignment = "auto";
  const worker = new WorkerManager(
    () => f.state,
    async () => {},
    {} as any,
    f.dir,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      cancellation = true;
      await starting.promise;
      throw Error("test stop before launch");
    },
    () => 1,
  );
  try {
    await assert.rejects(worker.start(f.a, f.project), /slots are occupied/);
    assert.equal(cancellation, false);
    // A same-epic replacement may drain its review, reserving capacity before
    // any async cancellation so another start cannot steal the last slot.
    (worker as any).reviewSlots = () => 0;
    const first = worker.start(f.a, f.project);
    await until(() => cancellation);
    assert.equal(worker.implementationCount(), 1);
    await assert.rejects(worker.start(f.b, f.project), /slots are occupied/);
    starting.resolve();
    await assert.rejects(first, /test stop/);
    assert.equal(worker.implementationCount(), 0);
  } finally {
    starting.resolve();
    await worker.close();
    await f.close();
  }
});

test("cancelled queued Q&A never launches a model and close cannot restart queued reviews", async () => {
  const f = await fixture(),
    held = gate();
  let began = false,
    questions = 0;
  const client = f.make({
    reviewer: {
      ask: async (input) => {
        if (input.question === "Queued question") questions++;
        return { harness: "codex", model: "verified", text: "Saved evidence." };
      },
    },
  });
  f.state.settings.maxWorkers = 1;
  try {
    await client.start("a");
    const run = await f.settled(client);
    f.intercept(async (selected, name) => {
      if (selected.id === "owned-b" && name === "find_code_review_issues") {
        began = true;
        await held.promise;
      }
    });
    await client.start("b");
    await until(() => began);
    const answer = client.discuss("a", run.id, "Queued question");
    await until(async () =>
      /capacity/.test((await client.get("a"))?.reviewer?.note ?? ""),
    );
    await client.cancel("a", run.id);
    await answer;
    assert.equal(questions, 0);
    assert.equal((await client.get("a"))?.reviewer?.state, "unavailable");
    await client.start("c");
    await client.close();
    held.resolve();
    assert.equal((await client.get("c"))?.state, "cancelled");
    await until(() => client.occupiedSlots() === 0);
    assert.equal(f.captures.includes("c"), false);
  } finally {
    held.resolve();
    await client.close();
    await f.close();
  }
});

test("a review fix follow-up returns through implementation and captures a new exact review pass", async () => {
  const f = await fixture();
  try {
    await f.manager.start("a");
    const first = await f.settled();
    assert.equal(first.outcome, "ready");
    await f.manager.requestFixes(
      "a",
      first.id,
      [],
      "Simplify this implementation.",
    );
    assert.deepEqual(f.fixes, ["a"]);
    assert.equal((await f.manager.get("a"))?.state, "stale");
    f.starting.add("a");
    await f.manager.beforeWorker("a");
    f.a.run.state = "preparing";
    f.starting.clear();
    await assert.rejects(f.manager.start("a"), /Finish/);
    f.bindings.set(f.a.run.workspace!, "source-a-2");
    f.a.changesRevision = "changes-a-2";
    f.a.run.state = "finished";
    f.a.run.finishedSourceBinding = "source-a-2";
    f.a.run.checks!.revision = "changes-a-2";
    await f.manager.start("a");
    const next = await f.settled();
    assert.notEqual(next.id, first.id);
    assert.equal(next.outcome, "ready");
    assert.equal(next.checks[0].state, "passed");
    assert.equal(next.snapshot.journalRevision, "changes-a-2");
    assert.equal(next.snapshot.sourceRevision, "source-a-2");
    assert.equal(f.captures.length, 2);
  } finally {
    await f.close();
  }
});
