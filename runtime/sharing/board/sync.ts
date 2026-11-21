import * as Y from "yjs";
import type { AppState } from "../../../src/shared";
import type {
  SharedBoardStatus,
  SharedProjectLink,
} from "../../../src/sharing";
import { refusalSentences } from "../../../src/sharing-refusals";
import type {
  BoardsApi,
  LoggedUpdate,
  UpdateReceipt,
} from "../memsync/boards-api";
import type { GrpcStream } from "../memsync/grpc";
import {
  SharingRefused,
  SharingSignedOut,
  SharingUnavailable,
} from "../problems";
import { applyBoard, boardOf, type EntryStamp } from "./board";
import {
  collections,
  emptyBoard,
  LARGEST_UPDATE,
  LAYOUT,
  layoutOf,
  LOCAL,
  readBoard,
  writeChanges,
  writeEntryAlone,
  type Board,
  type Collection,
} from "./document";
import { newIdentifiers, NOT_IN_THE_LOG } from "./identifiers";
import {
  BoardStore,
  type BoardToKeep,
  type KeptBoard,
  type LeftOutUpdate,
} from "./store";
import {
  holdsMore,
  idOf,
  missingFrom,
  nextCall,
  whyNotApplied,
} from "./updates";

export interface BoardSyncOptions {
  /** The project on this computer. */
  projectId: string;
  /** The shared project whose log holds its board. */
  sharedProjectId: string;
  /** Where this board keeps what it needs between runs. */
  folder: string;
  state(): AppState;
  boards: BoardsApi;
  /**
   * Saves the workspace as it is at the moment of the call, and writes it only
   * after `first` has finished.
   */
  saveWorkspace(first: () => Promise<void>): Promise<unknown>;
  /** What the window shows about this board changed. Nothing needs saving. */
  shown(): void;
  /** The names of the people on the shared project, by account. */
  people(): Promise<Map<string, string>>;
  /** How long to wait before trying again after failing this many times in a row. */
  waitBeforeRetry?: (failures: number) => number;
}

type Kept = Omit<KeptBoard, "log">;
/** `live`: caught up and listening. The window is told `synced`, `sending` or `newer`. */
type Condition = "starting" | "live" | "offline" | "apart" | "gone" | "stopped";
/** The documents went back to what was last saved, and the log is read again from there. */
class StartAgain extends Error {}

/** What marks a change that came from the log, as opposed to one this computer made. */
const FROM_LOG = "log";
const SOMEONE = "Someone on this project";
const LEFT_OUT_KEPT = 200,
  ARRIVALS_HELD = 256;
const WAITS = [1000, 2000, 5000, 15000, 30000, 60000];
/** A board that is first written out goes in this order, so what a task points at is there before it. */
const WRITING_ORDER: Collection[] = [
  "lanes",
  "fields",
  "views",
  "cycles",
  "goals",
  "tasks",
  "comments",
];
const WORK: Collection[] = ["goals", "cycles", "tasks", "comments"];
const NEWER =
  "A newer MemCode laid this board out. Update MemCode to change it from this computer. Until then it is shown here and what you change stays on this computer.";
const CANNOT_SEND =
  "Your changes could not be sent to the shared board yet. They are kept on this computer and sent when it works again.";
const CANNOT_SAVE =
  "The workspace could not be saved, so changes from the shared board are waiting. Free disk space, and they are taken up again.";

/** What a problem with the service says to the person, or nothing for a fault of MemCode's own. */
const sentenceOf = (problem: unknown) =>
  problem instanceof SharingUnavailable ||
  problem instanceof SharingRefused ||
  problem instanceof SharingSignedOut
    ? problem.message
    : undefined;
const sameBoard = (left: Board, right: Board) =>
  JSON.stringify(left) === JSON.stringify(right);
const hasWork = (board: Board) =>
  WORK.some((collection) => Object.keys(board[collection]).length > 0);
/** The entries of one board whose ids another does not hold. */
function onlyIn(mine: Board, theirs: Board): Board {
  const own = emptyBoard();
  for (const collection of collections)
    for (const [id, entry] of Object.entries(mine[collection]))
      if (!(id in theirs[collection])) own[collection][id] = entry;
  return own;
}

/**
 * Keeps the board of one local project and the board in a shared project's log
 * the same: docs/shared-board-layout-proposal.md.
 *
 * Two documents are kept. One holds exactly what the log has built. The other
 * holds that and this computer's own changes that are not in the log yet. The
 * app goes on showing the workspace file, which follows the second.
 *
 * Everything that changes them runs in turn, one after the other.
 */
