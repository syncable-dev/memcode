import { priorities, priorityLabels } from "../planning/priority";
import { RotateCcw, X } from "lucide-react";
import type { Cycle, Epic, Harness, Priority, WorkItem } from "../shared";
import { defaultFilters, type WorkFilters } from "../planning/types";
import { Select } from "./Select";

export function filterCount(filters: WorkFilters) {
  return Object.entries(filters).filter(
    ([key, value]) =>
      key !== "query" &&
      value !== (defaultFilters[key as keyof WorkFilters] ?? "all"),
  ).length;
}

export function WorkspaceFilters({
  filters,
  tasks,
  epics,
  cycles,
  change,
  close,
}: {
  filters: WorkFilters;
  tasks: WorkItem[];
  epics: Epic[];
  cycles: Cycle[];
  change: (patch: Partial<WorkFilters>) => void;
  close: () => void;
}) {
  const people = [
    ...new Map(
      tasks.flatMap((task) => (task.assignee ? [[task.assignee.id, task.assignee] as const] : [])),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const labels = Array.from(
    new Set(tasks.flatMap((task) => task.labels ?? [])),
  ).sort();
  return (
    <section
      className="workspace-popover workspace-filters"
      aria-label="Filter work"
    >
      <header>
        <div>
          <span className="planning-eyebrow">FIND YOUR FOCUS</span>
          <h3>Filter work</h3>
        </div>
        <button
          className="icon-button"
          aria-label="Close filters"
          onClick={close}
        >
          <X size={14} />
        </button>
      </header>
      <div className="workspace-filter-grid">
        <label>
          <span>Priority</span>
          <Select
            aria-label="Filter priority"
            value={filters.priority}
            onValueChange={(priority) =>
              change({ priority: priority as Priority | "all" })
            }
          >
            <option value="all">Any priority</option>
            {priorities.map((priority) => (
              <option key={priority} value={priority}>
                {priorityLabels[priority].replace(" priority", "")}
              </option>
            ))}
          </Select>
        </label>
        {people.length > 0 && (
          <label>
            <span>Assignee</span>
            <Select
              aria-label="Filter assignee"
              value={filters.assignee ?? "all"}
              onValueChange={(assignee) => change({ assignee })}
            >
              <option value="all">Anyone</option>
              <option value="none">Nobody</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label>
          <span>Goal</span>
          <Select
            aria-label="Filter goal"
            value={filters.epicId}
            onValueChange={(epicId) => change({ epicId })}
          >
            <option value="all">All goals</option>
            <option value="none">Without a goal</option>
            {epics.map((epic) => (
              <option key={epic.id} value={epic.id}>
                {epic.title}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span>Cycle</span>
          <Select
            aria-label="Filter cycle"
            value={filters.cycleId}
            onValueChange={(cycleId) => change({ cycleId })}
          >
            <option value="all">All cycles</option>
            <option value="none">No cycle</option>
            {cycles.map((cycle) => (
              <option key={cycle.id} value={cycle.id}>
                {cycle.name}
                {cycle.state === "active" ? " · active" : ""}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span>Label</span>
          <Select
            aria-label="Filter label"
            value={filters.label}
            onValueChange={(label) => change({ label })}
          >
            <option value="all">Any label</option>
            {labels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span>Work type</span>
          <Select
            aria-label="Filter work type"
            value={filters.kind}
            onValueChange={(kind) => change({ kind })}
          >
            <option value="all">Any type</option>
            <option value="feature">Feature</option>
            <option value="fix">Fix</option>
            <option value="refactor">Refactor</option>
            <option value="research">Research</option>
            <option value="test">Test</option>
          </Select>
        </label>
        <label>
          <span>Harness</span>
          <Select
            aria-label="Filter harness"
            value={filters.harness}
            onValueChange={(harness) =>
              change({ harness: harness as Harness | "all" })
            }
          >
            <option value="all">Any harness</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
            <option value="cursor">Cursor</option>
            <option value="copilot">GitHub Copilot</option>
            <option value="dsh">DeepSeek Harness</option>
          </Select>
        </label>
      </div>
      <footer>
        <label className="workspace-check">
          <input
            type="checkbox"
            checked={filters.archived}
            onChange={(event) => change({ archived: event.target.checked })}
          />
          <span>Archived work only</span>
        </label>
        <button
          className="text-button"
          onClick={() => change({ ...defaultFilters, query: filters.query })}
        >
          <RotateCcw size={11} />
          Reset filters
        </button>
      </footer>
    </section>
  );
}
