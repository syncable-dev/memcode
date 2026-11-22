import { createHash } from "node:crypto";
import { z } from "zod";
import type { Message } from "../../../src/shared";
import type { StoryReviewRun } from "../../../src/code-review";
import { sessionPayload } from "../../team/session-protocol";
import { LARGEST_UPDATE } from "../board/document";

/**
 * What MemCode writes into a card's activity log at the sharing service
 * (MemSync ADR-0014). MemSync never reads an entry; this file is the format.
 *
 * Three kinds of entry, each with the computer that wrote it:
 * - `session`: one worker run on that computer, as Team Sync shares it: its
 *   state, what it is doing, its models, and the person's and the worker's
 *   turns of the conversation. An entry holds the run's latest state and the
 *   turns that are new or changed since the run's last entry.
 * - `review`: the code review report of that run.
 * - `result`: a file someone shared from the card, kept at the service by its
 *   SHA-256.
 */

export const CARD_FORMAT = "memcode-card",
  CARD_VERSION = 1;

/** One worker run, or the part of it that is new since its last entry. */
export type SessionPart = z.infer<typeof sessionPart>;
/** A file shared from a card. The bytes are kept at the service by `sha256`. */
export type SharedResultRecord = z.infer<typeof resultRecord>;
export type CardRecord =
  | { kind: "session"; session: SessionPart }
  | { kind: "review"; sessionId: string; review: StoryReviewRun }
  | { kind: "result"; result: SharedResultRecord };
export interface WritingDevice {
  id: string;
  /** "Mac", "Windows" or "Linux", as Team Sync names a device. Never a host name. */
  name: string;
}
export type CardEntry = CardRecord & { device: WritingDevice };

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const device = z
  .object({
    id: uuid,
    name: z.enum(["Mac", "Windows", "Linux"]),
  })
  .strict();
// The session as Team Sync shares it, without the ids only its relay uses.
const sessionPart = sessionPayload
  .omit({ storyId: true, epoch: true, review: true })
  .extend({ id: uuid })
  .strict();
const reviewShape = sessionPayload.shape.review.unwrap();
const resultRecord = z
  .object({
    id: uuid,
    name: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine(
        (name) =>
          !/[\\/:\x00-\x1f]/.test(name) && name !== "." && name !== "..",
        "Use a filename, not a local path.",
      ),
    mime: z
      .string()
      .regex(/^[\w.+-]+\/[\w.+-]+$/)
      .max(100),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z
      .number()
      .int()
      .min(1)
      .max(5 * 1024 * 1024),
    kind: z.enum(["report", "artifact", "patch"]),
    description: z.string().max(2000).optional(),
  })
  .strict();
const envelope = {
  format: z.literal(CARD_FORMAT),
  version: z.literal(CARD_VERSION),
  device,
};
const entryShape = z.discriminatedUnion("kind", [
  z
    .object({ ...envelope, kind: z.literal("session"), session: sessionPart })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("review"),
      sessionId: uuid,
      review: reviewShape,
    })
    .strict(),
  z
    .object({ ...envelope, kind: z.literal("result"), result: resultRecord })
    .strict(),
]);

/** A local path or a credential never leaves this computer in a shared text. */
export const publicText = (value: string) =>
  value
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "<redacted-token>",
    )
    .replace(
      /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s]+|\/Users\/[^/\s]+|\/home\/[^/\s]+)/g,
      "<local-home>",
    );

/** The longest turn the shared format holds. Team Sync holds the same. */
const LONGEST_TURN = 100_000,
  CUT = "\n\n[The rest of this turn was too long to share.]";

/** A turn of the conversation as it may be shared: no local references, no review notes. */
export function publicMessage(message: Message): Message {
  const {
    id,
    role,
    at,
    streamId,
    promptedAt,
    pickedUpAt,
    queuedAt,
    queueOrder,
    followupState,
  } = message;
  return Object.fromEntries(
    Object.entries({
      id,
      role,
      at,
      text: shortEnough(publicText(message.text)),
      streamId,
      promptedAt,
      pickedUpAt,
      queuedAt,
      queueOrder,
      followupState,
    }).filter(([, value]) => value !== undefined),
  ) as unknown as Message;
}

const shortEnough = (text: string) =>
  text.length <= LONGEST_TURN
    ? text
    : text.slice(0, LONGEST_TURN - CUT.length) + CUT;

/** Every string in a value, redacted. For a review report, which holds text in many places. */
export const publicValue = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value), (_key, field) =>
    typeof field === "string" ? publicText(field) : field,
  );

/** The id of one worker run on one computer: the same for every entry of that run. */
export function sessionIdOf(
  deviceId: string,
  taskId: string,
  startedAt: string,
): string {
  const bytes = createHash("sha256")
    .update(["memcode-card-session", deviceId, taskId, startedAt].join("\n"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const encoder = new TextEncoder();
const encode = (entry: CardEntry) => encoder.encode(JSON.stringify(entry));
/** An entry must fit the service's limit with room to spare. */
const ROOM_IN_AN_ENTRY = LARGEST_UPDATE - 16 * 1024;

/**
 * The payloads for one record, each small enough for the service. A session
 * whose turns do not fit in one entry is written as several, each with the
 * run's state. A review that does not fit loses its per-symbol measurements;
 * one that still does not fit is not shared, and nothing comes back.
 */
export function cardPayloads(
  record: CardRecord,
  writer: WritingDevice,
): Uint8Array[] {
  const entry = { format: CARD_FORMAT, version: CARD_VERSION, device: writer };
  const whole = encode({ ...entry, ...record } as CardEntry);
  if (whole.length <= ROOM_IN_AN_ENTRY) return [whole];
  if (record.kind === "review") {
    const lighter = encode({
      ...entry,
      ...record,
      review: { ...record.review, metrics: [] },
    } as CardEntry);
    return lighter.length <= ROOM_IN_AN_ENTRY ? [lighter] : [];
  }
  if (record.kind !== "session") return [];
  const { messages, ...state } = record.session;
  const parts: Uint8Array[] = [];
  let together: Message[] = [];
  const written = (turns: Message[]) =>
    encode({
      ...entry,
      kind: "session",
      session: { ...state, messages: turns },
    } as CardEntry);
  for (const message of messages) {
    if (written([...together, message]).length > ROOM_IN_AN_ENTRY) {
      if (together.length) parts.push(written(together));
      together = [];
    }
    together.push(message);
  }
  parts.push(written(together));
  return parts;
}

export type ReadEntry =
  { readable: true; entry: CardEntry } | { readable: false; newer: boolean };

const decoder = new TextDecoder("utf-8", { fatal: true });

/** What an entry from the log says, when it is an entry MemCode can trust the shape of. */
export function readCardEntry(payload: Uint8Array): ReadEntry {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(payload));
  } catch {
    return { readable: false, newer: false };
  }
  const read = entryShape.safeParse(value);
  if (read.success)
    return { readable: true, entry: read.data as unknown as CardEntry };
  const version = (value as { format?: unknown; version?: unknown } | null)
    ?.version;
  const ours = (value as { format?: unknown } | null)?.format === CARD_FORMAT;
  return {
    readable: false,
    newer: ours && typeof version === "number" && version > CARD_VERSION,
  };
}
