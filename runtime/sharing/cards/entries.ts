import { createHash } from "node:crypto";
import { z } from "zod";
import type { Message } from "../../../src/shared";
import type { StoryReviewRun } from "../../../src/code-review";
import type { RunSummary } from "../../../src/team-session";
import { sessionPayload } from "../../team/session-protocol";
import { LARGEST_UPDATE } from "../board/document";
import { workerResponseSchema } from "../../worker-input";
import type { CardReaders } from "../memsync/cards-contract";

/**
 * What MemCode writes into a card's activity log at the sharing service
 * (MemSync ADR-0014). MemSync never reads an entry; this file is the format.
 *
 * Kinds of entry, each with the computer that wrote it:
 * - `session`: one worker run on that computer, as Team Sync shares it: its
 *   state, what it is doing, its models, and the person's and the worker's
 *   turns of the conversation. An entry holds the run's latest state and the
 *   turns that are new or changed since the run's last entry.
 * - `review`: the code review report of that run.
 * - `summary`: a finished run's last word: what the worker says it did.
 * - `result`: a file someone shared from the card, kept at the service by its
 *   SHA-256.
 * - `message`: something for a worker run on another computer, written by the
 *   computer it is sent from (MemSync ADR-0015): a follow-up, or an answer to
 *   what the worker waits for.
 * - `delivery`: what became of a message, written by the computer running the
 *   worker. It counts only from the account that started the worker.
 * - `input`: a question or an approval the worker waits for, written by the
 *   computer running it, so the person can answer from another computer.
 */

export const CARD_FORMAT = "memcode-card",
  CARD_VERSION = 1;

/** One worker run, or the part of it that is new since its last entry. */
export type SessionPart = z.infer<typeof sessionPart>;
/** A file shared from a card. The bytes are kept at the service by `sha256`. */
export type SharedResultRecord = z.infer<typeof resultRecord>;
/** A follow-up for a worker run on another computer, or an answer to what it waits for. */
export type WorkerMessageRecord = z.infer<typeof messageRecord>;
/** What the computer running a worker did with a message. */
export type DeliveryRecord = z.infer<typeof deliveryRecord>;
export type DeliveryState = DeliveryRecord["state"];
/** A question or an approval a worker waits for, as other computers see it. */
export type InputRecord = z.infer<typeof inputRecord>;
export type CardRecord =
  | { kind: "session"; session: SessionPart }
  | { kind: "review"; sessionId: string; review: StoryReviewRun }
  | { kind: "summary"; sessionId: string; summary: RunSummary }
  | { kind: "result"; result: SharedResultRecord }
  | { kind: "message"; message: WorkerMessageRecord }
  | { kind: "delivery"; delivery: DeliveryRecord }
  | { kind: "input"; input: InputRecord };
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
const moment = z.string().datetime();
/** The longest summary the shared format holds. */
export const LONGEST_SUMMARY = 20_000;
const summaryRecord = z
  .object({
    text: z.string().trim().min(1).max(LONGEST_SUMMARY),
    at: moment,
  })
  .strict();
/** The longest follow-up a card carries; the app's own message box holds as much. */
export const LONGEST_WORKER_MESSAGE = 20_000;
const messageRecord = z
  .object({
    id: uuid,
    sessionId: uuid,
    sentAt: moment,
    text: z.string().trim().min(1).max(LONGEST_WORKER_MESSAGE).optional(),
    answer: z
      .object({
        inputId: z.string().min(1).max(200),
        response: workerResponseSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
const deliveryRecord = z
  .object({
    messageId: uuid,
    sessionId: uuid,
    /**
     * `queued`: the worker takes it when it is ready. `asking`: it waits for the
     * worker's person to allow it. `picked-up`: the worker has it. `declined`:
     * the worker's person said no. `failed`: it could not reach the worker.
     */
    state: z.enum(["queued", "asking", "picked-up", "declined", "failed"]),
    at: moment,
    detail: z.string().max(500).optional(),
  })
  .strict();
const choice = z
  .object({
    id: z.string().min(1).max(1000),
    label: z.string().max(500),
    description: z.string().max(2000).optional(),
    kind: z.enum(["allow-once", "allow-session", "deny", "other"]).optional(),
  })
  .strict();
const inputRecord = z
  .object({
    sessionId: uuid,
    id: z.string().min(1).max(200),
    kind: z.enum(["approval", "question", "plan"]),
    title: z.string().max(4000),
    description: z.string().max(8000).optional(),
    toolName: z.string().max(200).optional(),
    details: z.string().max(8000).optional(),
    options: z.array(choice).max(40).optional(),
    questions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(1000),
            question: z.string().max(4000),
            options: z.array(choice).max(40),
            multiple: z.boolean().optional(),
            allowText: z.boolean().optional(),
            secret: z.boolean().optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    createdAt: moment,
    status: z.enum(["pending", "answered", "cancelled"]),
    /** It asks for something secret: it is answered on the worker's computer only. */
    answerHere: z.boolean().optional(),
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
    .object({
      ...envelope,
      kind: z.literal("summary"),
      sessionId: uuid,
      summary: summaryRecord,
    })
    .strict(),
  z
    .object({ ...envelope, kind: z.literal("result"), result: resultRecord })
    .strict(),
  z
    .object({ ...envelope, kind: z.literal("message"), message: messageRecord })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("delivery"),
      delivery: deliveryRecord,
    })
    .strict(),
  z
    .object({ ...envelope, kind: z.literal("input"), input: inputRecord })
    .strict(),
]);
/**
 * Who reads each kind of entry (MemSync ADR-0019). What a worker and its person said,
 * why a run failed, and what continues it stay with the person's own account, on any of
 * their computers. Everyone on the project sees that a run happens and how it stands,
 * its review and the files shared from its card.
 */
export function readersOf(record: CardRecord): CardReaders {
  switch (record.kind) {
    case "session":
      return record.session.messages.length || record.session.error
        ? "only-its-author"
        : "everyone";
    case "message":
    case "delivery":
    case "input":
      return "only-its-author";
    case "review":
    case "summary":
    case "result":
      return "everyone";
  }
}

/** A message is a follow-up or an answer, never both and never neither. */
const sensible = (entry: CardEntry) =>
  entry.kind !== "message" || !entry.message.text !== !entry.message.answer;

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
  if (read.success && sensible(read.data as unknown as CardEntry))
    return { readable: true, entry: read.data as unknown as CardEntry };
  const version = (value as { format?: unknown; version?: unknown } | null)
    ?.version;
  const ours = (value as { format?: unknown } | null)?.format === CARD_FORMAT;
  return {
    readable: false,
    newer: ours && typeof version === "number" && version > CARD_VERSION,
  };
}
