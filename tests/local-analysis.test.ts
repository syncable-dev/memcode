import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Project } from "../src/shared";
import {
  localAnalysisDiagnostics,
  registerLocalAnalysis,
} from "../runtime/local-analysis";
import type { MemtraceEngine } from "../runtime/memtrace";

const project = (): Project => ({
  id: "local-project",
  name: "My checkout",
  path: join(tmpdir(), "own-checkout"),
  branch: "epic/local",
  repoId: "local-repo",
  analysis: "indexing",
  analysisNote: "Waiting for peer_indexing",
  description: "PRIVATE SOURCE BRIEF",
  createdAt: "2026-11-16T00:00:00Z",
});
type Engine = Pick<MemtraceEngine, "call" | "scopeFor">;

test("only a stable certificate from the same owner recovers a saved publication refusal", async () => {
  const item = project();
  const refused =
    "owned source changed after verification; refusing publication";
  const stable = {
    ready: true,
    status: "complete",
    publication: { status: "published" },
    _meta: { graph_revision: { publication_unchanged_during_call: true } },
    source_unchanged_during_observation: true,
    requested_source_matches: true,
    requested_revision_matches: true,
    repo_id: item.repoId,
    worktree: item.path,
    branch: item.branch,
  };
  for (const [name, patch, ownerCurrent, note, recovered] of [
    [
      "replay and embeddings still running",
      {
        ready: false,
        status: "partial",
        reason: "branch_publication_incomplete",
      },
      true,
      refused,
      false,
    ],
    [
      "wrong checkout",
      { worktree: item.path + "-other" },
      true,
      refused,
      false,
    ],
    ["wrong repo", { repo_id: "other" }, true, refused, false],
    ["wrong branch", { branch: "other" }, true, refused, false],
    [
      "revision changed",
      { requested_revision_matches: false },
      true,
      refused,
      false,
    ],
    [
      "unstable publication",
      {
        _meta: { graph_revision: { publication_unchanged_during_call: false } },
      },
      true,
      refused,
      false,
    ],
    ["owner retired during capture", {}, false, refused, false],
    ["unrelated saved error", {}, true, "Authorization failed", false],
    ["stable verified publication", {}, true, refused, true],
  ] as const) {
    item.analysis = "error";
    item.analysisNote = note;
    const observed = await localAnalysisDiagnostics(
      item,
      {
        call: async (_p, name) => {
          if (name === "list_indexed_repositories")
            return [
              {
                repo_id: item.repoId,
                repo_path: item.path,
                live_branch: item.branch,
                index_state: "current",
              },
            ];
          if (name === "list_watched_paths")
            return { watches: [{ path: item.path, branch: item.branch }] };
          if (name === "list_jobs")
            return {
              jobs: [
                { repo_id: item.repoId, status: "completed", stage: "replay" },
                { repo_id: item.repoId, status: "running", stage: "embed" },
              ],
            };
          if (name === "get_query_revision") return { ...stable, ...patch };
          throw Error("Unexpected operation " + name);
        },
        scopeFor: () => null,
        bindingStillCurrent: () => () => ownerCurrent,
      },
      {
        onRecovered: async (id) => {
          assert.equal(id, item.repoId);
          item.analysis = "ready";
        },
      },
    );
    assert.equal(item.analysis, recovered ? "ready" : "error", name);
    assert.equal(
      observed.sourcePublication,
      recovered || name === "unrelated saved error"
        ? "verified"
        : name === "replay and embeddings still running"
          ? "incomplete"
          : "unverified",
      name,
    );
    assert.equal(observed.project.analysis, item.analysis, name);
  }
});

