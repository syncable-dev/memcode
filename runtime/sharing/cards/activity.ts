import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AppState,
  Artifact,
  Message,
  WorkItem,
} from "../../../src/shared";
import type { StoryReviewRun } from "../../../src/code-review";
import type {
  RunSummary,
  SessionActor,
  SharedSummary,
  TeamSession,
} from "../../../src/team-session";
import type {
  WorkerInputRequest,
  WorkerInputResponse,
} from "../../../src/worker-input";
import type { SharedAsk } from "../../../src/sharing";
import { replaceWorkspace } from "../../persistence";
import type { CardsApi, LoggedCardEntry } from "../memsync/cards-api";
import type { CardReaders } from "../memsync/cards-contract";
import type { GrpcStream } from "../memsync/grpc";
import { SharingRefused } from "../problems";
import { isForPeople, LARGEST_SHARED_FILE } from "./files";
import { idOf, nextCall } from "../board/updates";
import { summaryOf } from "./summary";
import {
  cardPayloads,
  publicMessage,
  publicText,
  publicValue,
  readCardEntry,
  readersOf,
  sessionIdOf,
  type CardEntry,
  type CardRecord,
  type DeliveryRecord,
  type DeliveryState,
  type InputRecord,
  type SessionPart,
  type SharedResultRecord,
  type WorkerMessageRecord,
  type WritingDevice,
} from "./entries";
import {
  answerStanding,
  answerSummary,
  inputRecordOf,
  messageStanding,
  type Host,
} from "./worker-messages";

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
  /** What a task changed here, as its Changes tab shows it, or nothing when it changed nothing. */
  changesOf?(taskId: string): Promise<Uint8Array | undefined>;
  /** A file a task's worker saved here, read to share it. Throws a sentence when it may not be shared. */
  savedFileOf?(taskId: string, artifactId: string): Promise<SavedFile>;
  /** The name of someone on the shared project, when it is known. */
  nameOf(accountId: string): string | undefined;
  /** Asks the sharing service for the name of someone not known yet: they may have joined since. */
  learnName?(accountId: string): Promise<void>;
  /** What a card shows changed. Nothing needs saving. */
  shown(): void;
  /** The account signed in here. Its own other computers may continue its workers. */
  me: string;
  /** Continues a worker run here with a follow-up from another computer, as one typed here. */
  deliver?(taskId: string, message: Message): Promise<void>;
  /** Answers what a worker run here waits for, as if it was answered here. */
  answer?(
    taskId: string,
    inputId: string,
    response: WorkerInputResponse,
  ): Promise<void>;
  waitBeforeRetry?: (failures: number) => number;
}

interface Waiting {
  cardId: string;
  id: string;
  payload: Uint8Array;
  readers: CardReaders;
}
/** What was last sent of each run, so only what changed is sent again. */
interface Sent {
  /** The run as everyone on the project sees it. */
  run?: string;
  /** The run as its own account sees it. */
  head?: string;
  turns: Record<string, string>;
  review?: string;
  summary?: string;
  /** What the finished run changed, as last shared. */
  changes?: string;
  /** When the run's changes were last looked at: its end, then its code review's. */
  changesLookedAt?: string;
  inputs?: Record<string, string>;
}
/** A message from another computer to a worker run here, and what became of it. */
interface Handled {
  taskId: string;
  sessionId: string;
  state: DeliveryState;
  author: string;
  device: WritingDevice;
  sentAt: string;
  text?: string;
  answer?: WorkerMessageRecord["answer"];
}
/** A message written here, shown on its card until the card's log has it. */
interface Outgoing {
  taskId: string;
  message: WorkerMessageRecord;
}
/** A file to share from a card. */
interface SavedFile {
  name: string;
  mime: string;
  kind: SharedResultRecord["kind"];
  bytes: Uint8Array;
}
interface KeptFile {
  version: 1;
  sent: Record<string, Sent>;
  /** The version of each file a worker saved here that was shared on its own, by the file's id. */
  sharedFiles?: Record<string, string>;
  /** Readers is missing from what an older MemCode kept: those are sent for their author alone. */
  waiting: Array<{
    cardId: string;
    id: string;
    payload: string;
    readers?: CardReaders;
  }>;
  /** How far the log of each card with a worker run here has been read for messages. */
  hosted?: Record<string, number>;
  handled?: Record<string, Handled>;
  outgoing?: Outgoing[];
}

