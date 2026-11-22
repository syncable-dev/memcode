import { createHash } from "node:crypto";
import type { ServerHttp2Stream } from "node:http2";
import {
  cardsCalls,
  cardsContract,
} from "../../runtime/sharing/memsync/cards-contract";
import {
  decodeMessage,
  encodeMessage,
  type WireMessage,
} from "../../runtime/sharing/memsync/wire";
import type { StandInPerson } from "./memsync-stand-in";

interface Entry {
  id: string;
  sequence: number;
  loggedAt: number;
  author: string;
  payload: Uint8Array;
}
interface KeptFile {
  sha256: string;
  content: Uint8Array;
  uploadedBy: string;
  uploadedAt: number;
}
type CardRule =
  | "no_such_project"
  | "invalid_card_id"
  | "invalid_update_id"
  | "empty_update"
  | "update_too_large"
  | "too_many_updates"
  | "file_too_large"
  | "project_storage_full"
  | "no_such_file";
interface Watcher {
  project: string;
  card: string;
  person: StandInPerson;
  after: number;
  stream: ServerHttp2Stream;
}

const MOST_ENTRIES = 100,
  LARGEST_ENTRY = 1024 * 1024,
  LARGEST_FILE = 5 * 1024 * 1024,
  MOST_FILE_BYTES = 50 * 1024 * 1024,
  PAGE = 50,
  UNAVAILABLE = 14;
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
const logged = (entry: Entry): WireMessage => ({
  id: entry.id,
  sequence: entry.sequence,
  logged_at: moment(entry.loggedAt),
  author_account_id: entry.author,
  payload: entry.payload,
});
const storedFile = (file: KeptFile): WireMessage => ({
  sha256: file.sha256,
  size: file.content.length,
  uploaded_by_account_id: file.uploadedBy,
  uploaded_at: moment(file.uploadedAt),
});

/**
 * MemSync's Cards service, kept in memory with the rules of ADR-0014: a log per
 * card that works like the board log, and files per project by SHA-256.
 */
