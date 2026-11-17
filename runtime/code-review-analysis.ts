import { createHash } from "node:crypto";
import { relative, isAbsolute } from "node:path";
import type { Project } from "../src/shared";
import type {
  CodeReviewFinding,
  CodeReviewMetric,
  CodeReviewEvidence,
  CodeReviewEngineAudit,
  CodeReviewProvenance,
  StoryReviewRun,
} from "../src/code-review";
import type { StoryReviewCapture } from "./code-review-snapshot";

type Json = Record<string, any>;
export interface ReviewEngine {
  call(project: Project, name: string, args: Json): Promise<any>;
}
export interface AnalysisProgress {
  phase: "review" | "quality" | "impact";
  note: string;
}
export interface StoryReviewAnalysis {
  findings: CodeReviewFinding[];
  metrics: CodeReviewMetric[];
  impact: StoryReviewRun["impact"];
  limitations: string[];
  sourceRevision: string | null;
  graphRevision: string | null;
  audit?: CodeReviewEngineAudit;
}

const list = (value: unknown): Json[] =>
  Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object")
    : [];
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const graph = (value: Json | null | undefined) =>
  value?._meta != null &&
  Object.prototype.hasOwnProperty.call(value._meta, "graph_revision")
    ? value._meta.graph_revision
    : value?.graph_revision;
const publication = (value: Json | null | undefined): string | null =>
  text(graph(value)?.token) || null;
const key = (value: string) => {
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};
const sources = new Set<CodeReviewProvenance>([
  "ast",
  "yaml",
  "cross_module",
  "online",
]);
const record = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** This native detector always declares its algorithm's scope, including a successful run. */
function evaluatedSupportedPatterns(name: string, coverage: Json): boolean {
  const known = new Set([
    "status",
    "candidate_fields",
    "source_files_read",
    "source_files_unavailable",
    "source_file_limit",
    "source_budget_reached",
    "requires",
    "supported",
    "unsupported",
    "empty_result_means",
  ]);
  const strings = (value: unknown, expected: string[]) =>
    Array.isArray(value) &&
    value.length === expected.length &&
    new Set(value).size === expected.length &&
    expected.every((item) => value.includes(item));
  return (
    name === "inconsistent_type_consumption" &&
    coverage.status === "evaluated_with_limitations" &&
    Object.keys(coverage).every((key) => known.has(key)) &&
    Number.isSafeInteger(coverage.candidate_fields) &&
    coverage.candidate_fields >= 0 &&
    Number.isSafeInteger(coverage.source_files_read) &&
    coverage.source_files_read >= 0 &&
    Number.isSafeInteger(coverage.source_file_limit) &&
    coverage.source_file_limit > 0 &&
    coverage.source_file_limit <= 64 &&
    coverage.source_files_read < coverage.source_file_limit &&
    coverage.source_files_unavailable === 0 &&
    coverage.source_budget_reached === false &&
    typeof coverage.requires === "string" &&
    typeof coverage.empty_result_means === "string" &&
    strings(coverage.supported, [
      "qualified primitive casts",
      "numeric conversion methods",
      "direct field returns",
      "recognized faithful methods",
    ]) &&
    strings(coverage.unsupported, [
      "arbitrary dataflow or aliases",
      "multiline consumption expressions",
    ])
  );
}

