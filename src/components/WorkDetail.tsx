import { priorities, priorityLabels } from "../planning/priority";
import { harnessNames } from "../shared";
import { Select } from "./Select";
import {
  StoryMetadata,
  WorkerAssignment,
  WorkerPrerequisites,
} from "./WorkerAssignment";
import { PlanningProperties } from "./PlanningProperties";
import { TrackedIssue, TrackedKey } from "./TrackedIssue";
import { WorkerBrowser } from "./WorkerBrowser";
import { ArtifactPreview } from "./ArtifactPreview";
import { ArtifactCollection } from "./ArtifactCollection";
import { groupedArtifacts } from "../artifact-purpose";
import { isWebLink, type FileReference } from "../file-reference";
import { reviewLocation } from "../review-labels";
import type { ReviewReference, ReviewComment } from "../review";
import { ReviewComposer } from "./ReviewComposer";
import { ReviewNotes } from "./ReviewNotes";
import { FollowupQueue, pendingFollowups } from "./FollowupQueue";
import { StoryComments } from "./StoryComments";
import { WorkerInputPanel, WorkerActivityView } from "./WorkerInputPanel";
import { WorkerAsks } from "./WorkerAsks";
import { DeleteAction } from "./DeleteAction";
import { workerReadiness } from "../worker-availability";
import {
  teamClaimForStory,
  teamStartBlocked,
  presentedTask,
} from "../team-presentation";
import { RemoteWorker, remoteActivityLabel } from "./RemoteWorker";
import { useRuntimeHealth } from "../useRuntimeHealth";
import { ConversationMessages } from "./ConversationMessage";
import { OthersRun } from "./OthersRun";
import { followsConversationTail } from "../conversation-performance";
import { useConversationDraft } from "../useConversationDraft";
import { filesOnly } from "../attachments";
import { AttachButton, AttachedFiles, useAttach } from "./Attachments";
import { modifierLabel, primaryModifier, shortcutLabel } from "../platform";
import "../styles-review.css";
import "../styles-worker-input.css";
import "../styles-annotations.css";
import "../styles-card-comments.css";
import { WorkerChanges } from "./WorkerChanges";
import { ShareFromCard } from "./ShareFromCard";
import {
  cardRunElsewhere,
  isUnfetchedSharedFile,
  onlyItsOwnerContinues,
  runElsewhereNote,
  sendElsewhereLabel,
  cardFileList,
} from "../sharing-cards";
import { StoryTabBar, type StoryTab, type StoryTabItem } from "./StoryTabBar";
import { isCodeReviewTask } from "../code-review-workflow";
import { taskStatus, workflowFor } from "../planning/workflow";
import type { CodeReviewFinding } from "../code-review";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  AudioLines,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  Code2,
  ExternalLink,
  FileCode2,
  Files,
  GitBranch,
  Globe2,
  ListChecks,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type {
  Artifact,
  Project,
  RuntimeInfo,
  WorkItem,
  Message,
  Epic,
  FleetConflict,
  AppState,
} from "../shared";
import { isActive, pendingPrerequisites, progress } from "../domain";
import { useDictation } from "../useDictation";
import { StoryPullRequestBanner } from "./PullRequest";
import {
  Empty,
  HarnessMark,
  WorkerMark,
  Mark,
  PriorityMark,
  Spinner,
  StageIcon,
  Time,
} from "./UI";

type Act = (action: () => Promise<unknown>) => Promise<void>;
const WorkerTerminal = lazy(() =>
  import("./WorkerTerminal").then((module) => ({
    default: module.WorkerTerminal,
  })),
);
const CodeReview = lazy(() =>
  import("./CodeReview").then((module) => ({ default: module.CodeReview })),
);
interface Props {
  state: AppState;
  task: WorkItem;
  project: Project;
  artifacts: Artifact[];
  initialArtifact?: Artifact;
  runtime: RuntimeInfo;
  epics: Epic[];
  conflicts: FleetConflict[];
  onDecisions: () => void;
  onPullRequest: (epicId: string) => void;
  onConnections: () => void;
  tasks: WorkItem[];
  onClose: () => void;
  onOpenTask: (task: WorkItem) => void;
  onCreateChild: () => void;
  notify: (s: string) => void;
  act: Act;
  obscured?: boolean;
  guidedTour?: boolean;
  onGuideTourEnd?: () => void;
  initialTab?: "review";
}

