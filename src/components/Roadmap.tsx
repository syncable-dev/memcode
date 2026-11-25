import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Flag,
  GitBranch,
  GitPullRequest,
  Plus,
  RefreshCw,
  Route,
} from "lucide-react";
import type { Epic, Project, WorkItem } from "../shared";
import { epicReadiness, type EpicPullRequest } from "../pull-request";
import { isActive, isQuickChanges } from "../domain";
import { Empty, PriorityMark, Spinner, StageIcon } from "./UI";
import { Select } from "./Select";
import {
  goalBranchStanding,
  type GoalBranch,
  type RepositoryStatus,
} from "../branches";
import { WORKED_OUT } from "./BaseBranchPicker";
import { keptCheckoutNotes } from "../shipped-goals";
import {
  currentPullRequest,
  isOnBranch,
  mergedPullRequests,
} from "../goal-work";
import { Modal } from "./Dialogs";
import { DeleteAction } from "./DeleteAction";

interface Props {
  project: Project;
  epics: Epic[];
  tasks: WorkItem[];
  open: (task: WorkItem) => void;
  addStory: (epicId?: string) => void;
  notify: (s: string) => void;
  createRequest?: number;
  onCreateRequestConsumed?: () => void;
  onEpicCreated?: (epic: Epic) => void;
  pullRequests?: EpicPullRequest[];
  openPullRequest: (epicId: string) => void;
  /** The project's repository: where new goals branch from, and why. */
  repository?: RepositoryStatus;
}

const phases = [
  { id: "now", name: "Now", detail: "Build the useful core", number: "01" },
  {
    id: "next",
    name: "Next",
    detail: "Make the work dependable",
    number: "02",
  },
  { id: "later", name: "Later", detail: "Make it a product", number: "03" },
] as const;