test("diagnostics query the actual engine and exact local checkout while excluding other projects and secret/source payloads", async () => {
  const item = project(),
    before = structuredClone(item),
    calls: Array<{ name: string; args: unknown }> = [];
  const other = join(tmpdir(), "other-checkout");
  const engine = {
    async call(selected: Project, name: string, args: unknown) {
      assert.equal(selected, item);
      calls.push({ name, args });
      if (name === "list_indexed_repositories")
        return [
          {
            repo_id: "wrong-repo",
            repo_path: other,
            branch: item.branch,
            index_state: "current",
          },
          {
            repo_id: item.repoId,
            repo_path: item.path,
            branch: item.branch,
            index_state: "catching_up",
            index_state_reason: "peer_indexing",
            nodes: 5432,
            edges: 12345,
            graph_head_sha: "abc",
            source: "PRIVATE SOURCE BODY",
            token: "PRIVATE-API-TOKEN",
          },
        ];
      if (name === "list_watched_paths")
        return {
          watches: [
            { path: other, repo_id: "wrong" },
            {
              path: item.path,
              repo_id: item.repoId,
              branch: item.branch,
              started_at: "2026-11-16T00:00:01Z",
              credentials: "PRIVATE-CREDENTIALS",
            },
          ],
        };
      if (name === "list_jobs")
        return {
          jobs: [
            {
              id: "other-path",
              repo_id: item.repoId,
              status: "running",
              runtime_context: { requested_path: other },
            },
            {
              id: "other-branch",
              repo_id: item.repoId,
              branch: "main",
              status: "running",
            },
            { id: "foreign", repo_id: "foreign", status: "running" },
            {
              id: "my-job",
              repo_id: item.repoId,
              status: "running",
              stage: "parse",
              message: "Waiting for source publication",
              updated_at: "2026-11-16T00:00:02Z",
              progress: {
                completed: 3,
                total: 10,
                unit: "files",
                source: "PRIVATE",
              },
              runtime_context: {
                requested_path: item.path,
                store_path: join(item.path!, ".memcode", "memtrace", ".memdb"),
                process_id: 123,
                configured_endpoint:
                  "https://user:secret@example.test/?token=SECRET",
              },
              result: { source: "PRIVATE RESULT" },
            },
          ],
        };
      if (name === "get_query_revision")
        return {
          ready: false,
          branch: item.branch,
          reason: "branch_publication_incomplete",
          mismatched_files: 1,
          mismatched_paths: ["src/app.ts"],
          source_commit: "abc",
          _meta: {
            graph_revision: {
              token: "graph-rev",
              status: "partial",
              secret: "PRIVATE",
            },
          },
          source: "PRIVATE CODE",
        };
      throw Error("An unexpected tool was called: " + name);
    },
    scopeFor(id: string) {
      assert.equal(id, item.id);
      return {
        mode: "project" as const,
        dataDirectory: join(item.path!, ".memcode", "memtrace", ".memdb"),
        workspaceFile: join(
          item.path!,
          ".memcode",
          "memtrace",
          "workspace.toml",
        ),
      };
    },
  } as Engine;
  const value = await localAnalysisDiagnostics(item, engine);
  assert.deepEqual(calls.map((c) => c.name).sort(), [
    "get_query_revision",
    "list_indexed_repositories",
    "list_jobs",
    "list_watched_paths",
  ]);
  assert.deepEqual(calls.find((c) => c.name === "get_query_revision")!.args, {
    repo_id: "local-repo",
    branch: item.branch,
  });
  assert.equal(value.repoMetadata!.index_state, "catching_up");
  assert.equal(value.repoMetadata!.repo_path, item.path);
  assert.equal(value.indexRevision!.ready, false);
  assert.equal(value.indexRevision!.reason, "branch_publication_incomplete");
  assert.deepEqual(value.indexRevision!.mismatched_paths, ["src/app.ts"]);
  assert.equal(value.watch.length, 1);
  assert.equal(value.jobs.length, 1);
  assert.equal(value.jobs[0].id, "my-job");
  assert.equal(value.jobs[0].branch_observation, "unknown");
  assert.equal(value.scope!.mode, "project");
  assert.deepEqual(value.failures, []);
  assert.doesNotMatch(
    JSON.stringify(value),
    /PRIVATE|configured_endpoint|other-checkout|foreign|credentials/,
  );
  assert.deepEqual(
    item,
    before,
    "Metadata queries never replace the project's local path, repo identity or analysis state",
  );
});

