import type { ServiceCall, SignedCalls } from "./signed-calls";
import {
  slackCalls,
  slackContract,
  slackService,
  type SlackCall,
} from "./slack-contract";
import { WireError, type WireMessage } from "./wire";

/** A Slack channel whose reports go to a shared project's Inbox. */
export interface SlackChannelRecord {
  teamId: string;
  channelId: string;
  /** Without the #, as it was called when it was linked. */
  channelName: string;
  /** The workspace, or empty when MemSync does not know its name. */
  teamName: string;
  /** Reports from the channel are written as this account. */
  linkedBy: string;
  linkedAt: string;
}

/** A Slack workspace connected to a project with Add to Slack. */
export interface SlackWorkspaceRecord {
  teamId: string;
  /** Empty when MemSync does not know its name. */
  teamName: string;
  /** Reports from it are written as this account. */
  connectedBy: string;
  connectedAt: string;
}

/** The SlackChannels API: a project's connected workspaces and channels. */
export interface SlackChannelsApi {
  /** Slack's page for adding the app, connecting the workspace to this project. */
  startInstall(projectId: string): Promise<string>;
  list(
    projectId: string,
  ): Promise<{ channels: SlackChannelRecord[]; workspaces: SlackWorkspaceRecord[] }>;
  disconnect(projectId: string, teamId: string): Promise<void>;
  link(projectId: string, code: string): Promise<SlackChannelRecord>;
  unlink(projectId: string, teamId: string, channelId: string): Promise<void>;
}

const unreadable = () =>
  new WireError("A Slack channel lacks something it always holds.");
const isMessage = (value: unknown): value is WireMessage =>
  !!value && typeof value === "object" && !Array.isArray(value);

function moment(value: unknown): string {
  if (!isMessage(value)) throw unreadable();
  const when = new Date(
    Number(value.seconds) * 1000 + Number(value.nanos) / 1e6,
  );
  if (Number.isNaN(when.getTime())) throw unreadable();
  return when.toISOString();
}

function channel(sent: unknown): SlackChannelRecord {
  if (!isMessage(sent) || !sent.team_id || !sent.channel_id) throw unreadable();
  return {
    teamId: String(sent.team_id),
    channelId: String(sent.channel_id),
    channelName: String(sent.channel_name ?? ""),
    teamName: String(sent.team_name ?? ""),
    linkedBy: String(sent.linked_by_account_id ?? ""),
    linkedAt: moment(sent.linked_at),
  };
}

function workspace(sent: unknown): SlackWorkspaceRecord {
  if (!isMessage(sent) || !sent.team_id) throw unreadable();
  return {
    teamId: String(sent.team_id),
    teamName: String(sent.team_name ?? ""),
    connectedBy: String(sent.connected_by_account_id ?? ""),
    connectedAt: moment(sent.connected_at),
  };
}

const call = (name: SlackCall): ServiceCall => ({
  service: slackService,
  name,
  contract: slackContract,
  ...slackCalls[name],
});

/** The SlackChannels API over gRPC, signed in with the caller's access token. */
export class MemsyncSlackChannels implements SlackChannelsApi {
  constructor(private readonly calls: SignedCalls) {}

  link(projectId: string, code: string) {
    const request = { project_id: projectId, code };
    return this.calls.unary(call("LinkChannel"), request, channel);
  }
  list(projectId: string) {
    const request = { project_id: projectId };
    return this.calls.unary(call("ListChannels"), request, (reply) => ({
      channels: (Array.isArray(reply.channels) ? reply.channels : []).map(
        channel,
      ),
      workspaces: (Array.isArray(reply.workspaces) ? reply.workspaces : []).map(
        workspace,
      ),
    }));
  }
  startInstall(projectId: string) {
    const request = { project_id: projectId };
    return this.calls.unary(call("StartSlackInstall"), request, (reply) => {
      const url = String(reply.install_url ?? "");
      if (!url.startsWith("https://slack.com/")) throw unreadable();
      return url;
    });
  }
  async disconnect(projectId: string, teamId: string) {
    const request = { project_id: projectId, team_id: teamId };
    await this.calls.unary(call("DisconnectWorkspace"), request, () => undefined);
  }
  async unlink(projectId: string, teamId: string, channelId: string) {
    const request = {
      project_id: projectId,
      team_id: teamId,
      channel_id: channelId,
    };
    await this.calls.unary(call("UnlinkChannel"), request, () => undefined);
  }
}
