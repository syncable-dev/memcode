import type { MemtraceEngine } from "../../runtime/memtrace";

/**
 * A stand-in for Memtrace's Fleet engine that follows the engine's own rules, ported from
 * memfleet-broker (crdt/classify, crdt/early, crdt/mediation) and memtrace-mcp
 * (fleet/tools, fleet/escalation). Kept faithful, including the parts that are awkward:
 * an intent lives 120 seconds with no way to end it early, and an edit is classified
 * against every live intent on the branch, the recording agent's own included.
 */
type Json = Record<string, any>;
type Mode = "off" | "advisory" | "auto";
interface Intent {
  id: string;
  agent: string;
  repo: string;
  branch: string | null;
  touched: string[];
  intent: unknown;
  assignment?: string;
  expiresAt: number;
}
interface Verdict {
  agent_id: string;
  verdict: { kind: "reconcile" | "recommend" | "defer_to_human"; winner?: string };
}
interface Facts {
  both_destructive: boolean;
  has_removal: boolean;
  deterministic_safe: boolean;
  deterministic_owner: string | null;
}
interface Escalation {
  escalation_id: string;
  repo_id: string;
  branch: string | null;
  episode_id: string;
  agent_id: string;
  touched: string[];
  conflicting_agents: string[];
  status: "Pending" | "Resolved";
  resolution?: string;
  winner?: string | null;
  facts: Facts;
  mode: Mode;
  verdicts: Verdict[];
  recommended_winner?: string | null;
  resolved_by?: string;
}

const intentTtlMs = 120_000;
const pattern = (intent: any) => intent?.refactor?.pattern;
const isAdditive = (intent: any) =>
  intent === "docs_only" || !!intent?.feature_add || !!intent?.test_add;
const isRemoval = (intent: any) =>
  pattern(intent) === "move_symbol" || intent?.cleanup?.kind === "dead_code";
const isDestructive = (intent: any) =>
  pattern(intent) === "change_signature" || isRemoval(intent);
const isStructural = (intent: any) =>
  ["rename_symbol", "move_symbol", "change_signature"].includes(pattern(intent));
const label = (intent: unknown) =>
  typeof intent === "string" ? intent : JSON.stringify(intent);

function classify(intent: unknown, touched: string[], active: Intent[]) {
  if (isAdditive(intent))
    return active.some((other) => other.touched.every((key) => touched.includes(key)))
      ? "B"
      : "A";
  const overlapping = active.filter((other) =>
    other.touched.some((key) => touched.includes(key)),
  );
  if (!overlapping.length) return "B";
  return isDestructive(intent) || overlapping.some((other) => isDestructive(other.intent))
    ? "C"
    : "B";
}

function detectEarly(agent: string, intent: unknown, touched: string[], active: Intent[]) {
  const overlaps = active
    .filter((other) => other.agent !== agent)
    .map((other) => ({
      agent_id: other.agent,
      intent: label(other.intent),
      destructive: isDestructive(other.intent),
      assignment: other.assignment ?? null,
      symbols: [...new Set(other.touched.filter((key) => touched.includes(key)))].sort(),
    }))
    .filter((overlap) => overlap.symbols.length)
    .sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  const destructive = isDestructive(intent);
  const would_escalate =
    !isAdditive(intent) &&
    overlaps.length > 0 &&
    (destructive || overlaps.some((overlap) => overlap.destructive));
  const partition: Array<{ symbol: string; owner: string; rebase: string[] }> = [];
  const arbitration: string[] = [];
  if (would_escalate)
    for (const symbol of [...new Set(overlaps.flatMap((o) => o.symbols))].sort()) {
      const on = overlaps.filter((overlap) => overlap.symbols.includes(symbol));
      const owners = [
        ...new Set([
          ...on.filter((o) => o.destructive).map((o) => o.agent_id),
          ...(destructive ? [agent] : []),
        ]),
      ].sort();
      const rebase = [
        ...new Set([...on.map((o) => o.agent_id), ...(destructive ? [] : [agent])]),
      ]
        .filter((other) => !owners.includes(other))
        .sort();
      if (owners.length === 1) partition.push({ symbol, owner: owners[0], rebase });
      else if (owners.length > 1) arbitration.push(symbol);
    }
  return { overlaps, would_escalate, partition, arbitration };
}