/** A run of a worker on another computer, as its log entries tell it. */
interface RunElsewhere {
  /** The account that wrote the run's first entry. Only its entries count. */
  account: string;
  device: WritingDevice;
  head: Omit<SessionPart, "messages">;
  turns: Map<string, Message>;
  review?: StoryReviewRun;
  /** One per round of work in the run, by when its worker wrote it. */
  summaries: Map<string, RunSummary>;
  updatedAt: string;
  sequence: number;
  entries: number;
}
/** A shared file, with the account that named it. The window gets the name only. */
type KnownResult = SharedResultRecord & {
  account: string;
  sharedAt: string;
  sharedHere: boolean;
};
/** One card's log, read from `cursor` on and watched. */
interface Reader {
  cursor: number;
  stream?: GrpcStream;
  reading?: Promise<void>;
  stopped: boolean;
}
interface LoggedMessage {
  record: WorkerMessageRecord;
  author: string;
  device: WritingDevice;
}
interface Followed extends Reader {
  followers: number;
  runs: Map<string, RunElsewhere>;
  results: KnownResult[];
  messages: Map<string, LoggedMessage>;
  /** Per message, the latest delivery by each account that wrote one. */
  deliveries: Map<string, Map<string, DeliveryRecord>>;
  /** Per input, the latest of it by each account that wrote one. */
  inputs: Map<string, Map<string, InputRecord>>;
}

const WAITS = [1000, 2000, 5000, 15000, 30000, 60000];
/** How long after a run here ends its card is still read for messages to it. */
export const CONTINUABLE_FOR_MS = 3 * 24 * 60 * 60 * 1000;
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
/**
 * A file the service turned down, as when the project is full, is not sent again; one
 * that could not reach it is, on the next look.
 */
