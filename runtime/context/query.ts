import type { ContextBinding, ContextPack, GraphClient } from "./contracts";
import { recordSavedReadCoverage } from "./saved-read";
import { verifiedIndexRevision } from "../memtrace-peer-index";

export type Row = Record<string, any>;
export type Query = (name: string, args: Row) => Promise<Row | null>;

export function scopedQuery(
  engine: GraphClient,
  binding: ContextBinding,
  calls: string[],
  coverage: ContextPack["coverage"],
): Query {
  return async (name, args) => {
    calls.push(name);
    try {
      const governance =
        ["governing_rules", "recall_decision"].includes(name) &&
        binding.governanceProject;
      const project = governance || binding.project;
      const result = await engine.call(
        project,
        name,
        governance && args.repo_id
          ? { ...args, repo_id: project.repoId }
          : args,
      );
      checkAdmission(result);
      if (
        name === "get_query_revision" &&
        binding.project.analysisCheckout === "owned-worktree-v1" &&
        !verifiedIndexRevision(result, binding.project, binding.project.repoId!)
      )
        throw Error(
          "The selected epic worktree graph is not certified. No other branch's graph can substitute for it.",
        );
      recordCoverage(name, result, coverage);
      recordSavedReadCoverage(result, binding, coverage);
      return result ?? null;
    } catch (error) {
      coverage.unknown.push(`${name}: ${(error as Error).message}`);
      return null;
    }
  };
}
function checkAdmission(result: Row | null): void {
  if (
    result?.status === "repo_not_in_store" ||
    result?.error === "repo_not_in_store" ||
    result?.diagnostic?.repo_lives_in
  )
    throw new Error(
      "Repository is not admitted by this Memtrace runtime; route to its verified owner.",
    );
}
function recordCoverage(
  name: string,
  result: Row | null,
  coverage: ContextPack["coverage"],
): void {
  if (!result) return;
  if (
    result.truncated ||
    result.graph_truncated ||
    result.graph_incomplete ||
    result.total_affected_is_lower_bound
  )
    coverage.truncated.push(
      `${name}: backend reports incomplete or truncated graph coverage.`,
    );
  if (
    result.status &&
    !["complete", "ok", "current", "observed"].includes(result.status)
  )
    coverage.unknown.push(`${name}: ${result.status}`);
  if (result.incomplete_reasons?.length)
    coverage.unknown.push(
      `${name}: ${JSON.stringify(result.incomplete_reasons)}`,
    );
}
