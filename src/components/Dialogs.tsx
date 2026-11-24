import { Select } from "./Select";
import { Integrations } from "./Integrations";
import type { Attachment } from "../attachments";
import { AttachButton, AttachedFiles, useAttach } from "./Attachments";
import { ModelSelect } from "./ModelSelect";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Check,
  CheckCheck,
  ChevronRight,
  Code2,
  Folder,
  FolderOpen,
  GitBranch,
  Layers3,
  Mic,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type {
  Harness,
  Project,
  RuntimeInfo,
  Settings,
  WorkItem,
  Epic,
  Cycle,
} from "../shared";
import { workerSlotChoices } from "../worker-slots";
import { useDictation } from "../useDictation";
import { taskDraftTitle } from "../task-draft";
import { HarnessMark, Mark, PriorityMark, Spinner, StageIcon } from "./UI";
import { estimateOptions } from "../planning/types";
import { isBacklogStatus } from "../planning/workflow";
import { ContextSettings } from "./ContextSettings";
import { DictationSettings } from "./DictationSettings";
import { synchronizeSettingsDraft } from "../settings-draft";
import type { MemtraceAccount } from "../connections";
import { AppUpdates } from "./AppUpdates";
import { BetaAccess } from "./BetaAccess";
import { TelemetrySettings } from "./TelemetrySettings";
import { WorkerConnections } from "./WorkerConnections";
import type { AppState } from "../shared";
import "../styles-setup-settings.css";

export type SettingsSection =
  | "account"
  | "workers"
  | "integrations"
  | "dictation"
  | "retrieval"
  | "updates"
  | "privacy";

export function Modal({
  title,
  kicker,
  description,
  close,
  children,
  wide = false,
}: {
  title: string;
  kicker: string;
  description?: string;
  close: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input,textarea,button")?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const nodes = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,textarea,select,[tabindex="0"]',
        ) ?? [],
      ).filter((node) => node.offsetParent !== null);
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      }
      if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0]?.focus();
      }
    };
    window.addEventListener("keydown", handle);
    return () => {
      window.removeEventListener("keydown", handle);
      before?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className={"modal " + (wide ? "wide" : "")}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !document.querySelector('[data-memcode-select-open="true"]')
          ) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header className="modal-heading">
          <div className="eyebrow">
            <span />
            {kicker}
          </div>
          <button
            className="icon-button modal-close"
            aria-label="Close dialog"
            onClick={close}
          >
            <X size={17} />
          </button>
          <h2 id="modal-title">{title}</h2>
          {description && <p>{description}</p>}
        </header>
        {children}
      </div>
    </div>
  );
}

