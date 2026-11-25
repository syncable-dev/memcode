import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppState, FleetConflict, Project, WorkItem } from "../src/shared";
import { workerRecordsFolder } from "./worker-records";
import {
  breaksAt,
  breaksCallers,
  changeKinds,
  changeVerbs,
  onlyAdds,
  type ChangeKind,
  type FleetDeclaration,
  type FleetPosition,
} from "../src/fleet";
import type { MemtraceEngine } from "./memtrace";
import { isActive } from "../src/domain";
import { now } from "./local";
import { coordinationSchema, type CoordinationRequest } from "./fleet-requests";
import { engineBreaks, engineIntent, fileOf, symbolIdentity } from "./fleet-symbols";
import { conflictClass } from "./fleet-classes";
import { ruling } from "./fleet-referee";
import { brokenBetween, FleetDeclarations, sharedSymbols } from "./fleet-declarations";
import { FleetDecisions, agentOf } from "./fleet-decisions";
import { FleetNews, type FleetNewsItem } from "./fleet-news";
import { rereadFleetSource } from "./fleet-source";
import { WorkerChangeJournal } from "./changes";
import { epicAnalysisProject } from "./epic-checkout";

export class FleetBlocked extends Error {}
type Json = Record<string, any>;
type Edit = Pick<CoordinationRequest, "symbols" | "kind" | "plan">;
/** An agent outside MemCode working on the same branch, as Fleet reports it. */
type Outsider = { agentId: string; plan?: string; breaks: boolean; symbols: string[] };

interface Hold {
  symbols: string[];
  decisionId?: string;
}
/** What a worker that ended its turn was still waiting for. */
export interface Owed {
  /** A disagreement that is still open. */
  open?: FleetConflict;
  /** One settled after the worker last heard from MemCode. */
  settled?: FleetConflict;
  /** Code a peer's change held, which is free now. */
  freed: string[];
  /** Code a peer is still reshaping. */
  busy: string[];
}

/** Fleet forgets a declaration after two minutes; one still being edited is renewed before that. */
const renewDeclarationMs = 45_000;
/** How often a goal asks Fleet whether a decision was settled somewhere else. */
const decisionCheckMs = 10_000;
/** A hot symbol can have dozens of editors; a reply names the first few. */
const peersListed = 6;
const keptMessages = 250;
/** How many of an edit's symbols the graph is asked about; a wide edit names the first few. */
const callersAsked = 5;
/** A change of this kind reaches the code that calls the symbol, not only the symbol itself. */
const reachesCallers = (kind: ChangeKind) => breaksCallers(kind) || kind === "rename";
/** Fleet's reason when it counts two sides that each break what the other relies on. */
const bothDestructive = "destructive change on both sides";
/** A person may take minutes or hours: the worker stops cleanly and MemCode brings it back. */
const whileThePersonDecides =
  "Finish your other symbols first. When nothing else is left, end your turn and say you are waiting for the decision: MemCode pauses this task and brings you back with the decision, so do not keep polling.";

/**
 * Lets the workers of a goal edit one checkout at the same time. Each worker declares what
 * it is about to change, edits without waiting, and records what it changed; Memtrace Fleet
 * keeps the trail and referees, and peers hear about each change as it lands. Only a
 * breaking change that meets someone else's edit becomes a decision, which the workers
 * involved judge before anyone asks the person.
 */
export class FleetCoordinator {
  private changes = new WorkerChangeJournal();
  private declarations: FleetDeclarations;
  private decisions: FleetDecisions;
  private news = new FleetNews();
  /** Symbols a worker was told to hold; it hears when they change. */
  private watching = new Map<string, Set<string>>();
  /** What each worker was told to hold and has not declared again. */
  private held = new Map<string, Hold[]>();
  /** A disagreement was settled: the workers that stopped for it can carry on. */
  onSettled?: (decision: FleetConflict) => void;
  /** A worker is done reshaping these symbols: those that stopped for them can carry on. */
  onFreed?: (task: WorkItem, symbols: string[]) => void;
  private renewed = new Map<string, number>();
  private outsiders = new Map<string, Outsider[]>();
  private decisionsChecked = new Map<string, number>();
  constructor(
    private state: () => AppState,
    private engine: MemtraceEngine,
    private changed: () => Promise<void>,
  ) {
    this.declarations = new FleetDeclarations(state);
    this.decisions = new FleetDecisions(state);
  }

  /** Joins the goal's fleet. Nothing is reserved: the worker declares as it goes. */
  async before(project: Project, task: WorkItem): Promise<void> {
    const analysis = epicAnalysisProject(project, task);
    if (!analysis.repoId || analysis.analysis !== "ready")
      throw new Error(
        "Connect Memtrace before launching a shared-branch Fleet worker.",
      );
    this.closeEarlierBookkeeping(project);
    this.declarations.abandon(task);
    await this.changes.begin(project, task);
    const context = await this.call(project, task, "fleet_branch_context", {});
    for (const pending of context.pending_escalations ?? [])
      this.adopt(project, task, pending);
    await this.changed();
  }