/** Retain native evidence as data, with explicit bounds instead of an unbounded blob. */
function boundedEvidence(value: unknown): {
  value?: CodeReviewEvidence;
  truncated: boolean;
} {
  let remaining = 12000,
    nodes = 256,
    truncated = false;
  const spend = (size: number) => {
    if (remaining < size) {
      truncated = true;
      return false;
    }
    remaining -= size;
    return true;
  };
  const visit = (
    input: unknown,
    depth: number,
  ): CodeReviewEvidence | undefined => {
    if (--nodes < 0 || depth > 6) {
      truncated = true;
      return;
    }
    if (
      input === null ||
      typeof input === "boolean" ||
      (typeof input === "number" && Number.isFinite(input))
    )
      return spend(JSON.stringify(input).length)
        ? (input as null | boolean | number)
        : undefined;
    if (typeof input === "string") {
      let bounded = input.slice(0, 2000);
      truncated ||= bounded.length !== input.length;
      while (
        bounded.length &&
        Buffer.byteLength(JSON.stringify(bounded)) > remaining
      )
        ((bounded = bounded.slice(0, Math.floor(bounded.length / 2))),
          (truncated = true));
      return spend(Buffer.byteLength(JSON.stringify(bounded)))
        ? bounded
        : undefined;
    }
    if (Array.isArray(input)) {
      if (!spend(2)) return;
      const result: CodeReviewEvidence[] = [];
      truncated ||= input.length > 32;
      for (const item of input.slice(0, 32)) {
        if (!spend(1)) break;
        const child = visit(item, depth + 1);
        if (child === undefined) {
          truncated = true;
          break;
        }
        result.push(child);
      }
      return result;
    }
    if (record(input)) {
      if (!spend(2)) return;
      const result: Record<string, CodeReviewEvidence> = {};
      const entries = Object.entries(input);
      truncated ||= entries.length > 32;
      for (const [name, item] of entries.slice(0, 32)) {
        if (
          name.length > 120 ||
          /[\x00-\x1f]/.test(name) ||
          ["__proto__", "prototype", "constructor"].includes(name)
        ) {
          truncated = true;
          continue;
        }
        if (!spend(Buffer.byteLength(JSON.stringify(name)) + 2)) break;
        const child = visit(item, depth + 1);
        if (child === undefined) {
          truncated = true;
          continue;
        }
        result[name] = child;
      }
      return result;
    }
    truncated = true;
  };
  return {
    value: visit(value, 0),
    get truncated() {
      return truncated;
    },
  };
}

function reviewAudit(
  value: Json,
  limitations: Set<string>,
): CodeReviewEngineAudit {
  const audit: CodeReviewEngineAudit = {};
  if (value._review_mode === "strict" || value._review_mode === "online")
    audit.reviewMode = value._review_mode;
  else limitations.add("The engine did not report a recognized review mode.");
  if (
    typeof value._policy === "string" &&
    /^[a-zA-Z0-9_.:-]{1,120}$/.test(value._policy)
  ) {
    audit.policy = value._policy;
    if (value._policy !== "memtrace_review_confidence_v1")
      limitations.add(
        "The engine reported a review policy this client does not recognize.",
      );
  } else
    limitations.add(
      "The engine did not report a recognized review policy identity.",
    );
  for (const [input, output] of [
    ["_raw_count", "rawCount"],
    ["_filtered_count", "filteredCount"],
    ["_max_candidates", "maxCandidates"],
  ] as const) {
    if (value[input] === undefined) continue;
    const candidate = value[input];
    if (
      typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0 &&
      candidate <= (output === "maxCandidates" ? 100 : 1_000_000_000) &&
      (output !== "maxCandidates" || candidate > 0)
    )
      audit[output] = candidate;
    else
      limitations.add(
        `The engine reported invalid ${output.replace(/[A-Z]/g, (match) => " " + match.toLowerCase())} metadata.`,
      );
  }
  if (value._source_counts !== undefined) {
    if (!record(value._source_counts))
      limitations.add("The engine reported malformed review source counts.");
    else {
      audit.sourceCounts = {};
      const counts = Object.entries(value._source_counts);
      if (counts.length > 24)
        limitations.add("Review source counts exceeded their metadata bound.");
      for (const [name, count] of counts.slice(0, 24)) {
        if (
          sources.has(name as CodeReviewProvenance) &&
          typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count >= 0 &&
          count <= 1_000_000_000
        )
          audit.sourceCounts[name as CodeReviewProvenance] = count;
        else
          limitations.add(
            "Unknown or invalid review source counts were excluded.",
          );
      }
    }
  }
  if (value._detectors !== undefined) {
    if (!record(value._detectors))
      limitations.add("The engine reported malformed detector coverage.");
    else {
      audit.detectors = {};
      const detectors = Object.entries(value._detectors);
      if (detectors.length > 24)
        limitations.add(
          "Detector coverage exceeded its 24-record display bound.",
        );
      for (const [name, coverage] of detectors.slice(0, 24)) {
        if (
          !/^[a-zA-Z][a-zA-Z0-9_:-]{0,79}$/.test(name) ||
          !record(coverage) ||
          typeof coverage.status !== "string" ||
          !/^[a-z_]{1,60}$/.test(coverage.status)
        ) {
          limitations.add("Malformed detector coverage was excluded.");
          continue;
        }
        const { status, reason, ...details } = coverage;
        const bounded = boundedEvidence(details);
        audit.detectors[name] = {
          status,
          ...(typeof reason === "string"
            ? { reason: reason.slice(0, 1500) }
            : {}),
          ...(bounded.value !== undefined ? { details: bounded.value } : {}),
          ...(bounded.truncated ||
          (typeof reason === "string" && reason.length > 1500)
            ? { detailsTruncated: true }
            : {}),
        };
        if (bounded.truncated)
          limitations.add(
            `${name.replaceAll("_", " ")} coverage details were bounded for display.`,
          );
        if (
          !["evaluated", "not_applicable"].includes(status) &&
          !evaluatedSupportedPatterns(name, coverage)
        )
          limitations.add(
            `${name.replaceAll("_", " ")}: ${typeof reason === "string" && reason ? reason.slice(0, 1500) : `the engine reported ${status.replaceAll("_", " ")} coverage`}.`,
          );
      }
    }
  }
  if (
    audit.rawCount !== undefined &&
    Array.isArray(value.issues) &&
    audit.rawCount < value.issues.length
  )
    limitations.add(
      "The engine review counts disagree with the returned findings.",
    );
  if (
    audit.rawCount !== undefined &&
    audit.filteredCount !== undefined &&
    audit.filteredCount > audit.rawCount
  )
    limitations.add("The engine review filtering counts are inconsistent.");
  if (
    audit.rawCount !== undefined &&
    audit.filteredCount !== undefined &&
    Array.isArray(value.issues) &&
    audit.rawCount - audit.filteredCount !== value.issues.length
  )
    limitations.add(
      "The engine's raw and filtered counts do not reconcile with its returned findings.",
    );
  if (
    audit.maxCandidates !== undefined &&
    Array.isArray(value.issues) &&
    value.issues.length > audit.maxCandidates
  )
    limitations.add(
      "The engine returned more findings than its reported candidate budget.",
    );
  return audit;
}

