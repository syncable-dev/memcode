import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Code2,
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
import "../styles-onboarding.css";

const copy = {
  project: {
    number: 1,
    title: "Give your idea a home.",
    body: "Create a local project or open a folder you already work in. You decide what goes on its board.",
    button: "Create or open a project",
    target: "[data-guide=project-picker]",
  },
  memtrace: {
    number: 2,
    title: "Understand the code first.",
    body: "Memtrace analyzes this project locally so workers can retrieve relevant code and measure a change’s complexity and impact.",
    button: "Analyze this project",
    target: "[data-guide=project-picker]",
  },
  worker: {
    number: 3,
    title: "Choose a worker you trust.",
    body: "Connect an installed coding tool and approve its access. Your provider account and permission settings stay yours.",
    button: "Choose a worker",
    target: "[data-guide=worker-connections]",
  },
  epic: {
    number: 4,
    title: "What would you like to build?",
    body: "An epic groups an outcome; a story describes one useful change. Write your own when you’re ready, or finish setup with an empty board.",
    button: "Write an epic",
    target: "[data-guide=new-epic]",
  },
  story: {
    number: 4,
    title: "One clear request is enough.",
    body: "Describe the outcome, useful context and what success looks like. Creating a story saves your brief; starting its worker is a separate choice.",
    button: "Write a story",
    target: "[data-guide=new-story]",
  },
  ready: {
    number: 4,
    title: "Explore your story.",
    body: "Take a tour inside the card. See where to talk to the worker, inspect its edits and open what it built.",
    button: "Tour the story tabs",
  },
  "code-review": {
    number: 5,
    title: "Review what changed.",
    body: "When the work is ready, move the story to the Code review lane. Open its Code review tab and start the review there.",
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
          : copy[step].target;
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
              { icon: Folder, label: "Your project" },
              { icon: Code2, label: "Code context" },
              { icon: Plug, label: "Your worker" },
              { icon: MessageSquare, label: "Your first work" },
              { icon: ScanLine, label: "Code review" },
            ].map(({ icon: Icon, label }, index) => (
              <div key={label} className={index === 0 ? "current" : ""}>
                <span>
                  <Icon size={17} />
                </span>
                <small>{String(index + 1).padStart(2, "0")}</small>
                <strong>{label}</strong>
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
          {preference}
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
        <div className="guide-progress" aria-label={`Step ${item.number} of 5`}>
          {[1, 2, 3, 4, 5].map((number) => (
            <i
              key={number}
              className={number <= item.number ? "complete" : ""}
            />
          ))}
        </div>
        <div className="guide-step-copy" key={step}>
          <small>
            STEP {item.number} OF 5{item.number === 4 ? " · OPTIONAL" : ""}
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
          ) : step === "code-review" ? (
            <>
              <div className="guide-review-advice">
                <ScanLine size={16} aria-hidden />
                <p>
                  Open a finding to see the evidence. Compare the measured
                  changes, then ask for a fix or record why you accept the risk.
                </p>
              </div>
              <button
                className="button primary"
                onClick={() => onAction("review-docs")}
              >
                {item.button} <ArrowRight size={13} />
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
                else onAction(step === "ready" ? "open-story" : step);
              }}
            >
              {step === "ready" && !story
                ? "Continue to Code review"
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
          {step === "worker" && connected && (
            <button
              className="guide-use-existing"
              onClick={() => onUpdate({ step: "epic" })}
            >
              <Check size={12} />
              Worker approved · continue
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
          {(step === "epic" ||
            step === "story" ||
            step === "ready" ||
            step === "code-review") && (
            <button
              className="guide-use-existing"
              onClick={() => onUpdate({ complete: true })}
            >
              <Check size={12} />
              {story || step === "code-review"
                ? "Finish setup"
                : "Finish setup · add work later"}
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
          <button onClick={pause}>Skip for now</button>
          <button onClick={onDocs}>
            Quick start <ArrowRight size={10} />
          </button>
        </footer>
      </aside>
    </>
  );
}
