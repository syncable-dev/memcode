import type { WorkItem } from "../src/shared";
import type {
  RoutingRequestKind,
  RoutingRequestSignals,
} from "../src/routing-signals";
import {
  predictRoutingLanguage,
  type RoutingLanguageModel,
} from "./routing-language-model";

interface PathReference {
  file: string;
  line?: number;
  column?: number;
}

export interface RoutingIntentAnalysis {
  signals: RoutingRequestSignals;
  references: {
    paths: PathReference[];
    symbols: string[];
    errors: string[];
  };
  searchQuery: string;
}

const extensions =
  "tsx?|m[tc]s|cts|jsx?|[cm]js|rs|pyi?|go|java|kt|kts|cs|cpp|cxx|cc|c|hpp|h|rb|php|swift|scala|vue|svelte|html?|css|scss|sass|less|mdx?|txt|rst|asciidoc|jsonc?|jsonl|ya?ml|toml|ini|cfg|conf|xml|sql|graphql|proto|sh|bash|ps1|bat|cmd|lock|gitignore|env";
const fileName = String.raw`(?:[\w.@+-]+\.(?:${extensions})|Dockerfile|Makefile|Gemfile|Rakefile|\.gitignore|\.env)`;
const location = String.raw`(?::([1-9]\d{0,7})(?::([1-9]\d{0,7}))?|#L([1-9]\d{0,7}))?`;
const boundedPath = new RegExp(
  String.raw`(?<![\w./\\:-])(?:\.[/\\])?(?:[\w.@+-]+[/\\])*${fileName}${location}(?![\w/\\-]|\.(?=\S))`,
  "gi",
);
const quotedPath = new RegExp(
  String.raw`^((?:\.[/\\])?(?:[\w.@+() -]+[/\\])*(?:${fileName}|[\w.@+() -]+\.(?:${extensions})))${location}$`,
  "i",
);
const symbolName = String.raw`[A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)*`;
const quotedSymbol = new RegExp(String.raw`^(${symbolName})(?:\(\))?$`);
const plainSymbol = new RegExp(
  String.raw`\b(?:function|method|symbol|class|interface)\s+(${symbolName})|\b(${symbolName})\(\)`,
  "g",
);
const notSymbols =
  /^(?:a|an|the|this|that|only|true|false|null|undefined|return|and|or|function|class|interface|with|called|named)$/i;