  async coordinate(
    project: Project,
    task: WorkItem,
    input: unknown,
    signal?: AbortSignal,
  ) {
    const request = coordinationSchema.parse(input);
    if (signal?.aborted) throw Error("Worker coordination was cancelled.");
    const reply = await this.respond(project, task, request, signal);
    const news = this.news.take(task.id);
    this.heard(task, news);
    await this.remember(task, request, reply);
    await this.changed();
    return news.length ? { ...reply, news } : reply;
  }
  private respond(
    project: Project,
    task: WorkItem,
    request: CoordinationRequest,
    signal?: AbortSignal,
  ): Promise<Json> {
    switch (request.action) {
      case "declare":
        return this.declare(project, task, request);
      case "record":
        return this.record(project, task, request);
      case "verdict":
        return this.judge(project, task, request);
      case "sync":
        return this.sync(task, request, signal);
    }
  }
  /** Updates waiting for the worker, handed over with whatever it asked MemCode next. */
  pendingNews(task: WorkItem): FleetNewsItem[] {
    const news = this.news.take(task.id);
    this.heard(task, news);
    return news;
  }
  /** A worker that was told its code is free again knows: what it does with that is its call. */
  private heard(task: WorkItem, news: FleetNewsItem[]) {
    for (const item of news)
      this.held.set(
        task.id,
        (this.held.get(task.id) ?? []).filter((hold) =>
          item.type === "decided"
            ? hold.decisionId !== item.decisionId
            : item.type !== "peer_changed" ||
              !!hold.decisionId ||
              !sharedSymbols(hold.symbols, (item.symbols as string[]) ?? []).length,
        ),
      );
  }

  // ── Declare: say what you are about to change, then edit ────────────────────

  private async declare(project: Project, task: WorkItem, request: Edit) {
    const { symbols, kind } = this.named(project, task, request);
    const hold = this.holdOn(task, symbols);
    if (hold) return hold;
    if (this.declarations.open(task)) await this.record(project, task, {});
    const plan = request.plan ?? task.title;
    const rivals = this.rivalShapes(task, symbols, kind);
    if (rivals.length) return this.contest(project, task, { symbols, kind, plan }, rivals);
    const editing = this.declarations.editingNow(task, symbols);
    const lately = this.declarations.changedRecently(task, symbols);
    const nearby = this.declarations.inSameFiles(task, symbols);
    const published = await this.publish(project, task, symbols, kind, plan);
    const own = this.declarations.announce(task, symbols, kind, plan);
    this.renewed.set(own.id, Date.now());
    this.outsiders.set(own.id, this.outsidersIn(published.coordination?.overlaps));
    this.stopWatching(task, symbols);
    await this.changes.begin(project, task, [...new Set(symbols.map(fileOf))]);
    const warning = breaksCallers(kind) ? this.warnEditors(task, own, editing) : undefined;
    if (breaksCallers(kind))
      await this.tellCallers(project, task, own, "peer_starting", editing.map((peer) => peer.taskId));
    return {
      directive: "proceed",
      canEdit: true,
      symbols,
      editingNow: [
        ...this.peers(editing),
        ...this.outsiders.get(own.id)!.map((outsider) => ({
          task: outsider.agentId,
          plan: outsider.plan,
          symbols: outsider.symbols,
        })),
      ],
      changedRecently: this.peers(lately),
      sameFiles: this.peers(nearby),
      ...(warning ? { warning } : {}),
      requirement:
        "Edit now. Call record as soon as this group of edits is done, before anything else.",
    };
  }
  /** Peers' unsettled reshapings of a symbol this task is about to reshape as well. */
  private rivalShapes(task: WorkItem, symbols: string[], kind: ChangeKind) {
    const reshaped = symbols.filter((symbol) => breaksAt(kind, symbol));
    if (!reshaped.length) return [];
    return this.declarations
      .reshapedBy(task, reshaped)
      .filter((peer) => !this.settledBetween(task, { symbols: reshaped, kind }, peer));
  }
  /** A disagreement about what the two edits break between them that is already settled. */
  private settledBetween(
    task: WorkItem,
    own: Pick<FleetDeclaration, "symbols" | "kind">,
    peer: FleetDeclaration,
  ) {
    const broken = brokenBetween(own, peer);
    return broken.length > 0 && this.decisions.settledWith(task, peer, broken);
  }
  /**
   * Two tasks want different shapes for the same symbol. The second one does not edit it:
   * whichever went in last would silently replace the other, so the person chooses.
   */
  private contest(
    project: Project,
    task: WorkItem,
    wanted: { symbols: string[]; kind: ChangeKind; plan: string },
    rivals: FleetDeclaration[],
  ) {
    const contested = [
      ...new Set(rivals.flatMap((rival) => brokenBetween(wanted, rival))),
    ];
    const decision = this.decisions.raise(project, task, contested, [
      { taskId: task.id, agentId: agentOf(task.id), kind: wanted.kind, plan: wanted.plan },
      ...rivals.map((rival) => this.positionOf(rival)),
    ]);
    this.declarations.attach(decision.id, decision.taskIds, decision.scope);
    this.decisions.askPerson(
      decision,
      "decide",
      "Both tasks reshape the same code in different ways, and only one shape can stand.",
    );
    this.askToJudge(task, decision);
    return this.hold(task, contested, {
      decision: this.decisions.brief(decision),
      requirement: `${this.peers(rivals).map((peer) => peer.task).join(", ")} already reshaped ${contested.join(", ")} for its own task, and your task wants a different shape. Do not edit it: a person is choosing between the two. Say what your task needs by calling coordinate with action verdict and decisionId ${decision.id} (reconcile, recommend or ask_human, with your reason). ${whileThePersonDecides}`,
    });
  }
  private named(project: Project, task: WorkItem, request: Edit) {
    if (!request.symbols?.length)
      throw Error("Name the symbols you are about to change, each as file::symbol.");
    if (!request.kind)
      throw Error(`Say what kind of change this is: ${changeKinds.join(", ")}.`);
    return {
      symbols: this.identities(project, task, request.symbols),
      kind: request.kind,
    };
  }
  private identities(project: Project, task: WorkItem, symbols: string[]) {
    const roots = { workspace: task.run.workspace ?? project.path!, project };
    return [...new Set(symbols.map((symbol) => symbolIdentity(symbol, roots)))];
  }
  /** The one case a worker does not edit straight away: the symbol is contested or being reshaped. */
  private holdOn(task: WorkItem, symbols: string[]): Json | undefined {
    const decision = this.decisions.openOn(task, symbols);
    if (decision)
      return this.hold(task, sharedSymbols(symbols, decision.scope), {
        decision: this.decisions.brief(decision),
        requirement: decision.needs
          ? `A person is deciding about these symbols, so do not edit them. ${whileThePersonDecides}`
          : "A disagreement on these symbols is not settled yet, so do not edit them. Carry on with your other symbols, or call sync with waitMs to hear when it is settled.",
      });
    const breaking = this.declarations.breakingInFlight(task, symbols);
    if (!breaking) return undefined;
    const peer = this.peer(breaking);
    return this.hold(task, sharedSymbols(symbols, breaking.symbols), {
      heldBy: peer,
      ownerTaskId: breaking.taskId,
      requirement: `${peer.task} is ${changeVerbs[breaking.kind]} these right now, so anything built on the current version would be wasted. Carry on with your other symbols, or call sync with waitMs to hear the moment it is recorded. Then declare again and build on the new version.`,
    });
  }
  private hold(task: WorkItem, heldSymbols: string[], detail: Json) {
    const watched = this.watching.get(task.id) ?? new Set<string>();
    for (const symbol of heldSymbols) watched.add(symbol);
    this.watching.set(task.id, watched);
    const held = (this.held.get(task.id) ?? []).filter(
      (item) => !sharedSymbols(item.symbols, heldSymbols).length,
    );
    this.held.set(task.id, [
      ...held,
      { symbols: heldSymbols, decisionId: detail.decision?.id },
    ]);
    return { directive: "hold", canEdit: false, heldSymbols, ...detail };
  }
  private stopWatching(task: WorkItem, symbols: string[]) {
    for (const symbol of symbols) this.watching.get(task.id)?.delete(symbol);
    // It named part of what it was held on and went ahead: the rest it can do without.
    this.held.set(
      task.id,
      (this.held.get(task.id) ?? []).filter(
        (item) => !sharedSymbols(item.symbols, symbols).length,
      ),
    );
  }
  /** A breaking change is about to land under peers' edits: they hear now, not after the fact. */
  private warnEditors(task: WorkItem, own: FleetDeclaration, editing: FleetDeclaration[]) {
    if (!editing.length) return undefined;
    for (const peer of editing) {
      const shared = sharedSymbols(peer.symbols, own.symbols);
      this.news.tell(peer.taskId, {
        type: "peer_starting",
        at: now(),
        task: task.identifier,
        kind: own.kind,
        plan: own.plan,
        symbols: shared,
        message: `${task.identifier} is ${changeVerbs[own.kind]} ${shared.join(", ")} right now: ${own.plan} You are editing it too. Record your edit, then re-read it once ${task.identifier} has recorded. If this breaks your task, say so when you are asked to judge.`,
      });
    }
    const names = this.peers(editing).map((peer) => peer.task).join(", ");
    return `${names} ${editing.length > 1 ? "are" : "is"} editing this right now and has been told. Your change lands under that edit, so after you record you will both be asked to judge whether the two still fit.`;
  }

