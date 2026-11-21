import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Folder,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  Plug,
  ScanLine,
  Sparkles,
  X,
} from "lucide-react";
import type { AppState, Project, Epic } from "../shared";
import type {
  GuideAction,
  OnboardingPatch,
  OnboardingProgress,
} from "../onboarding";
import { Modal } from "./Dialogs";
import { InstallWelcome } from "./InstallWelcome";
import { BetaAccess } from "./BetaAccess";
import { LocalToolsGuide } from "./LocalToolsGuide";
import { previousGuideStep } from "../onboarding";
import { timings, type Timing } from "../new-work";
import "../styles-onboarding.css";

const firstWork = {
  number: 5,
  title: "What do you want to get done?",
  body: "Say it in your own words. Your worker turns it into a plan you can check, and you decide what happens now and what waits.",
  button: "Plan your first work",
  target: "[data-guide=new-story]",
};

const copy = {
  project: {
    number: 1,
    title: "Give your idea a home.",
    body: "Open a code folder or start a new project. Everything you want to get done lives here.",
    button: "Create or open a project",
    target: "[data-guide=project-picker]",
  },
  memtrace: {
    number: 2,
    title: "Understand the code first.",
    body: "Memtrace reads your code on this computer, so every task starts with the right context.",
    button: "Analyze this project",
    target: "[data-guide=project-picker]",
  },
  worker: {
    number: 3,
    title: "Choose a worker you trust.",
    body: "Connect the coding tool you already use. Pick its default permissions once; every new task uses them.",
    button: "Choose a worker",
    target: "[data-guide=worker-connections]",
  },
  "local-tools": {
    number: 4,
    title: "Make it work your way.",
    body: "Two optional ways to make the workspace yours. Add them now or come back in Settings.",
    button: "Continue to your first work",
  },
  /** Saved progress from before goals still says "epic"; it opens the same step. */
  epic: firstWork,
  story: firstWork,
  ready: {
    number: 5,
    title: "Meet your first task.",
    body: "Open it to talk to the worker, follow its changes and try what it built.",
    button: "Tour the task",
  },
  "code-review": {
    number: 6,
    title: "Review what changed.",
    body: "Finished work waits in Code review. Look it over, then accept it or ask the worker for a fix.",
    button: "Open the illustrated guide",
  },
};

/** How one sentence becomes work: small asks stay one task, bigger ones become a goal. */
function GoalsAndTasks() {
  return (
    <div className="guide-concept" aria-label="How requests become tasks and goals">
      <div className="guide-concept-row">
        <q>Fix the broken footer link</q>
        <ArrowRight size={12} aria-hidden />
        <span className="guide-concept-result">
          <strong>Quick change</strong>
          <small>1 task</small>
        </span>
      </div>
      <div className="guide-concept-row">
        <q>Let customers export their reports</q>
        <ArrowRight size={12} aria-hidden />
        <span className="guide-concept-result goal">
          <strong>Goal</strong>
          <small>3 tasks, side by side</small>
        </span>
      </div>
      <p>
        A <b>task</b> is one piece of work for one worker. A <b>goal</b> is an
        outcome that takes a few tasks.
      </p>
      <div className="guide-concept-when" aria-label="When each goal happens">
        {(Object.keys(timings) as Timing[]).map((timing) => (
          <span key={timing}>
            <strong>{timings[timing].name}</strong>
            <small>{timings[timing].meaning}</small>
          </span>
        ))}
      </div>
      <p>Only Now work starts. Next and Later goals wait on the Roadmap.</p>
    </div>
  );
}