export function standInCards(the: {
  isOnProject(project: string, person: StandInPerson): boolean;
  now(): number;
  refuse(rule: CardRule): never;
}) {
  const logs = new Map<string, Entry[]>();
  const files = new Map<string, Map<string, KeptFile>>();
  const watchers = new Set<Watcher>();
  const calls: Array<{ method: string; card?: string }> = [];
  const logOf = (project: string, card: string) => {
    const key = `${project}/${card}`;
    if (!logs.has(key)) logs.set(key, []);
    return logs.get(key)!;
  };
  const filesOf = (project: string) => {
    if (!files.has(project)) files.set(project, new Map());
    return files.get(project)!;
  };
  const allowed = (project: unknown, person: StandInPerson) =>
    the.isOnProject(String(project), person)
      ? String(project)
      : the.refuse("no_such_project");
  const cardOf = (card: unknown) =>
    uuid.test(String(card))
      ? String(card).toLowerCase()
      : the.refuse("invalid_card_id");

  function feed(watcher: Watcher) {
    if (!the.isOnProject(watcher.project, watcher.person)) {
      watchers.delete(watcher);
      return void watcher.stream.end();
    }
    for (const entry of logOf(watcher.project, watcher.card))
      if (entry.sequence > watcher.after) {
        watcher.stream.write(
          framed(encodeMessage(cardsContract, "CardEntry", logged(entry))),
        );
        watcher.after = entry.sequence;
      }
  }

  function append(request: WireMessage, caller: StandInPerson): WireMessage {
    const project = allowed(request.project_id, caller),
      card = cardOf(request.card_id);
    const sent = (request.entries ?? []) as WireMessage[];
    if (sent.length > MOST_ENTRIES) the.refuse("too_many_updates");
    for (const entry of sent) {
      if (!uuid.test(String(entry.id))) the.refuse("invalid_update_id");
      const payload = entry.payload as Uint8Array;
      if (!payload?.length) the.refuse("empty_update");
      if (payload.length > LARGEST_ENTRY) the.refuse("update_too_large");
    }
    const log = logOf(project, card);
    const at = Math.max(the.now(), log.at(-1)?.loggedAt ?? 0);
    const receipts = sent.map((entry) => {
      const id = String(entry.id).toLowerCase();
      let kept = log.find((known) => known.id === id);
      if (!kept) {
        kept = {
          id,
          sequence: log.length + 1,
          loggedAt: at,
          author: caller.accountId,
          payload: entry.payload as Uint8Array,
        };
        log.push(kept);
      }
      return {
        id: kept.id,
        sequence: kept.sequence,
        logged_at: moment(kept.loggedAt),
      };
    });
    for (const watcher of watchers)
      if (watcher.project === project && watcher.card === card) feed(watcher);
    return { receipts };
  }

  function read(request: WireMessage, caller: StandInPerson): WireMessage {
    const log = logOf(
      allowed(request.project_id, caller),
      cardOf(request.card_id),
    );
    const after = Number(request.after_sequence);
    return {
      entries: log
        .filter((entry) => entry.sequence > after)
        .slice(0, PAGE)
        .map(logged),
    };
  }

  function upload(request: WireMessage, caller: StandInPerson): WireMessage {
    const project = allowed(request.project_id, caller);
    // An empty file is kept like any other, as MemSync keeps it.
    const content =
      (request.content as Uint8Array | undefined) ?? new Uint8Array();
    if (content.length > LARGEST_FILE) the.refuse("file_too_large");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const kept = filesOf(project);
    const known = kept.get(sha256);
    if (known) return storedFile(known);
    const used = [...kept.values()].reduce(
      (sum, file) => sum + file.content.length,
      0,
    );
    if (used + content.length > MOST_FILE_BYTES)
      the.refuse("project_storage_full");
    const file: KeptFile = {
      sha256,
      content,
      uploadedBy: caller.accountId,
      uploadedAt: the.now(),
    };
    kept.set(sha256, file);
    return storedFile(file);
  }

  function download(request: WireMessage, caller: StandInPerson): WireMessage {
    const project = allowed(request.project_id, caller);
    const file =
      filesOf(project).get(String(request.sha256)) ??
      the.refuse("no_such_file");
    return { file: storedFile(file), content: file.content };
  }

  function watch(
    stream: ServerHttp2Stream,
    request: WireMessage,
    caller: StandInPerson,
  ) {
    const watcher: Watcher = {
      project: allowed(request.project_id, caller),
      card: cardOf(request.card_id),
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
          : { "grpc-status": "5", "memsync-refusal": "no_such_project" },
      ),
    );
    stream.on("close", () => watchers.delete(watcher));
    watchers.add(watcher);
    feed(watcher);
  }

  return {
    calls,
    /** Answers one Cards call. A refusal is thrown before anything is sent. */
    answer(
      stream: ServerHttp2Stream,
      method: keyof typeof cardsCalls,
      caller: StandInPerson,
      body: Buffer,
    ) {
      const call = cardsCalls[method];
      const request = decodeMessage(
        cardsContract,
        call.request,
        body.subarray(5),
      );
      calls.push({ method, card: request.card_id as string | undefined });
      if (method === "WatchCardEntries") return watch(stream, request, caller);
      const reply =
        method === "AppendCardEntries"
          ? append(request, caller)
          : method === "ReadCardEntries"
            ? read(request, caller)
            : method === "UploadFile"
              ? upload(request, caller)
              : download(request, caller);
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () =>
        stream.sendTrailers({ "grpc-status": "0" }),
      );
      stream.end(framed(encodeMessage(cardsContract, call.reply, reply)));
    },
    /** A card's log as it stands. */
    log: (project: string, card: string) => [...logOf(project, card)],
    /** Adds an entry as someone on the project would, bypassing any client. */
    write(project: string, card: string, author: string, payload: Uint8Array) {
      const log = logOf(project, card);
      log.push({
        id: crypto.randomUUID(),
        sequence: log.length + 1,
        loggedAt: Math.max(the.now(), log.at(-1)?.loggedAt ?? 0),
        author,
        payload,
      });
      for (const watcher of watchers)
        if (watcher.project === project && watcher.card === card) feed(watcher);
    },
    files: (project: string) => [...filesOf(project).values()],
    get watching() {
      return watchers.size;
    },
    /** Ends every watcher's stream with UNAVAILABLE, as MemSync does when it stops. */
    cutWatchers() {
      for (const watcher of [...watchers]) watcher.stream.end();
    },
    recheckWatchers() {
      watchers.forEach(feed);
    },
    forget(project: string) {
      for (const key of [...logs.keys()])
        if (key.startsWith(`${project}/`)) logs.delete(key);
      files.delete(project);
    },
  };
}
