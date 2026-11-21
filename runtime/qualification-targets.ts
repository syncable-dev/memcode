import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { Project, WorkItem } from "../src/shared";
import { normalizedPath, repoFiles, visible } from "./context/source";
import { within } from "./local";
import type { RoutingIntentAnalysis } from "./routing-intent";

type Row = Record<string, any>;
export type QualificationRead = (
  name: string,
  args: Row,
) => Promise<Row | undefined>;
export interface QualificationTarget {
  name: string;
  file: string;
  line: number;
  endLine: number;
  kind: string;
  nodeId?: string;
  scopePath?: string;
  exported: boolean;
}

const FILE_LIMIT = 4;
const SYMBOL_LIMIT = 5;
const SAMPLE_LIMIT = 8;
const excluded =
  /(^|\/)(\.git|\.memcode|\.memdb|\.memtrace|node_modules|target|dist|dist-runtime)(\/|$)/;
const containers = new Set([
  "Class",
  "Struct",
  "Interface",
  "Trait",
  "Module",
  "Namespace",
]);
export const isNearbyTest = (file: string) =>
  /(?:^|[/\\])(?:tests?|__tests__)[/\\]|\.(?:test|spec)\./i.test(file);
const callable = (target: QualificationTarget) =>
  target.kind === "Function" || target.kind === "Method";
const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pathKey = (file: string) =>
  process.platform === "win32" ? file.toLowerCase() : file;
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const lineNumber = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
const list = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((row) => !!row && typeof row === "object")
    : [];
const identity = (target: QualificationTarget) =>
  target.nodeId ??
  `${pathKey(target.file)}:${target.line}:${target.kind}:${target.scopePath ?? target.name}`;
const distinct = (targets: QualificationTarget[]) => [
  ...new Map(targets.map((target) => [identity(target), target])).values(),
];

async function checkoutPath(root: string, file: string, directory = false) {
  if (file.split(/[/\\]/).includes("..")) return undefined;
  try {
    const absolute = await realpath(resolve(root, file));
    const key = normalizedPath(relative(root, absolute));
    if (!key || !within(root, absolute) || excluded.test(key)) return undefined;
    const info = await stat(absolute);
    if (info.isFile() || (directory && info.isDirectory())) return key;
  } catch {
    return undefined;
  }
}

function targetFrom(
  row: Row | undefined,
  project: Project,
  root?: string,
): QualificationTarget | undefined {
  if (
    !row ||
    (row.repo_id && row.repo_id !== project.repoId) ||
    (row.branch && row.branch !== project.branch)
  )
    return;
  const rawFile = text(row.file_path),
    name = text(row.name),
    kind = text(row.kind);
  if (!rawFile || !name || !kind) return;
  const file = normalizedPath(
    root && isAbsolute(rawFile) && within(root, rawFile)
      ? relative(root, rawFile)
      : rawFile,
  );
  if (
    /^(?:\/|[A-Za-z]:)|(?:^|\/)\.\.(?:\/|$)/.test(file) ||
    excluded.test(file)
  )
    return;
  const line = lineNumber(row.symbol_start_line ?? row.start_line);
  return {
    name,
    kind,
    file,
    line,
    endLine: lineNumber(row.symbol_end_line ?? row.end_line) || line,
    nodeId: text(row.node_id) || undefined,
    scopePath: text(row.scope_path) || undefined,
    exported: row.is_exported === true || kind === "APIEndpoint",
  };
}

function exactLine(entries: QualificationTarget[], line: number) {
  const matches = entries
    .filter((row) => row.line > 0 && row.line <= line && row.endLine >= line)
    .sort((a, b) => a.endLine - a.line - (b.endLine - b.line));
  const best = matches[0],
    other = matches[1];
  if (best && (!other || best.endLine - best.line < other.endLine - other.line))
    return best;
}

function containsClipped(context: Row) {
  const page = context.pagination?.contains;
  if (page)
    return page.next_offset != null || page.available_is_lower_bound === true;
  return context.truncated === true || context.graph_truncated === true;
}