  // ── Record: say what you changed; Fleet classes it against the peers' edits ─

  private async record(project: Project, task: WorkItem, request: Edit): Promise<Json> {
    const own = this.declarations.open(task) ?? this.declareLate(project, task, request);
    if (request.symbols) own.symbols = this.identities(project, task, request.symbols);
    if (request.kind) own.kind = request.kind;
    const files = [...new Set(own.symbols.map(fileOf))];
    await this.attribute(project, task, files);
    const episode = await this.call(project, task, "fleet_record_episode", {
      intent: engineIntent(own.kind, own.symbols),
      touched: own.symbols,
      metadata: {
        source: "memcode",
        task_id: task.id,
        epic_id: task.epicId,
        kind: own.kind,
        plan: own.plan,
        shared_branch: true,
        changes_revision: task.changesRevision,
      },
    });
    const overlapping = this.declarations.concurrentWith(task, own, own.symbols);
    const peers = [
      ...overlapping,
      ...this.rivalShapes(task, own.symbols, own.kind).filter(
        (rival) => !overlapping.some((peer) => peer.taskId === rival.taskId),
      ),
    ].filter((peer) => !this.settledBetween(task, own, peer));
    const outsiders = this.outsidersAt(own, episode);
    const reached = conflictClass(onlyAdds(own.kind) ? own.kind : "change", [
      ...peers.map((peer) => brokenBetween(own, peer).length > 0),
      ...outsiders.map((outsider) => breaksCallers(own.kind) || outsider.breaks),
    ]);
    this.declarations.close(own, reached);
    this.onFreed?.(task, own.symbols);
    const told = this.tellPeers(task, own);
    if (reachesCallers(own.kind))
      await this.tellCallers(project, task, own, "peer_changed", told);
    if (reached === "C")
      return this.disagree(project, task, own, peers, outsiders, episode);
    if (episode.escalation_id)
      await this.dismiss(project, task, episode.escalation_id, "No other worker's edit overlapped this change.");
    if (reached === "A") return { class: "A", directive: "proceed" };
    return {
      class: "B",
      directive: "reread",
      because: [
        ...this.peers(peers),
        ...outsiders.map((outsider) => ({ task: outsider.agentId, plan: outsider.plan })),
      ],
      source: await rereadFleetSource(project, task, files),
      requirement:
        "Another worker changed the same symbol while you did. Both edits are in the files: read the source in this reply and build on it before you edit this symbol again.",
    };
  }
  private declareLate(project: Project, task: WorkItem, request: Edit) {
    if (!request.symbols?.length || !request.kind)
      throw Error(
        "Declare what you are about to change before you edit it, then record it.",
      );
    const { symbols, kind } = this.named(project, task, request);
    return this.declarations.announce(task, symbols, kind, request.plan ?? task.title);
  }
  /** Records the edit as this task's. A file a peer is still editing elsewhere is left to that peer. */
  private async attribute(project: Project, task: WorkItem, files: string[]) {
    await this.changes.begin(project, task, files);
    await this.changes.checkpoint(project, task, this.sharing(task, files));
  }
  private sharing(task: WorkItem, own: string[]) {
    return {
      sharedWith: (path: string) => this.declarations.editorsOf(task, path),
      skip: (path: string) =>
        !own.includes(path) && this.declarations.editorsOf(task, path).length > 0,
    };
  }
  private outsidersIn(overlaps: Json[] | undefined): Outsider[] {
    return (overlaps ?? [])
      .filter((overlap) => !this.decisions.taskOf(overlap.agent_id))
      .map((overlap) => ({
        agentId: overlap.agent_id,
        plan: overlap.assignment ?? undefined,
        breaks: !!overlap.destructive,
        symbols: overlap.symbols ?? [],
      }));
  }
  /** Outside agents seen on these symbols when declaring, or named by Fleet in the conflict. */
  private outsidersAt(own: FleetDeclaration, episode: Json): Outsider[] {
    const named: Outsider[] = (episode.mediation_request?.assignments ?? [])
      .filter((entry: Json) => !this.decisions.taskOf(entry.agent_id))
      .map((entry: Json) => ({
        agentId: entry.agent_id,
        plan: entry.assignment ?? undefined,
        breaks: engineBreaks(entry.intent),
        symbols: own.symbols,
      }));
    const seen = this.outsiders.get(own.id) ?? [];
    this.outsiders.delete(own.id);
    this.renewed.delete(own.id);
    return [
      ...new Map([...seen, ...named].map((outsider) => [outsider.agentId, outsider])).values(),
    ];
  }
  /** Peers on the same symbols or files, and anyone holding for them, hear what changed and why. */
  private tellPeers(task: WorkItem, own: FleetDeclaration): string[] {
    const verb = changeVerbs[own.kind];
    const told = new Set<string>();
    for (const peer of this.declarations.touchedBy(task, own.symbols)) {
      if (told.has(peer.taskId)) continue;
      told.add(peer.taskId);
      const shared = sharedSymbols(peer.symbols, own.symbols);
      this.news.tell(peer.taskId, {
        type: "peer_changed",
        at: now(),
        task: task.identifier,
        kind: own.kind,
        plan: own.plan,
        symbols: shared.length ? shared : own.symbols,
        message: shared.length
          ? `${task.identifier} just recorded ${verb} ${shared.join(", ")}: ${own.plan} You are editing it too: re-read it and build on this before your next edit.`
          : `${task.identifier} just changed ${[...new Set(own.symbols.map(fileOf))].join(", ")} (${verb} ${own.symbols.join(", ")}): ${own.plan} You are editing other symbols in that file: re-read the file before your next edit.`,
      });
    }
    for (const [taskId, watched] of this.watching) {
      const freed = sharedSymbols([...watched], own.symbols);
      if (!freed.length || told.has(taskId)) continue;
      this.news.tell(taskId, {
        type: "peer_changed",
        at: now(),
        task: task.identifier,
        kind: own.kind,
        plan: own.plan,
        symbols: freed,
        message: `${task.identifier} has recorded ${verb} ${freed.join(", ")}: ${own.plan} Declare it again and build on the new version.`,
      });
      told.add(taskId);
    }
    return [...told];
  }
  /**
   * The graph knows who calls a symbol. A peer editing that calling code hears about a
   * change that reaches it, even though the two never touch the same symbol.
   */
  private async tellCallers(
    project: Project,
    task: WorkItem,
    own: FleetDeclaration,
    type: "peer_starting" | "peer_changed",
    alreadyTold: string[],
  ) {
    const calls = await this.callersOf(project, task, own.symbols);
    if (!calls.length) return;
    const verb = changeVerbs[own.kind];
    for (const peer of this.declarations.everyoneEditing(task)) {
      if (alreadyTold.includes(peer.taskId)) continue;
      const files = peer.symbols.map(fileOf);
      const theirs = calls.filter(
        (call) => peer.symbols.includes(call.caller) || files.includes(fileOf(call.caller)),
      );
      if (!theirs.length) continue;
      alreadyTold.push(peer.taskId);
      const changed = [...new Set(theirs.map((call) => call.symbol))];
      const calledFrom = [...new Set(theirs.map((call) => call.caller))];
      this.news.tell(peer.taskId, {
        type,
        at: now(),
        task: task.identifier,
        kind: own.kind,
        plan: own.plan,
        symbols: changed,
        calledFrom,
        message:
          type === "peer_starting"
            ? `${task.identifier} is ${verb} ${changed.join(", ")} right now: ${own.plan} In the code you are editing, ${calledFrom.join(", ")} calls it. Carry on, and re-read ${changed.join(", ")} once ${task.identifier} has recorded.`
            : `${task.identifier} just recorded ${verb} ${changed.join(", ")}: ${own.plan} In the code you are editing, ${calledFrom.join(", ")} calls it: re-read ${changed.join(", ")} and make sure your edit still fits.`,
      });
    }
  }
  /** Direct callers of the symbols, as the goal's code graph has them. An unreachable graph tells nobody. */
  private async callersOf(project: Project, task: WorkItem, symbols: string[]) {
    const analysis = epicAnalysisProject(project, task);
    const roots = { workspace: task.run.workspace ?? project.path!, project: analysis };
    const calls: Array<{ symbol: string; caller: string }> = [];
    for (const symbol of symbols.filter((item) => item.includes("::")).slice(0, callersAsked)) {
      const impact = await this.engine
        .call(analysis, "get_impact", {
          repo_id: analysis.repoId,
          branch: task.run.branch ?? project.branch,
          target: symbol.split("::").pop(),
          file_path: fileOf(symbol),
          direction: "upstream",
          depth: 1,
        })
        .catch(() => undefined);
      for (const row of Object.values(impact?.by_depth ?? {}).flat() as Json[]) {
        if (!row?.name || !row?.file_path) continue;
        try {
          calls.push({ symbol, caller: symbolIdentity(`${row.file_path}::${row.name}`, roots) });
        } catch {
          // A caller outside this checkout is nobody's edit here.
        }
      }
    }
    return calls;
  }