export function Roadmap({
  project,
  epics: allEpics,
  tasks,
  open,
  addStory,
  notify,
  createRequest,
  onCreateRequestConsumed,
  onEpicCreated,
  pullRequests = [],
  openPullRequest,
  repository,
}: Props) {
  const base = repository?.base.branch ?? "dev";
  const chooseGoalStart = (epic: Epic, value: string) =>
    void window.memcode
      .startGoalFresh(epic.id, value === WORKED_OUT ? null : value)
      .catch((error: Error) => notify(error.message));
  const [phase, setPhase] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState<string>();
  const [conflicts, setConflicts] = useState<Record<string, string[]>>({});
  // A goal whose pull request merged has shipped; it leaves the active plan.
  const epics = allEpics.filter((epic) => !epic.closedAt);
  const shipped = allEpics.length - epics.length;
  const updateFromBase = async (epic: Epic) => {
    setUpdating(epic.id);
    try {
      const result = await window.memcode.updateGoalFromBase(epic.id);
      const base = epic.baseBranch ?? "dev";
      setConflicts((known) => ({ ...known, [epic.id]: result.conflicts ?? [] }));
      if (!result.conflicts?.length)
        notify(
          result.merged
            ? `Updated “${epic.title}” from ${base}. Its code context refreshes in about a minute.`
            : `“${epic.title}” already has the latest ${base}.`,
        );
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setUpdating(undefined);
    }
  };
  const resolveConflicts = async (epic: Epic) => {
    setUpdating(epic.id);
    try {
      const result = await window.memcode.resolveGoalUpdate(epic.id);
      setConflicts((known) => ({ ...known, [epic.id]: [] }));
      if (!result.asked) notify(`“${epic.title}” has the latest ${epic.baseBranch ?? "dev"}.`);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setUpdating(undefined);
    }
  };
  const [newEpic, setNewEpic] = useState(false);
  useEffect(() => {
    if (createRequest) {
      setNewEpic(true);
      onCreateRequestConsumed?.();
    }
  }, [createRequest, onCreateRequestConsumed]);
  const done = tasks.filter((task) => task.stage === "done").length;
  const blocked = (task: WorkItem) =>
    (task.dependsOn ?? []).some(
      (id) => tasks.find((t) => t.id === id)?.stage !== "done",
    );
  const next = tasks.find((task) => task.stage === "planned" && !blocked(task));
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="roadmap-view">
      <section className="roadmap-summary">
        <div className="roadmap-summary-copy">
          <span>
            <Route size={13} />
            THE BUILD, IN VIEW
          </span>
          <h2>
            {epics.length} {epics.length === 1 ? "goal" : "goals"}. <em>One direction.</em>
          </h2>
          <p>
            {done} of {tasks.length} tasks complete<span>·</span>
            {tasks.filter((task) => isActive(task)).length} active workers
          </p>
        </div>
        <div className="roadmap-summary-progress">
          <div className="roadmap-progress-track">
            <i
              style={{
                width: tasks.length ? `${(done / tasks.length) * 100}%` : "0%",
              }}
            />
          </div>
          <div>
            <span>From foundation to a dependable fleet.</span>
            <strong>
              {tasks.length ? Math.round((done / tasks.length) * 100) : 0}%
            </strong>
          </div>
        </div>
        {next && (
          <button className="roadmap-next" onClick={() => open(next)}>
            <span>READY TO PICK UP</span>
            <strong>{next.title}</strong>
            <small>
              {next.identifier}
              <ArrowUpRight size={13} />
            </small>
          </button>
        )}
      </section>
      <div className="roadmap-toolbar">
        <div className="roadmap-phases">
          <button
            className={phase === "all" ? "active" : ""}
            onClick={() => setPhase("all")}
          >
            All phases<span>{epics.length}</span>
          </button>
          {phases.map((item) => (
            <button
              key={item.id}
              className={phase === item.id ? "active" : ""}
              onClick={() => setPhase(item.id)}
            >
              {item.name}
              <span>
                {epics.filter((epic) => epic.phase === item.id).length}
              </span>
            </button>
          ))}
        </div>
        <div className="roadmap-toolbar-end">
          <button
            className="button secondary"
            data-guide="new-epic"
            onClick={() => setNewEpic(true)}
          >
            <Plus size={13} />
            New goal
          </button>
        </div>
      </div>
      {!epics.length ? (
        <Empty
          icon={<Route size={29} />}
          title="A place for the bigger picture."
          description="Group the work into goals, then break them into tasks your fleet can pick up."
          action={
            <div className="roadmap-empty-actions">
              <button
                className="button primary"
                onClick={() => setNewEpic(true)}
              >
                <Plus size={14} />
                Create a goal
              </button>
            </div>
          }
        />
      ) : (
        phases
          .filter((item) => phase === "all" || phase === item.id)
          .map((item) => {
            const group = epics
              .filter((epic) => epic.phase === item.id)
              .sort((a, b) => a.order - b.order);
            return (
              <section className="roadmap-phase" key={item.id}>
                <header>
                  <span className="phase-number">{item.number}</span>
                  <h3>{item.name}</h3>
                  <span>{item.detail}</span>
                  <i />
                </header>
                <div className="epic-grid">
                  {group.map((epic) => {
                    const stories = tasks.filter(
                      (task) => task.epicId === epic.id,
                    );
                    const completed = stories.filter(
                      (task) => task.stage === "done",
                    ).length;
                    const working = stories.filter(
                      (task) => task.stage === "working",
                    ).length;
                    const allDone =
                      stories.length > 0 && completed === stories.length;
                    const readiness = epicReadiness(stories, epic);
                    const pullRequest = currentPullRequest(pullRequests, epic);
                    const merged = mergedPullRequests(pullRequests, epic);
                    const unfolded = expanded.has(epic.id);
                    return (
                      <article
                        className={
                          "epic-card " +
                          epic.color +
                          (unfolded ? " expanded" : "")
                        }
                        key={epic.id}
                      >
                        <div className="epic-card-top">
                          <span className={"epic-symbol " + epic.color}>
                            <Flag size={16} />
                          </span>
                          <span className="epic-identifier">
                            {epic.identifier}
                          </span>
                          <Select
                            aria-label={`Phase for ${epic.identifier}`}
                            className="epic-phase-picker"
                            value={epic.phase}
                            onValueChange={(value) =>
                              void window.memcode
                                .updateEpic(epic.id, {
                                  phase: value as Epic["phase"],
                                })
                                .catch((error) => notify(error.message))
                            }
                          >
                            <option value="now">Now</option>
                            <option value="next">Next</option>
                            <option value="later">Later</option>
                          </Select>
                          <EpicState
                            allDone={allDone}
                            updateNeeded={epic.updateNeeded?.reason}
                            pullRequest={!!pullRequest}
                            ready={readiness.isReady}
                            working={working > 0 || readiness.total > 0 || completed > 0}
                          />
                        </div>
                        <button
                          className="epic-title"
                          onClick={() => toggle(epic.id)}
                          aria-expanded={unfolded}
                        >
                          <h3>{epic.title}</h3>
                          <ChevronDown size={15} />
                        </button>
                        <p className="epic-description">{epic.description}</p>
                        <div className="epic-progress">
                          <div>
                            <i
                              style={{
                                width: stories.length
                                  ? `${(completed / stories.length) * 100}%`
                                  : "0%",
                              }}
                            />
                          </div>
                          <span>
                            {completed}
                            <small>/ {stories.length} tasks</small>
                          </span>
                        </div>
                        {merged.length > 0 && (
                          <GoalProgress
                            merged={merged}
                            tasks={stories}
                            onBranch={readiness.total}
                            notStarted={readiness.waiting}
                            unfolded={unfolded}
                            open={(url) =>
                              void window.memcode
                                .openPullRequest(epic.id, url)
                                .catch((error: Error) => notify(error.message))
                            }
                          />
                        )}
                        <GoalConflicts
                          epic={epic}
                          conflicts={conflicts[epic.id] ?? []}
                          tasks={stories}
                          busy={updating === epic.id}
                          resolve={() => void resolveConflicts(epic)}
                          undo={() =>
                            void window.memcode
                              .undoGoalUpdate(epic.id)
                              .catch((error: Error) => notify(error.message))
                          }
                        />
                        {repository && (
                          <GoalBranchRow
                            standing={goalBranchStanding(
                              epic,
                              stories.some(
                                (task) =>
                                  isOnBranch(task, epic) ||
                                  (!!task.run.startedAt && !task.run.branch),
                              ),
                              base,
                            )}
                            base={base}
                            branches={
                              isQuickChanges(epic) ? [] : repository.branches
                            }
                            chooseStart={(value) => chooseGoalStart(epic, value)}
                          />
                        )}
                        <div className="epic-card-actions">
                          <button onClick={() => toggle(epic.id)}>
                            {unfolded ? "Hide tasks" : "View tasks"}
                            <ChevronRight size={12} />
                          </button>
                          <button onClick={() => addStory(epic.id)}>
                            <Plus size={12} />
                            Add task
                          </button>
                          {epic.updateNeeded && !epic.resolving && (
                            <button
                              className="epic-update"
                              disabled={updating === epic.id || readiness.active > 0}
                              title={
                                readiness.active > 0
                                  ? "Wait for running tasks to finish first."
                                  : epic.updateNeeded.reason
                              }
                              onClick={() => void updateFromBase(epic)}
                            >
                              {updating === epic.id ? (
                                <Spinner size={11} />
                              ) : (
                                <RefreshCw size={12} />
                              )}
                              Update from {epic.baseBranch ?? "dev"}
                            </button>
                          )}
                          {(pullRequest || readiness.ready > 0) && (
                            <button
                              className={
                                readiness.isReady && !pullRequest
                                  ? "epic-pr-ready"
                                  : ""
                              }
                              onClick={() => openPullRequest(epic.id)}
                            >
                              <GitPullRequest size={12} />
                              {pullRequest
                                ? "View pull request"
                                : isQuickChanges(epic)
                                  ? `Ship ${readiness.ready} quick ${readiness.ready === 1 ? "change" : "changes"}`
                                  : "Create pull request"}
                            </button>
                          )}
                          <DeleteAction
                            kind="epic"
                            id={epic.id}
                            name={epic.title}
                            disabled={stories.some(isActive)}
                          />
                        </div>
                        {unfolded && (
                          <div className="epic-stories">
                            {stories.map((task) => (
                              <button
                                key={task.id}
                                onClick={() => open(task)}
                                className={blocked(task) ? "blocked" : ""}
                              >
                                <StageIcon stage={task.stage} />
                                <span>
                                  <small>{task.identifier}</small>
                                  <strong>{task.title}</strong>
                                </span>
                                {blocked(task) ? (
                                  <span
                                    className="dependency-tag"
                                    title="Waiting on prerequisite tasks"
                                  >
                                    <GitBranch size={10} />
                                    {task.dependsOn?.length}
                                  </span>
                                ) : task.route ? (
                                  <span className="story-tier">
                                    {task.route.tier}
                                  </span>
                                ) : (
                                  <PriorityMark value={task.priority} />
                                )}
                                <ArrowUpRight size={11} />
                              </button>
                            ))}
                            {!stories.length && (
                              <p className="epic-no-stories">
                                Give this goal its first focused task.
                              </p>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
                {!group.length && (
                  <div className="phase-empty">
                    This phase is open. Move a goal here when you’re ready.
                  </div>
                )}
              </section>
            );
          })
      )}
      {epics.length > 0 && (
        <div className="roadmap-footnote">
          <GitBranch size={12} />
          <span>
            Tasks carry the brief, runbook, model route and worker result.
            Prerequisites keep the order explicit.
            {shipped > 0 &&
              ` ${shipped} ${shipped === 1 ? "goal has" : "goals have"} shipped.`}
            {keptCheckoutNotes(allEpics).map((note) => (
              <small className="roadmap-kept-checkout" key={note}>
                {note}
              </small>
            ))}
          </span>
        </div>
      )}
      {newEpic && (
        <NewEpic
          project={project}
          created={onEpicCreated}
          close={() => setNewEpic(false)}
          notify={notify}
        />
      )}
    </div>
  );
}

function NewEpic({
  project,
  close,
  notify,
  created,
}: {
  project: Project;
  close: () => void;
  notify: (s: string) => void;
  created?: (epic: Epic) => void;
}) {
  const [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [phase, setPhase] = useState<Epic["phase"]>("now"),
    [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const epic = await window.memcode.createEpic({
        projectId: project.id,
        title: title.trim(),
        description,
        phase,
      });
      created?.(epic);
      close();
    } catch (error) {
      notify((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Give the bigger idea a direction."
      kicker="NEW GOAL"
      description="A goal names the outcome. Tasks make it actionable."
      close={close}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <label className="field">
            <span>Goal name</span>
            <input
              aria-label="Goal name"
              placeholder="What outcome are we working toward?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              maxLength={160}
            />
          </label>
          <div className="field">
            <span>Why it matters</span>
            <div className="brief-input-wrap">
              <textarea
                aria-label="Goal description"
                placeholder="Describe the outcome and what a successful version looks like…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <label className="field">
            <span>Roadmap phase</span>
            <Select
              aria-label="Roadmap phase"
              value={phase}
              onValueChange={(value) => setPhase(value as Epic["phase"])}
            >
              <option value="now">Now · build the useful core</option>
              <option value="next">Next · make it dependable</option>
              <option value="later">Later · make it a product</option>
            </Select>
          </label>
        </div>
        <footer className="modal-footer">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={!title.trim() || busy}
          >
            {busy ? <Spinner /> : <Plus size={13} />}Create goal
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function EpicState({
  allDone,
  updateNeeded,
  pullRequest,
  ready,
  working,
}: {
  allDone: boolean;
  updateNeeded?: string;
  pullRequest: boolean;
  ready: boolean;
  working: boolean;
}) {
  if (allDone)
    return (
      <span className="epic-state complete">
        <Check size={11} />
        Complete
      </span>
    );
  if (updateNeeded)
    return (
      <span className="epic-state needs-update" title={updateNeeded}>
        Needs update
      </span>
    );
  if (pullRequest)
    return (
      <span className="epic-state ready">
        <GitPullRequest size={10} />
        PR open
      </span>
    );
  if (ready) return <span className="epic-state ready">Ready for PR</span>;
  if (working) return <span className="epic-state working">In progress</span>;
  return <span className="epic-state">Planned</span>;
}

/** The base and the goal changed the same lines: a worker of the goal can resolve it. */
function GoalConflicts({
  epic,
  conflicts,
  tasks,
  busy,
  resolve,
  undo,
}: {
  epic: Epic;
  conflicts: string[];
  tasks: WorkItem[];
  busy: boolean;
  resolve: () => void;
  undo: () => void;
}) {
  const { resolving } = epic;
  const base = resolving?.base ?? epic.baseBranch ?? "dev";
  const files = resolving?.files ?? conflicts;
  if (!files.length) return null;
  const worker = tasks.find((task) => task.id === resolving?.taskId);
  const working = !!worker && isActive(worker);
  const named = files.length > 3 ? `${files.length} files` : files.join(", ");
  return (
    <div className="epic-conflicts">
      <p>
        {working
          ? `${worker.identifier} is resolving ${named} with ${base}.`
          : resolving
            ? `${base} still conflicts in ${named}.`
            : `${base} conflicts in ${named}. The goal’s work is safe.`}
      </p>
      {!working && (
        <div>
          <button
            disabled={busy || tasks.some(isActive)}
            title="Merges the base here, has a worker resolve the files, and commits the merge when no conflict is left."
            onClick={resolve}
          >
            {busy && <Spinner size={11} />}
            {resolving ? "Ask again" : "Have a worker resolve it"}
          </button>
          {resolving && (
            <button disabled={busy || tasks.some(isActive)} onClick={undo}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A goal that has shipped before: its merged pull requests, and what is left. */
function GoalProgress({
  merged,
  tasks,
  onBranch,
  notStarted,
  unfolded,
  open,
}: {
  merged: EpicPullRequest[];
  tasks: WorkItem[];
  onBranch: number;
  notStarted: number;
  unfolded: boolean;
  open: (url: string) => void;
}) {
  const shown = unfolded ? merged : merged.slice(-2);
  const earlier = merged.length - shown.length;
  return (
    <ul className="epic-shipped">
      {earlier > 0 && (
        <li>
          <Check size={11} aria-hidden="true" />
          <span>{counted(earlier, "earlier pull request")} merged</span>
        </li>
      )}
      {shown.map((item) => (
        <li key={item.url ?? item.branch}>
          <Check size={11} aria-hidden="true" />
          <button
            disabled={!item.url}
            title={item.branch}
            onClick={() => item.url && open(item.url)}
          >
            {item.number ? `Pull request #${item.number}` : item.branch}
          </button>
          <span>
            merged,{" "}
            {counted(
              item.tasks ??
                tasks.filter((task) => task.run.branch === item.branch).length,
              "task",
            )}
          </span>
        </li>
      ))}
      {onBranch > 0 && (
        <li>
          <i className="now" aria-hidden="true" />
          <span>{counted(onBranch, "task")} in progress</span>
        </li>
      )}
      {notStarted > 0 && (
        <li>
          <i aria-hidden="true" />
          <span>{counted(notStarted, "task")} left</span>
        </li>
      )}
    </ul>
  );
}

const counted = (count: number, what: string) =>
  `${count} ${what}${count === 1 ? "" : "s"}`;

/**
 * Where a goal's work goes, on its card: the branch its workers use; or, before its
 * first task starts, the branch it will branch from, which can be changed; or a branch
 * it names that no worker here has used, with a fresh start from the base.
 */
function GoalBranchRow({
  standing,
  base,
  branches,
  chooseStart,
}: {
  standing: GoalBranch;
  base: string;
  branches: string[];
  chooseStart: (value: string) => void;
}) {
  if (standing.kind === "working")
    return (
      <div className="epic-branch">
        <GitBranch size={11} aria-hidden="true" />
        <code title={standing.branch}>{standing.branch}</code>
      </div>
    );
  if (standing.kind === "unused")
    return (
      <div className="epic-branch unused">
        <GitBranch size={11} aria-hidden="true" />
        <code title={`${standing.branch}: no worker here has used it`}>{standing.branch}</code>
        <button className="epic-branch-fresh" onClick={() => chooseStart(WORKED_OUT)}>
          Start fresh from {base}
        </button>
      </div>
    );
  const others = branches.filter((branch) => branch !== base);
  if (!others.length)
    return (
      <div className="epic-branch">
        <GitBranch size={11} aria-hidden="true" />
        <span>New branch from</span>
        <code>{standing.from}</code>
        <span>when work starts</span>
      </div>
    );
  return (
    <div className="epic-branch">
      <GitBranch size={11} aria-hidden="true" />
      <span>New branch from</span>
      <Select
        aria-label="Where this goal branches from"
        className="epic-branch-picker"
        value={standing.from === base ? WORKED_OUT : standing.from}
        onValueChange={chooseStart}
      >
        <option value={WORKED_OUT} data-detail="Where this project's goals branch from.">
          {base}
        </option>
        {others.map((branch) => (
          <option key={branch} value={branch}>
            {branch}
          </option>
        ))}
      </Select>
      <span>when work starts</span>
    </div>
  );
}
