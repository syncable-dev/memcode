/**
 * Where a project's code analysis stands, in steps a person can follow. The
 * engine reports stages and its own detail lines; this turns them into the
 * steps MemCode shows, and never invents a number the engine did not give.
 */

export type AnalysisStep =
  | "starting"
  | "reading"
  | "linking"
  | "saving"
  | "search"
  | "checking";

export interface AnalysisProgress {
  step: AnalysisStep;
  /** How far the engine says it is, 0-100, when it says. */
  percent?: number;
  /** Done and total of the current step, when the engine counts it. */
  done?: number;
  total?: number;
  unit?: string;
  /** What the engine is doing now, in its own words. */
  detail?: string;
  startedAt: string;
  updatedAt: string;
  /** When the analysis stopped with an error, at this step. */
  stoppedAt?: string;
}

/** What one report from the engine says, before MemCode times it. */
export type AnalysisReport = Omit<
  AnalysisProgress,
  "startedAt" | "updatedAt" | "stoppedAt"
>;

export const analysisSteps: ReadonlyArray<{
  id: AnalysisStep;
  label: string;
  /** The label where there is room for two words. */
  short: string;
  /** What happens in this step, for someone who has not seen it before. */
  about: string;
}> = [
  {
    id: "starting",
    label: "Starting Memtrace",
    short: "Starting",
    about: "The code engine starts on this computer.",
  },
  {
    id: "reading",
    label: "Reading your files",
    short: "Reading files",
    about: "Every source file is read and its functions, classes and types are found.",
  },
  {
    id: "linking",
    label: "Connecting the code",
    short: "Linking code",
    about: "Calls, imports and references are linked, so each change shows what it touches.",
  },
  {
    id: "saving",
    label: "Saving the code map",
    short: "Saving map",
    about: "The map is written to this project's store on your computer.",
  },
  {
    id: "search",
    label: "Preparing search",
    short: "Search",
    about: "Code is made searchable by meaning, not only by name.",
  },
  {
    id: "checking",
    label: "Checking it matches your files",
    short: "Checking",
    about: "Memtrace confirms the map is of the files as they are now.",
  },
];

export const stepIndex = (step: AnalysisStep): number =>
  analysisSteps.findIndex((item) => item.id === step);

export const stepLabel = (step: AnalysisStep): string =>
  analysisSteps[stepIndex(step)]?.label ?? "Analyzing code";

/** The step an engine stage belongs to, or nothing for a stage it does not know. */
export function stepOfStage(stage: unknown): AnalysisStep | undefined {
  if (typeof stage !== "string") return undefined;
  const name = stage.trim().toLowerCase();
  if (["pending", "queued", "starting", "waiting"].includes(name)) return "starting";
  if (["scan", "parse", "parsing", "scanning"].includes(name)) return "reading";
  if (["resolve", "community", "process", "modules", "flows", "link"].includes(name))
    return "linking";
  if (["persist", "finalizing", "indexing", "write", "writing"].includes(name))
    return "saving";
  if (["embedding", "embed"].includes(name)) return "search";
  if (["verify", "verifying", "publish", "publication", "certify"].includes(name))
    return "checking";
  return undefined;
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;

/** The engine's own words, with its few terms of art said plainly. */
const cleanDetail = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^Louvain iteration (\d+)\/(\d+)(?: \([^)]*\))?/i, "Grouping related code · pass $1 of $2")
    .replace(/ — searchable while modules detect$/i, ", searchable already")
    .slice(0, 240);
  return text || undefined;
};

/** One engine job record (`check_job_status`, `list_jobs`), as progress. */
export function reportFromJob(job: unknown): AnalysisReport | undefined {
  if (!job || typeof job !== "object") return undefined;
  const value = job as Record<string, any>;
  const step =
    stepOfStage(value.stage) ??
    (value.status === "pending" ? "starting" : undefined);
  if (!step) return undefined;
  const progress = value.progress;
  const done = count(progress?.completed);
  const total = count(progress?.total);
  const measured = done !== undefined && total !== undefined && total > 0;
  return {
    step,
    ...(measured
      ? {
          done,
          total,
          percent: Math.min(100, Math.round((done / total) * 100)),
          ...(typeof progress?.unit === "string" ? { unit: progress.unit } : {}),
        }
      : {}),
    ...(cleanDetail(value.message) ? { detail: cleanDetail(value.message) } : {}),
  };
}

