import {
  boardsCalls,
  boardsContract,
  boardsService,
  type BoardsCall,
} from "./boards-contract";
import type { GrpcStream } from "./grpc";
import type { ServiceCall, SignedCalls } from "./signed-calls";
import { WireError, type WireMessage } from "./wire";

/** One change to a board, as its sender made it. The service never reads the bytes. */
export interface NewBoardUpdate {
  /** A UUID the sender chooses. Sending the same id again adds nothing. */
  id: string;
  payload: Uint8Array;
}
export interface UpdateReceipt {
  id: string;
  /** Its place in the project's log, from 1 with no gaps. */
  sequence: number;
  loggedAt: string;
}
export interface LoggedUpdate extends UpdateReceipt {
  /** The account that sent it. */
  author: string;
  payload: Uint8Array;
}

/** A project's board log at the sharing service. */
export interface BoardsApi {
  /** Adds updates to the end of the log: at most 100, each at most 1 MiB. */
  append(
    projectId: string,
    updates: NewBoardUpdate[],
  ): Promise<UpdateReceipt[]>;
  /** The next page after a number, oldest first. An empty page: nothing newer. */
  readAfter(projectId: string, sequence: number): Promise<LoggedUpdate[]>;
  /** Everything after a number, then each new update as it is logged. */
  watchAfter(
    projectId: string,
    sequence: number,
    onUpdate: (update: LoggedUpdate) => void | Promise<void>,
  ): GrpcStream;
}

const unreadable = () =>
  new WireError("A board update lacks something it always holds.");
const isMessage = (value: unknown): value is WireMessage =>
  !!value && typeof value === "object" && !Array.isArray(value);
const messages = (value: unknown) => (Array.isArray(value) ? value : []);

function receipt(sent: WireMessage): UpdateReceipt {
  const when = sent.logged_at;
  if (!sent.id || !Number(sent.sequence) || !isMessage(when))
    throw unreadable();
  const loggedAt = new Date(
    Number(when.seconds) * 1000 + Number(when.nanos) / 1e6,
  );
  if (Number.isNaN(loggedAt.getTime())) throw unreadable();
  return {
    id: String(sent.id),
    sequence: Number(sent.sequence),
    loggedAt: loggedAt.toISOString(),
  };
}

function logged(sent: WireMessage): LoggedUpdate {
  if (!(sent.payload instanceof Uint8Array)) throw unreadable();
  return {
    ...receipt(sent),
    author: String(sent.author_account_id),
    payload: sent.payload,
  };
}

const call = (name: BoardsCall): ServiceCall => ({
  service: boardsService,
  name,
  contract: boardsContract,
  ...boardsCalls[name],
});

/** The Boards API over gRPC, signed in with the caller's access token. */
export class MemsyncBoards implements BoardsApi {
  constructor(private readonly calls: SignedCalls) {}

  append(projectId: string, updates: NewBoardUpdate[]) {
    const request = {
      project_id: projectId,
      updates: updates.map(({ id, payload }) => ({ id, payload })),
    };
    return this.calls.unary(call("AppendUpdates"), request, (reply) =>
      messages(reply.receipts).map(receipt),
    );
  }
  readAfter(projectId: string, sequence: number) {
    const request = { project_id: projectId, after_sequence: sequence };
    return this.calls.unary(call("ReadUpdates"), request, (reply) =>
      messages(reply.updates).map(logged),
    );
  }
  watchAfter(
    projectId: string,
    sequence: number,
    onUpdate: (update: LoggedUpdate) => void | Promise<void>,
  ) {
    const request = { project_id: projectId, after_sequence: sequence };
    return this.calls.stream(call("WatchUpdates"), request, (update) =>
      onUpdate(logged(update)),
    );
  }
}