const quotedText =
  /`([^`\r\n]+)`|"([^"\r\n]+)"|(?<!\w)'([^'\r\n]+)'(?!\w)|“([^”\r\n]+)”|‘([^’\r\n]+)’/g;
const errorCue =
  /\b(?:error|exception|panic|failure|throws?|says?|reports?|rejects?|fail(?:s|ed|ing)?)(?:\s+(?:message|with|saying|because))?\s*[:=]?\s*$/i;
const errorText =
  /(?:\b[\w.]*Error\s*:|\b(?:error|exception|panic|denied|not found|no such|failed|did not respond|timed out|is closing|could not)\b)/i;
const errorCode =
  /\b(?:ERR_[A-Z0-9_]{2,50}|E(?:ACCES|ADDRINUSE|AGAIN|EXIST|INVAL|IO|NOENT|PIPE|TIMEDOUT)|HTTP [45]\d\d)\b/g;
const contract = String.raw`(?:public (?:API|interface|contract|signature|method|function)|(?:API|wire|data) (?:contract|signature|schema)|API|exported (?:name|symbol|method|function|signature|type)|backward(?:s)? compatibility|backward(?:s)? compatible|request schema|response schema|endpoint)`;
const preserveContract = new RegExp(
  String.raw`\b(?:preserve|maintain|keep|retain)\b[^.!?;\n]{0,55}\b${contract}\b|\bwithout (?:changing|breaking)\b[^.!?;\n]{0,40}\b${contract}\b|\b(?:do not|don['’]t|never|avoid)\s+(?:[\w-]+ (?:and|or) ){0,3}(?:change|changing|break|breaking|rename|remove)\b[^.!?;\n]{0,45}\b${contract}\b|\b${contract}\b[^.!?;\n]{0,30}\b(?:must|should) (?:stay|remain) unchanged\b`,
  "i",
);
const changeContract = new RegExp(
  String.raw`\b(?:rename|change|alter|remove|replace|deprecate|break|add|introduce)\b[^.!?;\n]{0,55}\b${contract}\b`,
  "i",
);
const behaviorConstraint =
  /\b(?:preserve|retain|keep|maintain)\b[^.!?;\n]{0,45}\bbehaviou?r\b|\b(?:do not|don['’]t|never|without)\s+(?:change|changing|alter|altering)\b[^.!?;\n]{0,35}\bbehaviou?r\b/i;
const fileConstraint =
  /\b(?:only (?:edit|modify|change|touch|update|work in)|(?:confine|limit|restrict) (?:edits|changes|work) to|(?:edit|modify|change|touch|update) only)\b[^.;!?\n]{0,80}\b(?:files?|FILE_REFERENCE)\b|\bFILE_REFERENCE\s+only\b/i;

const requestPatterns: Array<[RoutingRequestKind, RegExp]> = [
  [
    "explain",
    /^(?:explain|describe|summarize|understand|tell me|walk me through|what|which|how|why|where|when|who)\b/i,
  ],
  [
    "research",
    /^(?:research|investigate|diagnose|compare|evaluate|review|inspect|look (?:up|into|at)|check|find out|trace|audit)\b/i,
  ],
  [
    "test",
    /^(?:(?:test|benchmark|verify|validate)\b|(?:run|write|add|update|expand|repeat)\b[^.;!?\n]{0,45}\b(?:tests?|benchmarks?|checks?|regressions?)\b)/i,
  ],
  ["fix", /^(?:fix|resolve|repair|correct|patch|prevent)\b/i],
  [
    "refactor",
    /^(?:refactor|extract|simplify|split|consolidate|restructure|deduplicate|reduce (?:code |the )?complexity)\b/i,
  ],
  ["rename", /^rename\b/i],
  [
    "implement",
    /^(?:implement|add|build|change|create|edit|introduce|enable|disable|support|update|remove|replace|modify|make|allow|wire|integrate|move)\b/i,
  ],
];
const requestPrefix =
  /^(?:(?:and|also|then|next|also please|please|(?:can|could|would|will|should) (?:you|we)|(?:I|we|you) (?:want|need|have|would like)(?: you)? to|(?:I|we) (?:want|need) (?:it|this) to|I['’]d like (?:you )?to|help me|just|only|be able to)\s+)+/i;
const requestSeparator =
  /(?:[.;!?](?=\s|$)|[\n\r]|\s+(?:but|then|and then|also|and|or)\s+)/i;
const negative =
  /\b(?:do not|don['’]t|never|without|avoid|must not|should not|can['’]t|cannot|won['’]t)\s+[^.!?;\n]*?(?=[.!?;\n]|\s+(?:but|then|instead)\b|$)/gi;
const fallbackKind = {
  feature: "implement",
  fix: "fix",
  refactor: "refactor",
  research: "research",
  test: "test",
} as const;

function unique<T>(items: T[], key: (item: T) => string, limit: number): T[] {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const value = key(item);
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .slice(0, limit);
}

function pathReference(
  file: string,
  line?: string,
  column?: string,
): PathReference | undefined {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.length > 512 ||
    normalized.split("/").some((part) => part === ".." || part === ".")
  )
    return;
  return {
    file: normalized,
    ...(line ? { line: Number(line) } : {}),
    ...(column ? { column: Number(column) } : {}),
  };
}

function parseReferences(text: string) {
  const paths: PathReference[] = [];
  const symbols: string[] = [];
  const errors: string[] = [];
  const addPath = (file: string, line?: string, column?: string) => {
    const reference = pathReference(file, line, column);
    if (reference) paths.push(reference);
  };
  const addSymbol = (symbol: string) => {
    if (symbol.length <= 160 && !notSymbols.test(symbol)) symbols.push(symbol);
  };
  const unquoted = text.replace(
    quotedText,
    (
      match: string,
      tick,
      double,
      single,
      curvedDouble,
      curvedSingle,
      offset: number,
    ) => {
      const literal = String(
        tick ?? double ?? single ?? curvedDouble ?? curvedSingle,
      ).trim();
      const path = quotedPath.exec(literal);
      if (path) {
        addPath(path[1], path[2] ?? path[4], path[3]);
        return " FILE_REFERENCE ";
      }
      const symbol = quotedSymbol.exec(literal);
      const codes = [...literal.matchAll(errorCode)];
      if (
        errorCue.test(text.slice(Math.max(0, offset - 45), offset)) ||
        errorText.test(literal) ||
        codes.length
      ) {
        if (literal.length >= 3 && literal.length <= 240) errors.push(literal);
      } else if (symbol && (tick || /[.:(]/.test(literal)))
        addSymbol(symbol[1]);
      return " ".repeat(match.length);
    },
  );
  const prose = unquoted.replace(
    boundedPath,
    (match: string, line, column, anchorLine) => {
      const file = match.replace(
        /(?::[1-9]\d{0,7}(?::[1-9]\d{0,7})?|#L[1-9]\d{0,7})$/i,
        "",
      );
      addPath(file, line ?? anchorLine, column);
      return " FILE_REFERENCE ";
    },
  );
  for (const match of prose.matchAll(plainSymbol))
    addSymbol(match[1] ?? match[2]);
  for (const match of prose.matchAll(errorCode)) errors.push(match[0]);
  for (const match of prose.matchAll(
    /\b(?:[\w.]+Error|Error|Exception|panic)\s*:\s*([^\r\n]{3,240})/gi,
  )) {
    const error = match[0].trim();
    if (error.length <= 240 && !error.includes("FILE_REFERENCE"))
      errors.push(error);
  }
  return {
    paths: unique(
      paths,
      ({ file, line, column }) => `${file}:${line ?? ""}:${column ?? ""}`,
      8,
    ),
    symbols: unique(symbols, (symbol) => symbol, 12),
    errors: unique(errors, (error) => error, 6),
    prose,
  };
}

export function analyzeRoutingIntent(
  task: Pick<WorkItem, "title" | "description" | "kind">,
  model?: RoutingLanguageModel,
): RoutingIntentAnalysis {
  const text = `${task.title.slice(0, 500)}\n${task.description.slice(0, 6000)}`
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s)\]}]+/gi, " ");
  const { prose, ...references } = parseReferences(text);
  const affirmative = prose.replace(negative, "");
  let changesPublicContract = false;
  const requests = affirmative.split(requestSeparator).flatMap((part) => {
    const clause = part
      .trim()
      .replace(/^\s*(?:\d+[.)]\s+|[-*•]\s+)*/, "")
      .replace(requestPrefix, "");
    const request = requestPatterns.find(([, pattern]) =>
      pattern.test(clause),
    )?.[0];
    if (
      request &&
      request !== "explain" &&
      request !== "research" &&
      request !== "test"
    )
      changesPublicContract ||= changeContract.test(clause);
    return request ? [request] : [];
  });
  const kinds = unique(requests, (request) => request, requestPatterns.length);
  const prediction =
    model && !kinds.length
      ? predictRoutingLanguage(model, task.title, task.description)
      : undefined;
  const learned = !!prediction?.accepted.length;
  if (prediction) kinds.push(...prediction.accepted);
  if (!kinds.length)
    kinds.push(task.kind ? fallbackKind[task.kind] : "unknown");

  const searchQuery = [
    ...references.paths.map(({ file }) => file),
    ...references.symbols,
    ...references.errors,
    affirmative.replaceAll("FILE_REFERENCE", " "),
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  return {
    signals: {
      kinds,
      readOnly:
        !learned &&
        kinds.every((kind) => kind === "explain" || kind === "research"),
      fileScopeOnly: fileConstraint.test(affirmative),
      preserveBehavior: behaviorConstraint.test(prose),
      publicContract: changesPublicContract
        ? "change"
        : preserveContract.test(prose)
          ? "preserve"
          : "unspecified",
      ...(prediction && model
        ? {
            language: {
              digest: model.digest,
              outcome: learned ? "classified" : "abstained",
              scores: prediction.scores.map(({ kind, probability }) => ({
                kind,
                score: Math.round(probability * 1_000) / 1_000,
              })),
            },
          }
        : {}),
    },
    references,
    searchQuery,
  };
}