const skipRefused = (problem: unknown) => {
  if (problem instanceof SharingRefused) return;
  throw problem;
};
/** Which version of a worker's file this is: it changes when the worker writes the file again. */
const versionOf = (file: Artifact) => file.revision ?? file.createdAt;
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
  /** The cards of workers run here, read for messages to them. */
  private hosting = new Map<string, Reader>();
  private hosted: Record<string, number> = {};
  private handled: Record<string, Handled> = {};
  private outgoing: Array<Outgoing & { waitingId: string }> = [];
  private stopped = false;
  private pauses = new Set<() => void>();
  /** Runs whose changes are being shared now, so two captures share them once. */
  private sharingChanges = new Set<string>();
  /** The version of each worker's file shared on its own, by the file's id. */
  private sharedFiles: Record<string, string> = {};
  /** Files being shared now, so two captures share each once. */
  private sharingFiles = new Set<string>();

  constructor(private readonly options: CardActivityOptions) {}

  // ── This computer's runs ─────────────────────────────────────────────────

  /**
   * Looks at this project's tasks for what a run did since it was last written, and
   * shares what a run that finished changed and the files its worker made for people.
   */
  capture(): Promise<void> {
    this.capturing ??= this.captureRuns()
      .then(() => this.shareChangesOfFinishedRuns())
      .then(() => this.shareFilesOfFinishedRuns());
    return this.capturing;
  }

  private captureRuns(): Promise<void> {
    return this.inTurn(async () => {
      this.capturing = undefined;
      await this.load();
      if (this.stopped) return;
      let fresh = 0;
      for (const task of this.tasksRunHere()) {
        const made = [
          ...(await this.changesOf(task)),
          ...this.inputsOf(task),
          ...this.deliveriesOf(task),
        ];
        for (const record of made) this.queue(cardIdOf(task.id), record);
        fresh += made.length;
        // A run that starts here takes over an open card from one elsewhere.
        const open = this.followed.get(task.id);
        if (open && !open.stopped && task.sharedSession)
          this.show(task.id, open);
      }
      this.host();
      if (!fresh) return;
      await this.keep();
      this.send();
    });
  }

  /**
   * What each run here that finished changed, shared with everyone on the project.
   * They are looked at when the run ends and again when its code review settles, for
   * changes recorded after the end, and shared when they differ from what was. A run
   * that changed nothing, or more than a file may hold, shares nothing.
   */
  private async shareChangesOfFinishedRuns(): Promise<void> {
    for (const task of this.tasksRunHere()) {
      if (this.stopped || task.run.state !== "finished") continue;
      const sessionId = sessionIdOf(
        this.options.device.id,
        task.id,
        task.run.startedAt!,
      );
      const sent = (this.sent[sessionId] ??= { turns: {} });
      const settledAt =
        task.codeReview?.updatedAt ?? task.run.finishedAt ?? task.run.startedAt;
      if (
        sent.changesLookedAt === settledAt ||
        this.sharingChanges.has(sessionId)
      )
        continue;
      this.sharingChanges.add(sessionId);
      try {
        const bytes = await this.options.changesOf?.(task.id);
        const print =
          bytes && fingerprint(Buffer.from(bytes).toString("base64"));
        if (
          bytes?.length &&
          bytes.length <= LARGEST_SHARED_FILE &&
          print !== sent.changes
        ) {
          await this.shareResult(task.id, {
            name: `${task.identifier}-changes.json`,
            mime: "application/json",
            kind: "patch",
            bytes,
          });
          sent.changes = print;
        }
        sent.changesLookedAt = settledAt;
        await this.inTurn(() => this.keep());
      } finally {
        this.sharingChanges.delete(sessionId);
      }
    }
  }

  /**
   * The documents, images, sheets and slides a worker made, shared with everyone on
   * the project once its run finishes, and again when a later round of work changes
   * one. Code and data stay here unless someone shares them, and so does a file
   * larger than the service keeps.
   */
  private async shareFilesOfFinishedRuns(): Promise<void> {
    for (const task of this.tasksRunHere()) {
      if (task.run.state !== "finished") continue;
      for (const file of this.filesForPeople(task)) {
        if (this.stopped) return;
        await this.shareFileOnce(task, file);
      }
    }
  }

  private filesForPeople(task: WorkItem): Artifact[] {
    return this.options
      .state()
      .artifacts.filter(
        (file) =>
          file.taskId === task.id &&
          !file.id.startsWith("shared:") &&
          isForPeople(file.name) &&
          this.sharedFiles[file.id] !== versionOf(file),
      );
  }

  private async shareFileOnce(task: WorkItem, file: Artifact): Promise<void> {
    if (this.sharingFiles.has(file.id) || !this.options.savedFileOf) return;
    this.sharingFiles.add(file.id);
    try {
      const saved = await this.options
        .savedFileOf(task.id, file.id)
        .catch(() => undefined);
      if (saved && saved.bytes.length <= LARGEST_SHARED_FILE)
        await this.shareResult(task.id, saved).catch(skipRefused);
      this.sharedFiles[file.id] = versionOf(file);
      await this.inTurn(() => this.keep());
    } finally {
      this.sharingFiles.delete(file.id);
    }
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

  /**
   * What a run here did since it was last written: how it stands, for everyone, and
   * what was said and why it failed, for its own account (readersOf).
   */
  private async changesOf(task: WorkItem): Promise<CardRecord[]> {
    const session = sessionOf(task, this.options.device);
    const sent = (this.sent[session.id] ??= { turns: {} });
    const { messages, ...head } = session;
    const { error, ...run } = head;
    const changed = messages.filter(
      (message) => sent.turns[message.id] !== fingerprint(message),
    );
    const records: CardRecord[] = [];
    const runPrint = fingerprint(run);
    if (runPrint !== sent.run) {
      records.push({ kind: "session", session: { ...run, messages: [] } });
      sent.run = runPrint;
    }
    const headPrint = fingerprint(head);
    const failedSinceSent = !!error && headPrint !== sent.head;
    if (changed.length || failedSinceSent)
      records.push({
        kind: "session",
        session: { ...head, messages: changed },
      });
    sent.head = headPrint;
    for (const message of changed)
      sent.turns[message.id] = fingerprint(message);
    const summary = summaryOf(task, this.projectFolders());
    const summaryPrint = summary && fingerprint(summary);
    if (summary && summaryPrint !== sent.summary) {
      records.push({ kind: "summary", sessionId: session.id, summary });
      sent.summary = summaryPrint;
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

  /** Where this project's code is on this computer, so a summary names files by their path in it. */
  private projectFolders(): string[] {
    const path = this.options
      .state()
      .projects.find((project) => project.id === this.options.projectId)?.path;
    return path ? [path] : [];
  }

  /** What a run here waits for, when it is new or has changed since it was written. */
  private inputsOf(task: WorkItem): CardRecord[] {
    const startedAt = task.run.startedAt!;
    const sessionId = sessionIdOf(this.options.device.id, task.id, startedAt);
    const written = ((this.sent[sessionId] ??= { turns: {} }).inputs ??= {});
    return (this.options.state().workerInputs ?? [])
      .filter(
        (input) => input.taskId === task.id && input.createdAt >= startedAt,
      )
      .flatMap((input): CardRecord[] => {
        const record = inputRecordOf(input, sessionId);
        const print = fingerprint(record);
        if (written[input.id] === print) return [];
        written[input.id] = print;
        return [{ kind: "input", input: record }];
      });
  }

  /** What became of follow-ups from other computers that waited for a worker here. */
  private deliveriesOf(task: WorkItem): CardRecord[] {
    const records: CardRecord[] = [];
    for (const [messageId, handled] of Object.entries(this.handled)) {
      if (handled.taskId !== task.id || handled.state !== "queued") continue;
      const turn = task.messages.find((message) => message.id === messageId);
      const state: DeliveryState | undefined =
        !turn || turn.followupState === "cancelled"
          ? "declined"
          : turn.promptedAt || turn.pickedUpAt
            ? "picked-up"
            : turn.followupState === "paused"
              ? "failed"
              : undefined;
      if (state) records.push(this.delivery(messageId, handled, state));
    }
    return records;
  }

  private delivery(
    messageId: string,
    handled: Handled,
    state: DeliveryState,
    detail?: string,
  ): CardRecord {
    handled.state = state;
    return {
      kind: "delivery",
      delivery: {
        messageId,
        sessionId: handled.sessionId,
        state,
        at: new Date().toISOString(),
        ...(detail ? { detail: publicText(detail).slice(0, 500) } : {}),
      },
    };
  }

  private queue(cardId: string, record: CardRecord): string[] {
    const ids: string[] = [];
    const readers = readersOf(record);
    for (const payload of cardPayloads(record, this.options.device)) {
      const id = idOf(payload);
      this.waiting.push({ cardId, id, payload, readers });
      ids.push(id);
    }
    return ids;
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
          call.map(({ id, payload, readers }) => ({ id, payload, readers })),
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
          readers: entry.readers ?? "only-its-author",
        }));
        this.hosted = kept.hosted ?? {};
        this.handled = kept.handled ?? {};
        this.outgoing = (kept.outgoing ?? []) as typeof this.outgoing;
        this.sharedFiles = kept.sharedFiles ?? {};
      } catch {
        // Nothing kept yet, or nothing usable: what runs here is written again in full.
      }
      if (this.waiting.length) this.send();
      const asking = Object.values(this.handled).filter(
        (handled) => handled.state === "asking",
      );
      const showAll = () => {
        for (const taskId of new Set(
          Object.values(this.handled).map((handled) => handled.taskId),
        ))
          this.showAsks(taskId);
      };
      showAll();
      if (asking.length)
        void this.learnNames(asking.map((handled) => handled.author)).then(
          showAll,
        );
    })();
    return this.loaded;
  }

  private async keep(): Promise<void> {
    // Stopped: a send that ends now writes nothing. What still waited is kept from before.
    if (this.stopped) return;
    // A message written here is kept until it is sent and its card has read it back.
    this.outgoing = this.outgoing.filter(
      (sent) =>
        this.waiting.some((entry) => entry.id === sent.waitingId) ||
        (this.followed.get(sent.taskId)?.stopped === false &&
          !this.followed.get(sent.taskId)!.messages.has(sent.message.id)),
    );
    const kept: KeptFile = {
      version: 1,
      sent: this.sent,
      waiting: this.waiting.map((entry) => ({
        cardId: entry.cardId,
        id: entry.id,
        payload: Buffer.from(entry.payload).toString("base64"),
        readers: entry.readers,
      })),
      hosted: this.hosted,
      handled: this.handled,
      outgoing: this.outgoing,
      sharedFiles: this.sharedFiles,
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
      messages: new Map(),
      deliveries: new Map(),
      inputs: new Map(),
      stopped: false,
    };
    this.followed.set(taskId, card);
    card.reading = this.readLog(taskId, card, (entries) =>
      this.take(taskId, card, entries),
    );
  }

  /** The card was closed. What it showed stays on it until MemCode is closed. */
  unfollow(taskId: string): void {
    const card = this.followed.get(taskId);
    if (!card || --card.followers > 0) return;
    card.stopped = true;
    card.stream?.cancel();
  }

  /** Reads a card's log from the reader's cursor on, then watches it, until stopped. */
  private async readLog(
    taskId: string,
    reader: Reader,
    take: (entries: LoggedCardEntry[]) => void,
  ): Promise<void> {
    const cardId = cardIdOf(taskId);
    for (let failures = 0; !reader.stopped && !this.stopped;) {
      try {
        for (;;) {
          const page = await this.options.cards.readAfter(
            this.options.sharedProjectId,
            cardId,
            reader.cursor,
          );
          if (reader.stopped || !page.length) break;
          take(page);
        }
        if (reader.stopped) return;
        failures = 0;
        const stream = this.options.cards.watchAfter(
          this.options.sharedProjectId,
          cardId,
          reader.cursor,
          (entry) => take([entry]),
        );
        reader.stream = stream;
        await stream.finished;
        failures = 1;
      } catch (problem) {
        if (reader.stopped || this.stopped) return;
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
    if (!changed) return;
    this.show(taskId, card);
    // Someone who joined since this computer last looked: named once it has asked.
    const unknown = [
      ...[...card.runs.values()].map((run) => run.account),
      ...[...card.messages.values()].map((message) => message.author),
    ].filter((account) => !this.options.nameOf(account));
    if (unknown.length)
      void this.learnNames(unknown).then(() => {
        if (!card.stopped) this.show(taskId, card);
      });
  }

  private readonly askedNames = new Set<string>();
  /** Asks once for the names of people this computer does not know yet. */
  private async learnNames(accounts: string[]): Promise<void> {
    const fresh = [...new Set(accounts)].filter(
      (account) =>
        !this.options.nameOf(account) && !this.askedNames.has(account),
    );
    for (const account of fresh) this.askedNames.add(account);
    await Promise.all(
      fresh.map((account) => this.options.learnName?.(account).catch(() => {})),
    );
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
        sharedHere: entry.device.id === this.options.device.id,
      });
      return true;
    }
    if (entry.kind === "message") {
      card.messages.set(entry.message.id, {
        record: entry.message,
        author: logged.author,
        device: entry.device,
      });
      return true;
    }
    if (entry.kind === "delivery" || entry.kind === "input") {
      const [kept, id, value] =
        entry.kind === "delivery"
          ? [card.deliveries, entry.delivery.messageId, entry.delivery]
          : [card.inputs, entry.input.id, entry.input];
      const byAccount = (kept.get(id) ?? new Map()) as Map<
        string,
        typeof value
      >;
      byAccount.set(logged.author, value);
      (kept as Map<string, Map<string, typeof value>>).set(id, byAccount);
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
        summaries: new Map(),
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
    if (entry.kind === "summary")
      run.summaries.set(entry.summary.at, entry.summary);
    else run.review = entry.review;
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
    const latest = this.latestRun(card);
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
      delete task.sharedRunIsYours;
      delete task.sharedInputs;
    } else {
      task.sharedSession = this.sessionFor(task.id, latest, card);
      task.sharedFromLog = true;
      task.sharedRunIsYours = latest.account === this.options.me;
      const inputs = this.inputsFor(task.id, latest, card);
      if (inputs.length) task.sharedInputs = inputs;
      else delete task.sharedInputs;
    }
    this.options.shown();
  }

  private latestRun(card: Followed): RunElsewhere | undefined {
    return [...card.runs.values()]
      .sort((left, right) =>
        String(left.head.startedAt ?? "").localeCompare(
          String(right.head.startedAt ?? ""),
        ),
      )
      .at(-1);
  }

  private hostOf(run: RunElsewhere): Host {
    return {
      name: this.options.nameOf(run.account) ?? SOMEONE,
      device: run.device.name,
      isYou: run.account === this.options.me,
    };
  }

  private actorOf(author: string, device: WritingDevice): SessionActor {
    return {
      memberId: fingerprint(["owner", author]).slice(0, 32),
      name: this.options.nameOf(author) ?? SOMEONE,
      deviceId: device.id,
      device: device.name,
    };
  }

  /** The messages to a run: those in the card's log, and those written here that it has not read back yet. */
  private messagesTo(
    taskId: string,
    run: RunElsewhere,
    card: Followed,
  ): Array<LoggedMessage & { sending: boolean }> {
    // A worker that takes a follow-up may start a new run: messages to the host's earlier runs count too.
    const hosts = new Set(
      [...card.runs.values()]
        .filter(
          (one) =>
            one.account === run.account && one.device.id === run.device.id,
        )
        .map((one) => one.head.id),
    );
    const logged = [...card.messages.values()].filter((message) =>
      hosts.has(message.record.sessionId),
    );
    const known = new Set(logged.map((message) => message.record.id));
    const mine = this.outgoing
      .filter(
        (sent) =>
          sent.taskId === taskId &&
          hosts.has(sent.message.sessionId) &&
          !known.has(sent.message.id),
      )
      .map((sent) => ({
        record: sent.message,
        author: this.options.me,
        device: this.options.device,
        sending: this.waiting.some((entry) => entry.id === sent.waitingId),
      }));
    return [
      ...logged.map((message) => ({ ...message, sending: false })),
      ...mine,
    ];
  }

  /** A delivery counts only when the account that started the worker wrote it. */
  private deliveryOf(card: Followed, run: RunElsewhere, messageId: string) {
    return card.deliveries.get(messageId)?.get(run.account);
  }

  /** What the run waits for, from its own account's entries, with where an answer from here stands. */
  private inputsFor(
    taskId: string,
    run: RunElsewhere,
    card: Followed,
  ): WorkerInputRequest[] {
    const host = this.hostOf(run);
    const answers = this.messagesTo(taskId, run, card).filter(
      (message) => message.record.answer,
    );
    return [...card.inputs.values()].flatMap((byAccount) => {
      const input = byAccount.get(run.account);
      if (
        !input ||
        input.sessionId !== run.head.id ||
        input.status !== "pending"
      )
        return [];
      const answer = answers
        .filter((message) => message.record.answer!.inputId === input.id)
        .at(-1);
      const { sessionId, answerHere, ...shown } = input;
      return [
        {
          ...shown,
          taskId,
          runId: sessionId,
          harness: run.head.harness,
          elsewhere: answerHere
            ? {
                line: `Answer this on ${host.isYou ? "your" : `${host.name}'s`} ${host.device}`,
                answerable: false,
              }
            : answer
              ? answerStanding(
                  this.deliveryOf(card, run, answer.record.id),
                  host,
                  answer.sending,
                )
              : { answerable: true },
        } as WorkerInputRequest,
      ];
    });
  }

  private sessionFor(
    taskId: string,
    run: RunElsewhere,
    card: Followed,
  ): TeamSession {
    const owner = {
      // The window is given names, not account ids.
      memberId: fingerprint(["owner", run.account]).slice(0, 32),
      name: this.options.nameOf(run.account) ?? SOMEONE,
      deviceId: run.device.id,
      device: run.device.name,
    };
    // A person's turn in a run is by whoever started the run, on that computer.
    const turns = [...run.turns.values()].map((turn) =>
      turn.role === "user" ? { ...turn, actor: owner } : turn,
    );
    // A follow-up sent from another computer is by whoever sent it, wherever it stands.
    const host = this.hostOf(run);
    for (const sent of this.messagesTo(taskId, run, card)) {
      if (!sent.record.text) continue;
      const actor = this.actorOf(sent.author, sent.device);
      const delivered = turns.find((turn) => turn.id === sent.record.id);
      if (delivered) {
        delivered.actor = actor;
        continue;
      }
      turns.push({
        id: sent.record.id,
        role: "user",
        text: sent.record.text,
        at: sent.record.sentAt,
        actor,
        ...messageStanding(
          this.deliveryOf(card, run, sent.record.id),
          host,
          sent.sending,
        ),
      });
    }
    turns.sort((left, right) => left.at.localeCompare(right.at));
    return {
      ...(run.head as Omit<TeamSession, "messages">),
      storyId: taskId,
      epoch: 1,
      revision: run.entries,
      sequence: run.sequence,
      owner,
      updatedAt: run.updatedAt,
      messages: turns,
      ...(run.review ? { review: { ...run.review, taskId } } : {}),
      summaries: this.summariesOf(card),
    } as TeamSession;
  }

  /** The summary of every round of work on the card, by whoever ran it, oldest first. */
  private summariesOf(card: Followed): SharedSummary[] {
    return [...card.runs.values()]
      .flatMap((run) => {
        const { name, device } = this.hostOf(run);
        return [...run.summaries.values()].map((summary) => ({
          ...summary,
          by: name,
          device,
        }));
      })
      .sort((left, right) => left.at.localeCompare(right.at));
  }

  // ── Messages to workers (MemSync ADR-0015) ───────────────────────────────

  /** Sends a follow-up to the worker an open card shows from another computer. */
  messageWorker(taskId: string, text: string): Promise<string> {
    return this.sendToRun(taskId, { text });
  }

  /** Answers what the worker an open card shows from another computer waits for. */
  async answerWorker(
    taskId: string,
    inputId: string,
    response: WorkerInputResponse,
  ): Promise<string> {
    const input = this.options
      .state()
      .tasks.find((task) => task.id === taskId)
      ?.sharedInputs?.find((one) => one.id === inputId);
    if (!input?.elsewhere?.answerable)
      throw new Error(
        input?.elsewhere?.line ??
          "The worker is no longer waiting for this. Your answer was not sent.",
      );
    return this.sendToRun(taskId, { answer: { inputId, response } });
  }

  private async sendToRun(
    taskId: string,
    body: Pick<WorkerMessageRecord, "text" | "answer">,
  ): Promise<string> {
    await this.load();
    const card = this.followed.get(taskId);
    const run = card && !card.stopped ? this.latestRun(card) : undefined;
    if (!card || !run)
      throw new Error(
        "The worker this card shows is not known here yet. Open the card again and send it once more.",
      );
    if (run.account !== this.options.me)
      throw new Error(
        `Only ${this.hostOf(run).name} can continue this worker. Leave a comment on the card instead.`,
      );
    const message: WorkerMessageRecord = {
      id: randomUUID(),
      sessionId: run.head.id,
      sentAt: new Date().toISOString(),
      ...body,
    };
    await this.inTurn(async () => {
      const [waitingId] = this.queue(cardIdOf(taskId), {
        kind: "message",
        message,
      });
      this.outgoing.push({ taskId, message, waitingId });
      await this.keep();
    });
    this.show(taskId, card);
    this.send();
    return message.id;
  }

  /** Reads, for messages, the cards of the workers run here that can still be continued. */
  private host(): void {
    if (this.stopped) return;
    const now = Date.now();
    const asking = new Set(
      Object.values(this.handled)
        .filter((handled) => handled.state === "asking")
        .map((handled) => handled.taskId),
    );
    const wanted = new Set(
      this.tasksRunHere()
        .filter((task) => continuable(task, now) || asking.has(task.id))
        .map((task) => task.id),
    );
    for (const [taskId, reader] of this.hosting)
      if (!wanted.has(taskId)) {
        reader.stopped = true;
        reader.stream?.cancel();
        this.hosting.delete(taskId);
      }
    for (const taskId of wanted) {
      if (this.hosting.has(taskId)) continue;
      const reader: Reader = {
        cursor: this.hosted[taskId] ?? 0,
        stopped: false,
      };
      this.hosting.set(taskId, reader);
      reader.reading = this.readLog(taskId, reader, (entries) =>
        this.received(taskId, reader, entries),
      );
    }
  }

  private received(
    taskId: string,
    reader: Reader,
    entries: LoggedCardEntry[],
  ): void {
    const messages: Array<{ entry: CardEntry; logged: LoggedCardEntry }> = [];
    for (const logged of entries) {
      if (logged.sequence <= reader.cursor) continue;
      reader.cursor = logged.sequence;
      const read = readCardEntry(logged.payload);
      if (
        read.readable &&
        read.entry.kind === "message" &&
        read.entry.device.id !== this.options.device.id
      )
        messages.push({ entry: read.entry, logged });
    }
    const cursor = reader.cursor;
    void this.inTurn(async () => {
      if (this.stopped) return;
      for (const { entry, logged } of messages)
        await this.receive(taskId, entry, logged);
      this.hosted[taskId] = Math.max(this.hosted[taskId] ?? 0, cursor);
      await this.keep();
      this.send();
    }).catch((problem) =>
      console.error("A message to a worker was not taken in:", problem),
    );
  }

  /**
   * A message to a worker run here, from the account that started the worker:
   * the same person on another of their computers. It is carried out at once.
   * Nobody else continues a worker; a message in another's name is left alone.
   */
  private async receive(
    taskId: string,
    entry: CardEntry,
    logged: LoggedCardEntry,
  ): Promise<void> {
    if (entry.kind !== "message" || this.handled[entry.message.id]) return;
    if (logged.author !== this.options.me) return;
    const { message } = entry;
    const task = this.options
      .state()
      .tasks.find(
        (item) =>
          item.id === taskId && item.projectId === this.options.projectId,
      );
    const startedAt = task?.run.startedAt;
    // For the run here now, or an earlier one this computer wrote to this card. Not for another computer's.
    if (
      !startedAt ||
      (message.sessionId !==
        sessionIdOf(this.options.device.id, taskId, startedAt) &&
        !this.sent[message.sessionId])
    )
      return;
    const handled: Handled = {
      taskId,
      sessionId: message.sessionId,
      state: "asking",
      author: logged.author,
      device: entry.device,
      sentAt: message.sentAt,
      ...(message.text ? { text: message.text } : {}),
      ...(message.answer ? { answer: message.answer } : {}),
    };
    this.handled[message.id] = handled;
    await this.carryOut(message.id, handled);
    this.showAsks(taskId);
  }

  /** Hands a message to the worker, as if it was typed or answered here. */
  private async carryOut(messageId: string, handled: Handled): Promise<void> {
    const cardId = cardIdOf(handled.taskId);
    try {
      if (handled.answer) {
        if (!this.options.answer)
          throw new Error(
            "This computer cannot answer a worker for someone else.",
          );
        await this.options.answer(
          handled.taskId,
          handled.answer.inputId,
          handled.answer.response,
        );
        this.queue(cardId, this.delivery(messageId, handled, "picked-up"));
        return;
      }
      if (!this.options.deliver)
        throw new Error(
          "This computer cannot continue a worker for someone else.",
        );
      await this.options.deliver(handled.taskId, {
        id: messageId,
        role: "user",
        text: handled.text!,
        at: new Date().toISOString(),
        actor: this.actorOf(handled.author, handled.device),
        sourceCommandId: messageId,
      });
      this.queue(cardId, this.delivery(messageId, handled, "queued"));
    } catch (problem) {
      this.queue(
        cardId,
        this.delivery(
          messageId,
          handled,
          "failed",
          problem instanceof Error ? problem.message : String(problem),
        ),
      );
    }
  }

  /** The person here allows or declines a message someone else sent to a worker run here. */
  async decide(
    taskId: string,
    messageId: string,
    allow: boolean,
  ): Promise<void> {
    await this.load();
    await this.inTurn(async () => {
      const handled = this.handled[messageId];
      if (!handled || handled.taskId !== taskId || handled.state !== "asking")
        throw new Error("This message is no longer waiting for you.");
      if (allow) await this.carryOut(messageId, handled);
      else
        this.queue(
          cardIdOf(taskId),
          this.delivery(messageId, handled, "declined"),
        );
      this.showAsks(taskId);
      await this.keep();
    });
    this.send();
  }

  /** Puts the messages that wait for this person's word on their task. */
  private showAsks(taskId: string): void {
    const task = this.options
      .state()
      .tasks.find(
        (item) =>
          item.id === taskId && item.projectId === this.options.projectId,
      );
    if (!task) return;
    const inputs = this.options.state().workerInputs ?? [];
    const asks: SharedAsk[] = Object.entries(this.handled)
      .filter(
        ([, handled]) =>
          handled.taskId === taskId && handled.state === "asking",
      )
      .map(([id, handled]) => ({
        id,
        from: this.options.nameOf(handled.author) ?? SOMEONE,
        device: handled.device.name,
        kind: handled.answer ? ("answer" as const) : ("message" as const),
        text: handled.answer
          ? answerSummary(
              inputs.find((input) => input.id === handled.answer!.inputId),
              handled.answer.response,
            )
          : handled.text!,
        sentAt: handled.sentAt,
      }))
      .sort((left, right) => left.sentAt.localeCompare(right.sentAt));
    if (asks.length) task.sharedAsks = asks;
    else delete task.sharedAsks;
    this.options.shown();
  }

  // ── Small things ─────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    this.stopped = true;
    for (const reader of [
      ...this.followed.values(),
      ...this.hosting.values(),
    ]) {
      reader.stopped = true;
      reader.stream?.cancel();
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

/** A run here still continued by a message: one that runs, or that ended a little while ago. */
function continuable(task: WorkItem, now: number): boolean {
  if (["preparing", "running", "stopping", "blocked"].includes(task.run.state))
    return true;
  const ended = Date.parse(task.run.finishedAt ?? task.run.startedAt ?? "");
  return Number.isFinite(ended) && now - ended < CONTINUABLE_FOR_MS;
}