function coordination(early: ReturnType<typeof detectEarly>) {
  return {
    would_escalate: early.would_escalate,
    overlaps: early.overlaps,
    suggested_partition: early.partition,
    needs_human: early.arbitration,
    advice: early.arbitration.length
      ? "destructive on both sides for some symbols — align in the symbol's thread or escalate before editing"
      : early.would_escalate
        ? "destructive overlap — let the owner serialize the change; rebase your work on those symbols after"
        : early.overlaps.length
          ? "non-destructive overlap — re-read the shared symbols before editing"
          : "clear",
  };
}

function referee(facts: Facts, verdicts: Verdict[], mode: Mode) {
  if (mode === "off") return { outcome: "human_required", detail: { reason: "mediation disabled (off)" } };
  if (facts.both_destructive)
    return { outcome: "human_required", detail: { reason: "destructive change on both sides" } };
  if (facts.deterministic_safe && !facts.has_removal)
    return mode === "auto"
      ? { outcome: "auto_apply", detail: { winner: facts.deterministic_owner } }
      : { outcome: "human_confirm", detail: { recommended_winner: facts.deterministic_owner } };
  if (!verdicts.length) return { outcome: "pending", detail: { reason: "awaiting agent verdict" } };
  const kinds = verdicts.map((entry) => entry.verdict.kind);
  if (kinds.includes("defer_to_human"))
    return { outcome: "human_required", detail: { reason: "an agent deferred to a human" } };
  const reconciles = kinds.filter((kind) => kind === "reconcile").length;
  if (reconciles && reconciles < kinds.length)
    return {
      outcome: "human_required",
      detail: { reason: "agents split between reconcile and recommend" },
    };
  const winners = [...new Set(verdicts.map((entry) => entry.verdict.winner).filter(Boolean))];
  if (!reconciles && winners.length !== 1)
    return { outcome: "human_required", detail: { reason: "agents recommend different winners" } };
  const winner = reconciles ? null : (winners[0] as string);
  return mode === "auto" && !facts.has_removal && verdicts.length >= 2
    ? { outcome: "auto_apply", detail: { winner } }
    : { outcome: "human_confirm", detail: { recommended_winner: winner } };
}

const directive = (escalation: Escalation, agent: string) =>
  escalation.status === "Pending"
    ? "wait"
    : !escalation.winner
      ? "review"
      : escalation.winner === agent
        ? "proceed"
        : "defer";

