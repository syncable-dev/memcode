import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Archive,
  CalendarDays,
  Check,
  CheckSquare,
  CircleCheck,
  Columns3,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type {
  AppState,
  Project,
  RuntimeInfo,
  SavedView,
  TaskPatch,
  WorkItem,
} from "../shared";
import { defaultView, type ViewConfig } from "../planning/types";
import {
  bulkEditPatch,
  groupMove,
  groupNames,
  groupWork,
} from "../planning/groups";
import {
  backlogStatusId,
  filterWork,
  isBacklogStatus,
  taskStatus,
  workflowFor,
} from "../planning/workflow";
import { storyReadiness, type StoryReadiness } from "../planning/readiness";
import { WorkBoard } from "./Board";
import { BoardSettings } from "./BoardSettings";
import { WorkCalendar, WorkTimeline } from "./ScheduleViews";
import { WorkspaceHero } from "./WorkspaceHero";
import { filterCount } from "./WorkspaceFilters";
import {
  WorkspaceToolbar,
  modeChoices,
  type WorkspacePanel,
} from "./WorkspaceToolbar";
import { Modal } from "./Dialogs";
import { Select } from "./Select";
import { Spinner } from "./UI";

interface Props {
  state: AppState;
  project: Project;
  runtime: RuntimeInfo;
  open: (task: WorkItem) => void;
  create: (statusId?: string) => void;
  notify: (message: string) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  addProject: () => void;
  /** Shown in the calendar and timeline, where the green bar would crowd the view. */
  heading: React.ReactNode;
}

