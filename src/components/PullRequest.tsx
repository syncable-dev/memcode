import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CircleCheck,
  Copy,
  GitBranch,
  GitPullRequest,
} from "lucide-react";
import type { AppState, Epic, WorkItem } from "../shared";
import { isQuickChanges } from "../domain";
import {
  descriptionParts,
  epicReadiness,
  type MergeResult,
  type PullRequestStatus,
  type PullRequestPlan,
  type PullRequestResult,
  type UnfinishedTask,
} from "../pull-request";
import { isOnBranch, pullRequestOf } from "../goal-work";
import { Modal } from "./Dialogs";
import MessageMarkdown from "./MessageMarkdown";
import { Spinner } from "./UI";

interface Props {
  epic: Epic;
  close: () => void;
  notify: (message: string) => void;
}

interface Drafts {
  title: string;
  description: string;
  commitMessage: string;
}

/** Shows exactly what Create will do, then commits, pushes and opens the PR. */
export function PullRequestSheet({ epic, close, notify }: Props) {
  const { plan, error, reload } = usePullRequestPlan(epic.id);
  const [result, setResult] = useState<PullRequestResult>();
  const [merged, setMerged] = useState<MergeResult>();
  const heading = plan?.existing ? "Pull request" : "Create pull request";
  return (
    <Modal
      title={
        merged
          ? `Merged into ${merged.pullRequest.base}`
          : result
            ? resultHeading(result)
            : heading
      }
      kicker={`${epic.identifier} · ${epic.title}`}
      description="The tasks worked on in this branch ship together in this pull request."
      close={close}
      wide
    >
      {merged ? (
        <MergeDone merged={merged} close={close} />
      ) : result && plan ? (
        <PullRequestDone
          result={result}
          plan={plan}
          close={close}
          notify={notify}
        />
      ) : error ? (
        <div className="modal-body">
          <p className="pr-blocker">{error}</p>
          <button className="button secondary" onClick={reload}>
            Try again
          </button>
        </div>
      ) : !plan ? (
        <div className="modal-body pr-loading">
          <Spinner size={13} />
          Checking the goal's branch and pull request…
        </div>
      ) : (
        <PullRequestForm
          plan={plan}
          reload={reload}
          close={close}
          notify={notify}
          onCreated={setResult}
          onMerged={setMerged}
        />
      )}
    </Modal>
  );
}

