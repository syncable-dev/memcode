import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../src/shared";
import {
  prepareReviewAnalysis,
  repairReviewPublication,
} from "../runtime/review-analysis-prepare";

function fixture() {
  const project: Project = {
    id: "owned-a",
    name: "Epic A",
    description: "",
    path:
      process.platform === "win32" ? "C:/fixture/epic-a" : "/fixture/epic-a",
    branch: "epic/a",
    repoId: "repo",
    analysis: "ready",
    analysisCheckout: "owned-worktree-v1",
    createdAt: "2026-11-17T12:00:00Z",
  };
  const certificate = (
    status: "published" | "partial" = "published",
  ): Record<string, any> => ({
    ready: status === "published",
    status: status === "published" ? "complete" : "partial",
    repo_id: "repo",
    worktree: project.path,
    branch: project.branch,
    checkout_mode: "owned-worktree-v1",
    graph_scope: "owned_worktree_graph",
    default_branch_matches: true,
    source_unchanged_during_observation: true,
    requested_source_matches: true,
    requested_revision_matches: true,
    retry_query_group: false,
    source_revision: "same-source",
    indexing_revision: "indexed",
    token: "query",
    mismatched_files: 0,
    mismatched_paths: [],
    ambiguous_indexed_files: false,
    source_file_count: 2,
    indexed_file_count: 2,
    publication: {
      status,
      token: status === "published" ? "published" : "pending",
    },
    _meta: {
      graph_revision: {
        status,
        token: status === "published" ? "published" : "pending",
        publication_unchanged_during_call: status === "published",
      },
    },
  });
  const reads: Record<string, any>[] = [certificate()],
    calls: string[] = [],
    progress: string[] = [];
  let cancelled = false,
    afterAnalyze: ((force: boolean) => void) | undefined,
    afterWatch: (() => void) | undefined;
  const engine = {
    releaseEpic: async () => {
      calls.push("release");
    },
    analyze: async (_scope: Project, _update: unknown, force = false) => {
      calls.push(force ? "analyze:repair" : "analyze:cached");
      afterAnalyze?.(force);
      return "repo";
    },
    watch: async () => {
      calls.push("watch");
      afterWatch?.();
      return {
        state: "watching" as const,
        path: project.path!,
        repoId: "repo",
        branch: project.branch,
        origin: "memcode" as const,
        verifiedAt: "now",
      };
    },
    call: async (_scope: Project, name: string) => {
      calls.push(name);
      return reads.shift() ?? certificate();
    },
  };
  const run = (capturedPaths: string[] = []) =>
    prepareReviewAnalysis(
      engine,
      project,
      (note) => progress.push(note),
      () => {
        if (cancelled) throw Error("cancelled by user");
      },
      capturedPaths,
    );
  return {
    project,
    certificate,
    reads,
    calls,
    progress,
    engine,
    run,
    cancel: () => {
      cancelled = true;
    },
    afterAnalyze: (fn: typeof afterAnalyze) => {
      afterAnalyze = fn;
    },
    afterWatch: (fn: typeof afterWatch) => {
      afterWatch = fn;
    },
  };
}

test("private review preparation reuses the live owner without retirement or duplicate analysis", async () => {
  const f = fixture(),
    before = structuredClone(f.project);
  const result = await f.run();
  assert.deepEqual(f.calls, [
    "watch",
    "get_query_revision",
  ]);
  assert.deepEqual(result, f.project);
  assert.notEqual(result, f.project);
  assert.deepEqual(f.project, before);
});

test("one real incremental repair completes a known unfinished publication without changing source identity", async () => {
  const f = fixture();
  f.reads.splice(0, 1, f.certificate("partial"), f.certificate());
  assert.equal((await f.run()).repoId, "repo");
  assert.deepEqual(f.calls, [
    "watch",
    "get_query_revision",
    "analyze:repair",
    "watch",
    "get_query_revision",
  ]);
  assert.equal(f.progress.length, 1);
  assert.match(f.progress[0], /one incremental refresh/);
});