export class BoardSync {
  private readonly store: BoardStore;
  private kept: Kept = this.nothingKept(0);
  private doc = new Y.Doc();
  private logDoc = new Y.Doc();
  private turns: Promise<unknown> = Promise.resolve();
  private running?: Promise<void>;
  private stopped = false;
  private mustReopen = false;
  private watching?: GrpcStream;
  private arrived: LoggedUpdate[] = [];
  private taking?: Promise<void>;
  private capturing?: Promise<void>;
  private sending?: Promise<void>;
  /** What the service has said it logged, in this run. */
  private logged = new Set<string>();
  private repairs = new Set<string>();
  /** Entries that read as updates and could not be applied. */
  private unusable = new Set<string>();
  private names = new Map<string, string>();
  private askedAbout = new Set<string>();
  private stamps = new Map<string, EntryStamp>();
  private arriving?: LoggedUpdate;
  private condition: Condition = "starting";
  private detail?: string;
  /** Why the last call to send did not get through, while something is still waiting. */
  private notSent?: string;
  /** The service turned a change down by one of its rules. Asking again changes nothing. */
  private refused?: string;
  /** Both boards have work on them, so they stay two. */
  private apart = false;
  private tooLarge = 0;
  private lastShown = "";
  private pauses = new Set<() => void>();

  constructor(private readonly options: BoardSyncOptions) {
    this.store = new BoardStore(options.folder);
  }

  /** Begins reading the log and sending what this computer has. */
  start(): void {
    this.running ??= this.run();
  }

  /** Ends sync for now. What is not sent yet stays on disk for the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.watching?.cancel();
    for (const end of [...this.pauses]) end();
    // Whatever is being written is finished. A call the service has not
    // answered is not waited for: what it brings is dropped when it comes.
    await this.turns;
    this.doc.destroy();
    this.logDoc.destroy();
  }

  /** Forgets what was kept for this board. For after `stop`. */
  forget(): Promise<void> {
    return this.store.remove();
  }

  /**
   * Looks at the workspace for changes made on this computer and queues them
   * for the log. Called after every save of the workspace.
   */
  capture(): Promise<void> {
    this.capturing ??= this.inTurn(async () => {
      this.capturing = undefined;
      if (this.stopped || !this.noteOwnChanges()) return;
      await this.store.save(this.toKeep(false));
      await this.settle();
    });
    return this.capturing;
  }

  /** The name of someone on the shared project, when it is known. */
  nameOf(accountId: string): string | undefined {
    return this.names.get(accountId);
  }

  status(): SharedBoardStatus {
    const waiting = this.kept.unsent.length;
    const leftOut = new Map<
      string,
      { by: string; on: string; count: number }
    >();
    for (const entry of this.kept.leftOut) {
      const by = this.names.get(entry.author) ?? SOMEONE,
        on = entry.loggedAt.slice(0, 10);
      const line = leftOut.get(`${by}\n${on}`) ?? { by, on, count: 0 };
      line.count++;
      leftOut.set(`${by}\n${on}`, line);
    }
    const live = this.condition === "live",
      newer = live && this.isNewer(),
      sending = live && !newer && waiting > 0,
      refused = sending ? this.refused : undefined,
      held = sending && !refused ? this.notSent : undefined;
    return {
      projectId: this.options.projectId,
      state: newer
        ? "newer"
        : this.condition !== "live"
          ? this.condition
          : refused
            ? "stopped"
            : held
              ? "offline"
              : waiting
                ? "sending"
                : "synced",
      detail: newer ? NEWER : (refused ?? held ?? this.detail),
      waiting,
      leftOut: [...leftOut.values()],
      setAside: this.logDoc.store.pendingStructs !== null,
      tooLarge: this.tooLarge,
    };
  }

  // ── Reading the log ──────────────────────────────────────────────────────

  private async run(): Promise<void> {
    this.mustReopen = true;
    void this.learn();
    for (let failures = 0; !this.stopped;) {
      try {
        if (this.mustReopen) await this.inTurn(() => this.open());
        await this.catchUp();
        if (this.stopped) return;
        await this.inTurn(async () => {
          if (!this.kept.joined) await this.join();
          // What changed on this computer while sync was not running.
          else if (this.noteOwnChanges())
            await this.store.save(this.toKeep(false));
          await this.settle();
        });
        failures = 0;
        this.say(this.apart ? "apart" : "live");
        await this.watch();
        // A stream that ends is started again, as the service's own notes say.
        failures = 1;
      } catch (problem) {
        if (this.stopped) return;
        if (this.isGone(problem)) return;
        failures++;
        this.failed(problem);
      }
      await this.pause(this.waitFor(failures));
    }
  }