function localPath(value: unknown, root: string): string | null {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2000 ||
    /[\x00-\x1f]/.test(value)
  )
    return null;
  const result = isAbsolute(value)
    ? relative(root, value).replaceAll("\\", "/")
    : value.replaceAll("\\", "/");
  return !result ||
    result.startsWith("/") ||
    result
      .split("/")
      .some((part) => part === ".." || part === ".git" || part === ".memcode")
    ? null
    : result;
}

function certificate(value: Json, project: Project): boolean {
  return (
    value?.ready === true &&
    value.repo_id === project.repoId &&
    value.branch === project.branch &&
    typeof value.worktree === "string" &&
    key(value.worktree) === key(project.path!) &&
    !!value.source_revision &&
    value.source_unchanged_during_observation === true &&
    value.requested_revision_matches !== false &&
    value.requested_source_matches !== false &&
    value.retry_query_group !== true &&
    value.status !== "partial" &&
    !!publication(value) &&
    graph(value)?.publication_unchanged_during_call === true
  );
}

function reviewFindings(
  value: Json,
  paths: Set<string>,
  root: string,
  limitations: Set<string>,
): CodeReviewFinding[] {
  if (
    value._workflow !== "deterministic_code_review" ||
    !Array.isArray(value.issues)
  ) {
    limitations.add(
      "The engine did not report a recognized deterministic review result.",
    );
    return [];
  }
  if (value.issues.length >= 100)
    limitations.add(
      "The review reached its 100-finding display limit; additional findings may exist.",
    );
  if (value._graph_state !== "ready")
    limitations.add(
      `Cross-module review is ${text(value._graph_state) || "unavailable"}.`,
    );
  const found: CodeReviewFinding[] = [];
  for (const issue of value.issues.slice(0, 100)) {
    if (!record(issue)) {
      limitations.add("A malformed engine finding was excluded.");
      continue;
    }
    const path = localPath(issue.path, root);
    const provenance = sources.has(issue._source)
      ? (issue._source as CodeReviewProvenance)
      : undefined;
    const relatedCapturedPaths =
      provenance === "cross_module" && record(issue.evidence)
        ? [
            ...new Set(
              [
                issue.evidence.declared_in,
                ...list(issue.evidence.consuming_sites)
                  .slice(0, 32)
                  .map((site) => site.path),
              ]
                .map((candidate) => localPath(candidate, root))
                .filter(
                  (candidate): candidate is string =>
                    !!candidate && paths.has(key(candidate)),
                ),
            ),
          ]
        : [];
    const authored = !!path && paths.has(key(path));
    if (!path || (!authored && !relatedCapturedPaths.length)) {
      limitations.add(
        "A review finding outside this story's captured files had no verified native evidence link to its changes and was excluded.",
      );
      continue;
    }
    if (!provenance)
      limitations.add(
        "A finding did not report a recognized native detector source.",
      );
    const severity = text(issue.severity).toLowerCase();
    const ruleId = text(issue.pattern_id).slice(0, 160),
      explanation = text(issue.message).slice(0, 8000);
    if (!explanation) {
      limitations.add("An engine finding did not include an explanation.");
      continue;
    }
    const category: CodeReviewFinding["category"] =
      /security|csrf|oauth|injection|credential|xss|secret/.test(ruleId)
        ? "security"
        : /complexity|nesting|duplicate|refactor/.test(ruleId)
          ? "refactor"
          : /style|convention|maintain|docstring/.test(ruleId)
            ? "maintainability"
            : "correctness";
    const line = number(issue.line);
    const evidence =
      issue.evidence !== undefined
        ? boundedEvidence(issue.evidence)
        : undefined;
    if (evidence?.truncated)
      limitations.add(
        `Evidence for ${ruleId || "a finding"} was bounded for display; inspect the source before acting.`,
      );
    found.push({
      id: createHash("sha256")
        .update(JSON.stringify([ruleId, path, line, explanation]))
        .digest("hex"),
      title:
        text(issue.title).slice(0, 240) ||
        ruleId.replaceAll("_", " ").replaceAll("-", " ") ||
        "Review finding",
      explanation,
      severity: ["critical", "high", "medium", "low", "info"].includes(severity)
        ? (severity as CodeReviewFinding["severity"])
        : "info",
      category,
      path,
      ...(provenance ? { provenance } : {}),
      locationScope: authored ? "story-change" : "affected-code",
      ...(!authored ? { relatedCapturedPaths } : {}),
      ...(line && Number.isInteger(line) ? { line } : {}),
      ...(ruleId ? { ruleId } : {}),
      ...(evidence?.value !== undefined
        ? { evidenceData: evidence.value }
        : {}),
      ...(evidence?.truncated ? { evidenceTruncated: true } : {}),
      ...(text(issue.recommendation)
        ? { recommendation: issue.recommendation.slice(0, 4000) }
        : {}),
    });
  }
  return [...new Map(found.map((item) => [item.id, item])).values()];
}