export function fleetEngine(
  options: {
    mediator?: Mode;
    /** The engine today counts an agent's own live intent as a peer's. A fixed engine would not. */
    countsOwnIntent?: boolean;
    now?: () => number;
    /** The graph's direct callers of a symbol, by the symbol's bare name. */
    callers?: Record<string, Array<{ name: string; file_path: string }>>;
  } = {},
) {
  const mode = options.mediator ?? "auto";
  const countsOwnIntent = options.countsOwnIntent ?? true;
  const clock = options.now ?? Date.now;
  const intents: Intent[] = [];
  const escalations = new Map<string, Escalation>();
  const episodes: Json[] = [];
  const calls: Array<{ name: string; args: Json }> = [];
  let sequence = 0;
  const live = (repo: string, branch: string | null) =>
    intents.filter(
      (intent) => intent.repo === repo && intent.branch === branch && intent.expiresAt > clock(),
    );
  const overlapping = (active: Intent[], touched: string[]) =>
    active.filter((intent) => intent.touched.some((key) => touched.includes(key)));
  const facts = (agent: string, intent: unknown, active: Intent[], early: ReturnType<typeof detectEarly>): Facts => {
    const kindOf = (who: string) =>
      who === agent ? intent : active.find((other) => other.agent === who)?.intent;
    const owners = early.partition.map((part) => kindOf(part.owner)).filter(Boolean);
    const has_removal = owners.some(isRemoval);
    const safe =
      early.would_escalate &&
      !early.arbitration.length &&
      owners.length > 0 &&
      owners.every((owner) => pattern(owner) === "change_signature") &&
      !early.partition.flatMap((part) => part.rebase).some((who) => isStructural(kindOf(who))) &&
      !has_removal;
    return {
      both_destructive: early.arbitration.length > 0,
      has_removal,
      deterministic_safe: safe,
      deterministic_owner: safe ? early.partition[0].owner : null,
    };
  };
  const handlers: Record<string, (args: Json) => Json> = {
    fleet_branch_context(args) {
      const active = live(args.repo_id, args.branch ?? null);
      const pending = [...escalations.values()].filter(
        (item) => item.status === "Pending" && item.repo_id === args.repo_id && item.branch === (args.branch ?? null),
      );
      return {
        you: args.agent_id,
        branch: args.branch ?? null,
        peers: active
          .filter((intent) => intent.agent !== args.agent_id)
          .map((intent) => ({
            agent_id: intent.agent,
            assignment: intent.assignment,
            touched: intent.touched,
            intent: intent.intent,
          })),
        pending_escalations: pending.map((item) => ({
          escalation_id: item.escalation_id,
          repo_id: item.repo_id,
          branch: item.branch,
          status: item.status,
        })),
        recent_peer_episodes: episodes
          .filter((episode) => episode.agent_id !== args.agent_id && episode.branch === (args.branch ?? null))
          .slice(-10),
      };
    },
    fleet_preflight(args) {
      const active = overlapping(live(args.repo_id, args.branch ?? null), args.touched);
      const early = detectEarly(args.agent_id ?? "preflight-caller", args.intent ?? "exploratory", args.touched, active);
      return {
        active_conflicts: active.map((intent) => ({ agent_id: intent.agent, touched: intent.touched, intent: intent.intent })),
        has_conflicts: active.length > 0,
        active_leases: [],
        coordination: coordination(early),
      };
    },
    fleet_publish_intent(args) {
      const active = overlapping(live(args.repo_id, args.branch ?? null), args.touched);
      const early = detectEarly(args.agent_id, args.intent, args.touched, active);
      const intent: Intent = {
        id: "intent-" + ++sequence,
        agent: args.agent_id,
        repo: args.repo_id,
        branch: args.branch ?? null,
        touched: args.touched,
        intent: args.intent,
        assignment: args.assignment,
        expiresAt: clock() + intentTtlMs,
      };
      intents.push(intent);
      return {
        you: args.agent_id,
        intent_id: intent.id,
        impact_preview: [],
        active_conflicts: active.map((other) => ({ agent_id: other.agent, touched: other.touched, intent: other.intent })),
        touched: args.touched,
        branch: args.branch ?? null,
        coordination: coordination(early),
      };
    },
    fleet_record_episode(args) {
      const branch = args.branch ?? null;
      const active = live(args.repo_id, branch).filter(
        (intent) => countsOwnIntent || intent.agent !== args.agent_id,
      );
      const conflict_class = classify(args.intent, args.touched, active);
      const episode_id = "episode-" + ++sequence;
      episodes.push({ episode_id, agent_id: args.agent_id, branch, touched: args.touched, conflict_class });
      if (conflict_class !== "C")
        return {
          you: args.agent_id,
          episode_id,
          conflict_class,
          replan_hint: conflict_class === "A" ? "proceed" : "re-read",
          propagated: [],
          touched: args.touched,
          branch,
          escalation_id: null,
          next_action: null,
          mediation_request: null,
        };
      const involved = overlapping(active, args.touched);
      const early = detectEarly(args.agent_id, args.intent, args.touched, active);
      const escalation: Escalation = {
        escalation_id: "escalation-" + ++sequence,
        repo_id: args.repo_id,
        branch,
        episode_id,
        agent_id: args.agent_id,
        touched: args.touched,
        conflicting_agents: involved.map((intent) => intent.agent),
        status: "Pending",
        facts: facts(args.agent_id, args.intent, active, early),
        mode,
        verdicts: [],
      };
      escalations.set(escalation.escalation_id, escalation);
      return {
        you: args.agent_id,
        episode_id,
        conflict_class,
        replan_hint: "defer",
        propagated: [],
        touched: args.touched,
        branch,
        escalation_id: escalation.escalation_id,
        next_action: { poll: "fleet_get_escalation", escalation_id: escalation.escalation_id },
        mediation_request:
          mode === "off"
            ? null
            : {
                escalation_id: escalation.escalation_id,
                assignments: involved.map((intent) => ({
                  agent_id: intent.agent,
                  assignment: intent.assignment,
                  intent: intent.intent,
                })),
                touched: args.touched,
                blast_radius: [],
                suggested_partition: coordination(early).suggested_partition,
                mode,
              },
      };
    },
    fleet_submit_verdict(args) {
      const escalation = escalations.get(args.escalation_id);
      if (!escalation || escalation.status !== "Pending")
        return { accepted: false, reason: "unknown or already-resolved escalation", escalation_id: args.escalation_id };
      escalation.verdicts = [
        ...escalation.verdicts.filter((entry) => entry.agent_id !== args.agent_id),
        { agent_id: args.agent_id, verdict: args.verdict },
      ];
      const decided = referee(escalation.facts, escalation.verdicts, escalation.mode);
      if (decided.outcome === "auto_apply") {
        escalation.status = "Resolved";
        escalation.winner = (decided.detail as Json).winner ?? null;
        escalation.recommended_winner = escalation.winner;
        escalation.resolution = escalation.winner
          ? `auto-resolved by agent consensus — ${escalation.winner} proceeds`
          : "auto-resolved by agent consensus — reconcile (all proceed)";
        escalation.resolved_by = "agents";
      } else
        escalation.recommended_winner =
          decided.outcome === "human_confirm" ? (decided.detail as Json).recommended_winner : null;
      return {
        escalation_id: args.escalation_id,
        ...decided,
        your_directive: directive(escalation, args.agent_id),
        verdicts_collected: escalation.verdicts.length,
        escalation: { ...escalation },
      };
    },
    fleet_get_escalation(args) {
      const escalation = escalations.get(args.escalation_id);
      if (!escalation) return { found: false, escalation_id: args.escalation_id };
      return {
        ...escalation,
        ...(args.agent_id ? { your_directive: directive(escalation, args.agent_id) } : {}),
      };
    },
    fleet_resolve_escalation(args) {
      const escalation = escalations.get(args.escalation_id);
      if (!escalation || escalation.status !== "Pending")
        return { resolved: false, reason: "unknown or already-resolved escalation" };
      Object.assign(escalation, {
        status: "Resolved",
        resolution: args.resolution,
        winner: args.winner || null,
        resolved_by: "human",
      });
      return { ...escalation };
    },
    get_impact(args) {
      const rows = options.callers?.[args.target] ?? [];
      return {
        found: rows.length > 0,
        by_depth: rows.length ? { "1": rows } : {},
        affected_files: [...new Set(rows.map((row) => row.file_path))],
      };
    },
    fleet_list_escalations(args) {
      const pending = [...escalations.values()].filter(
        (item) => item.status === "Pending" && item.repo_id === args.repo_id,
      );
      return { repo_id: args.repo_id, pending, count: pending.length };
    },
  };
  const engine = {
    call: async (_project: unknown, name: string, args: Json) => {
      calls.push({ name, args });
      // Graph tools (find_code and the rest) are not Fleet's; they answer with nothing.
      return handlers[name]?.(args) ?? {};
    },
    activateEpic: async () => {},
    analyze: async () => "fixture",
    qualify: async () => ({
      state: "partial",
      symbols: [],
      incomplete: true,
      note: "Fixture scope",
      measuredAt: new Date().toISOString(),
    }),
  } as unknown as MemtraceEngine;
  return {
    engine,
    calls,
    escalations,
    /** How many times each engine tool was called. */
    counts: () =>
      calls.reduce<Record<string, number>>(
        (all, call) => ({ ...all, [call.name]: (all[call.name] ?? 0) + 1 }),
        {},
      ),
  };
}
