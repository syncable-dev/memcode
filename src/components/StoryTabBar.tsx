import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  type LucideIcon,
} from "lucide-react";
import "../styles-story-guide.css";

const tabHelp = {
  conversation: [
    "Give your worker direction",
    "Describe the outcome, answer a worker’s question or send a follow-up. If the worker is busy, your follow-up waits in Queue.",
  ],
  queue: [
    "Adjust the next instruction",
    "Edit or cancel a waiting follow-up before the worker picks it up. The next worker pass starts automatically when it’s ready.",
  ],
  comments: [
    "Discuss the story with your team",
    "Leave a decision or ask a teammate a question here. To pass a comment to the worker, add it to a follow-up and send it.",
  ],
  runbook: [
    "Agree on what done means",
    "Break the outcome into small checks. Tick them off as you verify each part of the story.",
  ],
  changes: [
    "Inspect this worker’s edits",
    "Select a changed file to compare added and removed lines. Attach a comment to the lines you want the worker to revisit.",
  ],
  review: [
    "Check the evidence before accepting",
    "Move the story into the Code review lane and start a review. Inspect findings, checks and before/after measurements, then request a fix or record a dismissal. Saved reviews stay readable in Acceptance and Done.",
  ],
  artifacts: [
    "Open what the worker delivered",
    "Preview a saved report, image or document. Select a passage to comment on it, then send your notes when you’re ready.",
  ],
  browser: [
    "Try the running app",
    "Use this story’s live browser to try a change on the same page your worker sees. Capture a screenshot to keep it with the story.",
  ],
  terminal: [
    "Follow a running process",
    "Watch a dev server or open a shell in the story’s workspace. Select output to copy it or include it in a follow-up.",
  ],
  file: [
    "Read the linked project file",
    "This tab opens when you follow a local file reference. Read the source in context and select the passage you want to discuss.",
  ],
} as const;

export type StoryTab = keyof typeof tabHelp;
export type StoryTabItem = {
  id: StoryTab;
  label: string;
  icon: LucideIcon;
  count?: number;
};

export function StoryTabBar({
  tabs,
  tab,
  onSelect,
  needsReply,
  guidedTour = false,
  onGuideTourEnd,
}: {
  tabs: StoryTabItem[];
  tab: StoryTab;
  onSelect: (tab: StoryTab) => void;
  needsReply: boolean;
  guidedTour?: boolean;
  onGuideTourEnd?: () => void;
}) {
  const [manuallyOpened, setManuallyOpened] = useState(false);
  const [guideEnded, setGuideEnded] = useState(false);
  const showing = manuallyOpened || (guidedTour && !guideEnded);
  const panelId = useId();
  const guideButton = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLElement>(null);
  const index = Math.max(
    0,
    tabs.findIndex((item) => item.id === tab),
  );
  const current = tabs[index];
  const [heading, description] = tabHelp[current.id];
  const isLast = index === tabs.length - 1;

  useEffect(() => {
    if (!guidedTour) setGuideEnded(false);
  }, [guidedTour]);

  useEffect(() => {
    const list = rail.current;
    const active = list?.querySelector<HTMLButtonElement>(
      '[aria-current="page"]',
    );
    if (!list || !active) return;
    const bounds = list.getBoundingClientRect();
    const button = active.getBoundingClientRect();
    if (button.right > bounds.right)
      list.scrollLeft += button.right - bounds.right + 8;
    else if (button.left < bounds.left)
      list.scrollLeft -= bounds.left - button.left + 8;
  }, [tab]);

  function closeGuide() {
    setManuallyOpened(false);
    if (guidedTour && !guideEnded) {
      setGuideEnded(true);
      onGuideTourEnd?.();
    }
    guideButton.current?.focus({ preventScroll: true });
  }

  return (
    <div
      className="story-guide-shell"
      onKeyDown={(event) => {
        if (showing && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeGuide();
        }
      }}
    >
      <div className="story-tab-toolbar">
        <nav className="detail-tabs" aria-label="Story tabs" ref={rail}>
          {tabs.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-current={tab === item.id ? "page" : undefined}
              className={tab === item.id ? "active" : ""}
              onClick={() => onSelect(item.id)}
            >
              <item.icon size={13} />
              {item.label}
              {item.id === "conversation" && needsReply ? (
                <small className="conversation-needs-reply">Needs reply</small>
              ) : item.count ? (
                <small>{item.count}</small>
              ) : null}
            </button>
          ))}
        </nav>
        <button
          type="button"
          ref={guideButton}
          className="story-guide-toggle"
          aria-expanded={showing}
          aria-controls={showing ? panelId : undefined}
          onClick={() => (showing ? closeGuide() : setManuallyOpened(true))}
        >
          <BookOpen size={14} aria-hidden="true" /> Story guide
        </button>
      </div>
      {showing && (
        <section
          id={panelId}
          className="story-guide-panel"
          aria-label="Story guide"
        >
          <span className="story-guide-symbol" aria-hidden="true">
            <current.icon size={17} />
          </span>
          <div
            className="story-guide-copy"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="story-guide-position">
              {current.id === "file" ? "File" : current.label} <span>·</span>{" "}
              {index + 1} of {tabs.length}
            </div>
            <h3>{heading}</h3>
            <p>{description}</p>
          </div>
          <div className="story-guide-controls">
            <button
              type="button"
              className="story-guide-close"
              onClick={closeGuide}
            >
              {guidedTour && !guideEnded ? "Skip tour" : "Close guide"}
            </button>
            <button
              type="button"
              className="story-guide-back"
              aria-label="Previous tab in guide"
              disabled={index === 0}
              onClick={() => onSelect(tabs[index - 1].id)}
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              className="story-guide-next"
              onClick={() =>
                isLast ? closeGuide() : onSelect(tabs[index + 1].id)
              }
            >
              {isLast ? (
                <>
                  Finish <Check size={14} />
                </>
              ) : (
                <>
                  Next <ArrowRight size={14} />
                </>
              )}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
