import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import type { AppState, Project } from "../shared";
import {
  folderStanding,
  goalBranchStanding,
  type RepositoryStatus,
} from "../branches";
import { Modal } from "./Dialogs";

/**
 * A project's repository: its folder and GitHub repository, the branch the folder is
 * on, where new work starts, and the branch each goal's work goes to.
 */
export function RepositoryPanel({
  project,
  state,
  close,
}: {
  project: Project;
  state: AppState;
  close(): void;
}) {
  const [status, setStatus] = useState<RepositoryStatus>();
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    window.memcode
      .repositoryStatus(project.id)
      .then(setStatus, (error: Error) => setProblem(error.message));
  }, [project.id]);
  const act = async (work: () => Promise<RepositoryStatus | void>) => {
    setBusy(true);
    setProblem("");
    try {
      const next = await work();
      if (next) setStatus(next);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const base = status?.base.branch ?? "dev";
  const goals = state.epics
    .filter((goal) => goal.projectId === project.id && !goal.closedAt)
    .map((goal) => ({
      goal,
      standing: goalBranchStanding(
        goal,
        state.tasks.some(
          (task) => task.epicId === goal.id && !!task.run.startedAt,
        ),
        base,
      ),
    }));
  const fresh = goals.filter(({ standing }) => standing.startFresh);
  const startFresh = (ids: string[]) =>
    act(async () => {
      for (const id of ids) await window.memcode.startGoalFresh(id);
    });
  return (
    <Modal
      title="Repository and branches"
      kicker="WHERE WORK BRANCHES FROM"
      description={project.name}
      close={() => {
        if (!busy) close();
      }}
      wide
    >
      <div className="modal-body repository-panel">
        {!status && !problem && <p>Reading the repository…</p>}
        {status && (
          <>
            <dl>
              <dt>Folder</dt>
              <dd>{status.folder}</dd>
              <dt>Repository</dt>
              <dd>
                {status.github
                  ? status.github.replace("https://", "")
                  : status.remote
                    ? `${status.remote}, not on GitHub`
                    : "No remote. Work stays on this computer."}
              </dd>
            </dl>
            <p
              className={
                "repository-standing" +
                (status.behind || status.changedFiles ? " attention" : "")
              }
              role="status"
            >
              <GitBranch size={13} aria-hidden="true" />
              {folderStanding(status)}
            </p>
            <label className="repository-base">
              <span>New work starts from</span>
              <select
                value={status.base.chosen ? status.base.branch : ""}
                disabled={busy}
                onChange={(event) =>
                  void act(() =>
                    window.memcode.setBaseBranch(
                      project.id,
                      event.target.value || null,
                    ),
                  )
                }
              >
                <option value="">
                  {status.base.chosen
                    ? "Worked out by MemCode"
                    : `Worked out by MemCode · ${status.base.branch}`}
                </option>
                {status.branches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </label>
            <div className="repository-goals">
              <div className="repository-goals-head">
                <strong>Goals</strong>
                {fresh.length > 1 && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void startFresh(fresh.map(({ goal }) => goal.id))
                    }
                  >
                    Start all {fresh.length} fresh from {base}
                  </button>
                )}
              </div>
              {goals.length ? (
                <ul>
                  {goals.map(({ goal, standing }) => (
                    <li key={goal.id}>
                      <span>
                        <strong>{goal.title}</strong>
                        <small>{standing.text}</small>
                      </span>
                      {standing.startFresh && (
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => void startFresh([goal.id])}
                        >
                          Start fresh from {base}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No goals yet. Each goal gets its own branch from {base}.</p>
              )}
            </div>
          </>
        )}
        {problem && (
          <p role="alert" className="worker-input-error">
            {problem}
          </p>
        )}
      </div>
      <footer className="modal-footer">
        <span>Nothing here deletes or switches a branch.</span>
        <button className="button secondary" disabled={busy} onClick={close}>
          Done
        </button>
      </footer>
    </Modal>
  );
}
