import { readFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import type {
  Constraint,
  ContextBinding,
  ContextPack,
  ContextRequest,
} from "./contracts";
import { checkedPath, hash, normalizedPath } from "./source";
import type { Query } from "./query";

function projectRulePaths(files: string[]): Set<string> {
  const paths = new Set(["AGENTS.md"]);
  for (const file of files) {
    let dir = normalizedPath(dirname(file));
    while (dir && dir !== ".") {
      paths.add(posix.join(dir, "AGENTS.md"));
      const next = posix.dirname(dir);
      if (next === dir) break;
      dir = next;
    }
  }
  return paths;
}
export async function loadConstraints(
  binding: ContextBinding,
  files: string[],
  query: Query,
): Promise<Constraint[]> {
  const constraints: Constraint[] = [];
  for (const file of files) {
    const result = await query("governing_rules", {
      repo_id: binding.project.repoId,
      file_path: file,
    });
    for (const [i, rule] of (result?.rules ?? []).entries())
      constraints.push({
        id: `governance:${file}:${i}`,
        origin: "governing_rules",
        text: typeof rule === "string" ? rule : JSON.stringify(rule),
      });
  }
  for (const file of projectRulePaths(files)) {
    try {
      // Project rules apply even when narrow source visibility excludes their path.
      const path = await checkedPath({ ...binding, scope: [] }, file),
        text = await readFile(path.absolute, "utf8");
      constraints.push({
        id: `project:${file}`,
        origin: "project-rules",
        text,
        ref: {
          file,
          startLine: 1,
          endLine: text.split(/\r?\n/).length,
          sha256: hash(text),
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return constraints;
}
export function evidenceFiles(pack: ContextPack): string[] {
  return [
    ...new Set(
      pack.evidence.flatMap((item) => (item.ref ? [item.ref.file] : [])),
    ),
  ];
}
export async function refreshConstraints(
  binding: ContextBinding,
  request: ContextRequest,
  pack: ContextPack,
  files: string[],
  query: Query,
): Promise<void> {
  pack.constraints = await loadConstraints(
    binding,
    [...new Set(files.concat(evidenceFiles(pack)))],
    query,
  );
  pack.revision.constraintsDigest = hash(JSON.stringify(pack.constraints));
  const recall = decisionQuery(request);
  const decisions = await query("recall_decision", {
    query: `${binding.governanceProject?.repoId ?? binding.project.repoId} ${recall}`,
    top_k: 4,
  });
  if (decisions)
    pack.evidence.push({
      id: "decisions",
      kind: "decision",
      text: JSON.stringify(decisions),
      origin:
        "recall_decision; ranked historical candidates, applicability may be unknown",
    });
  else
    pack.coverage.unknown.push(
      "Decision memory unavailable; absence of constraints is not established.",
    );
}
function decisionQuery(request: ContextRequest): string {
  if (request.capability === "find") return request.query;
  if (request.capability === "understand")
    return request.target.symbol + " " + (request.question ?? "");
  return request.intent;
}
