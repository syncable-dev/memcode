import { useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  GitBranch,
  MessagesSquare,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { FleetConflict, Project, WorkItem } from "../shared";
import {
  changeVerbs,
  decisionAsk,
  needsPerson,
  verdictSummary,
  type FleetPosition,
} from "../fleet";
import { Select } from "./Select";
import { Empty, Spinner } from "./UI";

const bothProceed = "both";

export function FleetDecisions({
  project,
  conflicts,
  tasks,
  open,
  notify,
}: {
  project: Project;
  conflicts: FleetConflict[];
  tasks: WorkItem[];
  open: (task: WorkItem) => void;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      await window.memcode.refreshFleet(project.id);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const yours = conflicts.filter(needsPerson),
    settling = conflicts.filter(
      (item) => item.status === "open" && !needsPerson(item),
    ),
    resolved = conflicts.filter((item) => item.status === "resolved");
  const card = (item: FleetConflict) => (
    <Decision
      key={item.id}
      conflict={item}
      tasks={tasks}
      open={open}
      notify={notify}
    />
  );
  return (
    <div className="fleet-decisions">
      <section className="fleet-explainer">
        <span className="fleet-explainer-icon">
          <ShieldCheck size={23} />
        </span>
        <div>
          <h2>Many workers, one goal, no waiting.</h2>
          <p>
            Workers on a goal edit the same code at the same time. Each one says
            what it is about to change and why, and the others hear about it as
            it lands. When two changes can’t both stand, the workers involved
            judge first. You’re asked only when they disagree, one of them has a
            question, or code is being removed.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy || project.example || project.analysis !== "ready"}
          onClick={() => void refresh()}
        >
          {busy ? <Spinner size={13} /> : <RefreshCw size={13} />}Refresh Fleet
        </button>
      </section>
      <div className="section-heading">
        <h2>
          Needs your decision{" "}
          <span className="decision-count">{yours.length}</span>
        </h2>
        <span>Only the workers involved hold the contested code</span>
      </div>
      {yours.length ? (
        yours.map(card)
      ) : (
        <Empty
          icon={<ShieldCheck size={28} />}
          title="Nothing needs you."
          description="Overlapping edits are merged by the workers as they go. A disagreement they can’t settle between them appears here, with what each of them wants."
        />
      )}
      {settling.length > 0 && (
        <>
          <div className="section-heading">
            <h2>The workers are settling</h2>
            <span>No action needed unless they can’t agree</span>
          </div>
          {settling.map(card)}
        </>
      )}
      {resolved.length > 0 && (
        <details className="decision-history">
          <summary>Decision history · {resolved.length}</summary>
          {resolved.map(card)}
        </details>
      )}
    </div>
  );
}

function Decision({
  conflict,
  tasks,
  open,
  notify,
}: {
  conflict: FleetConflict;
  tasks: WorkItem[];
  open: (task: WorkItem) => void;
  notify: (message: string) => void;
}) {
  const [resolution, setResolution] = useState(conflict.resolution ?? ""),
    [winner, setWinner] = useState(
      conflict.winnerTaskId ?? conflict.recommendedTaskId ?? bothProceed,
    ),
    [busy, setBusy] = useState(false);
  const affected = tasks.filter((task) => conflict.taskIds.includes(task.id));
  const name = (taskId?: string) =>
    tasks.find((task) => task.id === taskId)?.identifier ?? "another agent";
  const chosen = affected.find((task) => task.id === winner);
  const resolve = async () => {
    setBusy(true);
    try {
      await window.memcode.resolveFleetConflict(
        conflict.id,
        resolution.trim() ||
          (chosen
            ? `${chosen.identifier} goes ahead.`
            : "Both changes go ahead as they are."),
        chosen?.id,
      );
      notify("Decision recorded. The workers involved have been told.");
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const asked = needsPerson(conflict);
  return (
    <article className={"decision-card " + conflict.status}>
      <header>
        <span className="decision-icon">
          {conflict.status === "resolved" ? (
            <Check size={17} />
          ) : asked ? (
            <AlertTriangle size={17} />
          ) : (
            <MessagesSquare size={17} />
          )}
        </span>
        <div>
          <span className="decision-kicker">{decisionAsk(conflict)}</span>
          <h3>{conflict.summary}</h3>
          {conflict.needsReason && (
            <p className="decision-reason">{conflict.needsReason}</p>
          )}
        </div>
        <span className="decision-branch">
          <GitBranch size={12} />
          {conflict.branch}
        </span>
      </header>
      <div className="decision-body">
        {conflict.positions?.length ? (
          <ul className="decision-positions">
            {conflict.positions.map((position) => (
              <Position
                key={position.agentId}
                position={position}
                task={tasks.find((task) => task.id === position.taskId)}
                recommended={
                  !!position.taskId &&
                  position.taskId === conflict.recommendedTaskId
                }
                name={name}
                open={open}
              />
            ))}
          </ul>
        ) : (
          <div className="decision-workers">
            {affected.map((task) => (
              <button key={task.id} onClick={() => open(task)}>
                <span>{task.identifier}</span>
                {task.title}
                <ArrowUpRight size={12} />
              </button>
            ))}
          </div>
        )}
        <details className="decision-scope">
          <summary>Contested code · {conflict.scope.length}</summary>
          {conflict.scope.map((scope) => (
            <code key={scope}>{scope}</code>
          ))}
        </details>
        {(asked || conflict.status === "resolved") && (
          <>
            <label className="field">
              <span>
                {conflict.status === "resolved"
                  ? "What was decided"
                  : "Anything the workers should know (optional)"}
              </span>
              <textarea
                aria-label={`Resolution for ${conflict.id}`}
                value={resolution}
                onChange={(event) => setResolution(event.target.value)}
                placeholder="For example: keep the new signature, and rename afterwards."
                maxLength={10000}
              />
            </label>
            <footer>
              <Select
                aria-label={`Who goes ahead for ${conflict.id}`}
                value={winner}
                onValueChange={setWinner}
              >
                <option value={bothProceed}>Both go ahead as they are</option>
                {affected.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.identifier} goes ahead · the other rebuilds on it
                  </option>
                ))}
              </Select>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void resolve()}
              >
                {busy ? <Spinner size={13} /> : <Check size={13} />}{" "}
                {conflict.status === "resolved"
                  ? "Update decision"
                  : conflict.needs === "confirm"
                    ? "Confirm"
                    : "Decide"}
              </button>
            </footer>
            <p className="decision-note">
              The workers involved hear your decision at once and carry on.
              Nothing in the files is undone.
            </p>
          </>
        )}
      </div>
    </article>
  );
}

function Position({
  position,
  task,
  recommended,
  name,
  open,
}: {
  position: FleetPosition;
  task?: WorkItem;
  recommended: boolean;
  name: (taskId?: string) => string;
  open: (task: WorkItem) => void;
}) {
  const verdict = verdictSummary(position, name);
  return (
    <li className={"decision-position" + (recommended ? " recommended" : "")}>
      <div className="decision-position-who">
        {task ? (
          <button onClick={() => open(task)}>
            <span>{task.identifier}</span>
            {task.title}
            <ArrowUpRight size={12} />
          </button>
        ) : (
          <span className="decision-outsider">{position.agentId}</span>
        )}
        {recommended && <span className="decision-pill">Recommended</span>}
      </div>
      <p className="decision-wants">
        <strong>
          Is {position.kind ? changeVerbs[position.kind] : "changing"} it.
        </strong>{" "}
        {position.plan}
      </p>
      <p className="decision-verdict">
        {verdict ? (
          <>
            <strong>{verdict}.</strong> {position.reason}
          </>
        ) : (
          <em>Has not judged yet.</em>
        )}
      </p>
    </li>
  );
}
