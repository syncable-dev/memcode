import { FolderGit2, GitBranch, Layers, NotebookPen, ScanLine } from "lucide-react";

const steps = [
  { topic: "projects", title: "Project", detail: "Connect your code", icon: FolderGit2 },
  { topic: "workers", title: "Worker", detail: "Approve a worker", icon: GitBranch },
  { topic: "epics", title: "Epic", detail: "Define an outcome", icon: Layers },
  { topic: "stories", title: "Story", detail: "Give it one task", icon: NotebookPen },
  { topic: "review", title: "Code review", detail: "Inspect the evidence", icon: ScanLine },
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
