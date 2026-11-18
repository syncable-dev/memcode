import { useEffect, useState } from "react";
import {
  Archive,
  ArrowUpRight,
  CalendarDays,
  GitFork,
  Hash,
  Plus,
  Tag,
  X,
} from "lucide-react";
import type { AppState, WorkItem, TaskPatch } from "../shared";
import { estimateOptions } from "../planning/types";
import { isActive } from "../domain";
import { Select } from "./Select";
import { StageIcon } from "./UI";

export function PlanningProperties({
  state,
  task,
  update,
  open,
  createChild,
}: {
  state: AppState;
  task: WorkItem;
  update: (patch: TaskPatch) => void;
  open: (task: WorkItem) => void;
  createChild: () => void;
}) {
  const [labels, setLabels] = useState((task.labels ?? []).join(", "));
  useEffect(
    () => setLabels((task.labels ?? []).join(", ")),
    [task.id, task.labels?.join(",")],
  );
  const disabled = isActive(task),
    cycles = state.cycles.filter(
      (cycle) =>
        cycle.projectId === task.projectId &&
        (cycle.state !== "completed" || cycle.id === task.cycleId),
    ),
    fields = state.customFields.filter(
      (field) => field.projectId === task.projectId,
    ),
    others = state.tasks.filter(
      (other) =>
        other.projectId === task.projectId &&
        other.id !== task.id &&
        !other.archivedAt,
    ),
    children = others.filter((other) => other.parentId === task.id);
  return (
    <section className="inspector-section planning-properties">
      <div className="inspector-label">
        PLANNING
        <CalendarDays size={12} />
      </div>
      <label className="metadata-field">
        <span>Cycle</span>
        <Select
          aria-label="Story cycle"
          disabled={disabled}
          value={task.cycleId ?? "none"}
          onValueChange={(value) =>
            update({ cycleId: value === "none" ? null : value })
          }
        >
          <option value="none">No cycle</option>
          {cycles.map((cycle) => (
            <option key={cycle.id} value={cycle.id}>
              {cycle.name}
              {cycle.state === "active" ? " · active" : ""}
            </option>
          ))}
        </Select>
      </label>
      <label className="metadata-field">
        <span>
          Estimate <small>Manual story points</small>
        </span>
        <Select
          aria-label="Story estimate"
          value={task.estimate ?? "none"}
          onValueChange={(value) =>
            update({ estimate: value === "none" ? null : Number(value) })
          }
        >
          <option value="none">Not estimated</option>
          {estimateOptions.map((value) => (
            <option key={value} value={value}>
              {value} points
            </option>
          ))}
          {task.estimate !== undefined &&
            task.estimate !== null &&
            !estimateOptions.includes(task.estimate) && (
              <option value={task.estimate}>{task.estimate} points</option>
            )}
        </Select>
      </label>
      <div className="planning-date-pair">
        <label className="metadata-field">
          <span>Start</span>
          <input
            aria-label="Story start date"
            type="date"
            value={task.startDate ?? ""}
            onChange={(event) =>
              update({ startDate: event.target.value || null })
            }
          />
        </label>
        <label className="metadata-field">
          <span>Due</span>
          <input
            aria-label="Story due date"
            type="date"
            value={task.dueDate ?? ""}
            onChange={(event) =>
              update({ dueDate: event.target.value || null })
            }
          />
        </label>
      </div>
      <label className="metadata-field">
        <span>Labels</span>
        <input
          aria-label="Story labels"
          placeholder="interface, orchestration…"
          value={labels}
          onChange={(event) => setLabels(event.target.value)}
          onBlur={() => {
            const next = labels
              .split(",")
              .map((label) => label.trim())
              .filter(Boolean);
            if (next.join(",") !== (task.labels ?? []).join(","))
              update({ labels: next });
          }}
        />
      </label>
      {!!task.labels?.length && (
        <div className="story-labels">
          {task.labels.map((label) => (
            <span key={label}>
              <Tag size={9} />
              {label}
            </span>
          ))}
        </div>
      )}
      <details className="planning-relations">
        <summary>
          Relationships & fields <GitFork size={12} />
        </summary>
        <label className="metadata-field">
          <span>Parent story</span>
          <Select
            aria-label="Parent story"
            value={task.parentId ?? "none"}
            onValueChange={(value) =>
              update({ parentId: value === "none" ? null : value })
            }
          >
            <option value="none">No parent story</option>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.identifier} · {other.title}
              </option>
            ))}
          </Select>
        </label>
        <label className="metadata-field">
          <span>Duplicate of</span>
          <Select
            aria-label="Duplicate story"
            value={task.duplicateOf ?? "none"}
            onValueChange={(value) =>
              update({ duplicateOf: value === "none" ? null : value })
            }
          >
            <option value="none">Not a duplicate</option>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.identifier} · {other.title}
              </option>
            ))}
          </Select>
        </label>
        <div className="metadata-field">
          <span>Related stories</span>
          {others
            .filter((other) => task.relatedIds?.includes(other.id))
            .map((other) => (
              <div key={other.id} className="prerequisite">
                <button onClick={() => open(other)}>
                  {other.identifier} · {other.title}
                </button>
                <button
                  aria-label={`Remove relation to ${other.identifier}`}
                  onClick={() =>
                    update({
                      relatedIds: task.relatedIds?.filter(
                        (id) => id !== other.id,
                      ),
                    })
                  }
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          <Select
            aria-label="Add related story"
            value="none"
            onValueChange={(value) => {
              if (value !== "none")
                update({ relatedIds: [...(task.relatedIds ?? []), value] });
            }}
          >
            <option value="none">Link a story…</option>
            {others
              .filter((other) => !task.relatedIds?.includes(other.id))
              .map((other) => (
                <option key={other.id} value={other.id}>
                  {other.identifier} · {other.title}
                </option>
              ))}
          </Select>
        </div>
        {fields.map((field) => (
          <label key={field.id} className="metadata-field">
            <span>{field.name}</span>
            {field.type === "select" ? (
              <Select
                aria-label={field.name}
                value={
                  task.customFields?.[field.id] == null
                    ? "unset"
                    : `option:${task.customFields[field.id]}`
                }
                onValueChange={(value) =>
                  update({
                    customFields: {
                      ...task.customFields,
                      [field.id]: value === "unset" ? null : value.slice(7),
                    },
                  })
                }
              >
                <option value="unset">Not set</option>
                {task.customFields?.[field.id] != null &&
                  !field.options.includes(
                    String(task.customFields[field.id]),
                  ) && (
                    <option value={`option:${task.customFields[field.id]}`}>
                      {task.customFields[field.id]} · stored value
                    </option>
                  )}
                {field.options.map((option) => (
                  <option key={option} value={`option:${option}`}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : (
              <input
                aria-label={field.name}
                type={field.type === "number" ? "number" : "text"}
                defaultValue={task.customFields?.[field.id] ?? ""}
                key={task.id + field.id}
                onBlur={(event) =>
                  update({
                    customFields: {
                      ...task.customFields,
                      [field.id]:
                        event.target.value === ""
                          ? null
                          : field.type === "number"
                            ? Number(event.target.value)
                            : event.target.value,
                    },
                  })
                }
              />
            )}
          </label>
        ))}
      </details>
      <div className="child-stories">
        <div>
          <span>
            Child stories{" "}
            <small>
              {children.filter((child) => child.stage === "done").length}/
              {children.length}
            </small>
          </span>
          <button
            aria-label="Add child story"
            title={
              task.stage === "done"
                ? "Reopen this story to add unfinished child work"
                : "Add child story"
            }
            disabled={task.stage === "done"}
            onClick={createChild}
          >
            <Plus size={12} />
          </button>
        </div>
        {children.map((child) => (
          <button key={child.id} onClick={() => open(child)}>
            <StageIcon stage={child.stage} />
            <span>{child.title}</span>
            <ArrowUpRight size={11} />
          </button>
        ))}
      </div>
      <button
        className="archive-story"
        disabled={disabled}
        onClick={() =>
          update({
            archivedAt: task.archivedAt ? null : new Date().toISOString(),
          })
        }
      >
        <Archive size={12} />
        {task.archivedAt ? "Restore story" : "Archive story"}
      </button>
    </section>
  );
}