  // ── Disagree: a breaking change met someone's edit; the workers judge first ──

  private async disagree(
    project: Project,
    task: WorkItem,
    own: FleetDeclaration,
    peers: FleetDeclaration[],
    outsiders: Outsider[],
    episode: Json,
  ) {
    const parties = [
      this.positionOf(own),
      ...peers.map((peer) => this.positionOf(peer)),
      ...outsiders.map((outsider) => ({ agentId: outsider.agentId, plan: outsider.plan })),
    ];
    const contested = [
      ...new Set([
        ...peers.flatMap((peer) => brokenBetween(own, peer)),
        ...outsiders.flatMap((outsider) => sharedSymbols(own.symbols, outsider.symbols)),
      ]),
    ];
    let decision = this.decisions.openOn(task, contested);
    if (decision) {
      for (const party of parties) this.decisions.join(decision, party);
      if (episode.escalation_id && episode.escalation_id !== decision.escalationId)
        await this.dismiss(project, task, episode.escalation_id, "Already being decided as " + decision.id + ".");
    } else
      decision = this.decisions.raise(project, task, contested, parties, episode.escalation_id ?? undefined);
    this.declarations.attach(decision.id, decision.taskIds, decision.scope);
    if (!decision.escalationId)
      this.decisions.askPerson(decision, "decide", "Fleet opened no decision for this, so the workers cannot settle it between them.");
    this.askToJudge(task, decision);
    return {
      class: "C",
      directive: "judge",
      decision: this.decisions.brief(decision),
      requirement: `Your edit and another worker's cannot both stand as they are. Both are in the files. Read each position, then call coordinate with action verdict, decisionId and verdict: reconcile (they fit together; say how in reason), recommend (winner: the task that should stand, with reason) or ask_human (a product call; put the question in reason). Until the reply says proceed, do not edit ${decision.scope.join(", ")}. Other work can continue.`,
    };
  }
  private positionOf(declaration: FleetDeclaration): FleetPosition {
    return {
      taskId: declaration.taskId,
      agentId: agentOf(declaration.taskId),
      kind: declaration.kind,
      plan: declaration.plan,
    };
  }
  private askToJudge(recorder: WorkItem, decision: FleetConflict) {
    for (const taskId of decision.taskIds) {
      if (taskId === recorder.id) continue;
      this.news.tell(taskId, {
        type: "judge",
        at: now(),
        decision: this.decisions.brief(decision),
        message: `${recorder.identifier}'s change to ${decision.scope.join(", ")} cannot stand together with yours as they are. Read each position in this update, then call coordinate with action verdict and decisionId ${decision.id}: reconcile, recommend or ask_human, with your reason. Do not edit ${decision.scope.join(", ")} until it is settled.`,
      });
    }
  }
  private async judge(project: Project, task: WorkItem, request: CoordinationRequest) {
    const decision = request.decisionId ? this.decisions.find(request.decisionId) : undefined;
    const position = decision && this.decisions.position(decision, task);
    if (!decision || !position)
      throw Error("That decision does not involve this task.");
    if (decision.status === "open") {
      if (!request.verdict || !request.reason)
        throw Error("Give your verdict (reconcile, recommend or ask_human) and your reason.");
      const winner = request.verdict === "recommend" ? this.party(decision, request.winner) : undefined;
      Object.assign(position, {
        verdict: request.verdict,
        reason: request.reason,
        winnerTaskId: winner?.id,
      });
      await this.submit(project, task, decision, position);
    }
    return this.standing(decision, task);
  }
  private party(decision: FleetConflict, name?: string) {
    const involved = this.state().tasks.filter((task) => decision.taskIds.includes(task.id));
    const winner = involved.find(
      (task) => task.id === name || task.identifier.toLowerCase() === name?.toLowerCase(),
    );
    if (!winner)
      throw Error(
        "Recommend one of the tasks involved: " +
          involved.map((task) => task.identifier).join(", ") + ".",
      );
    return winner;
  }
  private async submit(project: Project, task: WorkItem, decision: FleetConflict, position: FleetPosition) {
    if (!decision.escalationId) return;
    const result = await this.direct(project, task, "fleet_submit_verdict", {
      escalation_id: decision.escalationId,
      agent_id: agentOf(task.id),
      verdict:
        position.verdict === "reconcile"
          ? { kind: "reconcile", merge_plan: position.reason }
          : position.verdict === "recommend"
            ? { kind: "recommend", winner: agentOf(position.winnerTaskId!), rationale: position.reason, confidence: 0.8 }
            : { kind: "defer_to_human", question: position.reason },
    });
    this.weigh(
      decision,
      result.accepted === false ? await this.heldByFleet(project, task, decision) : result,
      task,
    );
  }
  /** Where Fleet stands on a decision it no longer takes verdicts for. */
  private async heldByFleet(project: Project, task: WorkItem, decision: FleetConflict): Promise<Json> {
    const held = await this.direct(project, task, "fleet_get_escalation", {
      escalation_id: decision.escalationId,
    });
    if (String(held.status).toLowerCase() !== "resolved") return { outcome: "pending" };
    return held.resolved_by === "agents"
      ? { outcome: "auto_apply" }
      : { outcome: "decided", winner: held.winner, resolution: held.resolution };
  }
  /**
   * Fleet referees, and MemCode's own rules are the floor under it: a disagreement is
   * settled without the person only when both allow it. Anything stricter from either wins.
   */
  private weigh(decision: FleetConflict, fleet: Json, actor?: WorkItem) {
    if (fleet.outcome === "decided")
      return this.settled(decision, {
        by: "human",
        winnerTaskId: this.decisions.taskOf(fleet.winner)?.id,
        resolution: fleet.resolution ?? "Settled in Memtrace Fleet.",
      });
    const own = ruling(
      decision.positions ?? [],
      this.decisions.awaiting(decision).flatMap((position) => position.taskId ?? []),
    );
    if ("person" in own) {
      decision.recommendedTaskId = own.recommendedTaskId;
      return this.decisions.askPerson(decision, own.person, own.reason);
    }
    const outdated = this.countsEarlierEdits(decision, fleet);
    if (fleet.outcome === "human_required" && !outdated)
      return this.decisions.askPerson(decision, "decide", fleet.detail?.reason);
    if ("wait" in own) return;
    if (outdated) this.tellFleet(decision, own.winnerTaskId);
    else if (fleet.outcome !== "auto_apply") {
      decision.recommendedTaskId = own.winnerTaskId;
      return this.decisions.askPerson(decision, "confirm", "Fleet is set to ask before it settles anything.");
    }
    this.settled(
      decision,
      { by: "agents", winnerTaskId: own.winnerTaskId, resolution: this.reasoning(decision) },
      actor,
    );
  }
  /**
   * Fleet keeps an intent for two minutes, also after its edit was recorded and settled,
   * and counts it as one more side that breaks something. MemCode knows the sides: when
   * every one of them is here and only one breaks callers, that rule does not apply.
   */
  private countsEarlierEdits(decision: FleetConflict, fleet: Json) {
    const positions = decision.positions ?? [];
    return (
      fleet.outcome === "human_required" &&
      fleet.detail?.reason === bothDestructive &&
      positions.every((position) => position.taskId && position.kind) &&
      positions.filter((position) => breaksCallers(position.kind!)).length <= 1
    );
  }
  /** Closes Fleet's own record of a disagreement MemCode settled. */
  private tellFleet(decision: FleetConflict, winnerTaskId?: string) {
    const project = this.state().projects.find((item) => item.id === decision.projectId);
    const task = project && this.onBranch(project, decision.branch);
    if (!project || !task || !decision.escalationId) return;
    void this.direct(project, task, "fleet_resolve_escalation", {
      escalation_id: decision.escalationId,
      resolution: this.reasoning(decision),
      ...(winnerTaskId ? { winner: agentOf(winnerTaskId) } : {}),
    }).catch(() => {});
  }
  private reasoning(decision: FleetConflict) {
    return (decision.positions ?? [])
      .filter((position) => position.reason)
      .map(
        (position) =>
          `${this.state().tasks.find((task) => task.id === position.taskId)?.identifier ?? position.agentId}: ${position.reason}`,
      )
      .join(" ");
  }
  private settled(
    decision: FleetConflict,
    outcome: { resolution: string; winnerTaskId?: string; by: "agents" | "human" },
    actor?: WorkItem,
  ) {
    this.decisions.settle(decision, outcome);
    this.onSettled?.(decision);
    const winner = this.state().tasks.find((task) => task.id === outcome.winnerTaskId);
    for (const task of this.state().tasks) {
      if (!decision.taskIds.includes(task.id) || task.id === actor?.id) continue;
      const directive = this.decisions.directive(decision, task);
      this.news.tell(task.id, {
        type: "decided",
        at: now(),
        decisionId: decision.id,
        directive,
        resolution: outcome.resolution,
        message:
          directive === "proceed"
            ? `Settled for ${decision.scope.join(", ")}: you go ahead. ${outcome.resolution}`
            : `Settled for ${decision.scope.join(", ")}: ${winner?.identifier ?? "the other change"} stands. Re-read it and rebuild your change on that version. ${outcome.resolution}`,
      });
    }
    // Workers that were only held off by it hear that the code is free again.
    for (const [taskId, held] of this.held)
      if (
        !decision.taskIds.includes(taskId) &&
        held.some((hold) => hold.decisionId === decision.id)
      )
        this.news.tell(taskId, {
          type: "decided",
          at: now(),
          decisionId: decision.id,
          directive: "proceed",
          resolution: outcome.resolution,
          message: `Settled for ${decision.scope.join(", ")}: that code is free again. ${outcome.resolution} Declare it and build on the version there now.`,
        });
  }
  private standing(decision: FleetConflict, task: WorkItem) {
    const directive = this.decisions.directive(decision, task);
    return {
      outcome:
        decision.status === "resolved"
          ? "settled"
          : decision.needs
            ? "needs_person"
            : "waiting_for_peer",
      directive,
      decision: this.decisions.brief(decision),
      requirement:
        directive === "proceed"
          ? "Settled: go ahead, following the resolution."
          : directive === "defer"
            ? "Settled: the other change stands. Re-read the symbols and rebuild your change on that version."
            : decision.needs
              ? `Not settled yet: a person is deciding. Keep off the contested symbols. ${whileThePersonDecides}`
              : "Not settled yet. Keep off the contested symbols and carry on with other work; call sync with waitMs to hear the outcome.",
    };
  }

