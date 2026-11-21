import { randomUUID } from "node:crypto";
import type { AppState, FleetConflict, Project, WorkItem } from "../src/shared";
import {
  changeVerbs,
  type FleetDeclaration,
  type FleetPosition,
} from "../src/fleet";
import { isActive } from "../src/domain";
import { sharedSymbols } from "./fleet-declarations";
import { now } from "./local";

/** How long the workers involved get to answer before the person is asked instead. */
const verdictWindowMs = 120_000;

export const agentOf = (taskId: string) => "memcode:" + taskId;
export type Directive = "wait" | "proceed" | "defer";

/**
 * Real disagreements between workers: two edits that cannot both stand as they are. The
 * workers involved judge first; a decision reaches the person only when they disagree,
 * one of them asks, or code is being removed.
 */
export class FleetDecisions {
  constructor(private state: () => AppState) {}
  private all() {
    return this.state().fleetConflicts;
  }
  private task(taskId?: string) {
    return this.state().tasks.find((task) => task.id === taskId);
  }
  /** The task behind an agent name Fleet knows, when it is one of MemCode's workers. */
  taskOf(agentId?: string | null) {
    return agentId?.startsWith("memcode:")
      ? this.task(agentId.slice("memcode:".length))
      : undefined;
  }
  find(id: string) {
    return this.all().find((item) => item.id === id || item.escalationId === id);
  }
  /** A disagreement not yet settled that covers any of these symbols in the task's goal. */
  openOn(task: WorkItem, symbols: string[]) {
    return this.all().find(
      (item) =>
        item.status === "open" &&
        item.severity === "C" &&
        item.projectId === task.projectId &&
        item.branch === task.run.branch &&
        sharedSymbols(item.scope, symbols).length > 0,
    );
  }
  /** Whether a peer's edit was already part of a settled disagreement with this task. */
  settledWith(task: WorkItem, peer: FleetDeclaration) {
    const decision = peer.decisionId ? this.find(peer.decisionId) : undefined;
    return decision?.status === "resolved" && decision.taskIds.includes(task.id);
  }
  raise(
    project: Project,
    task: WorkItem,
    symbols: string[],
    positions: FleetPosition[],
    escalationId?: string,
  ): FleetConflict {
    const decision: FleetConflict = {
      id: escalationId ?? randomUUID(),
      projectId: project.id,
      epicId: task.epicId ?? undefined,
      branch: task.run.branch ?? project.branch,
      taskIds: positions.flatMap((position) => position.taskId ?? []),
      agentIds: positions.map((position) => position.agentId),
      scope: symbols,
      severity: "C",
      source: "episode",
      summary: this.summary(symbols, positions),
      status: "open",
      createdAt: now(),
      escalationId,
      positions,
    };
    this.all().push(decision);
    return decision;
  }
  /** One sentence for the person: "MC-12 is changing the signature of cartTotal while MC-13 is renaming it." */
  private summary(symbols: string[], positions: FleetPosition[]) {
    const what = symbols.map((symbol) => symbol.split("::").pop()).join(", ");
    const [first, ...others] = positions.map((position) => ({
      who: this.task(position.taskId)?.identifier ?? position.agentId,
      doing: position.kind ? changeVerbs[position.kind] : "changing",
    }));
    if (!first) return what;
    const rest = others.map((other) => `${other.who} is ${other.doing} it`).join(" and ");
    return `${first.who} is ${first.doing} ${what}${rest ? " while " + rest : ""}.`;
  }
  /** Adds a party that recorded into a disagreement already open. */
  join(decision: FleetConflict, position: FleetPosition) {
    const positions = (decision.positions ??= []);
    if (positions.some((known) => known.agentId === position.agentId)) return;
    positions.push(position);
    decision.agentIds.push(position.agentId);
    if (position.taskId) decision.taskIds.push(position.taskId);
    decision.summary = this.summary(decision.scope, positions);
  }
  position(decision: FleetConflict, task: WorkItem) {
    return decision.positions?.find((position) => position.taskId === task.id);
  }
  /** Workers involved that are still running and have not judged yet. */
  awaiting(decision: FleetConflict) {
    return (decision.positions ?? []).filter((position) => {
      const task = this.task(position.taskId);
      return !position.verdict && !!task && isActive(task);
    });
  }
  askPerson(decision: FleetConflict, needs: "confirm" | "decide", reason?: string) {
    decision.needs = needs;
    decision.needsReason = reason;
  }
  settle(
    decision: FleetConflict,
    outcome: { resolution: string; winnerTaskId?: string; by: "agents" | "human" },
  ) {
    Object.assign(decision, {
      status: "resolved",
      resolution: outcome.resolution,
      winnerTaskId: outcome.winnerTaskId,
      resolvedAt: now(),
      resolutionKind: outcome.by,
      needs: undefined,
      needsReason: undefined,
    });
  }
  /** What the decision means for one task: hold the contested code, go ahead, or rebuild on the other's. */
  directive(decision: FleetConflict, task: WorkItem): Directive {
    if (decision.status === "open") return "wait";
    return !decision.winnerTaskId || decision.winnerTaskId === task.id
      ? "proceed"
      : "defer";
  }
  /** Disagreements the workers were asked to judge and have left unanswered for too long. */
  unanswered(project: Project) {
    return this.all().filter(
      (item) =>
        item.status === "open" &&
        item.projectId === project.id &&
        !item.needs &&
        !!item.positions &&
        Date.now() - Date.parse(item.createdAt) > verdictWindowMs,
    );
  }
  /** The disagreement as a worker reads it: who wants what. */
  brief(decision: FleetConflict) {
    const name = (taskId?: string) => this.task(taskId)?.identifier;
    return {
      id: decision.id,
      symbols: decision.scope,
      positions: (decision.positions ?? []).map((position) => ({
        task: name(position.taskId) ?? position.agentId,
        title: this.task(position.taskId)?.title,
        kind: position.kind,
        plan: position.plan,
        verdict: position.verdict,
        recommends: name(position.winnerTaskId),
        reason: position.reason,
      })),
      needsPerson: decision.needs,
      resolution: decision.resolution,
    };
  }
}
