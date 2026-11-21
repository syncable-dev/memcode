import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Columns3,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type {
  AppState,
  Project,
  WorkflowState,
  CustomField,
  Stage,
} from "../shared";
import { stages } from "../shared";
import { isBacklogStatus, workflowFor } from "../planning/workflow";
import { stageLabel } from "../domain";
import { Modal } from "./Dialogs";
import { Select } from "./Select";
import { Spinner } from "./UI";

export function BoardSettings({
  state,
  project,
  close,
  notify,
}: {
  state: AppState;
  project: Project;
  close: () => void;
  notify: (message: string) => void;
}) {
  const [tab, setTab] = useState<"workflow" | "fields">("workflow");
  const [workflow, setWorkflow] = useState(() =>
    structuredClone(workflowFor(state, project.id)),
  );
  const [fields, setFields] = useState(() =>
    structuredClone(
      state.customFields.filter((field) => field.projectId === project.id),
    ),
  );
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      state.customFields
        .filter((field) => field.projectId === project.id)
        .map((field) => [field.id, field.options.join(", ")]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const needsStage = (status: WorkflowState) => isBacklogStatus(status.id) ||
    !workflow.some((other) => other.id !== status.id && other.stage === status.stage && !isBacklogStatus(other.id));
  const update = (id: string, patch: Partial<WorkflowState>) =>
    setWorkflow((list) =>
      list.map((status) =>
        status.id === id ? { ...status, ...patch } : status,
      ),
    );
  const fieldUpdate = (id: string, patch: Partial<CustomField>) =>
    setFields((list) =>
      list.map((field) => (field.id === id ? { ...field, ...patch } : field)),
    );
  const reorder = (index: number, delta: number) =>
    setWorkflow((list) => {
      const next = [...list];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
  const parsedFields = fields.map((field) => ({
    ...field,
    name: field.name.trim(),
    options:
      field.type === "select"
        ? Array.from(
            new Set(
              (choices[field.id] ?? "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            ),
          )
        : field.options,
  }));
  const invalid =
    workflow.some(
      (status) =>
        !status.name.trim() ||
        (status.wipLimit !== null &&
          status.wipLimit !== undefined &&
          (!Number.isInteger(status.wipLimit) || status.wipLimit < 1)),
    ) ||
    parsedFields.some(
      (field) =>
        !field.name || (field.type === "select" && !field.options.length),
    );
  const save = async () => {
    setBusy(true);
    try {
      await window.memcode.saveWorkflow(
        project.id,
        workflow.map((status, order) => ({
          ...status,
          name: status.name.trim(),
          order,
        })),
      );
      await window.memcode.saveCustomFields(project.id, parsedFields);
      close();
    } catch (error) {
      notify((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="A workflow that fits your work."
      kicker="WORKSPACE SETTINGS"
      description="Name your lanes, set advisory limits, and keep useful fields close."
      close={() => {
        if (!busy) close();
      }}
      wide
    >
      <div className="settings-tabs">
        <button
          className={tab === "workflow" ? "active" : ""}
          onClick={() => setTab("workflow")}
        >
          <Columns3 size={13} />
          Workflow<span>{workflow.length}</span>
        </button>
        <button
          className={tab === "fields" ? "active" : ""}
          onClick={() => setTab("fields")}
        >
          <SlidersHorizontal size={13} />
          Custom fields<span>{fields.length}</span>
        </button>
      </div>
      <div className="modal-body board-settings-body">
        {tab === "workflow" ? (
          <>
            <div className="workspace-settings-intro">
              <h3>Make the board feel like your team.</h3>
              <p>
                Give every lane a clear purpose. Reorder lanes to match how work
                flows.
              </p>
            </div>
            <div className="workflow-editor-head">
              <span>Lane name</span>
              <span>Execution stage</span>
              <span>WIP limit</span>
              <span>Order</span>
            </div>
            {workflow.map((status, index) => (
              <div className="workflow-editor-row" key={status.id}>
                <label className="workflow-name">
                  <i style={{ background: status.color }} />
                  <input
                    aria-label={`Lane name ${status.id}`}
                    value={status.name}
                    maxLength={100}
                    onChange={(event) =>
                      update(status.id, { name: event.target.value })
                    }
                  />
                </label>
                <Select
                  aria-label={`Stage for ${status.name}`}
                  value={status.stage}
                  disabled={isBacklogStatus(status.id)}
                  onValueChange={(value) =>
                    update(status.id, { stage: value as Stage })
                  }
                >
                  {stages.map((stage) => (
                    <option
                      key={stage}
                      value={stage}
                      disabled={
                        stage !== status.stage &&
                        needsStage(status)
                      }
                    >
                      {stageLabel(stage)}
                    </option>
                  ))}
                </Select>
                <input
                  aria-label={`WIP limit for ${status.name}`}
                  type="number"
                  min="1"
                  step="1"
                  placeholder="None"
                  value={status.wipLimit ?? ""}
                  onChange={(event) =>
                    update(status.id, {
                      wipLimit: event.target.value
                        ? Number(event.target.value)
                        : null,
                    })
                  }
                />
                <div className="workflow-row-actions">
                  <button
                    className="icon-button"
                    aria-label={`Move ${status.name} earlier`}
                    disabled={index <= 1}
                    onClick={() => reorder(index, -1)}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Move ${status.name} later`}
                    disabled={index === 0 || index === workflow.length - 1}
                    onClick={() => reorder(index, 1)}
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${status.name}`}
                    title={
                      needsStage(status)
                        ? "Keep at least one lane for each execution stage"
                        : `Remove ${status.name}`
                    }
                    disabled={needsStage(status)}
                    onClick={() =>
                      setWorkflow((list) =>
                        list.filter((item) => item.id !== status.id),
                      )
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
            <button
              className="workspace-add-definition"
              onClick={() =>
                setWorkflow((list) => [
                  ...list,
                  {
                    id: crypto.randomUUID(),
                    projectId: project.id,
                    name: "Ready",
                    stage: "planned",
                    color: "#9aa991",
                    order: list.length,
                    wipLimit: null,
                  },
                ])
              }
            >
              <Plus size={13} />
              Add a lane
            </button>
            <p className="planning-help">
              Lanes map to four execution stages. A finished worker still enters
              review. WIP limits are visible planning guidance.
            </p>
          </>
        ) : (
          <>
            <div className="workspace-settings-intro">
              <h3>Useful context, close to the work.</h3>
              <p>Project fields appear in every task’s planning details.</p>
            </div>
            {!fields.length && (
              <div className="workspace-fields-empty">
                <SlidersHorizontal size={22} />
                <strong>Keep only the fields you need.</strong>
                <p>
                  Add a text, number, or choice field when it helps you make a
                  decision.
                </p>
              </div>
            )}
            {fields.map((field) => (
              <div className="field-editor" key={field.id}>
                <div>
                  <input
                    aria-label={`Field name ${field.id}`}
                    placeholder="Field name"
                    value={field.name}
                    maxLength={100}
                    onChange={(event) =>
                      fieldUpdate(field.id, { name: event.target.value })
                    }
                  />
                  <Select
                    aria-label={`Type for ${field.name}`}
                    value={field.type}
                    onValueChange={(value) =>
                      fieldUpdate(field.id, {
                        type: value as CustomField["type"],
                      })
                    }
                  >
                    <option value="text">Text</option>
                    <option value="number">Number</option>
                    <option value="select">Choices</option>
                  </Select>
                  <button
                    className="icon-button"
                    aria-label={`Remove field ${field.name}`}
                    onClick={() =>
                      setFields((list) =>
                        list.filter((item) => item.id !== field.id),
                      )
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {field.type === "select" && (
                  <label className="custom-field-choices">
                    <span>Choices, separated by commas</span>
                    <input
                      aria-label={`Choices for ${field.name}`}
                      placeholder="Frontend, Backend, Platform"
                      value={choices[field.id] ?? ""}
                      onChange={(event) =>
                        setChoices((current) => ({
                          ...current,
                          [field.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                )}
              </div>
            ))}
            <button
              className="workspace-add-definition"
              onClick={() =>
                setFields((list) => [
                  ...list,
                  {
                    id: crypto.randomUUID(),
                    projectId: project.id,
                    name: "New field",
                    type: "text",
                    options: [],
                  },
                ])
              }
            >
              <Plus size={13} />
              Add custom field
            </button>
            <p className="planning-help">
              Removing a field definition keeps the values tasks already have.
            </p>
          </>
        )}
      </div>
      <footer className="modal-footer">
        <button className="button secondary" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          onClick={() => void save()}
          disabled={busy || invalid}
        >
          {busy ? <Spinner size={13} /> : <SlidersHorizontal size={13} />}Save
          workspace settings
        </button>
      </footer>
    </Modal>
  );
}
