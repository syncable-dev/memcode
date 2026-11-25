import { useEffect, useMemo, useState } from "react";
import type { AppState, Project } from "../shared";
import type {
  SentStatuses,
  TrackerChoices,
  TrackerConnection,
  TrackerPreview,
  TrackerScope,
  TrackerTeam,
} from "../tracker";
import { keptElsewhere } from "../tracker";
import { workflowFor } from "../planning/workflow";
import { IntegrationMark } from "./IntegrationMark";
import { Select } from "./Select";
import { Spinner } from "./UI";

const counted = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Linear's page: connect, choose what to bring in, and see that it is kept in step. */
export function LinearPage({
  project,
  state,
  notify,
}: {
  project: Project | undefined;
  state: AppState;
  notify: (message: string) => void;
}) {
  const connection = state.trackers?.find((item) => item.projectId === project?.id);
  const elsewhere = project && keptElsewhere(state, project.id);
  const [busy, setBusy] = useState("");
  const [key, setKey] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const act = async (name: string, job: () => Promise<unknown>) => {
    setBusy(name);
    notify("");
    try {
      await job();
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const connect = (withKey?: string) =>
    act("connect", async () => {
      try {
        await window.memcode.connectTracker(project!.id, withKey);
        setKey(undefined);
      } catch (error) {
        // A MemCode without an application at Linear can still connect.
        if (/Use an API key/.test((error as Error).message)) setKey("");
        throw error;
      }
    });
  const signedOut = !!connection?.problem && /Connect again/.test(connection.problem);

  return (
    <article className="integration-page" aria-label="Linear">
      <header className="integration-page-header">
        <span className="integration-mark linear large">
          <IntegrationMark id="linear" size={22} />
        </span>
        <div>
          <h3>Linear</h3>
          <p>
            A team’s issues as cards in <strong>{project?.name ?? "this project"}</strong>. Edits
            go both ways. Workers, code and conversations stay in MemCode, and nothing in Linear
            starts a worker.
          </p>
        </div>
        {project && !project.example && (!connection || signedOut) && (
          <button
            type="button"
            className={"button " + (elsewhere ? "secondary" : "primary")}
            disabled={!!busy}
            onClick={() => void connect()}
          >
            {signedOut ? "Connect again" : "Connect Linear"}
          </button>
        )}
      </header>

      {elsewhere && (
        <section>
          <h4>In step</h4>
          <div className="integration-connection">
            <div>
              <strong>{elsewhere.by} keeps this project in step</strong>
              <span>
                With {elsewhere.team || "a team"} in {elsewhere.workspace || "Linear"}, from their
                MemCode.
              </span>
            </div>
            {connection && !signedOut && (
              <button
                type="button"
                className="button secondary"
                disabled={!!busy}
                onClick={() =>
                  void act("take-over", () => window.memcode.takeOverTracker(connection.id))
                }
              >
                Do it from here
              </button>
            )}
          </div>
          <p className="linear-shared">
            Everyone on the project sees the same cards, so you need not connect.
          </p>
        </section>
      )}
      {project?.example && (
        <p className="integration-note">
          The example project cannot be connected. Open one of your own projects first.
        </p>
      )}
      {busy === "connect" && key === undefined && (
        <p className="integration-note">
          <Spinner /> Linear opened in your browser. Choose Authorize there, and this goes on by
          itself.
          <button
            type="button"
            className="integration-link"
            onClick={() => void window.memcode.cancelTrackerConnecting()}
          >
            Cancel
          </button>
        </p>
      )}
      {project && !project.example && (!connection || signedOut) && (
        <section className="linear-key">
          {key === undefined ? (
            <button type="button" className="integration-link" onClick={() => setKey("")}>
              Use an API key instead
            </button>
          ) : (
            // Settings is a form of its own: Enter here must not save and close it.
            <div className="linear-key-form">
              <label htmlFor="linear-key">
                Personal API key, from Linear › Settings › Security & access
              </label>
              <div>
                <input
                  id="linear-key"
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (key.trim().length >= 10 && !busy) void connect(key);
                  }}
                  placeholder="lin_api_…"
                />
                <button
                  type="button"
                  className="button primary"
                  disabled={key.trim().length < 10 || !!busy}
                  onClick={() => void connect(key)}
                >
                  {busy === "connect" && <Spinner size={12} />}
                  Connect
                </button>
              </div>
              <small>It is kept in this computer’s credential store and sent to Linear only.</small>
            </div>
          )}
        </section>
      )}

      {connection && !signedOut && (
        <section>
          <h4>Connected</h4>
          <div className="integration-connection">
            <div>
              <strong>{connection.workspace.name}</strong>
              <span>As {connection.viewer.name}. Changes from here carry that name in Linear.</span>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={!!busy}
              onClick={() =>
                void act("disconnect", async () => {
                  const { told } = await window.memcode.disconnectTracker(connection.id);
                  if (!told)
                    notify(
                      "Disconnected here. Linear could not be reached: remove MemCode there too, in Settings › Security & access.",
                    );
                })
              }
            >
              Disconnect
            </button>
          </div>
        </section>
      )}

      {connection && !signedOut && !elsewhere && connection.importedAt && !choosing && (
        <LinearStatus
          connection={connection}
          state={state}
          busy={busy}
          act={act}
          change={() => setChoosing(true)}
          notify={notify}
        />
      )}
      {connection && !signedOut && !elsewhere && (!connection.importedAt || choosing) && (
        <LinearChoices
          connection={connection}
          state={state}
          notify={notify}
          close={connection.importedAt ? () => setChoosing(false) : undefined}
        />
      )}
      {!connection && (
        <section>
          <h4>What you get</h4>
          <ul className="integration-how">
            <li>
              <strong>One issue, one card.</strong> A milestone or project is a goal, a cycle is a
              cycle, and comments go both ways.
            </li>
            <li>
              <strong>Your steps reach Linear.</strong> A worker that starts moves the issue to In
              Progress, a finished one to In Review, and a merged pull request to Done.
            </li>
            <li>
              <strong>The newest change wins,</strong> field by field, and the other value stays on
              the card to put back.
            </li>
          </ul>
        </section>
      )}
    </article>
  );
}