export function Onboarding({
  progress,
  state,
  project,
  connected,
  memtraceConnected = false,
  hidden,
  onUpdate,
  onAction,
  onDocs,
  notify,
}: {
  progress: OnboardingProgress;
  state: AppState;
  project: Project;
  /** Kept for callers; the first-work step no longer asks for a goal up front. */
  epics?: Epic[];
  connected: boolean;
  memtraceConnected?: boolean;
  hidden: boolean;
  onUpdate: (patch: OnboardingPatch) => void;
  onAction: (action: GuideAction) => void;
  onDocs: () => void;
  needsEngine?: boolean;
  notify: (message: string) => void;
}) {
  const step = progress.step === "epic" ? "story" : progress.step;
  const laneId = state.reviewWorkflows?.[project.id]?.codeReviewStatusId;
  const [bounds, setBounds] = useState<DOMRect>();
  useEffect(() => {
    if (step === "welcome" || step === "context" || hidden) return;
    const selector =
      step === "ready"
        ? progress.storyId &&
          `[data-work-item="${CSS.escape(progress.storyId)}"]`
        : step === "code-review"
          ? laneId && `[data-work-group="${CSS.escape(laneId)}"]`
          : "target" in copy[step]
            ? (copy[step].target as string)
            : undefined;
    if (!selector) {
      setBounds(undefined);
      return;
    }
    const update = () =>
      setBounds(document.querySelector(selector)?.getBoundingClientRect());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step, hidden, laneId, progress.storyId]);
  if (progress.dismissed || progress.completedAt) return null;
  if (hidden && (step === "welcome" || step === "context")) return null;
  const preference = (
    <label className="guide-auto-preference">
      <input
        type="checkbox"
        checked={state.onboardingPreferences?.showForNewProjects === false}
        onChange={(event) =>
          onUpdate({ showForNewProjects: !event.target.checked })
        }
      />
      <span>Don’t open this guide automatically for new projects.</span>
    </label>
  );
  const pause = () => onUpdate({ dismissed: true });

  if (step === "welcome")
    return (
      <Modal
        title="Make your first idea real."
        kicker="WELCOME TO MEMCODE"
        description="Your code. Your workers. A clear place to begin."
        close={pause}
        wide
      >
        <InstallWelcome
          preference={preference}
          onSkip={pause}
          onContinue={() => onUpdate({ step: "project", dismissed: false })}
        />
      </Modal>
    );

  if (step === "context") {
    const shared = state.team?.some((item) => item.projectId === project.id);
    const stories = state.tasks.filter(
      (item) => item.projectId === project.id && !item.example,
    ).length;
    return (
      <Modal
        title={`Set up ${project.name}.`}
        kicker="YOUR PROJECT, YOUR PACE"
        description="A little context. The right worker. Then your first piece of work."
        close={pause}
        wide
      >
        <div className="project-guide-welcome">
          <div className="project-guide-source">
            <span className="project-guide-folder">
              <Folder size={23} />
            </span>
            <div>
              <strong>{project.name}</strong>
              <span>
                {project.path ? (
                  <>
                    <GitBranch size={11} /> {project.branch} · Local source
                  </>
                ) : shared ? (
                  "Shared board · Local source is optional"
                ) : (
                  "Planning workspace"
                )}
              </span>
            </div>
            <small>{shared ? "TEAM PROJECT" : "ON THIS DEVICE"}</small>
          </div>
          {project.description && (
            <p className="project-guide-brief">{project.description}</p>
          )}
          <div className="project-guide-path" aria-label="Project setup steps">
            {[
              {
                icon: Plug,
                label: "Connect",
                detail: "Your account, code and coding tool.",
              },
              {
                icon: MessageSquare,
                label: "Build",
                detail: "Say what you want. Your workers do the tasks.",
              },
              {
                icon: ScanLine,
                label: "Review",
                detail: "See the change and decide what’s ready.",
              },
            ].map(({ icon: Icon, label, detail }, index) => (
              <div key={label} className={index === 0 ? "current" : ""}>
                <span>
                  <Icon size={17} />
                </span>
                <small>{String(index + 1).padStart(2, "0")}</small>
                <strong>{label}</strong>
                <p>{detail}</p>
              </div>
            ))}
          </div>
          <p className="project-guide-expectation">
            {shared
              ? "Your team’s current board is already here. Connect a local checkout when you want to work on the code."
              : stories
                ? "Your existing work stays on the board. This guide only helps connect the essentials for this project."
                : "Your board starts empty. Setup won’t add goals, tasks or cycles for you."}
          </p>
          <details className="project-guide-options">
            <summary>Setup preferences</summary>
            {preference}
          </details>
          <footer>
            <button className="button secondary" onClick={pause}>
              Skip for now
            </button>
            <button
              className="button primary"
              onClick={() => onUpdate({ step: "memtrace" })}
            >
              {project.path ? "Connect code context" : "Continue setup"}
              <ArrowRight size={14} />
            </button>
          </footer>
          <small className="guide-reopen-note">
            This project remembers your place. Reopen setup from Docs at any
            time.
          </small>
        </div>
      </Modal>
    );
  }

  const item = copy[step];
  const story = state.tasks.find(
    (entry) => entry.id === progress.storyId && entry.projectId === project.id,
  );
  const existingStory = state.tasks.find(
    (entry) =>
      entry.projectId === project.id &&
      !entry.example &&
      !entry.archivedAt &&
      (!progress.epicId || entry.epicId === progress.epicId),
  );
  const analyzing = ["connecting", "indexing"].includes(project.analysis);
  const contextReady = project.analysis === "ready" && memtraceConnected;
  const phase = step === "code-review" ? 2 : item.number === 5 ? 1 : 0;
  return (
    <>
      {!hidden && bounds && bounds.width > 0 && (
        <div
          className="onboarding-spotlight"
          aria-hidden
          style={{
            left: bounds.x - 5,
            top: bounds.y - 5,
            width: bounds.width + 10,
            height: bounds.height + 10,
          }}
        />
      )}
      <aside
        className={"onboarding-guide " + (hidden ? "suspended" : "")}
        aria-label="Getting started guide"
      >
        <header>
          <span>
            <Sparkles size={12} />
            {project.example ? "GETTING STARTED" : project.name}
          </span>
          <button
            className="icon-button"
            aria-label="Skip this project’s setup for now"
            onClick={pause}
          >
            <X size={14} />
          </button>
        </header>
        <ol
          className="guide-progress"
          aria-label={`Setup stage ${phase + 1} of 3`}
        >
          {["Connect", "Build", "Review"].map((label, index) => (
            <li
              key={label}
              className={index <= phase ? "complete" : ""}
              aria-current={index === phase ? "step" : undefined}
            >
              {index < phase ? <Check size={11} /> : <span>{index + 1}</span>}
              {label}
            </li>
          ))}
        </ol>
        <div className="guide-step-copy" key={step}>
          <small>
            {step === "local-tools"
              ? "OPTIONAL · ON THIS COMPUTER"
              : [
                  "CONNECT YOUR WORKSPACE",
                  "YOUR FIRST PIECE OF WORK",
                  "READY WHEN YOU ARE",
                ][phase]}
          </small>
          <h2>{item.title}</h2>
          <p>{item.body}</p>
          {step === "memtrace" ? (
            <>
              {!project.path ? (
                <>
                  <button
                    className="button primary"
                    onClick={() => onAction("team")}
                  >
                    Connect local code
                    <ArrowRight size={13} />
                  </button>
                  <button
                    className="guide-use-existing"
                    onClick={() => onUpdate({ step: "worker" })}
                  >
                    Keep planning without local code
                    <ArrowRight size={12} />
                  </button>
                </>
              ) : (
                <>
                  {!memtraceConnected && (
                    <BetaAccess notify={notify} existingCLI />
                  )}
                  {analyzing && (
                    <div className="guide-analysis-status" role="status">
                      <LoaderCircle size={15} />
                      <span>
                        {project.analysisNote ||
                          "Analyzing this project’s code…"}
                      </span>
                    </div>
                  )}
                  {project.analysis === "error" && (
                    <p className="guide-analysis-error" role="status">
                      {project.analysisNote ||
                        "Code context needs attention. You can retry or return later."}
                    </p>
                  )}
                  {contextReady ? (
                    <>
                      <div className="guide-analysis-status ready">
                        <Check size={15} />
                        <span>Code context connected</span>
                      </div>
                      <button
                        className="button primary"
                        onClick={() => {
                          onUpdate({ step: "worker" });
                          onAction("worker");
                        }}
                      >
                        Choose a worker
                        <ArrowRight size={13} />
                      </button>
                    </>
                  ) : (
                    memtraceConnected &&
                    !analyzing && (
                      <button
                        className="button primary"
                        onClick={() => onAction("analyze")}
                      >
                        {project.analysis === "error"
                          ? "Retry analysis"
                          : "Analyze this project"}
                        <ArrowRight size={13} />
                      </button>
                    )
                  )}
                </>
              )}
            </>
          ) : step === "local-tools" ? (
            <>
              <LocalToolsGuide hidden={hidden} onAction={onAction} />
              <button
                className="button primary"
                onClick={() => onUpdate({ step: "story" })}
              >
                {item.button} <ArrowRight size={13} />
              </button>
            </>
          ) : step === "code-review" ? (
            <>
              <div className="guide-review-preview">
                <ScanLine size={18} aria-hidden />
                <span>
                  <strong>Understand the change.</strong>
                  <small>Before &amp; after · Findings · Verification</small>
                </span>
              </div>
              <button
                className="button primary"
                onClick={() => onUpdate({ complete: true })}
              >
                Finish setup <Check size={13} />
              </button>
              <button
                className="guide-use-existing"
                onClick={() => onAction("review-docs")}
              >
                See how Code review works <ArrowRight size={12} />
              </button>
              {story && (
                <button
                  className="guide-use-existing"
                  onClick={() => onAction("view-review")}
                >
                  Show Code review on my task <ArrowRight size={12} />
                </button>
              )}
            </>
          ) : (
            <button
              className="button primary"
              onClick={() => {
                if (step === "ready" && !story)
                  onUpdate({ step: "code-review" });
                else if (step === "worker" && connected)
                  onUpdate({ step: "local-tools" });
                else onAction(step === "ready" ? "open-story" : step);
              }}
            >
              {step === "ready" && !story
                ? "Continue to Code review"
                : step === "worker" && connected
                  ? "Continue"
                  : item.button}
              <ArrowRight size={13} />
            </button>
          )}
          {step === "project" && !project.example && (
            <button
              className="guide-use-existing"
              onClick={() =>
                onUpdate({ step: "context", projectId: project.id })
              }
            >
              <Check size={12} />
              Use {project.name}
            </button>
          )}
          {step === "worker" && (
            <details className="guide-permissions-help">
              <summary>Which permission level should I choose?</summary>
              <p>
                Smart auto handles routine approvals where supported. Standard
                asks using the tool’s normal rules. Full access bypasses tool
                approvals and supported sandboxes. Your default is saved for
                future tasks.
              </p>
            </details>
          )}
          {step === "worker" && connected && (
            <button
              className="guide-use-existing"
              onClick={() => onAction("worker")}
            >
              <Check size={12} />
              Review worker settings
            </button>
          )}
          {step === "story" && <GoalsAndTasks />}
          {step === "story" && existingStory && (
            <button
              className="guide-use-existing"
              onClick={() =>
                onUpdate({
                  step: "ready",
                  storyId: existingStory.id,
                  epicId: existingStory.epicId ?? undefined,
                })
              }
            >
              <MessageSquare size={12} /> Tour {existingStory.identifier}
            </button>
          )}
          {(step === "story" || (step === "ready" && story)) && (
            <button
              className="guide-use-existing"
              onClick={() => onUpdate({ step: "code-review" })}
            >
              Continue to Code review <ArrowRight size={12} />
            </button>
          )}
          {(step === "story" || step === "ready") && (
            <button
              className="guide-use-existing"
              onClick={() => onUpdate({ complete: true })}
            >
              <Check size={12} />
              {story ? "Finish setup" : "Finish setup · add work later"}
            </button>
          )}
        </div>
        <details className="guide-options">
          <summary>Setup preferences</summary>
          {preference}
          <p>
            “Skip for now” only closes this project’s guide. You can reopen it
            from Docs.
          </p>
          <button
            className="guide-privacy-link"
            onClick={() => onAction("account")}
          >
            Privacy &amp; usage preferences <ArrowRight size={11} />
          </button>
          <p>Optional usage reports are off by default.</p>
        </details>
        <footer>
          {previousGuideStep(step) ? (
            <button onClick={() => onUpdate({ step: previousGuideStep(step) })}>
              Back
            </button>
          ) : (
            <button onClick={pause}>Skip for now</button>
          )}
          <button onClick={onDocs}>
            Quick start <ArrowRight size={10} />
          </button>
        </footer>
      </aside>
    </>
  );
}