const invalid: Record<string, (value: Record<string, any>) => void> = {
  foreign_repo: (value) => {
    value.repo_id = "other";
  },
  foreign_checkout: (value) => {
    value.worktree += "-other";
  },
  foreign_branch: (value) => {
    value.branch = "epic/b";
  },
  canonical_scope: (value) => {
    value.graph_scope = "canonical_graph";
  },
  unknown_checkout_mode: (value) => {
    value.checkout_mode = "future";
  },
  changed_source: (value) => {
    value.source_unchanged_during_observation = false;
  },
  mismatched_source: (value) => {
    value.mismatched_files = 1;
    value.mismatched_paths = ["src/main.ts"];
  },
  missing_file_coverage: (value) => {
    delete value.source_file_count;
  },
  unknown_index_inventory: (value) => {
    delete value.indexed_file_count;
  },
  missing_source_identity: (value) => {
    delete value.source_revision;
  },
  ambiguous_graph: (value) => {
    value.ambiguous_indexed_files = true;
  },
  unavailable_publication: (value) => {
    value.publication.status = "unavailable";
  },
  explicit_malformed_envelope: (value) => {
    value._meta.graph_revision = null;
    value.graph_revision = {
      token: "pending",
      publication_unchanged_during_call: false,
    };
  },
  inconsistent_tokens: (value) => {
    value._meta.graph_revision.token = "other";
  },
  error: (value) => {
    value._error = "Index failed";
  },
  error_code: (value) => {
    value.error_code = "PUBLICATION_FAILED";
  },
  error_message: (value) => {
    value.message = "Index failed";
  },
  other_partial_reason: (value) => {
    value.reason = "branch_publication_incomplete";
  },
};
for (const [label, change] of Object.entries(invalid))
  test(`private review preparation never repairs ${label}`, async () => {
    const f = fixture(),
      partial = f.certificate("partial");
    change(partial);
    f.reads.splice(0, 1, partial);
    await assert.rejects(f.run(), /No automatic repair/);
    assert.equal(f.calls.includes("analyze:repair"), false);
    assert.equal(f.progress.length, 0);
  });

test("a still-dirty result or changed source after the single repair is never accepted or retried again", async () => {
  for (const changed of [false, true]) {
    const f = fixture(),
      after = f.certificate(changed ? "published" : "partial");
    if (changed) after.source_revision = "new-source";
    f.reads.splice(0, 1, f.certificate("partial"), after);
    await assert.rejects(f.run(), /after one incremental refresh/);
    assert.equal(f.calls.filter((call) => call === "analyze:repair").length, 1);
  }
});

test("watch failure, indexing errors and cancellation cannot turn into a repair or launch review capture", async () => {
  const watch = fixture();
  watch.engine.watch = async () => {
    throw Error("watch failed");
  };
  await assert.rejects(watch.run(), /watch failed/);
  assert.equal(watch.calls.includes("get_query_revision"), false);
  const index = fixture();
  delete index.project.repoId;
  index.engine.analyze = async () => {
    throw Error("index failed");
  };
  await assert.rejects(index.run(), /index failed/);
  assert.equal(index.calls.includes("watch"), false);
  const cancel = fixture();
  delete cancel.project.repoId;
  cancel.afterAnalyze(() => cancel.cancel());
  await assert.rejects(cancel.run(), /cancelled/);
  assert.equal(cancel.calls.includes("watch"), false);
  const beforeRepair = fixture();
  beforeRepair.reads[0] = beforeRepair.certificate("partial");
  beforeRepair.afterWatch(() => beforeRepair.cancel());
  await assert.rejects(beforeRepair.run(), /cancelled/);
  assert.equal(beforeRepair.calls.includes("analyze:repair"), false);
  const duringRepair = fixture();
  duringRepair.reads[0] = duringRepair.certificate("partial");
  duringRepair.afterAnalyze((force) => {
    if (force) duringRepair.cancel();
  });
  await assert.rejects(duringRepair.run(), /cancelled/);
  assert.equal(duringRepair.calls.filter((call) => call === "watch").length, 1);
});

test("non-owned legacy preparation keeps its existing behavior and starts no extra engine work", async () => {
  const f = fixture();
  delete f.project.analysisCheckout;
  assert.equal(await f.run(), f.project);
  assert.deepEqual(f.calls, []);
});

test("late publication recovery repairs the current owner without retirement, reopening or cached analysis", async () => {
  const f = fixture();
  f.reads.splice(0, 1, f.certificate("partial"), f.certificate());
  await repairReviewPublication(
    f.engine,
    f.project,
    (note) => f.progress.push(note),
    () => {},
    "same-source",
  );
  assert.deepEqual(f.calls, [
    "watch",
    "get_query_revision",
    "analyze:repair",
    "watch",
    "get_query_revision",
  ]);
  assert.equal(f.calls.includes("release"), false);
  assert.equal(f.calls.includes("analyze:cached"), false);
});