function PullRequestForm({
  plan,
  reload,
  close,
  notify,
  onCreated,
  onMerged,
}: {
  plan: PullRequestPlan;
  reload: () => void;
  close: () => void;
  notify: (message: string) => void;
  onCreated: (result: PullRequestResult) => void;
  onMerged: (result: MergeResult) => void;
}) {
  const [drafts, setDrafts] = useState<Drafts>(() => draftsFrom(plan));
  const [busy, setBusy] = useState(false);
  const [shipUnfinished, setShipUnfinished] = useState(false);
  useEffect(() => setDrafts(draftsFrom(plan)), [plan]);
  const create = async () => {
    setBusy(true);
    try {
      onCreated(
        await window.memcode.createPullRequest({
          epicId: plan.epicId,
          ...drafts,
          ...(plan.unfinished.length ? { shipUnfinished } : {}),
        }),
      );
    } catch (failure) {
      notify((failure as Error).message);
      setBusy(false);
      reload();
    }
  };
  const bringBase = async () => {
    setBusy(true);
    try {
      const result = await window.memcode.resolveGoalUpdate(plan.epicId);
      notify(
        result.asked
          ? `${result.asked} is resolving the conflicts with ${plan.base}. Push the update when it is done.`
          : `${plan.base} is in. Push the update to the pull request.`,
      );
    } catch (failure) {
      notify((failure as Error).message);
    }
    setBusy(false);
    reload();
  };
  const merge = async () => {
    setBusy(true);
    try {
      onMerged(await window.memcode.mergePullRequest(plan.epicId));
    } catch (failure) {
      notify((failure as Error).message);
      setBusy(false);
      reload();
    }
  };
  const open = plan.status?.state === "open";
  const pendingChanges = plan.uncommitted.length > 0 || plan.ahead > 0;
  const changeAttribution = (include: boolean) =>
    window.memcode
      .setHandoffAttribution(include ? "include" : "omit")
      .then(reload, (failure: Error) => notify(failure.message));
  const { readiness } = plan;
  return (
    <>
      <div className="modal-body pr-sheet">
        <div className="pr-route">
          <GitBranch size={13} />
          <code>{plan.branch}</code>
          <ArrowRight size={12} />
          <code>{plan.base}</code>
          <span>{changeSummary(plan)}</span>
          {plan.existing?.url && (
            <button
              className="pr-link"
              onClick={() =>
                void window.memcode
                  .openPullRequest(plan.epicId)
                  .catch((failure: Error) => notify(failure.message))
              }
            >
              Open on GitHub
              <ArrowUpRight size={11} />
            </button>
          )}
        </div>
        {plan.status && <GitHubStatus status={plan.status} />}
        {plan.blocker && !plan.existing ? (
          <p className="pr-blocker">{plan.blocker}</p>
        ) : (
          readiness.ready + readiness.unfinished < readiness.total && (
            <p className="pr-notice">
              {readiness.ready} of {readiness.total} tasks are in review.
              You can open the pull request now and push the rest later.
            </p>
          )
        )}
        {plan.unfinished.length > 0 && (
          <label className="pr-unfinished checkbox-label">
            <input
              id="pr-ship-unfinished"
              type="checkbox"
              checked={shipUnfinished}
              onChange={(event) => setShipUnfinished(event.target.checked)}
            />
            <span>
              Ship what{" "}
              {plan.unfinished.length === 1
                ? "this task"
                : `these ${plan.unfinished.length} tasks`}{" "}
              left unfinished
              {plan.unfinished.map((task) => (
                <small key={task.identifier}>
                  {task.identifier} · {task.title}. {unfinishedBecause[task.state]}
                </small>
              ))}
            </span>
          </label>
        )}
        {readiness.waiting > 0 && (
          <p className="pr-waiting">
            {readiness.waiting === 1
              ? "The goal's other task stays in the goal."
              : `The goal's other ${readiness.waiting} tasks stay in the goal.`}
          </p>
        )}
        {plan.notice && <p className="pr-notice">{plan.notice}</p>}
        <label className="field">
          <span>Title</span>
          <input
            value={drafts.title}
            onChange={(event) =>
              setDrafts({ ...drafts, title: event.target.value })
            }
          />
        </label>
        <DescriptionField
          value={drafts.description}
          onChange={(description) => setDrafts({ ...drafts, description })}
        />
        {plan.uncommitted.length > 0 && (
          <details className="pr-commit">
            <summary>Commit message</summary>
            <textarea
              className="pr-text"
              rows={6}
              spellCheck={false}
              aria-label="Commit message"
              value={drafts.commitMessage}
              onChange={(event) =>
                setDrafts({ ...drafts, commitMessage: event.target.value })
              }
            />
          </details>
        )}
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={plan.attribution !== "omit"}
            onChange={(event) => void changeAttribution(event.target.checked)}
          />
          <span>
            Add a MemCode line
            <small>
              A one-line footer and an Orchestrated-by trailer. Remembered for
              next time.
            </small>
          </span>
        </label>
        {plan.steps.length > 0 && (
          <div className="pr-steps">
            <strong>When you click {plan.existing ? "Update" : "Create"}</strong>
            <ol>
              {plan.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        )}
      </div>
      <footer className="modal-footer">
        <span>Nothing happens until you click.</span>
        <div className="pr-actions">
          <button className="button secondary" onClick={close}>
            Cancel
          </button>
          {(!plan.existing || pendingChanges) && (
            <button
              className={"button " + (open ? "secondary" : "primary")}
              disabled={
                !!plan.blocker ||
                busy ||
                !drafts.title.trim() ||
                (plan.unfinished.length > 0 && !shipUnfinished)
              }
              onClick={() => void create()}
            >
              {busy && !open && <Spinner size={12} />}
              {plan.existing ? "Push updates" : "Create pull request"}
            </button>
          )}
          {open && plan.status?.needsBase && (
            <button className="button secondary" disabled={busy} onClick={() => void bringBase()}>
              Update from {plan.base}
            </button>
          )}
          {open && (
            <button
              className="button primary"
              disabled={busy || !!plan.status?.mergeBlocker}
              title={plan.status?.mergeBlocker}
              onClick={() => void merge()}
            >
              {busy && <Spinner size={12} />}
              Merge pull request
            </button>
          )}
        </div>
      </footer>
    </>
  );
}

/** Preview first, like GitHub: people judge the PR by how it will read. */
function DescriptionField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  return (
    <div className="field pr-description">
      <div className="pr-description-head">
        <span>Description</span>
        <div role="tablist" aria-label="Description view">
          {(["preview", "edit"] as const).map((item) => (
            <button
              key={item}
              role="tab"
              aria-selected={mode === item}
              onClick={() => setMode(item)}
            >
              {item === "preview" ? "Preview" : "Edit"}
            </button>
          ))}
        </div>
      </div>
      {mode === "preview" ? (
        <div className="pr-preview">
          {descriptionParts(value).map((part, index) =>
            part.kind === "markdown" ? (
              <MessageMarkdown key={index} text={part.text} />
            ) : (
              <details key={index} className="pr-folded">
                <summary>{part.summary}</summary>
                <MessageMarkdown text={part.text} />
              </details>
            ),
          )}
        </div>
      ) : (
        <textarea
          aria-label="Description"
          rows={14}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

/** GitHub's review and checks, and the reason Merge is unavailable, if any. */
function GitHubStatus({ status }: { status: PullRequestStatus }) {
  const review = {
    approved: "Approved",
    "changes-requested": "Changes requested",
    "review-required": "Review required",
    "not-required": "No review required",
  }[status.review];
  const checks = {
    passing: "Checks passing",
    failing: "Checks failing",
    pending: "Checks running",
    none: "No checks",
  }[status.checks];
  return (
    <div className="pr-status">
      <span className={"pr-chip " + status.review}>{review}</span>
      <span className={"pr-chip " + status.checks}>{checks}</span>
      {status.mergeMethod && (
        <span className="pr-chip">Merges with {status.mergeMethod}</span>
      )}
      {status.mergeBlocker && (
        <span className="pr-status-note">{status.mergeBlocker}</span>
      )}
    </div>
  );
}

function MergeDone({
  merged,
  close,
}: {
  merged: MergeResult;
  close: () => void;
}) {
  return (
    <>
      <div className="modal-body pr-done">
        <ul>
          <li>
            <CircleCheck size={13} />
            Merged pull request
            {merged.pullRequest.number ? ` #${merged.pullRequest.number}` : ""}{" "}
            into <code>{merged.pullRequest.base}</code>
          </li>
          {merged.completedStories > 0 && (
            <li>
              <CircleCheck size={13} />
              Moved {merged.completedStories}{" "}
              {merged.completedStories === 1 ? "task" : "tasks"} to Done
            </li>
          )}
          <li>
            <CircleCheck size={13} />
            Goals that use the same files are marked Needs update
          </li>
          <li className="pr-done-next">
            <GitBranch size={13} />
            Next, the goal's history goes into the project's code index, then
            its checkout is removed. The branch stays.
          </li>
        </ul>
      </div>
      <footer className="modal-footer">
        <span />
        <button className="button primary" onClick={close}>
          Done
        </button>
      </footer>
    </>
  );
}

function PullRequestDone({
  result,
  plan,
  close,
  notify,
}: {
  result: PullRequestResult;
  plan: PullRequestPlan;
  close: () => void;
  notify: (message: string) => void;
}) {
  const needsDescription =
    result.descriptionOmitted || (result.pushed && result.opened === "none");
  const copyDescription = () =>
    navigator.clipboard
      .writeText(plan.description)
      .then(() => notify("Description copied."))
      .catch(() =>
        notify("Copy was blocked. Select the description and copy it."),
      );
  const openOnGitHub = () =>
    window.memcode
      .openPullRequest(plan.epicId)
      .catch((failure: Error) => notify(failure.message));
  return (
    <>
      <div className="modal-body pr-done">
        <ul>
          {result.committed && (
            <li>
              <CircleCheck size={13} />
              Committed {plan.uncommitted.length}{" "}
              {plan.uncommitted.length === 1 ? "file" : "files"} to{" "}
              <code>{plan.branch}</code>
            </li>
          )}
          {result.pushed && (
            <li>
              <CircleCheck size={13} />
              Pushed <code>{plan.branch}</code> to {plan.remote}
            </li>
          )}
          <li>
            <CircleCheck size={13} />
            {openedText(result)}
          </li>
        </ul>
        {needsDescription && (
          <p className="pr-notice">
            {result.descriptionOmitted
              ? "The description was too long for the link. Copy it and paste it into GitHub."
              : "Copy the description into the pull request on your Git host."}
          </p>
        )}
      </div>
      <footer className="modal-footer">
        <span />
        <div className="pr-actions">
          {needsDescription && (
            <button
              className="button secondary"
              onClick={() => void copyDescription()}
            >
              <Copy size={12} />
              Copy description
            </button>
          )}
          {result.pullRequest.url && (
            <button
              className="button secondary"
              onClick={() => void openOnGitHub()}
            >
              <ArrowUpRight size={12} />
              Open on GitHub
            </button>
          )}
          <button className="button primary" onClick={close}>
            Done
          </button>
        </div>
      </footer>
    </>
  );
}

function usePullRequestPlan(epicId: string) {
  const [plan, setPlan] = useState<PullRequestPlan>();
  const [error, setError] = useState<string>();
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let current = true;
    setError(undefined);
    window.memcode.pullRequestPlan(epicId).then(
      (next) => current && setPlan(next),
      (failure: Error) => current && setError(failure.message),
    );
    return () => {
      current = false;
    };
  }, [epicId, reloads]);
  return { plan, error, reload: () => setReloads((n) => n + 1) };
}

function draftsFrom(plan: PullRequestPlan): Drafts {
  return {
    title: plan.title,
    description: plan.description,
    commitMessage: plan.commitMessage,
  };
}

function changeSummary(plan: PullRequestPlan): string {
  const files = plan.uncommitted.length;
  if (files) return `${files} ${files === 1 ? "file" : "files"} to commit`;
  if (plan.ahead)
    return `${plan.ahead} ${plan.ahead === 1 ? "commit" : "commits"} to push`;
  return "";
}

function resultHeading(result: PullRequestResult): string {
  if (result.opened === "created") return "Pull request created";
  if (result.opened === "existing") return "Pull request updated";
  if (result.opened === "browser") return "Finish on GitHub";
  return result.pushed ? "Branch pushed" : "Changes committed";
}

function openedText(result: PullRequestResult): string {
  if (result.opened === "created") return "Opened the pull request on GitHub";
  if (result.opened === "existing")
    return "The open pull request now has these commits";
  if (result.opened === "browser")
    return "GitHub is open in your browser with the title and description filled in. Click Create pull request there.";
  return result.pushed
    ? "Open a pull request for this branch on your Git host"
    : "Add a remote to open pull requests from MemCode";
}

const unfinishedBecause: Record<UnfinishedTask["state"], string> = {
  failed: "Its worker failed.",
  stopped: "Its worker was stopped.",
  waiting: "It waits for a decision.",
};

/** Shown on a story once its branch can ship, where the person already is. */
export function StoryPullRequestBanner({
  task,
  state,
  onOpen,
}: {
  task: WorkItem;
  state: AppState;
  onOpen: (epicId: string) => void;
}) {
  if (task.stage !== "review" && task.stage !== "done") return null;
  const epic = state.epics.find((item) => item.id === task.epicId);
  if (!epic) return null;
  const record = pullRequestOf(state.pullRequests, epic, task);
  const readiness = epicReadiness(state.tasks, epic);
  if (!record && (!readiness.isReady || !isOnBranch(task, epic))) return null;
  const quick = isQuickChanges(epic);
  return (
    <div className="story-pr-banner">
      <GitPullRequest size={15} />
      <span>
        <strong>
          {record
            ? `Part of the “${epic.title}” pull request`
            : quick
              ? "Your quick changes are ready to ship"
              : `“${epic.title}” is ready for a pull request`}
        </strong>
        <small>
          {record
            ? "Tasks worked on together share a branch, so this work ships in that pull request."
            : quick
              ? `${readiness.total === 1 ? "This change ships" : `${readiness.total} small changes ship`} together in one pull request.`
              : readiness.total === 1
                ? "This task is in review. Open a pull request for it."
                : `${readiness.total} tasks are in review. They share a branch, so they ship together.`}
        </small>
      </span>
      <button
        className="button primary"
        onClick={() =>
          // A merged branch's checkout may be gone, so its pull request opens where it is.
          record?.state === "merged" && record.url
            ? void window.memcode
                .openPullRequest(epic.id, record.url)
                .catch(() => {})
            : onOpen(epic.id)
        }
      >
        {record ? "View pull request" : quick ? "Ship quick changes" : "Create pull request"}
      </button>
    </div>
  );
}
