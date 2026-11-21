import type { ServerHttp2Stream } from "node:http2";
import {
  boardsCalls,
  boardsContract,
} from "../../runtime/sharing/memsync/boards-contract";
import {
  decodeMessage,
  encodeMessage,
  type WireMessage,
} from "../../runtime/sharing/memsync/wire";
import type { StandInPerson } from "./memsync-stand-in";

export interface StandInLoggedUpdate {
  id: string;
  sequence: number;
  loggedAt: number;
  author: string;
  payload: Uint8Array;
}
type BoardRule =
  | "no_such_project"
  | "invalid_update_id"
  | "empty_update"
  | "update_too_large"
  | "too_many_updates";
interface Watcher {
  project: string;
  person: StandInPerson;
  after: number;
  stream: ServerHttp2Stream;
}

const MAX_UPDATES_PER_CALL = 100,
  MAX_UPDATE_BYTES = 1024 * 1024,
  PAGE = 50;
const UNAVAILABLE = 14;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const framed = (message: Uint8Array) => {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt32BE(message.length, 1);
  frame.set(message, 5);
  return frame;
};
const moment = (ms: number) => ({
  seconds: Math.floor(ms / 1000),
  nanos: (ms % 1000) * 1e6,
});
const logged = (update: StandInLoggedUpdate): WireMessage => ({
  id: update.id,
  sequence: update.sequence,
  logged_at: moment(update.loggedAt),
  author_account_id: update.author,
  payload: update.payload,
});

/**
 * MemSync's board logs, kept in memory with its rules: every update numbered
 * and dated once, an id never logged twice, and a watcher fed what is new.
 */
export function standInBoardLogs(the: {
  isOnProject(project: string, person: StandInPerson): boolean;
  now(): number;
  refuse(rule: BoardRule): never;
}) {
  const logs = new Map<string, StandInLoggedUpdate[]>();
  const watchers = new Set<Watcher>();
  let loseNextReceipts = false;
  const logOf = (project: string) => {
    if (!logs.has(project)) logs.set(project, []);
    return logs.get(project)!;
  };
  const allowed = (project: unknown, person: StandInPerson) =>
    the.isOnProject(String(project), person)
      ? String(project)
      : the.refuse("no_such_project");

  function feed(watcher: Watcher) {
    if (!the.isOnProject(watcher.project, watcher.person)) {
      watchers.delete(watcher);
      return void watcher.stream.end();
    }
    for (const update of logOf(watcher.project))
      if (update.sequence > watcher.after) {
        watcher.stream.write(
          framed(encodeMessage(boardsContract, "BoardUpdate", logged(update))),
        );
        watcher.after = update.sequence;
      }
  }

  function append(request: WireMessage, caller: StandInPerson): WireMessage {
    const sent = request.updates as WireMessage[];
    if (sent.length > MAX_UPDATES_PER_CALL) the.refuse("too_many_updates");
    for (const update of sent) {
      if (!uuid.test(String(update.id))) the.refuse("invalid_update_id");
      const payload = update.payload as Uint8Array;
      if (!payload.length) the.refuse("empty_update");
      if (payload.length > MAX_UPDATE_BYTES) the.refuse("update_too_large");
    }
    const log = logOf(allowed(request.project_id, caller));
    // Updates sent in one call share a time, never earlier than the entry before.
    const at = Math.max(the.now(), log.at(-1)?.loggedAt ?? 0);
    const receipts = sent.map((update) => {
      const id = String(update.id).toLowerCase();
      let entry = log.find((known) => known.id === id);
      if (!entry) {
        entry = {
          id,
          sequence: log.length + 1,
          loggedAt: at,
          author: caller.accountId,
          payload: update.payload as Uint8Array,
        };
        log.push(entry);
      }
      return {
        id: entry.id,
        sequence: entry.sequence,
        logged_at: moment(entry.loggedAt),
      };
    });
    watchers.forEach(feed);
    return { receipts };
  }

  function read(request: WireMessage, caller: StandInPerson): WireMessage {
    const log = logOf(allowed(request.project_id, caller));
    const after = Number(request.after_sequence);
    return {
      updates: log
        .filter((update) => update.sequence > after)
        .slice(0, PAGE)
        .map(logged),
    };
  }

  function watch(
    stream: ServerHttp2Stream,
    request: WireMessage,
    caller: StandInPerson,
  ) {
    const watcher: Watcher = {
      project: allowed(request.project_id, caller),
      person: caller,
      after: Number(request.after_sequence),
      stream,
    };
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () =>
      stream.sendTrailers(
        the.isOnProject(watcher.project, caller)
          ? { "grpc-status": String(UNAVAILABLE) }
          : {
              "grpc-status": "5",
              "memsync-refusal": "no_such_project",
            },
      ),
    );
    stream.on("close", () => watchers.delete(watcher));
    watchers.add(watcher);
    feed(watcher);
  }

  return {
    /** Answers one Boards call. A refusal is thrown before anything is sent. */
    answer(
      stream: ServerHttp2Stream,
      method: keyof typeof boardsCalls,
      caller: StandInPerson,
      body: Buffer,
    ) {
      const call = boardsCalls[method];
      const request = decodeMessage(
        boardsContract,
        call.request,
        body.subarray(5),
      );
      if (method === "WatchUpdates") return watch(stream, request, caller);
      const reply =
        method === "AppendUpdates"
          ? append(request, caller)
          : read(request, caller);
      if (method === "AppendUpdates" && loseNextReceipts) {
        // Logged, and the answer never arrives.
        loseNextReceipts = false;
        return void stream.close();
      }
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () =>
        stream.sendTrailers({ "grpc-status": "0" }),
      );
      stream.end(framed(encodeMessage(boardsContract, call.reply, reply)));
    },
    /** A project's log as it stands. */
    log: (project: string) => [...logOf(project)],
    /** What is kept for an entry is no longer what was sent, as after a fault in storage. */
    damage(project: string, sequence: number, payload: Uint8Array) {
      logOf(project)[sequence - 1].payload = payload;
    },
    loseNextReceipts() {
      loseNextReceipts = true;
    },
    /** Ends every watcher's stream, as a proxy that drops quiet connections does. */
    cutWatchers() {
      for (const watcher of [...watchers]) watcher.stream.end();
    },
    /** Looks again at who may watch, as MemSync does every ten seconds. */
    recheckWatchers() {
      watchers.forEach(feed);
    },
    get watching() {
      return watchers.size;
    },
    forget(project: string) {
      logs.delete(project);
    },
  };
}
