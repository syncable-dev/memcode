import { useEffect, useState, type Ref } from "react";
import {
  ArrowUpRight,
  GitBranch,
  Layers3,
  Link2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  AppState,
  Epic,
  Harness,
  RuntimeInfo,
  TeamWorkspaceState,
  WorkItem,
  ModelOption,
} from "../shared";
import { ModelSelect } from "./ModelSelect";
import { harnessNames } from "../shared";
import { workerReadiness } from "../worker-availability";
import { isActive, type pendingPrerequisites } from "../domain";
import { taskStatus } from "../planning/workflow";
import type { WorkflowState } from "../planning/types";
import { Select } from "./Select";
import { RoutingCard } from "./Routing";
import { WorkerPermissions } from "./WorkerPermissions";
import { teamClaimForStory, teamStartBlocked } from "../team-presentation";

type Update = (patch: Parameters<Window["memcode"]["updateTask"]>[1]) => void;

export function WorkerAssignment({
  task,
  runtime,
  settings,
  busy,
  plan,
  update,
  connections,
  onConnections,
  team,
  disabled = false,
}: {
  task: WorkItem;
  runtime: RuntimeInfo;
  settings: AppState["settings"];
  busy: boolean;
  plan: () => void;
  update: Update;
  connections: AppState["workerConnections"];
  onConnections: () => void;
  team?: TeamWorkspaceState;
  disabled?: boolean;
}) {
  const automatic = task.assignment === "auto";
  const owner = teamClaimForStory(team, task.id);
  const claimBlock = teamStartBlocked(team, task.id);
  const readiness = workerReadiness(task, runtime.harnesses, connections);
  const [refreshedModels, setRefreshedModels] = useState<ModelOption[]>();
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelsError, setModelsError] = useState("");
  useEffect(() => {
    setRefreshedModels(undefined);
    setModelsError("");
  }, [task.harness]);
  const remoteCatalog =
    refreshedModels ??
    runtime.harnesses.find((h) => h.id === task.harness)?.models ??
    [];
  const catalog =
    settings.localModel && task.harness === "codex"
      ? [task.modelOverride, settings.model]
          .filter(
            (id, index, ids): id is string => !!id && ids.indexOf(id) === index,
          )
          .map((id) => ({
            id,
            label: id + " · local",
            source: "alias" as const,
          }))
      : remoteCatalog;
  return (
    <>
      {team && (
        <div className="team-claim-notice" role="status">
          <span>
            <ShieldCheck size={12} />
            Shared task
          </span>
          <strong>
            {owner
              ? `${owner.name}${owner.local ? " · you" : ""}`
              : claimBlock
                ? "Waiting for connection"
                : "Available to claim"}
          </strong>
          <small>
            {owner
              ? owner.device
              : "Starting a worker reserves this task on this device."}
          </small>
          {claimBlock && <p>{claimBlock}</p>}
        </div>
      )}
      <label className="inspector-field">
        <span>Assignment</span>
        <Select
          aria-label="Assigned harness"
          value={automatic ? "auto" : task.harness}
          disabled={isActive(task)}
          onValueChange={(value) =>
            update(
              value === "auto"
                ? { assignment: "auto", modelOverride: null }
                : {
                    assignment: "manual",
                    harness: value as Harness,
                    modelOverride: null,
                  },
            )
          }
        >
          <option value="auto">Automatic</option>
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
          <option value="cursor">Cursor</option>
          <option value="copilot">GitHub Copilot</option>
          <option value="dsh">DeepSeek Harness</option>
        </Select>
      </label>
      <label className="inspector-field">
        <span>
          Model{" "}
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh available models"
            title="Refresh this account’s available models"
            disabled={refreshingModels || isActive(task)}
            onClick={async () => {
              setRefreshingModels(true);
              setModelsError("");
              try {
                const fresh = await window.memcode.refreshWorkerCatalog();
                setRefreshedModels(
                  fresh.harnesses.find((h) => h.id === task.harness)?.models ??
                    [],
                );
              } catch (error) {
                setModelsError((error as Error).message);
              } finally {
                setRefreshingModels(false);
              }
            }}
          >
            <RefreshCw
              size={11}
              className={refreshingModels ? "spin" : undefined}
            />
          </button>
        </span>
        <ModelSelect
          label="Assigned model"
          harness={task.harness}
          models={catalog}
          value={task.modelOverride}
          automaticLabel={
            automatic
              ? (task.route?.model ?? "Memtrace chooses")
              : "Match task complexity"
          }
          disabled={isActive(task) || automatic}
          onChange={(modelOverride) => update({ modelOverride })}
        />
        {modelsError && <small role="status">{modelsError}</small>}
        {task.harness === "codex" &&
          catalog.length > 0 &&
          catalog.every((m) => !/^gpt-6/.test(m.id)) && (
            <small>
              Only these models were offered by this Codex account and runtime.
              Refresh after updating Codex or switching its account.
            </small>
          )}
      </label>
      <div className="inspector-field">
        <span>Execution</span>
        <span>
          <span className="tiny-local-dot" />
          This computer
        </span>
      </div>
      <WorkerPermissions
        task={task}
        settings={settings}
        update={update}
        onDefaults={onConnections}
      />
      {!task.example && !readiness.canStart && (
        <div className="assignment-connect" role="status">
          <span>
            <Link2 size={13} />
            Connect in Workers
          </span>
          <p>
            {automatic
              ? task.route
                ? `${harnessNames[task.route.harness]} / ${task.route.modelLabel || task.route.model} is named for this task. Connect it in Workers before starting. The assignment does not start the work.`
                : "Memtrace names a harness and model from the measured task. Connect a worker in Workers before starting."
              : readiness.runtimeKnown
                ? `${harnessNames[task.harness]} is installed. Approve its connection before starting work.`
                : readiness.selectedInstalled
                  ? "The installed runtime path has not been confirmed. Check its connection in Workers."
                  : `Install the standalone ${harnessNames[task.harness]} CLI, then connect it in Workers.`}
          </p>
          <button className="secondary-button" onClick={onConnections}>
            Connect in Workers <ArrowUpRight size={12} />
          </button>
        </div>
      )}
      <RoutingCard
        task={task}
        busy={busy || isActive(task)}
        disabled={disabled}
        plan={plan}
      />
    </>
  );
}

