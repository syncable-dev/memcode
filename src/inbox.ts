/**
 * A shared project's Inbox: the reports people sent from Slack, and what became of each.
 * MemSync keeps it as the card log of the nil card. Its entries are JSON in the inbox
 * format of MemSync's docs/inbox-format.md: MemSync writes reports, replies and "also hit",
 * MemCode writes "picked up", "declined" and "reopened".
 */

/** The card whose log is a project's Inbox. */
export const INBOX_CARD = "00000000-0000-0000-0000-000000000000";
export const INBOX_FORMAT = "memcode-inbox/1";

export interface InboxPerson {
  name: string;
  slackUser: string;
}

export interface InboxFile {
  name: string;
  mime: string;
  size: number;
  slackUrl: string;
  /** Present when the project keeps a copy. */
  sha256?: string;
  /** Why the project keeps no copy. */
  notKept?: "too_big" | "no_room" | "unreadable";
}

export interface InboxReply {
  text: string;
  author: InboxPerson;
  writtenAt: string;
}

export type InboxState = "new" | "picked_up" | "declined";
export type HowBad = "blocked" | "annoying" | "idea";

export interface InboxItem {
  id: string;
  title: string;
  text: string;
  reporter: InboxPerson;
  filedBy?: InboxPerson;
  permalink?: string;
  channel: string;
  files: InboxFile[];
  links: string[];
  expected?: string;
  where?: string;
  howBad?: HowBad;
  reportedAt: string;
  replies: InboxReply[];
  alsoHit: InboxPerson[];
  state: InboxState;
  /** The goal it became or joined, once picked up. */
  goal?: { id: string; title: string };
  /** Why it was declined, when it is. */
  reason?: string;
  /** The account that last picked it up, declined or reopened it. */
  decidedBy?: string;
}

/** One entry of the Inbox's log, as the Cards API hands it over. */
export interface InboxLogEntry {
  author: string;
  payload: Uint8Array;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const optional = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

function person(value: unknown): InboxPerson {
  const read = record(value);
  return { name: text(read.name), slackUser: text(read.slack_user) };
}

function file(value: unknown): InboxFile {
  const read = record(value);
  const notKept = optional(read.not_kept);
  return {
    name: text(read.name),
    mime: text(read.mime),
    size: Number(read.size) || 0,
    slackUrl: text(read.slack_url),
    sha256: optional(read.sha256),
    notKept:
      notKept === "too_big" || notKept === "no_room" || notKept === "unreadable"
        ? notKept
        : undefined,
  };
}

const list = <T>(value: unknown, read: (item: unknown) => T): T[] =>
  Array.isArray(value) ? value.map(read) : [];
const howBadOf = (value: unknown): HowBad | undefined =>
  value === "blocked" || value === "annoying" || value === "idea"
    ? value
    : undefined;

/**
 * The Inbox's items, newest report first, from its whole log in order. Entries that are
 * not JSON, not in this format, or of a kind this version does not know are skipped.
 */
export function inboxItems(entries: InboxLogEntry[]): InboxItem[] {
  const items = new Map<string, InboxItem>();
  const decoder = new TextDecoder();
  for (const entry of entries) {
    let read: Json;
    try {
      read = record(JSON.parse(decoder.decode(entry.payload)));
    } catch {
      continue;
    }
    if (read.format !== INBOX_FORMAT) continue;
    const id = text(read.item);
    if (!id) continue;
    const known = items.get(id);
    switch (read.kind) {
      case "report": {
        if (known) break;
        const source = record(read.source);
        const details = record(read.details);
        items.set(id, {
          id,
          title: text(read.title) || "Report from Slack",
          text: text(read.text),
          reporter: person(read.reporter),
          filedBy: read.filed_by ? person(read.filed_by) : undefined,
          permalink: optional(source.permalink),
          channel: text(source.channel),
          files: list(read.files, file),
          links: list(read.links, text).filter(Boolean),
          expected: optional(details.expected),
          where: optional(details.where),
          howBad: howBadOf(details.how_bad),
          reportedAt: text(read.reported_at),
          replies: [],
          alsoHit: [],
          state: "new",
        });
        break;
      }
      case "reply":
        known?.replies.push({
          text: text(read.text),
          author: person(read.author),
          writtenAt: text(read.written_at),
        });
        if (known) known.files.push(...list(read.files, file));
        break;
      case "also_hit": {
        const someone = person(read.person);
        if (
          known &&
          !known.alsoHit.some((hit) => hit.slackUser === someone.slackUser)
        )
          known.alsoHit.push(someone);
        break;
      }
      case "picked_up":
        if (!known) break;
        known.state = "picked_up";
        known.goal = { id: text(read.goal), title: text(read.goal_title) };
        known.reason = undefined;
        known.decidedBy = entry.author;
        break;
      case "declined":
        if (!known) break;
        known.state = "declined";
        known.reason = text(read.reason);
        known.goal = undefined;
        known.decidedBy = entry.author;
        break;
      case "reopened":
        if (!known) break;
        known.state = "new";
        known.reason = undefined;
        known.goal = undefined;
        known.decidedBy = entry.author;
        break;
    }
  }
  return [...items.values()].sort((a, b) =>
    b.reportedAt.localeCompare(a.reportedAt),
  );
}

/** A Slack channel whose reports go to the project's Inbox. */
export interface InboxChannel {
  teamId: string;
  channelId: string;
  channelName: string;
  teamName: string;
  linkedBy: string;
  linkedAt: string;
}

/** What the Inbox screen shows for one shared project. */
export interface ProjectInbox {
  items: InboxItem[];
  channels: InboxChannel[];
  /** The sharing service has no Slack channels yet. */
  channelsUnavailable: boolean;
}

/** What became of a report, as MemCode records it. */
export type InboxDecision =
  | { kind: "picked_up"; goal: string; goalTitle: string }
  | { kind: "declined"; reason: string }
  | { kind: "reopened" };

/** The entry that records a decision about an item. */
export function decisionEntry(item: string, decision: InboxDecision): Json {
  const base = { format: INBOX_FORMAT, kind: decision.kind, item };
  switch (decision.kind) {
    case "picked_up":
      return { ...base, goal: decision.goal, goal_title: decision.goalTitle };
    case "declined":
      return { ...base, reason: decision.reason };
    case "reopened":
      return base;
  }
}

/** What a new goal starts from: the report as someone would write it themselves. */
export function requestFrom(item: InboxItem): string {
  // A title is usually the text's first line, so the text alone says it once.
  const body = item.text.trim();
  const lines = body.startsWith(item.title) ? [body] : [item.title];
  if (body && !body.startsWith(item.title)) lines.push("", body);
  if (item.expected) lines.push("", `Expected: ${item.expected}`);
  if (item.where) lines.push(`Where: ${item.where}`);
  if (item.links.length) lines.push("", ...item.links);
  if (item.permalink) lines.push("", `Reported in Slack: ${item.permalink}`);
  return lines.join("\n");
}
