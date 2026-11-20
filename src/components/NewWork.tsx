import { useRef, useState } from "react";
import { ArrowLeftRight, Flag, Plus, Sparkles, X } from "lucide-react";
import {
  harnessNames,
  type Epic,
  type Harness,
  type Project,
  type WorkItem,
} from "../shared";
import type { GoalPlan, Placement, PlannedTask } from "../goal-plan";
import { suggestedPlace, type Place } from "../new-work";
import { isQuickChanges } from "../domain";
import { taskDraftTitle } from "../task-draft";
import { Modal } from "./Dialogs";
import { Select } from "./Select";
import { Spinner } from "./UI";
import "../styles-new-work.css";

interface Props {
  project: Project;
  /** Open goals in this project; shipped goals take no new work. */
  goals: Epic[];
  defaultHarness: Harness;
  /** Harnesses the person connected in Workers; planning uses one of them. */
  connected: Harness[];
  fixedEpicId?: string;
  statusId?: string;
  onClose: () => void;
  onCreated: (task: WorkItem) => void;
  onAdvanced: () => void;
  notify: (message: string) => void;
}

type Step = "write" | "placing" | "choose" | "planning" | "plan";

/** One door for new work: describe it, MemCode places it, a goal gets a plan. */
export function NewWork(props: Props) {
  const { project, goals, fixedEpicId } = props;
  const [step, setStep] = useState<Step>("write");
  const [request, setRequest] = useState("");
  const [placement, setPlacement] = useState<Placement>({ files: [], goals: [] });
  const [place, setPlace] = useState<Place>({ kind: "quick" });
  const [harness, setHarness] = useState<Harness>(
    props.connected.includes(props.defaultHarness)
      ? props.defaultHarness
      : (props.connected[0] ?? props.defaultHarness),
  );
  const [plan, setPlan] = useState<GoalPlan>();
  const [busy, setBusy] = useState(false);
  const planning = useRef(0);
  const fixed = goals.find((goal) => goal.id === fixedEpicId);

  const continueToPlace = async () => {
    if (!request.trim()) return;
    setStep("placing");
    const found = await window.memcode
      .placeWork(project.id, request)
      .catch(() => ({ files: [], goals: [] }));
    setPlacement(found);
    setPlace(suggestedPlace(found, request, fixedEpicId));
    setStep("choose");
  };

  const planGoal = async () => {
    const token = ++planning.current;
    setStep("planning");
    try {
      const result = await window.memcode.planGoal({
        projectId: project.id,
        request,
        harness,
      });
      if (token !== planning.current) return;
      setPlan(result);
      setStep("plan");
      if (result.fallback)
        props.notify(
          `${harnessNames[harness]}'s plan couldn't be read, so this starts as one task. Add more if you like.`,
        );
    } catch (error) {
      if (token !== planning.current) return;
      props.notify((error as Error).message);
      setStep("choose");
    }
  };

  const createTask = (input: {
    title: string;
    description: string;
    epicId: string | null;
  }) =>
    window.memcode.createTask({
      projectId: project.id,
      title: input.title,
      description: input.description,
      epicId: input.epicId,
      priority: "medium",
      harness: props.defaultHarness,
      assignment: "auto",
      ...(props.statusId ? { statusId: props.statusId } : {}),
    });

  const addTask = async (start: boolean) => {
    setBusy(true);
    try {
      const task = await createTask({
        title: taskDraftTitle("", request),
        description: request.trim(),
        epicId: place.kind === "goal" ? place.epicId : null,
      });
      if (start) await window.memcode.startWorker(task.id);
      props.onCreated(task);
    } catch (error) {
      props.notify((error as Error).message);
      setBusy(false);
    }
  };

  const createGoal = async (start: boolean) => {
    if (!plan) return;
    setBusy(true);
    try {
      const epic = await window.memcode.createEpic({
        projectId: project.id,
        title: plan.title.trim() || taskDraftTitle("", request),
        description: request.trim(),
        phase: "now",
      });
      const tasks: WorkItem[] = [];
      for (const item of plan.tasks.filter((task) => task.title.trim()))
        tasks.push(
          await createTask({
            title: item.title.trim(),
            description: item.brief.trim() || item.title.trim(),
            epicId: epic.id,
          }),
        );
      if (start)
        for (const task of tasks) await window.memcode.startWorker(task.id);
      if (tasks[0]) props.onCreated(tasks[0]);
      else props.onClose();
    } catch (error) {
      props.notify((error as Error).message);
      setBusy(false);
    }
  };

  const heading = fixed
    ? `Add a task to “${fixed.title}”`
    : step === "plan"
      ? "Review the plan"
      : "What do you want to get done?";
  return (
    <Modal
      title={heading}
      kicker="New work"
      description={
        step === "write"
          ? fixed
            ? "Describe the change. It joins this goal's branch and coordinates with its tasks."
            : "Describe it in a sentence. MemCode finds the goal it belongs to, or starts a new one."
          : undefined
      }
      close={props.onClose}
      wide
    >
      {step === "write" && (
        <WriteStep
          request={request}
          onChange={setRequest}
          onContinue={() => void continueToPlace()}
          onAdvanced={props.onAdvanced}
          onClose={props.onClose}
        />
      )}
      {step === "placing" && (
        <Waiting text="Checking which code this touches and which goals are already changing it…" />
      )}
      {step === "planning" && (
        <Waiting
          text={`${harnessNames[harness]} is planning this goal. This can take a minute.`}
          onCancel={() => {
            planning.current++;
            setStep("choose");
          }}
        />
      )}
      {step === "choose" && (
        <ChooseStep
          request={request}
          goals={goals}
          fixed={fixed}
          placement={placement}
          place={place}
          onPlace={setPlace}
          harness={harness}
          connected={props.connected}
          onHarness={setHarness}
          busy={busy}
          onEdit={() => setStep("write")}
          onAdd={(start) => void addTask(start)}
          onPlan={() => void planGoal()}
        />
      )}
      {step === "plan" && plan && (
        <PlanStep
          plan={plan}
          onChange={setPlan}
          busy={busy}
          onBack={() => setStep("choose")}
          onCreate={(start) => void createGoal(start)}
        />
      )}
    </Modal>
  );
}