  // ── Sync: hear what peers did, without spending a model call on a poll loop ──

  private async sync(task: WorkItem, request: CoordinationRequest, signal?: AbortSignal) {
    await this.news.arrival(task.id, request.waitMs, signal);
    return {
      directive: "synced",
      decisions: this.state()
        .fleetConflicts.filter(
          (item) => item.status === "open" && item.taskIds.includes(task.id),
        )
        .map((item) => this.decisions.brief(item)),
    };
  }

  // ── The worker's lifetime ───────────────────────────────────────────────────

  async heartbeat(project: Project, task: WorkItem): Promise<void> {
    const open = this.declarations.open(task);
    if (open && Date.now() - (this.renewed.get(open.id) ?? 0) > renewDeclarationMs) {
      this.renewed.set(open.id, Date.now());
      await this.publish(project, task, open.symbols, open.kind, open.plan);
    }
    await this.followDecisions(project, task);
  }
  /** The turn ended: an edit the worker never recorded is recorded for it. */
  async after(project: Project, task: WorkItem): Promise<void> {
    if (this.declarations.open(task)) await this.record(project, task, {});
  }
  /**
   * What a worker whose turn ended was still waiting for. Taken before it is released and
   * answered after, because a person can decide in between: a model writing its last
   * message hears nothing any more.
   */
  owed(task: WorkItem): () => Owed {
    const held = this.held.get(task.id) ?? [];
    const unheard = this.news
      .unheard(task.id)
      .flatMap((item) =>
        item.type === "decided" && item.directive !== "proceed"
          ? [String(item.decisionId)]
          : [],
      );
    return () => {
      const about = [...held.flatMap((item) => item.decisionId ?? []), ...unheard].flatMap(
        (id) => this.decisions.find(id) ?? [],
      );
      const waited = held.flatMap((item) => (item.decisionId ? [] : item.symbols));
      const busy = waited.filter((symbol) =>
        this.declarations.breakingInFlight(task, [symbol]),
      );
      return {
        open:
          this.decisions.openWith(task) ??
          about.find((decision) => decision.status === "open"),
        settled: about.findLast((decision) => decision.status === "resolved"),
        freed: waited.filter((symbol) => !busy.includes(symbol)),
        busy,
      };
    };
  }
  async release(project: Project, task: WorkItem): Promise<void> {
    try {
      await this.changes.release(project, task, this.sharing(task, []));
    } finally {
      const left = this.declarations.open(task)?.symbols;
      this.declarations.abandon(task);
      if (left) this.onFreed?.(task, left);
      this.watching.delete(task.id);
      this.held.delete(task.id);
      this.news.forget(task.id);
    }
  }
  /** What the worker is told about the fleet when it starts. */
  async context(project: Project, task: WorkItem) {
    const engine = await this.call(project, task, "fleet_branch_context", {});
    return {
      branch: task.run.branch,
      workerId: agentOf(task.id),
      editingNow: this.peers(this.declarations.everyoneEditing(task)),
      changedLately: this.peers(this.declarations.latestRecorded(task, peersListed)),
      otherAgents: this.outsidersIn(
        (engine.peers ?? []).map((peer: Json) => ({ ...peer, symbols: peer.touched })),
      ).slice(0, peersListed),
      decisions: this.state()
        .fleetConflicts.filter((item) => item.taskIds.includes(task.id))
        .slice(-peersListed)
        .map((item) => ({
          ...this.decisions.brief(item),
          yourDirective: this.decisions.directive(item, task),
        })),
    };
  }
  async failure(project: Project, task: WorkItem, summary: string): Promise<void> {
    task.run.error = summary;
    task.messages.push({
      id: randomUUID(),
      role: "system",
      at: now(),
      text:
        summary +
        "\nThis is a coordination service problem. Shared work is preserved; it is not an agent semantic disagreement.",
    });
    await this.changed();
  }

