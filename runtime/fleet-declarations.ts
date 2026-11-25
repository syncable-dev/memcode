import { randomUUID } from "node:crypto";
import type { AppState, WorkItem } from "../src/shared";
import {
  breaksAt,
  type ChangeKind,
  type ConflictClass,
  type FleetDeclaration,
} from "../src/fleet";
import { isActive } from "../src/domain";
import { fileOf } from "./fleet-symbols";
import { now } from "./local";

const keptDeclarations = 400;
/** A breaking change that never gets recorded stops holding others after this long. */
const breakingHoldMs = 180_000;
/** How far back a recorded change still counts as recent to a worker starting on the symbol. */
const recentMs = 600_000;

export const sharedSymbols = (left: string[], right: string[]) =>
  left.filter((symbol) => right.includes(symbol));
/** The symbols two edits share that at least one of them reshapes or removes. */
export const brokenBetween = (
  left: Pick<FleetDeclaration, "symbols" | "kind">,
  right: Pick<FleetDeclaration, "symbols" | "kind">,
) =>
  sharedSymbols(left.symbols, right.symbols).filter(
    (symbol) => breaksAt(left.kind, symbol) || breaksAt(right.kind, symbol),
  );
const sharedFiles = (left: string[], right: string[]) =>
  sharedSymbols([...new Set(left.map(fileOf))], right.map(fileOf));

/**
 * What every worker in a goal is changing right now, and what it changed lately. This is
 * what lets workers edit at the same time: each one sees who else is on a symbol and why.
 */
