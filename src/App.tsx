import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { cardActivityFeed } from "./card-activity";
import { needsPerson } from "./fleet";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CalendarDays,
  ChartNoAxesCombined,
  FileCode2,
  Files,
  Folder,
  GitBranch,
  Layers3,
  LayoutGrid,
  MessageSquare,
  Minus,
  PanelLeft,
  Plus,
  Radio,
  Route,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Workflow,
  Users,
  X,
  Inbox as InboxIcon,
} from "lucide-react";
import {
  harnessIds,
  type AppState,
  type RuntimeInfo,
  type WorkItem,
  type Artifact,
} from "./shared";
import { isActive, tasksForProject } from "./domain";
import {
  Empty,
  HarnessMark,
  Mark,
  Spinner,
  StageIcon,
  Time,
} from "./components/UI";
import { Workspace } from "./components/Workspace";
import { Conversations } from "./components/Conversations";
import { ArtifactCollection } from "./components/ArtifactCollection";
import { groupedArtifacts } from "./artifact-purpose";
import { WorkDetail } from "./components/WorkDetail";
import { Roadmap } from "./components/Roadmap";
import { BaseBranchPicker } from "./components/BaseBranchPicker";
import { PullRequestSheet } from "./components/PullRequest";
import { NewWork } from "./components/NewWork";
import { Inbox } from "./components/Inbox";
import { attachReport } from "./report-attachments";
import type { Attachment } from "./attachments";
import { requestFrom, type InboxItem } from "./inbox";
import { FleetDecisions } from "./components/FleetDecisions";
import { Cycles } from "./components/Cycles";
import { InsightsPage } from "./components/InsightsPage";
import { Improve } from "./components/Improve";
import { Onboarding } from "./components/Onboarding";
import type { SettingsSection } from "./components/Dialogs";
import { SignInWelcome } from "./components/SignInWelcome";
import { needsAccountSetup } from "./onboarding";
import { InstallWelcome } from "./components/InstallWelcome";
import { Docs } from "./components/Docs";
import {
  firstRunGuide,
  projectGuide,
  type OnboardingPatch,
  type GuideAction,
} from "./onboarding";
import type { GuideDestination } from "./guide-content";
import { WorkerConnections } from "./components/WorkerConnections";
import { TeamOnboarding } from "./components/TeamOnboarding";
import {
  NoFolderYet,
  SHARED_GROUP,
  ShareButton,
  SwitcherShared,
  isSharedHere,
  offersSharing,
  useSharingOverview,
} from "./components/ShareProject";
import { LocalProjectSetup } from "./components/LocalProjectSetup";
import { projectSharingAsKnown } from "./sharing";
import { readShownNotices, rememberShownNotices, unseenNotices } from "./notices";
import "./styles-team.css";
import "./styles-collaboration.css";
import "./styles-sharing.css";
import { BetaAccess } from "./components/BetaAccess";
import { AppUpdateAction } from "./components/AppUpdates";
import { InstallationGuide } from "./components/InstallationGuide";
import type { MemCodeBetaStatus } from "./beta";
import type { MemtraceAccount } from "./connections";
import { approvedRuntime } from "./worker-availability";
import { useRuntimeHealth } from "./useRuntimeHealth";
import { useRepositoryStatus } from "./useRepositoryStatus";
import { repositoryName } from "./branches";
import { primaryModifier, shortcutLabel } from "./platform";
import "./styles-runtime-health.css";
import "./styles-artifact-collection.css";
import "./styles-artifact-thumbnail.css";
import {
  Modal,
  NewProjectDialog,
  NewTaskDialog,
  SearchDialog,
  SettingsDialog,
} from "./components/Dialogs";
import { hasTeamPage } from "./team-presentation";
import { DeleteProject } from "./components/DeleteProject";

type View =
  | "inbox"
  | "board"
  | "roadmap"
  | "cycles"
  | "insights"
  | "improve"
  | "fleet"
  | "workers"
  | "conversations"
  | "artifacts"
  | "activity"
  | "docs"
  | "team";
const pageCopy: Record<View, [string, string, string]> = {
  inbox: [
    "FROM THE PEOPLE YOU WORK WITH",
    "Reports, ready to pick up.",
    "What your team sent from Slack, with the evidence. Pick one up and define the goal.",
  ],
  team: [
    "BUILD WITH YOUR TEAM",
    "Better together. Still local.",
    "Keep the plan, the discussions and the results in sync.",
  ],
  docs: [
    "A CLEAR PLACE TO BEGIN",
    "The MemCode guide.",
    "Start with the essentials. Find the details when you need them.",
  ],
  cycles: [
    "A RHYTHM FOR THE WORK",
    "Clear cycles. Steady progress.",
    "Plan a focused window, track the scope, and carry the right work forward.",
  ],
  insights: [
    "UNDERSTAND THE MOMENTUM",
    "The work, understood.",
    "See recorded progress and the evidence behind the next decision.",
  ],
  improve: [
    "MEASURE THE CHANGE",
    "Better code, with evidence.",
    "Turn source findings into focused work, then see how the code improves.",
  ],
  fleet: [
    "HUMAN IN THE LOOP",
    "A clear decision. A moving fleet.",
    "The workers settle what they can. What’s left shows what each of them wants.",
  ],
  board: [
    "THE BIG PICTURE",
    "Your fleet, in focus.",
    "Ideas become clear work. Your agents take it from there.",
  ],
  roadmap: [
    "FROM IDEA TO IMPLEMENTATION",
    "A direction for every task.",
    "Shape the goals. Bank the work. Build it with your fleet.",
  ],
  workers: [
    "YOUR LOCAL FLEET",
    "A place for every worker.",
    "Follow the work, the context, and what needs you next.",
  ],
  conversations: [
    "THINK TOGETHER",
    "Good work starts here.",
    "Pick up the thread without losing the bigger picture.",
  ],
  artifacts: [
    "THE WORK, MADE VISIBLE",
    "From work to something real.",
    "Interactive artifacts, images and reports, ready to open.",
  ],
  activity: [
    "WORKSPACE PULSE",
    "Every step, connected.",
    "A local history of the work moving through your fleet.",
  ],
};

