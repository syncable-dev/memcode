import { breaksCallers, type FleetPosition } from "../src/fleet";

/** What MemCode allows for a disagreement right now. */
export type Ruling =
  | { settle: true; winnerTaskId: string | undefined }
  | { wait: true }
  | { person: "confirm" | "decide"; recommendedTaskId?: string; reason?: string };

/**
 * MemCode's own floor under Fleet's referee, judged from what each worker actually
 * declared for the contested code. Fleet reads a worker's kind of change from any of its
 * recent declarations, so on its own it can mistake a removal for a safe change and settle
 * it without the person. Nothing is settled here that these rules do not allow:
 *
 * - two breaking changes to the same code, a worker asking, or workers disagreeing: the person decides;
 * - moving or removing code under someone's edit: the person confirms, always;
 * - a signature change over ordinary edits: safe to order, the signature change stands;
 * - anything else: settled only when at least two workers judged the same way.
 *
 * `awaiting` names the workers involved that are still running and have not judged.
 */
export function ruling(positions: FleetPosition[], awaiting: string[]): Ruling {
  const breaking = positions.filter(
    (position) => position.kind && breaksCallers(position.kind),
  );
  if (breaking.length > 1)
    return { person: "decide", reason: "Both changes break what the other relies on." };
  const judged = positions.filter((position) => position.verdict);
  if (judged.some((position) => position.verdict === "ask_human"))
    return { person: "decide", reason: "A worker asked for your call." };
  if (!judged.length) return { wait: true };
  const agreed = agreement(judged);
  if (!agreed) return { person: "decide", reason: "The workers disagree." };
  const removes = positions.some(
    (position) => position.kind === "move" || position.kind === "remove",
  );
  if (!removes && safeToOrder(positions, breaking))
    return { settle: true, winnerTaskId: breaking[0].taskId };
  if (!removes && judged.length >= 2)
    return { settle: true, winnerTaskId: agreed.winnerTaskId };
  if (awaiting.length) return { wait: true };
  return {
    person: "confirm",
    recommendedTaskId: agreed.winnerTaskId,
    ...(removes ? { reason: "Code is being moved or removed." } : {}),
  };
}

/** What the verdicts given so far agree on; nothing when they differ. */
function agreement(judged: FleetPosition[]): { winnerTaskId: string | undefined } | undefined {
  const reconciles = judged.filter((position) => position.verdict === "reconcile").length;
  if (reconciles === judged.length) return { winnerTaskId: undefined };
  if (reconciles) return undefined;
  const winners = new Set(judged.map((position) => position.winnerTaskId));
  return winners.size === 1 ? { winnerTaskId: [...winners][0] } : undefined;
}

const reshapes = new Set(["rename", "move", "signature"]);
/** One signature change, and every other party making a known change that does not reshape the symbol. */
function safeToOrder(positions: FleetPosition[], breaking: FleetPosition[]) {
  return (
    breaking.length === 1 &&
    breaking[0].kind === "signature" &&
    positions.every(
      (position) =>
        position === breaking[0] || (!!position.kind && !reshapes.has(position.kind)),
    )
  );
}