  private async catchUp(): Promise<void> {
    for (;;) {
      const page = await this.options.boards.readAfter(
        this.options.sharedProjectId,
        this.kept.cursor,
      );
      if (this.stopped || !page.length) return;
      await this.inTurn(() => this.take(page));
    }
  }

  private watch(): Promise<void> {
    const stream = this.options.boards.watchAfter(
      this.options.sharedProjectId,
      this.kept.cursor,
      (update) => this.arrive(update),
    );
    this.watching = stream;
    return stream.finished.finally(() => {
      if (this.watching === stream) this.watching = undefined;
    });
  }

  /** Updates from the stream are taken together when several are waiting. */
  private arrive(update: LoggedUpdate): Promise<void> | undefined {
    this.arrived.push(update);
    this.taking ??= this.inTurn(async () => {
      this.taking = undefined;
      await this.take(this.arrived.splice(0));
      await this.settle();
    }).catch((problem) => {
      // The stream is read again from what was last saved.
      this.failed(problem);
      this.watching?.cancel();
    });
    return this.arrived.length > ARRIVALS_HELD ? this.taking : undefined;
  }

  private async open(): Promise<void> {
    this.mustReopen = false;
    const at = this.link()?.applied ?? 0;
    let read = await this.store.load(at);
    try {
      this.rebuild(read ?? { ...this.nothingKept(at), log: new Uint8Array() });
    } catch {
      // What was kept cannot be used. The log and the workspace are still whole.
      read = undefined;
    }
    if (read) return;
    await this.store.remove();
    this.rebuild({ ...this.nothingKept(at), log: new Uint8Array() });
  }

  private nothingKept(applied: number): Kept {
    return {
      cursor: 0,
      applied,
      joined: false,
      seen: emptyBoard(),
      unsent: [],
      leftOut: [],
      arrived: {},
    };
  }

  private rebuild({ log, ...kept }: KeptBoard): void {
    const doc = new Y.Doc(),
      logDoc = new Y.Doc();
    if (log.length) {
      Y.applyUpdate(logDoc, log, FROM_LOG);
      Y.applyUpdate(doc, log, FROM_LOG);
    }
    for (const update of kept.unsent) {
      if (whyNotApplied(update.id, update.payload))
        throw new Error("A change that was waiting to be sent is damaged.");
      Y.applyUpdate(doc, update.payload, FROM_LOG);
    }
    for (const collection of collections)
      logDoc
        .getMap(collection)
        .observeDeep((events) => this.stamp(collection, events));
    this.doc.destroy();
    this.logDoc.destroy();
    this.doc = doc;
    this.logDoc = logDoc;
    this.kept = kept;
    this.stamps.clear();
    this.arrived = [];
  }

  /** Notes which entries the log entry being applied made or changed. */
  private stamp(collection: Collection, events: Y.YEvent<any>[]): void {
    const from = this.arriving;
    if (!from) return;
    for (const event of events) {
      const made = event.path.length === 0;
      const ids = made
        ? [...event.changes.keys.keys()]
        : [String(event.path[0])];
      for (const id of ids) {
        const key = `${collection}/${id}`;
        const stamp = this.stamps.get(key) ?? {};
        if (made && event.changes.keys.get(id)?.action === "add") {
          stamp.createdAt = from.loggedAt;
          stamp.createdBy = from.author;
          if (collection === "tasks") this.kept.arrived[id] ??= from.sequence;
        }
        stamp.changedAt = from.loggedAt;
        this.stamps.set(key, stamp);
      }
    }
  }

  /**
   * Deals with the next entries of the log: applies the ones that can be
   * applied, writes down the ones that cannot, and makes the workspace follow.
   */
  private async take(entries: LoggedUpdate[]): Promise<void> {
    const next = entries.filter((entry) => entry.sequence > this.kept.cursor);
    if (!next.length || this.stopped) return;
    await this.learnNames(next);
    if (this.stopped) return;

    // From here until the workspace is asked to save, nothing waits. Whatever
    // saves the workspace sees it before all of this or after all of it.
    this.noteOwnChanges();
    const before = this.kept.joined ? readBoard(this.doc) : undefined;
    if (before) this.stamps.clear();
    const logChanged = this.applyAll(next);
    // Until the boards are brought together the workspace follows nothing, and
    // nothing is kept: the log is read from its start again on the next run,
    // which also gives every entry its author and its time.
    if (!before) return;
    const follows = this.follow(before, next[next.length - 1].loggedAt);
    await this.keep(logChanged, follows);
  }