export function App() {
  const runtimeHealth = useRuntimeHealth();
  const [state, setState] = useState<AppState | null>(null);
  const repository = useRepositoryStatus(
    state?.projects.find((item) => item.id === state.activeProjectId) ??
      state?.projects[0],
  );
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [view, setView] = useState<View>("board");
  /** The Inbox report a new goal is being defined from, if any. */
  const [inboxItem, setInboxItem] = useState<InboxItem | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [guideReviewId, setGuideReviewId] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(
    null,
  );
  const [storyEpic, setStoryEpic] = useState<string | undefined>();
  const [pullRequestEpic, setPullRequestEpic] = useState<string>();
  /** More options for a new task, with what was written and attached before. */
  const [detailedTask, setDetailedTask] = useState<{
    request: string;
    files: Attachment[];
  } | null>(null);
  const [storyStatus, setStoryStatus] = useState<string | undefined>();
  const [storyParent, setStoryParent] = useState<string | undefined>();
  const [dialog, setDialog] = useState<
    "task" | "project" | "settings" | "search" | "welcome" | null
  >(null);
  const [projectMenu, setProjectMenu] = useState(false);
  const [joinTeamRequest, setJoinTeamRequest] = useState(0);
  const [localSetupProjectId, setLocalSetupProjectId] = useState("");
  const [docsArticle, setDocsArticle] = useState("start");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("account");
  const [createEpicRequest, setCreateEpicRequest] = useState(0);
  const [account, setAccount] = useState<MemtraceAccount>();
  const [betaStatus, setBetaStatus] = useState<MemCodeBetaStatus>();
  const [accountPromptOpen, setAccountPromptOpen] = useState(false);
  const [accountPromptSkipped, setAccountPromptSkipped] = useState(false);
  const [toast, setToast] = useState("");
  const [fatal, setFatal] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [folderSetupOpen, setFolderSetupOpen] = useState(false);
  const sharing = useSharingOverview(
    betaStatus?.state === "connected" ? betaStatus.account?.id : undefined,
  );
  const notify = useCallback((message: string) => {
    setToast(message);
  }, []);
  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        notify((error as Error).message);
      }
    },
    [notify],
  );
  useEffect(() => {
    if (state) cardActivityFeed.publish(state.tasks);
  }, [state?.tasks]);
  const shownNotices = useRef(readShownNotices());
  useEffect(() => {
    const unseen = unseenNotices(state?.notices, shownNotices.current);
    for (const notice of unseen) {
      shownNotices.current.add(notice.id);
      notify(notice.text);
    }
    if (unseen.length) rememberShownNotices(shownNotices.current);
  }, [state?.notices, notify]);
  useEffect(() => {
    if (betaStatus?.accessMode !== "installed-cli") return;
    let live = true;
    void window.memcode
      .accountStatus()
      .then((value) => {
        if (live) setAccount(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [betaStatus?.accessMode]);
  useEffect(() => {
    if (
      betaStatus?.state === "connected" ||
      (betaStatus?.accessMode === "installed-cli" &&
        (account?.status === "connected" || account?.sessionVerified))
    ) {
      setAccountPromptOpen(false);
      setAccountPromptSkipped(false);
    } else if (
      !accountPromptSkipped &&
      needsAccountSetup(betaStatus, account)
    ) {
      setAccountPromptOpen(true);
    }
  }, [betaStatus, account, accountPromptSkipped]);
  useEffect(() => {
    let live = true;
    const update = (value: MemCodeBetaStatus) => {
      if (live) setBetaStatus(value);
    };
    const unsubscribe = window.memcode?.onBetaStatus?.(update);
    void window.memcode
      ?.betaStatus?.()
      .then(update)
      .catch(() => {});
    let resumedAt = 0;
    const resume = () => {
      if (
        document.visibilityState === "hidden" ||
        Date.now() - resumedAt < 30000
      )
        return;
      resumedAt = Date.now();
      void window.memcode
        ?.resumeBeta?.()
        .then(update)
        .catch(() => {});
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      live = false;
      unsubscribe?.();
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  useEffect(() => {
    if (!window.memcode) {
      setFatal("Open this workspace through the MemCode desktop app.");
      return;
    }
    let mounted = true;
    void window.memcode
      .load()
      .then((result) => {
        if (!mounted) return;
        setState((previous) => previous ?? result.state);
        setRuntime(result.runtime);
        if (firstRunGuide(result.state))
          void window.memcode.updateOnboarding({
            step: "welcome",
            dismissed: false,
          });
        if (
          result.state.epics.some(
            (epic) => epic.projectId === result.state.activeProjectId,
          )
        )
          setView("roadmap");
      })
      .catch((error) => {
        if (mounted) setFatal(error.message);
      });
    const unsubscribe = window.memcode.onState(setState);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        document.querySelector(
          ".modal-backdrop, .connection-consent-backdrop",
        ) ||
        document.querySelector('[data-memcode-select-open="true"]')
      )
        return;
      const input =
        event.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);
      if (primaryModifier(event) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDialog("search");
      }
      if (event.key === "Escape") {
        setDialog(null);
        setProjectMenu(false);
        if (!dialog) setSelectedId(null);
      }
      if (
        !input &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "c"
      ) {
        setDetailedTask(null);
        setInboxItem(null);
        setStoryEpic(undefined);
        setStoryParent(undefined);
        setStoryStatus(undefined);
        setDialog("task");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dialog]);
  useEffect(() => {
    if (dialog === "settings" && docsArticle === "dictation")
      document
        .querySelector("[data-guide=dictation-settings]")
        ?.scrollIntoView({ block: "center" });
  }, [dialog, docsArticle]);
  if (fatal)
    return (
      <div className="boot-screen">
        <Mark />
        <h1>MemCode needs a moment.</h1>
        <p>{fatal}</p>
        <button className="button primary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!state || !runtime)
    return (
      <div className="boot-screen">
        <Mark />
        <Spinner size={20} />
        <p>Opening your workspace</p>
      </div>
    );
  const project =
    state.projects.find((p) => p.id === state.activeProjectId) ??
    state.projects[0];
  const guideProgress = projectGuide(state, project.id);
  const guideProject = project;
  const tasks = tasksForProject(state, project.id);
  const epics = state.epics.filter((epic) => epic.projectId === project.id);
  const selected = state.tasks.find((task) => task.id === selectedId);
  const active = runtimeHealth.available
    ? tasks.filter((task) => isActive(task))
    : [];
  const working = tasks.filter((task) => task.stage === "working");
  const artifacts = state.artifacts.filter((a) => a.projectId === project.id);
  const open = (task: WorkItem) => {
    setGuideReviewId(null);
    setSelectedArtifact(null);
    setSelectedId(task.id);
    setDialog(null);
  };
  const create = (epicId?: string, parentId?: string, statusId?: string) => {
    setDetailedTask(null);
    setInboxItem(null);
    setStoryStatus(statusId);
    setStoryEpic(epicId);
    setStoryParent(parentId);
    setDialog("task");
  };
  const openCodeAnalysis = async () => {
    if (!project.path || project.example) {
      if (state.team?.some((room) => room.projectId === project.id)) {
        setLocalSetupProjectId(project.id);
        setView("team");
      } else setDialog("project");
      return;
    }
    if (
      !runtime.memtraceAvailable &&
      betaStatus &&
      betaStatus.state !== "connected"
    ) {
      setDialog("settings");
      return;
    }
    await window.memcode.analyzeProject(project.id);
  };
  const updateGuide = (patch: OnboardingPatch) => {
    if (patch.step === "code-review") setView("board");
    void act(() =>
      window.memcode.updateOnboarding({
        ...(!project.example ? { projectId: project.id } : {}),
        ...patch,
      }),
    );
  };
  const startGuide = (action: "resume" | "restart" | "after-tour") => {
    setSelectedId(null);
    setDialog(null);
    setProjectMenu(false);
    const progress = guideProgress;
    const fresh = action === "restart" || !progress || !!progress.completedAt;
    const firstStep = project.example ? "welcome" : "context";
    const savedStep = fresh ? firstStep : progress.step;
    const step =
      action === "after-tour" && savedStep === "welcome"
        ? "project"
        : savedStep;
    updateGuide({
      ...(fresh ? { restart: true } : {}),
      step,
      dismissed: false,
    });
    setView(
      step === "worker"
        ? "workers"
        : step === "epic" || step === "story"
          ? "roadmap"
          : "board",
    );
  };
  const guideAction = (action: GuideAction) => {
    if (action === "review-docs") {
      updateGuide({ dismissed: true });
      setSelectedId(null);
      setDocsArticle("review");
      setView("docs");
      return;
    }
    if (action === "project") {
      setDialog("project");
      return;
    }
    if (action === "worker") {
      setView("workers");
      return;
    }
    if (
      action === "account" ||
      action === "dictation" ||
      action === "retrieval"
    ) {
      setSettingsSection(action);
      setDialog("settings");
      return;
    }
    if (action === "team") {
      setView("team");
      return;
    }
    if (action === "analyze") {
      void act(openCodeAnalysis);
      return;
    }
    const progress = guideProgress;
    void act(async () => {
      if (progress?.projectId && progress.projectId !== project.id) {
        await window.memcode.selectProject(progress.projectId);
        setState((await window.memcode.load()).state);
      }
      if (action === "epic") {
        setView("roadmap");
        setCreateEpicRequest((value) => value + 1);
      }
      if (action === "story") {
        setView("roadmap");
        create(progress?.epicId);
      }
      if (
        (action === "open-story" || action === "view-review") &&
        progress?.storyId
      ) {
        const story = tasks.find((task) => task.id === progress.storyId);
        if (story) {
          open(story);
          if (action === "view-review") setGuideReviewId(story.id);
        }
      }
    });
  };
  /** The title and New work button above a view. The board shows its green bar instead. */
  const pageHeading = (
    <div className="page-heading">
      <div>
        <div className="eyebrow">
          <span />
          {pageCopy[view][0]}
        </div>
        <h1>{pageCopy[view][1]}</h1>
        <p>{pageCopy[view][2]}</p>
      </div>
      {view !== "docs" && (
        <button
          className="button primary"
          data-guide="new-story"
          onClick={() => create()}
        >
          <Plus size={15} />
          New work
          <kbd>C</kbd>
        </button>
      )}
    </div>
  );
  /** The report a task was defined from is recorded as picked up. */
  const pickedUp = (task: WorkItem) => {
    if (!inboxItem) return;
    const goal = task.epicId ?? task.id;
    const goalTitle =
      state?.epics.find((epic) => epic.id === task.epicId)?.title ?? task.title;
    window.memcode
      .decideInboxItem({
        projectId: task.projectId,
        itemId: inboxItem.id,
        decision: { kind: "picked_up", goal, goalTitle },
      })
      .catch((error: Error) => notify(error.message));
    setInboxItem(null);
  };
  const guideGo = (destination: GuideDestination) => {
    if (destination === "project") {
      setDialog("project");
      return;
    }
    if (destination === "settings" || destination === "retrieval") {
      setSettingsSection(
        destination === "retrieval" ? "retrieval" : "dictation",
      );
      setDialog("settings");
      return;
    }
    if (destination === "account" || destination === "integrations") {
      setSettingsSection(destination);
      setDialog("settings");
      return;
    }
    setView(destination);
  };
  const navItems: Array<{
    id: View;
    label: string;
    icon: typeof LayoutGrid;
    count?: number;
  }> = [
    { id: "board", label: "Workspace", icon: LayoutGrid },
    { id: "inbox", label: "Inbox", icon: InboxIcon },
    { id: "roadmap", label: "Roadmap", icon: Route, count: epics.length },
    {
      id: "cycles",
      label: "Cycles",
      icon: CalendarDays,
      count: state.cycles.filter(
        (cycle) => cycle.projectId === project.id && cycle.state === "active",
      ).length,
    },
    { id: "insights", label: "Insights", icon: ChartNoAxesCombined },
    { id: "improve", label: "Improve", icon: Sparkles },
    {
      id: "fleet",
      label: "Decisions",
      icon: ShieldCheck,
      count: state.fleetConflicts.filter(
        (item) => item.projectId === project.id && needsPerson(item),
      ).length,
    },
    {
      id: "workers",
      label: "Workers",
      icon: Workflow,
      count:
        (state.workerInputs ?? []).filter((input) => input.status === "pending")
          .length || active.length,
    },
    { id: "conversations", label: "Conversations", icon: MessageSquare },
    {
      id: "artifacts",
      label: "Artifacts",
      icon: Files,
      count: groupedArtifacts(artifacts).primary.length,
    },
    { id: "activity", label: "Activity", icon: Radio },
    // Sharing replaces Team Sync: the Team page stays only for a project still in a team.
    ...(hasTeamPage(state, project.id)
      ? [
          {
            id: "team" as const,
            label: "Team",
            icon: Users,
            count: state.team?.find((item) => item.projectId === project.id)
              ?.unreadCount,
          },
        ]
      : []),
    { id: "docs", label: "Docs", icon: BookOpen },
  ];
  const projectGroups = new Map<string, typeof state.projects>();
  for (const item of state.projects) {
    const shared = state.team?.find((room) => room.projectId === item.id);
    const label = shared
      ? (shared.teamName ?? "Shared preview projects")
      : isSharedHere(state, item.id)
        ? SHARED_GROUP
        : "Personal projects";
    projectGroups.set(label, [...(projectGroups.get(label) ?? []), item]);
  }
  // Shared projects come last, so those not on this computer yet follow them.
  const switcherGroups = [...projectGroups].sort(
    ([left], [right]) =>
      Number(left === SHARED_GROUP) - Number(right === SHARED_GROUP),
  );
  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <InstallationGuide />
      <div className="desktop-titlebar" data-tauri-drag-region>
        <div className="titlebar-left">
          <button
            className="icon-button"
            title="Toggle sidebar"
            onClick={() => setCollapsed(!collapsed)}
          >
            <PanelLeft size={14} />
          </button>
          <span>MemCode</span>
          <ChevronRight size={11} />
          <span>{project.name}</span>
        </div>
        <div className="titlebar-center">
          <span className="tiny-local-dot" />
          {import.meta.env.DEV ? "Development · live UI" : "Local workspace"}
        </div>
        <div className="window-controls">
          <button
            aria-label="Minimize"
            onClick={() => void window.memcode.windowAction("minimize")}
          >
            <Minus size={13} />
          </button>
          <button
            aria-label="Maximize"
            onClick={() => void window.memcode.windowAction("maximize")}
          >
            <Square size={10} />
          </button>
          <button
            aria-label="Close"
            onClick={() => void window.memcode.windowAction("close")}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Mark />
          <span>
            MemCode<span className="brand-product">FLEET WORKER SUITE</span>
          </span>
          <span className="alpha-tag">α</span>
        </div>
        <div className="project-picker-wrap">
          <button
            className={"project-picker " + (projectMenu ? "selected" : "")}
            data-guide="project-picker"
            onClick={() => {
              if (!projectMenu) void sharing.refresh();
              setProjectMenu(!projectMenu);
            }}
          >
            <span className="project-avatar">
              <Layers3 size={17} />
            </span>
            <span>
              <strong>{project.name}</strong>
              <small>
                {project.example
                  ? "Example project"
                  : repository
                    ? repositoryName(repository)
                    : project.branch}
              </small>
            </span>
            <ChevronDown size={13} />
          </button>
          {projectMenu && (
            <div className="project-menu">
              {switcherGroups.map(([group, items]) => (
                <div key={group}>
                  <span className="menu-eyebrow">{group}</span>
                  {items.map((item) => (
                    <div className="project-menu-row" key={item.id}>
                      <button
                        onClick={() => {
                          void act(() => window.memcode.selectProject(item.id));
                          setSelectedId(null);
                          setProjectMenu(false);
                        }}
                      >
                        <span className="project-avatar small">
                          {isSharedHere(state, item.id) ? (
                            <Users size={14} aria-label="Shared" />
                          ) : (
                            <Folder size={14} />
                          )}
                        </span>
                        <span>
                          {item.name}
                          {item.example && <small>Example</small>}
                        </span>
                        {project.id === item.id && <Check size={13} />}
                      </button>
                      <DeleteProject
                        project={item}
                        sharing={projectSharingAsKnown(item, state, sharing.overview)}
                        hasInbox={
                          !!state.inboxLinks?.some((link) => link.projectId === item.id)
                        }
                        onDeleted={() => {
                          setSelectedId(null);
                          setProjectMenu(false);
                          void sharing.refresh();
                        }}
                      />
                    </div>
                  ))}
                </div>
              ))}
              <SwitcherShared
                state={state}
                overview={sharing.overview}
                act={act}
                headed={!projectGroups.has(SHARED_GROUP)}
                onOpened={() => {
                  setSelectedId(null);
                  setView("board");
                  setProjectMenu(false);
                  void sharing.refresh();
                }}
              />
              <div className="menu-divider" />
              <button
                onClick={() => {
                  setDialog("project");
                  setProjectMenu(false);
                }}
              >
                <Plus size={16} />
                Add a project
              </button>
            </div>
          )}
        </div>
        <button className="sidebar-search" onClick={() => setDialog("search")}>
          <Search size={14} />
          <span>Search anything</span>
          <kbd>{shortcutLabel("K")}</kbd>
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={"nav-item " + (view === item.id ? "active" : "")}
              onClick={() => setView(item.id)}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
              {item.count ? <small>{item.count}</small> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            type="button"
            className="engine-card"
            disabled={
              project.analysis === "connecting" ||
              project.analysis === "indexing"
            }
            onClick={() => {
              if (project.analysis === "ready") setView("insights");
              else void act(openCodeAnalysis);
            }}
          >
            <span
              className={`engine-orb ${project.analysis === "ready" ? "connected" : ""}`}
            >
              <GitBranch size={15} />
            </span>
            <span className="engine-card-label">
              <strong>Powered by Memtrace</strong>
              <small>
                {project.analysis === "ready"
                  ? "Code context connected"
                  : project.analysis === "error"
                    ? "Retry code analysis"
                    : project.analysis === "connecting" ||
                        project.analysis === "indexing"
                      ? "Analyzing code…"
                      : project.example
                        ? "Your code. Understood."
                        : "Connect your code context"}
              </small>
            </span>
            {project.analysis === "ready" ? (
              <span className="live-dot" />
            ) : (
              <ArrowUpRight size={13} />
            )}
          </button>
          <div className="sidebar-footer">
            <button onClick={() => setDialog("settings")}>
              <Settings2 size={15} />
              <span>Settings</span>
            </button>
            <span className="version">v{runtime.appVersion}</span>
            <button
              title="Open product guide"
              onClick={() => {
                setDocsArticle("start");
                setView("docs");
              }}
            >
              <CircleHelp size={15} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-workspace">
        <header className="workspace-topbar">
          <div>
            <span className="breadcrumb-project">{project.name}</span>
            {repository && (
              <BaseBranchPicker project={project} repository={repository} notify={notify} />
            )}
            <ChevronRight size={12} />
            <span>
              {view === "board"
                ? "Workspace"
                : navItems.find((n) => n.id === view)?.label}
            </span>
          </div>
          <div>
            <span
              className={
                "local-pill " +
                (!runtimeHealth.available ? "runtime-offline" : "")
              }
            >
              <span />
              {runtimeHealth.available ? "Local execution" : "Runtime stopped"}
            </span>
            <AppUpdateAction
              open={() => setDialog("settings")}
              automaticDownloads={
                state.settings.automaticUpdateDownloads !== false
              }
            />
            <button
              className="icon-button"
              title="Search workspace"
              onClick={() => setDialog("search")}
            >
              <Search size={16} />
            </button>
            {sharing.overview &&
              offersSharing(sharing.overview, project, state) && (
                <ShareButton
                  state={state}
                  project={project}
                  overview={sharing.overview}
                  setOverview={sharing.setOverview}
                  yourName={betaStatus?.account?.name}
                  refresh={sharing.refresh}
                  notify={notify}
                  onSignIn={() => {
                    setSettingsSection("account");
                    setDialog("settings");
                  }}
                />
              )}
            <BetaAccess
              compact
              notify={notify}
              existingCLI
              onStatus={setBetaStatus}
              onAccountStatus={setAccount}
            />
          </div>
        </header>
        {(!runtimeHealth.available || runtimeHealth.saveError) && (
          <div className="runtime-notice" role="alert">
            <Radio size={15} />
            <div>
              <strong>
                {runtimeHealth.available
                  ? "Workspace changes are not saved"
                  : "Runtime disconnected"}
              </strong>
              {runtimeHealth.available
                ? runtimeHealth.saveError
                : "Live worker status is unavailable. Reopen MemCode to reconnect; the last saved workspace is preserved."}
            </div>
          </div>
        )}
        <div className="workspace-scroll">
          {view !== "team" && view !== "board" && pageHeading}
          {view === "team" && (
            <TeamOnboarding
              state={state}
              project={project}
              joinRequested={joinTeamRequest}
              localSetupRequested={localSetupProjectId === project.id}
              onLocalSetupHandled={() => setLocalSetupProjectId("")}
              onJoinHandled={() => setJoinTeamRequest(0)}
              onWorkers={() => setView("workers")}
              onInsights={() => setView("insights")}
              notify={notify}
              open={open}
              openArtifact={(artifact) => {
                const task = state.tasks.find(
                  (item) => item.id === artifact.taskId,
                );
                if (task) {
                  open(task);
                  setSelectedArtifact(artifact);
                } else {
                  notify(
                    "The result is saved locally. Open its shared task to view it.",
                  );
                }
              }}
            />
          )}
          {view === "board" &&
            !project.path &&
            isSharedHere(state, project.id) && (
              <div className="share-folder">
                <NoFolderYet
                  open={folderSetupOpen}
                  onOpen={() => setFolderSetupOpen((value) => !value)}
                />
                {folderSetupOpen && (
                  <LocalProjectSetup
                    project={project}
                    notify={notify}
                    onWorkers={() => setView("workers")}
                    onInsights={() => setView("insights")}
                  />
                )}
              </div>
            )}
          {view === "inbox" && (
            <Inbox
              project={project}
              onConnectSlack={() => {
                setSettingsSection("integrations");
                setDialog("settings");
              }}
              onDefineGoal={(item) => {
                setStoryEpic(undefined);
                setStoryStatus(undefined);
                setStoryParent(undefined);
                setDetailedTask(null);
                setInboxItem(item);
                setDialog("task");
              }}
              notify={notify}
            />
          )}
          {view === "docs" && (
            <Suspense fallback={<Spinner />}>
              <Docs
                initialArticle={docsArticle}
                onStartGuide={startGuide}
                onWatchTour={() => setDialog("welcome")}
                onGo={guideGo}
              />
            </Suspense>
          )}
          {view === "cycles" && (
            <Cycles
              state={state}
              project={project}
              open={open}
              notify={notify}
            />
          )}
          {view === "insights" && (
            <InsightsPage
              key={JSON.stringify([
                project.id,
                project.path,
                project.repoId,
                project.branch,
              ])}
              onAnalyze={openCodeAnalysis}
              state={state}
              project={project}
              open={open}
              notify={notify}
            />
          )}
          {view === "improve" && (
            <Improve
              key={JSON.stringify([
                project.id,
                project.path,
                project.repoId,
                project.branch,
              ])}
              onAnalyze={openCodeAnalysis}
              state={state}
              project={project}
              open={open}
              notify={notify}
            />
          )}
          {view === "roadmap" && (
            <Roadmap
              key={project.id}
              project={project}
              epics={epics}
              tasks={tasks}
              open={open}
              addStory={create}
              notify={notify}
              createRequest={createEpicRequest}
              onCreateRequestConsumed={() => setCreateEpicRequest(0)}
              pullRequests={state.pullRequests}
              openPullRequest={setPullRequestEpic}
              repository={repository}
              onEpicCreated={(epic) => {
                if (guideProgress?.step === "epic" && !guideProgress.dismissed)
                  updateGuide({ epicId: epic.id, step: "story" });
              }}
            />
          )}
          {view === "fleet" && (
            <FleetDecisions
              project={project}
              conflicts={state.fleetConflicts.filter(
                (item) => item.projectId === project.id,
              )}
              tasks={tasks}
              open={open}
              notify={notify}
            />
          )}
          {view === "board" && (
            <Workspace
              state={state}
              project={project}
              runtime={runtime}
              open={open}
              create={(statusId) => create(undefined, undefined, statusId)}
              notify={notify}
              act={act}
              addProject={() => setDialog("project")}
              heading={pageHeading}
            />
          )}
          {view === "workers" && (
            <section className="workers-view">
              {(state.workerInputs ?? [])
                .filter((input) => input.status === "pending")
                .map((input) => {
                  const task = state.tasks.find(
                    (task) => task.id === input.taskId,
                  );
                  return (
                    task && (
                      <button
                        key={input.id}
                        className="worker-attention-link"
                        onClick={() => open(task)}
                      >
                        <ShieldCheck size={17} />
                        <span>
                          <strong>
                            {input.kind === "approval"
                              ? "Approval needed"
                              : "Waiting for your answer"}
                          </strong>
                          <small>
                            {task.identifier} · {task.title} · {input.title}
                          </small>
                        </span>
                        <ArrowUpRight size={15} />
                      </button>
                    )
                  );
                })}
              <WorkerConnections
                runtime={runtime}
                onRuntime={setRuntime}
                state={state}
                notify={notify}
                onCreateWork={() => create()}
              />
              <div className="section-heading">
                <h2>Work in progress</h2>
                <span>
                  {project.example
                    ? "Example project · no live agents"
                    : !runtimeHealth.available
                      ? "Live status unavailable"
                      : `${active.length} active sessions`}
                </span>
              </div>
              {working.length ? (
                <div className="worker-session-list">
                  {working.map((task) => (
                    <button key={task.id} onClick={() => open(task)}>
                      <HarnessMark id={task.harness} />
                      <span>
                        <strong>{task.title}</strong>
                        <small>
                          {task.identifier} ·{" "}
                          {task.run.workspace
                            ? "Shared with its goal"
                            : task.example
                              ? "Example session"
                              : "Ready to start a worker"}
                        </small>
                      </span>
                      <span className="session-status">
                        <span
                          className={
                            runtimeHealth.available && isActive(task)
                              ? "live-dot"
                              : "quiet-dot"
                          }
                        />
                        {task.example
                          ? "Preview"
                          : !runtimeHealth.available && isActive(task)
                            ? "Connection lost"
                            : isActive(task)
                              ? "Running"
                              : "Not running"}
                      </span>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={<Workflow size={27} />}
                  title="A clear space to get started."
                  description="Connect a worker, then give it a focused task. Its session will appear here."
                  action={
                    <button className="button primary" onClick={() => create()}>
                      <Plus size={14} />
                      Create work item
                    </button>
                  }
                />
              )}
            </section>
          )}
          {view === "conversations" && (
            <Conversations key={project.id} tasks={tasks} open={open} />
          )}
          {view === "artifacts" &&
            (artifacts.length ? (
              <ArtifactCollection
                key={project.id}
                artifacts={artifacts}
                layout="gallery"
                tasks={tasks}
                onOpen={(artifact) => {
                  const task = tasks.find((t) => t.id === artifact.taskId);
                  if (task) {
                    open(task);
                    setSelectedArtifact(artifact);
                  }
                }}
              />
            ) : (
              <Empty
                icon={<Files size={27} />}
                title="The output belongs with the work."
                description="When a harness produces a report, image or preview in its artifact folder, you can open it here and in the work item."
                action={
                  <button className="button primary" onClick={() => create()}>
                    <Plus size={14} />
                    Create work item
                  </button>
                }
              />
            ))}
          {view === "activity" && (
            <div className="activity-feed">
              {tasks
                .flatMap((task) =>
                  task.messages.map((message) => ({ task, message })),
                )
                .sort((a, b) => b.message.at.localeCompare(a.message.at))
                .slice(0, 35)
                .map(({ task, message }) => (
                  <button key={message.id} onClick={() => open(task)}>
                    <span className={"activity-marker " + message.role}>
                      {message.role === "tool" ? (
                        <GitBranch size={13} />
                      ) : message.role === "assistant" ? (
                        <Sparkles size={13} />
                      ) : (
                        <MessageSquare size={13} />
                      )}
                    </span>
                    <div>
                      <span className="activity-line">
                        <strong>{task.identifier}</strong>
                        <span>
                          {message.role === "assistant"
                            ? "Worker update"
                            : message.role === "tool"
                              ? "Context or tool output"
                              : message.role === "system"
                                ? "Session update"
                                : "Brief or note"}
                        </span>
                        <Time at={message.at} />
                      </span>
                      <p>{message.text}</p>
                    </div>
                    <ArrowUpRight size={13} />
                  </button>
                ))}
            </div>
          )}
        </div>
      </main>
      {selected && (
        <WorkDetail
          state={state}
          task={selected}
          guidedTour={
            guideProgress?.step === "ready" &&
            !guideProgress.dismissed &&
            !guideProgress.completedAt &&
            guideProgress.storyId === selected.id &&
            project.id === selected.projectId
          }
          onGuideTourEnd={() => updateGuide({ step: "code-review" })}
          initialTab={guideReviewId === selected.id ? "review" : undefined}
          project={state.projects.find((p) => p.id === selected.projectId)!}
          artifacts={state.artifacts.filter((a) => a.taskId === selected.id)}
          initialArtifact={
            selectedArtifact?.taskId === selected.id
              ? selectedArtifact
              : undefined
          }
          runtime={runtime}
          conflicts={state.fleetConflicts.filter(
            (item) =>
              item.projectId === selected.projectId &&
              item.status === "open" &&
              (item.taskIds.includes(selected.id) ||
                item.epicId === selected.epicId),
          )}
          onDecisions={() => {
            setSelectedId(null);
            setView("fleet");
          }}
          onPullRequest={setPullRequestEpic}
          onConnections={() => {
            setSelectedId(null);
            setView("workers");
          }}
          epics={state.epics.filter(
            (epic) => epic.projectId === selected.projectId,
          )}
          tasks={state.tasks.filter(
            (task) => task.projectId === selected.projectId,
          )}
          onClose={() => {
            setSelectedId(null);
            setGuideReviewId(null);
          }}
          onOpenTask={open}
          onCreateChild={() =>
            create(selected.epicId ?? undefined, selected.id)
          }
          notify={notify}
          act={act}
          obscured={!!dialog}
        />
      )}
      {dialog === "task" && !storyParent && !detailedTask && (
        <NewWork
          project={project}
          goals={epics.filter((epic) => !epic.closedAt)}
          defaultHarness={state.settings.defaultHarness}
          connected={harnessIds.filter(
            (harness) => !!state.workerConnections?.[harness],
          )}
          fixedEpicId={storyEpic}
          statusId={storyStatus}
          initialRequest={inboxItem ? requestFrom(inboxItem) : undefined}
          reportedBy={inboxItem?.reporter.name}
          initialFiles={
            inboxItem
              ? (add, starting) =>
                  attachReport(project.id, inboxItem, add, starting)
              : undefined
          }
          workerLimit={state.settings.maxWorkers}
          freeSlots={Math.max(
            0,
            state.settings.maxWorkers - state.tasks.filter(isActive).length,
          )}
          onClose={() => {
            setDialog(null);
            setInboxItem(null);
          }}
          onAdvanced={(request, files) => setDetailedTask({ request, files })}
          onConnectWorkers={() => {
            setDialog(null);
            setInboxItem(null);
            setView("workers");
          }}
          onCreated={(task) => {
            setDialog(null);
            pickedUp(task);
            setSelectedId(task.id);
            if (guideProgress?.step === "story" && !guideProgress.dismissed)
              updateGuide({
                storyId: task.id,
                epicId: task.epicId ?? undefined,
                step: "ready",
              });
          }}
          notify={notify}
        />
      )}
      {dialog === "task" && (storyParent || detailedTask) && (
        <NewTaskDialog
          project={project}
          defaultHarness={state.settings.defaultHarness}
          epics={epics}
          initialEpicId={storyEpic}
          initialStatusId={storyStatus}
          cycles={state.cycles.filter(
            (cycle) => cycle.projectId === project.id,
          )}
          parent={state.tasks.find(
            (task) => task.id === storyParent && task.projectId === project.id,
          )}
          initialDescription={detailedTask?.request}
          initialFiles={detailedTask?.files}
          onClose={() => {
            setDialog(null);
            setInboxItem(null);
          }}
          onCreated={(task) => {
            setDialog(null);
            pickedUp(task);
            setSelectedId(task.id);
            if (guideProgress?.step === "story" && !guideProgress.dismissed)
              updateGuide({
                storyId: task.id,
                epicId: task.epicId ?? undefined,
                step: "ready",
              });
          }}
          notify={notify}
        />
      )}
      {dialog === "project" && (
        <NewProjectDialog
          needsEngine={
            !runtime.memtraceAvailable && betaStatus?.state !== "connected"
          }
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            setView("board");
            setSelectedId(null);
          }}
          notify={notify}
        />
      )}
      {pullRequestEpic &&
        state.epics.some((epic) => epic.id === pullRequestEpic) && (
          <PullRequestSheet
            epic={state.epics.find((epic) => epic.id === pullRequestEpic)!}
            close={() => setPullRequestEpic(undefined)}
            notify={notify}
          />
        )}
      {dialog === "settings" && (
        <SettingsDialog
          settings={state.settings}
          state={state}
          initialSection={settingsSection}
          onSetupGuide={() => startGuide("resume")}
          runtime={runtime}
          onClose={() => setDialog(null)}
          onSaved={setRuntime}
          notify={notify}
          onAccountStatus={setAccount}
        />
      )}
      {dialog === "search" && (
        <SearchDialog
          tasks={tasks}
          onClose={() => setDialog(null)}
          open={open}
          create={create}
        />
      )}
      {dialog === "welcome" && (
        <Modal
          title="MemCode product tour"
          kicker="WELCOME TO MEMCODE"
          wide
          close={() => setDialog(null)}
        >
          <InstallWelcome
            replay
            onSkip={() => setDialog(null)}
            onContinue={() => startGuide("after-tour")}
          />
        </Modal>
      )}
      {guideProgress &&
        !guideProgress.dismissed &&
        !guideProgress.completedAt && (
          <Onboarding
            needsEngine={
              !runtime.memtraceAvailable && betaStatus?.state !== "connected"
            }
            notify={notify}
            progress={guideProgress}
            state={state}
            project={guideProject}
            epics={state.epics.filter((e) => e.projectId === project.id)}
            connected={runtime.harnesses.some((adapter) =>
              approvedRuntime(adapter, state.workerConnections),
            )}
            memtraceConnected={
              betaStatus?.accessMode === "beta"
                ? betaStatus.state === "connected"
                : account?.status === "connected" ||
                  account?.sessionVerified === true
            }
            hidden={
              !!dialog ||
              !!selected ||
              (accountPromptOpen && !accountPromptSkipped)
            }
            onUpdate={updateGuide}
            onAction={guideAction}
            onDocs={() => {
              updateGuide({ dismissed: true });
              setSelectedId(null);
              setDocsArticle("start");
              setView("docs");
            }}
          />
        )}
      {accountPromptOpen && !accountPromptSkipped && !dialog && (
        <SignInWelcome
          notify={notify}
          onStatus={setBetaStatus}
          onAccountStatus={setAccount}
          onSkip={() => {
            setAccountPromptSkipped(true);
            setAccountPromptOpen(false);
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <span className="toast-dot" />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
