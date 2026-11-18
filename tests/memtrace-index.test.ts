import { test } from "node:test";
import assert from "node:assert/strict";
import { MemtraceEngine } from "../runtime/memtrace.ts";
import type { Project } from "../src/shared.ts";

const project = {
  id: "selected-project",
  path: "C:/temporary/selected-project",
  branch: "epic/local-context",
  repoId: "selected-repo",
} as Project;
const repository = {
  repo_id: project.repoId,
  repo_path: project.path,
  index_state: "current",
};
const refusal = "owned source changed after verification; refusing publication";
const verified = {
  ready: true,
  status: "complete",
  publication: { status: "published" },
  _meta: { graph_revision: { publication_unchanged_during_call: true } },
  worktree: project.path,
  repo_id: project.repoId,
  branch: project.branch,
  requested_source_matches: true,
  requested_revision_matches: true,
  source_unchanged_during_observation: true,
};
function fixture(
  rows: unknown,
  revision = { ready: true, branch: project.branch },
) {
  const engine = new MemtraceEngine(() => "");
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  (engine as any).connect = async () => ({});
  (engine as any).watch = async () => undefined;
  engine.call = async (_project, name, args) => {
    calls.push({ name, args });
    if (name === "list_indexed_repositories") return rows;
    if (name === "index_directory") return { job_id: "local-index-job" };
    if (name === "check_job_status")
      return {
        id: "local-index-job",
        status: "completed",
        repo_id: project.repoId,
      };
    if (name === "get_query_revision") return revision;
    throw Error(`Unexpected operation ${name}`);
  };
  return { engine, calls };
}

for (const [shape, rows] of [
  ["array", [repository]],
  ["repos", { repos: [repository] }],
  ["repositories", { repositories: [repository] }],
] as const) {
  test(`current local repository in ${shape} response is reused without indexing`, async () => {
    const f = fixture(rows);
    assert.equal(await f.engine.analyze(project, () => {}), project.repoId);
    assert.deepEqual(
      f.calls.map((call) => call.name),
      ["list_indexed_repositories", "get_query_revision"],
    );
  });
}

test("a current summary waits for independently verified startup publication without enqueueing", async () => {
  const f = fixture([repository]);
  const original = f.engine.call;
  let reads = 0;
  f.engine.call = async (p, name, args) => {
    if (name === "list_jobs") return { jobs: [] };
    if (name === "get_query_revision")
      return {
        ready: ++reads >= 3,
        branch: project.branch,
        repo_id: project.repoId,
        worktree: project.path,
        source_unchanged_during_observation: true,
        graph_revision: { publication_unchanged_during_call: reads >= 3 },
      };
    return original(p, name, args);
  };
  try {
    assert.equal(await f.engine.analyze(project, () => {}), project.repoId);
    assert.equal(reads, 3);
    assert.equal(
      f.calls.some((c) => c.name === "index_directory"),
      false,
    );
  } finally {
    await f.engine.close();
  }
});

test("refresh preserves existing identity and requests incremental indexing of the selected branch", async () => {
  const f = fixture({ repos: [repository] });
  assert.equal(await f.engine.analyze(project, () => {}, true), project.repoId);
  assert.deepEqual(
    f.calls.find((call) => call.name === "index_directory")?.args,
    {
      path: project.path,
      repo_id: project.repoId,
      incremental: true,
      skip_embed: false,
      branch: project.branch,
    },
  );
  assert.equal(f.calls.at(-1)?.name, "get_query_revision");
});

test("job completion does not mark an unpublished graph ready", async () => {
  const f = fixture({ repos: [repository] }, {
    ready: false,
    branch: project.branch,
    reason: "branch_publication_incomplete",
  } as any);
  await assert.rejects(
    f.engine.analyze(project, () => {}, true),
    /source.*not verified.*branch_publication_incomplete/,
  );
});

test("job completion for a different source branch is rejected", async () => {
  const f = fixture([repository], { ready: true, branch: "another-branch" });
  await assert.rejects(
    f.engine.analyze(project, () => {}, true),
    /not verified/,
  );
});

test("retry after a publication refusal reuses a later certified graph without submitting a job", async () => {
  const f = fixture([repository], verified);
  assert.equal(
    await f.engine.analyze(project, () => {}, false, refusal),
    project.repoId,
  );
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ["list_indexed_repositories", "get_query_revision"],
  );
});