export function WorkerPrerequisites({
  blockers,
  workflow,
  open,
  edit,
}: {
  blockers: ReturnType<typeof pendingPrerequisites>;
  workflow: WorkflowState[];
  open: (story: WorkItem) => void;
  edit: () => void;
}) {
  return (
    <section
      id="worker-prerequisites"
      className="worker-prerequisites"
      aria-label="Worker prerequisites"
    >
      <header>
        <strong>
          Waiting on{" "}
          {blockers.length === 1 ? "a prerequisite" : "prerequisites"}
        </strong>
        <button type="button" onClick={edit}>
          Edit prerequisites
        </button>
      </header>
      <ul>
        {blockers.map(({ id, story }) => (
          <li key={id}>
            {story ? (
              <button type="button" onClick={() => open(story)}>
                <span>
                  <small>
                    {story.identifier} · {story.archivedAt && "Archived · "}
                    {taskStatus(story, workflow).name}
                  </small>
                  {story.title}
                </span>
                <ArrowUpRight size={13} aria-hidden="true" />
              </button>
            ) : (
              <span>Task unavailable in this project</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function StoryMetadata({
  task,
  epics,
  tasks,
  update,
  prerequisitesRef,
}: {
  task: WorkItem;
  epics: Epic[];
  tasks: WorkItem[];
  update: Update;
  prerequisitesRef: Ref<HTMLDivElement>;
}) {
  const [scope, setScope] = useState((task.scope ?? []).join("\n"));
  useEffect(
    () => setScope((task.scope ?? []).join("\n")),
    [task.id, task.scope?.join("\n")],
  );
  const prerequisites = tasks.filter((item) =>
    task.dependsOn?.includes(item.id),
  );
  const missingCount = (task.dependsOn ?? []).filter(
    (id) => !prerequisites.some((item) => item.id === id),
  ).length;
  const disabled = isActive(task);
  return (
    <section className="inspector-section story-metadata">
      <details>
        <summary className="inspector-label">
          TASK DETAILS
          <Layers3 size={12} />
        </summary>
        <label className="metadata-field">
          <span>Goal</span>
          <Select
            aria-label="Work item goal"
            value={task.epicId ?? "none"}
            disabled={disabled}
            onValueChange={(value) =>
              update({ epicId: value === "none" ? null : value })
            }
          >
            <option value="none">Project work · default goal</option>
            {epics.map((epic) => (
              <option value={epic.id} key={epic.id}>
                {epic.title}
              </option>
            ))}
          </Select>
        </label>
        <label className="metadata-field">
          <span>Type of work</span>
          <Select
            aria-label="Work item type"
            value={task.kind ?? "feature"}
            disabled={disabled}
            onValueChange={(value) =>
              update({ kind: value as WorkItem["kind"] })
            }
          >
            <option value="feature">Feature</option>
            <option value="fix">Fix</option>
            <option value="refactor">Refactor</option>
            <option value="test">Verification</option>
            <option value="research">Research</option>
          </Select>
        </label>
        <label className="metadata-field">
          <span>
            Source scope <small>One file or directory per line</small>
          </span>
          <textarea
            aria-label="Source scope"
            value={scope}
            disabled={disabled}
            placeholder="src/components/Board.tsx"
            onChange={(event) => setScope(event.target.value)}
            onBlur={() => {
              const paths = scope
                .split("\n")
                .map((path) => path.trim())
                .filter(Boolean);
              if (paths.join("\n") !== (task.scope ?? []).join("\n"))
                update({ scope: paths });
            }}
          />
        </label>
        <div
          className="metadata-field"
          ref={prerequisitesRef}
          tabIndex={-1}
          aria-label="Edit task prerequisites"
          role="group"
        >
          <span>
            Prerequisites <small>Optional</small>
          </span>
          <p className="prerequisites-hint">
            Link a task when this work needs its result. Remove the link here
            if the two tasks can run independently.
          </p>
          {prerequisites.map((item) => (
            <div
              className={
                "prerequisite " + (item.stage === "done" ? "complete" : "")
              }
              key={item.id}
            >
              <GitBranch size={11} />
              <span>
                {item.identifier} · {item.title}
                {item.archivedAt && " (archived)"}
              </span>
              <button
                title="Remove prerequisite"
                disabled={disabled}
                onClick={() =>
                  update({
                    dependsOn: task.dependsOn?.filter((id) => id !== item.id),
                  })
                }
              >
                <X size={11} />
              </button>
            </div>
          ))}
          {missingCount > 0 && (
            <div className="prerequisite">
              <GitBranch size={11} />
              <span>
                {missingCount === 1
                  ? "1 unavailable task"
                  : `${missingCount} unavailable tasks`}
              </span>
              <button
                type="button"
                title="Remove unavailable prerequisites"
                disabled={disabled}
                onClick={() =>
                  update({ dependsOn: prerequisites.map((item) => item.id) })
                }
              >
                <X size={11} />
              </button>
            </div>
          )}
          <Select
            aria-label="Add prerequisite"
            value="none"
            disabled={disabled}
            onValueChange={(value) => {
              if (value !== "none")
                update({ dependsOn: [...(task.dependsOn ?? []), value] });
            }}
          >
            <option value="none">Add prerequisite…</option>
            {tasks
              .filter(
                (item) =>
                  item.id !== task.id &&
                  !item.archivedAt &&
                  !task.dependsOn?.includes(item.id),
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.identifier} · {item.title}
                </option>
              ))}
          </Select>
        </div>
      </details>
    </section>
  );
}
