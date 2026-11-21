import type { RoutingImpactEvidence } from "../src/routing-evidence";
import {
  isNearbyTest,
  type QualificationRead,
  type QualificationTarget,
} from "./qualification-targets";

type ImpactRow = Record<string, any>;
const TARGET_LIMIT = 5;
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const path = (value: string) => {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
const entries = (value: unknown): ImpactRow[] =>
  Array.isArray(value)
    ? value.filter((row) => !!row && typeof row === "object")
    : [];

interface Observations {
  identities: Set<string>;
  floor?: number;
}
const observations = (): Observations => ({ identities: new Set() });
function recordFloor(
  group: Observations,
  observed: number | undefined,
  usableZero: boolean,
) {
  if (observed !== undefined && (observed > 0 || usableZero))
    group.floor = Math.max(group.floor ?? 0, observed);
}
function unionSize(group: Observations) {
  return group.floor !== undefined || group.identities.size > 0
    ? Math.max(group.floor ?? 0, group.identities.size)
    : undefined;
}

export async function collectQualificationImpact(
  confirmed: QualificationTarget[],
  inferred: QualificationTarget[],
  repoId: string,
  read: QualificationRead,
  scopeIncomplete: boolean,
): Promise<{ impact: RoutingImpactEvidence; testPaths: Set<string> }> {
  const targets = confirmed.length ? confirmed : inferred;
  const testPaths = new Set<string>();
  const symbols = observations(),
    files = observations(),
    processes = observations();
  const modules = new Set<string>();
  const namedOnlyFiles = new Set<string>(),
    typedFiles = new Set<string>();
  let observedTargets = 0;
  let incomplete =
    scopeIncomplete || !confirmed.length || targets.length > TARGET_LIMIT;
  const scans = targets.slice(0, TARGET_LIMIT);
  // Batches bound contention with Memtrace's graph maintenance lane.
  for (let offset = 0; offset < scans.length; offset += 2) {
    const batch = scans.slice(offset, offset + 2);
    const answers = await Promise.all(
      batch.map((target) =>
        read("get_impact", {
          target: target.nodeId ?? target.scopePath ?? target.name,
          file_path: target.file,
          direction: "upstream",
          depth: 3,
        }),
      ),
    );
    for (const [index, answer] of answers.entries()) {
      const target = batch[index];
      if (
        answer?.found !== true ||
        (answer.target?.node_id &&
          target.nodeId &&
          answer.target.node_id !== target.nodeId)
      ) {
        incomplete = true;
        continue;
      }
      observedTargets++;
      const partial =
        answer.risk === "UNKNOWN" ||
        answer.graph_incomplete === true ||
        answer.truncated === true ||
        answer.total_affected_is_lower_bound === true;
      const rows = Object.values(answer.by_depth ?? {}).flatMap(entries);
      const seenSymbols = new Set<string>();
      for (const row of rows) {
        const repo = text(row.repo_id) || repoId,
          file = path(text(row.file_path));
        const stableId = text(row.node_id ?? row.id);
        if (stableId) {
          const identity = `${repo}\0${stableId}`;
          seenSymbols.add(identity);
          symbols.identities.add(identity);
          if (row.kind === "Module") modules.add(identity);
        }
        if (file) {
          typedFiles.add(file);
          files.identities.add(`${repo}\0${file}`);
          if (repo === repoId && isNearbyTest(file)) testPaths.add(file);
        }
      }
      const namedFiles = new Set<string>();
      for (const entry of Array.isArray(answer.affected_files)
        ? answer.affected_files
        : []) {
        const file = path(
          typeof entry === "string"
            ? entry
            : text(entry?.file_path ?? entry?.path),
        );
        if (!file) continue;
        namedFiles.add(file);
        const repo = typeof entry === "object" ? text(entry?.repo_id) : "";
        if (repo) {
          typedFiles.add(file);
          files.identities.add(`${repo}\0${file}`);
          if (repo === repoId && isNearbyTest(file)) testPaths.add(file);
        } else namedOnlyFiles.add(file);
      }
      const seenProcesses = new Set<string>();
      for (const entry of Array.isArray(answer.affected_processes)
        ? answer.affected_processes
        : []) {
        const id =
          typeof entry === "string" ? entry : text(entry?.node_id ?? entry?.id);
        if (!id) continue;
        const identity = `${text(entry?.repo_id) || repoId}\0${id}`;
        seenProcesses.add(identity);
        processes.identities.add(identity);
      }
      const total = count(answer.total_affected);
      const totalFiles =
        count(answer.affected_files_count) ??
        (Array.isArray(answer.affected_files)
          ? answer.affected_files.length
          : undefined);
      const totalProcesses =
        count(answer.affected_processes_count) ??
        (Array.isArray(answer.affected_processes)
          ? answer.affected_processes.length
          : undefined);
      // A legacy or truncated answer may report counts without identities.
      // The largest known single-target count is a safe union lower bound.
      recordFloor(symbols, total, !partial);
      recordFloor(files, totalFiles, !partial);
      recordFloor(processes, totalProcesses, !partial);
      incomplete ||=
        partial ||
        total !== seenSymbols.size ||
        totalFiles !== namedFiles.size ||
        totalProcesses !== seenProcesses.size;
    }
  }
  for (const file of namedOnlyFiles) {
    if (!typedFiles.has(file)) files.identities.add(file);
  }
  return {
    impact: {
      targetCount: targets.length,
      observedTargets,
      basis: confirmed.length ? "confirmed" : "inferred",
      incomplete,
      affectedSymbols: unionSize(symbols),
      affectedFiles: unionSize(files),
      affectedProcesses: unionSize(processes),
      affectedModules: modules.size || undefined,
    },
    testPaths,
  };
}