  // ── The person decides; Fleet's own queue is followed ───────────────────────

  /** The person's decision. Running workers hear it at their next call and carry on. */
  async resolve(id: string, resolution: string, winnerTaskId?: string): Promise<void> {
    const decision = this.decisions.find(id);
    if (!decision) throw new Error("Fleet decision not found.");
    if (winnerTaskId && !decision.taskIds.includes(winnerTaskId))
      throw new Error("Choose one of the affected task workers.");
    const project = this.state().projects.find((item) => item.id === decision.projectId)!;
    const task = this.onBranch(project, decision.branch);
    if (decision.escalationId && decision.status === "open") {
      const analysis = task ? epicAnalysisProject(project, task) : project;
      if (analysis !== project) await this.engine.activateEpic(analysis);
      await this.engine.call(analysis, "fleet_resolve_escalation", {
        escalation_id: decision.escalationId,
        resolution,
        winner: winnerTaskId ? agentOf(winnerTaskId) : undefined,
      });
    }
    this.settled(decision, { by: "human", winnerTaskId, resolution });
    await this.changed();
  }
  /** Picks up decisions raised or settled outside MemCode: another tool, another machine. */
  async refresh(project: Project, task?: WorkItem): Promise<void> {
    this.closeEarlierBookkeeping(project);
    const tasks = task
      ? [task]
      : this.state().tasks.filter((item) => item.projectId === project.id && isActive(item));
    const asked = new Set<string>();
    for (const item of tasks) {
      const analysis = epicAnalysisProject(project, item);
      if (!analysis.repoId || analysis.analysis !== "ready" || asked.has(analysis.id)) continue;
      asked.add(analysis.id);
      const listed = await this.engine.call(analysis, "fleet_list_escalations", {
        repo_id: analysis.repoId,
      });
      for (const entry of listed.pending ?? []) {
        const owner = this.onBranch(project, entry.branch ?? project.branch);
        if (owner) this.adopt(project, owner, entry);
      }
      this.decisionsChecked.delete(project.id + "\n" + item.run.branch);
      await this.followDecisions(project, item);
    }
    await this.changed();
  }
  private onBranch(project: Project, branch: string) {
    return this.state().tasks.find(
      (task) => task.projectId === project.id && task.run.branch === branch,
    );
  }
  /** A disagreement Fleet holds that MemCode did not raise: the person sees it. */
  private adopt(project: Project, task: WorkItem, entry: Json) {
    const id = entry.escalation_id ?? entry.id;
    if (!id || this.decisions.find(id)) return;
    const decision = this.decisions.raise(project, task, entry.touched ?? [], [], id);
    Object.assign(decision, {
      source: "remote",
      agentIds: [entry.agent_id, ...(entry.conflicting_agents ?? [])].filter(Boolean),
      summary: "Another agent on this branch raised a disagreement.",
    });
    this.decisions.askPerson(decision, "decide", "Raised outside MemCode.");
  }
  private async followDecisions(project: Project, task: WorkItem) {
    const key = project.id + "\n" + task.run.branch;
    if (Date.now() - (this.decisionsChecked.get(key) ?? 0) < decisionCheckMs) return;
    this.decisionsChecked.set(key, Date.now());
    for (const decision of this.decisions.unanswered(project))
      this.decisions.askPerson(
        decision,
        decision.recommendedTaskId ? "confirm" : "decide",
        "A worker involved did not answer.",
      );
    for (const decision of this.state().fleetConflicts)
      if (
        decision.status === "open" &&
        decision.escalationId &&
        decision.projectId === project.id &&
        decision.branch === task.run.branch
      )
        await this.followFleet(project, task, decision);
  }
  private async followFleet(project: Project, task: WorkItem, decision: FleetConflict) {
    const fleet = await this.heldByFleet(project, task, decision);
    if (fleet.outcome !== "pending") this.weigh(decision, fleet);
  }
  /** Earlier versions listed plain overlaps as open decisions; those were never the person's to make. */
  private closeEarlierBookkeeping(project: Project) {
    for (const item of this.state().fleetConflicts) {
      if (
        item.projectId !== project.id ||
        item.status !== "open" ||
        item.severity === "C" ||
        item.escalationId
      )
        continue;
      Object.assign(item, {
        status: "resolved",
        resolvedAt: now(),
        resolutionKind: "coordination",
        resolution:
          "Reclassified as an ordinary overlap. Workers re-read current source before editing. No semantic disagreement was recorded.",
      });
    }
  }