export class FleetDeclarations {
  private tick: number;
  constructor(private state: () => AppState) {
    this.tick = Math.max(
      0,
      ...this.all().map((declaration) => declaration.closed ?? declaration.opened),
    );
  }
  private all(): FleetDeclaration[] {
    return (this.state().fleetDeclarations ??= []);
  }
  private running(taskId: string) {
    const task = this.state().tasks.find((item) => item.id === taskId);
    return !!task && isActive(task);
  }
  private inFlight(declaration: FleetDeclaration) {
    return !declaration.recordedAt && this.running(declaration.taskId);
  }
  /** Other tasks' declarations in the same goal checkout. */
  private beside(task: WorkItem) {
    return this.all().filter(
      (declaration) =>
        declaration.taskId !== task.id &&
        declaration.projectId === task.projectId &&
        declaration.branch === task.run.branch,
    );
  }
  /** The group of edits the task announced and has not recorded yet. */
  open(task: WorkItem) {
    return this.all().find(
      (declaration) => declaration.taskId === task.id && !declaration.recordedAt,
    );
  }
  announce(task: WorkItem, symbols: string[], kind: ChangeKind, plan: string) {
    const declaration: FleetDeclaration = {
      id: randomUUID(),
      taskId: task.id,
      projectId: task.projectId,
      branch: task.run.branch!,
      symbols,
      kind,
      plan,
      declaredAt: now(),
      opened: ++this.tick,
    };
    const all = this.all();
    all.push(declaration);
    if (all.length > keptDeclarations)
      all.splice(0, all.length - keptDeclarations);
    return declaration;
  }
  close(declaration: FleetDeclaration, conflictClass?: ConflictClass) {
    declaration.recordedAt = now();
    declaration.closed = ++this.tick;
    declaration.class = conflictClass;
  }
  /** Ends whatever the task left open, for a worker that stopped without recording. */
  abandon(task: WorkItem) {
    for (const declaration of this.all())
      if (declaration.taskId === task.id && !declaration.recordedAt)
        this.close(declaration);
  }
  /** Peers editing any of these symbols right now. */
  editingNow(task: WorkItem, symbols: string[]) {
    return this.beside(task).filter(
      (declaration) =>
        this.inFlight(declaration) &&
        sharedSymbols(declaration.symbols, symbols).length > 0,
    );
  }
  /** Peers editing other symbols in the same files right now. */
  inSameFiles(task: WorkItem, symbols: string[]) {
    return this.beside(task).filter(
      (declaration) =>
        this.inFlight(declaration) &&
        !sharedSymbols(declaration.symbols, symbols).length &&
        sharedFiles(declaration.symbols, symbols).length > 0,
    );
  }
  /** Changes peers recorded to these symbols since this task last started on them. */
  changedRecently(task: WorkItem, symbols: string[]) {
    const lastLooked = Math.max(
      0,
      ...this.all()
        .filter(
          (declaration) =>
            declaration.taskId === task.id &&
            sharedSymbols(declaration.symbols, symbols).length > 0,
        )
        .map((declaration) => declaration.opened),
    );
    return this.beside(task)
      .filter(
        (declaration) =>
          !!declaration.recordedAt &&
          declaration.closed! > lastLooked &&
          Date.now() - Date.parse(declaration.recordedAt) < recentMs &&
          sharedSymbols(declaration.symbols, symbols).length > 0,
      )
      .reverse();
  }
  /** A peer's breaking change to one of these symbols that has not been recorded yet. */
  breakingInFlight(task: WorkItem, symbols: string[]) {
    return this.editingNow(task, symbols).find(
      (declaration) =>
        sharedSymbols(declaration.symbols, symbols).some((symbol) =>
          breaksAt(declaration.kind, symbol),
        ) &&
        Date.now() - Date.parse(declaration.declaredAt) < breakingHoldMs,
    );
  }
  /**
   * Peers that reshaped one of these symbols in work nobody has accepted yet. A second task
   * reshaping it too is a disagreement about the symbol, however far apart the edits were.
   */
  reshapedBy(task: WorkItem, symbols: string[]) {
    const latest = new Map<string, FleetDeclaration>();
    for (const declaration of this.beside(task))
      if (
        !!declaration.recordedAt &&
        this.unaccepted(declaration.taskId) &&
        sharedSymbols(declaration.symbols, symbols).some((symbol) =>
          breaksAt(declaration.kind, symbol),
        )
      )
        latest.set(declaration.taskId, declaration);
    return [...latest.values()];
  }
  private unaccepted(taskId: string) {
    const task = this.state().tasks.find((item) => item.id === taskId);
    return !!task && task.stage !== "done";
  }
  /**
   * Peers whose edits to these symbols overlapped in time with `own`: still in flight, or
   * recorded after `own` was declared. A change recorded earlier is history `own` built on.
   */
  concurrentWith(task: WorkItem, own: FleetDeclaration, symbols: string[]) {
    return this.beside(task).filter(
      (declaration) =>
        sharedSymbols(declaration.symbols, symbols).length > 0 &&
        (declaration.closed === undefined
          ? this.inFlight(declaration)
          : declaration.closed > own.opened),
    );
  }
  /** Other tasks with unrecorded edits declared in this file. */
  editorsOf(task: WorkItem, file: string): string[] {
    return [
      ...new Set(
        this.beside(task)
          .filter(
            (declaration) =>
              this.inFlight(declaration) &&
              declaration.symbols.some((symbol) => fileOf(symbol) === file),
          )
          .map((declaration) => declaration.taskId),
      ),
    ];
  }
  /** Peers whose declared symbols or files a change to `symbols` touches. */
  touchedBy(task: WorkItem, symbols: string[]) {
    return this.beside(task).filter(
      (declaration) =>
        this.inFlight(declaration) &&
        sharedFiles(declaration.symbols, symbols).length > 0,
    );
  }
  /** Everything peers in the goal are editing right now. */
  everyoneEditing(task: WorkItem) {
    return this.beside(task).filter((declaration) => this.inFlight(declaration));
  }
  /** The peers' latest recorded changes, newest first. */
  latestRecorded(task: WorkItem, count: number) {
    return this.beside(task)
      .filter((declaration) => !!declaration.recordedAt && !!declaration.class)
      .slice(-count)
      .reverse();
  }
  /** Every declaration of these tasks on these symbols joins the disagreement. */
  attach(decisionId: string, taskIds: string[], symbols: string[]) {
    for (const declaration of this.all())
      if (
        taskIds.includes(declaration.taskId) &&
        sharedSymbols(declaration.symbols, symbols).length > 0
      )
        declaration.decisionId ??= decisionId;
  }
}
