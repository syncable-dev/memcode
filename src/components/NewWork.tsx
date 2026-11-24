import { useEffect, useRef, useState } from "react";
import { Check, Flag, ListChecks, Plus, X, Zap } from "lucide-react";
import {
  harnessNames,
  type Epic,
  type Harness,
  type Project,
  type WorkItem,
} from "../shared";
import {
  requestAsPlan,
  type Placement,
  type PlannedGoal,
  type PlannedTask,
  type WorkDraft,
} from "../goal-plan";
import {
  placementQuery,
  goalDescription,
  startEach,
  startsNow,
  startsWithinLimit,
  suggestedPlaces,
  suggestedTimings,
  thinkingSteps,
  timings,
  type ThinkingProgress,
  type Place,
  type Timing,
} from "../new-work";
import { isQuickChanges } from "../domain";
import { taskDraftTitle } from "../task-draft";
import { withAttachments, type Attachment } from "../attachments";
import {
  AttachButton,
  AttachedFiles,
  useAttach,
  type Attach,
} from "./Attachments";
import { Modal } from "./Dialogs";
import { Select } from "./Select";
import { Spinner } from "./UI";
import "../styles-new-work.css";

interface Props {
  project: Project;
  /** Open goals in this project; shipped goals take no new work. */
  goals: Epic[];
  defaultHarness: Harness;
  /** Harnesses the person connected in Workers; one of them plans, and starting needs one. */
  connected: Harness[];
  fixedEpicId?: string;
  statusId?: string;
  /** What the request starts as, such as a report from the Inbox. */
  initialRequest?: string;
  /** The files it starts with, as they are got. */
  initialFiles?: (
    add: (file: Attachment) => void,
    starting: () => boolean,
  ) => Promise<void>;
  onClose: () => void;
  onCreated: (task: WorkItem) => void;
  /** More options, with what was written and attached so far. */
  onAdvanced: (request: string, files: Attachment[]) => void;
  onConnectWorkers: () => void;
  /** Workers that can start right now, and the most that run at once (Settings). */
  freeSlots: number;
  workerLimit: number;
  notify: (message: string) => void;
}

type Step = "write" | "thinking" | "review";

const nothingPlaced: Placement = { files: [], goals: [] };
/** A task's declared scope holds at most this many files. */
const maximumScope = 20;

