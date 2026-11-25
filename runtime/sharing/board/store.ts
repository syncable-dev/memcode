import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceWorkspace } from "../../persistence";
import { collections, newerOf, withNewerOf, withoutNewer, type Board } from "./document";
import type { NotApplied } from "./updates";

/** A change this computer made that is not in the log yet. */
export interface UnsentUpdate {
  id: string;
  payload: Uint8Array;
}
/** A log entry that was not applied. `failed`: it read as an update and could not be applied. */
export interface LeftOutUpdate {
  sequence: number;
  id: string;
  author: string;
  loggedAt: string;
  reason: NotApplied | "failed";
}
/** What one connected project keeps beside the workspace file. */
export interface KeptBoard {
  /** The number of the last log entry dealt with. */
  cursor: number;
  /**
   * How many times the log has changed the workspace file. The workspace holds
   * the same number, which is how a save that was cut off is told apart.
   */
  applied: number;
  /** Whether the board here and the board in the log have been brought together. */
  joined: boolean;
  /** The board as this computer last wrote or took it. Its own changes are told from this. */
  seen: Board;
  unsent: UnsentUpdate[];
  leftOut: LeftOutUpdate[];
  /** The number of the log entry that made each task. It decides who keeps an identifier two tasks share. */
  arrived: Record<string, number>;
  /** The document as the log has built it. */
  log: Uint8Array;
  /** An older MemCode kept it last: what it does not know has still to be read from the document. */
  newerUnread?: boolean;
}
/** A save. Leaving `log` out says the document is as it was last saved. */
export type BoardToKeep = Omit<KeptBoard, "log"> & { log?: Uint8Array };

const VERSION = 1;
const STATE = "sync.json",
  LOG = "log.bin",
  NEXT = ".next";

const digestOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const isMissing = (problem: unknown) =>
  (problem as NodeJS.ErrnoException).code === "ENOENT";

interface StateFile {
  version: number;
  cursor: number;
  applied: number;
  joined: boolean;
  seen: Board;
  /** What of it an older MemCode does not know. It drops this when it keeps the board. */
  newer?: Board;
  unsent: Array<{ id: string; payload: string }>;
  leftOut: LeftOutUpdate[];
  arrived?: Record<string, number>;
  log: { bytes: number; sha256: string };
}

function isStateFile(read: unknown): read is StateFile {
  const file = read as StateFile | null;
  return (
    !!file &&
    typeof file === "object" &&
    file.version === VERSION &&
    Number.isSafeInteger(file.cursor) &&
    Number.isSafeInteger(file.applied) &&
    typeof file.joined === "boolean" &&
    !!file.seen &&
    collections.every(
      (name) => file.seen[name] && typeof file.seen[name] === "object",
    ) &&
    Array.isArray(file.unsent) &&
    file.unsent.every(
      (update) =>
        typeof update?.id === "string" && typeof update.payload === "string",
    ) &&
    Array.isArray(file.leftOut) &&
    typeof file.log?.sha256 === "string"
  );
}

/**
 * Where one connected project's sync state is kept: a folder with the document
 * the log has built and everything else in one file.
 *
 * A save is written beside what is there and then put in its place. When the
 * workspace file has to change with it, the workspace is saved between the two
 * steps, so after a crash the pair is either both old or both new.
 */
export class BoardStore {
  private logDigest = digestOf(new Uint8Array());
  private logBytes = 0;
  constructor(private readonly folder: string) {}

  private path(name: string) {
    return join(this.folder, name);
  }
  private async read(name: string): Promise<StateFile | undefined> {
    try {
      const read: unknown = JSON.parse(await readFile(this.path(name), "utf8"));
      const seen = (read as Partial<StateFile> | null)?.seen;
      // A MemCode from before boards said who keeps them in step with a tracker knows none.
      if (seen && typeof seen === "object") seen.trackers ??= {};
      return isStateFile(read) ? read : undefined;
    } catch (problem) {
      if (isMissing(problem) || problem instanceof SyntaxError)
        return undefined;
      throw problem;
    }
  }
  private drop(...names: string[]) {
    return Promise.all(
      names.map((name) => rm(this.path(name), { force: true })),
    );
  }

  /**
   * What was kept, or nothing when there is nothing this workspace can use.
   * `workspaceAt` is the number the workspace file holds.
   */
  async load(workspaceAt: number): Promise<KeptBoard | undefined> {
    const waiting = await this.read(STATE + NEXT);
    // A save that waited for the workspace counts only if the workspace got there.
    if (waiting?.applied === workspaceAt) await this.commit();
    else await this.drop(STATE + NEXT, LOG + NEXT);
    const file = await this.read(STATE);
    if (!file || file.applied !== workspaceAt) return undefined;
    let log: Uint8Array;
    try {
      log = await readFile(this.path(LOG));
    } catch (problem) {
      if (!isMissing(problem)) throw problem;
      log = new Uint8Array();
    }
    // A document that is not the one that was saved would quietly lose the board.
    if (log.length !== file.log.bytes || digestOf(log) !== file.log.sha256)
      return undefined;
    this.logDigest = file.log.sha256;
    this.logBytes = file.log.bytes;
    return {
      cursor: file.cursor,
      applied: file.applied,
      joined: file.joined,
      seen: file.newer ? withNewerOf(file.seen, file.newer) : file.seen,
      ...(file.newer ? {} : { newerUnread: true }),
      unsent: file.unsent.map((update) => ({
        id: update.id,
        payload: Buffer.from(update.payload, "base64"),
      })),
      leftOut: file.leftOut,
      arrived: file.arrived ?? {},
      log,
    };
  }

  /** Writes a save beside what is kept. It counts once `commit` has put it in place. */
  async prepare(kept: BoardToKeep): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    if (kept.log) {
      await writeFile(this.path(LOG + NEXT), kept.log);
      this.logDigest = digestOf(kept.log);
      this.logBytes = kept.log.length;
    } else await this.drop(LOG + NEXT);
    const file: StateFile = {
      version: VERSION,
      cursor: kept.cursor,
      applied: kept.applied,
      joined: kept.joined,
      seen: withoutNewer(kept.seen),
      ...(kept.newerUnread ? {} : { newer: newerOf(kept.seen) }),
      unsent: kept.unsent.map((update) => ({
        id: update.id,
        payload: Buffer.from(update.payload).toString("base64"),
      })),
      leftOut: kept.leftOut,
      arrived: kept.arrived,
      log: { bytes: this.logBytes, sha256: this.logDigest },
    };
    await writeFile(this.path(STATE + NEXT), JSON.stringify(file), "utf8");
  }

  /** Puts the prepared save in place: the document first, then the file that describes it. */
  async commit(): Promise<void> {
    try {
      await replaceWorkspace(this.path(LOG + NEXT), this.path(LOG));
    } catch (problem) {
      // No new document: this save left it as it was, or it is already in place.
      if (!isMissing(problem)) throw problem;
    }
    await replaceWorkspace(this.path(STATE + NEXT), this.path(STATE));
  }

  async save(kept: BoardToKeep): Promise<void> {
    await this.prepare(kept);
    await this.commit();
  }

  /** Forgets everything kept for this project. */
  remove(): Promise<void> {
    return rm(this.folder, { recursive: true, force: true });
  }
}