test("an unbound checkout performs no engine work; an exact-path discovered identity is used without mutating saved project identity", async () => {
  const item = project();
  let calls = 0;
  const engine = {
    call: async () => {
      calls++;
      throw Error("Unexpected");
    },
    scopeFor: () => null,
  } as Engine;
  const unbound = await localAnalysisDiagnostics(
    { ...item, path: null },
    engine,
  );
  assert.equal(calls, 0);
  assert.equal(unbound.failures[0].operation, "project_scope");
  const queried: unknown[] = [];
  const known = {
    call: async (_p: Project, name: string, args: unknown) => {
      if (name === "list_indexed_repositories")
        return [
          {
            repo_path: item.path,
            repo_id: "actual-admitted-repo",
            branch: item.branch,
          },
        ];
      if (name === "get_query_revision") {
        queried.push(args);
        return { ready: true };
      }
      return { jobs: [], watches: [] };
    },
    scopeFor: () => null,
  } as Engine;
  const observed = await localAnalysisDiagnostics(item, known);
  assert.deepEqual(queried, [
    { repo_id: "actual-admitted-repo", branch: item.branch },
  ]);
  assert.equal(item.repoId, "local-repo");
  assert.equal(observed.project.repoId, "local-repo");
  assert.equal(observed.repoMetadata!.repo_id, "actual-admitted-repo");
  assert.equal(observed.failures[0].operation, "repository_identity");
});

test("metadata errors keep useful reasons and redact bearer credentials, URL secrets and signed assertions", async () => {
  const item = project(),
    secret = "sk-verysecretcredential",
    jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJwcml2YXRlIn0.signature";
  const engine = {
    call: async (_p: Project, name: string) => {
      if (name === "list_indexed_repositories")
        return [{ repo_id: item.repoId, repo_path: item.path }];
      throw Error(
        `branch_publication_incomplete: api_key=${secret} Bearer ABCDEFG https://alice:password@example.test/?token=URLSECRET ${jwt}`,
      );
    },
    scopeFor: () => null,
  } as Engine;
  const value = await localAnalysisDiagnostics(item, engine);
  assert.equal(value.failures.length, 3);
  assert.match(value.failures[0].reason, /branch_publication_incomplete/);
  assert.doesNotMatch(
    JSON.stringify(value),
    /verysecretcredential|ABCDEFG|alice:password|URLSECRET|eyJhbGci/,
  );
  assert.ok(value.failures.every((f) => f.timeout === false));
});

test("a stalled engine yields bounded unknown observations without cancellation or mutations", async () => {
  const item = project(),
    calls: string[] = [];
  let complete!: () => void;
  const stalled = new Promise<Record<string, unknown>>((resolve) => {
    complete = () => resolve({});
  });
  const engine = {
    call: async (_p: Project, name: string) => {
      calls.push(name);
      return stalled;
    },
    scopeFor: () => ({
      mode: "workspace" as const,
      dataDirectory: join(tmpdir(), "local-store"),
    }),
  } as Engine;
  const start = Date.now();
  const value = await localAnalysisDiagnostics(item, engine, { timeoutMs: 20 });
  assert.ok(Date.now() - start < 500);
  assert.equal(value.repoMetadata, null);
  assert.equal(value.indexRevision, null);
  assert.equal(value.scope!.mode, "workspace");
  assert.ok(value.failures.every((f) => f.timeout));
  assert.equal(value.failures.length, 4);
  assert.deepEqual(calls.sort(), [
    "list_indexed_repositories",
    "list_jobs",
    "list_watched_paths",
  ]);
  complete();
  await new Promise((resolve) => setImmediate(resolve));
});