test("late recovery cannot adopt a changed source between the group's boundary and its repair inspection", async () => {
  for (const status of ["published", "partial"] as const) {
    const f = fixture();
    f.reads[0] = f.certificate(status);
    f.reads[0].source_revision = "source-edited-after-group";
    await assert.rejects(
      repairReviewPublication(
        f.engine,
        f.project,
        () => {},
        () => {},
        "same-source",
      ),
      /source changed before publication recovery/,
    );
    assert.deepEqual(f.calls, ["watch", "get_query_revision"]);
  }
});

function transition(
  f: ReturnType<typeof fixture>,
  partialBody = false,
  partialPublication = false,
) {
  const value = f.certificate(partialPublication ? "partial" : "published");
  if (partialBody) {
    value.ready = false;
    value.status = "partial";
  }
  value._meta = {
    stale: true,
    graph_revision: {
      before: { status: "partial", token: "pending" },
      after: { status: "published", token: "published" },
      publication_unchanged_during_call: false,
    },
  };
  return value;
}

test("a native publication completed during inspection requires a fresh strict read, not another index", async () => {
  for (const shape of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    const f = fixture();
    f.reads.splice(
      0,
      1,
      transition(f, ...(shape as [boolean, boolean])),
      f.certificate(),
    );
    await repairReviewPublication(
      f.engine,
      f.project,
      () => {},
      () => {},
      "same-source",
    );
    assert.deepEqual(f.calls, [
      "watch",
      "get_query_revision",
      "get_query_revision",
    ]);
  }
});

test("an incremental repair followed by a mid-observation completion still gets only one actual repair", async () => {
  const f = fixture();
  f.reads.splice(
    0,
    1,
    f.certificate("partial"),
    transition(f, true, false),
    f.certificate(),
  );
  await repairReviewPublication(
    f.engine,
    f.project,
    () => {},
    () => {},
    "same-source",
  );
  assert.equal(f.calls.filter((call) => call === "analyze:repair").length, 1);
  assert.equal(
    f.calls.filter((call) => call === "get_query_revision").length,
    3,
  );
  assert.equal(f.calls.includes("release"), false);
});

test("ongoing recognized publication transitions have a shared three-fresh-read bound and never become evidence", async () => {
  const f = fixture();
  f.reads.splice(0, 1, ...Array.from({ length: 5 }, () => transition(f)));
  await assert.rejects(
    repairReviewPublication(f.engine, f.project, () => {}),
    /No automatic repair/,
  );
  assert.equal(
    f.calls.filter((call) => call === "get_query_revision").length,
    4,
  );
  assert.equal(f.calls.includes("analyze:repair"), false);
});

test("each fresh transition observation rechecks source identity before recovery", async () => {
  const f = fixture(),
    changed = f.certificate();
  changed.source_revision = "changed-between-fresh-reads";
  f.reads.splice(0, 1, transition(f), changed);
  await assert.rejects(
    repairReviewPublication(
      f.engine,
      f.project,
      () => {},
      () => {},
      "same-source",
    ),
    /source changed/,
  );
  assert.equal(
    f.calls.filter((call) => call === "get_query_revision").length,
    2,
  );
  assert.equal(f.calls.includes("analyze:repair"), false);
});

test("unknown, malformed, missing and foreign transition metadata never gets a fresh-read allowance", async () => {
  for (const alter of [
    (value: any) => {
      value._meta.graph_revision.before.status = "unavailable";
    },
    (value: any) => {
      value._meta.graph_revision.after.token = null;
    },
    (value: any) => {
      value._meta.graph_revision.error = "failed";
    },
    (value: any) => {
      value._meta.stale = false;
    },
    (value: any) => {
      delete value.source_file_count;
    },
    (value: any) => {
      value.worktree += "-other";
    },
  ]) {
    const f = fixture(),
      value = transition(f);
    alter(value);
    f.reads[0] = value;
    await assert.rejects(
      repairReviewPublication(f.engine, f.project, () => {}),
      /No automatic repair/,
    );
    assert.deepEqual(f.calls, ["watch", "get_query_revision"]);
  }
});