export async function resolveQualificationTargets(
  project: Project,
  task: WorkItem,
  intent: RoutingIntentAnalysis,
  read: QualificationRead,
) {
  const root = project.path
    ? await realpath(project.path).catch(() => undefined)
    : undefined;
  const { paths, symbols, errors } = intent.references;
  const declared = task.scope ?? [];
  const fileHints = [
    ...declared.map((file) => ({ file, line: undefined, declared: true })),
    ...paths.map((ref) => ({ ...ref, declared: false })),
  ];
  const requestedFiles = new Map<string, (typeof fileHints)[number]>();
  for (const hint of fileHints) {
    const key = `${pathKey(normalizedPath(hint.file))}:${hint.line ?? ""}`;
    if (!requestedFiles.has(key)) requestedFiles.set(key, hint);
  }
  let unresolved =
    Math.max(0, requestedFiles.size - FILE_LIMIT) +
    Math.max(0, symbols.length - SYMBOL_LIMIT);
  let incomplete = false;
  const confirmed: QualificationTarget[] = [],
    inferred: QualificationTarget[] = [];
  const resolvedFiles: string[] = [],
    declaredPaths: string[] = [];
  const fileContexts = new Map<
    string,
    Awaited<ReturnType<QualificationRead>>
  >();
  const incompleteFiles = new Set<string>();
  let fileInventory: Promise<string[]> | undefined;
  const candidates = (rows: Row[]) =>
    rows.flatMap((row) => targetFrom(row, project, root) ?? []);
  if (project.path && !root) {
    return {
      confirmed,
      inferred,
      sourceFiles: resolvedFiles,
      symbols: [],
      unresolved: requestedFiles.size + symbols.length,
      incomplete: true,
    };
  }

  for (const reference of [...requestedFiles.values()].slice(0, FILE_LIMIT)) {
    let file = root
      ? await checkoutPath(root, reference.file, reference.declared)
      : reference.file;
    if (!file && root && !reference.file.includes("/") && !reference.declared) {
      fileInventory ??= repoFiles(root).catch(() => []);
      const matches = (await fileInventory).filter(
        (entry) => pathKey(basename(entry)) === pathKey(reference.file),
      );
      if (matches.length === 1) file = await checkoutPath(root, matches[0]);
    }
    if (!file) {
      unresolved++;
      continue;
    }
    if (reference.declared) declaredPaths.push(file);
    if (
      !reference.declared &&
      declared.length &&
      (!declaredPaths.length ||
        !visible(pathKey(file), declaredPaths.map(pathKey)))
    ) {
      unresolved++;
      continue;
    }
    resolvedFiles.push(file);
    if (!fileContexts.has(file))
      fileContexts.set(
        file,
        await read("get_symbol_context", {
          symbol: basename(file),
          file_path: file,
          limit: 64,
        }),
      );
    const context = fileContexts.get(file);
    const target = targetFrom(context?.symbol, project, root);
    if (
      !context?.found ||
      context.ambiguous ||
      (target && pathKey(target.file) !== pathKey(file))
    ) {
      unresolved++;
      continue;
    }
    const declarations = candidates(list(context.contains)).filter(
      (row) => pathKey(row.file) === pathKey(file),
    );
    const clipped = containsClipped(context);
    if (reference.line) {
      let match = exactLine(declarations, reference.line);
      if (match && containers.has(match.kind) && match.nodeId) {
        const container = await read("get_symbol_context", {
          symbol: match.nodeId,
          file_path: file,
          limit: 64,
        });
        if (
          container?.found &&
          !container.ambiguous &&
          targetFrom(container.symbol, project, root)?.nodeId === match.nodeId
        ) {
          const members = candidates(list(container.contains)).filter(
            (row) => pathKey(row.file) === pathKey(file),
          );
          match = exactLine(members, reference.line) ?? match;
          incomplete ||= containsClipped(container);
        } else incomplete = true;
      }
      if (match) confirmed.push(match);
      else unresolved++;
      incomplete ||= clipped;
    } else {
      if (target?.kind === "File") confirmed.push(target);
      else unresolved++;
      const callables = declarations.filter(callable);
      inferred.push(...callables.slice(0, SAMPLE_LIMIT));
      if (clipped || callables.length > SAMPLE_LIMIT)
        incompleteFiles.add(pathKey(file));
    }
  }

  const hardScope = declared.length
    ? declaredPaths
    : intent.signals.fileScopeOnly
      ? resolvedFiles
      : undefined;
  const inScope = (target: QualificationTarget) =>
    !hardScope ||
    (hardScope.length > 0 &&
      visible(pathKey(target.file), hardScope.map(pathKey)));
  // An exact file fixes path ambiguity, while an unqualified name still goes
  // through Memtrace's declaration selector and retains its ambiguity verdict.
  for (const symbol of symbols.slice(0, SYMBOL_LIMIT)) {
    const file =
      new Set(resolvedFiles).size === 1 ? resolvedFiles[0] : undefined;
    const context = await read("get_symbol_context", {
      symbol,
      ...(file ? { file_path: file } : {}),
      limit: 4,
    });
    const target = targetFrom(context?.symbol, project, root);
    if (
      !target ||
      !context?.found ||
      context.ambiguous ||
      (target.name !== symbol && target.scopePath !== symbol) ||
      (file && pathKey(file) !== pathKey(target.file)) ||
      !inScope(target) ||
      (root && !(await checkoutPath(root, target.file)))
    ) {
      unresolved++;
      continue;
    }
    confirmed.push(target);
  }

  if (
    intent.searchQuery &&
    (!hardScope || hardScope.length > 0) &&
    ((!confirmed.length && !inferred.length) ||
      unresolved > 0 ||
      errors.length > 0)
  ) {
    const search = await read("find_code", {
      query: intent.searchQuery,
      limit: SAMPLE_LIMIT,
      include_context: true,
      ...(hardScope?.length === 1 ? { file_path: hardScope[0] } : {}),
    });
    const result = candidates(list(search?.results))
      .filter(callable)
      .filter(inScope);
    for (const row of result) {
      if (!root || (await checkoutPath(root, row.file))) inferred.push(row);
    }
    incomplete ||=
      search?.status !== "complete" ||
      !!search.context?.incomplete_reasons?.length;
  }

  const exactMatches = distinct(confirmed.filter(inScope));
  const preciseFiles = new Set(
    exactMatches
      .filter((row) => row.kind !== "File")
      .map((row) => pathKey(row.file)),
  );
  const exact = exactMatches.filter(
    (row) => row.kind !== "File" || !preciseFiles.has(pathKey(row.file)),
  );
  const exactKeys = new Set(exact.map(identity));
  const estimates = distinct(inferred.filter(inScope)).filter(
    (row) =>
      !preciseFiles.has(pathKey(row.file)) && !exactKeys.has(identity(row)),
  );
  // Keep the narrowest verified definition first for UI and Fleet consumers.
  const orderedExact = exact.sort(
    (a, b) =>
      Number(a.kind === "File") - Number(b.kind === "File") ||
      ordinal(a.file, b.file) ||
      a.line - b.line ||
      ordinal(a.name, b.name),
  );
  return {
    confirmed: orderedExact,
    inferred: estimates,
    unresolved,
    incomplete:
      incomplete ||
      unresolved > 0 ||
      [...incompleteFiles].some((file) => !preciseFiles.has(file)),
    sourceFiles: [...new Set(resolvedFiles)].sort(),
    symbols: distinct([
      ...orderedExact.filter(callable),
      ...orderedExact.filter((entry) => entry.kind !== "File"),
      ...estimates,
      ...orderedExact,
    ]).slice(0, SAMPLE_LIMIT),
  };
}
