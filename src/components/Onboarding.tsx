import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Folder,
  GitBranch,
  Layers3,
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
import "../styles-onboarding.css";

const copy = {
  project: {
    number: 1,
    title: "Give your idea a home.",
    body: "Open a code folder or start a new project. Your board is a place for the work you want to do.",
    button: "Create or open a project",
    target: "[data-guide=project-picker]",
  },
  memtrace: {
    number: 2,
    title: "Understand the code first.",
    body: "Memtrace reads your code locally. Your workers get relevant context, measured complexity and change impact.",
    button: "Analyze this project",
    target: "[data-guide=project-picker]",
  },
  worker: {
    number: 3,
    title: "Choose a worker you trust.",
    body: "Connect your coding tool with your approval. Choose its default permissions here, once, for future stories.",
    button: "Choose a worker",
    target: "[data-guide=worker-connections]",
  },
  "local-tools": {
    number: 4,
    title: "Make it work your way.",
    body: "Two optional ways to make the workspace yours. Add them now or come back in Settings.",
    button: "Continue to your first work",
  },
  epic: {
    number: 5,
    title: "What would you like to build?",
    body: "An epic holds a larger goal. Stories are the smaller changes that get you there. Start with either.",
    button: "Write an epic",
    target: "[data-guide=new-epic]",
  },
  story: {
    number: 5,
    title: "One clear request is enough.",
    body: "Describe what you want and how you’ll know it works. Save the story, then start its worker when you’re ready.",
    button: "Write a story",
    target: "[data-guide=new-story]",
  },
  ready: {
    number: 5,
    title: "Explore your story.",
    body: "Take a tour inside the card. See where to talk to the worker, inspect its edits and open what it built.",
    button: "Tour the story tabs",
  },
  "code-review": {
    number: 6,
    title: "Review what changed.",
    body: "Move finished work to Code review. Start the review inside the story to compare measurements and inspect findings before accepting the change.",
    button: "Open the illustrated guide",
  },
};

export function Onboarding({
  progress,
  state,
  project,
  epics,
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
  epics: Epic[];
  connected: boolean;
  memtraceConnected?: boolean;
  hidden: boolean;
  onUpdate: (patch: OnboardingPatch) => void;
  onAction: (action: GuideAction) => void;
  onDocs: () => void;
  needsEngine?: boolean;
  notify: (message: string) => void;
}) {
  const step = progress.step;
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
                detail: "One clear story. Your worker takes it from there.",
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
                : "Your board starts empty. Setup won’t add stories, epics or cycles for you."}
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

  const item = copy[step],
    selectedEpic =
      epics.find((entry) => entry.id === progress.epicId) ??
      epics.find((entry) => !entry.sourceKey);
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
                onClick={() => onUpdate({ step: "epic" })}
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
                  Show Code review on my story <ArrowRight size={12} />
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
                future stories.
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
          {step === "epic" && selectedEpic && (
            <button
              className="guide-use-existing"
              onClick={() =>
                onUpdate({ step: "story", epicId: selectedEpic.id })
              }
            >
              <Layers3 size={12} />
              Use {selectedEpic.title}
            </button>
          )}
          {step === "epic" && !selectedEpic && (
            <button
              className="guide-use-existing"
              onClick={() => {
                onUpdate({ step: "story" });
                onAction("story");
              }}
            >
              <MessageSquare size={12} />
              Start with a story instead
            </button>
          )}
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
          {(step === "epic" ||
            step === "story" ||
            (step === "ready" && story)) && (
            <button
              className="guide-use-existing"
              onClick={() => onUpdate({ step: "code-review" })}
            >
              Continue to Code review <ArrowRight size={12} />
            </button>
          )}
          {(step === "epic" || step === "story" || step === "ready") && (
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