function pendingBranch(f: ReturnType<typeof fixture>): Record<string, any> {
  return {
    ready: false,
    status: "partial",
    reason: "branch_publication_incomplete",
    repo_id: f.project.repoId,
    worktree: f.project.path,
    branch: f.project.branch,
    checkout_mode: "owned-worktree-v1",
    graph_scope: "owned_worktree_graph",
    requested_source_matches: true,
    requested_revision_matches: true,
    retry_query_group: false,
    source_commit: "commit",
    source_revision: "same-source",
    indexing_revision: null,
    token: null,
    _meta: {
      graph_revision: {
        status: "partial",
        token: "pending",
        publication_unchanged_during_call: false,
      },
    },
  };
}

test("an edited epic with a pending branch view gets one incremental refresh after a second observation", async () => {
  const f = fixture();
  const transition = pendingBranch(f);
  transition._meta = {
    stale: true,
    graph_revision: {
      before: { status: "partial", token: "previous" },
      after: { status: "partial", token: "pending" },
      publication_unchanged_during_call: false,
    },
  };
  f.reads.splice(0, 1, transition, pendingBranch(f), f.certificate());
  await f.run(["src/owned.ts"]);
  assert.deepEqual(f.calls, [
    "watch",
    "get_query_revision",
    "watch",
    "get_query_revision",
    "analyze:repair",
    "watch",
    "get_query_revision",
  ]);
});

test("a pending branch view cannot authorize recovery on a changed source or a foreign checkout", async () => {
  for (const mutate of [
    (value: any) => {
      value.source_revision = "changed";
    },
    (value: any) => {
      value.worktree += "-foreign";
    },
    (value: any) => {
      value.requested_source_matches = false;
    },
    (value: any) => {
      value._meta.graph_revision.status = "unavailable";
    },
    (value: any) => {
      value.mismatched_files = 1;
    },
    (value: any) => {
      value.error_code = "BROKEN";
    },
  ]) {
    const f = fixture(),
      followup = pendingBranch(f);
    mutate(followup);
    f.reads.splice(0, 1, pendingBranch(f), followup);
    await assert.rejects(f.run(["src/owned.ts"]));
    assert.equal(f.calls.includes("analyze:repair"), false);
  }
});

test("a pending branch view after repair cannot authorize review or a second index", async () => {
  const f = fixture();
  f.reads.splice(
    0,
    1,
    pendingBranch(f),
    pendingBranch(f),
    pendingBranch(f),
    pendingBranch(f),
  );
  await assert.rejects(
    f.run(["src/owned.ts"]),
    /after one incremental refresh/,
  );
  assert.equal(f.calls.filter((call) => call === "analyze:repair").length, 1);
});

test("only the current story’s captured files can explain a stale native index", async () => {
  for (const authorized of [true, false]) {
    const f = fixture(),
      lag = f.certificate();
    Object.assign(lag, {
      ready: false,
      status: "partial",
      mismatched_files: 1,
      mismatched_paths: ["src/owned.ts"],
    });
    f.reads.splice(0, 1, lag, lag, f.certificate());
    if (authorized) {
      await f.run(["src/owned.ts"]);
      assert.equal(
        f.calls.filter((call) => call === "analyze:repair").length,
        1,
      );
    } else {
      await assert.rejects(f.run(["src/another.ts"]), /No automatic repair/);
      assert.equal(f.calls.includes("analyze:repair"), false);
    }
  }
});

test("a captured mismatch can cross a publication boundary during its confirming read", async () => {
  const f = fixture(),
    lag = f.certificate(),
    pending = pendingBranch(f);
  Object.assign(lag, {
    ready: false,
    status: "partial",
    mismatched_files: 1,
    mismatched_paths: ["src/owned.ts"],
  });
  pending._meta = {
    stale: true,
    graph_revision: {
      before: { status: "published", token: "old" },
      after: { status: "partial", token: "new" },
      publication_unchanged_during_call: false,
    },
  };
  f.reads.splice(0, 1, lag, pending, pendingBranch(f), f.certificate());
  await f.run(["src/owned.ts"]);
  assert.equal(f.calls.filter((call) => call === "analyze:repair").length, 1);
  assert.equal(
    f.calls.filter((call) => call === "get_query_revision").length,
    4,
  );
});