function WriteStep(props: {
  request: string;
  onChange: (value: string) => void;
  onContinue: () => void;
  onAdvanced: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="modal-body nw-body">
        <textarea
          className="nw-ask"
          autoFocus
          aria-label="What do you want to get done?"
          placeholder="e.g. People get logged out on every deploy. Keep sessions alive and let them sign out other devices."
          value={props.request}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              props.onContinue();
            }
          }}
        />
      </div>
      <footer className="modal-footer">
        <button className="nw-link" type="button" onClick={props.onAdvanced}>
          More options
        </button>
        <div className="nw-actions">
          <button className="button secondary" type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            disabled={!props.request.trim()}
            onClick={props.onContinue}
          >
            Continue <kbd>⌘↵</kbd>
          </button>
        </div>
      </footer>
    </>
  );
}

function Waiting({ text, onCancel }: { text: string; onCancel?: () => void }) {
  return (
    <div className="modal-body nw-body">
      <div className="nw-waiting">
        <Spinner size={14} />
        <span>{text}</span>
        {onCancel && (
          <button className="nw-link" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function ChooseStep(props: {
  request: string;
  goals: Epic[];
  fixed?: Epic;
  placement: Placement;
  place: Place;
  onPlace: (place: Place) => void;
  harness: Harness;
  connected: Harness[];
  onHarness: (harness: Harness) => void;
  busy: boolean;
  onEdit: () => void;
  onAdd: (start: boolean) => void;
  onPlan: () => void;
}) {
  const { placement, place } = props;
  const match = props.fixed
    ? undefined
    : placement.goals
        .map((found) => ({
          found,
          goal: props.goals.find((goal) => goal.id === found.epicId),
        }))
        .find((item) => item.goal);
  const target = props.fixed ?? match?.goal;
  const others = props.goals.filter(
    (goal) => goal.id !== target?.id && !isQuickChanges(goal),
  );
  const chosenGoal =
    place.kind === "goal"
      ? props.goals.find((goal) => goal.id === place.epicId)
      : undefined;
  const canPlan = props.connected.length > 0;
  return (
    <>
      <div className="modal-body nw-body">
        <div className="nw-said">
          <span>{props.request}</span>
          <button className="nw-link" type="button" onClick={props.onEdit}>
            Edit
          </button>
        </div>
        <div className="nw-label">Where it goes</div>
        <div className="nw-places">
          {target && (
            <PlaceOption
              selected={place.kind === "goal" && place.epicId === target.id}
              onSelect={() => props.onPlace({ kind: "goal", epicId: target.id })}
              title={`Add to “${target.title}”`}
              suggested
            >
              {match ? (
                <>
                  It touches <code>{match.found.shared[0]}</code>
                  {match.found.shared.length > 1
                    ? ` and ${match.found.shared.length - 1} more ${match.found.shared.length === 2 ? "file" : "files"}`
                    : ""}
                  , which this goal is already changing. Same branch, so the agents coordinate instead of conflicting.
                </>
              ) : (
                "It joins this goal's branch and coordinates with its tasks."
              )}
            </PlaceOption>
          )}
          {chosenGoal && chosenGoal.id !== target?.id && (
            <PlaceOption selected onSelect={() => {}} title={`Add to “${chosenGoal.title}”`}>
              It joins this goal's branch and coordinates with its tasks.
            </PlaceOption>
          )}
          <PlaceOption
            selected={place.kind === "quick"}
            onSelect={() => props.onPlace({ kind: "quick" })}
            title="Quick change"
            suggested={!target && place.kind === "quick"}
          >
            A small change that ships with your other quick changes in one pull request. It can start right away.
          </PlaceOption>
          <PlaceOption
            selected={place.kind === "new"}
            onSelect={() => props.onPlace({ kind: "new" })}
            title="New goal"
            suggested={!target && place.kind === "new"}
          >
            {canPlan ? (
              <span className="nw-plan-with">
                Its own branch and pull request.
                <span>
                  Plan the tasks with
                  <Select
                    aria-label="Plan with"
                    value={props.harness}
                    onValueChange={(value) => props.onHarness(value as Harness)}
                  >
                    {props.connected.map((item) => (
                      <option key={item} value={item}>
                        {harnessNames[item]}
                      </option>
                    ))}
                  </Select>
                </span>
              </span>
            ) : (
              "Its own branch and pull request. Connect a worker in Workers to plan its tasks."
            )}
          </PlaceOption>
        </div>
        {!props.fixed && others.length > 0 && (
          <div className="nw-others">
            <span>Or add to</span>
            {others.map((goal) => (
              <button
                key={goal.id}
                type="button"
                className={"nw-chip" + (place.kind === "goal" && place.epicId === goal.id ? " on" : "")}
                onClick={() => props.onPlace({ kind: "goal", epicId: goal.id })}
              >
                <Flag size={11} />
                {goal.title}
              </button>
            ))}
          </div>
        )}
      </div>
      <footer className="modal-footer">
        <span className="nw-hint">One goal is one branch and one pull request.</span>
        <div className="nw-actions">
          {place.kind === "new" ? (
            <button
              className="button primary"
              type="button"
              disabled={!canPlan || props.busy}
              onClick={props.onPlan}
            >
              <Sparkles size={13} />
              Plan goal
            </button>
          ) : (
            <>
              <button
                className="button secondary"
                type="button"
                disabled={props.busy}
                onClick={() => props.onAdd(false)}
              >
                Add task
              </button>
              <button
                className="button primary"
                type="button"
                disabled={props.busy}
                onClick={() => props.onAdd(true)}
              >
                {props.busy && <Spinner size={12} />}
                Add and start
              </button>
            </>
          )}
        </div>
      </footer>
    </>
  );
}

function PlaceOption(props: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  suggested?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role="radio"
      tabIndex={0}
      aria-checked={props.selected}
      className={"nw-place" + (props.selected ? " on" : "")}
      onClick={props.onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onSelect();
        }
      }}
    >
      <span className="nw-radio" />
      <span>
        <span className="nw-place-title">
          {props.title}
          {props.suggested && <span className="nw-suggested">Suggested</span>}
        </span>
        <span className="nw-why">{props.children}</span>
      </span>
    </div>
  );
}

function PlanStep(props: {
  plan: GoalPlan;
  onChange: (plan: GoalPlan) => void;
  busy: boolean;
  onBack: () => void;
  onCreate: (start: boolean) => void;
}) {
  const { plan } = props;
  const setTasks = (tasks: PlannedTask[]) => props.onChange({ ...plan, tasks });
  const many = plan.tasks.length > 1;
  return (
    <>
      <div className="modal-body nw-body">
        <label className="field">
          <span>Goal</span>
          <input
            value={plan.title}
            onChange={(event) => props.onChange({ ...plan, title: event.target.value })}
          />
        </label>
        <div className="nw-plan-head">
          <span className="nw-label">{many ? "Tasks" : "One task"}</span>
          <span className="nw-model">
            Planned by {harnessNames[plan.harness]}
            {plan.model ? ` · ${plan.model}` : ""}
          </span>
        </div>
        <div className="nw-tasks">
          {plan.tasks.map((task, index) => (
            <div className="nw-task" key={index}>
              <span className="nw-num">{index + 1}</span>
              <span className="nw-task-main">
                <input
                  aria-label={`Task ${index + 1}`}
                  value={task.title}
                  onChange={(event) =>
                    setTasks(
                      plan.tasks.map((item, at) =>
                        at === index ? { ...item, title: event.target.value } : item,
                      ),
                    )
                  }
                />
                {task.brief && task.brief !== task.title && (
                  <span className="nw-brief">{task.brief}</span>
                )}
                {task.files.length > 0 && (
                  <span className="nw-files">
                    {task.files.slice(0, 4).map((file) => (
                      <code key={file}>{file}</code>
                    ))}
                  </span>
                )}
              </span>
              {many && (
                <button
                  className="nw-remove"
                  type="button"
                  aria-label={`Remove task ${index + 1}`}
                  onClick={() => setTasks(plan.tasks.filter((_, at) => at !== index))}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="nw-plan-actions">
          <button
            className="nw-link"
            type="button"
            onClick={() => setTasks([...plan.tasks, { title: "", brief: "", files: [] }])}
          >
            <Plus size={12} />
            Add a task
          </button>
          {many && (
            <button
              className="nw-link"
              type="button"
              onClick={() =>
                setTasks([
                  {
                    title: plan.title,
                    brief: plan.tasks.map((task) => task.title).join("\n"),
                    files: [...new Set(plan.tasks.flatMap((task) => task.files))],
                  },
                ])
              }
            >
              Make it one task
            </button>
          )}
        </div>
        {many && (
          <div className="nw-teach">
            <ArrowLeftRight size={13} />
            <span>
              These tasks run in parallel on one branch. Where they touch the same code, Fleet coordinates them, so the goal ends in one clean pull request.
            </span>
          </div>
        )}
      </div>
      <footer className="modal-footer">
        <button className="nw-link" type="button" onClick={props.onBack}>
          Back
        </button>
        <div className="nw-actions">
          <button
            className="button secondary"
            type="button"
            disabled={props.busy}
            onClick={() => props.onCreate(false)}
          >
            Create goal
          </button>
          <button
            className="button primary"
            type="button"
            disabled={props.busy}
            onClick={() => props.onCreate(true)}
          >
            {props.busy && <Spinner size={12} />}
            {many ? `Create and start ${plan.tasks.length} agents` : "Create and start"}
          </button>
        </div>
      </footer>
    </>
  );
}