/** One door for new work: say what you want, a worker plans it, the plan decides where it goes. */
export function NewWork(props: Props) {
  const { project, goals, fixedEpicId } = props;
  const [step, setStep] = useState<Step>("write");
  const [request, setRequest] = useState(props.initialRequest ?? "");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [gathering, setGathering] = useState(!!props.initialFiles);
  const attach = useAttach(files, setFiles, props.notify);
  const { initialFiles } = props;
  useEffect(() => {
    if (!initialFiles) return;
    let open = true;
    initialFiles(
      (file) => {
        if (open) setFiles((known) => withAttachments(known, [file]));
      },
      () => open,
    )
      .catch((error: Error) => props.notify(error.message))
      .finally(() => {
        if (open) setGathering(false);
      });
    return () => {
      open = false;
    };
    // Once: the composer is opened anew for each report.
  }, []);
  const [planner, setPlanner] = useState<Harness | undefined>(
    props.connected.includes(props.defaultHarness)
      ? props.defaultHarness
      : props.connected[0],
  );
  const [requestPlacement, setRequestPlacement] =
    useState<Placement>(nothingPlaced);
  const [draft, setDraft] = useState<WorkDraft>();
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [timings, setTimings] = useState<Timing[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<
    ThinkingProgress & { since: number }
  >({
    planned: false,
    since: 0,
  });
  const thinking = useRef(0);
  const fixed = goals.find((goal) => goal.id === fixedEpicId);

  const place = (text: string) =>
    window.memcode.placeWork(project.id, text).catch(() => nothingPlaced);

  const planWith = async (harness: Harness | undefined): Promise<WorkDraft> => {
    if (!harness) return requestAsPlan(request);
    try {
      return await window.memcode.planGoal({
        projectId: project.id,
        request,
        harness,
        ...(files.length ? { attachments: files } : {}),
      });
    } catch (error) {
      props.notify((error as Error).message);
      return { ...requestAsPlan(request), fallback: true, harness, model: "" };
    }
  };

  /** One goal is placed by the request; several are each placed by their own tasks. */
  const placementsFor = (planned: WorkDraft, forRequest: Placement) =>
    planned.goals.length === 1
      ? Promise.resolve([forRequest])
      : Promise.all(planned.goals.map((goal) => place(placementQuery(goal))));

  const show = (planned: WorkDraft, found: Placement[]) => {
    setDraft(planned);
    setPlacements(found);
    const suggested = suggestedPlaces({
      placements: found,
      draft: planned,
      request,
      fixedEpicId,
    });
    setPlaces(suggested);
    setTimings(suggestedTimings(suggested));
  };

  const think = async () => {
    if (!request.trim()) return;
    const token = ++thinking.current;
    const current = (update: Partial<ThinkingProgress>) =>
      token === thinking.current &&
      setProgress((before) => ({ ...before, ...update }));
    setProgress({ planned: false, since: Date.now() });
    setStep("thinking");
    const [forRequest, planned] = await Promise.all([
      place(request).then((found) => {
        current({ files: found.files });
        return found;
      }),
      planWith(planner).then((plan) => {
        current({ planned: true });
        return plan;
      }),
    ]);
    const found = await placementsFor(planned, forRequest);
    if (token !== thinking.current) return;
    setRequestPlacement(forRequest);
    show(planned, found);
    setStep("review");
  };

  const editGoal = (index: number, goal: PlannedGoal) =>
    draft &&
    setDraft({
      ...draft,
      goals: draft.goals.map((item, at) => (at === index ? goal : item)),
    });
  const removeGoal = (index: number) => {
    if (!draft) return;
    const keep = (_: unknown, at: number) => at !== index;
    setDraft({ ...draft, goals: draft.goals.filter(keep) });
    setPlacements(placements.filter(keep));
    setPlaces(places.filter(keep));
    setTimings(timings.filter(keep));
  };
  const mergeGoals = () => {
    if (!draft) return;
    const merged: PlannedGoal = {
      title: taskDraftTitle("", request),
      tasks: draft.goals.flatMap((goal) => goal.tasks),
    };
    show({ ...draft, goals: [merged] }, [requestPlacement]);
  };

  const destination = async (
    goal: PlannedGoal,
    where: Place,
    timing: Timing,
  ): Promise<string | null> => {
    if (where.kind === "goal") return where.epicId;
    if (where.kind === "quick") return null;
    const epic = await window.memcode.createEpic({
      projectId: project.id,
      title: goal.title.trim() || taskDraftTitle("", request),
      description: goalDescription(
        goal,
        request,
        (draft?.goals.length ?? 1) > 1,
      ),
      phase: timing,
    });
    return epic.id;
  };

  const createTask = (item: PlannedTask, epicId: string | null) =>
    window.memcode.createTask({
      projectId: project.id,
      title: item.title.trim(),
      description: item.brief.trim() || item.title.trim(),
      runbook: item.steps,
      scope: item.files.slice(0, maximumScope),
      epicId,
      priority: "medium",
      harness: props.defaultHarness,
      assignment: "auto",
      ...(files.length ? { attachments: files } : {}),
      ...(props.statusId ? { statusId: props.statusId } : {}),
    });

  /** Workers prepare after the composer closes; their cards show each step as it happens. */
  const startInBackground = (tasks: WorkItem[]) =>
    void startEach(tasks, (id) => window.memcode.startWorker(id)).then(
      (failed) => {
        if (failed.length)
          props.notify(
            `Everything was added, but ${plural(failed.length, "task")} didn't start. ${failed.join(" ")}`,
          );
      },
    );

  /** Once anything exists the composer closes, so pressing again can never create it twice. */
  const create = async (start: boolean) => {
    if (!draft) return;
    setBusy(true);
    const created: Array<{ task: WorkItem; starts: boolean }> = [];
    let madeSomething = false;
    try {
      for (const [index, goal] of draft.goals.entries()) {
        const where = places[index] ?? { kind: "new" };
        const timing = timings[index] ?? "now";
        const epicId = await destination(goal, where, timing);
        madeSomething ||= where.kind === "new";
        for (const item of goal.tasks.filter((task) => task.title.trim())) {
          created.push({
            task: await createTask(item, epicId),
            starts: startsNow(where, timing),
          });
          madeSomething = true;
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      if (!madeSomething) {
        props.notify(message);
        setBusy(false);
        return;
      }
      props.notify(
        `Stopped partway, after adding ${plural(created.length, "task")}. ${message}`,
      );
    }
    if (created[0]) props.onCreated(created[0].task);
    else props.onClose();
    if (start)
      startInBackground(
        created
          .filter((item) => item.starts)
          .map((item) => item.task)
          .slice(0, props.freeSlots),
      );
  };

  const heading =
    step === "review"
      ? "Here's the plan"
      : step === "thinking"
        ? "Planning your work…"
        : fixed
          ? `Add to “${fixed.title}”`
          : "What do you want to get done?";
  return (
    <Modal
      title={heading}
      kicker="New work"
      description={
        step === "write"
          ? fixed
            ? "Describe the change. It joins this goal and works alongside its tasks."
            : "Describe it in your own words, as briefly or fully as you like. A small change becomes one task, bigger work becomes a goal, and separate outcomes become separate goals."
          : undefined
      }
      close={props.onClose}
      wide
    >
      {step === "write" && (
        <WriteStep
          request={request}
          onChange={setRequest}
          files={files}
          setFiles={setFiles}
          attach={attach}
          gathering={gathering}
          notify={props.notify}
          planner={planner}
          connected={props.connected}
          onPlanner={setPlanner}
          onConnectWorkers={props.onConnectWorkers}
          onContinue={() => void think()}
          onAdvanced={() => props.onAdvanced(request, files)}
          onClose={props.onClose}
        />
      )}
      {step === "thinking" && (
        <Thinking
          progress={{ ...progress, planner: planner && harnessNames[planner] }}
          onCancel={() => {
            thinking.current++;
            setStep("write");
          }}
        />
      )}
      {step === "review" && draft && (
        <ReviewStep
          request={request}
          draft={draft}
          placements={placements}
          places={places}
          timings={timings}
          onTiming={(index, timing) =>
            setTimings(
              timings.map((item, at) => (at === index ? timing : item)),
            )
          }
          goals={goals}
          fixed={fixed}
          canStart={props.connected.length > 0}
          freeSlots={props.freeSlots}
          workerLimit={props.workerLimit}
          busy={busy}
          onGoal={editGoal}
          onPlace={(index, where) =>
            setPlaces(places.map((item, at) => (at === index ? where : item)))
          }
          onRemove={removeGoal}
          onMerge={mergeGoals}
          onEdit={() => setStep("write")}
          onConnectWorkers={props.onConnectWorkers}
          onCreate={(start) => void create(start)}
        />
      )}
    </Modal>
  );
}

function WriteStep(props: {
  request: string;
  onChange: (value: string) => void;
  files: Attachment[];
  setFiles: (change: (files: Attachment[]) => Attachment[]) => void;
  attach: Attach;
  /** The report's files are still on their way. */
  gathering: boolean;
  notify: (message: string) => void;
  planner?: Harness;
  connected: Harness[];
  onPlanner: (harness: Harness) => void;
  onConnectWorkers: () => void;
  onContinue: () => void;
  onAdvanced: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div
        className={
          "modal-body nw-body" + (props.attach.over ? " attach-over" : "")
        }
        {...props.attach.drop}
      >
        <textarea
          className={"nw-ask" + (props.request.length > 200 ? " long" : "")}
          autoFocus
          aria-label="What do you want to get done?"
          placeholder="e.g. People get logged out on every deploy. Keep sessions alive and let them sign out other devices."
          value={props.request}
          onChange={(event) => props.onChange(event.target.value)}
          {...props.attach.paste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              props.onContinue();
            }
          }}
        />
        <div className="nw-attach">
          <AttachButton attach={props.attach} label="Attach files" />
          <span>
            {props.gathering ? (
              <>
                <Spinner size={12} /> Adding the report’s files
              </>
            ) : props.files.length ? (
              "Say what each file shows, if it isn’t obvious. Workers get the files and your notes."
            ) : (
              "Images, PDFs, spreadsheets, presentations or any file. Drop or paste them here too."
            )}
          </span>
        </div>
        <AttachedFiles
          items={props.files}
          setItems={props.setFiles}
          notify={props.notify}
          notes
        />
        <div className="nw-planner">
          {props.planner ? (
            <>
              <span>Planned by</span>
              <Select
                aria-label="Planned by"
                value={props.planner}
                onValueChange={(value) => props.onPlanner(value as Harness)}
              >
                {props.connected.map((item) => (
                  <option key={item} value={item}>
                    {harnessNames[item]}
                  </option>
                ))}
              </Select>
              <span>
                It reads the code and splits the work into tasks. Nothing is
                changed yet.
              </span>
            </>
          ) : (
            <>
              <span>
                No worker is connected, so this becomes one task you can edit.
              </span>
              <button
                className="nw-link"
                type="button"
                onClick={props.onConnectWorkers}
              >
                Connect a worker
              </button>
            </>
          )}
        </div>
      </div>
      <footer className="modal-footer">
        <button className="nw-link" type="button" onClick={props.onAdvanced}>
          More options
        </button>
        <div className="nw-actions">
          <button
            className="button secondary"
            type="button"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            disabled={
              !props.request.trim() ||
              props.gathering ||
              props.attach.adding > 0
            }
            onClick={props.onContinue}
          >
            {props.planner ? "Plan it" : "Continue"} <kbd>⌘↵</kbd>
          </button>
        </div>
      </footer>
    </>
  );
}

/** Ticks once a second so a long plan visibly moves. */
function useElapsed(since: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What's happening while a request is planned: the same steps for every worker. */
function Thinking(props: {
  progress: ThinkingProgress & { since: number };
  onCancel: () => void;
}) {
  const elapsed = useElapsed(props.progress.since);
  const steps = thinkingSteps(props.progress);
  return (
    <div className="modal-body nw-body">
      <ol className="nw-steps" aria-live="polite">
        {steps.map((step) => (
          <li key={step.label} className={step.state}>
            <span className="nw-step-mark" aria-hidden>
              {step.state === "done" ? (
                <Check size={12} />
              ) : step.state === "active" ? (
                <Spinner size={12} />
              ) : null}
            </span>
            <span className="nw-step-text">
              <span>{step.label}</span>
              {step.detail && <code>{step.detail}</code>}
            </span>
            {step.state === "active" && (
              <span className="nw-step-time">{elapsed}</span>
            )}
          </li>
        ))}
      </ol>
      <div className="nw-waiting">
        <span>
          {props.progress.planner
            ? `${props.progress.planner} reads your request and the related files, then splits the work into tasks. It changes nothing. This usually takes under a minute.`
            : "No worker is connected, so your request becomes one task you can edit."}
        </span>
        <button className="nw-link" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

function ReviewStep(props: {
  request: string;
  draft: WorkDraft;
  placements: Placement[];
  places: Place[];
  timings: Timing[];
  goals: Epic[];
  fixed?: Epic;
  canStart: boolean;
  freeSlots: number;
  workerLimit: number;
  busy: boolean;
  onGoal: (index: number, goal: PlannedGoal) => void;
  onPlace: (index: number, place: Place) => void;
  onTiming: (index: number, timing: Timing) => void;
  onRemove: (index: number) => void;
  onMerge: () => void;
  onEdit: () => void;
  onConnectWorkers: () => void;
  onCreate: (start: boolean) => void;
}) {
  const planned = props.draft.goals;
  const several = planned.length > 1;
  const count = planned
    .flatMap((goal) => goal.tasks)
    .filter((task) => task.title.trim()).length;
  const only = props.places[0] ?? { kind: "new" };
  const startable = planned
    .filter((_, index) =>
      startsNow(
        props.places[index] ?? { kind: "new" },
        props.timings[index] ?? "now",
      ),
    )
    .flatMap((goal) => goal.tasks)
    .filter((task) => task.title.trim()).length;
  const waiting = startable < count;
  const starts = startsWithinLimit({ startable, freeSlots: props.freeSlots });
  const canStartNow = props.canStart && starts.now > 0;
  const limited = props.canStart && starts.waiting > 0;
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const confirm = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      primary.current?.click();
    };
    window.addEventListener("keydown", confirm);
    return () => window.removeEventListener("keydown", confirm);
  }, []);
  return (
    <>
      <div className="modal-body nw-body nw-review">
        <div className="nw-asked">
          <div className="nw-asked-head">
            <span className="nw-label">You asked</span>
            <PlanSource
              draft={props.draft}
              onConnectWorkers={props.onConnectWorkers}
            />
          </div>
          <div className="nw-asked-text">
            <p title={props.request}>{props.request}</p>
            <button className="nw-link" type="button" onClick={props.onEdit}>
              Edit
            </button>
          </div>
        </div>
        {several && (
          <div className="nw-summary">
            <strong>
              {planned.length} separate outcomes · {plural(count, "task")}
            </strong>
            <span>Each one is placed on its own below.</span>
            <button className="nw-link" type="button" onClick={props.onMerge}>
              Make it one goal
            </button>
          </div>
        )}
        {planned.map((goal, index) => (
          <GoalCard
            key={index}
            goal={goal}
            onGoal={(next) => props.onGoal(index, next)}
            place={props.places[index] ?? { kind: "new" }}
            onPlace={(next) => props.onPlace(index, next)}
            timing={props.timings[index] ?? "now"}
            onTiming={(next) => props.onTiming(index, next)}
            placement={props.placements[index] ?? nothingPlaced}
            goals={props.goals}
            fixed={props.fixed}
            onRemove={several ? () => props.onRemove(index) : undefined}
          />
        ))}
      </div>
      <footer className="modal-footer">
        <button className="nw-link" type="button" onClick={props.onEdit}>
          Back
        </button>
        <div className="nw-actions">
          {!props.canStart && (
            <span className="nw-hint">Connect a worker to start it.</span>
          )}
          {limited ? (
            <span className="nw-hint">
              {starts.now
                ? `${plural(props.workerLimit, "worker")} can run at once, so ${plural(starts.waiting, "task")} will be ready to start after.`
                : `All ${plural(props.workerLimit, "worker")} are busy, so these will be ready to start after.`}
            </span>
          ) : (
            props.canStart &&
            waiting &&
            startable > 0 && (
              <span className="nw-hint">
                Next and Later goals wait on the Roadmap.
              </span>
            )
          )}
          <button
            ref={canStartNow ? undefined : primary}
            className={"button " + (canStartNow ? "secondary" : "primary")}
            type="button"
            disabled={props.busy || count === 0}
            onClick={() => props.onCreate(false)}
          >
            {!canStartNow && props.busy && <Spinner size={12} />}
            {several ? "Create all" : createLabel(only)}
            {!canStartNow && <kbd>⌘↵</kbd>}
          </button>
          {canStartNow && (
            <button
              ref={primary}
              className="button primary"
              type="button"
              disabled={props.busy}
              onClick={() => props.onCreate(true)}
            >
              {props.busy && <Spinner size={12} />}
              {limited
                ? `Create and start ${starts.now} of ${startable} now`
                : waiting
                  ? `Create and start ${plural(startable, "Now task")}`
                  : startLabel(several ? { kind: "new" } : only, count)}
              <kbd>⌘↵</kbd>
            </button>
          )}
        </div>
      </footer>
    </>
  );
}

/**
 * One planned piece of work as a card: what it is and when it happens up top, and its tasks on
 * a rail hanging from it, so the goal and the tasks that deliver it read as one thing.
 */
function GoalCard(props: {
  goal: PlannedGoal;
  onGoal: (goal: PlannedGoal) => void;
  place: Place;
  onPlace: (place: Place) => void;
  timing: Timing;
  onTiming: (timing: Timing) => void;
  placement: Placement;
  goals: Epic[];
  fixed?: Epic;
  onRemove?: () => void;
}) {
  const { goal, place } = props;
  const waits = place.kind === "new" && props.timing !== "now";
  const Mark = place.kind === "quick" ? Zap : Flag;
  return (
    <section className={`nw-goal ${place.kind}${waits ? " waits" : ""}`}>
      <header className="nw-goal-band">
        <span className="nw-goal-mark" aria-hidden>
          <Mark size={12} />
        </span>
        <div className="nw-goal-top">
          {props.fixed ? (
            <span className="nw-kind-fixed">{`Add to “${props.fixed.title}”`}</span>
          ) : (
            <Select
              className="nw-kind"
              aria-label={`Where “${goal.title}” goes`}
              value={placeValue(place)}
              onValueChange={(value) => props.onPlace(placeFrom(value))}
            >
              {placeOptions(props.goals, props.placement).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
          <span className="nw-goal-controls">
            {place.kind === "new" && (
              <TimingChoice
                goal={goal.title}
                value={props.timing}
                onChange={props.onTiming}
              />
            )}
            {props.onRemove && (
              <button
                className="nw-remove"
                type="button"
                aria-label={`Leave out “${goal.title}”`}
                title="Leave this out"
                onClick={props.onRemove}
              >
                <X size={13} />
              </button>
            )}
          </span>
        </div>
        {place.kind === "new" && (
          <input
            className="nw-goal-title"
            aria-label="Goal"
            placeholder="Name the outcome"
            value={goal.title}
            onChange={(event) =>
              props.onGoal({ ...goal, title: event.target.value })
            }
          />
        )}
        <PlaceReason
          goal={goal}
          place={place}
          timing={props.timing}
          placement={props.placement}
          goals={props.goals}
        />
      </header>
      <TaskRail goal={goal} onGoal={props.onGoal} />
    </section>
  );
}

/** The Roadmap's Now, Next and Later, chosen per new goal. */
function TimingChoice(props: {
  goal: string;
  value: Timing;
  onChange: (timing: Timing) => void;
}) {
  return (
    <div
      className="nw-timing"
      role="radiogroup"
      aria-label={`When to work on “${props.goal}”`}
    >
      {(Object.keys(timings) as Timing[]).map((timing) => (
        <button
          key={timing}
          type="button"
          role="radio"
          aria-checked={props.value === timing}
          className={props.value === timing ? "on" : ""}
          title={timings[timing].meaning}
          onClick={() => props.onChange(timing)}
        >
          {timings[timing].name}
        </button>
      ))}
    </div>
  );
}

const placeValue = (place: Place) =>
  place.kind === "goal" ? `goal:${place.epicId}` : place.kind;
const placeFrom = (value: string): Place =>
  value.startsWith("goal:")
    ? { kind: "goal", epicId: value.slice("goal:".length) }
    : { kind: value === "new" ? "new" : "quick" };

/** Goals that already change this code come first, then the other open goals. */
function placeOptions(goals: Epic[], placement: Placement) {
  const open = goals.filter((goal) => !isQuickChanges(goal));
  const matched = placement.goals
    .map((found) => open.find((goal) => goal.id === found.epicId))
    .filter((goal): goal is Epic => !!goal);
  const others = open.filter((goal) => !matched.includes(goal));
  return [
    { value: "quick", label: "Quick change" },
    { value: "new", label: "New goal" },
    ...[...matched, ...others].map((goal) => ({
      value: `goal:${goal.id}`,
      label: `Add to “${goal.title}”`,
    })),
  ];
}

function createLabel(place: Place) {
  if (place.kind === "new") return "Create goal";
  if (place.kind === "goal") return "Add to goal";
  return "Add";
}

function startLabel(place: Place, count: number) {
  const verb = place.kind === "new" ? "Create" : "Add";
  return count > 1 ? `${verb} and start ${count} agents` : `${verb} and start`;
}

function PlaceReason(props: {
  goal: PlannedGoal;
  placement: Placement;
  place: Place;
  timing: Timing;
  goals: Epic[];
}) {
  const { place } = props;
  const count = props.goal.tasks.filter((task) => task.title.trim()).length;
  if (place.kind === "quick")
    return (
      <span className="nw-why">
        It ships together with your other small changes.
      </span>
    );
  if (place.kind === "new" && props.timing !== "now")
    return (
      <span className="nw-why">
        {timings[props.timing].meaning} It waits on the Roadmap until you start
        it.
      </span>
    );
  if (place.kind === "new")
    return (
      <span className="nw-why">
        {timings.now.meaning}
        {count > 1
          ? ` Its ${count} tasks run side by side and stay coordinated.`
          : ""}
      </span>
    );
  const goal = props.goals.find((item) => item.id === place.epicId);
  const match = props.placement.goals.find(
    (found) => found.epicId === place.epicId,
  );
  if (!match)
    return (
      <span className="nw-why">
        It joins {goal ? `“${goal.title}”` : "this goal"} and works alongside
        its tasks.
      </span>
    );
  const more = match.shared.length - 1;
  return (
    <span className="nw-why">
      It touches <code>{match.shared[0]}</code>
      {more > 0 ? ` and ${more} more ${more === 1 ? "file" : "files"}` : ""},
      which this goal is already changing, so it joins in and the work stays
      coordinated.
    </span>
  );
}

function PlanSource(props: { draft: WorkDraft; onConnectWorkers: () => void }) {
  const { draft } = props;
  if (!("harness" in draft))
    return (
      <span className="nw-model">
        Your request as one task ·{" "}
        <button
          className="nw-link"
          type="button"
          onClick={props.onConnectWorkers}
        >
          Connect a worker
        </button>{" "}
        to have it planned
      </span>
    );
  if (draft.fallback)
    return (
      <span className="nw-model">
        {harnessNames[draft.harness]} couldn't plan this, so it's your request
        as one task
      </span>
    );
  return (
    <span className="nw-model">
      Planned by {harnessNames[draft.harness]}
      {draft.model ? ` · ${draft.model}` : ""}
    </span>
  );
}

const filesShown = 3;

/** A goal's tasks as numbered steps on a rail; each can be renamed, read in full or removed. */
function TaskRail(props: {
  goal: PlannedGoal;
  onGoal: (goal: PlannedGoal) => void;
}) {
  const { goal } = props;
  const [expanded, setExpanded] = useState<number | undefined>(
    goal.tasks.length === 1 ? 0 : undefined,
  );
  const setTasks = (tasks: PlannedTask[]) => props.onGoal({ ...goal, tasks });
  const many = goal.tasks.length > 1;
  const toggle = (index: number) =>
    setExpanded(expanded === index ? undefined : index);
  const rename = (index: number, title: string) =>
    setTasks(
      goal.tasks.map((item, at) => (at === index ? { ...item, title } : item)),
    );
  const mergeIntoOne = () =>
    setTasks([
      {
        title: goal.title,
        brief: goal.tasks.map((task) => task.title).join("\n"),
        files: [...new Set(goal.tasks.flatMap((task) => task.files))],
        steps: goal.tasks.map((task) => task.title),
      },
    ]);
  return (
    <ol className="nw-rail">
      {goal.tasks.map((task, index) => (
        <li
          className="nw-task"
          key={index}
          style={{ "--nw-order": index } as React.CSSProperties}
        >
          <span className="nw-node" aria-hidden>
            {index + 1}
          </span>
          <span className="nw-task-main">
            <input
              aria-label={`Task ${index + 1}`}
              placeholder="What should this task do?"
              autoFocus={!task.title && !task.brief}
              value={task.title}
              onChange={(event) => rename(index, event.target.value)}
            />
            {task.brief && task.brief !== task.title && (
              <button
                type="button"
                className="nw-brief"
                aria-expanded={expanded === index}
                title={expanded === index ? undefined : "Show the full brief"}
                onClick={() => toggle(index)}
              >
                {task.brief}
              </button>
            )}
            {(task.steps.length > 0 || task.files.length > 0) && (
              <span className="nw-task-meta">
                {task.steps.length > 0 && (
                  <button
                    type="button"
                    className="nw-steps-toggle"
                    aria-expanded={expanded === index}
                    title="The runbook the worker ticks off as it goes"
                    onClick={() => toggle(index)}
                  >
                    <ListChecks size={11} />
                    {plural(task.steps.length, "step")}
                  </button>
                )}
                {task.files.length > 0 && (
                  <span className="nw-files">
                    {task.files.slice(0, filesShown).map((file) => (
                      <code key={file}>{file}</code>
                    ))}
                    {task.files.length > filesShown && (
                      <code>+{task.files.length - filesShown}</code>
                    )}
                  </span>
                )}
              </span>
            )}
            {expanded === index && task.steps.length > 0 && (
              <ol
                className="nw-runbook"
                aria-label={`Runbook for task ${index + 1}`}
              >
                {task.steps.map((step, at) => (
                  <li key={at}>{step}</li>
                ))}
              </ol>
            )}
          </span>
          {many && (
            <button
              className="nw-remove"
              type="button"
              aria-label={`Remove task ${index + 1}`}
              title="Remove this task"
              onClick={() =>
                setTasks(goal.tasks.filter((_, at) => at !== index))
              }
            >
              <X size={13} />
            </button>
          )}
        </li>
      ))}
      <li className="nw-rail-end">
        <button
          className="nw-add"
          type="button"
          onClick={() =>
            setTasks([
              ...goal.tasks,
              { title: "", brief: "", files: [], steps: [] },
            ])
          }
        >
          <span className="nw-node" aria-hidden>
            <Plus size={12} />
          </span>
          Add a task
        </button>
        {many && (
          <button className="nw-link" type="button" onClick={mergeIntoOne}>
            Make it one task
          </button>
        )}
      </li>
    </ol>
  );
}
