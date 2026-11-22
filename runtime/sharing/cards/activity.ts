import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppState, Message, WorkItem } from "../../../src/shared";
import type { StoryReviewRun } from "../../../src/code-review";
import type { TeamSession } from "../../../src/team-session";
import { replaceWorkspace } from "../../persistence";
import type { CardsApi, LoggedCardEntry } from "../memsync/cards-api";
import type { GrpcStream } from "../memsync/grpc";
import { SharingRefused } from "../problems";
import { idOf, nextCall } from "../board/updates";
import {
  cardPayloads,
  publicMessage,
  publicText,
  publicValue,
  readCardEntry,
  sessionIdOf,
  type CardEntry,
  type CardRecord,
  type SessionPart,
  type SharedResultRecord,
  type WritingDevice,
} from "./entries";

export interface CardActivityOptions {
  /** The project on this computer. */
  projectId: string;
  /** The shared project whose cards' logs these are. */
  sharedProjectId: string;
  /** This computer. Entries it wrote itself are never shown back to it. */
  device: WritingDevice;
  /** Where this project keeps what it sent. */
  folder: string;
  state(): AppState;
  cards: CardsApi;
  /** The latest code review report of a task on this computer. */
  reviewOf(taskId: string): Promise<StoryReviewRun | null>;
  /** The name of someone on the shared project, when it is known. */
  nameOf(accountId: string): string | undefined;
  /** What a card shows changed. Nothing needs saving. */
  shown(): void;
  waitBeforeRetry?: (failures: number) => number;
}

interface Waiting {
  cardId: string;
  id: string;
  payload: Uint8Array;
}
/** What was last sent of each run, so only what changed is sent again. */
interface Sent {
  head?: string;
  turns: Record<string, string>;
  review?: string;
}
interface KeptFile {
  version: 1;
  sent: Record<string, Sent>;
  waiting: Array<{ cardId: string; id: string; payload: string }>;
}

/** A run of a worker on another computer, as its log entries tell it. */
interface RunElsewhere {
  /** The account that wrote the run's first entry. Only its entries count. */
  account: string;
  device: WritingDevice;
  head: Omit<SessionPart, "messages">;
  turns: Map<string, Message>;
  review?: StoryReviewRun;
  updatedAt: string;
  sequence: number;
  entries: number;
}
/** A shared file, with the account that named it. The window gets the name only. */
type KnownResult = SharedResultRecord & { account: string; sharedAt: string };
interface Followed {
  followers: number;
  cursor: number;
  runs: Map<string, RunElsewhere>;
  results: KnownResult[];
  stream?: GrpcStream;
  reading?: Promise<void>;
  stopped: boolean;
}

const WAITS = [1000, 2000, 5000, 15000, 30000, 60000];
const SOMEONE = "Someone on this project";
const progressLabels: Record<string, string> = {
  preparing: "Preparing the worker",
  joining: "Coordinating with the goal’s other tasks",
  starting: "Starting the harness",
  responding: "Worker is responding",
  reading: "Reading project context",
  editing: "Editing project files",
  testing: "Running checks",
  working: "Working on the task",
  waiting: "Waiting for input or a handoff",
  waiting_for_user: "Waiting for an answer on the worker's device",
  finishing: "Finishing the worker turn",
  stopping: "Stopping the worker",
};
const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id of a task's card at the sharing service: the task's own id when it is a
 * UUID, as MemCode makes them, and a UUID made from it otherwise. The same on
 * every computer.
 */
