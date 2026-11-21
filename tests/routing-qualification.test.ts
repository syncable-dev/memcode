import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { git } from "../runtime/local";
import { collectEvidence, refreshEvidence } from "../runtime/qualification";
import type { Project, WorkItem } from "../src/shared";

const graphMeta = (token = "published-a") => ({
  graph_revision: { token, publication_unchanged_during_call: true },
});

async function fixture(t: TestContext, changePublication = false) {
  const folder = await mkdtemp(join(tmpdir(), "memcode-routing-fixture-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await mkdir(join(folder, "src"));
  const source = [
    "export function loadBoard() {",
    "  return read();",
    "}",
    "",
    "export function saveBoard() {",
    "  return write();",
    "}",
  ].join("\n");
  await writeFile(join(folder, "src", "board.ts"), source, "utf8");
  await git(folder, ["init", "-b", "main"]);
  await git(folder, ["add", "--", "src/board.ts"]);
  await git(folder, [
    "-c",
    "user.name=MemCode Test",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  const sourceCommit = await git(folder, ["rev-parse", "HEAD"]);
  const project: Project = {
    id: "fixture",
    repoId: "fixture",
    branch: "main",
    analysis: "ready",
    name: "Fixture",
    description: "",
    createdAt: "2026-11-20",
    path: folder,
  };
  const task: WorkItem = {
    id: "story",
    projectId: project.id,
    identifier: "RT-1",
    title: "Refactor board persistence",
    description:
      "Refactor `src/board.ts:2` and `saveBoard` without changing behavior.",
    stage: "planned",
    priority: "medium",
    category: "Tests",
    harness: "codex",
    assignment: "auto",
    kind: "refactor",
    checklist: [],
    messages: [],
    createdAt: "2026-11-20",
    updatedAt: "2026-11-20",
    run: { state: "idle" },
  };
  const functions = [
    { name: "loadBoard", node_id: "load", start_line: 1, end_line: 3 },
    { name: "saveBoard", node_id: "save", start_line: 5, end_line: 7 },
  ].map((row) => ({
    ...row,
    kind: "Function",
    file_path: "src/board.ts",
    is_exported: true,
  }));
  const shared = {
    node_id: "shared",
    file_path: "tests/board.test.ts",
    kind: "Function",
  };
  const separate = {
    node_id: "extra",
    file_path: "src/route.ts",
    kind: "Module",
  };
  const requests: Array<{ name: string; arguments: Record<string, unknown> }> =
    [];
  const client = {
    call: async (
      checkout: Project,
      tool: string,
      args: Record<string, unknown>,
    ) => {
      requests.push({ name: tool, arguments: args });
      assert.equal(checkout, project);
      assert.equal(args.repo_id, project.repoId);
      if (tool === "get_query_revision")
        return {
          ready: true,
          branch: project.branch,
          token: "bound-revision",
          source_commit: sourceCommit,
          source_revision: "content-fingerprint",
          _meta: graphMeta(),
        };
      assert.equal(args.branch, project.branch);
      if (tool === "get_symbol_context") {
        const symbol =
          args.symbol === "board.ts"
            ? {
                name: "board.ts",
                kind: "File",
                file_path: "src/board.ts",
                node_id: "file",
              }
            : functions.find((functionRow) => functionRow.name === args.symbol);
        return {
          found: !!symbol,
          symbol,
          contains: args.symbol === "board.ts" ? functions : [],
          pagination: {
            contains: { next_offset: null, available_is_lower_bound: false },
          },
          _meta: graphMeta(),
        };
      }
      if (tool === "find_code")
        return { results: functions, status: "complete", _meta: graphMeta() };
      if (tool === "get_function_quality_metrics")
        return {
          matches: 1,
          _meta: graphMeta(),
          function: {
            ...functions.find((row) => row.name === args.function_name),
            complexity_source: "ast",
            cognitive_complexity: 4,
            complexity: 2,
            max_nesting: 1,
            quality_metrics_v: 1,
            maintainability_index:
              args.function_name === "loadBoard" ? 0 : 72.4,
          },
        };
      if (tool === "get_impact") {
        const rows = args.target === "load" ? [shared] : [shared, separate];
        return {
          found: true,
          risk: "LOW",
          target: { node_id: args.target },
          by_depth: { 1: rows },
          total_affected: rows.length,
          affected_files: rows.map((row) => row.file_path),
          affected_processes: [{ id: "flow" }],
          _meta: graphMeta(
            changePublication && args.target === "save"
              ? "published-b"
              : "published-a",
          ),
        };
      }
      throw Error(`Unexpected graph tool ${tool}`);
    },
  };
  return { project, task, client, requests };
}

test("exact line and symbol qualification deduplicates callers, files and flows", async (t) => {
  const { project, task, client, requests } = await fixture(t);
  const evidence = await collectEvidence(client, project, task);
  assert.equal(evidence.state, "measured", evidence.note);
  assert.deepEqual(
    evidence.symbols.map((symbol) => symbol.name),
    ["loadBoard", "saveBoard"],
  );
  assert.deepEqual(
    evidence.symbols.map((symbol) => symbol.maintainabilityIndex),
    [0, 72.4],
  );
  assert.equal(
    requests.filter(
      (request) => request.name === "get_function_quality_metrics",
    ).length,
    2,
  );
  assert.deepEqual(evidence.impact, {
    targetCount: 2,
    observedTargets: 2,
    basis: "confirmed",
    incomplete: false,
    affectedSymbols: 2,
    affectedFiles: 2,
    affectedProcesses: 1,
    affectedModules: 1,
  });
  assert.deepEqual(evidence.scopeCoverage, {
    confirmedTargets: 2,
    inferredTargets: 0,
    unresolvedReferences: 0,
    measuredTargets: 2,
    incomplete: false,
    nearbyTests: 1,
    publicContracts: 2,
  });
  assert.equal(evidence.sourceRevision, "content-fingerprint");
  assert.ok(!requests.some((request) => request.name === "find_code"));
  assert.equal(
    requests.filter((request) => request.name === "get_query_revision").at(-1)
      ?.arguments.expected_revision,
    "bound-revision",
  );
  assert.deepEqual(
    requests
      .filter((request) => request.name === "get_impact")
      .map((request) => request.arguments.target),
    ["load", "save"],
  );
});

test("a mixed publication discards grouped impact and AST metrics", async (t) => {
  const { project, task, client } = await fixture(t, true);
  const evidence = await collectEvidence(client, project, task);
  assert.equal(evidence.state, "partial");
  assert.match(evidence.note, /changed while/);
  assert.equal(evidence.scopeCoverage?.measuredTargets, 0);
  assert.equal(evidence.affected, undefined);
  assert.equal(evidence.impact?.observedTargets, 0);
  assert.deepEqual(evidence.symbols, []);
});

test("invalid, estimated, or versionless maintainability stays unknown", async (t) => {
  const { project, task, client } = await fixture(t);
  for (const overrides of [
    { maintainability_index: 101 },
    { maintainability_index: undefined },
    { complexity_source: "estimated" },
    { quality_metrics_v: undefined },
    { node_id: "different-symbol" },
  ]) {
    const evidence = await collectEvidence(
      {
        async call(checkout, name, args) {
          const response = await client.call(checkout, name, args);
          if (name !== "get_function_quality_metrics") return response;
          return {
            ...response,
            function: { ...response.function, ...overrides },
          };
        },
      },
      project,
      task,
    );
    assert.equal(evidence.symbols.length, 2);
    assert.ok(
      evidence.symbols.every(
        (symbol) => symbol.maintainabilityIndex === undefined,
      ),
    );
  }
});

test("a stale index excludes maintainability from both fresh reads and cached story evidence", async (t) => {
  const { project, task, client } = await fixture(t);
  const evidence = await collectEvidence(client, project, task);
  const staleClient = {
    async call(checkout: Project, name: string, args: Record<string, unknown>) {
      const response = await client.call(checkout, name, args);
      return name === "get_query_revision"
        ? {
            ...response,
            ready: false,
            mismatched_files: 1,
            mismatched_paths: ["src/board.ts"],
          }
        : response;
    },
  };
  const reevaluated = await collectEvidence(staleClient, project, task);
  assert.equal(reevaluated.state, "partial");
  assert.equal(reevaluated.symbols[0].cognitive, 4);
  assert.equal(reevaluated.symbols[0].maintainabilityIndex, undefined);
  const [refreshed] = await refreshEvidence(staleClient, project, [
    { ...task, evidence },
  ]);
  assert.equal(refreshed.action, "stale");
  assert.equal(refreshed.evidence?.symbols[0].maintainabilityIndex, undefined);
});

test("a changed work request refreshes evidence on the same checkout", async (t) => {
  const { project, task, client } = await fixture(t);
  const evidence = await collectEvidence(client, project, task);
  const [result] = await refreshEvidence(client, project, [
    {
      ...task,
      evidence,
      description: "Refactor `loadBoard` without changing behavior.",
    },
  ]);
  assert.equal(result.action, "refreshed");
  assert.deepEqual(
    result.evidence?.symbols.map((symbol) => symbol.name),
    ["loadBoard"],
  );
  assert.notEqual(
    result.evidence?.binding?.requestFingerprint,
    evidence.binding?.requestFingerprint,
  );
});

test("partial impact totals without identities give a lower bound and never add together", async (t) => {
  const { project, task, client } = await fixture(t);
  const evidence = await collectEvidence(
    {
      call: (checkout, tool, args) =>
        tool === "get_impact"
          ? Promise.resolve({
              found: true,
              target: { node_id: args.target },
              risk: "UNKNOWN",
              total_affected: args.target === "load" ? 11 : 14,
              affected_files: [],
              affected_processes: [],
              _meta: graphMeta(),
            })
          : client.call(checkout, tool, args),
    },
    project,
    task,
  );
  assert.equal(evidence.state, "partial");
  assert.equal(evidence.affected, 14);
  assert.equal(evidence.affectedFiles, undefined);
  assert.equal(evidence.affectedProcesses, undefined);
  assert.equal(evidence.impact?.incomplete, true);
});

test("an epic cannot adopt measurements from another checkout", async (t) => {
  const { project, task, client } = await fixture(t);
  project.analysisCheckout = "owned-worktree-v1";
  const evidence = await collectEvidence(client, project, task);
  assert.equal(evidence.state, "partial");
  assert.match(evidence.note, /different checkout/);
  assert.deepEqual(evidence.symbols, []);
  assert.equal(evidence.impact?.affectedSymbols, undefined);
});