test("the registered RPC accepts only a project id and returns metadata without index/watch/reset calls", async () => {
  const item = project();
  let invoke: ((value: unknown) => Promise<unknown>) | undefined;
  registerLocalAnalysis(
    (name, schema, handle) => {
      assert.equal(name, "project:local-diagnostics");
      invoke = async (value) => handle(schema.parse(value));
    },
    (id) => {
      assert.equal(id, item.id);
      return item;
    },
    {
      call: async (_p, name) =>
        name === "list_indexed_repositories"
          ? [{ repo_path: item.path, repo_id: item.repoId }]
          : {},
      scopeFor: () => null,
    } as Engine,
  );
  await assert.rejects(invoke!({ projectId: item.id, reset: true }));
  const value = (await invoke!({ projectId: item.id })) as Awaited<
    ReturnType<typeof localAnalysisDiagnostics>
  >;
  assert.equal(value.project.name, item.name);
});

test("observed incomplete-publication metadata preserves the UI fields, null counts and watch provenance", async () => {
  // Anonymized shape from windows-diagnostics.json. Its repository list was
  // rewrapped by the capture script; raw arrays and .repos are supported too.
  const item = project(),
    extended =
      process.platform === "win32"
        ? "\\\\?\\" + item.path!.replaceAll("/", "\\")
        : item.path!;
  const engine = {
    call: async (_p: Project, name: string) => {
      if (name === "list_indexed_repositories")
        return {
          repositories: [
            {
              branch: null,
              commit_sha: null,
              edges: null,
              index_state: "catching_up",
              index_state_reason:
                "a save's graph update is still being completed",
              live_branch: item.branch,
              nodes: null,
              path: extended,
              repo_path: extended,
              repo_id: item.repoId,
              summary_current: false,
              summary_error: null,
              workspace_branch: item.branch,
            },
          ],
          totalRepositories: 1,
        };
      if (name === "list_watched_paths")
        return {
          _meta: {
            owner_http: "http://127.0.0.1:12345",
            owner_pid: 123,
            secret: "PRIVATE",
          },
          count: 1,
          watches: [
            {
              answered_by: "store_owner_daemon",
              branch: item.branch,
              index_scope: { view: "canonical_graph", source: "PRIVATE" },
              origin: "manual",
              path: item.path,
              repo_id: item.repoId,
              started_at: "2026-11-15T22:16:53.232Z",
            },
          ],
        };
      if (name === "list_jobs")
        return { _meta: { owner_http: "http://127.0.0.1:12345" }, jobs: [] };
      return {
        _meta: {
          graph_revision: {
            publication_unchanged_during_call: false,
            status: "partial",
            token: "observed-graph",
          },
        },
        branch: item.branch,
        indexing_revision: null,
        ready: false,
        reason: "branch_publication_incomplete",
        repo_id: item.repoId,
        requested_revision_matches: true,
        requested_source_matches: true,
        retry_query_group: false,
        source_commit: "abc",
        source_revision: "source-hash",
        status: "partial",
        token: null,
        worktree: item.path,
      };
    },
    scopeFor: () => ({
      mode: "project" as const,
      dataDirectory: join(item.path!, ".memcode", "memtrace", ".memdb"),
    }),
  } as Engine;
  const value = await localAnalysisDiagnostics(item, engine);
  assert.equal(value.indexRevision!.ready, false);
  assert.equal(value.indexRevision!.reason, "branch_publication_incomplete");
  assert.equal(value.indexRevision!.indexing_revision, null);
  assert.equal(value.indexRevision!.retry_query_group, false);
  assert.equal(value.repoMetadata!.nodes, null);
  assert.equal(value.repoMetadata!.edges, null);
  assert.equal(value.repoMetadata!.workspace_branch, item.branch);
  assert.equal(value.watch[0].origin, "manual");
  assert.deepEqual(value.watch[0].index_scope, { view: "canonical_graph" });
  assert.deepEqual(value.jobs, []);
  assert.deepEqual(value.failures, []);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|owner_http/);
});