  // ── Speaking to Fleet ───────────────────────────────────────────────────────

  private publish(project: Project, task: WorkItem, symbols: string[], kind: ChangeKind, plan: string) {
    return this.call(project, task, "fleet_publish_intent", {
      intent: engineIntent(kind, symbols),
      touched: symbols,
      assignment: `${task.identifier}: ${task.title}. ${plan}`.slice(0, 1600),
    });
  }
  /** Closes a decision Fleet opened that no peer's edit explains, so nothing waits on it. */
  private dismiss(project: Project, task: WorkItem, escalationId: string, why: string) {
    return this.direct(project, task, "fleet_resolve_escalation", {
      escalation_id: escalationId,
      resolution: why,
      winner: agentOf(task.id),
    });
  }
  /** A call about this task's own edits: identity and branch are bound by the host, never the worker. */
  private call(project: Project, task: WorkItem, name: string, extra: Json) {
    const analysis = epicAnalysisProject(project, task);
    return this.engine.call(analysis, name, {
      repo_id: analysis.repoId,
      branch: task.run.branch ?? project.branch,
      agent_id: agentOf(task.id),
      ...extra,
    });
  }
  private direct(project: Project, task: WorkItem, name: string, args: Json) {
    return this.engine.call(epicAnalysisProject(project, task), name, args);
  }

