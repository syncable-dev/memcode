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
}: Props) {
  const [phase, setPhase] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState<string>();
  // A goal whose pull request merged has shipped; it leaves the active plan.
  const epics = allEpics.filter((epic) => !epic.closedAt);
  const shipped = allEpics.length - epics.length;
  const updateFromBase = async (epic: Epic) => {
    setUpdating(epic.id);
    try {
      const result = await window.memcode.updateGoalFromBase(epic.id);
      const base = epic.baseBranch ?? "dev";
      notify(
        result.conflicts?.length
          ? `Updating “${epic.title}” would conflict in ${result.conflicts.join(", ")}. Its work is saved on its branch; resolve it there or ask an agent.`
          : result.merged
            ? `Updated “${epic.title}” from ${base}. Its code context refreshes in about a minute.`
            : `“${epic.title}” already has the latest ${base}.`,
      );
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
            {epics.length} epics. <em>One direction.</em>
          </h2>
          <p>
            {done} of {tasks.length} stories complete<span>·</span>
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
        <button
          className="button secondary"
          data-guide="new-epic"
          onClick={() => setNewEpic(true)}
        >
          <Plus size={13} />
          New epic
        </button>
      </div>
      {!epics.length ? (
        <Empty
          icon={<Route size={29} />}
          title="A place for the bigger picture."
          description="Group the work into epics, then break it into stories your fleet can pick up."
          action={
            <div className="roadmap-empty-actions">
              <button
                className="button primary"
                onClick={() => setNewEpic(true)}
              >
                <Plus size={14} />
                Create an epic
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
                    const readiness = epicReadiness(stories, epic.id);
                    const pullRequest = pullRequests.find(
                      (item) => item.epicId === epic.id,
                    );
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
                            working={working > 0}
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
                            <small>/ {stories.length} stories</small>
                          </span>
                        </div>
                        <div className="epic-card-actions">
                          <button onClick={() => toggle(epic.id)}>
                            {unfolded ? "Hide stories" : "View stories"}
                            <ChevronRight size={12} />
                          </button>
                          <button onClick={() => addStory(epic.id)}>
                            <Plus size={12} />
                            Add story
                          </button>
                          {epic.updateNeeded && (
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
                                    title="Waiting on prerequisite stories"
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
                                Give this epic its first focused story.
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
                    This phase is open. Move an epic here when you’re ready.
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
            Stories carry the brief, runbook, model route and worker result.
            Prerequisites keep the order explicit.
            {shipped > 0 &&
              ` ${shipped} ${shipped === 1 ? "goal has" : "goals have"} shipped.`}
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
      kicker="NEW EPIC"
      description="An epic gathers the outcome. Stories make it actionable."
      close={close}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <label className="field">
            <span>Epic name</span>
            <input
              aria-label="Epic name"
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
                aria-label="Epic description"
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
            {busy ? <Spinner /> : <Plus size={13} />}Create epic
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
