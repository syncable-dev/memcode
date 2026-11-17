import type { WorkItem } from "../src/shared";
import type { Project } from "../src/shared";
import { isAbsolute, relative, resolve } from "node:path";

export function touchedIdentities(task: WorkItem, project?: Project): string[] {
  const symbols = (task.evidence?.symbols ?? []).map(
    (symbol) => symbol.nodeId ?? `${symbol.file}::${symbol.name}`,
  );
  const files = [
    ...(task.scope ?? []),
    ...(task.evidence?.symbols ?? []).map((symbol) => symbol.file),
  ].map((path) => {
    // Private graph UUIDs can differ from canonical graph UUIDs. The same
    // source file still needs one shared identity within the canonical repo.
    let local = path;
    if (isAbsolute(path) && task.run.workspace) {
      const candidate = relative(task.run.workspace, path);
      if (
        !isAbsolute(candidate) &&
        candidate !== ".." &&
        !candidate.startsWith("../") &&
        !candidate.startsWith("..\\")
      )
        local = candidate;
    }
    const full = resolve(
      project?.path ?? task.run.workspace ?? ".",
      local,
    ).replaceAll("\\", "/");
    return (
      "file::" + (process.platform === "win32" ? full.toLowerCase() : full)
    );
  });
  return [...new Set([...symbols, ...files])];
}
// A declared work category, not a semantic classification of the resulting diff.
export function declaredIntent(task: WorkItem): unknown {
  if (task.kind === "test")
    return { test_add: { covers: touchedIdentities(task) } };
  if (task.kind === "research") return "exploratory";
  if (task.kind === "refactor")
    return { refactor: { pattern: "extract_function" } };
  if (task.kind === "fix") return { bug_fix: { defect: "logic_error" } };
  return { feature_add: { surface: "new_symbol" } };
}
