import test from "node:test";
import assert from "node:assert/strict";
import {
  completedEpicIndex,
  verifiedIndexRevision,
  waitForIndexPublication,
  waitForPeerIndex,
  verifyingSourceRevision,
} from "../runtime/memtrace-peer-index";
import { MemtraceEngine } from "../runtime/memtrace";
import type { Project } from "../src/shared";

const project: Project = {
  id: "peer-fixture",
  name: "Peer fixture",
  description: "Synthetic job protocol",
  path: process.cwd(),
  branch: "main",
  repoId: "fixture",
  analysis: "ready",
  createdAt: "2026-11-16",
};
const skipped = {
  skipped: true,
  reason: "peer_indexing",
  repo_id: "fixture",
  branch: "main",
};

test("an idle epic retirement prevents an in-flight query from resurrecting its graph owner", async () => {
  const epic = {
    ...project,
    id: "retiring-epic",
    analysisCheckout: "owned-worktree-v1" as const,
  };
  const engine = new MemtraceEngine(() => "");
  let reject!: (error: Error) => void,
    connected = 0,
    closed = 0,
    released = 0;
  const pending = new Promise((_resolve, fail) => {
    reject = fail;
  });
  const client = {
    callTool: () => pending,
    close: async () => {
      closed++;
    },
  };
  (engine as any).connect = async () => {
    connected++;
    return client;
  };
  (engine as any).clients.set(epic.id, { client, projectPath: epic.path });
  (engine as any).scopes.set(epic.id, {
    mode: "project",
    dataDirectory: "private-epic-store",
  });
  (engine as any).owners.release = async (store: string) => {
    assert.equal(store, "private-epic-store");
    released++;
  };
  const query = engine.call(epic, "get_query_revision", {
    repo_id: epic.repoId,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await engine.releaseEpic(epic);
  reject(Error("Connection closed"));
  await assert.rejects(query, /retired/);
  assert.equal(connected, 1);
  assert.equal(closed, 1);
  assert.equal(released, 1);
  assert.equal(engine.scopeFor(epic.id), null);
  await engine.close();
});

test("an owned epic rejects a canonical or incomplete certificate even when it says ready", () => {
  const epic = { ...project, analysisCheckout: "owned-worktree-v1" as const };
  const revision = {
    ready: true,
    repo_id: epic.repoId,
    branch: epic.branch,
    worktree: epic.path,
    source_unchanged_during_observation: true,
    graph_revision: { publication_unchanged_during_call: true },
  };
  assert.equal(verifiedIndexRevision(revision, epic, epic.repoId!), false);
  const owned = {
    ...revision,
    checkout_mode: "owned-worktree-v1",
    graph_scope: "owned_worktree_graph",
  };
  assert.equal(verifiedIndexRevision(owned, epic, epic.repoId!), true);
  assert.equal(
    verifiedIndexRevision(
      { ...owned, worktree: epic.path + "/different" },
      epic,
      epic.repoId!,
    ),
    false,
  );
  assert.equal(
    verifiedIndexRevision({ ...owned, repo_id: undefined }, epic, epic.repoId!),
    false,
  );
});

// Shape captured from the native owned-worktree acceptance run (6ec252fb6).
// Only local paths and opaque revision tokens are replaced with fixture values.
const nativeOwnedProject: Project = {
  ...project,
  branch: "epic/a",
  analysisCheckout: "owned-worktree-v1",
};
const nativeOwnedRevision = {
  _meta: {
    graph_revision: {
      publication_unchanged_during_call: true,
      token: "fixture-graph-publication",
    },
  },
  ambiguous_indexed_files: false,
  branch: "epic/a",
  checkout_mode: "owned-worktree-v1",
  default_branch_matches: true,
  default_query_branch: "epic/a",
  graph_scope: "owned_worktree_graph",
  indexed_file_count: 1,
  indexing_revision: "fixture-indexing-revision",
  mismatched_files: 0,
  mismatched_paths: [],
  publication: { status: "published", token: "fixture-graph-publication" },
  ready: true,
  repo_id: "fixture",
  requested_revision_matches: true,
  requested_source_matches: true,
  retry_query_group: false,
  scope:
    "repository graph and supported source files; Cortex has independent revisions",
  source_commit: "fixture-commit",
  source_file_count: 1,
  source_revision: "fixture-source-revision",
  source_unchanged_during_observation: true,
  status: "complete",
  token: "fixture-query-token",
  worktree: project.path,
};

const writingRevision = {
  ...nativeOwnedRevision,
  ready: false,
  status: "partial",
  reason: "index_write_in_progress",
  publication: { status: "partial" },
  _meta: { graph_revision: { publication_unchanged_during_call: false } },
};

test("a completed index waits through a prolonged owned write and resumes on the same published source", async () => {
  let elapsed = 0;
  const progress: string[] = [];
  const reads: Array<Record<string, unknown>> = [];
  const result = await waitForIndexPublication(
    {
      async call(_, name, args) {
        assert.equal(name, "get_query_revision");
        reads.push(args);
        return elapsed >= 75_000 ? nativeOwnedRevision : writingRevision;
      },
    },
    nativeOwnedProject,
    "fixture",
    (note) => progress.push(note),
    {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    },
  );
  assert.equal(result, "fixture");
  assert.equal(reads[0].expected_source_revision, undefined);
  assert.ok(
    reads
      .slice(1)
      .every(
        (read) =>
          read.expected_source_revision === nativeOwnedRevision.source_revision,
      ),
  );
  assert.ok(progress.every((note) => note.includes("automatically")));
  assert.ok(elapsed >= 75_000 && elapsed < 80_000);
});

test("an owned write refuses a changed source, ambiguous scope, or a mismatched graph", async () => {
  for (const patch of [
    { source_revision: "new-revision" },
    { source_revision: undefined },
    { graph_scope: "canonical_graph" },
    { checkout_mode: undefined },
    { branch: "epic/b" },
    { repo_id: "unrelated" },
    { requested_source_matches: false },
    { worktree: nativeOwnedProject.path + "-other" },
  ]) {
    await assert.rejects(
      waitForIndexPublication(
        {
          call: async () => ({ ...nativeOwnedRevision, ...patch }),
        },
        nativeOwnedProject,
        "fixture",
        () => {},
        { sleep: async () => {} },
        writingRevision,
      ),
      /same source|another repository/,
    );
  }
  await assert.rejects(
    waitForIndexPublication(
      {
        call: async () => ({ ...writingRevision, source_revision: undefined }),
      },
      nativeOwnedProject,
      "fixture",
      () => {},
    ),
    /same source/,
  );
});

test("a stuck writer is bounded and a cancelled in-flight read is never polled again", async () => {
  let elapsed = 0;
  await assert.rejects(
    waitForIndexPublication(
      {
        call: async () => writingRevision,
      },
      nativeOwnedProject,
      "fixture",
      () => {},
      {
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
        timeoutMs: 2000,
      },
    ),
    /still verifying.*Retry/,
  );
  assert.equal(elapsed, 2000);
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(
    waitForIndexPublication(
      {
        call: () => {
          reads++;
          queueMicrotask(() => controller.abort());
          return new Promise(() => {});
        },
      },
      nativeOwnedProject,
      "fixture",
      () => {},
      { signal: controller.signal },
    ),
    /cancelled/,
  );
  assert.equal(reads, 1);
});

test("canonical and owned readers cannot reuse each other's graph certificates", () => {
  const canonical = { ...nativeOwnedProject, analysisCheckout: undefined };
  assert.equal(
    verifiedIndexRevision(nativeOwnedRevision, canonical, "fixture"),
    false,
  );
  assert.equal(
    verifiedIndexRevision(
      {
        ...nativeOwnedRevision,
        checkout_mode: undefined,
        graph_scope: undefined,
      },
      canonical,
      "fixture",
    ),
    true,
  );
});

test("a native owned certificate uses the MCP publication envelope and keeps exact checkout guards", () => {
  assert.equal(
    verifiedIndexRevision(nativeOwnedRevision, nativeOwnedProject, "fixture"),
    true,
  );
  for (const patch of [
    { branch: "epic/b" },
    { repo_id: "another-repo" },
    { repo_id: undefined },
    { worktree: project.path + "/another-checkout" },
    { worktree: 42 },
    { worktree: undefined },
    { checkout_mode: undefined },
    { graph_scope: "repository_graph" },
    { source_unchanged_during_observation: false },
    { requested_source_matches: false },
    { requested_revision_matches: false },
    { default_branch_matches: false },
    { publication: { status: "partial" } },
    { status: "partial" },
    { retry_query_group: true },
  ]) {
    assert.equal(
      verifiedIndexRevision(
        { ...nativeOwnedRevision, ...patch },
        nativeOwnedProject,
        "fixture",
      ),
      false,
      JSON.stringify(patch),
    );
  }
});

test("an unstable or malformed native envelope cannot be hidden by legacy success metadata", () => {
  for (const graphRevision of [
    null,
    undefined,
    { publication_unchanged_during_call: false },
    { status: "partial", publication_unchanged_during_call: true },
    { publication_unchanged_during_call: "true" },
    {},
    true,
    "ready",
    [],
  ]) {
    const value = {
      ...nativeOwnedRevision,
      _meta: { graph_revision: graphRevision },
      graph_revision: { publication_unchanged_during_call: true },
    };
    assert.equal(
      verifiedIndexRevision(value, nativeOwnedProject, "fixture"),
      false,
      JSON.stringify(graphRevision),
    );
  }
  for (const graphRevision of [
    null,
    undefined,
    { publication_unchanged_during_call: false },
    { status: "partial", publication_unchanged_during_call: true },
    true,
    "ready",
    [],
  ]) {
    assert.equal(
      verifiedIndexRevision(
        {
          ...nativeOwnedRevision,
          _meta: { graph_revision: graphRevision },
          graph_revision: { publication_unchanged_during_call: true },
        },
        { ...nativeOwnedProject, analysisCheckout: undefined },
        "fixture",
      ),
      false,
    );
  }
});

test("legacy graph metadata is used only when the native envelope field is absent", () => {
  for (const metadata of [undefined, null, {}]) {
    assert.equal(
      verifiedIndexRevision(
        {
          ...nativeOwnedRevision,
          _meta: metadata,
          graph_revision: { publication_unchanged_during_call: true },
        },
        nativeOwnedProject,
        "fixture",
      ),
      true,
    );
  }
});

test("publication polling adopts the native envelope only after its boundary settles", async () => {
  let reads = 0;
  assert.equal(
    await waitForIndexPublication(
      {
        call: async (_project, name, args) => {
          assert.equal(name, "get_query_revision");
          assert.deepEqual(args, { repo_id: "fixture", branch: "epic/a" });
          reads++;
          return {
            ...nativeOwnedRevision,
            _meta: {
              graph_revision: {
                publication_unchanged_during_call: reads > 1,
              },
            },
          };
        },
      },
      nativeOwnedProject,
      "fixture",
      () => {},
      clock(),
    ),
    "fixture",
  );
  assert.equal(reads, 2);
});
const job = (patch: Record<string, unknown> = {}) => ({
  id: "existing-job",
  repo_id: "fixture",
  status: "running",
  stage: "parse",
  message: "Parsing source files",
  runtime_context: { requested_path: project.path },
  ...patch,
});
test("a worker repair requires the previous exact job and an idle native store", () => {
  const finished = job({ status: "completed", branch: project.branch });
  const canRepair = (jobs: unknown) => completedEpicIndex({ jobs }, project, "fixture");
  assert.equal(canRepair([finished]), true);
  for (const other of ["running", "pending", "paused", "unknown"])
    assert.equal(canRepair([finished, job({ status: other })]), false);
  for (const mismatch of [{ branch: "other" }, { repo_id: "other" }, { runtime_context: { requested_path: "/other" } }])
    assert.equal(canRepair([{ ...finished, ...mismatch }]), false);
  assert.equal(canRepair([]), false);
  assert.equal(canRepair(undefined), false);
});

test("a guarded worker refresh rechecks the matched repository before submitting any job", async () => {
  const engine = new MemtraceEngine(() => "unused");
  engine.connect = (async () => ({})) as unknown as MemtraceEngine["connect"];
  const calls: string[] = [];
  engine.call = async (_project, name) => {
    calls.push(name);
    if (name === "list_indexed_repositories")
      return { repos: [{ repo_id: "fixture", repo_path: project.path }] };
    throw Error("unexpected native request");
  };
  await assert.rejects(engine.analyze(project, () => {}, true, undefined, undefined, async (repoId) => {
    assert.equal(repoId, "fixture");
    throw Error("source changed");
  }), /source changed/);
  assert.deepEqual(calls, ["list_indexed_repositories"]);
  await engine.close();
});

const clock = () => {
  let time = 100000;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    discoveryMs: 30,
    timeoutMs: 100,
    pollMs: 10,
    readTimeoutMs: 100,
  };
};

for (const reason of ["index_verification_running", "branch_publication_incomplete"])
  test(`native ${reason} gets the bounded verification window and requires the same final certificate`, async () => {
    let time = 0, reads = 0;
    const pending = { ...nativeOwnedRevision, ready: false, status: "partial", reason,
      token: null, indexing_revision: null, source_revision: "unchanged-source",
      requested_source_matches: true, requested_revision_matches: true, retry_query_group: false };
    assert.equal(verifyingSourceRevision(pending, nativeOwnedProject, "fixture"), "unchanged-source");
    assert.equal(verifyingSourceRevision({ ...pending, graph_scope: "canonical_graph" }, nativeOwnedProject, "fixture"), undefined);
    assert.equal(verifyingSourceRevision({ ...pending, error: "failure" }, nativeOwnedProject, "fixture"), undefined);
    assert.equal(await waitForIndexPublication({ call: async (_p, name, args) => {
      assert.equal(name, "get_query_revision"); reads++;
      if (reads > 1) assert.equal(args.expected_source_revision, "unchanged-source");
      return time < 60_000 ? pending : { ...nativeOwnedRevision, source_revision: "unchanged-source" };
    } }, nativeOwnedProject, "fixture", () => {}, {
      now: () => time, sleep: async ms => { time += ms; }, pollMs: 1000, timeoutMs: 100_000,
    }), "fixture");
    assert.ok(time >= 60_000 && time <= 100_000);
  });

test("a completed job waits beyond three seconds for independent publication without resubmitting or accepting partial results", async () => {
  let time = 0;
  const calls: string[] = [],
    notes: string[] = [];
  const client = {
    call: async (
      _project: Project,
      name: string,
      args: Record<string, any>,
    ) => {
      calls.push(name);
      assert.deepEqual(args, { repo_id: "fixture", branch: "main" });
      return {
        repo_id: "fixture",
        worktree: project.path,
        branch: "main",
        ready: time >= 5000,
        status: time < 5000 ? "partial" : "current",
      };
    },
  };
  assert.equal(
    await waitForIndexPublication(
      client,
      project,
      "fixture",
      (note) => notes.push(note),
      {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
        pollMs: 1000,
        timeoutMs: 30_000,
      },
    ),
    "fixture",
  );
  assert.equal(time, 5000);
  assert.equal(calls.length, 6);
  assert.ok(calls.every((name) => name === "get_query_revision"));
  assert.ok(
    notes.length > 0 &&
      notes.every((note) => note.includes("verify code context")),
  );
});

test("completed-job publication rejects explicit foreign repository, checkout or branch immediately", async () => {
  for (const patch of [
    { repo_id: "foreign" },
    { worktree: project.path + "-foreign" },
    { branch: "epic/foreign" },
  ]) {
    let reads = 0;
    const client = {
      call: async () => {
        reads++;
        return {
          ready: true,
          branch: "main",
          repo_id: "fixture",
          worktree: project.path,
          ...patch,
        };
      },
    };
    await assert.rejects(
      waitForIndexPublication(client, project, "fixture", () => {}, clock()),
      /not verified.*another repository, checkout or branch/,
    );
    assert.equal(reads, 1);
  }
});

test("a publication that stays partial times out with its reason and never becomes ready", async () => {
  let time = 0,
    reads = 0;
  const client = {
    call: async () => {
      reads++;
      return {
        ready: false,
        status: "partial",
        branch: "main",
        worktree: project.path,
        repo_id: "fixture",
        reason: "branch_publication_incomplete",
      };
    },
  };
  await assert.rejects(
    waitForIndexPublication(client, project, "fixture", () => {}, {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      timeoutMs: 4000,
      pollMs: 1000,
    }),
    /not verified.*branch_publication_incomplete.*no duplicate index/,
  );
  assert.equal(time, 4000);
  assert.equal(reads, 4);
});

test("cancellation and source rebinding stop completed-job publication before another query", async () => {
  for (const change of ["cancel", "checkout", "branch"]) {
    const selected = { ...project };
    let cancelled = false,
      time = 0,
      reads = 0;
    const client = {
      call: async () => {
        reads++;
        return {
          ready: false,
          branch: "main",
          worktree: project.path,
          repo_id: "fixture",
        };
      },
    };
    await assert.rejects(
      waitForIndexPublication(client, selected, "fixture", () => {}, {
        now: () => time,
        isCancelled: () => cancelled,
        timeoutMs: 30_000,
        sleep: async (ms) => {
          time += ms;
          if (change === "cancel") cancelled = true;
          else if (change === "checkout") selected.path += "-changed";
          else selected.branch = "epic/changed";
        },
      }),
      /cancelled|checkout\/branch changed/,
    );
    assert.equal(reads, 1);
  }
});

test("an unresponsive final certificate query is bounded", async () => {
  await assert.rejects(
    waitForIndexPublication(
      { call: async () => new Promise(() => {}) },
      project,
      "fixture",
      () => {},
      {
        readTimeoutMs: 10,
        timeoutMs: 30_000,
      },
    ),
    /verification did not respond before its deadline/,
  );
});

test("peer job discovery follows matching owner progress and verifies branch/source at completion", async () => {
  const calls: Array<[string, Record<string, any>]> = [],
    notes: string[] = [];
  let polls = 0;
  const client = {
    call: async (
      _project: Project,
      name: string,
      args: Record<string, any>,
    ) => {
      calls.push([name, args]);
      if (name === "list_jobs")
        return {
          jobs: [job({ progress: { completed: 2, total: 8, unit: "files" } })],
        };
      if (name === "check_job_status")
        return ++polls === 1
          ? job({
              stage: "embed",
              message: "Embedding changed symbols",
              progress: { completed: 3, total: null, unit: "symbols" },
            })
          : job({ status: "completed" });
      if (name === "get_query_revision") return { ready: true, branch: "main" };
      throw Error("Unexpected mutation " + name);
    },
  };
  assert.equal(
    await waitForPeerIndex(
      client,
      project,
      skipped,
      "fixture",
      (note) => notes.push(note),
      clock(),
    ),
    "fixture",
  );
  assert.equal(polls, 2);
  assert.match(notes[0], /existing-job.*parse.*2\/8 files/);
  assert.ok(notes.some((note) => note.includes("Embedding changed symbols")));
  assert.ok(
    notes.every((note) => !note.includes("%")),
    "Unknown totals do not produce invented percentages",
  );
  assert.deepEqual(
    calls
      .filter(([name]) => name === "check_job_status")
      .map(([, args]) => args.job_id),
    ["existing-job", "existing-job"],
  );
  assert.equal(calls.at(-1)?.[0], "get_query_revision");
});

test("engine peer handling queues once and adopts the tracked job rather than resubmitting indexes", async () => {
  const engine = new MemtraceEngine(() => "unused-fixture"),
    calls: string[] = [],
    payloads: Record<string, any>[] = [];
  engine.connect = (async () => ({})) as unknown as MemtraceEngine["connect"];
  engine.watch = async () => null;
  engine.call = async (_project, name, args) => {
    calls.push(name);
    if (name === "list_indexed_repositories")
      return {
        repos: [
          { repo_id: "fixture", repo_path: project.path, index_state: "stale" },
        ],
      };
    if (name === "index_directory") {
      payloads.push(args);
      return skipped;
    }
    if (name === "list_jobs") return { jobs: [job()] };
    if (name === "check_job_status") return job({ status: "completed" });
    if (name === "get_query_revision") return { ready: true, branch: "main" };
    throw Error("Unexpected " + name);
  };
  try {
    assert.equal(await engine.analyze({ ...project }, () => {}), "fixture");
    assert.equal(calls.filter((name) => name === "index_directory").length, 1);
    assert.equal(payloads[0].branch, "main");
    assert.equal(payloads[0].incremental, true);
    assert.equal(payloads[0].clear_existing, undefined);
  } finally {
    await engine.close();
  }
});

test("a missing active job or stale lease stops promptly without creating another job", async () => {
  let lists = 0;
  const client = {
    call: async (_project: Project, name: string) => {
      if (name === "list_jobs") {
        lists++;
        return { jobs: [] };
      }
      if (name === "get_query_revision")
        return { ready: false, branch: "main" };
      throw Error("Unexpected " + name);
    },
  };
  await assert.rejects(
    waitForPeerIndex(client, project, skipped, "fixture", () => {}, clock()),
    /no active job.*lease may be stale/,
  );
  assert.ok(
    lists <= 4,
    "Discovery is bounded independently of the normal index duration",
  );
});

test("unrelated repositories, checkouts and explicit other branches are never followed", async () => {
  let statusCalls = 0;
  const client = {
    call: async (_project: Project, name: string) => {
      if (name === "list_jobs")
        return {
          jobs: [
            job({ id: "other-repo", repo_id: "other" }),
            job({
              id: "other-root",
              runtime_context: { requested_path: project.path + "-different" },
            }),
            job({ id: "other-branch", branch: "epic/other" }),
          ],
        };
      if (name === "get_query_revision")
        return { ready: false, branch: "main" };
      if (name === "check_job_status") {
        statusCalls++;
        throw Error("Wrong job polled");
      }
      throw Error("Unexpected " + name);
    },
  };
  await assert.rejects(
    waitForPeerIndex(client, project, skipped, "fixture", () => {}, clock()),
    /no active job/,
  );
  assert.equal(statusCalls, 0);
});

test("a returned job ID is preferred and still checked against its exact local scope", async () => {
  const calls: string[] = [];
  const client = {
    call: async (
      _project: Project,
      name: string,
      args: Record<string, any>,
    ) => {
      if (name === "list_jobs")
        return {
          jobs: [job({ id: "unselected-job" }), job({ id: "returned-job" })],
        };
      if (name === "check_job_status") {
        calls.push(args.job_id);
        return job({ id: args.job_id, status: "completed" });
      }
      if (name === "get_query_revision") return { ready: true, branch: "main" };
      throw Error("Unexpected " + name);
    },
  };
  assert.equal(
    await waitForPeerIndex(
      client,
      project,
      { ...skipped, job_id: "returned-job" },
      "fixture",
      () => {},
      clock(),
    ),
    "fixture",
  );
  assert.deepEqual(calls, ["returned-job"]);
  await assert.rejects(
    waitForPeerIndex(
      {
        call: async () => ({
          jobs: [job({ id: "returned-job", repo_id: "unrelated" })],
        }),
      },
      project,
      { ...skipped, job_id: "returned-job" },
      "fixture",
      () => {},
      clock(),
    ),
    /does not match this local checkout/,
  );
});

test("completed legacy jobs without branch metadata still require independently ready source on the intended branch", async () => {
  const client = {
    call: async (_project: Project, name: string) => {
      if (name === "list_jobs") return { jobs: [job()] };
      if (name === "check_job_status") return job({ status: "completed" });
      if (name === "get_query_revision")
        return { ready: true, branch: "epic/different" };
      throw Error("Unexpected " + name);
    },
  };
  await assert.rejects(
    waitForPeerIndex(client, project, skipped, "fixture", () => {}, clock()),
    /completed, but current source on branch main is not verified/,
  );
  await assert.rejects(
    waitForPeerIndex(
      client,
      project,
      { ...skipped, branch: "epic/different" },
      "fixture",
      () => {},
      clock(),
    ),
    /another repository or branch/,
  );
});

test("the actual existing job failure is surfaced rather than a generic peer-indexing message", async () => {
  const client = {
    call: async (_project: Project, name: string) => {
      if (name === "list_jobs") return { jobs: [job()] };
      if (name === "check_job_status")
        return job({
          status: "failed",
          error: "Source input certificate could not be qualified",
        });
      throw Error("Unexpected " + name);
    },
  };
  await assert.rejects(
    waitForPeerIndex(client, project, skipped, "fixture", () => {}, clock()),
    /existing-job failed: Source input certificate/,
  );
});

test("an active but unfinished job has a bounded wait with its identity retained for reconnect", async () => {
  let polls = 0;
  const options = { ...clock(), timeoutMs: 20 };
  const client = {
    call: async (_project: Project, name: string) => {
      if (name === "list_jobs") return { jobs: [job()] };
      if (name === "check_job_status") {
        polls++;
        return job();
      }
      throw Error("Unexpected " + name);
    },
  };
  await assert.rejects(
    waitForPeerIndex(client, project, skipped, "fixture", () => {}, options),
    /existing-job is still running.*no duplicate index/,
  );
  assert.equal(polls, 2);
});

test("unresponsive owner diagnostics are bounded rather than inheriting a long blind MCP wait", async () => {
  await assert.rejects(
    waitForPeerIndex(
      { call: async () => new Promise(() => {}) },
      project,
      skipped,
      "fixture",
      () => {},
      { ...clock(), readTimeoutMs: 5 },
    ),
    /list_jobs did not respond/,
  );
});

const backgroundRevision = (patch: Record<string, unknown> = {}) => ({
  repo_id: "fixture",
  worktree: project.path,
  branch: "main",
  ready: false,
  status: "partial",
  source_revision: "stable-source",
  source_file_count: 2,
  indexed_file_count: 2,
  mismatched_files: 0,
  source_unchanged_during_observation: true,
  graph_revision: { publication_unchanged_during_call: false },
  ...patch,
});

test("native bootstrap may hold the lease with no foreground job until its exact source publication converges", async () => {
  let revisions = 0;
  const names: string[] = [],
    notes: string[] = [];
  const options = clock();
  const client = {
    call: async (_p: Project, name: string) => {
      names.push(name);
      if (name === "list_jobs") return { jobs: [] };
      if (name === "get_query_revision")
        return backgroundRevision(
          ++revisions < 6
            ? {}
            : {
                ready: true,
                status: "complete",
                graph_revision: { publication_unchanged_during_call: true },
              },
        );
      throw Error("Unexpected mutation " + name);
    },
  };
  assert.equal(
    await waitForPeerIndex(
      client,
      project,
      skipped,
      "fixture",
      (n) => notes.push(n),
      options,
    ),
    "fixture",
  );
  assert.equal(
    revisions,
    6,
    "Wait continues beyond the short foreground job discovery budget",
  );
  assert.ok(notes.some((n) => n.includes("startup")));
  assert.deepEqual([...new Set(names)].sort(), [
    "get_query_revision",
    "list_jobs",
  ]);
});

test("a fresh peer owner without a repo ID is resolved only from the exact local repository", async () => {
  let discoveries = 0;
  const client = {
    call: async (_p: Project, name: string) => {
      if (name === "list_jobs") return [];
      if (name === "list_indexed_repositories")
        return ++discoveries === 1
          ? []
          : [
              { repo_id: "wrong", path: project.path + "-other" },
              { repo_id: "fixture", path: project.path, branch: "main" },
            ];
      if (name === "get_query_revision")
        return backgroundRevision({
          ready: true,
          status: "complete",
          graph_revision: { publication_unchanged_during_call: true },
        });
      throw Error("Unexpected " + name);
    },
  };
  assert.equal(
    await waitForPeerIndex(
      client,
      project,
      { skipped: true, reason: "peer_indexing" },
      undefined,
      () => {},
      clock(),
    ),
    "fixture",
  );
  assert.equal(discoveries, 2);
});

test("matching source counts cannot qualify an unpublished or changed-source background graph", async () => {
  for (const patch of [
    { ready: false, status: "partial" },
    { source_unchanged_during_observation: false },
    { requested_source_matches: false },
    { graph_revision: { publication_unchanged_during_call: false } },
  ]) {
    const client = {
      call: async (_p: Project, name: string) => {
        if (name === "list_jobs") return { jobs: [] };
        if (name === "get_query_revision")
          return backgroundRevision({
            ready: true,
            status: "complete",
            graph_revision: { publication_unchanged_during_call: true },
            ...patch,
          });
        throw Error("Unexpected mutation " + name);
      },
    };
    await assert.rejects(
      waitForPeerIndex(client, project, skipped, "fixture", () => {}, {
        ...clock(),
        publicationMs: 50,
      }),
      /startup graph.*not finished verifying.*no duplicate/,
    );
  }
});

test("jobless source certificates for another checkout or branch never qualify", async () => {
  for (const patch of [
    { worktree: project.path + "-other" },
    { branch: "other" },
    { repo_id: "other" },
  ]) {
    const value = backgroundRevision({
      ready: true,
      status: "complete",
      graph_revision: { publication_unchanged_during_call: true },
      ...patch,
    });
    assert.equal(verifiedIndexRevision(value, project, "fixture"), false);
  }
  if (process.platform === "win32")
    assert.equal(
      verifiedIndexRevision(
        backgroundRevision({
          ready: true,
          status: "complete",
          worktree: "//?/" + project.path!.replaceAll("\\", "/"),
          graph_revision: { publication_unchanged_during_call: true },
        }),
        project,
        "fixture",
      ),
      true,
      "Rust canonical Windows worktree paths identify the same checkout",
    );
});

test("cancellation or checkout/branch changes stop background publication adoption", async () => {
  for (const change of ["cancel", "path", "branch"]) {
    const selected = { ...project },
      options = clock();
    let cancelled = false;
    const client = {
      call: async (_p: Project, name: string) => {
        if (name === "list_jobs") return { jobs: [] };
        if (name === "get_query_revision") return backgroundRevision();
        throw Error("Unexpected mutation " + name);
      },
    };
    const sleep = options.sleep;
    await assert.rejects(
      waitForPeerIndex(client, selected, skipped, "fixture", () => {}, {
        ...options,
        isCancelled: () => cancelled,
        sleep: async (ms) => {
          await sleep(ms);
          if (change === "cancel") cancelled = true;
          if (change === "path") selected.path += "-rebound";
          if (change === "branch") selected.branch = "another";
        },
      }),
      /cancelled or its local checkout\/branch changed/,
    );
  }
});

const pendingOwnedPublication = {
  ...nativeOwnedRevision,
  ready: false,
  status: "partial",
  publication: { status: "partial", token: "pending" },
  _meta: {
    graph_revision: {
      status: "partial",
      token: "pending",
      publication_unchanged_during_call: false,
    },
  },
};

test("a completed owned index with every source file matched waits for the same publication past 30 seconds", async () => {
  let elapsed = 0;
  const names = new Set<string>();
  await waitForIndexPublication(
    {
      call: async (_project, name, args) => {
        names.add(name);
        if (elapsed > 0)
          assert.equal(
            args.expected_source_revision,
            nativeOwnedRevision.source_revision,
          );
        return elapsed < 45_000 ? pendingOwnedPublication : nativeOwnedRevision;
      },
    },
    nativeOwnedProject,
    "fixture",
    () => {},
    {
      completedJob: true,
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    },
  );
  assert.deepEqual([...names], ["get_query_revision"]);
  assert.ok(elapsed >= 45_000 && elapsed < 50_000);
});

test("only an exact current source and a recognized partial publication extend a completed job wait", async () => {
  for (const [completedJob, change] of [
    [false, {}],
    [true, { reason: "unrecognized" }],
    [true, { mismatched_paths: ["a.ts"] }],
    [true, { mismatched_files: 1 }],
    [true, { source_revision: null }],
    [true, { error: "failed" }],
    [true, { graph_scope: "canonical_graph" }],
    [true, { _meta: { ...pendingOwnedPublication._meta, stale: true } }],
    [true, { publication: { status: "partial", token: "different" } }],
  ] as const) {
    let elapsed = 0;
    await assert.rejects(
      waitForIndexPublication(
        {
          call: async () => ({ ...pendingOwnedPublication, ...change }),
        },
        nativeOwnedProject,
        "fixture",
        () => {},
        {
          completedJob,
          now: () => elapsed,
          sleep: async (ms) => {
            elapsed += ms;
          },
        },
      ),
    );
    assert.equal(elapsed, 30_000);
  }
});

test("a source change while a completed owned index publishes interrupts the wait", async () => {
  let elapsed = 0;
  await assert.rejects(
    waitForIndexPublication(
      {
        call: async () =>
          elapsed === 0
            ? pendingOwnedPublication
            : { ...nativeOwnedRevision, source_revision: "other" },
      },
      nativeOwnedProject,
      "fixture",
      () => {},
      {
        completedJob: true,
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
      },
    ),
    /same source revision/,
  );
});

test("a completed-job wait cannot adopt an older publication or wait through cancellation", async () => {
  let elapsed = 0;
  await assert.rejects(
    waitForIndexPublication(
      {
        call: async () =>
          elapsed === 0
            ? pendingOwnedPublication
            : {
                ...nativeOwnedRevision,
                _meta: {
                  stale: true,
                  graph_revision: nativeOwnedRevision._meta.graph_revision,
                },
              },
      },
      nativeOwnedProject,
      "fixture",
      () => {},
      {
        completedJob: true,
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
        isCancelled: () => elapsed >= 35_000,
      },
    ),
    /cancelled/,
  );
  assert.ok(elapsed < 40_000);
});

test("matched files alone do not start a worker and cannot renew its publication budget", async () => {
  let elapsed = 0;
  await assert.rejects(
    waitForIndexPublication(
      {
        call: async () => pendingOwnedPublication,
      },
      nativeOwnedProject,
      "fixture",
      () => {},
      {
        completedJob: true,
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
      },
    ),
    /still verifying/,
  );
  assert.equal(elapsed, 120_000);
});
