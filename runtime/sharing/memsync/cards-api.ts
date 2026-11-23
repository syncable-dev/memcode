import type { LoggedUpdate, UpdateReceipt } from "./boards-api";
import {
  cardReaders,
  cardsCalls,
  cardsContract,
  cardsService,
  type CardReaders,
  type CardsCall,
} from "./cards-contract";
import type { GrpcStream } from "./grpc";
import type { ServiceCall, SignedCalls } from "./signed-calls";
import { WireError, type WireMessage } from "./wire";

/** One entry of a card's activity log, as its sender made it. The service never reads it. */
export interface NewCardEntry {
  /** A UUID the sender chooses. Sending the same id again to the same card adds nothing. */
  id: string;
  payload: Uint8Array;
  /** Everyone on the project, the default, or only the account that sends it. */
  readers?: CardReaders;
}
/** An entry as the log holds it: numbered, dated and signed by the service. */
export type LoggedCardEntry = LoggedUpdate;

/** A file the project keeps, by the SHA-256 of its bytes. */
export interface StoredFile {
  sha256: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
}

/** The activity logs of a project's cards, and the files they refer to. */
export interface CardsApi {
  /** Adds entries to the end of a card's log: at most 100, each at most 1 MiB. */
  append(
    projectId: string,
    cardId: string,
    entries: NewCardEntry[],
  ): Promise<UpdateReceipt[]>;
  /** The next page of a card's log after a number. An empty page: nothing newer. */
  readAfter(
    projectId: string,
    cardId: string,
    sequence: number,
  ): Promise<LoggedCardEntry[]>;
  /** Everything after a number, then each new entry as it is logged. */
  watchAfter(
    projectId: string,
    cardId: string,
    sequence: number,
    onEntry: (entry: LoggedCardEntry) => void | Promise<void>,
  ): GrpcStream;
  /** Keeps a file for the project: at most 5 MiB. Sending it again adds nothing. */
  upload(projectId: string, content: Uint8Array): Promise<StoredFile>;
  download(
    projectId: string,
    sha256: string,
  ): Promise<{ file: StoredFile; content: Uint8Array }>;
}

const unreadable = () =>
  new WireError("A card's log or file lacks something it always holds.");
const isMessage = (value: unknown): value is WireMessage =>
  !!value && typeof value === "object" && !Array.isArray(value);
const messages = (value: unknown) => (Array.isArray(value) ? value : []);
const sha256Shape = /^[0-9a-f]{64}$/;

function moment(value: unknown): string {
  if (!isMessage(value)) throw unreadable();
  const when = new Date(
    Number(value.seconds) * 1000 + Number(value.nanos) / 1e6,
  );
  if (Number.isNaN(when.getTime())) throw unreadable();
  return when.toISOString();
}

function receipt(sent: WireMessage): UpdateReceipt {
  if (!sent.id || !Number(sent.sequence)) throw unreadable();
  return {
    id: String(sent.id),
    sequence: Number(sent.sequence),
    loggedAt: moment(sent.logged_at),
  };
}

function logged(sent: WireMessage): LoggedCardEntry {
  if (!(sent.payload instanceof Uint8Array) || !sent.author_account_id)
    throw unreadable();
  return {
    ...receipt(sent),
    author: String(sent.author_account_id),
    payload: sent.payload,
  };
}

function stored(sent: unknown): StoredFile {
  if (!isMessage(sent) || !sha256Shape.test(String(sent.sha256)))
    throw unreadable();
  return {
    sha256: String(sent.sha256),
    size: Number(sent.size),
    uploadedBy: String(sent.uploaded_by_account_id),
    uploadedAt: moment(sent.uploaded_at),
  };
}

const call = (name: CardsCall): ServiceCall => ({
  service: cardsService,
  name,
  contract: cardsContract,
  ...cardsCalls[name],
});

/** The Cards API over gRPC, signed in with the caller's access token. */
export class MemsyncCards implements CardsApi {
  constructor(private readonly calls: SignedCalls) {}

  append(projectId: string, cardId: string, entries: NewCardEntry[]) {
    const request = {
      project_id: projectId,
      card_id: cardId,
      entries: entries.map(({ id, payload, readers = "everyone" }) => ({
        id,
        payload,
        readers: cardReaders[readers],
      })),
    };
    return this.calls.unary(call("AppendCardEntries"), request, (reply) =>
      messages(reply.receipts).map(receipt),
    );
  }
  readAfter(projectId: string, cardId: string, sequence: number) {
    const request = {
      project_id: projectId,
      card_id: cardId,
      after_sequence: sequence,
    };
    return this.calls.unary(call("ReadCardEntries"), request, (reply) =>
      messages(reply.entries).map(logged),
    );
  }
  watchAfter(
    projectId: string,
    cardId: string,
    sequence: number,
    onEntry: (entry: LoggedCardEntry) => void | Promise<void>,
  ) {
    const request = {
      project_id: projectId,
      card_id: cardId,
      after_sequence: sequence,
    };
    return this.calls.stream(call("WatchCardEntries"), request, (entry) =>
      onEntry(logged(entry)),
    );
  }
  upload(projectId: string, content: Uint8Array) {
    const request = { project_id: projectId, content };
    return this.calls.unary(call("UploadFile"), request, stored);
  }
  download(projectId: string, sha256: string) {
    const request = { project_id: projectId, sha256 };
    return this.calls.unary(call("DownloadFile"), request, (reply) => {
      if (!(reply.content instanceof Uint8Array)) throw unreadable();
      return { file: stored(reply.file), content: reply.content };
    });
  }
}
