import type { ServerHttp2Stream } from "node:http2";
import {
  slackCalls,
  slackContract,
  type SlackCall,
} from "../../runtime/sharing/memsync/slack-contract";
import {
  decodeMessage,
  encodeMessage,
  type WireMessage,
} from "../../runtime/sharing/memsync/wire";
import type { StandInPerson } from "./memsync-stand-in";

const framed = (message: Uint8Array) => {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt32BE(message.length, 1);
  frame.set(message, 5);
  return frame;
};

/** MemSync's Slack connections, kept in memory. Slack itself is never asked. */
export function standInSlack(the: {
  isOnProject(project: string, person: StandInPerson): boolean;
  now(): number;
  refuse(rule: "no_such_project"): never;
}) {
  const connected: Array<{ project: string; team: string; name: string; by: string }> = [];
  const allowed = (project: unknown, person: StandInPerson) =>
    the.isOnProject(String(project), person)
      ? String(project)
      : the.refuse("no_such_project");
  const at = () => ({ seconds: Math.floor(the.now() / 1000), nanos: 0 });

  const handlers: Partial<
    Record<SlackCall, (request: WireMessage, caller: StandInPerson) => WireMessage>
  > = {
    StartSlackInstall: ({ project_id }, caller) => ({
      install_url: `https://slack.com/oauth/v2/authorize?state=${allowed(project_id, caller)}`,
    }),
    ListChannels({ project_id }, caller) {
      const project = allowed(project_id, caller);
      return {
        channels: [],
        workspaces: connected
          .filter((one) => one.project === project)
          .map((one) => ({
            team_id: one.team,
            team_name: one.name,
            connected_by_account_id: one.by,
            connected_at: at(),
          })),
      };
    },
    DisconnectWorkspace({ project_id, team_id }, caller) {
      const project = allowed(project_id, caller);
      const index = connected.findIndex(
        (one) => one.project === project && one.team === team_id,
      );
      if (index >= 0) connected.splice(index, 1);
      return {};
    },
  };

  return {
    /** Someone approved Add to Slack: this workspace reports to the project now. */
    connect(project: string, team: string, name: string, by: StandInPerson) {
      connected.push({ project, team, name, by: by.accountId });
    },
    answer(
      stream: ServerHttp2Stream,
      method: SlackCall,
      caller: StandInPerson,
      body: Buffer,
    ) {
      const call = slackCalls[method];
      const reply = handlers[method]!(
        decodeMessage(slackContract, call.request, body.subarray(5)),
        caller,
      );
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(framed(encodeMessage(slackContract, call.reply, reply)));
    },
  };
}