/** Only query the captured contribution; no repository-wide quality scan or re-index. */
async function analyzeStableGroup(
  engine: ReviewEngine,
  project: Project,
  capture: StoryReviewCapture,
  progress: (value: AnalysisProgress) => Promise<void>,
  assertActive: () => void,
  retryPublication: boolean,
): Promise<StoryReviewAnalysis> {
  const limitations = new Set(capture.limitations),
    observations: Json[] = [];
  const paths = new Set(capture.snapshot.files.map((file) => key(file.path)));
  const call = async (name: string, args: Json): Promise<Json> => {
    assertActive();
    const value = await engine.call(project, name, args);
    assertActive();
    if (
      !value ||
      typeof value !== "object" ||
      value.error ||
      value.error_code ||
      value.repo_in_store === false
    )
      throw Error(
        text(value?.message ?? value?.error) ||
          `${name.replaceAll("_", " ")} is unavailable.`,
      );
    observations.push(value);
    return value;
  };
  const scope = { repo_id: project.repoId, branch: project.branch };
  let before = await call("get_query_revision", { ...scope, wait_ms: 0 });
  // A reopened cache can briefly publish a new graph boundary without source edits.
  // Wait only on that exact checkout's explicitly transient response, never on a
  // foreign path, unsupported certificate or malformed publication envelope.
  for (
    let attempt = 0;
    attempt < 6 &&
    before.ready === false &&
    before.repo_id === project.repoId &&
    before.branch === project.branch &&
    typeof before.worktree === "string" &&
    key(before.worktree) === key(project.path!) &&
    before.source_unchanged_during_observation === true &&
    graph(before)?.publication_unchanged_during_call === false;
    attempt++
  ) {
    assertActive();
    await new Promise((resolve) => setTimeout(resolve, 150));
    before = await call("get_query_revision", { ...scope, wait_ms: 1000 });
  }
  // Only observations inside this group's opening/closing boundary are evidence.
  observations.splice(0, observations.length, before);
  if (!certificate(before, project))
    limitations.add(
      "The engine could not certify this exact checkout and branch before review.",
    );
  await progress({
    phase: "review",
    note: "Running local AST, rule-pack and cross-module checks on this story's patch.",
  });
  let findings: CodeReviewFinding[] = [],
    audit: CodeReviewEngineAudit | undefined;
  try {
    const review = await call("find_code_review_issues", {
      diff: capture.patch,
      repo_root: project.path,
      repo_id: project.repoId,
      graph_mode: "strict",
      review_mode: "online",
      max_candidates: 100,
      base_sha_files: capture.baseFiles,
    });
    audit = reviewAudit(review, limitations);
    findings = reviewFindings(review, paths, project.path!, limitations);
  } catch (error) {
    assertActive();
    limitations.add(`Code review: ${(error as Error).message}`);
  }

  await progress({
    phase: "quality",
    note: "Measuring the functions and methods touched by this story.",
  });
  const metrics: CodeReviewMetric[] = [],
    symbols: Json[] = [];
  try {
    const detected = await call("detect_changes", {
      ...scope,
      diff: capture.patch,
    });
    if (!Array.isArray(detected.changed_files))
      limitations.add("The engine did not report changed-file coverage.");
    const covered = new Set<string>();
    for (const file of list(detected.changed_files)) {
      const path = localPath(file.file_path, project.path!);
      if (!path || !paths.has(key(path))) continue;
      covered.add(key(path));
      if (file.matched !== true)
        limitations.add(`${path} was not found in the selected source graph.`);
      for (const symbol of list(file.affected_symbols)) {
        if (["Function", "Method"].includes(symbol.kind))
          symbols.push({ ...symbol, path });
      }
    }
    for (const path of paths)
      if (!covered.has(path))
        limitations.add(`${path} has no source-backed changed-file coverage.`);
    const unique = [
      ...new Map(
        symbols.map((row) => [
          `${row.path}:${row.id ?? row.name}:${row.start_line}`,
          row,
        ]),
      ).values(),
    ];
    symbols.splice(0, symbols.length, ...unique.slice(0, 24));
    if (unique.length > 24)
      limitations.add(
        "Quality and impact are bounded to 24 changed functions; narrow the story or review the remainder separately.",
      );
    if (!symbols.length)
      limitations.add(
        "No changed function or method could be measured; quality and impact are unavailable for this patch.",
      );
    for (const symbol of symbols) {
      try {
        const value = await call("get_function_quality_metrics", {
          ...scope,
          function_name: symbol.name,
          file_path: symbol.path,
          kind: symbol.kind,
        });
        const row = value.function;
        const rowPath = localPath(row?.file_path, project.path!);
        if (
          !row ||
          (typeof value.matches === "number" && value.matches !== 1) ||
          rowPath === null ||
          key(rowPath) !== key(symbol.path) ||
          text(row.name) !== text(symbol.name)
        )
          throw Error(
            "The selected declaration was not resolved unambiguously.",
          );
        const maintainabilityIndex = number(row.maintainability_index),
          halsteadVolume = number(row.halstead_volume),
          risk = text(row.risk_level).toLowerCase();
        const metric: CodeReviewMetric = {
          symbol: text(row.scope_path) || text(row.name),
          path: symbol.path,
          line:
            number(row.start_line) ?? number(symbol.start_line) ?? undefined,
          cognitive: number(row.cognitive_complexity),
          cyclomatic: number(row.complexity),
          nesting: number(row.max_nesting),
          ...{
            maintainabilityIndex,
            halsteadVolume,
            ...(["low", "medium", "high", "critical"].includes(risk)
              ? { riskLevel: risk }
              : {}),
          },
          source: row.complexity_source === "ast" ? "ast" : "estimated",
        };
        metrics.push(metric);
        if (
          metric.source !== "ast" ||
          metric.cognitive === null ||
          metric.cyclomatic === null ||
          metric.nesting === null
        )
          limitations.add(
            `${metric.symbol} does not have complete AST complexity measurements.`,
          );
        if (
          metric.source === "ast" &&
          row.quality_metrics_v === 1 &&
          maintainabilityIndex === null
        )
          limitations.add(
            `${metric.symbol} has AST quality metrics, but its maintainability index was not reported.`,
          );
      } catch (error) {
        assertActive();
        limitations.add(
          `Quality for ${text(symbol.name)}: ${(error as Error).message}`,
        );
      }
    }
  } catch (error) {
    assertActive();
    limitations.add(`Changed-symbol coverage: ${(error as Error).message}`);
  }

  await progress({
    phase: "impact",
    note: "Tracing affected callers, files and execution flows.",
  });
  const affected = new Set<string>(),
    files = new Set<string>(),
    processes = new Set<string>();
  let impactComplete = symbols.length > 0;
  for (const symbol of symbols) {
    try {
      const value = await call("get_impact", {
        ...scope,
        target: symbol.id || symbol.name,
        file_path: symbol.path,
        direction: "upstream",
        depth: 5,
      });
      const entries = Object.values(value.by_depth ?? {}).flatMap(list);
      const ids = entries
        .map(
          (row) =>
            text(row.node_id ?? row.id) ||
            (row.file_path && row.name
              ? `${text(row.repo_id)}:${text(row.file_path)}:${text(row.name)}`
              : ""),
        )
        .filter(Boolean);
      const whole =
        value.found === true &&
        value.truncated !== true &&
        value.graph_incomplete !== true &&
        value.total_affected_is_lower_bound !== true &&
        value.risk !== "UNKNOWN" &&
        number(value.total_affected) === new Set(ids).size &&
        Array.isArray(value.affected_files) &&
        Array.isArray(value.affected_processes);
      impactComplete &&= whole;
      if (!whole)
        limitations.add(
          `Impact for ${text(symbol.name)} is incomplete; the displayed reach is an observed lower bound.`,
        );
      for (const id of ids) affected.add(id);
      for (const item of value.affected_files ?? []) {
        const path =
          typeof item === "string" ? item : text(item.file_path ?? item.path);
        if (path) files.add(path);
      }
      for (const item of value.affected_processes ?? []) {
        const id =
          typeof item === "string"
            ? item
            : text(item.id ?? item.node_id ?? item.name);
        if (id) processes.add(id);
      }
    } catch (error) {
      assertActive();
      impactComplete = false;
      limitations.add(
        `Impact for ${text(symbol.name)}: ${(error as Error).message}`,
      );
    }
  }
  const after = await call("get_query_revision", {
    ...scope,
    expected_revision: before.token,
    expected_source_revision: before.source_revision,
    wait_ms: 0,
  });
  const graphRevision = publication(after),
    aligned =
      certificate(before, project) &&
      certificate(after, project) &&
      before.source_revision === after.source_revision &&
      before.token === after.token &&
      graphRevision === publication(before) &&
      observations.every(
        (value) =>
          publication(value) === graphRevision &&
          graph(value)?.publication_unchanged_during_call === true,
      );
  if (
    !aligned &&
    retryPublication &&
    certificate(before, project) &&
    after.repo_id === project.repoId &&
    after.branch === project.branch &&
    typeof after.worktree === "string" &&
    key(after.worktree) === key(project.path!) &&
    after.source_revision === before.source_revision &&
    after.source_unchanged_during_observation === true &&
    record(graph(after)) &&
    !!publication(after) &&
    (before.token !== after.token ||
      graph(after)?.publication_unchanged_during_call === false)
  ) {
    // Discard all measurements from the interrupted publication group. This is
    // one bounded read-only retry, not a successful merge of inconsistent data.
    return analyzeStableGroup(
      engine,
      project,
      capture,
      progress,
      assertActive,
      false,
    );
  }
  if (!aligned)
    limitations.add(
      "Source/index publication changed or could not be certified throughout review. These observations cannot certify the current code.",
    );
  return {
    findings,
    metrics,
    impact: {
      symbols: symbols.length ? affected.size : null,
      files: symbols.length ? files.size : null,
      processes: symbols.length ? processes.size : null,
      complete: impactComplete && aligned,
      ...(!impactComplete || !aligned
        ? {
            note: "Observed reach only; incomplete graph coverage is not proof of no impact.",
          }
        : {}),
    },
    limitations: [...limitations],
    sourceRevision: text(after.source_revision) || null,
    graphRevision,
    audit,
  };
}

/** Only query the captured contribution; never turn unavailable evidence into a pass. */
export async function analyzeStoryReview(
  engine: ReviewEngine,
  project: Project,
  capture: StoryReviewCapture,
  progress: (value: AnalysisProgress) => Promise<void>,
  assertActive: () => void,
): Promise<StoryReviewAnalysis> {
  return analyzeStableGroup(
    engine,
    project,
    capture,
    progress,
    assertActive,
    true,
  );
}
