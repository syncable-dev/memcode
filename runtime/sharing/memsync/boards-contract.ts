import type { Contract } from "./wire";

/**
 * boards.proto, written out by hand. A test reads the .proto file beside this one
 * and fails when the two disagree.
 */
const text = (number: number) => ({ number, kind: "string" }) as const;
const bytes = (number: number) => ({ number, kind: "bytes" }) as const;
const count = (number: number) => ({ number, kind: "uint64" }) as const;
const moment = "google.protobuf.Timestamp";
const loggedAt = (number: number) =>
  ({ number, kind: { message: moment } }) as const;
const many = (number: number, message: string) =>
  ({ number, kind: { message }, repeated: true }) as const;

export const boardsService = "memsync.v1.Boards";

export const boardsContract = {
  [moment]: {
    seconds: { number: 1, kind: "int64" },
    nanos: { number: 2, kind: "int32" },
  },
  NewBoardUpdate: { id: text(1), payload: bytes(2) },
  BoardUpdate: {
    id: text(1),
    sequence: count(2),
    logged_at: loggedAt(3),
    author_account_id: text(4),
    payload: bytes(5),
  },
  UpdateReceipt: { id: text(1), sequence: count(2), logged_at: loggedAt(3) },
  AppendUpdatesRequest: {
    project_id: text(1),
    updates: many(2, "NewBoardUpdate"),
  },
  AppendUpdatesResponse: { receipts: many(1, "UpdateReceipt") },
  ReadUpdatesRequest: { project_id: text(1), after_sequence: count(2) },
  ReadUpdatesResponse: { updates: many(1, "BoardUpdate") },
  WatchUpdatesRequest: { project_id: text(1), after_sequence: count(2) },
} satisfies Contract;

export const boardsCalls = {
  AppendUpdates: {
    request: "AppendUpdatesRequest",
    reply: "AppendUpdatesResponse",
  },
  ReadUpdates: { request: "ReadUpdatesRequest", reply: "ReadUpdatesResponse" },
  /** The reply is a stream of these, one per update. */
  WatchUpdates: { request: "WatchUpdatesRequest", reply: "BoardUpdate" },
} as const;
export type BoardsCall = keyof typeof boardsCalls;
