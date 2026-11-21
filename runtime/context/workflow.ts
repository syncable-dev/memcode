import type { ContextBinding, ContextPack, ContextRequest } from "./contracts";
import type { RetrievalAssistant } from "./local-model";
import { literalSource, normalizedPath, repoRelativePath, visible } from "./source";
import type { Query, Row } from "./query";
import { searchRows, textFallback } from "./workflow-find";
import { targetRows } from "./workflow-target";

export interface Workflow {
  binding: ContextBinding;
  pack: ContextPack;
  query: Query;
  assistant?: RetrievalAssistant;
}
export function relativePath(binding: ContextBinding, raw: string): string {
  return repoRelativePath(binding.project, raw);
}
export function scopeAllowed(binding: ContextBinding, raw: string): boolean {
  return visible(normalizedPath(raw), binding.scope);
}
export function rowVisible(binding: ContextBinding, row: Row): boolean {
  return (
    typeof row.file_path === "string" &&
    scopeAllowed(binding, relativePath(binding, row.file_path))
  );
}
export function queryScope(binding: ContextBinding) {
  return { repo_id: binding.project.repoId, branch: binding.branch };
}

export async function retrieve(
  request: ContextRequest,
  context: Workflow,
): Promise<{ files: string[]; ambiguous: boolean }> {
  if (request.capability !== "find") {
    const result = await targetRows(request, context);
    return {
      files: await verifyRows(result.rows, context),
      ambiguous: result.ambiguous,
    };
  }
  if (request.scope && !scopeAllowed(context.binding, request.scope))
    throw new Error(
      "Requested search scope is outside this worker's visibility",
    );
  if (request.mode === "text") {
    await textFallback(request, context);
    return { files: [], ambiguous: false };
  }
  return {
    files: await verifyRows(await searchRows(request, context), context),
    ambiguous: false,
  };
}
async function verifyRows(rows: Row[], context: Workflow): Promise<string[]> {
  const files: string[] = [],
    { pack, binding } = context;
  for (const row of rows.slice(0, 8)) {
    try {
      const item = await literalSource(
        binding,
        row.file_path,
        row.symbol_start_line ?? row.start_line ?? 1,
        row.symbol_end_line ?? row.end_line ?? row.start_line ?? 1,
        row.kind === "File" ? "" : row.name,
        row.node_id ?? row.id,
      );
      pack.evidence.push(item);
      files.push(item.ref!.file);
      pack.candidates.push({
        symbol: row.name,
        file: item.ref!.file,
        line: item.ref!.startLine,
        nodeId: row.node_id ?? row.id,
      });
      if ((row.symbol_end_line ?? row.end_line ?? 0) > item.ref!.endLine)
        pack.coverage.truncated.push(
          `${item.ref!.file}: source excerpt ends at ${item.ref!.endLine}; declaration continues.`,
        );
    } catch (error) {
      pack.coverage.unknown.push(
        `Source not verified for ${row.name}: ${(error as Error).message}`,
      );
    }
  }
  return files;
}
