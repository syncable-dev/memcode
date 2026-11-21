/**
 * What a worker says it is doing to a symbol. Fleet decides from the kind whether two
 * workers' edits can both land, need a re-read, or are a real disagreement.
 */
export const changeKinds = [
  "add",
  "change",
  "fix",
  "rename",
  "signature",
  "move",
  "remove",
  "docs",
  "test",
  "format",
] as const;
export type ChangeKind = (typeof changeKinds)[number];

const breaking: ReadonlySet<ChangeKind> = new Set(["signature", "move", "remove"]);
/** A change that reshapes or removes what other code relies on: the kind that can truly conflict. */
export const breaksCallers = (kind: ChangeKind) => breaking.has(kind);

const adding: ReadonlySet<ChangeKind> = new Set(["add", "docs", "test"]);
/** A change that only adds; it never conflicts with another worker's edit. */
export const onlyAdds = (kind: ChangeKind) => adding.has(kind);

/** How a kind reads in a sentence: "MC-12 is changing the signature of cartTotal". */
export const changeVerbs: Record<ChangeKind, string> = {
  add: "adding",
  change: "changing",
  fix: "fixing",
  rename: "renaming",
  signature: "changing the signature of",
  move: "moving",
  remove: "removing",
  docs: "documenting",
  test: "adding tests for",
  format: "formatting",
};

/** How two workers' edits relate: independent, compatible after a re-read, or a real disagreement. */
export type ConflictClass = "A" | "B" | "C";

/** One group of edits a worker announced: open while it edits, closed once it recorded them. */
export interface FleetDeclaration {
  id: string;
  taskId: string;
  projectId: string;
  branch: string;
  /** `file::symbol`, or the file path when the file changes as a whole. */
  symbols: string[];
  kind: ChangeKind;
  /** Why, in the worker's words. Peers and the person deciding read this. */
  plan: string;
  declaredAt: string;
  recordedAt?: string;
  class?: ConflictClass;
  /** Where it falls in the goal's order of declarations and records; settles "before or during". */
  opened: number;
  closed?: number;
  /** The disagreement this edit became part of. */
  decisionId?: string;
}

export const verdictKinds = ["reconcile", "recommend", "ask_human"] as const;
export type VerdictKind = (typeof verdictKinds)[number];

/** What one task involved in a disagreement wants, shown to the person who decides. */
export interface FleetPosition {
  /** Missing for an agent outside MemCode working on the same branch. */
  taskId?: string;
  agentId: string;
  kind?: ChangeKind;
  /** What it is changing and why. */
  plan?: string;
  verdict?: VerdictKind;
  /** The task it recommends should go ahead. */
  winnerTaskId?: string;
  /** Its merge plan, its reasoning, or its question for the person. */
  reason?: string;
}

/** The parts of a decision the screen reads to tell the person what, if anything, is asked. */
export interface DecisionStanding {
  status: "open" | "resolved";
  positions?: FleetPosition[];
  needs?: "confirm" | "decide";
  resolutionKind?: "human" | "coordination" | "agents";
}

/**
 * Whether a disagreement is the person's to settle now. While the workers involved are
 * still judging it is not; one nobody here can judge (no positions) always is.
 */
export function needsPerson(decision: DecisionStanding): boolean {
  return (
    decision.status === "open" &&
    (!!decision.needs || !decision.positions?.length)
  );
}

export function decisionAsk(decision: DecisionStanding): string {
  if (decision.status === "resolved")
    return decision.resolutionKind === "agents"
      ? "Settled by the workers"
      : decision.resolutionKind === "human"
        ? "You decided"
        : "Settled";
  if (decision.needs === "confirm") return "Confirm the workers' recommendation";
  if (decision.needs === "decide") return "The workers could not settle this";
  return decision.positions?.length
    ? "The workers are settling this"
    : "Needs your decision";
}

/** What a worker concluded, as the person reads it; nothing while it has not judged. */
export function verdictSummary(
  position: FleetPosition,
  name: (taskId?: string) => string,
): string | undefined {
  switch (position.verdict) {
    case "reconcile":
      return "Says both changes fit together";
    case "recommend":
      return position.winnerTaskId && position.winnerTaskId === position.taskId
        ? "Says its own change has to stand"
        : `Recommends ${name(position.winnerTaskId)} goes ahead`;
    case "ask_human":
      return "Asks you";
  }
}

/** What a worker that paused for the person's decision is told when it is brought back. */
export function decisionInstruction(
  decision: { scope: string[]; resolution?: string },
  standing: "yours" | "both" | { other: string },
): string {
  const what = decision.scope.map((symbol) => symbol.split("::").pop()).join(", ");
  const outcome =
    standing === "yours"
      ? "Your change goes ahead. Carry on with this task."
      : standing === "both"
        ? "Both changes go ahead as they are. Carry on with this task."
        : `${standing.other}’s change stands. Re-read it and rebuild your task on that version. If your task can no longer be done as written, say so and stop.`;
  return `Decision on ${what}: ${decision.resolution ?? ""} ${outcome}`.replace(/\s+/g, " ");
}