export function NewTaskDialog({
  project,
  defaultHarness,
  epics,
  initialEpicId,
  initialStatusId,
  cycles = [],
  parent,
  initialDescription = "",
  initialFiles = [],
  onClose,
  onCreated,
  notify,
}: {
  project: Project;
  defaultHarness: Harness;
  epics: Epic[];
  initialEpicId?: string;
  initialStatusId?: string;
  cycles?: Cycle[];
  parent?: WorkItem;
  initialDescription?: string;
  initialFiles?: Attachment[];
  onClose: () => void;
  onCreated: (task: WorkItem) => void;
  notify: (s: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState(initialDescription);
  const [files, setFiles] = useState<Attachment[]>(initialFiles);
  const attach = useAttach(files, setFiles, notify);
  const [harness, setHarness] = useState<Harness>(defaultHarness);
  const [assignment, setAssignment] = useState("auto");
  const [epicId, setEpicId] = useState(
    parent?.epicId ?? initialEpicId ?? "none",
  );
  const [cycleId, setCycleId] = useState(
    cycles.some(
      (cycle) => cycle.id === parent?.cycleId && cycle.state !== "completed",
    )
      ? parent!.cycleId!
      : "none",
  );
  const [estimate, setEstimate] = useState("none");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [labels, setLabels] = useState("");
  const [kind, setKind] = useState<NonNullable<WorkItem["kind"]>>("feature");
  const [priority, setPriority] = useState<"high" | "medium" | "low">("medium");
  const [busy, setBusy] = useState(false);
  const dictation = useDictation(
    (text) =>
      setDescription((value) => [value, text].filter(Boolean).join("\n")),
    notify,
  );
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const resolvedTitle = taskDraftTitle(title, description);
    if (!resolvedTitle || busy) return;
    setBusy(true);
    try {
      onCreated(
        await window.memcode.createTask({
          projectId: project.id,
          title: resolvedTitle,
          ...(initialStatusId &&
          (cycleId === "none" || !isBacklogStatus(initialStatusId))
            ? { statusId: initialStatusId }
            : {}),
          description: description.trim(),
          ...(files.length ? { attachments: files } : {}),
          harness,
          assignment: assignment === "auto" ? "auto" : "manual",
          epicId: epicId === "none" ? null : epicId,
          kind,
          priority,
          cycleId: cycleId === "none" ? null : cycleId,
          estimate: estimate === "none" ? null : Number(estimate),
          parentId: parent?.id ?? null,
          startDate: startDate || null,
          dueDate: dueDate || null,
          labels: labels
            .split(",")
            .map((label) => label.trim())
            .filter(Boolean),
        }),
      );
    } catch (error) {
      notify((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Give the next idea a place."
      kicker="NEW WORK ITEM"
      description="Start with the outcome. Shape the runbook as you go."
      close={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-project">
            <Layers3 size={14} />
            {project.name}
            <ChevronRight size={12} />
            <span>
              {parent ? `Subtask of ${parent.identifier}` : "New task"}
            </span>
          </div>
          <div className="task-title-group">
            <label className="task-title-field">
              <span>
                Title <small>or use your brief</small>
              </span>
              <input
                className="task-title-input"
                aria-label="Work item title"
                placeholder="A short name for this task"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={160}
                autoFocus
                aria-describedby="task-title-help"
              />
            </label>
            <p id="task-title-help" className="task-title-help">
              {!title.trim() && taskDraftTitle("", description) ? (
                <>
                  Title from brief:{" "}
                  <strong>{taskDraftTitle("", description)}</strong>
                </>
              ) : (
                "Add a title or describe the task below."
              )}
            </p>
          </div>
          <div
            className={
              "brief-input-wrap" + (attach.over ? " attach-over" : "")
            }
            {...attach.drop}
          >
            <textarea
              aria-label="Work item brief"
              placeholder="Describe the outcome, context, and what good looks like…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              {...attach.paste}
              maxLength={20000}
            />
            <AttachedFiles
              items={files}
              setItems={setFiles}
              notify={notify}
              notes
            />
            <div className="brief-input-footer">
              <span>
                {dictation.phase === "idle"
                  ? "A few clear sentences are a good start."
                  : dictation.label}
              </span>
              <AttachButton attach={attach} />
              <button
                type="button"
                className={"dictation-button " + dictation.phase}
                onClick={() => void dictation.toggle()}
                title={dictation.label}
                disabled={
                  dictation.phase === "preparing" ||
                  dictation.phase === "transcribing"
                }
              >
                {dictation.phase === "preparing" ||
                dictation.phase === "transcribing" ? (
                  <Spinner />
                ) : dictation.phase === "recording" ? (
                  <Square size={12} />
                ) : (
                  <AudioLines size={16} />
                )}
              </button>
            </div>
          </div>
          <div className="form-row">
            <label className="field">
              <span>Worker assignment</span>
              <Select
                aria-label="Worker harness"
                value={assignment === "auto" ? "auto" : harness}
                onValueChange={(value) => {
                  setAssignment(value);
                  if (value !== "auto") setHarness(value as Harness);
                }}
              >
                <option value="auto">Automatic · Memtrace route</option>
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
                <option value="cursor">Cursor</option>
                <option value="copilot">GitHub Copilot</option>
                <option value="dsh">DeepSeek Harness</option>
              </Select>
            </label>
            <label className="field">
              <span>Priority</span>
              <Select
                aria-label="Priority"
                value={priority}
                onValueChange={(e) => setPriority(e as typeof priority)}
              >
                <option value="high">High priority</option>
                <option value="medium">Medium priority</option>
                <option value="low">Low priority</option>
              </Select>
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span>Goal</span>
              <Select
                aria-label="Task goal"
                value={epicId}
                onValueChange={setEpicId}
              >
                <option value="none">Project work · default goal</option>
                {epics.map((epic) => (
                  <option key={epic.id} value={epic.id}>
                    {epic.identifier} · {epic.title}
                  </option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span>Type of work</span>
              <Select
                aria-label="Type of work"
                value={kind}
                onValueChange={(value) => setKind(value as typeof kind)}
              >
                <option value="feature">Feature</option>
                <option value="fix">Fix</option>
                <option value="refactor">Refactor</option>
                <option value="test">Verification</option>
                <option value="research">Research</option>
              </Select>
            </label>
          </div>
          <details className="new-story-extra">
            <summary>Planning · optional</summary>
            <div className="form-row">
              <label className="field">
                <span>Cycle</span>
                <Select
                  aria-label="New task cycle"
                  value={cycleId}
                  onValueChange={setCycleId}
                >
                  <option value="none">No cycle</option>
                  {cycles
                    .filter((cycle) => cycle.state !== "completed")
                    .map((cycle) => (
                      <option key={cycle.id} value={cycle.id}>
                        {cycle.name}
                      </option>
                    ))}
                </Select>
              </label>
              <label className="field">
                <span>
                  Estimate <small>Manual points</small>
                </span>
                <Select
                  aria-label="New task estimate"
                  value={estimate}
                  onValueChange={setEstimate}
                >
                  <option value="none">Not estimated</option>
                  {estimateOptions.map((value) => (
                    <option key={value} value={String(value)}>
                      {value} points
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          </details>
          <details className="new-story-extra">
            <summary>Dates & labels</summary>
            <div className="form-row">
              <label className="field">
                <span>Start date</span>
                <input
                  type="date"
                  aria-label="New task start date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Due date</span>
                <input
                  type="date"
                  aria-label="New task due date"
                  min={startDate || undefined}
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </label>
            </div>
            <label className="field">
              <span>Labels</span>
              <input
                aria-label="New task labels"
                placeholder="interface, orchestration…"
                value={labels}
                onChange={(event) => setLabels(event.target.value)}
              />
            </label>
          </details>
          <div className="form-note">
            <GitBranch size={13} />
            <p>
              The brief, runbook, conversation and output stay together.
              Creating work never starts a worker automatically.
            </p>
          </div>
        </div>
        <footer className="modal-footer">
          <span>
            <span className="tiny-local-dot" />
            Saved to your local workspace
          </span>
          <button
            className="button primary"
            type="submit"
            disabled={!taskDraftTitle(title, description) || busy}
          >
            {busy ? <Spinner /> : <Plus size={14} />}Create work item
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function NewProjectDialog({
  onClose,
  onCreated,
  notify,
  needsEngine = false,
}: {
  onClose: () => void;
  onCreated: () => void;
  notify: (s: string) => void;
  needsEngine?: boolean;
}) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const dictation = useDictation(
    (text) => setDescription((v) => [v, text].filter(Boolean).join("\n")),
    notify,
  );
  const select = async () => {
    try {
      const path = await window.memcode.selectFolder();
      if (path) {
        setParent(path);
        if (mode === "existing")
          setName(path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project");
      }
    } catch (error) {
      notify((error as Error).message);
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!parent || !name.trim()) return;
    setBusy(true);
    try {
      await window.memcode.createProject({
        mode,
        parent,
        name: name.trim(),
        description: description.trim(),
      });
      onCreated();
    } catch (error) {
      notify((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="A place for what comes next."
      kicker="ADD A PROJECT"
      description="Bring an existing codebase, or start with an idea."
      close={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          {needsEngine && (
            <div className="project-beta-setup">
              <BetaAccess notify={notify} existingCLI />
            </div>
          )}
          <div className="project-mode">
            <button
              type="button"
              className={mode === "existing" ? "active" : ""}
              onClick={() => {
                setMode("existing");
                setParent("");
                setName("");
              }}
            >
              <FolderOpen size={21} />
              <strong>Existing project</strong>
              <span>Understand the code. Continue the work.</span>
              {mode === "existing" && <Check size={13} />}
            </button>
            <button
              type="button"
              className={mode === "new" ? "active" : ""}
              onClick={() => {
                setMode("new");
                setParent("");
                setName("");
              }}
            >
              <Sparkles size={21} />
              <strong>Something new</strong>
              <span>A clear brief. A fresh local repository.</span>
              {mode === "new" && <Check size={13} />}
            </button>
          </div>
          <label className="field">
            <span>
              {mode === "existing" ? "Project folder" : "Create inside"}
            </span>
            <button
              type="button"
              className="folder-select"
              onClick={() => void select()}
            >
              <Folder size={15} />
              <span>{parent || "Choose a folder on this computer"}</span>
              <ChevronRight size={14} />
            </button>
          </label>
          <label className="field">
            <span>Project name</span>
            <input
              aria-label="Project name"
              placeholder="Your next great project"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
            />
          </label>
          <div className="field">
            <span>What is this project for?</span>
            <div className="brief-input-wrap">
              <textarea
                aria-label="Project purpose"
                placeholder="Describe who it helps, what it does, and where you want to take it…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={10000}
              />
              <div className="brief-input-footer">
                <span>
                  {dictation.phase === "idle"
                    ? "Your project brief becomes shared context for the work."
                    : dictation.label}
                </span>
                <button
                  type="button"
                  className={"dictation-button " + dictation.phase}
                  title={
                    dictation.phase === "idle"
                      ? "Dictate project purpose"
                      : dictation.label
                  }
                  onClick={() => void dictation.toggle()}
                  disabled={
                    dictation.phase === "preparing" ||
                    dictation.phase === "transcribing"
                  }
                >
                  {dictation.phase === "preparing" ||
                  dictation.phase === "transcribing" ? (
                    <Spinner />
                  ) : dictation.phase === "recording" ? (
                    <Square size={12} />
                  ) : (
                    <AudioLines size={16} />
                  )}
                </button>
              </div>
            </div>
          </div>
          <div className="form-note">
            <GitBranch size={14} />
            <p>
              {mode === "existing"
                ? "MemCode reads the project through your local Memtrace engine. Existing source files are kept in place."
                : "We create a new folder, initialize Git, and save your brief. Your first work item starts with defining the project."}
            </p>
          </div>
        </div>
        <footer className="modal-footer">
          <button type="button" className="text-button" onClick={onClose}>
            Keep exploring
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={!parent || !name.trim() || busy}
          >
            {busy ? <Spinner /> : null}
            {mode === "new" ? "Create project" : "Open project"}
            <ArrowRight size={14} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function SettingsDialog({
  settings,
  state,
  runtime,
  onClose,
  onSaved,
  notify,
  onAccountStatus,
  initialSection = "account",
  onSetupGuide,
}: {
  settings: Settings;
  state: AppState;
  runtime: RuntimeInfo;
  onClose: () => void;
  onSaved: (runtime: RuntimeInfo) => void;
  notify: (s: string) => void;
  onAccountStatus?: (account: MemtraceAccount) => void;
  initialSection?: SettingsSection;
  onSetupGuide: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const dshRuntime = runtime.harnesses.find((harness) => harness.id === "dsh");
  const dshProfiles = dshRuntime?.profiles?.length
    ? dshRuntime.profiles
    : [draft.dshProfile || dshRuntime?.activeProfile || "acp"];
  const selectedDshProfile =
    draft.dshProfile || dshRuntime?.activeProfile || dshProfiles[0] || "acp";
  // The loaded dsh catalog belongs to the saved profile. Until a different
  // draft profile is saved, offer no models that profile may not have.
  const dshProfilePending =
    !!dshRuntime?.activeProfile && selectedDshProfile !== dshRuntime.activeProfile;
  const models =
    draft.defaultHarness === "dsh" && dshProfilePending
      ? []
      : runtime.harnesses.find((harness) => harness.id === draft.defaultHarness)
          ?.models ?? [];
  const dshProfileOptions = dshProfiles.includes(selectedDshProfile)
    ? dshProfiles
    : [selectedDshProfile, ...dshProfiles];
  const previousSettings = useRef(settings);
  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = settings;
    setDraft((value) => synchronizeSettingsDraft(value, previous, settings));
  }, [settings]);
  const [busy, setBusy] = useState(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      onSaved(await window.memcode.saveSettings(draft));
      notify("Workspace settings saved.");
      onClose();
    } catch (error) {
      notify((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Make the workspace yours."
      kicker="LOCAL SETTINGS"
      close={onClose}
    >
      <form onSubmit={save}>
        <nav className="settings-navigation" aria-label="Settings sections">
          {(
            [
              ["account", "Account"],
              ["workers", "Workers"],
              ["integrations", "Integrations"],
              ["dictation", "Dictation"],
              ["retrieval", "Local retrieval"],
              ["updates", "Updates"],
              ["privacy", "Privacy"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="modal-body settings-body">
          {section === "account" && (
            <>
              <BetaAccess
                notify={notify}
                existingCLI
                onAccountStatus={onAccountStatus}
              />
              <div className="settings-setup-link">
                <span>
                  <strong>A clear place to start.</strong>
                  <small>
                    Walk through your account, worker defaults and optional
                    local tools.
                  </small>
                </span>
                <button
                  type="button"
                  className="button secondary"
                  onClick={onSetupGuide}
                >
                  Project setup <ArrowRight size={13} />
                </button>
              </div>
            </>
          )}
          {section === "updates" && (
            <>
              <AppUpdates
                currentVersion={runtime.appVersion}
                beforeRestart={async () => {
                  onSaved(await window.memcode.saveSettings(draft));
                }}
                automaticDownloads={draft.automaticUpdateDownloads !== false}
                onAutomaticDownloadsChange={(value) =>
                  setDraft((draft) => ({
                    ...draft,
                    automaticUpdateDownloads: value,
                  }))
                }
              />
            </>
          )}
          {section === "privacy" && <TelemetrySettings notify={notify} />}
          {section === "integrations" && (
            <Integrations state={state} notify={notify} />
          )}
          {section === "account" && (
            <details className="settings-engine-advanced">
              <summary>Advanced · use an existing Memtrace CLI</summary>
              <div className="settings-section">
                <div>
                  <GitBranch size={17} />
                  <span>
                    <strong>Memtrace engine</strong>
                    <small>
                      Optional existing CLI setup. Beta uses its separately
                      managed local engine.
                    </small>
                  </span>
                  <span
                    className={
                      "connection-label " +
                      (runtime.memtraceAvailable ? "available" : "")
                    }
                  >
                    <span />
                    {runtime.memtraceAvailable ? "Detected" : "Not found"}
                  </span>
                </div>
                <label className="field">
                  <span>Executable or JavaScript entry point</span>
                  <input
                    aria-label="Memtrace executable"
                    placeholder="Auto-detect from PATH"
                    value={draft.memtracePath}
                    onChange={(e) =>
                      setDraft({ ...draft, memtracePath: e.target.value })
                    }
                  />
                </label>
              </div>
            </details>
          )}
          {section === "workers" && (
            <>
              <WorkerConnections
                state={state}
                runtime={runtime}
                notify={notify}
                onRuntime={onSaved}
                compact
              />
              <div className="settings-section">
                <div>
                  <WorkflowIcon />
                  <span>
                    <strong>Worker defaults</strong>
                    <small>
                      Execution stays local. Your harness controls model
                      authentication.
                    </small>
                  </span>
                </div>
                <div className="form-row">
                  <label className="field">
                    <span>Default harness</span>
                    <Select
                      value={draft.defaultHarness}
                      onValueChange={(e) =>
                        setDraft({
                          ...draft,
                          defaultHarness: e as Harness,
                          model:
                            e === draft.defaultHarness || draft.localModel
                              ? draft.model
                              : "",
                        })
                      }
                    >
                      <option value="codex">Codex</option>
                      <option value="claude">Claude Code</option>
                      <option value="cursor">Cursor</option>
                      <option value="copilot">GitHub Copilot</option>
                      <option value="dsh">DeepSeek Harness</option>
                    </Select>
                  </label>
                  <label className="field">
                    <span>Worker slots</span>
                    <Select
                      value={draft.maxWorkers}
                      onValueChange={(e) =>
                        setDraft({ ...draft, maxWorkers: Number(e) })
                      }
                    >
                      {workerSlotChoices.map((n) => (
                        <option key={n} value={n}>
                          {n} workers
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
                <label className="field">
                  <span>Model override</span>
                  {draft.localModel ? (
                    <input
                      aria-label="Model override"
                      placeholder="Installed Ollama model name"
                      value={draft.model}
                      onChange={(e) =>
                        setDraft({ ...draft, model: e.target.value })
                      }
                    />
                  ) : (
                    <ModelSelect
                      label="Model override"
                      harness={draft.defaultHarness}
                      models={models}
                      value={draft.model}
                      automaticLabel="Automatic · match task complexity"
                      onChange={(model) =>
                        setDraft({ ...draft, model: model ?? "" })
                      }
                    />
                  )}
                  <small>Automatic stories use this override. Story assignments take precedence.</small>
                </label>
                {(draft.defaultHarness === "dsh" ||
                  (dshRuntime?.available &&
                    (dshRuntime.profiles?.length ?? 0) > 0)) && (
                  <label className="field">
                    <span>DeepSeek Harness ACP profile</span>
                    <Select
                      aria-label="DeepSeek Harness ACP profile"
                      value={selectedDshProfile}
                      onValueChange={(dshProfile) =>
                        setDraft({
                          ...draft,
                          dshProfile,
                          // A dsh model override belongs to the previous profile's catalog.
                          ...(dshProfile !== selectedDshProfile &&
                          draft.defaultHarness === "dsh" &&
                          !draft.localModel
                            ? { model: "" }
                            : {}),
                        })
                      }
                    >
                      {dshProfileOptions.map((profile) => (
                        <option key={profile} value={profile}>
                          {profile}
                        </option>
                      ))}
                    </Select>
                    <small>
                      {dshProfilePending
                        ? "Save to load this profile’s models. Overrides that it does not offer reset to Automatic."
                        : "Models and providers are loaded from this ACP profile."}
                    </small>
                  </label>
                )}
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={draft.localModel}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        localModel: e.target.checked,
                        model: "",
                      })
                    }
                  />
                  <span>
                    Use a local Ollama model with Codex
                    <small>
                      Requires a model name and a local Ollama installation.
                      Applies to automatic stories and stories assigned to Codex.
                    </small>
                  </span>
                </label>
              </div>
            </>
          )}
          {section === "dictation" && (
            <DictationSettings
              settings={draft}
              change={(speech, endpoint) =>
                setDraft((value) => ({
                  ...value,
                  speech,
                  ...(endpoint !== undefined
                    ? { speechEndpoint: endpoint }
                    : {}),
                }))
              }
            />
          )}
          {section === "retrieval" && (
            <ContextSettings
              value={draft.contextAssistant}
              change={(contextAssistant) =>
                setDraft((value) => ({ ...value, contextAssistant }))
              }
            />
          )}
          <div className="storage-note">
            <ShieldCheck size={14} />
            <span>
              Your workspace is stored locally.<code>{runtime.dataPath}</code>
            </span>
          </div>
        </div>
        <footer className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <Check size={14} />}Save settings
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function WorkflowIcon() {
  return <Code2 size={17} />;
}

export function SearchDialog({
  tasks,
  onClose,
  open,
  create,
}: {
  tasks: WorkItem[];
  onClose: () => void;
  open: (task: WorkItem) => void;
  create: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const found = tasks
    .filter((t) =>
      `${t.title} ${t.identifier} ${t.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice(0, 8);
  return (
    <div
      className="modal-backdrop search-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search workspace"
      >
        <div className="command-input">
          <Search size={18} />
          <input
            aria-label="Search workspace"
            placeholder="Find a work item, or start something new…"
            value={query}
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(found.length - 1, i + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              }
              if (e.key === "Enter" && found[index]) open(found[index]);
            }}
          />
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close search"
          >
            <X size={15} />
          </button>
        </div>
        <div className="command-results">
          <span className="menu-eyebrow">
            {query ? "MATCHING WORK" : "RECENT WORK"}
          </span>
          {found.map((task, i) => (
            <button
              className={i === index ? "selected" : ""}
              key={task.id}
              onMouseEnter={() => setIndex(i)}
              onClick={() => open(task)}
            >
              <StageIcon stage={task.stage} />
              <span className="command-id">{task.identifier}</span>
              <span>{task.title}</span>
              <ChevronRight size={12} />
            </button>
          ))}
          {!found.length && (
            <p className="search-no-results">
              No matching work. Give the idea a new home.
            </p>
          )}
          <div className="menu-divider" />
          <button onClick={create}>
            <Plus size={14} />
            <span>Create a work item</span>
            <kbd>C</kbd>
          </button>
        </div>
        <footer className="command-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to navigate
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span>
            <kbd>esc</kbd> to close
          </span>
        </footer>
      </div>
    </div>
  );
}