/**
 * A line the engine prints while it starts and indexes, such as
 * `Indexing app — persist · Writing 120 symbols · 88% · 21s`.
 */
export function reportFromEngineLine(line: unknown): AnalysisReport | undefined {
  if (typeof line !== "string") return undefined;
  const text = line.replace(/\s+/g, " ").trim();
  // After the first index: history and search, which the engine names together.
  if (/Embedding \+ replaying|Phase 2\/2/i.test(text))
    return { step: "search", detail: "Reading the project's history and preparing search" };
  const indexed = /indexed: (\d+) nodes - (\d+) edges/i.exec(text);
  if (indexed)
    return {
      step: "saving",
      percent: 100,
      detail: `Mapped ${indexed[1]} symbols and ${indexed[2]} links`,
    };
  const indexing = /Indexing .+? [—–-] ([a-z_]+)(?: · (.*))?$/i.exec(text);
  if (!indexing) return undefined;
  const step = stepOfStage(indexing[1]);
  if (!step) return undefined;
  const parts = (indexing[2] ?? "").split(" · ").map((part) => part.trim());
  const percentPart = parts.find((part) => /^\d{1,3}%$/.test(part));
  const percent = percentPart ? Math.min(100, Number.parseInt(percentPart, 10)) : undefined;
  const detail = cleanDetail(
    parts
      .filter((part) => part && part !== percentPart && !/^\d+(\.\d+)?m?s$/.test(part))
      .join(" · "),
  );
  return {
    step,
    ...(percent !== undefined ? { percent } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** The next record of an analysis that is under way. */
export function nextProgress(
  previous: AnalysisProgress | undefined,
  report: AnalysisReport,
  at: string,
): AnalysisProgress {
  const startedAt = previous && !previous.stoppedAt ? previous.startedAt : at;
  const sameStep = previous?.step === report.step && !previous.stoppedAt;
  return {
    // Within a step, what the engine said last stays until it says more.
    ...(sameStep
      ? {
          ...(previous!.percent !== undefined ? { percent: previous!.percent } : {}),
          ...(previous!.detail ? { detail: previous!.detail } : {}),
        }
      : {}),
    ...report,
    startedAt,
    updatedAt: at,
  };
}

/** The one-line note a report stands for, where MemCode shows a line of text. */
export function progressNote(report: AnalysisReport): string {
  const measured =
    report.done !== undefined && report.total !== undefined
      ? `${report.done.toLocaleString()} of ${report.total.toLocaleString()}${report.unit ? " " + report.unit : ""}`
      : report.percent !== undefined
        ? `${report.percent}%`
        : "";
  return [stepLabel(report.step), measured, report.detail ? readableDetail(report.detail) : ""]
    .filter(Boolean)
    .join(" · ");
}

/** Large counts in an engine line, written the way people read them. */
export function readableDetail(detail: string, locale?: string): string {
  return detail.replace(/\b\d{4,}\b/g, (digits) =>
    Number(digits).toLocaleString(locale),
  );
}

const failures = new WeakSet<object>();

/** An error a code analysis ended with: the analysis panel shows it, not a passing message. */
export function markAnalysisFailure<T>(error: T): T {
  if (error && typeof error === "object") failures.add(error);
  return error;
}

export const isAnalysisFailure = (error: unknown): boolean =>
  !!error && typeof error === "object" && failures.has(error);

/** "0:42", "3:05", "1:02:09": a running clock where there is little room. */
export function clockLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const two = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? `${hours}:${two(minutes)}:${two(seconds % 60)}`
    : `${minutes}:${two(seconds % 60)}`;
}

/** "42 s", "3 min 05 s", "1 h 02 min". */
export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
