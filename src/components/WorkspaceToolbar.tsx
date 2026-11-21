import type { RefObject } from "react";
import {
  CalendarDays,
  Columns3,
  GitBranch,
  List,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { Cycle, Epic, SavedView, WorkItem } from "../shared";
import type { GroupBy, ViewConfig, ViewMode } from "../planning/types";
import { groupNames } from "../planning/groups";
import { WorkspaceFilters, filterCount } from "./WorkspaceFilters";
import { Select } from "./Select";

export const modeChoices = [
  ["board", "Board", Columns3],
  ["list", "List", List],
  ["timeline", "Timeline", GitBranch],
  ["calendar", "Calendar", CalendarDays],
] as const;
export type WorkspacePanel = "filters" | "display" | null;
interface Props {
  config: ViewConfig;
  change: (patch: Partial<ViewConfig>) => void;
  views: SavedView[];
  viewId: string | null;
  currentView?: SavedView;
  dirty: boolean;
  chooseView: (view?: SavedView) => void;
  saveView: () => void;
  panel: WorkspacePanel;
  setPanel: (panel: WorkspacePanel) => void;
  tasks: WorkItem[];
  epics: Epic[];
  cycles: Cycle[];
  openSettings: () => void;
  controlsRef: RefObject<HTMLDivElement | null>;
}

export function WorkspaceToolbar({
  config,
  change,
  views,
  viewId,
  currentView,
  dirty,
  chooseView,
  saveView,
  panel,
  setPanel,
  tasks,
  epics,
  cycles,
  openSettings,
  controlsRef,
}: Props) {
  return (
    <div className="workspace-controls" ref={controlsRef}>
      <div className="workspace-view-bar">
        <nav className="workspace-saved-views" aria-label="Saved work views">
          <button
            className={!viewId ? "active" : ""}
            onClick={() => chooseView()}
          >
            All work
            <span>{tasks.filter((task) => !task.archivedAt).length}</span>
          </button>
          {views.map((view) => (
            <button
              key={view.id}
              className={viewId === view.id ? "active" : ""}
              onClick={() => chooseView(view)}
            >
              {view.name}
            </button>
          ))}
        </nav>
        <button className="workspace-save-view" onClick={saveView}>
          <Save size={12} />
          {currentView && dirty ? "Save changes" : "Save view"}
          {dirty && <i aria-label="Unsaved view changes" />}
        </button>
      </div>
      <div className="board-toolbar workspace-toolbar">
        <div className="board-toolbar-left">
          <div
            className="segmented-control workspace-modes"
            aria-label="Work layout"
          >
            {modeChoices.map(([mode, label, Icon]) => (
              <button
                key={mode}
                aria-label={`${label} view`}
                aria-pressed={config.mode === mode}
                className={config.mode === mode ? "active" : ""}
                onClick={() => change({ mode: mode as ViewMode })}
              >
                <Icon size={12} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="board-toolbar-right">
          <label className="inline-search workspace-search">
            <Search size={13} />
            <input
              aria-label="Search work"
              value={config.filters.query}
              placeholder="Search work…"
              onChange={(event) =>
                change({
                  filters: { ...config.filters, query: event.target.value },
                })
              }
            />
            {config.filters.query && (
              <button
                aria-label="Clear work search"
                onClick={() =>
                  change({ filters: { ...config.filters, query: "" } })
                }
              >
                <X size={11} />
              </button>
            )}
          </label>
          <button
            className={
              "workspace-tool-button " +
              (filterCount(config.filters) ? "filtered" : "")
            }
            aria-expanded={panel === "filters"}
            onClick={() => setPanel(panel === "filters" ? null : "filters")}
          >
            <SlidersHorizontal size={12} />
            Filter
            {filterCount(config.filters) > 0 && (
              <small>{filterCount(config.filters)}</small>
            )}
          </button>
          <button
            className="workspace-tool-button"
            aria-expanded={panel === "display"}
            onClick={() => setPanel(panel === "display" ? null : "display")}
          >
            <Settings2 size={12} />
            <span>Display</span>
          </button>
        </div>
      </div>
      {panel === "filters" && (
        <WorkspaceFilters
          filters={config.filters}
          tasks={tasks}
          epics={epics}
          cycles={cycles}
          close={() => setPanel(null)}
          change={(patch) =>
            change({ filters: { ...config.filters, ...patch } })
          }
        />
      )}
      {panel === "display" && (
        <WorkspaceDisplay
          config={config}
          change={change}
          close={() => setPanel(null)}
          openSettings={() => {
            setPanel(null);
            openSettings();
          }}
        />
      )}
    </div>
  );
}

function WorkspaceDisplay({
  config,
  change,
  close,
  openSettings,
}: {
  config: ViewConfig;
  change: (patch: Partial<ViewConfig>) => void;
  close: () => void;
  openSettings: () => void;
}) {
  return (
    <section
      className="workspace-popover workspace-display"
      aria-label="Display options"
    >
      <header>
        <div>
          <span className="planning-eyebrow">YOUR WORK, YOUR VIEW</span>
          <h3>Display options</h3>
        </div>
        <button
          className="icon-button"
          aria-label="Close display options"
          onClick={close}
        >
          <X size={14} />
        </button>
      </header>
      <label>
        <span>Group board by</span>
        <Select
          aria-label="Group work by"
          value={config.groupBy}
          onValueChange={(value) => change({ groupBy: value as GroupBy })}
        >
          {Object.entries(groupNames).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </label>
      <label>
        <span>Sort work by</span>
        <Select
          aria-label="Sort work by"
          value={config.sortBy}
          onValueChange={(value) =>
            change({ sortBy: value as ViewConfig["sortBy"] })
          }
        >
          <option value="priority">Priority · high first</option>
          <option value="updated">Recently updated</option>
          <option value="created">Recently created</option>
          <option value="due">Due date · earliest first</option>
          <option value="estimate">Manual estimate · highest first</option>
        </Select>
      </label>
      <button className="workspace-settings-link" onClick={openSettings}>
        <Columns3 size={13} />
        <span>
          Workflow & custom fields
          <small>Lane names, limits, and project fields</small>
        </span>
        <Settings2 size={12} />
      </button>
      <p>
        Grouping changes how work is organized. Moving a task changes the
        matching planning field.
      </p>
    </section>
  );
}