  /** Applies entries in order and moves the log position past each. Says whether any applied. */
  private applyAll(entries: LoggedUpdate[]): boolean {
    let applied = false;
    for (const entry of entries) {
      const id = entry.id.toLowerCase();
      const mine = this.kept.unsent.findIndex((update) => update.id === id);
      const why = this.unusable.has(id)
        ? "failed"
        : whyNotApplied(id, entry.payload);
      if (why) this.leaveOut(entry, why);
      else if (this.apply(entry, mine < 0)) applied = true;
      else {
        // Applying threw, and may have left a document half changed. Both go
        // back to what was last saved and the log is read again from there,
        // this entry left out.
        this.unusable.add(id);
        this.mustReopen = true;
        throw new StartAgain();
      }
      // The log has it now, damaged or not. A damaged one is sent again as a repair.
      if (mine >= 0) this.kept.unsent.splice(mine, 1);
      this.logged.delete(id);
      this.kept.cursor = entry.sequence;
    }
    return applied;
  }

  private leaveOut(entry: LoggedUpdate, reason: LeftOutUpdate["reason"]): void {
    this.kept.leftOut.push({
      sequence: entry.sequence,
      id: entry.id.toLowerCase(),
      author: entry.author,
      loggedAt: entry.loggedAt,
      reason,
    });
    this.kept.leftOut.splice(0, this.kept.leftOut.length - LEFT_OUT_KEPT);
  }

  /**
   * Makes the workspace follow what the entries changed on the board.
   * `before` is the board as it was before them. Says whether it changed.
   */
  private follow(before: Board, at: string): boolean {
    const after = readBoard(this.doc);
    if (sameBoard(before, after)) return false;
    const state = this.options.state();
    applyBoard(state, this.options.projectId, before, after, {
      at,
      stampOf: (collection, id) => this.stamps.get(`${collection}/${id}`),
      nameOf: (account) => this.names.get(account),
    });
    // Read-only on a newer layout: `seen` stays, so changes made here are still found later.
    if (this.isNewer()) return true;
    this.kept.seen = boardOf(state, this.options.projectId);
    // A task that came with an identifier one here already has.
    if (this.renumber()) this.noteOwnChanges();
    return true;
  }

  /** Applies one entry inside a guard. Says whether it applied. */
  private apply(entry: LoggedUpdate, toBoth: boolean): boolean {
    this.arriving = entry;
    try {
      Y.applyUpdate(this.logDoc, entry.payload, FROM_LOG);
      // This computer's own update is in the second document since it was made.
      if (toBoth) Y.applyUpdate(this.doc, entry.payload, FROM_LOG);
      return true;
    } catch {
      return false;
    } finally {
      this.arriving = undefined;
    }
  }

  private async learnNames(entries: LoggedUpdate[]): Promise<void> {
    const unknown = entries.filter(
      (entry) =>
        !this.names.has(entry.author) && !this.askedAbout.has(entry.author),
    );
    if (!unknown.length) return;
    for (const entry of unknown) this.askedAbout.add(entry.author);
    await this.learn();
  }

  private async learn(): Promise<void> {
    try {
      // Someone who has left the project keeps the name they had.
      for (const [account, name] of await this.options.people())
        this.names.set(account, name);
    } catch {
      // A name is a nicety. The board does not wait for one.
    }
  }

  // ── This computer's own changes ──────────────────────────────────────────

  private isNewer(): boolean {
    return (layoutOf(this.doc) ?? 0) > LAYOUT;
  }

  /** Writes what changed on this computer into the document. Says whether there was something. */
  private noteOwnChanges(): boolean {
    if (!this.kept.joined || this.isNewer()) return false;
    const state = this.options.state();
    // A project that is gone from this computer is not a board that was emptied.
    if (!state.projects.some((one) => one.id === this.options.projectId))
      return false;
    const now = boardOf(state, this.options.projectId);
    if (sameBoard(this.kept.seen, now)) return false;
    const made = this.recording(() => {
      this.tooLarge += writeChanges(this.doc, this.kept.seen, now);
    });
    this.kept.seen = now;
    return made > 0;
  }