  // ── What the worker sees and what the card shows ────────────────────────────

  private peer(declaration: FleetDeclaration) {
    const task = this.state().tasks.find((item) => item.id === declaration.taskId);
    return {
      task: task?.identifier ?? declaration.taskId,
      title: task?.title,
      kind: declaration.kind,
      plan: declaration.plan,
      symbols: declaration.symbols,
      at: declaration.recordedAt ?? declaration.declaredAt,
    };
  }
  private peers(declarations: FleetDeclaration[]) {
    return declarations.slice(0, peersListed).map((declaration) => this.peer(declaration));
  }
  private async remember(task: WorkItem, request: CoordinationRequest, reply: Json) {
    const summary = {
      symbols: reply.symbols ?? request.symbols,
      kind: request.kind,
      plan: request.plan,
      class: reply.class,
      canEdit: reply.canEdit,
      heldBy: reply.heldBy?.task,
      decisionId: reply.decision?.id,
      outcome: reply.outcome,
    };
    const directory = workerRecordsFolder(task);
    if (directory) {
      await mkdir(directory, { recursive: true });
      await appendFile(
        join(directory, "fleet-activity.jsonl"),
        JSON.stringify({ at: now(), action: request.action, directive: reply.directive, ...summary }) + "\n",
        { mode: 0o600 },
      );
    }
    if (request.action === "sync") return;
    task.messages.push({
      id: randomUUID(),
      role: "tool",
      at: now(),
      text: `Fleet · ${request.action} · ${reply.directive}\n${JSON.stringify(summary, null, 2)}`,
    });
    if (task.messages.length > keptMessages)
      task.messages.splice(1, task.messages.length - keptMessages);
  }
}
