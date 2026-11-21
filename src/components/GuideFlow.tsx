import { Bot, FolderGit2, Layers, NotebookPen, ScanLine } from "lucide-react";

const steps = [
  { topic: "projects", title: "Project", detail: "Connect your code", icon: FolderGit2 },
  { topic: "workers", title: "Worker", detail: "Connect a coding tool", icon: Bot },
  { topic: "epics", title: "Goal", detail: "Say what you want", icon: Layers },
  { topic: "stories", title: "Task", detail: "One piece of work", icon: NotebookPen },
  { topic: "review", title: "Code review", detail: "Check what changed", icon: ScanLine },
] as const;

export function GuideFlow({ onTopic }: { onTopic: (topic: string) => void }) {
  return (
    <nav className="guide-flow" aria-label="From project to code review">
      <ol>
        {steps.map(({ topic, title, detail, icon: Icon }, index) => (
          <li key={topic}>
            <button
              type="button"
              onClick={() => onTopic(topic)}
              style={{ animationDelay: `${index * 60}ms` }}
            >
              <span className="guide-flow-icon"><Icon size={18} aria-hidden="true" /></span>
              <strong>{title}</strong>
              <small>{detail}</small>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
