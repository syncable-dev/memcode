import test from "node:test";
import assert from "node:assert/strict";
import { scopedQuery } from "../runtime/context/query";
import type { ContextBinding, ContextPack } from "../runtime/context/contracts";
import type { Project } from "../src/shared";

test("epic source facts stay private while accepted repository governance stays shared", async () => {
  const canonical: Project = {
    id: "project",
    path: "/repo",
    name: "Repo",
    description: "",
    repoId: "canonical",
    branch: "main",
    analysis: "ready",
    createdAt: "2026-11-17",
  };
  const epic: Project = {
    ...canonical,
    id: "project:epic:a",
    path: "/epic-a",
    repoId: "private-a",
    branch: "epic/a",
    analysisCheckout: "owned-worktree-v1",
  };
  const binding: ContextBinding = {
    project: epic,
    governanceProject: canonical,
    branch: epic.branch,
    workerId: "worker-a",
    scope: [],
  };
  const calls: Array<{ id: string; name: string; repo: unknown }> = [];
  const coverage: ContextPack["coverage"] = {
    status: "partial",
    unknown: [],
    truncated: [],
    constraintsRemaining: 0,
    canAct: true,
  };
  const query = scopedQuery(
    {
      call: async (project, name, args) => {
        calls.push({ id: project.id, name, repo: args.repo_id });
        return { status: "ok", marker: project.repoId };
      },
    },
    binding,
    [],
    coverage,
  );
  assert.equal(
    (await query("find_code", { repo_id: "private-a", query: "invitation" }))!
      .marker,
    "private-a",
  );
  assert.equal(
    (await query("governing_rules", {
      repo_id: "private-a",
      file_path: "src/invitation.ts",
    }))!.marker,
    "canonical",
  );
  assert.equal(
    (await query("get_impact", { repo_id: "private-a", target: "invitation" }))!
      .marker,
    "private-a",
  );
  await query("recall_decision", { query: "canonical invitation" });
  assert.deepEqual(
    calls.map((x) => x.id),
    [epic.id, canonical.id, epic.id, canonical.id],
  );
  assert.equal(calls[1].repo, "canonical");
});

test("a canonical ready certificate can never qualify an owned epic's source pack", async () => {
  const project: Project = {
    id: "epic",
    path: "/epic-a",
    name: "Epic",
    description: "",
    repoId: "private-a",
    branch: "epic/a",
    analysis: "ready",
    analysisCheckout: "owned-worktree-v1",
    createdAt: "2026-11-17",
  };
  const coverage: ContextPack["coverage"] = {
    status: "partial",
    unknown: [],
    truncated: [],
    constraintsRemaining: 0,
    canAct: true,
  };
  const query = scopedQuery(
    {
      call: async () => ({
        ready: true,
        branch: "main",
        worktree: "/canonical",
        repo_id: "canonical",
      }),
    },
    { project, workerId: "worker", branch: project.branch, scope: [] },
    [],
    coverage,
  );
  assert.equal(
    await query("get_query_revision", { repo_id: project.repoId }),
    null,
  );
  assert.match(
    coverage.unknown.join(" "),
    /epic worktree graph is not certified/,
  );
});
