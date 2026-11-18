import { Clock3, Laptop } from "lucide-react";
import { harnessNames } from "../shared";
import type { TeamWorkerPhase } from "../team";
import type { teamClaimForStory } from "../team-presentation";
import { HarnessMark } from "./UI";

type Owner = NonNullable<ReturnType<typeof teamClaimForStory>>;
const phases: Record<TeamWorkerPhase, string> = {
  preparing: "Preparing the story",
  joining: "Joining the epic Fleet",
  starting: "Starting the harness",
  responding: "Responding",
  reading: "Reading project context",
  editing: "Editing code",
  testing: "Running checks",
  working: "Working on the story",
  waiting: "Waiting for input or a handoff",
  finishing: "Finishing the worker turn",
  stopping: "Stopping the worker",
};

export function remoteActivityLabel(owner: Owner) {
  return owner.activity ? phases[owner.activity.phase] : "Waiting for a worker update";
}

function UpdatedAt({ at }: { at: string }) {
  const date = new Date(at);
  return (
    <time dateTime={at} title={date.toLocaleString()}>
      {date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
    </time>
  );
}

export function RemoteWorker({ owner, offline }: { owner: Owner; offline: boolean }) {
  const { activity } = owner;
  return (
    <section className="inspector-section remote-worker" aria-label="Worker on another device">
      <div className="inspector-label">WORKER ASSIGNMENT <span>TEAM</span></div>
      <div className="assigned-worker">
        {activity?.harness ? <HarnessMark id={activity.harness} /> : <Laptop size={19} />}
        <div>
          <strong>{activity?.harness ? harnessNames[activity.harness] : "Shared story"}</strong>
          <span>{owner.name} · {owner.device}</span>
        </div>
      </div>
      <dl>
        <div>
          <dt>{activity?.actualModel ? "Confirmed model" : activity?.requestedModel ? "Requested model" : "Model"}</dt>
          <dd>{activity?.actualModel ?? activity?.requestedModel ?? "Awaiting host confirmation"}</dd>
        </div>
      </dl>
      <div className="remote-worker-activity" role="status">
        <Clock3 size={14} aria-hidden="true" />
        <div>
          <strong>{remoteActivityLabel(owner)}</strong>
          <small>{offline ? "Last synced" : activity ? "Updated" : "Claimed"} <UpdatedAt at={activity?.updatedAt ?? owner.claim.acquiredAt} /></small>
        </div>
      </div>
      {offline ? <p>Team Sync is offline. Reconnect to see new activity.</p> :
        !activity && <p>The host holds the story claim. Open this card there for worker details.</p>}
      {activity?.recent && activity.recent.length > 1 && (
        <details>
          <summary>Recent activity</summary>
          <ol>{activity.recent.map((entry, i) => <li key={entry.at + i}><span>{phases[entry.phase]}</span><UpdatedAt at={entry.at} /></li>)}</ol>
        </details>
      )}
    </section>
  );
}
