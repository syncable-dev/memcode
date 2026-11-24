import type { Contract } from "./wire";

/**
 * slack.proto, written out by hand. A test reads the .proto file beside this one and
 * fails when the two disagree.
 */
const text = (number: number) => ({ number, kind: "string" }) as const;
const moment = "google.protobuf.Timestamp";
const at = (number: number) => ({ number, kind: { message: moment } }) as const;
const many = (number: number, message: string) =>
  ({ number, kind: { message }, repeated: true }) as const;

export const slackService = "memsync.v1.SlackChannels";

export const slackContract = {
  [moment]: {
    seconds: { number: 1, kind: "int64" },
    nanos: { number: 2, kind: "int32" },
  },
  SlackChannel: {
    team_id: text(1),
    channel_id: text(2),
    channel_name: text(3),
    team_name: text(4),
    linked_by_account_id: text(5),
    linked_at: at(6),
  },
  LinkChannelRequest: { project_id: text(1), code: text(2) },
  ListChannelsRequest: { project_id: text(1) },
  ListChannelsResponse: { channels: many(1, "SlackChannel") },
  UnlinkChannelRequest: {
    project_id: text(1),
    team_id: text(2),
    channel_id: text(3),
  },
  UnlinkChannelResponse: {},
} satisfies Contract;

export const slackCalls = {
  LinkChannel: { request: "LinkChannelRequest", reply: "SlackChannel" },
  ListChannels: { request: "ListChannelsRequest", reply: "ListChannelsResponse" },
  UnlinkChannel: {
    request: "UnlinkChannelRequest",
    reply: "UnlinkChannelResponse",
  },
} as const;
export type SlackCall = keyof typeof slackCalls;