export function cardIdOf(taskId: string): string {
  if (uuidShape.test(taskId)) return taskId.toLowerCase();
  const bytes = createHash("sha256")
    .update(`memcode-card\n${taskId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A worker run on this computer, as it may be shared. */
function sessionOf(task: WorkItem, device: WritingDevice): SessionPart {
  const run = task.run;
  return {
    id: sessionIdOf(device.id, task.id, run.startedAt!),
    harness: task.harness,
    ...(task.route?.model ? { requestedModel: task.route.model } : {}),
    ...(run.measurements?.modelId
      ? { actualModel: run.measurements.modelId }
      : {}),
    state: run.state,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.error ? { error: publicText(run.error).slice(0, 8000) } : {}),
    ...(run.activity
      ? {
          activity: {
            phase: run.activity.phase.slice(0, 100),
            label: progressLabels[run.activity.phase] ?? "Working on the task",
            updatedAt: run.activity.at,
          },
        }
      : {}),
    messages: task.messages
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .slice(-10000)
      .map(publicMessage),
  };
}

/**
 * The activity of one connected project's cards at the sharing service.
 *
 * On the computer that runs a worker, every run on a card of this project is
 * written to that card's log as it happens: its state, what it is doing, the
 * person's and the worker's turns, and its code review. A file someone shares
 * from a card is uploaded and named in the log.
 *
 * On every computer, a card someone opens is read from its log and followed
 * while it is open. A run from another computer is shown on the card, read
 * only, and only from entries of the account that started it.
 */
export class CardActivity {
  private sent: Record<string, Sent> = {};
  private waiting: Waiting[] = [];
  private loaded?: Promise<void>;
  private turns: Promise<unknown> = Promise.resolve();
  private sending?: Promise<void>;
  private capturing?: Promise<void>;
  private followed = new Map<string, Followed>();
  private stopped = false;
  private pauses = new Set<() => void>();

  constructor(private readonly options: CardActivityOptions) {}

  // ── This computer's runs ─────────────────────────────────────────────────

  /** Looks at this project's tasks for what a run did since it was last written. */
  capture(): Promise<void> {
    this.capturing ??= this.inTurn(async () => {
      this.capturing = undefined;
      await this.load();
      if (this.stopped) return;
      const records: Array<{ cardId: string; records: CardRecord[] }> = [];
      for (const task of this.tasksRunHere()) {
        records.push({
          cardId: cardIdOf(task.id),
          records: await this.changesOf(task),
        });
        // A run that starts here takes over an open card from one elsewhere.
        const open = this.followed.get(task.id);
        if (open && !open.stopped && task.sharedSession)
          this.show(task.id, open);
      }
      const fresh = records.filter((card) => card.records.length);
      if (!fresh.length) return;
      for (const { cardId, records: made } of fresh)
        for (const record of made) this.queue(cardId, record);
      await this.keep();
      this.send();
    });
    return this.capturing;
  }

  /** Names a file someone shared from a card in the card's log, once its bytes are kept. */
  async shareResult(
    taskId: string,
    file: {
      name: string;
      mime: string;
      kind: SharedResultRecord["kind"];
      bytes: Uint8Array;
    },
  ): Promise<SharedResultRecord> {
    await this.load();
    const stored = await this.options.cards.upload(
      this.options.sharedProjectId,
      file.bytes,
    );
    const result: SharedResultRecord = {
      id: crypto.randomUUID(),
      name: file.name,
      mime: file.mime,
      sha256: stored.sha256,
      size: stored.size,
      kind: file.kind,
    };
    await this.inTurn(async () => {
      this.queue(cardIdOf(taskId), { kind: "result", result });
      await this.keep();
    });
    this.send();
    await this.sending;
    return result;
  }

  /** Whether something written here has not reached the sharing service yet. */
  get unsent(): number {
    return this.waiting.length;
  }

  private tasksRunHere(): WorkItem[] {
    return this.options
      .state()
      .tasks.filter(
        (task) =>
          task.projectId === this.options.projectId &&
          !task.example &&
          !!task.run.startedAt,
      );
  }

  private async changesOf(task: WorkItem): Promise<CardRecord[]> {
    const session = sessionOf(task, this.options.device);
    const sent = (this.sent[session.id] ??= { turns: {} });
    const { messages, ...head } = session;
    const changed = messages.filter(
      (message) => sent.turns[message.id] !== fingerprint(message),
    );
    const records: CardRecord[] = [];
    const headPrint = fingerprint(head);
    if (headPrint !== sent.head || changed.length) {
      records.push({
        kind: "session",
        session: { ...head, messages: changed },
      });
      sent.head = headPrint;
      for (const message of changed)
        sent.turns[message.id] = fingerprint(message);
    }
    if (task.codeReview) {
      const review = await this.options.reviewOf(task.id).catch(() => null);
      const shared = review && publicValue(review);
      const reviewPrint = shared && fingerprint(shared);
      if (shared && reviewPrint !== sent.review) {
        records.push({ kind: "review", sessionId: session.id, review: shared });
        sent.review = reviewPrint!;
      }
    }
    return records;
  }

  private queue(cardId: string, record: CardRecord): void {
    for (const payload of cardPayloads(record, this.options.device))
      this.waiting.push({ cardId, id: idOf(payload), payload });
  }

  private send(): void {
    if (this.stopped) return;
    this.sending ??= this.sendAll().finally(() => {
      this.sending = undefined;
    });
  }

  private async sendAll(): Promise<void> {
    for (let failures = 0; !this.stopped && this.waiting.length;) {
      const cardId = this.waiting[0].cardId;
      const call = nextCall(
        this.waiting.filter((entry) => entry.cardId === cardId),
      );
      try {
        await this.options.cards.append(
          this.options.sharedProjectId,
          cardId,
          call.map(({ id, payload }) => ({ id, payload })),
        );
        failures = 0;
        await this.inTurn(() => this.done(call));
      } catch (problem) {
        if (this.stopped) return;
        if (problem instanceof SharingRefused) {
          if (problem.rule === "no_such_project") return;
          // The service will not take these, now or later. The rest still goes.
          console.error("A card entry was refused:", problem.rule);
          await this.inTurn(() => this.done(call));
          continue;
        }
        await this.pause(this.waitFor(++failures));
      }
    }
  }

  private async done(sent: Waiting[]): Promise<void> {
    const ids = new Set(sent.map((entry) => entry.id));
    this.waiting = this.waiting.filter((entry) => !ids.has(entry.id));
    await this.keep();
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const kept = JSON.parse(
          await readFile(join(this.options.folder, "cards.json"), "utf8"),
        ) as KeptFile;
        if (kept.version !== 1) return;
        this.sent = kept.sent ?? {};
        this.waiting = (kept.waiting ?? []).map((entry) => ({
          ...entry,
          payload: Buffer.from(entry.payload, "base64"),
        }));
      } catch {
        // Nothing kept yet, or nothing usable: what runs here is written again in full.
      }
      if (this.waiting.length) this.send();
    })();
    return this.loaded;
  }

  private async keep(): Promise<void> {
    const kept: KeptFile = {
      version: 1,
      sent: this.sent,
      waiting: this.waiting.map((entry) => ({
        cardId: entry.cardId,
        id: entry.id,
        payload: Buffer.from(entry.payload).toString("base64"),
      })),
    };
    await mkdir(this.options.folder, { recursive: true });
    const path = join(this.options.folder, "cards.json");
    await writeFile(path + ".next", JSON.stringify(kept), "utf8");
    await replaceWorkspace(path + ".next", path);
  }

  // ── Cards someone opens ──────────────────────────────────────────────────

  /** Reads a card's log and follows it while the card is open. */
  follow(taskId: string): void {
    if (this.stopped) return;
    const known = this.followed.get(taskId);
    if (known && !known.stopped) {
      known.followers++;
      return;
    }
    // A card opened again is read again from its start, by a reader of its own.
    const card: Followed = {
      followers: 1,
      cursor: 0,
      runs: new Map(),
      results: [],
      stopped: false,
    };
    this.followed.set(taskId, card);
    card.reading = this.read(taskId, card);
  }

  /** The card was closed. What it showed stays on it until MemCode is closed. */
  unfollow(taskId: string): void {
    const card = this.followed.get(taskId);
    if (!card || --card.followers > 0) return;
    card.stopped = true;
    card.stream?.cancel();
  }

  private async read(taskId: string, card: Followed): Promise<void> {
    const cardId = cardIdOf(taskId);
    for (let failures = 0; !card.stopped && !this.stopped;) {
      try {
        for (;;) {
          const page = await this.options.cards.readAfter(
            this.options.sharedProjectId,
            cardId,
            card.cursor,
          );
          if (card.stopped || !page.length) break;
          this.take(taskId, card, page);
        }
        if (card.stopped) return;
        failures = 0;
        const stream = this.options.cards.watchAfter(
          this.options.sharedProjectId,
          cardId,
          card.cursor,
          (entry) => this.take(taskId, card, [entry]),
        );
        card.stream = stream;
        await stream.finished;
        failures = 1;
      } catch (problem) {
        if (card.stopped || this.stopped) return;
        if (
          problem instanceof SharingRefused &&
          problem.rule === "no_such_project"
        )
          return;
        failures++;
      }
      await this.pause(this.waitFor(failures));
    }
  }

  private take(taskId: string, card: Followed, entries: LoggedCardEntry[]) {
    let changed = false;
    for (const logged of entries) {
      if (logged.sequence <= card.cursor) continue;
      card.cursor = logged.sequence;
      const read = readCardEntry(logged.payload);
      if (!read.readable) continue;
      changed = this.apply(card, read.entry, logged) || changed;
    }
    if (changed) this.show(taskId, card);
  }

  /** Takes one entry into what a card shows. Says whether it changed anything. */
  private apply(
    card: Followed,
    entry: CardEntry,
    logged: LoggedCardEntry,
  ): boolean {
    if (entry.kind === "result") {
      if (card.results.some((result) => result.id === entry.result.id))
        return false;
      card.results.push({
        ...entry.result,
        account: logged.author,
        sharedAt: logged.loggedAt,
      });
      return true;
    }
    // A run of this computer's own is shown from the task itself.
    if (entry.device.id === this.options.device.id) return false;
    if (entry.kind === "session") {
      const { messages, ...head } = entry.session;
      const run = card.runs.get(head.id);
      // A run's conversation counts only from the account that started it.
      if (run && run.account !== logged.author) return false;
      const kept: RunElsewhere = run ?? {
        account: logged.author,
        device: entry.device,
        head,
        turns: new Map(),
        updatedAt: logged.loggedAt,
        sequence: logged.sequence,
        entries: 0,
      };
      kept.head = head;
      for (const message of messages) kept.turns.set(message.id, message);
      kept.updatedAt = logged.loggedAt;
      kept.sequence = logged.sequence;
      kept.entries++;
      card.runs.set(head.id, kept);
      return true;
    }
    const run = card.runs.get(entry.sessionId);
    if (!run || run.account !== logged.author) return false;
    run.review = entry.review;
    run.updatedAt = logged.loggedAt;
    run.entries++;
    return true;
  }

  /** Puts what a card's log says on the task, for the card's views. */
  private show(taskId: string, card: Followed): void {
    const task = this.options
      .state()
      .tasks.find(
        (item) =>
          item.id === taskId && item.projectId === this.options.projectId,
      );
    if (!task) return;
    task.sharedResults = card.results.map(({ account, ...result }) => ({
      ...result,
      sharedBy: this.options.nameOf(account) ?? SOMEONE,
    }));
    const latest = [...card.runs.values()]
      .sort((left, right) =>
        String(left.head.startedAt ?? "").localeCompare(
          String(right.head.startedAt ?? ""),
        ),
      )
      .at(-1);
    const localStart = task.run.startedAt ?? "";
    const runsHere = ["preparing", "running", "stopping"].includes(
      task.run.state,
    );
    if (
      !latest ||
      runsHere ||
      String(latest.head.startedAt ?? "") < localStart
    ) {
      delete task.sharedSession;
      delete task.sharedFromLog;
    } else {
      task.sharedSession = this.sessionFor(task.id, latest);
      task.sharedFromLog = true;
    }
    this.options.shown();
  }

  private sessionFor(taskId: string, run: RunElsewhere): TeamSession {
    const turns = [...run.turns.values()].sort((left, right) =>
      left.at.localeCompare(right.at),
    );
    return {
      ...(run.head as Omit<TeamSession, "messages">),
      storyId: taskId,
      epoch: 1,
      revision: run.entries,
      sequence: run.sequence,
      owner: {
        // The window is given names, not account ids.
        memberId: fingerprint(["owner", run.account]).slice(0, 32),
        name: this.options.nameOf(run.account) ?? SOMEONE,
        deviceId: run.device.id,
        device: run.device.name,
      },
      updatedAt: run.updatedAt,
      messages: turns,
      ...(run.review ? { review: { ...run.review, taskId } } : {}),
    } as TeamSession;
  }

  // ── Small things ─────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    this.stopped = true;
    for (const card of this.followed.values()) {
      card.stopped = true;
      card.stream?.cancel();
    }
    for (const end of [...this.pauses]) end();
    await this.turns;
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
}