test("a failed native job can be superseded by a later exact certificate before analysis returns", async () => {
  const f = fixture([repository], verified);
  const original = f.engine.call;
  f.engine.call = async (p, name, args) =>
    name === "check_job_status"
      ? {
          id: "local-index-job",
          repo_id: project.repoId,
          status: "failed",
          error: refusal,
        }
      : original(p, name, args);
  assert.equal(await f.engine.analyze(project, () => {}, true), project.repoId);
  assert.equal(f.calls.filter((c) => c.name === "index_directory").length, 1);
  assert.deepEqual(f.calls.at(-1), {
    name: "get_query_revision",
    args: { repo_id: project.repoId, branch: project.branch },
  });
});

test("a sidebar retry after a verification deadline repairs a stable 437-file reasonless partial graph and waits for certification", async () => {
  const stale = {
    ...project,
    analysis: "error" as const,
    analysisNote:
      "Memtrace get_query_revision did not respond while inspecting the existing index.",
  };
  const f = fixture([repository], verified);
  const native = f.engine.call;
  let reads = 0;
  f.engine.call = async (p, name, args) => {
    if (name !== "get_query_revision") return native(p, name, args);
    if (++reads === 1)
      return {
        ...verified,
        ready: false,
        status: "partial",
        source_file_count: 437,
        indexed_file_count: 437,
        mismatched_files: 0,
        ambiguous_indexed_files: false,
        _meta: {
          graph_revision: {
            status: "partial",
            publication_unchanged_during_call: false,
          },
        },
      };
    await new Promise((resolve) => setTimeout(resolve, 5200));
    return verified;
  };
  assert.equal(await f.engine.analyze(stale, () => {}), project.repoId);
  assert.equal(reads, 2);
  assert.deepEqual(
    f.calls.filter((c) => c.name === "index_directory").map((c) => c.args),
    [
      {
        path: project.path,
        branch: project.branch,
        repo_id: project.repoId,
        incremental: true,
        skip_embed: false,
      },
    ],
  );
});

test("a saved refusal cannot authorize a repair on a different branch", async () => {
  const f = fixture([repository], { ...verified, branch: "other" });
  await assert.rejects(
    f.engine.analyze(project, () => {}, false, refusal),
    /could not verify the repository/,
  );
  assert.equal(
    f.calls.some((c) => c.name === "index_directory"),
    false,
  );
});

test("retry after a refusal uses a single incremental job, and preserves a repeated native refusal", async () => {
  const f = fixture([repository], {
    ...verified,
    ready: false,
    status: "partial",
    reason: "branch_publication_incomplete",
  } as any);
  const original = f.engine.call;
  f.engine.call = async (p, name, args) =>
    name === "check_job_status"
      ? {
          id: "local-index-job",
          repo_id: project.repoId,
          status: "failed",
          error: refusal,
        }
      : original(p, name, args);
  await assert.rejects(
    f.engine.analyze(project, () => {}, false, refusal),
    { message: refusal },
  );
  assert.equal(f.calls.filter((c) => c.name === "index_directory").length, 1);
  assert.equal(
    f.calls.find((c) => c.name === "index_directory")?.args.incremental,
    true,
  );
  assert.equal(
    f.calls.filter((c) => c.name === "get_query_revision").length,
    2,
  );
});

test("an unrelated failure never submits a recovery job or adopts a later certificate", async () => {
  const f = fixture([repository], verified),
    original = f.engine.call;
  f.engine.call = async (p, name, args) =>
    name === "check_job_status"
      ? {
          id: "local-index-job",
          status: "failed",
          error: "Graph store unavailable",
        }
      : original(p, name, args);
  await assert.rejects(
    f.engine.analyze(project, () => {}, true),
    /Graph store unavailable/,
  );
  assert.equal(f.calls.filter((c) => c.name === "index_directory").length, 1);
  assert.equal(
    f.calls.some((c) => c.name === "get_query_revision"),
    false,
  );
});

test("native alreadyUpToDate admission still requires a verified revision, not a foreground job", async () => {
  const f = fixture([repository]),
    original = f.engine.call;
  let submissions = 0;
  f.engine.call = async (p, name, args) => {
    if (name === "index_directory") {
      submissions++;
      return { alreadyUpToDate: true, repo_id: project.repoId };
    }
    if (name === "list_jobs") return { jobs: [] };
    return original(p, name, args);
  };
  try {
    assert.equal(
      await f.engine.analyze(project, () => {}, true),
      project.repoId,
    );
    assert.equal(submissions, 1);
  } finally {
    await f.engine.close();
  }
});
