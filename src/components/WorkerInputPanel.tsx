import { useEffect, useState } from "react";
import { CircleHelp, Clock3, ShieldCheck, X } from "lucide-react";
import type { WorkItem } from "../shared";
import type { WorkerInputRequest, WorkerInputResponse } from "../worker-input";
import { loadCardDraft, saveCardDraft } from "../card-drafts";

export function WorkerInputPanel({ request }: { request: WorkerInputRequest }) {
  const key = "memcode-worker-input:" + request.id;
  const harness =
    request.harness === "claude"
      ? "Claude Code"
      : request.harness === "codex"
        ? "Codex"
        : "Cursor";
  const exactDetails = [request.details, request.title]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join("\n\n");
  const primaryOption = request.options?.find(
    (option) => option.kind === "allow-once",
  )?.id;
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(
      () => (loadCardDraft(key) as Record<string, string | string[]>) ?? {},
    ),
    [custom, setCustom] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    saveCardDraft(
      key,
      Object.fromEntries(
        Object.entries(answers).filter(
          ([id]) => !request.questions?.find((q) => q.id === id)?.secret,
        ),
      ),
    );
  }, [answers, key, request.questions]);
  const values = () =>
    Object.fromEntries(
      (request.questions ?? []).map((q) => [
        q.id,
        custom[q.id]?.trim() || answers[q.id] || "",
      ]),
    );
  const ready = (request.questions ?? []).every((q) => {
    const answer = values()[q.id];
    return Array.isArray(answer) ? answer.length > 0 : !!answer.trim();
  });
  const send = async (response: WorkerInputResponse) => {
    setBusy(true);
    setError("");
    try {
      await window.memcode.respondToWorker(
        request.taskId,
        request.id,
        response,
      );
      saveCardDraft(key, undefined);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="worker-input-panel"
      aria-label={
        request.kind === "approval"
          ? "Worker approval request"
          : "Worker question"
      }
      data-worker-input-id={request.id}
    >
      <header>
        <span className="worker-input-icon" aria-hidden="true">
          {request.kind === "approval" ? (
            <ShieldCheck size={15} />
          ) : (
            <CircleHelp size={15} />
          )}
        </span>
        <div className="worker-input-heading">
          <h3>
            {request.kind === "approval"
              ? "Permission requested"
              : request.kind === "plan"
                ? "Review the plan"
                : "Your input is needed"}
          </h3>
          <span>
            {harness} <i aria-hidden="true">·</i> Waiting for you
          </span>
        </div>
        <button
          className="worker-input-dismiss"
          aria-label="Dismiss request"
          title="Dismiss request"
          disabled={busy}
          onClick={() => void send({ cancelled: true })}
        >
          <X size={14} />
        </button>
      </header>
      <div className="worker-input-body">
        {request.kind === "approval" ? (
          <div className="worker-input-action-preview">
            <code>{request.title}</code>
          </div>
        ) : (
          <p className="worker-input-context">{request.title}</p>
        )}
        {request.description && (
          <p className="worker-input-description">{request.description}</p>
        )}
        {(request.kind === "approval" || request.details) && (
          <details className="worker-input-details">
            <summary>
              {request.toolName
                ? `Requested action · ${request.toolName}`
                : "View request details"}
            </summary>
            <pre>{exactDetails}</pre>
          </details>
        )}
        {(request.questions ?? []).map((q) => (
          <fieldset key={q.id} disabled={busy}>
            <legend>{q.question}</legend>
            <div className="worker-question-options">
              {q.options.map((option) => {
                const value = answers[q.id],
                  selected = Array.isArray(value)
                    ? value.includes(option.id)
                    : value === option.id;
                return (
                  <label key={option.id} className={selected ? "selected" : ""}>
                    <input
                      type={q.multiple ? "checkbox" : "radio"}
                      name={request.id + q.id}
                      checked={selected && !custom[q.id]}
                      onChange={() => {
                        setCustom((value) => ({ ...value, [q.id]: "" }));
                        setAnswers((value) => ({
                          ...value,
                          [q.id]: q.multiple
                            ? selected
                              ? (Array.isArray(value[q.id])
                                  ? (value[q.id] as string[])
                                  : []
                                ).filter((id) => id !== option.id)
                              : [
                                  ...(Array.isArray(value[q.id])
                                    ? (value[q.id] as string[])
                                    : []),
                                  option.id,
                                ]
                            : option.id,
                        }));
                      }}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {option.description && (
                        <small>{option.description}</small>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            {(q.allowText || !q.options.length) && (
              <label className="worker-custom-answer">
                <span>
                  {q.secret
                    ? "Private answer"
                    : q.options.length
                      ? "Or write your answer"
                      : "Your answer"}
                </span>
                {q.secret ? (
                  <input
                    aria-label={q.question}
                    type="password"
                    autoComplete="off"
                    value={custom[q.id] ?? ""}
                    maxLength={20000}
                    onChange={(e) =>
                      setCustom({ ...custom, [q.id]: e.target.value })
                    }
                  />
                ) : (
                  <textarea
                    aria-label={q.question}
                    value={custom[q.id] ?? ""}
                    maxLength={20000}
                    onChange={(e) =>
                      setCustom({ ...custom, [q.id]: e.target.value })
                    }
                  />
                )}
              </label>
            )}
          </fieldset>
        ))}
        {error && (
          <p className="worker-input-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        <span>{busy ? "Sending…" : "Reply to continue this worker."}</span>
        <div>
          {request.options?.length ? (
            request.options.map((option) => (
              <button
                key={option.id}
                className={
                  "button " +
                  (option.id === primaryOption ? "primary" : "secondary")
                }
                title={option.description}
                disabled={busy || !ready}
                onClick={() =>
                  void send({ optionId: option.id, answers: values() })
                }
              >
                {option.label}
              </button>
            ))
          ) : (
            <button
              className="button primary"
              disabled={busy || !ready}
              onClick={() => void send({ answers: values() })}
            >
              {busy ? "Sending…" : "Send answer"}
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

function secondsSince(clock: number, start?: string): number {
  const timestamp = start ? Date.parse(start) : NaN;
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.floor((clock - timestamp) / 1000))
    : 0;
}

function duration(seconds: number) {
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function WorkerActivityView({
  task,
  requestedAt,
}: {
  task: WorkItem;
  requestedAt?: string;
}) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const activity = task.run.activity;
  const elapsed = secondsSince(clock, activity?.at ?? task.run.startedAt);
  const age = duration(elapsed);
  if (requestedAt || task.run.state === "preparing") {
    const label = requestedAt
      ? "Requesting worker"
      : (activity?.label ?? "Preparing worker");
    const total = duration(
      secondsSince(clock, requestedAt ?? task.run.startedAt),
    );
    return (
      <div
        className="worker-start-progress"
        role="group"
        aria-label="Worker startup"
      >
        <Clock3 size={14} aria-hidden="true" />
        <span role="status">{label}</span>
        <small>
          {!requestedAt && activity?.at && elapsed >= 5 && (
            <>{age} on this step · </>
          )}
          {total} total
        </small>
      </div>
    );
  }
  return (
    <div
      className={"worker-live-activity " + (activity?.phase ?? "working")}
      role="group"
      aria-label="Worker activity"
    >
      <Clock3 size={13} aria-hidden="true" />
      <span role="status">
        {activity?.phase === "waiting_for_user"
          ? "Waiting for your reply below"
          : (activity?.label ?? "Working")}
      </span>
      {(activity?.phase === "tool" || elapsed >= 10) && (
        <small>
          {activity?.phase === "waiting_for_user" ||
          activity?.phase === "waiting_for_worker"
            ? `Waiting ${age}`
            : age}
        </small>
      )}
      {activity?.lastTool && (
        <small title={activity.lastTool.label}>
          Last tool {activity.lastTool.failed ? "failed" : "finished"} in{" "}
          {duration(Math.floor(activity.lastTool.durationMs / 1000))}
        </small>
      )}
    </div>
  );
}