export function Workspace({
  state,
  project,
  runtime,
  open,
  create,
  notify,
  act,
  addProject,
  heading,
}: Props) {
  const workspace = useRef<HTMLElement>(null);
  const [config, setConfig] = useState<ViewConfig>(() =>
    structuredClone(defaultView),
  );
  useLayoutEffect(() => {
    workspace.current
      ?.closest(".workspace-scroll")
      ?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [config.mode, project.id]);
  const [viewId, setViewId] = useState<string | null>(null),
    [panel, setPanel] = useState<WorkspacePanel>(null),
    [settings, setSettings] = useState(false),
    [saveOpen, setSaveOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set()),
    [bulk, setBulk] = useState("none"),
    [busy, setBusy] = useState(false);
  const [promotion, setPromotion] = useState<{
    projectId: string;
    ids: string[];
    cycleId: string;
    patch: TaskPatch;
  } | null>(null);
  const controls = useRef<HTMLDivElement>(null);
  const [readyOnly, setReadyOnly] = useState(false);
  const projectTasks = state.tasks.filter(
      (task) => task.projectId === project.id,
    ),
    epics = state.epics
      .filter((epic) => epic.projectId === project.id)
      .sort((a, b) => a.order - b.order),
    cycles = state.cycles.filter((cycle) => cycle.projectId === project.id),
    views = state.savedViews.filter((view) => view.projectId === project.id),
    workflow = workflowFor(state, project.id);
  const filtered = filterWork(
    projectTasks,
    config.filters.epicId === "none"
      ? { ...config, filters: { ...config.filters, epicId: "all" } }
      : config,
  ).filter((task) => config.filters.epicId !== "none" || !task.epicId);
  const readiness = new Map<string, StoryReadiness>();
  if (config.mode === "board") {
    for (const task of filtered) {
      const status = storyReadiness(task, projectTasks, workflow);
      if (status) readiness.set(task.id, status);
    }
  }
  const ready = filtered.filter(
    (task) => readiness.get(task.id)?.state === "ready",
  );
  const visible =
    readyOnly && config.mode === "board" && !config.filters.archived
      ? ready
      : filtered;
  const currentView = views.find((view) => view.id === viewId),
    dirty =
      JSON.stringify(config) !==
      JSON.stringify(
        currentView
          ? {
              mode: currentView.mode,
              groupBy: currentView.groupBy,
              sortBy: currentView.sortBy,
              filters: currentView.filters,
            }
          : defaultView,
      );
  const change = (patch: Partial<ViewConfig>) => {
    setConfig((current) => ({ ...current, ...patch }));
    setSelected(new Set());
    setBulk("none");
  };
  useEffect(() => {
    setConfig(structuredClone(defaultView));
    setReadyOnly(false);
    setViewId(null);
    setSelected(new Set());
    setPanel(null);
    setSettings(false);
    setPromotion(null);
  }, [project.id]);
  useEffect(() => {
    const allowed = new Set(visible.map((task) => task.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => allowed.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visible.map((task) => task.id).join(",")]);
  useEffect(() => {
    if (!panel) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (
        !controls.current?.contains(target) &&
        !target.closest("[data-memcode-select-open]")
      )
        setPanel(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !document.querySelector("[data-memcode-select-open]")
      )
        setPanel(null);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [panel]);
  const groups = groupWork(config.groupBy, {
    tasks: visible,
    workflow,
    epics,
    cycles,
  });
  const saveMove = async (ids: string[], patch: TaskPatch) => {
    setBusy(true);
    try {
      if (ids.length === 1) await window.memcode.updateTask(ids[0], patch);
      else await window.memcode.bulkUpdateTasks(ids, patch);
      setPromotion(null);
      setSelected(new Set());
      setBulk("none");
      if (ids.length > 1) notify(`${ids.length} tasks updated.`);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const requestMove = (ids: string[], patch: TaskPatch) => {
    const activeCycle = cycles.find((cycle) => cycle.state === "active");
    if (
      activeCycle &&
      patch.stage === "planned" &&
      patch.statusId &&
      !isBacklogStatus(patch.statusId) &&
      projectTasks.some(
        (task) =>
          ids.includes(task.id) &&
          isBacklogStatus(taskStatus(task, workflow).id),
      )
    ) {
      setPromotion({
        projectId: project.id,
        ids,
        cycleId: activeCycle.id,
        patch,
      });
      return;
    }
    void saveMove(ids, patch);
  };
  const move = (id: string, target: string) => {
    if (busy || promotion) return;
    const result = groupMove(config.groupBy, target, { workflow, cycles });
    if (result.kind === "blocked") notify(result.message);
    if (result.kind === "update")
      requestMove(selected.has(id) ? [...selected] : [id], result.patch);
  };
  const chooseView = (view?: SavedView) => {
    setReadyOnly(false);
    setViewId(view?.id ?? null);
    setConfig(
      structuredClone(
        view
          ? {
              mode: view.mode,
              groupBy: view.groupBy,
              sortBy: view.sortBy,
              filters: view.filters,
            }
          : defaultView,
      ),
    );
    setSelected(new Set());
    setPanel(null);
  };
  const applyBulk = async () => {
    if (bulk === "none" || !selected.size) return;
    const patch = bulkEditPatch(
      bulk,
      config.filters.archived,
      workflow,
      new Date().toISOString(),
    );
    if (!patch) return;
    requestMove([...selected], patch);
  };
  const targetCycle = cycles.find((cycle) => cycle.id === promotion?.cycleId);
  const canJoin = targetCycle?.state === "active";
  const selectionIncludesCycle = promotion?.ids.some((id) =>
    projectTasks.some((task) => task.id === id && task.cycleId),
  );
  const targetStatus = workflow.find(
    (status) => status.id === promotion?.patch.statusId,
  );
  const allSelected =
    visible.length > 0 && visible.every((task) => selected.has(task.id));
  return (
    <section
      ref={workspace}
      className={"workspace-planning workspace-mode-" + config.mode}
    >
      {config.mode === "calendar" || config.mode === "timeline" ? (
        heading
      ) : (
        <WorkspaceHero
          project={project}
          tasks={projectTasks}
          runtime={runtime}
          act={act}
          addProject={addProject}
          create={() => create()}
        />
      )}
      <WorkspaceToolbar
        config={config}
        change={change}
        views={views}
        viewId={viewId}
        currentView={currentView}
        dirty={dirty}
        chooseView={chooseView}
        saveView={() => setSaveOpen(true)}
        panel={panel}
        setPanel={setPanel}
        tasks={projectTasks}
        epics={epics}
        cycles={cycles}
        openSettings={() => setSettings(true)}
        controlsRef={controls}
      />
      {(config.mode === "board" || config.mode === "list") && (
        <div className="workspace-selection-tools">
          <label className="workspace-check">
            <input
              type="checkbox"
              aria-label="Select all visible work"
              className="selection-checkbox"
              checked={allSelected}
              onChange={() =>
                setSelected(
                  allSelected
                    ? new Set()
                    : new Set(visible.map((task) => task.id)),
                )
              }
            />
            <span>
              {selected.size
                ? `${selected.size} selected`
                : `${visible.length} ${config.filters.archived ? "archived " : ""}work ${visible.length === 1 ? "item" : "items"}`}
            </span>
          </label>
          {selected.size > 0 ? (
            <>
              <Select
                aria-label="Bulk action"
                value={bulk}
                onValueChange={setBulk}
              >
                <option value="none">Choose an action…</option>
                {workflow.map((status) => (
                  <option key={status.id} value={"status|" + status.id}>
                    Move to {status.name}
                  </option>
                ))}
                {(["high", "medium", "low"] as const).map((priority) => (
                  <option key={priority} value={"priority|" + priority}>
                    Priority: {priority}
                  </option>
                ))}
                <option value="cycle|none">Remove from cycle</option>
                {cycles
                  .filter((cycle) => cycle.state !== "completed")
                  .map((cycle) => (
                    <option key={cycle.id} value={"cycle|" + cycle.id}>
                      Cycle: {cycle.name}
                    </option>
                  ))}
                <option value="archive">
                  {config.filters.archived
                    ? "Restore selected work"
                    : "Archive selected work"}
                </option>
              </Select>
              <button
                className="workspace-apply"
                disabled={busy || bulk === "none"}
                onClick={() => void applyBulk()}
              >
                {busy ? <Spinner size={11} /> : <Check size={11} />}Apply
              </button>
              <button
                className="icon-button"
                aria-label="Clear selection"
                onClick={() => setSelected(new Set())}
              >
                <X size={12} />
              </button>
            </>
          ) : (
            <span className="workspace-selection-hint">
              <CheckSquare size={11} />
              Select work to update it together
            </span>
          )}
          {config.mode === "board" && !config.filters.archived && (
            <button
              type="button"
              className="workspace-ready-filter"
              aria-pressed={readyOnly}
              title="Show planned tasks with clear prerequisites in this view"
              onClick={() => setReadyOnly((wasReadyOnly) => !wasReadyOnly)}
            >
              <CircleCheck size={13} />
              Ready to start <span>{ready.length}</span>
            </button>
          )}
          <span className="workspace-group-label">
            {config.mode === "board"
              ? `Grouped by ${groupNames[config.groupBy].toLowerCase()}`
              : "Manual estimates · local planning"}
          </span>
        </div>
      )}
      {config.mode === "board" || config.mode === "list" ? (
        <WorkBoard
          key={project.id}
          backlogId={backlogStatusId(project.id)}
          readiness={readiness}
          tasks={visible}
          mode={config.mode}
          groups={groups}
          cycles={cycles}
          storyComments={state.storyComments}
          open={open}
          create={create}
          move={move}
          selected={selected}
          toggle={(id) =>
            setSelected((current) => {
              const next = new Set(current);
              next.has(id) ? next.delete(id) : next.add(id);
              return next;
            })
          }
        />
      ) : config.mode === "calendar" ? (
        <WorkCalendar tasks={visible} open={open} notify={notify} />
      ) : (
        <WorkTimeline tasks={visible} open={open} notify={notify} />
      )}
      <div className="board-footnote workspace-footnote">
        <span>
          {config.filters.archived ? (
            <>
              <Archive size={11} />
              Archived work stays available for reference.
            </>
          ) : (
            <>
              Planning changes never start workers. You choose when work runs.
            </>
          )}
        </span>
        <button onClick={() => create()}>
          <Plus size={11} />
          New work
        </button>
      </div>
      {settings && (
        <BoardSettings
          state={state}
          project={project}
          notify={notify}
          close={() => setSettings(false)}
        />
      )}
      {promotion && promotion.projectId === project.id && (
        <Modal
          kicker="CYCLE PLANNING"
          title={`Plan ${promotion.ids.length === 1 ? "this task" : "these " + promotion.ids.length + " tasks"}?`}
          description={
            canJoin
              ? `Move ${promotion.ids.length === 1 ? "this task" : "all selected tasks"} to ${targetStatus?.name ?? "Planned"}. Would you also like to add ${promotion.ids.length === 1 ? "it" : "them"} to ${targetCycle.name}?`
              : "The active cycle changed while this dialog was open. You can still plan this work."
          }
          close={() => {
            if (!busy) setPromotion(null);
          }}
        >
          <footer className="modal-footer saved-view-footer">
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setPromotion(null)}
            >
              Cancel
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void saveMove(promotion.ids, promotion.patch)}
            >
              {selectionIncludesCycle
                ? "Keep current cycles"
                : "Plan outside cycle"}
            </button>
            {canJoin && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void saveMove(promotion.ids, {
                    ...promotion.patch,
                    cycleId: targetCycle.id,
                  })
                }
              >
                {busy ? <Spinner size={14} /> : <CalendarDays size={14} />}Add
                to cycle
              </button>
            )}
          </footer>
        </Modal>
      )}
      {saveOpen && (
        <SaveWorkspaceView
          project={project}
          config={config}
          current={currentView}
          close={() => setSaveOpen(false)}
          notify={notify}
          saved={(view) => {
            setViewId(view.id);
            setSaveOpen(false);
          }}
          removed={() => {
            chooseView();
            setSaveOpen(false);
          }}
        />
      )}
    </section>
  );
}

function SaveWorkspaceView({
  project,
  config,
  current,
  close,
  notify,
  saved,
  removed,
}: {
  project: Project;
  config: ViewConfig;
  current?: SavedView;
  close: () => void;
  notify: (message: string) => void;
  saved: (view: SavedView) => void;
  removed: () => void;
}) {
  const [name, setName] = useState(current?.name ?? ""),
    [busy, setBusy] = useState(false);
  const save = async (copy = false) => {
    setBusy(true);
    try {
      saved(
        await window.memcode.saveView({
          ...config,
          projectId: project.id,
          name: name.trim(),
          ...(!copy && current ? { id: current.id } : {}),
        }),
      );
    } catch (error) {
      notify((error as Error).message);
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await window.memcode.deleteView(current.id);
      removed();
    } catch (error) {
      notify((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={current ? "Keep this view close." : "A view for the way you work."}
      kicker="SAVED WORK VIEW"
      description="Save this layout, grouping, sort order, and filters for this project."
      close={close}
    >
      <div className="modal-body saved-view-body">
        <label className="field">
          <span>View name</span>
          <input
            aria-label="View name"
            placeholder="This cycle, Platform work, Ready to review…"
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="saved-view-summary">
          <Columns3 size={15} />
          <span>
            {modeChoices.find(([mode]) => mode === config.mode)?.[1]} view
            <small>
              {groupNames[config.groupBy]} · {filterCount(config.filters)}{" "}
              filters{config.filters.query ? " · search included" : ""}
            </small>
          </span>
        </div>
      </div>
      <footer className="modal-footer saved-view-footer">
        {current && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 size={12} />
            Delete view
          </button>
        )}
        <button className="button secondary" disabled={busy} onClick={close}>
          Cancel
        </button>
        {current && (
          <button
            className="button secondary"
            disabled={busy || !name.trim()}
            onClick={() => void save(true)}
          >
            Save as new
          </button>
        )}
        <button
          className="button primary"
          disabled={busy || !name.trim()}
          onClick={() => void save()}
        >
          {busy ? <Spinner size={12} /> : <Save size={12} />}Save view
        </button>
      </footer>
    </Modal>
  );
}
