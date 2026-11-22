import type { Contract } from "./wire";

/**
 * cards.proto, written out by hand. A test reads the .proto file beside this one
 * and fails when the two disagree. `UpdateReceipt` comes from boards.proto.
 */
const text = (number: number) => ({ number, kind: "string" }) as const;
const bytes = (number: number) => ({ number, kind: "bytes" }) as const;
const count = (number: number) => ({ number, kind: "uint64" }) as const;
const moment = "google.protobuf.Timestamp";
const at = (number: number) => ({ number, kind: { message: moment } }) as const;
const one = (number: number, message: string) =>
  ({ number, kind: { message } }) as const;
const many = (number: number, message: string) =>
  ({ number, kind: { message }, repeated: true }) as const;

export const cardsService = "memsync.v1.Cards";

export const cardsContract = {
  [moment]: {
    seconds: { number: 1, kind: "int64" },
    nanos: { number: 2, kind: "int32" },
  },
  UpdateReceipt: { id: text(1), sequence: count(2), logged_at: at(3) },
  NewCardEntry: { id: text(1), payload: bytes(2) },
  CardEntry: {
    id: text(1),
    sequence: count(2),
    logged_at: at(3),
    author_account_id: text(4),
    payload: bytes(5),
  },
  AppendCardEntriesRequest: {
    project_id: text(1),
    card_id: text(2),
    entries: many(3, "NewCardEntry"),
  },
  AppendCardEntriesResponse: { receipts: many(1, "UpdateReceipt") },
  ReadCardEntriesRequest: {
    project_id: text(1),
    card_id: text(2),
    after_sequence: count(3),
  },
  ReadCardEntriesResponse: { entries: many(1, "CardEntry") },
  WatchCardEntriesRequest: {
    project_id: text(1),
    card_id: text(2),
    after_sequence: count(3),
  },
  UploadFileRequest: { project_id: text(1), content: bytes(2) },
  StoredFile: {
    sha256: text(1),
    size: count(2),
    uploaded_by_account_id: text(3),
    uploaded_at: at(4),
  },
  DownloadFileRequest: { project_id: text(1), sha256: text(2) },
  DownloadFileResponse: { file: one(1, "StoredFile"), content: bytes(2) },
} satisfies Contract;

export const cardsCalls = {
  AppendCardEntries: {
    request: "AppendCardEntriesRequest",
    reply: "AppendCardEntriesResponse",
  },
  ReadCardEntries: {
    request: "ReadCardEntriesRequest",
    reply: "ReadCardEntriesResponse",
  },
  /** The reply is a stream of these, one per entry. */
  WatchCardEntries: { request: "WatchCardEntriesRequest", reply: "CardEntry" },
  UploadFile: { request: "UploadFileRequest", reply: "StoredFile" },
  DownloadFile: {
    request: "DownloadFileRequest",
    reply: "DownloadFileResponse",
  },
} as const;
export type CardsCall = keyof typeof cardsCalls;

/** A message of this service is at most this large, a whole file included. */
export const LARGEST_CARDS_MESSAGE = 6 * 1024 * 1024;