export function WorkDetail({
  state,
  task: localTask,
  project,
  artifacts: ownArtifacts,
  initialArtifact,
  runtime,
  epics,
  conflicts,
  onDecisions,
  onPullRequest,
  onConnections,
  tasks,
  onClose,
  onOpenTask,
  onCreateChild,
  notify,
  act,
  obscured = false,
  guidedTour,
  onGuideTourEnd,
  initialTab,
}: Props) {
  const shared = localTask.sharedSession;
  const task = presentedTask(localTask);
  const health = useRuntimeHealth();
  const team = state.team?.find((item) => item.projectId === task.projectId);
  // A run shown from the card's log at the sharing service: read here, never steered.
  const elsewhere = cardRunElsewhere(localTask);
  const owner = teamClaimForStory(team, task.id) ?? elsewhere;
  const sharedBoard = state.sharedBoards?.find(
    (board) => board.projectId === localTask.projectId,
  );
  const sharedProjectName = state.sharedProjectLinks?.find(
    (link) => link.projectId === localTask.projectId,
  )?.sharedProjectName;
  const artifacts = cardFileList(localTask, ownArtifacts);
  const [sharing, setSharing] = useState("");
  // While a card of a shared project is open, what happens to it elsewhere is followed.
  useEffect(() => {
    if (!sharedBoard) return;
    const taskId = localTask.id;
    void window.memcode.followSharedCard(taskId).catch(() => {});
    return () => void window.memcode.unfollowSharedCard(taskId).catch(() => {});
  }, [localTask.id, !!sharedBoard]);
  const remote = owner && !owner.local ? owner : undefined;
  const teamBlock = teamStartBlocked(team, task.id);
  const blockers = pendingPrerequisites(task, tasks);
  const prerequisitesRef = useRef<HTMLDivElement>(null);
  // What a worker on another computer waits for comes from the card's log, to answer from here.
  const pendingInputs = elsewhere
    ? (localTask.sharedInputs ?? [])
    : remote
      ? []
      : (state.workerInputs ?? []).filter(
          (input) => input.taskId === task.id && input.status === "pending",
        );
  const yours = !!localTask.sharedRunIsYours;
  // Someone else's run: its conversation is theirs alone (MemSync ADR-0019).
  const othersRun = elsewhere && !yours ? elsewhere : undefined;
  const [tab, setTab] = useState<StoryTab>(
    () =>
      initialTab ?? (isCodeReviewTask(state, task) ? "review" : "conversation"),
  );
  const reviewing = isCodeReviewTask(state, task);
  const workflow = workflowFor(state, task.projectId);
  const status = taskStatus(task, workflow);
  const [changeTarget, setChangeTarget] = useState<CodeReviewFinding>();
  const {
    draft,
    setDraft,
    attachedComments,
    setAttachedComments,
    clearSubmitted,
    files: draftFiles,
    setFiles: setDraftFiles,
  } = useConversationDraft(task.id);
  const attach = useAttach(draftFiles, setDraftFiles, notify);
  const [commentFocus, setCommentFocus] = useState(0);
  const [commentsOpen, setCommentsOpen] = useState(false),
    [focusedCommentId, setFocusedCommentId] = useState<string>(),
    [editingComment, setEditingComment] = useState<ReviewComment>();
  const comments = (state.reviewComments ?? []).filter(
    (comment) => comment.taskId === task.id,
  );
  const discussion = (state.storyComments ?? []).filter(
      (comment) => comment.taskId === task.id,
    ),
    pending = pendingFollowups(task);
  const [browserLink, setBrowserLink] = useState<{ url: string; id: string }>();
  const [file, setFile] = useState<FileReference>(),
    [references, setReferences] = useState<ReviewReference[]>([]);
  const [check, setCheck] = useState("");
  const [busy, setBusy] = useState(false);
  const [startRequest, setStartRequest] = useState<{
    taskId: string;
    at: string;
    previousStart?: string;
    error?: string;
  }>();
  const [planning, setPlanning] = useState(false);
  const measuredStory = useRef<string>("");
  const plan = () =>
    void act(async () => {
      setPlanning(true);
      try {
        if (project.analysis !== "ready")
          await window.memcode.analyzeProject(project.id);
        await window.memcode.qualifyTask(task.id);
      } finally {
        setPlanning(false);
      }
    });
  useEffect(() => {
    // Reviewing saved evidence must not start implementation qualification or
    // indexing. Check the lane too: an in-place card switch updates tab later.
    // A project with no folder on this computer, as a shared one opened here, has nothing to measure.
    if (
      remote ||
      reviewing ||
      tab === "review" ||
      !health.available ||
      !project.path ||
      task.example ||
      task.route ||
      isActive(task)
    )
      return;
    if (measuredStory.current === task.id) return;
    measuredStory.current = task.id;
    plan();
  }, [
    remote?.claim.attemptId,
    reviewing,
    tab,
    health.available,
    task.id,
    task.example,
    task.route,
    task.run.state,
  ]);
  const [selectedArtifact, setArtifact] = useState<Artifact | null>(null);
  const artifact =
    artifacts.find((item) => item.id === selectedArtifact?.id) ??
    selectedArtifact;
  const messagesRef = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);
  const conversationTask = useRef<string | undefined>(undefined);
  const dictation = useDictation(
    (text) => setDraft((value) => [value, text].filter(Boolean).join("\n")),
    notify,
  );
  useEffect(() => {
    setTab(
      initialTab ?? (isCodeReviewTask(state, task) ? "review" : "conversation"),
    );
    setChangeTarget(undefined);
    setCommentsOpen(false);
    setFocusedCommentId(undefined);
    setEditingComment(undefined);
    setAttachedComments((ids) =>
      ids.filter((id) =>
        comments.some((note) => note.id === id && note.status === "saved"),
      ),
    );
    setBrowserLink(undefined);
    setArtifact(null);
    setFile(undefined);
    setReferences([]);
  }, [task.id]);
  useEffect(() => {
    if (reviewing) setTab("review");
  }, [reviewing]);
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  useEffect(() => {
    if (initialArtifact) {
      setArtifact(initialArtifact);
      setTab("artifacts");
    }
  }, [initialArtifact?.id, task.id]);
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const opening = conversationTask.current !== task.id;
    conversationTask.current = task.id;
    if (opening || followConversation.current) {
      followConversation.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }, [
    task.messages.length,
    task.messages.at(-1)?.text,
    task.run.state,
    startRequest?.error,
    task.id,
    tab,
  ]);
  const run = async () => {
    if (teamBlock) {
      notify(teamBlock);
      return;
    }
    const submitted = {
      draft,
      comments: [...attachedComments],
      files: draftFiles,
    };
    followConversation.current = true;
    const request = {
      taskId: task.id,
      at: new Date().toISOString(),
      previousStart: task.run.startedAt,
    };
    setStartRequest(request);
    try {
      if (draft.trim() || draftFiles.length) {
        const text = draft.trim() || filesOnly(draftFiles.length);
        if (attachedComments.length)
          await window.memcode.shareReviewComments(
            task.id,
            attachedComments,
            text,
            draftFiles.length ? draftFiles : undefined,
          );
        else
          await window.memcode.addMessage(
            task.id,
            text,
            undefined,
            draftFiles.length ? draftFiles : undefined,
          );
        clearSubmitted(submitted);
      }
      await window.memcode.startWorker(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStartRequest((previous) =>
        previous === request ? { ...request, error: message } : previous,
      );
      if (tab !== "conversation") notify(message);
    } finally {
      setStartRequest((previous) =>
        previous === request ? undefined : previous,
      );
    }
  };
  const send = async () => {
    if (teamBlock && !remote && !isActive(task)) {
      notify(teamBlock);
      return;
    }
    if (!health.available) {
      notify(
        "Reopen MemCode to reconnect before sending. Your draft is kept here.",
      );
      return;
    }
    if (!draft.trim() && !draftFiles.length) return;
    const submitted = {
      draft,
      comments: [...attachedComments],
      files: draftFiles,
    };
    followConversation.current = true;
    if (
      !remote &&
      !task.example &&
      !isActive(task) &&
      !workerReadiness(task, runtime.harnesses, state.workerConnections)
        .canStart
    ) {
      notify("Connect a worker in Workers before sending this task.");
      return;
    }
    await act(async () => {
      await window.memcode.sendFollowup(
        task.id,
        draft.trim() || filesOnly(draftFiles.length),
        attachedComments.length ? attachedComments : undefined,
        draftFiles.length ? draftFiles : undefined,
      );
      clearSubmitted(submitted);
      // Sent to another computer: the message shows how it stands instead.
      if (isActive(task) && !elsewhere)
        notify(
          "Follow-up queued. The worker will pick it up automatically when ready.",
        );
    });
  };
  const toggle = (id: string) =>
    void act(() =>
      window.memcode.updateTask(task.id, {
        checklist: task.checklist.map((item) =>
          item.id === id ? { ...item, done: !item.done } : item,
        ),
      }),
    );
  const removeCheck = (id: string) =>
    void act(() =>
      window.memcode.updateTask(task.id, {
        checklist: task.checklist.filter((item) => item.id !== id),
      }),
    );
  const addCheck = async () => {
    if (!check.trim()) return;
    await act(async () => {
      await window.memcode.updateTask(task.id, {
        checklist: [
          ...task.checklist,
          { id: crypto.randomUUID(), text: check.trim(), done: false },
        ],
      });
      setCheck("");
    });
  };
  const openArtifact = async (item: Artifact) => {
    if (isUnfetchedSharedFile(item))
      return act(async () => {
        const fetched = await window.memcode.openSharedCardFile({
          taskId: task.id,
          resultId: item.id.slice("shared:".length),
        });
        setArtifact(fetched);
        setTab("artifacts");
      });
    setArtifact(item);
    setTab("artifacts");
  };
  const shareFile = (item: Artifact) =>
    void act(async () => {
      setSharing(item.id);
      try {
        await window.memcode.shareCardFile({
          taskId: task.id,
          artifactId: item.id,
        });
        notify(`${item.name} is shared with ${sharedProjectName}`);
      } finally {
        setSharing("");
      }
    });
  // Sharing is offered on the computer that ran the worker, for a shared project.
  const mayShare = !!sharedBoard && !elsewhere && !task.example;
  const comment = (reference: ReviewReference) => {
    if (reference.taskId !== task.id) return;
    setReferences([reference]);
    setEditingComment(undefined);
    setCommentsOpen(false);
  };
  const focusComment = async (note: ReviewComment) => {
    void window.memcode.previewAction("clear-selection").catch(() => {});
    setCommentFocus((value) => value + 1);
    setFocusedCommentId(note.id);
    setCommentsOpen(true);
    setReferences([]);
    if (note.reference.kind === "changes") setTab("changes");
    else if (note.reference.kind === "terminal") setTab("terminal");
    else if (note.reference.path)
      await openLink(
        note.reference.path +
          (note.reference.kind === "file" && note.reference.lineStart
            ? ":" + note.reference.lineStart
            : ""),
      );
  };
  const openLink = async (href: string, basePath?: string) => {
    try {
      if (isWebLink(href)) {
        setBrowserLink({ url: href, id: crypto.randomUUID() });
        setTab("browser");
        return;
      }
      const target = await window.memcode.resolveFile(task.id, href, basePath);
      const saved = artifacts.find((item) => item.id === target.artifactId);
      if (saved) {
        setArtifact(saved);
        setTab("artifacts");
      } else {
        setFile(target);
        setTab("file");
      }
    } catch (error) {
      notify((error as Error).message);
    }
  };
  useEffect(
    () =>
      window.memcode.onReview((event) => {
        if (event.action === "comment") comment(event.reference);
        else if (event.action === "focus-comment" && event.taskId === task.id) {
          const note = comments.find((c) => c.id === event.commentId);
          if (note) void focusComment(note);
        } else if (event.action === "link" && event.taskId === task.id)
          void openLink(event.href, event.basePath);
      }),
    [task.id, artifacts, state.reviewComments],
  );
  const available = runtime.harnesses.find(
    (h) => h.id === task.harness,
  )?.available;
  const active = isActive(task);
  useEffect(() => {
    if (active) setStartRequest(undefined);
  }, [active, task.id]);
  const currentRequest =
    startRequest?.taskId === task.id &&
    !active &&
    task.run.startedAt === startRequest.previousStart
      ? startRequest
      : undefined;
  const requestedAt = currentRequest?.error ? undefined : currentRequest?.at;
  const launchError = currentRequest?.error || (!requestedAt && task.run.error);
  const starting = !!requestedAt || task.run.state === "preparing";
  const startupProgress = health.available && starting && (
    <WorkerActivityView task={task} requestedAt={requestedAt} />
  );
  const connection = workerReadiness(
    task,
    runtime.harnesses,
    state.workerConnections,
  );
  const sessionLabel = starting
    ? "Preparing worker"
    : {
        stopping: "Stopping worker…",
        stopped: "Worker stopped",
        blocked: task.run.waitingOnDecision
          ? "Paused until you decide"
          : task.run.waitingOnCode
            ? "Waiting for another worker"
            : "Worker needs attention",
        failed: "Worker needs attention",
        finished: "Worker finished",
        idle: undefined,
        running: undefined,
        preparing: undefined,
      }[task.run.state];
  const openConnections = () => {
    try {
      sessionStorage.setItem(
        "memcode:connection-draft:" + task.id,
        JSON.stringify({ draft, comments: attachedComments }),
      );
    } catch {
      notify("Keep this task open until its draft is saved.");
      return;
    }
    onConnections();
  };
  const tabs: StoryTabItem[] = [
    { id: "conversation", label: "Conversation", icon: MessageSquare },
    { id: "queue", label: "Queue", icon: ListChecks, count: pending.length },
    {
      id: "comments",
      label: "Comments",
      icon: MessageSquare,
      count: discussion.filter((comment) => !comment.deletedAt).length,
    },
    { id: "runbook", label: "Runbook", icon: ListChecks },
    { id: "changes", label: "Changes", icon: Code2 },
    {
      id: "review",
      label: "Code review",
      icon: ShieldCheck,
      count: task.codeReview?.findingCount,
    },
    {
      id: "artifacts",
      label: "Artifacts",
      icon: Files,
      count: groupedArtifacts(artifacts).primary.length,
    },
    { id: "browser", label: "Browser", icon: Globe2 },
    { id: "terminal", label: "Terminal", icon: Terminal },
    ...(file
      ? [{ id: "file" as const, label: file.name, icon: FileCode2 }]
      : []),
  ];
  return (
    <div
      className="detail-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="work-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
      >
        <header className="detail-topbar">
          <div>
            <button
              className="icon-button"
              onClick={onClose}
              aria-label="Back to workspace"
            >
              <ArrowLeft size={16} />
            </button>
            <LayersIcon />
            <span>{project.name}</span>
            <ChevronRight size={12} />
            <span className="detail-identifier">{task.identifier}</span>
          </div>
          <div>
            {task.example && (
              <span className="detail-example">Example session</span>
            )}
            <button
              className="icon-button"
              title="Open goal workspace"
              disabled={!!remote || (!task.run.workspace && !task.run.worktree)}
              onClick={() =>
                void act(() => window.memcode.openWorkerWorkspace(task.id))
              }
            >
              <ExternalLink size={14} />
            </button>
            <DeleteAction
              compact
              kind="story"
              id={task.id}
              name={task.title}
              disabled={!!remote || isActive(task)}
              withChildren={tasks.some((item) => item.parentId === task.id)}
              onDeleted={onClose}
            />
            <button
              className="icon-button"
              aria-label="Close work item"
              onClick={onClose}
            >
              <X size={17} />
            </button>
          </div>
        </header>
        <div className="detail-heading">
          <div className="detail-heading-label">
            <span className="category">
              <i />
              {task.category}
            </span>
            <span className="detail-heading-dot" />
            <span>{task.identifier}</span>
            <TrackedKey task={task} />
          </div>
          <h2 id="detail-title">{task.title}</h2>
          <div className="detail-properties">
            <label className={"status-select " + task.stage}>
              <StageIcon stage={task.stage} />
              <Select
                aria-label="Work item status"
                value={status.id}
                onValueChange={(e) =>
                  void act(() =>
                    window.memcode.updateTask(task.id, {
                      statusId: e,
                    }),
                  )
                }
              >
                {workflow.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
              <ChevronDown size={10} />
            </label>
            <span className="property-divider" />
            <label className="property-select">
              <PriorityMark value={task.priority} />
              <Select
                aria-label="Work item priority"
                value={task.priority}
                onValueChange={(e) =>
                  void act(() =>
                    window.memcode.updateTask(task.id, {
                      priority: e as WorkItem["priority"],
                    }),
                  )
                }
              >
                {priorities.map((priority) => (
                  <option key={priority} value={priority}>
                    {priorityLabels[priority]}
                  </option>
                ))}
              </Select>
            </label>
            <span className="property-divider" />
            <span className="detail-local">
              <span />
              {remote ? `On ${remote.device}` : "Local execution"}
            </span>
          </div>
        </div>
        <StoryPullRequestBanner
          task={task}
          state={state}
          onOpen={onPullRequest}
        />
        <StoryTabBar
          key={task.id}
          tab={tab}
          tabs={tabs}
          needsReply={pendingInputs.length > 0}
          guidedTour={guidedTour}
          onGuideTourEnd={onGuideTourEnd}
          onSelect={(next) => {
            if (next !== "artifacts") setArtifact(null);
            setTab(next);
          }}
        />
        <div
          className={
            "detail-body" + (tab === "review" ? " is-code-review" : "")
          }
        >
          <div className="detail-content">
            {tab === "review" && (
              <Suspense fallback={<Spinner />}>
                <CodeReview
                  key={task.id}
                  task={task}
                  canStartReview={reviewing && !remote}
                  remoteReview={
                    remote && reviewing
                      ? {
                          host: remote.device,
                          waiting: !!team?.sessionCommands?.some(
                            (c) =>
                              c.storyId === task.id &&
                              c.kind === "review-start" &&
                              ["queued", "received"].includes(c.state),
                          ),
                          error: team?.sessionCommands
                            ?.filter(
                              (c) =>
                                c.storyId === task.id &&
                                c.kind === "review-start",
                            )
                            .at(-1)?.error,
                        }
                      : undefined
                  }
                  notify={notify}
                  onOpenSource={(path, line) =>
                    void openLink(path + (line ? `:${line}` : ""))
                  }
                  onOpenChanges={(finding) => {
                    setChangeTarget(finding);
                    setTab("changes");
                  }}
                />
              </Suspense>
            )}
            {tab === "queue" && (
              <FollowupQueue
                key={task.id}
                task={task}
                comments={comments}
                notify={notify}
                memberId={team?.memberId}
              />
            )}
            {tab === "comments" && (
              <StoryComments
                key={task.id}
                taskId={task.id}
                comments={discussion}
                notify={notify}
                onOpenLink={(href) => void openLink(href)}
                onFollowup={
                  remote
                    ? undefined
                    : (text) => {
                        setDraft((value) =>
                          [value, text].filter(Boolean).join("\n\n"),
                        );
                        setTab("conversation");
                      }
                }
              />
            )}
            {remote && (tab === "terminal" || tab === "browser") && (
              <Empty
                icon={<ExternalLink size={23} />}
                title={`Open the ${tab} on ${remote.device}.`}
                description={`${remote.name} holds this task there. You can leave a comment for the team here.`}
                action={
                  <button
                    className="secondary-button"
                    onClick={() => setTab("comments")}
                  >
                    Task comments
                  </button>
                }
              />
            )}
            {tab === "terminal" && !remote && (
              <Suspense fallback={<Spinner />}>
                <WorkerTerminal
                  task={task}
                  onComment={comment}
                  comments={comments.filter(
                    (comment) => comment.reference.kind === "terminal",
                  )}
                  focusedCommentId={focusedCommentId}
                  focusVersion={commentFocus}
                  onFocusComment={(id) => {
                    const note = comments.find((c) => c.id === id);
                    if (note) void focusComment(note);
                  }}
                  onBrowser={(url) => {
                    void openLink(url);
                  }}
                />
              </Suspense>
            )}
            {tab === "conversation" && (
              <>
                {pending.length > 0 && (
                  <button
                    className="followup-queue-summary"
                    onClick={() => setTab("queue")}
                    aria-label="View queued follow-ups"
                  >
                    <ListChecks size={14} />
                    <strong>
                      {pending.length} follow-up
                      {pending.length === 1 ? "" : "s"} waiting
                    </strong>
                    {/* Sent to a worker on another computer: they can only be viewed. */}
                    <span>
                      {pending.every((message) => message.deliveryLine)
                        ? "View"
                        : "View, edit or cancel"}
                    </span>
                    <ArrowRight size={13} />
                  </button>
                )}
                <div
                  className="conversation-scroll"
                  ref={messagesRef}
                  onScroll={(event) => {
                    followConversation.current = followsConversationTail(
                      event.currentTarget,
                    );
                  }}
                >
                  <div className="session-start">
                    <span>THE WORK STARTS WITH A CLEAR BRIEF</span>
                    <i />
                  </div>
                  {othersRun && shared ? (
                    <OthersRun
                      owner={othersRun}
                      request={localTask.description.trim() || localTask.title}
                      session={shared}
                      onOpenLink={(href) => void openLink(href)}
                    />
                  ) : (
                    <ConversationMessages
                      key={task.id}
                      messages={task.messages}
                      harness={task.harness}
                      from={
                        // An issue brought in keeps its own id: its words are Linear's.
                        task.tracker?.id === task.id ? task.tracker.key : undefined
                      }
                      onOpenLink={(href) => void openLink(href)}
                      comments={comments}
                      onOpenReference={(reference, id) => {
                        const note = comments.find((c) => c.id === id);
                        if (note) void focusComment(note);
                        else if (reference.path) void openLink(reference.path);
                      }}
                    />
                  )}
                  {!remote &&
                    health.available &&
                    task.run.state === "running" && (
                      <WorkerActivityView task={task} />
                    )}
                  {launchError && (
                    <div className="run-error" role="alert">
                      <Terminal size={14} />
                      <div>
                        <strong>The worker needs attention.</strong>
                        <p>{launchError}</p>
                      </div>
                    </div>
                  )}
                  {!remote && !health.available && active && (
                    <div className="run-error" role="status">
                      <Terminal size={14} />
                      <div>
                        <strong>Worker connection lost.</strong>
                        <p>
                          Live status is unavailable. Reopen MemCode before
                          continuing this task.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
                <div
                  className={
                    "conversation-composer" +
                    (pendingInputs.length ? " has-worker-input" : "")
                  }
                >
                  {remote && (
                    <div className="shared-session-status" role="status">
                      <span className="status-dot" />
                      <strong>
                        {remote.name} · {remote.device}
                      </strong>
                      <span>
                        {team?.connection === "offline"
                          ? "Offline · follow-ups wait for reconnection"
                          : (shared?.activity?.label ??
                            remoteActivityLabel(remote))}
                      </span>
                    </div>
                  )}
                  {team?.sessionsError && remote && (
                    <p className="shared-session-error" role="status">
                      Session sync: {team.sessionsError}
                    </p>
                  )}
                  {!remote && startupProgress}
                  {!!localTask.sharedAsks?.length && (
                    <WorkerAsks
                      taskId={localTask.id}
                      asks={localTask.sharedAsks}
                      act={act}
                    />
                  )}
                  {pendingInputs.length > 0 && (
                    <div className="worker-input-stack">
                      {pendingInputs.map((request) => (
                        <WorkerInputPanel key={request.id} request={request} />
                      ))}
                    </div>
                  )}
                  {othersRun && (
                    <p className="shared-only-owner" role="note">
                      <span>{onlyItsOwnerContinues(othersRun)}</span>
                      <button
                        className="button secondary"
                        onClick={() => setTab("comments")}
                      >
                        <MessageSquare size={12} />
                        Comment
                      </button>
                    </p>
                  )}
                  {!othersRun && (
                    <>
                      <div
                        className={
                          "composer-box " +
                          (dictation.phase === "recording"
                            ? "recording"
                            : "") +
                          (attach.over ? " attach-over" : "")
                        }
                        {...attach.drop}
                      >
                        <AttachedFiles
                          items={draftFiles}
                          setItems={setDraftFiles}
                          notify={notify}
                        />
                        {attachedComments.length > 0 && (
                          <div className="followup-comment-chips">
                            {attachedComments.map((id) => {
                              const note = comments.find((c) => c.id === id);
                              return note ? (
                                <span key={id}>
                                  <MessageSquare size={11} />
                                  {note.reference.name} ·{" "}
                                  {reviewLocation(note.reference)}
                                  <button
                                    className="icon-button"
                                    aria-label="Remove attached comment"
                                    onClick={() =>
                                      setAttachedComments((values) =>
                                        values.filter((value) => value !== id),
                                      )
                                    }
                                  >
                                    <X size={10} />
                                  </button>
                                </span>
                              ) : null;
                            })}
                          </div>
                        )}
                        <textarea
                          aria-label="Message to worker"
                          placeholder={
                            elsewhere
                              ? runElsewhereNote(elsewhere)
                              : task.example
                                ? "Explore the conversation, or add a note…"
                                : active
                                  ? "Queue a follow-up for the next worker pass…"
                                  : "Add context, ask a follow-up, or describe the next step…"
                          }
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          {...attach.paste}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && primaryModifier(e)) {
                              e.preventDefault();
                              void send();
                            }
                          }}
                        />
                        <div className="composer-controls">
                          <div>
                            <WorkerMark task={task} small />
                            <span>
                              {task.route
                                ? `${harnessNames[task.route.harness]} · ${task.route.modelLabel || task.route.model}`
                                : task.assignment === "auto"
                                  ? "Choosing a harness"
                                  : harnessNames[task.harness]}
                            </span>
                            {dictation.phase !== "idle" && (
                              <span className="recording-label">
                                {dictation.label}
                              </span>
                            )}
                          </div>
                          <div>
                            <AttachButton
                              attach={attach}
                              disabled={!health.available || !!elsewhere}
                            />
                            <button
                              className={"dictation-button " + dictation.phase}
                              title={
                                dictation.label || "Dictate a note locally"
                              }
                              aria-label="Dictate a note"
                              onClick={() => void dictation.toggle()}
                              disabled={
                                !health.available ||
                                dictation.phase === "preparing" ||
                                dictation.phase === "transcribing"
                              }
                            >
                              {dictation.phase === "preparing" ||
                              dictation.phase === "transcribing" ? (
                                <Spinner />
                              ) : dictation.phase === "recording" ? (
                                <Square size={11} />
                              ) : (
                                <AudioLines size={16} />
                              )}
                            </button>
                            <button
                              className="send-button"
                              title={
                                !health.available
                                  ? "Reopen MemCode to reconnect before sending"
                                  : elsewhere
                                    ? sendElsewhereLabel(elsewhere)
                                    : !remote && !active && teamBlock
                                      ? teamBlock
                                      : !remote &&
                                          !task.example &&
                                          !active &&
                                          !connection.canStart
                                        ? "Connect in Workers before sending this task"
                                        : active
                                          ? `Queue follow-up · ${shortcutLabel("Enter")}`
                                          : `Send follow-up · ${shortcutLabel("Enter")}`
                              }
                              aria-label={
                                active ? "Queue follow-up" : "Send follow-up"
                              }
                              disabled={
                                !health.available ||
                                (!draft.trim() && !draftFiles.length) ||
                                attach.adding > 0 ||
                                (!remote && !active && !!teamBlock) ||
                                (!remote &&
                                  !task.example &&
                                  !active &&
                                  !connection.canStart)
                              }
                              onClick={() => void send()}
                            >
                              <ArrowUp size={15} />
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="composer-hint">
                        <span>
                          <ShieldCheck size={10} />
                          Your conversation stays in this workspace.
                        </span>
                        <span>
                          <kbd>{modifierLabel()}</kbd>
                          <kbd>↵</kbd> to send
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
            {tab === "runbook" && (
              <div className="runbook-view">
                <div className="runbook-intro">
                  <div className="eyebrow">
                    <span />
                    THE OUTCOME
                  </div>
                  <h3>A clear brief. A focused path.</h3>
                  <p>
                    {task.description ||
                      "Add context to the conversation to help the worker understand the outcome."}
                  </p>
                </div>
                <div className="runbook-heading">
                  <h4>Runbook</h4>
                  <span>
                    {task.checklist.filter((item) => item.done).length} of{" "}
                    {task.checklist.length} complete
                  </span>
                </div>
                <div className="runbook-progress">
                  <i style={{ width: progress(task) + "%" }} />
                </div>
                <div className="checklist">
                  {task.checklist.map((item) => (
                    <div key={item.id} className="checklist-row">
                      <button
                        className={item.done ? "checked" : ""}
                        onClick={() => toggle(item.id)}
                      >
                        <span className="check-box">
                          {item.done && <Check size={12} />}
                        </span>
                        <span>{item.text}</span>
                      </button>
                      <button
                        className="checklist-remove"
                        aria-label={`Remove step “${item.text}”`}
                        title="Remove this step"
                        onClick={() => removeCheck(item.id)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <form
                  className="add-check"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addCheck();
                  }}
                >
                  <Plus size={14} />
                  <input
                    aria-label="New runbook step"
                    placeholder="Add the next step…"
                    value={check}
                    onChange={(e) => setCheck(e.target.value)}
                  />
                  {check && (
                    <button className="text-button" type="submit">
                      Add
                      <ArrowRight size={12} />
                    </button>
                  )}
                </form>
                <div className="runbook-note">
                  <GitBranch size={15} />
                  <p>
                    The worker follows this runbook and ticks each step as it
                    finishes it. A tick is the worker’s own progress report, so
                    review the actual result before accepting a change.
                  </p>
                </div>
              </div>
            )}
            {tab === "changes" && (
              <WorkerChanges
                task={task}
                focusTarget={changeTarget}
                onComment={comment}
                comments={comments.filter(
                  (comment) => comment.reference.kind === "changes",
                )}
                focusedCommentId={focusedCommentId}
                focusVersion={commentFocus}
                onFocusComment={(id) => {
                  const note = comments.find((c) => c.id === id);
                  if (note) void focusComment(note);
                }}
              />
            )}
            {tab === "file" && file && (
              <ArtifactPreview
                key={file.path}
                file={file}
                commentId={focusedCommentId}
                commentFocus={commentFocus}
                taskId={task.id}
                obscured={obscured}
                onBack={() => setTab("conversation")}
              />
            )}
            {tab === "artifacts" &&
              (artifact ? (
                <ArtifactPreview
                  key={artifact.id}
                  artifact={artifact}
                  commentId={focusedCommentId}
                  commentFocus={commentFocus}
                  taskId={task.id}
                  obscured={obscured}
                  onBack={() => setArtifact(null)}
                />
              ) : artifacts.length ? (
                <div className="detail-artifacts">
                  <div className="eyebrow">
                    <span />
                    BUILT ALONG THE WAY
                  </div>
                  <h3>Artifacts and reports.</h3>
                  <p>
                    Reports and deliverables, with supporting evidence below.
                  </p>
                  <ArtifactCollection
                    key={task.id}
                    artifacts={artifacts}
                    onOpen={(item) => void openArtifact(item)}
                  />
                  {mayShare && (
                    <ShareFromCard
                      projectName={sharedProjectName ?? "the shared project"}
                      artifacts={ownArtifacts.filter(
                        (item) => !item.id.startsWith("shared:"),
                      )}
                      sharedNames={
                        new Set(
                          (localTask.sharedResults ?? [])
                            .filter((result) => result.sharedHere)
                            .map((result) => result.name),
                        )
                      }
                      busy={sharing}
                      onShare={shareFile}
                    />
                  )}
                </div>
              ) : (
                <Empty
                  icon={<Files size={27} />}
                  title="Keep the output close."
                  description="Reports, images and HTML files saved by the worker under .memcode/workers/<task-id>/artifacts/ will appear here."
                />
              ))}
            {tab === "browser" && !remote && (
              <WorkerBrowser
                key={task.id}
                task={task}
                obscured={obscured}
                notify={notify}
                opening={browserLink}
                onOpeningConsumed={() => setBrowserLink(undefined)}
              />
            )}
            {comments.length > 0 && !references.length && !commentsOpen && (
              <div className="review-attachment-bar">
                <MessageSquare size={12} />
                {comments.some((comment) => comment.status === "saved")
                  ? comments.filter((comment) => comment.status === "saved")
                      .length + " comments saved locally"
                  : comments.length + " comments on this card"}
                <button onClick={() => setCommentsOpen(true)}>
                  Review comments
                  <ArrowUpRight size={11} />
                </button>
              </div>
            )}
            {commentsOpen && !references.length && (
              <ReviewNotes
                comments={comments}
                focusedId={focusedCommentId}
                onFocus={(note) => void focusComment(note)}
                onClose={() => setCommentsOpen(false)}
                onEdit={(note) => {
                  setEditingComment(note);
                  setReferences([note.reference]);
                  setCommentsOpen(false);
                }}
                onDelete={(note) =>
                  void act(() =>
                    window.memcode.deleteReviewComment(task.id, note.id),
                  )
                }
                onAttach={(ids) => {
                  setAttachedComments(ids);
                  setCommentsOpen(false);
                  setTab("conversation");
                  setDraft(
                    (value) =>
                      value || "Please address the selected review comments.",
                  );
                }}
              />
            )}
            {references.length > 0 && (
              <ReviewComposer
                references={references}
                onRemove={(index) =>
                  setReferences((value) => value.filter((_, i) => i !== index))
                }
                editing={editingComment}
                onClose={() => {
                  setReferences([]);
                  setEditingComment(undefined);
                  void window.memcode
                    .previewAction("clear-selection")
                    .catch(() => {});
                }}
                onSave={async (text, refs) => {
                  for (const reference of refs) {
                    const saved = await window.memcode.saveReviewComment({
                      taskId: task.id,
                      reference,
                      text,
                      id: editingComment?.id,
                    });
                    setFocusedCommentId(saved.id);
                  }
                  notify(
                    "Comment saved on the selection. Add it to a follow-up when you’re ready.",
                  );
                }}
              />
            )}
          </div>
          <aside className="work-inspector">
            {conflicts.length > 0 && (
              <div className="fleet-paused-banner">
                <span>Fleet paused for your decision</span>
                <button onClick={onDecisions}>
                  Review
                  <ArrowUpRight size={12} />
                </button>
              </div>
            )}
            {remote ? (
              <RemoteWorker
                owner={remote}
                scope={elsewhere ? "project" : "team"}
                offline={
                  team?.connection === "offline" ||
                  team?.connection === "connecting"
                }
              />
            ) : (
              <section className="inspector-section">
                <div className="inspector-label">
                  WORKER ASSIGNMENT
                  <span>
                    {task.example
                      ? "PREVIEW"
                      : !health.available
                        ? "DISCONNECTED"
                        : active
                          ? "ACTIVE"
                          : "LOCAL"}
                  </span>
                </div>
                <div className="assigned-worker">
                  <WorkerMark task={task} />
                  <div>
                    <strong>
                      {task.route
                        ? harnessNames[task.route.harness]
                        : task.assignment === "auto"
                          ? "Automatic"
                          : harnessNames[task.harness]}
                    </strong>
                    <span>
                      {task.example
                        ? "Example conversation"
                        : !health.available
                          ? "Runtime disconnected · live status unavailable"
                          : (sessionLabel ??
                            (active
                              ? pendingInputs.length
                                ? "Waiting for your answer"
                                : task.run.activity?.phase ===
                                    "waiting_for_worker"
                                  ? "Waiting for a Fleet handoff"
                                  : task.run.activity?.phase === "finishing"
                                    ? "Finishing the worker turn"
                                    : "Working on the goal"
                              : task.route
                                ? connection.routeConnected
                                  ? `${task.route.modelLabel || task.route.model} · assigned, not started`
                                  : `${task.route.modelLabel || task.route.model} · connect before starting`
                                : task.assignment === "auto"
                                  ? planning
                                    ? "Measuring who picks this up"
                                    : "Waiting for a measured assignment"
                                  : connection.selectedConnected
                                    ? "Connection approved"
                                    : available
                                      ? "Installed · approval needed"
                                      : "Runtime not detected"))}
                    </span>
                  </div>
                  <span
                    className={
                      health.available && active ? "live-dot" : "quiet-dot"
                    }
                  />
                </div>
                <WorkerAssignment
                  task={task}
                  runtime={runtime}
                  settings={state.settings}
                  connections={state.workerConnections}
                  team={team}
                  onConnections={openConnections}
                  busy={planning}
                  disabled={!health.available}
                  plan={plan}
                  update={(patch) =>
                    void act(() => window.memcode.updateTask(task.id, patch))
                  }
                />
                {pendingInputs.length > 0 && tab !== "conversation" && (
                  <button
                    className="worker-reply-link"
                    onClick={() => setTab("conversation")}
                  >
                    <MessageSquare size={13} />
                    Waiting for your reply
                    <ArrowRight size={13} />
                  </button>
                )}
                {!active && blockers.length > 0 && (
                  <WorkerPrerequisites
                    blockers={blockers}
                    workflow={workflow}
                    open={onOpenTask}
                    edit={() => {
                      const details =
                        prerequisitesRef.current?.closest("details");
                      if (details) details.open = true;
                      prerequisitesRef.current?.focus();
                    }}
                  />
                )}
                {tab !== "conversation" && startupProgress}
                {active ? (
                  <button
                    className="button stop-worker"
                    onClick={() =>
                      void act(() => window.memcode.stopWorker(task.id))
                    }
                    disabled={
                      !health.available || task.run.state === "stopping"
                    }
                  >
                    {task.run.state === "stopping" ? (
                      <Spinner />
                    ) : (
                      <Square size={11} />
                    )}
                    {task.run.state === "stopping"
                      ? "Stopping worker…"
                      : "Stop worker"}
                  </button>
                ) : (
                  <button
                    className="button start-worker"
                    aria-describedby={
                      blockers.length ? "worker-prerequisites" : undefined
                    }
                    onClick={() => void run()}
                    disabled={
                      !health.available ||
                      busy ||
                      !!requestedAt ||
                      conflicts.length > 0 ||
                      blockers.length > 0 ||
                      !!teamBlock ||
                      !connection.canStart
                    }
                    title={
                      teamBlock ??
                      (!connection.canStart
                        ? task.route
                          ? `Connect ${harnessNames[task.route.harness]} in Workers before starting`
                          : "Connect an approved worker in Workers first"
                        : undefined)
                    }
                  >
                    {requestedAt ? <Spinner /> : <Play size={12} />}{" "}
                    {requestedAt
                      ? "Starting worker…"
                      : task.run.workspace
                        ? "Resume task"
                        : "Start worker"}
                    <ArrowUpRight size={12} />
                  </button>
                )}
                {task.example && (
                  <p className="inspector-caption">
                    Connect a local project to run real work.
                  </p>
                )}
              </section>
            )}
            <StoryMetadata
              task={task}
              epics={epics}
              tasks={tasks}
              prerequisitesRef={prerequisitesRef}
              update={(patch) =>
                void act(() => window.memcode.updateTask(task.id, patch))
              }
            />
            <TrackedIssue task={task} state={state} act={act} />
            <PlanningProperties
              state={state}
              task={task}
              update={(patch) =>
                void act(() => window.memcode.updateTask(task.id, patch))
              }
              open={onOpenTask}
              createChild={onCreateChild}
            />
            {!remote && (
              <section className="inspector-section context-section">
                <div className="inspector-label">
                  CODE CONTEXT
                  <GitBranch size={12} />
                </div>
                {project.analysis === "error" && project.analysisNote && (
                  <details className="context-connection-error">
                    <summary>Code context couldn’t connect</summary>
                    <p>{project.analysisNote}</p>
                  </details>
                )}
                {task.evidence ? (
                  <>
                    <div className="evidence-status">
                      <span
                        className={
                          task.evidence.state === "measured"
                            ? "live-dot"
                            : "quiet-dot"
                        }
                      />
                      {task.evidence.state === "measured"
                        ? "Measured context"
                        : task.evidence.state === "partial"
                          ? "Partial context"
                          : "Not connected"}
                    </div>
                    <p className="context-note">{task.evidence.note}</p>
                    <div className="evidence-counts">
                      <div>
                        <strong>{task.evidence.symbols.length}</strong>
                        <span>Source anchors</span>
                      </div>
                      <div>
                        <strong>
                          {task.evidence.affected === undefined
                            ? "—"
                            : `${task.evidence.affected}${task.evidence.incomplete ? "+" : ""}`}
                        </strong>
                        <span>Observed impact</span>
                      </div>
                    </div>
                    {task.evidence.symbols.slice(0, 3).map((symbol, index) => (
                      <div
                        className="source-anchor"
                        key={symbol.file + symbol.name + index}
                      >
                        <Code2 size={11} />
                        <span>
                          <strong>{symbol.name}</strong>
                          <small>
                            {symbol.file.split(/[\\/]/).slice(-2).join("/")}:
                            {symbol.line}
                          </small>
                        </span>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="context-empty">
                    <span className="context-glyph">
                      <GitBranch size={20} />
                    </span>
                    <h4>Context before code.</h4>
                    <p>
                      Bring the relevant symbols, relationships and decisions
                      into this work.
                    </p>
                  </div>
                )}
                <button
                  className="context-action"
                  disabled={
                    starting ||
                    busy ||
                    project.example ||
                    ["connecting", "indexing"].includes(project.analysis)
                  }
                  onClick={() =>
                    void act(async () => {
                      setBusy(true);
                      try {
                        if (project.analysis !== "ready")
                          await window.memcode.analyzeProject(project.id);
                        await window.memcode.qualifyTask(task.id);
                      } finally {
                        setBusy(false);
                      }
                    })
                  }
                >
                  {busy ||
                  ["connecting", "indexing"].includes(project.analysis) ? (
                    <Spinner size={12} />
                  ) : (
                    <GitBranch size={12} />
                  )}{" "}
                  {project.analysis === "ready"
                    ? "Refresh work context"
                    : "Connect Memtrace"}
                  <ArrowRight size={12} />
                </button>
              </section>
            )}
            <section className="inspector-section">
              <div className="inspector-label">
                WORKING AGREEMENT
                <ShieldCheck size={12} />
              </div>
              <div className="agreement-row">
                <Check size={12} />
                <span>Local project and artifact storage</span>
              </div>
              <div className="agreement-row">
                <Check size={12} />
                <span>Shared goal work with Fleet coordination</span>
              </div>
              <div className="agreement-row">
                <Check size={12} />
                <span>Review before marking done</span>
              </div>
              {!remote && task.run.branch && (
                <div className="branch-card">
                  <GitBranch size={12} />
                  <span>{task.run.branch}</span>
                  <button
                    title="Open goal workspace"
                    className="icon-button"
                    onClick={() =>
                      void act(() =>
                        window.memcode.openWorkerWorkspace(task.id),
                      )
                    }
                  >
                    <ArrowUpRight size={12} />
                  </button>
                </div>
              )}
            </section>
            <div className="inspector-footnote">
              <Mark small />
              <span>
                Memtrace provides the context.
                <br />
                You stay in the loop.
              </span>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function LayersIcon() {
  return (
    <span className="detail-folder">
      <Files size={13} />
    </span>
  );
}