test("malformed metadata is unknown instead of an empty watch/job result and structured Node causes remain useful", async () => {
  const item = project();
  const engine = {
    call: async (_p: Project, name: string) => {
      if (name === "list_indexed_repositories")
        return { repos: [{ repo_path: item.path, repo_id: item.repoId }] };
      if (name === "list_jobs")
        throw {
          code: "NODE_ERROR",
          reason: { message: "store unavailable" },
          cause: {
            message:
              "Authorization: Basic BASE64PRIVATE\nCookie: session=COOKIEPRIVATE",
          },
          raw: { source: "PRIVATE CODE" },
        };
      if (name === "list_watched_paths")
        return { unsupported: true, source: "PRIVATE CODE" };
      return { unexpected: true, source: "PRIVATE CODE" };
    },
    scopeFor: () => null,
  } as Engine;
  const value = await localAnalysisDiagnostics(item, engine);
  assert.equal(value.indexRevision, null);
  assert.ok(
    value.failures.some(
      (f) =>
        f.operation === "list_watched_paths" && f.reason.includes("unknown"),
    ),
  );
  const jobFailure = value.failures.find((f) => f.operation === "list_jobs")!;
  assert.match(jobFailure.reason, /NODE_ERROR.*store unavailable/);
  assert.doesNotMatch(
    JSON.stringify(value),
    /BASE64PRIVATE|COOKIEPRIVATE|PRIVATE CODE/,
  );
});

test("certificate diagnostics are bounded, filtered and redacted for only the selected project's current owner", async () => {
  const item = project();
  let selected = "";
  const engine = {
    call: async (_p: Project, name: string) =>
      name === "list_indexed_repositories"
        ? { repos: [{ repo_path: item.path, repo_id: item.repoId }] }
        : name === "get_query_revision"
          ? { ready: false, reason: "branch_publication_incomplete" }
          : { jobs: [], watches: [] },
    scopeFor: () => null,
    certificateDiagnosticsFor: (id: string) => {
      selected = id;
      return [
        "PRIVATE SOURCE BODY",
        ...Array.from(
          { length: 12 },
          (_, i) =>
            `certificate ${i}: stored files differ Bearer PRIVATE-CAP ${"x".repeat(800)}`,
        ),
      ];
    },
  } as Engine;
  const value = await localAnalysisDiagnostics(item, engine);
  assert.equal(selected, item.id);
  assert.equal(value.engineDiagnostics!.length, 8);
  assert.ok(value.engineDiagnostics!.join("").length <= 4000);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE SOURCE BODY|PRIVATE-CAP/);
});

test("matching job paths cannot override a conflicting repository identity and copied diagnostics remain bounded", async () => {
  const item = project(),
    long = "z".repeat(5000);
  const engine = {
    call: async (_p: Project, name: string) => {
      if (name === "list_indexed_repositories")
        return {
          repos: [
            {
              repo_path: item.path,
              repo_id: item.repoId,
              index_state_reason: long,
              summary_error: long,
            },
          ],
        };
      if (name === "list_jobs")
        return {
          jobs: [
            {
              id: "wrong-id",
              repo_id: "foreign",
              runtime_context: { requested_path: item.path },
            },
            ...Array.from({ length: 20 }, (_, i) => ({
              id: `job-${i}`,
              repo_id: item.repoId,
              message: long,
              error: long,
              warning: long,
              stage: long,
              status: long,
              created_at: long,
              runtime_context: {
                requested_path: item.path,
                store_path: long,
                mode: long,
              },
              progress: { unit: long },
            })),
          ],
        };
      if (name === "list_watched_paths") return { watches: [] };
      return {
        ready: false,
        reason: long,
        note: long,
        mismatched_paths: Array.from({ length: 30 }, () => long),
      };
    },
    scopeFor: () => null,
  } as Engine;
  const value = await localAnalysisDiagnostics(item, engine);
  assert.ok(value.jobs.every((job) => job.id !== "wrong-id"));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 32768);
});