function LinearStatus({
  connection,
  state,
  busy,
  act,
  change,
  notify,
}: {
  connection: TrackerConnection;
  state: AppState;
  busy: string;
  act: (name: string, job: () => Promise<unknown>) => Promise<void>;
  change: () => void;
  notify: (message: string) => void;
}) {
  const [undo, setUndo] = useState<{ removed: number; kept: number }>();
  const shared = state.sharedProjectLinks?.some(
    (link) => link.projectId === connection.projectId,
  );
  const cards = state.tasks.filter(
    (task) => task.projectId === connection.projectId && task.tracker,
  );
  const of = (standing: string) => cards.filter((task) => task.tracker!.standing === standing);
  const attention = of("attention");
  const moving = of("sending").length + of("waiting").length;
  return (
    <>
      <section>
        <h4>In step with {connection.team?.name ?? "the team"}</h4>
        <div className="linear-status" data-problem={connection.problem ? "true" : undefined}>
          <p>
            <strong>{counted(of("synced").length, "card")} in step</strong>
            {moving > 0 && <span>{moving} on the way</span>}
            {attention.length > 0 && <span>{attention.length} need you</span>}
            {of("unlinked").length > 0 && <span>{of("unlinked").length} unlinked</span>}
          </p>
          <small>
            {connection.paused
              ? "Paused. Nothing goes back and forth."
              : connection.problem
                ? connection.problem
                : "While MemCode is open, changes arrive within half a minute."}
          </small>
          <div>
            <button
              type="button"
              className="button secondary"
              disabled={!!busy || connection.paused}
              onClick={() => void act("sync", () => window.memcode.syncTracker(connection.id))}
            >
              {busy === "sync" && <Spinner size={12} />}
              Check now
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!!busy}
              onClick={() =>
                void act("pause", () =>
                  window.memcode.pauseTracker(connection.id, !connection.paused),
                )
              }
            >
              {connection.paused ? "Carry on" : "Pause"}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!!busy}
              onClick={change}
            >
              Change what is brought in
            </button>
          </div>
        </div>
      </section>
      {attention.length > 0 && (
        <section>
          <h4>Need you</h4>
          <ul className="linear-attention">
            {attention.slice(0, 20).map((task) => (
              <li key={task.id}>
                <strong>{task.tracker!.key ?? task.identifier}</strong> {task.title}
                <small>{task.tracker!.note}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {undo && (
        <div className="linear-undo" role="group" aria-label="Undo the import">
          <p>
            {undo.removed
              ? `Take ${counted(undo.removed, "card")} out of this project again${shared ? ", for everyone on it" : ""}?`
              : "There is no card to take out."}
            {undo.kept > 0 &&
              ` ${counted(undo.kept, "card")} someone worked on ${undo.kept === 1 ? "stays" : "stay"}.`}{" "}
            Linear is not changed.
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={!!busy || !undo.removed}
            onClick={() =>
              void act("undo", async () => {
                const { removed, kept } = await window.memcode.undoTrackerImport(connection.id);
                setUndo(undefined);
                notify(
                  `${counted(removed, "card")} taken out again.${kept ? ` ${kept} that someone worked on stay.` : ""} Linear was not changed.`,
                );
              })
            }
          >
            {busy === "undo" && <Spinner size={12} />}
            Take them out
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!!busy}
            onClick={() => setUndo(undefined)}
          >
            Keep everything
          </button>
        </div>
      )}
      {!undo && connection.undoUntil && connection.undoUntil > new Date().toISOString() && (
        <p className="integration-note">
          <button
            type="button"
            className="integration-link"
            disabled={!!busy}
            onClick={() =>
              void act("undo", async () =>
                setUndo(await window.memcode.previewUndoTrackerImport(connection.id)),
              )
            }
          >
            Undo the import
          </button>
          until{" "}
          {new Date(connection.undoUntil).toLocaleDateString(undefined, {
            day: "numeric",
            month: "long",
          })}
          . Cards someone worked on stay.
        </p>
      )}
    </>
  );
}

const scopes: { id: TrackerScope; label: string }[] = [
  { id: "open", label: "Open work" },
  { id: "cycle", label: "The current cycle" },
  { id: "all", label: "Everything" },
];
const steps: { id: keyof SentStatuses; label: string; types: string[] }[] = [
  { id: "planned", label: "Planned here is", types: ["unstarted", "backlog"] },
  { id: "working", label: "A worker started", types: ["started"] },
  { id: "review", label: "A worker finished", types: ["started"] },
  { id: "done", label: "Merged or done", types: ["completed"] },
  { id: "canceled", label: "Canceled here", types: ["canceled"] },
];

/** Already filled in, with what MemCode would choose. Nothing changes until Import. */
function LinearChoices({
  connection,
  state,
  notify,
  close,
}: {
  connection: TrackerConnection;
  state: AppState;
  notify: (message: string) => void;
  close?: () => void;
}) {
  const [teams, setTeams] = useState<TrackerTeam[]>();
  const [teamId, setTeamId] = useState(connection.choices?.teamId ?? "");
  const [preview, setPreview] = useState<TrackerPreview>();
  const [choices, setChoices] = useState<TrackerChoices>();
  const [importing, setImporting] = useState(false);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let live = true;
    void window.memcode
      .trackerTeams(connection.id)
      .then((found) => {
        if (!live) return;
        setTeams(found);
        if (!teamId && found.length) setTeamId(found[0].id);
      })
      .catch((error: Error) => notify(error.message));
    return () => {
      live = false;
    };
  }, [connection.id]);
  useEffect(() => {
    if (!teamId) return;
    let live = true;
    setPreview(undefined);
    void window.memcode
      .trackerPreview(connection.id, teamId)
      .then((found) => {
        if (!live) return;
        setPreview(found);
        setChoices(
          connection.choices?.teamId === teamId
            ? {
                ...found.suggested,
                ...connection.choices,
                lanes: { ...found.suggested.lanes, ...connection.choices.lanes },
                send: { ...found.suggested.send, ...connection.choices.send },
              }
            : found.suggested,
        );
      })
      .catch((error: Error) => live && notify(error.message));
    return () => {
      live = false;
    };
  }, [connection.id, teamId]);
  const lanes = useMemo(
    () =>
      workflowFor(state, connection.projectId).filter(
        (lane) => !lane.id.endsWith(":code-review"),
      ),
    [state.workflowStates, connection.projectId],
  );
  const change = (next: Partial<TrackerChoices>) =>
    setChoices((now) => (now ? { ...now, ...next } : now));
  const bring = async () => {
    if (!choices) return;
    setImporting(true);
    try {
      const result = await window.memcode.importFromTracker(connection.id, choices);
      notify(
        result.tasks
          ? `${counted(result.tasks, "task")} and ${counted(result.goals, "goal")} are on the board.`
          : "Everything chosen is on the board already.",
      );
      close?.();
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setImporting(false);
    }
  };
  if (!teams)
    return (
      <p className="integration-note">
        <Spinner /> Reading your teams
      </p>
    );
  return (
    <section className="linear-choices">
      <h4>Bring work in</h4>
      <label>
        <span>From</span>
        <Select aria-label="Linear team" value={teamId} onValueChange={setTeamId}>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name} ({team.key})
            </option>
          ))}
        </Select>
      </label>
      {!preview || !choices ? (
        <p className="integration-note">
          <Spinner /> Counting what is there
        </p>
      ) : (
        <>
          <fieldset>
            <legend>Bring</legend>
            {scopes
              .filter((scope) => scope.id !== "cycle" || preview.team.cyclesEnabled)
              .map((scope) => (
                <label key={scope.id}>
                  <input
                    type="radio"
                    name="linear-scope"
                    checked={choices.scope === scope.id}
                    onChange={() => change({ scope: scope.id })}
                  />
                  {scope.label}, {counted(preview.counts[scope.id], "issue")}
                </label>
              ))}
          </fieldset>
          <label>
            <span>Goals are</span>
            <Select
              aria-label="What becomes a goal"
              value={choices.goals}
              onValueChange={(goals) => change({ goals: goals as TrackerChoices["goals"] })}
            >
              <option value="milestones">
                Milestones, and projects without any
              </option>
              <option value="parents">Parent issues</option>
              <option value="none">Nothing, only tasks</option>
            </Select>
          </label>
          <label className="linear-check">
            <input
              type="checkbox"
              checked={choices.direction === "both"}
              onChange={(event) => change({ direction: event.target.checked ? "both" : "in" })}
            />
            Send changes from here to Linear
          </label>
          <label className="linear-check">
            <input
              type="checkbox"
              checked={choices.createIssues && choices.direction === "both"}
              disabled={choices.direction === "in"}
              onChange={(event) => change({ createIssues: event.target.checked })}
            />
            New tasks here become issues in Linear
          </label>
          <button
            type="button"
            className="integration-link"
            aria-expanded={checking}
            onClick={() => setChecking(!checking)}
          >
            {checking ? "Hide the statuses" : "Check the statuses"}
          </button>
          {checking && (
            <div className="linear-statuses">
              <h5>Where a status shows</h5>
              {preview.statuses
                .filter((status) => !["triage", "canceled", "duplicate"].includes(status.type))
                .map((status) => (
                  <label key={status.id}>
                    <span>{status.name}</span>
                    <Select
                      aria-label={`Lane for ${status.name}`}
                      value={choices.lanes[status.id] ?? ""}
                      onValueChange={(lane) =>
                        change({ lanes: { ...choices.lanes, [status.id]: lane } })
                      }
                    >
                      {lanes.map((lane) => (
                        <option key={lane.id} value={lane.id}>
                          {lane.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                ))}
              <h5>What Linear hears</h5>
              {steps.map((step) => (
                <label key={step.id}>
                  <span>{step.label}</span>
                  <Select
                    aria-label={step.label}
                    value={choices.send[step.id] ?? ""}
                    onValueChange={(status) =>
                      change({ send: { ...choices.send, [step.id]: status } })
                    }
                  >
                    {preview.statuses
                      .filter((status) => step.types.includes(status.type))
                      .map((status) => (
                        <option key={status.id} value={status.id}>
                          {status.name}
                        </option>
                      ))}
                  </Select>
                </label>
              ))}
            </div>
          )}
          <footer>
            <small>Linear is not changed by bringing work in. It can be undone for seven days.</small>
            {close && (
              <button type="button" className="button secondary" onClick={close}>
                Cancel
              </button>
            )}
            <button
              type="button"
              className="button primary"
              disabled={importing}
              onClick={() => void bring()}
            >
              {importing && <Spinner size={12} />}
              {importing
                ? "Bringing it in"
                : `Import ${counted(preview.counts[choices.scope], "issue")}`}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