  /** Runs changes to the document and queues each update they make. Says how many. */
  private recording(change: () => void): number {
    const made: Uint8Array[] = [];
    const listen = (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL) made.push(update);
    };
    this.doc.on("update", listen);
    try {
      change();
    } finally {
      this.doc.off("update", listen);
    }
    for (const payload of made)
      this.kept.unsent.push({ id: idOf(payload), payload });
    return made.length;
  }

  /**
   * Makes the board on this computer and the board in the log one board, once.
   * Either this computer shares its project, and its board is written to a log
   * that has none. Or it joins a project that has a board, and takes that
   * board as it is. Two boards with work on them are never made into one.
   */
  private async join(): Promise<void> {
    const state = this.options.state(),
      projectId = this.options.projectId;
    // Nothing of this computer's is in the document before this, so it holds what the log holds.
    const shared = readBoard(this.doc);
    const own = onlyIn(boardOf(state, projectId), shared);
    const joining = hasWork(shared);
    this.apart = joining && hasWork(own);
    if (this.apart) return;
    if (!joining && !this.isNewer())
      this.recording(() => {
        for (const collection of WRITING_ORDER)
          for (const [id, entry] of Object.entries(own[collection]))
            this.tooLarge += writeEntryAlone(this.doc, collection, id, entry);
      });
    const joined = readBoard(this.doc);
    // What was just written is on this computer already. Only the rest is taken.
    const written = onlyIn(joined, shared);
    applyBoard(state, projectId, written, joined, {
      at: new Date().toISOString(),
      stampOf: (collection, id) => this.stamps.get(`${collection}/${id}`),
      nameOf: (account) => this.names.get(account),
    });
    this.stamps.clear();
    this.kept.joined = true;
    if (!this.isNewer()) {
      this.kept.seen = boardOf(state, projectId);
      if (this.renumber()) this.noteOwnChanges();
    }
    await this.keep(true, !sameBoard(written, joined));
  }

  /**
   * Gives a new identifier to every task of this project that shares one with
   * a task that reached the log before it. Says whether anything changed.
   */
  private renumber(): boolean {
    const tasks = this.options
      .state()
      .tasks.filter(
        (task) => task.projectId === this.options.projectId && !task.example,
      );
    const renamed = newIdentifiers(
      tasks.map((task) => ({
        id: task.id,
        identifier: task.identifier,
        arrived: this.kept.arrived[task.id] ?? NOT_IN_THE_LOG,
      })),
    );
    let changed = false;
    for (const task of tasks) {
      const identifier = renamed.get(task.id);
      if (!identifier) continue;
      task.identifier = identifier;
      changed = true;
    }
    return changed;
  }

  /** After the log or this computer changed something: repair, send, and tell the window. */
  private async settle(): Promise<void> {
    if (this.stopped) return;
    if (
      this.kept.joined &&
      !this.kept.unsent.length &&
      !this.isNewer() &&
      holdsMore(this.doc, this.logDoc)
    )
      await this.repair();
    this.send();
    this.report();
  }

  /**
   * This computer holds something the log does not, and has nothing waiting
   * to be sent: an update of its own was damaged on the way into the log. It
   * sends what is missing as a new update.
   */
  private async repair(): Promise<void> {
    const payload = missingFrom(this.logDoc, this.doc);
    if (payload.length > LARGEST_UPDATE) return;
    const taken = new Set(this.kept.leftOut.map((entry) => entry.id));
    for (let again = 0; again < 8; again++) {
      const id = idOf(payload, again);
      if (taken.has(id) || this.repairs.has(id)) continue;
      this.repairs.add(id);
      this.kept.unsent.push({ id, payload });
      return this.store.save(this.toKeep(false));
    }
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  private send(): void {
    if (this.refused) return;
    this.sending ??= this.sendAll().finally(() => {
      this.sending = undefined;
    });
  }

  private async sendAll(): Promise<void> {
    for (let failures = 0; !this.stopped;) {
      const call = nextCall(
        this.kept.unsent.filter((update) => !this.logged.has(update.id)),
      );
      if (!call.length) return;
      try {
        const receipts = await this.options.boards.append(
          this.options.sharedProjectId,
          call,
        );
        failures = 0;
        this.notSent = undefined;
        await this.inTurn(() => this.sent(receipts));
      } catch (problem) {
        if (this.stopped || this.isGone(problem)) return;
        if (problem instanceof SharingRefused) {
          // The service will not take it, now or later. Reading goes on.
          this.refused = problem.message;
          return this.report();
        }
        this.notSent = sentenceOf(problem) ?? CANNOT_SEND;
        this.report();
        await this.pause(this.waitFor(++failures));
      }
    }
  }

  private async sent(receipts: UpdateReceipt[]): Promise<void> {
    if (this.stopped) return;
    let dropped = false;
    for (const receipt of receipts) {
      const id = receipt.id.toLowerCase();
      this.logged.add(id);
      // Logged at a number this computer is already past: it will not come by again.
      const at = this.kept.unsent.findIndex((update) => update.id === id);
      if (at >= 0 && receipt.sequence <= this.kept.cursor) {
        this.kept.unsent.splice(at, 1);
        dropped = true;
      }
    }
    if (dropped) await this.store.save(this.toKeep(false));
    this.report();
  }

  // ── Keeping ──────────────────────────────────────────────────────────────

  private toKeep(withLog: boolean): BoardToKeep {
    return {
      ...this.kept,
      unsent: [...this.kept.unsent],
      leftOut: [...this.kept.leftOut],
      log: withLog ? Y.encodeStateAsUpdate(this.logDoc) : undefined,
    };
  }

  /**
   * Saves what is kept. When the workspace changed with it, the workspace is
   * saved between writing this save and putting it in place, so that after a
   * crash the two are either both as before or both as now.
   */
  private async keep(log: boolean, workspace: boolean): Promise<void> {
    const link = this.link();
    if (!workspace || !link) return this.store.save(this.toKeep(log));
    link.applied = this.kept.applied = this.kept.applied + 1;
    const kept = this.toKeep(log);
    for (let failures = 1; ; failures++) {
      try {
        // Not after a wait: the workspace must be saved as it is right now.
        await this.options.saveWorkspace(() => this.store.prepare(kept));
        break;
      } catch (problem) {
        if (this.stopped) return;
        console.error("A change from the shared board was not saved:", problem);
        this.say("stopped", CANNOT_SAVE);
        await this.pause(this.waitFor(failures));
        if (this.stopped) return;
      }
    }
    await this.store.commit();
    if (this.condition === "stopped" && this.detail === CANNOT_SAVE)
      this.say("live");
  }

  // ── Small things ─────────────────────────────────────────────────────────

  private link(): SharedProjectLink | undefined {
    return this.options
      .state()
      .sharedProjectLinks?.find(
        (link) =>
          link.projectId === this.options.projectId &&
          link.sharedProjectId === this.options.sharedProjectId,
      );
  }

  private inTurn<Result>(job: () => Promise<Result> | Result): Promise<Result> {
    const turn = this.turns.then(job);
    this.turns = turn.catch(() => {});
    return turn;
  }

  private waitFor(failures: number): number {
    return (
      this.options.waitBeforeRetry?.(failures) ??
      WAITS[Math.min(failures, WAITS.length) - 1]
    );
  }

  private pause(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const end = () => {
        clearTimeout(timer);
        this.pauses.delete(end);
        resolve();
      };
      const timer = setTimeout(end, ms);
      this.pauses.add(end);
    });
  }

  /** The shared project is not there for this person any more. Sync ends; the board stays here. */
  private isGone(problem: unknown): boolean {
    if (
      !(problem instanceof SharingRefused) ||
      problem.rule !== "no_such_project"
    )
      return false;
    this.stopped = true;
    this.watching?.cancel();
    for (const end of [...this.pauses]) end();
    this.say("gone", refusalSentences.no_such_project);
    return true;
  }

  private failed(problem: unknown): void {
    if (problem instanceof StartAgain) return this.say("starting");
    const said = sentenceOf(problem);
    if (said) return this.say("offline", said);
    // Not something the service said: start again from what was last saved.
    console.error("Board sync failed and starts again:", problem);
    this.mustReopen = true;
    this.say(
      "offline",
      "Board sync ran into a problem and is starting again. Nothing on this computer was lost.",
    );
  }

  private say(condition: Condition, detail?: string): void {
    this.condition = condition;
    this.detail = detail;
    this.report();
  }

  private report(): void {
    const shown = JSON.stringify(this.status());
    if (shown === this.lastShown) return;
    this.lastShown = shown;
    this.options.shown();
  }
}
