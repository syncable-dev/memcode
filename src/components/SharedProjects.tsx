import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  FolderOpen,
  LoaderCircle,
  Mail,
  RefreshCw,
} from "lucide-react";
import type { AppState, Project } from "../shared";
import {
  localProjectOf,
  projectSharing,
  type PendingInvitation,
  type ProjectSharing,
  type SharedBoardStatus,
  type SharedProject,
  type SharingOverview,
} from "../sharing";
import { boardStanding } from "../sharing-board";
import { dateLabel } from "../planning/dates";
import { errorMessage } from "../errors";

const REFRESH_ON_RETURN_MS = 15_000;
type Workspace = Pick<
  AppState,
  "projects" | "team" | "sharedProjectLinks" | "sharedBoards"
>;
type Ready = Extract<SharingOverview, { state: "ready" }>;

interface PanelProps {
  /** Null while the first answer is on its way. */
  overview: SharingOverview | null;
  state: Workspace;
  project: Project;
  /** Which action is running, so its button and the others wait. */
  busy: string;
  error: string;
  onRefresh(): void;
  onManage(): void;
  onAccount(): void;
  onSettings(): void;
  onAccept(invitation: PendingInvitation): void;
  onConnect(shared: SharedProject): void;
  onDisconnect(): void;
  onKeepBoth(): void;
}

const boardOf = (state: Workspace, project: Project) =>
  state.sharedBoards?.find((board) => board.projectId === project.id);

const people = (shared: SharedProject) => {
  const others = [shared.owner, ...shared.guests]
    .filter((person) => !person.isYou)
    .filter((person) => shared.youAreOwner || person !== shared.owner)
    .map((person) => person.name);
  const taken = shared.guests.length + shared.openInvitations;
  return [
    shared.youAreOwner ? "You own it" : `Shared by ${shared.owner.name}`,
    ...(others.length ? [`with ${others.join(", ")}`] : []),
    `${taken} of ${shared.guestLimit} guest places taken`,
  ].join(" · ");
};

/** How the open project's board stands with the shared one. */
function BoardLines({
  board,
  alreadySaid,
}: {
  board: ReturnType<typeof boardStanding>;
  /** What the page says beside this, so the same sentence is not there twice. */
  alreadySaid?: string;
}) {
  return (
    <>
      {board.line !== alreadySaid && (
        <small className={`sharing-board ${board.tone}`}>{board.line}</small>
      )}
      {board.notes.map((note) => (
        <small key={note}>{note}</small>
      ))}
    </>
  );
}

/** What the open project's own line says, and whether it can be disconnected. */
function OpenProject({
  project,
  standing,
  board,
  alreadySaid,
  busy,
  onDisconnect,
  onKeepBoth,
}: {
  project: Project;
  standing: ProjectSharing;
  /** How board sync stands, when it runs for this project. */
  board?: SharedBoardStatus;
  alreadySaid?: string;
  busy: string;
  onDisconnect(): void;
  onKeepBoth(): void;
}) {
  const name = <strong>{project.name}</strong>;
  const linked =
    standing.kind === "connected" ||
    standing.kind === "gone" ||
    standing.kind === "elsewhere" ||
    standing.kind === "remembered";
  const shared =
    standing.kind === "connected"
      ? standing.shared.name
      : standing.kind === "remembered"
        ? standing.name
        : undefined;
  // A project that is connected and has no word from board sync yet is about to get one.
  const lines =
    shared !== undefined && (board || standing.kind === "connected")
      ? boardStanding(board, { local: project.name, shared })
      : undefined;
  return (
    <section className="sharing-open-project">
      <span className="project-avatar">
        <FolderOpen size={17} />
      </span>
      <div>
        {standing.kind === "free" && (
          <p>{name} is not connected to a shared project. Choose one below.</p>
        )}
        {standing.kind === "example" && (
          <p>
            The example project cannot be connected. Open one of your own
            projects first.
          </p>
        )}
        {standing.kind === "team" && (
          <p>
            {name} is shared through Team Sync, so it cannot be connected here
            as well.
          </p>
        )}
        {standing.kind === "connected" && (
          <>
            <p>
              {name} is connected to <strong>{standing.shared.name}</strong>.
            </p>
            {lines && <BoardLines board={lines} />}
          </>
        )}
        {standing.kind === "remembered" && (
          <>
            <p>
              {name} is connected to <strong>{standing.name}</strong>.
            </p>
            {lines && <BoardLines board={lines} alreadySaid={alreadySaid} />}
          </>
        )}
        {standing.kind === "gone" && (
          <p>
            {name} was connected to <strong>{standing.name}</strong>, which no
            longer exists, or you are no longer on it.
          </p>
        )}
        {standing.kind === "elsewhere" && (
          <p>
            {name} was connected to <strong>{standing.name}</strong> under
            another Memtrace account or sharing service.
          </p>
        )}
      </div>
      {lines?.asksToKeepBoth && (
        <button
          className="button primary"
          disabled={!!busy}
          onClick={onKeepBoth}
        >
          {busy === "keep-both" && <LoaderCircle className="spin" size={13} />}
          Keep both
        </button>
      )}
      {linked && (
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={onDisconnect}
        >
          {busy === "disconnect" && <LoaderCircle className="spin" size={13} />}
          Disconnect
        </button>
      )}
    </section>
  );
}

function SharedProjectRow({
  shared,
  connectedTo,
  openProject,
  mayConnect,
  busy,
  onConnect,
}: {
  shared: SharedProject;
  connectedTo: Project | undefined;
  openProject: Project;
  mayConnect: boolean;
  busy: string;
  onConnect(shared: SharedProject): void;
}) {
  return (
    <li className="sharing-row">
      <div>
        <strong>{shared.name}</strong>
        <small>{people(shared)}</small>
      </div>
      {connectedTo?.id === openProject.id ? (
        <span className="sharing-connected">
          <Check size={13} />
          Connected to this project
        </span>
      ) : connectedTo ? (
        <span className="sharing-connected">
          Connected to {connectedTo.name}
        </span>
      ) : (
        mayConnect && (
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => onConnect(shared)}
          >
            {busy === `connect:${shared.id}` && (
              <LoaderCircle className="spin" size={13} />
            )}
            Connect {openProject.name}
          </button>
        )
      )}
    </li>
  );
}

function Lists({
  overview,
  state,
  project,
  busy,
  onRefresh,
  onManage,
  onAccept,
  onConnect,
  onDisconnect,
  onKeepBoth,
}: PanelProps & { overview: Ready }) {
  const standing = projectSharing(project, state, overview);
  const links = state.sharedProjectLinks ?? [];
  return (
    <>
      <OpenProject
        project={project}
        standing={standing}
        board={boardOf(state, project)}
        busy={busy}
        onDisconnect={onDisconnect}
        onKeepBoth={onKeepBoth}
      />
      <div className="sharing-heading">
        <h3>Your shared projects</h3>
        <span className="sharing-heading-actions">
          <button
            className="icon-button"
            title="Look again"
            aria-label="Look again"
            disabled={!!busy}
            onClick={onRefresh}
          >
            <RefreshCw size={14} className={busy === "refresh" ? "spin" : ""} />
          </button>
          <button className="button secondary" onClick={onManage}>
            Manage at memtrace.io
            <ArrowUpRight size={13} />
          </button>
        </span>
      </div>
      {overview.projects.length ? (
        <ul className="sharing-list">
          {overview.projects.map((shared) => (
            <SharedProjectRow
              key={shared.id}
              shared={shared}
              connectedTo={localProjectOf(
                shared,
                links,
                state.projects,
                overview.service,
              )}
              openProject={project}
              mayConnect={standing.kind === "free"}
              busy={busy}
              onConnect={onConnect}
            />
          ))}
        </ul>
      ) : (
        <p className="sharing-empty">
          You have no shared projects yet. Start one at memtrace.io, where you
          also invite people to it.
        </p>
      )}
      <div className="sharing-heading">
        <h3>Invitations for you</h3>
      </div>
      {overview.invitations.length ? (
        <ul className="sharing-list">
          {overview.invitations.map((invitation) => (
            <li className="sharing-row" key={invitation.id}>
              <span className="sharing-mark">
                <Mail size={15} />
              </span>
              <div>
                <strong>{invitation.projectName}</strong>
                <small>
                  From {invitation.invitedBy} · open until{" "}
                  {dateLabel(invitation.expiresAt.slice(0, 10), {
                    day: "numeric",
                    month: "long",
                  })}
                </small>
              </div>
              <button
                className="button primary"
                disabled={!!busy}
                onClick={() => onAccept(invitation)}
              >
                {busy === `accept:${invitation.id}` && (
                  <LoaderCircle className="spin" size={13} />
                )}
                Accept
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sharing-empty">No invitations are waiting for you.</p>
      )}
      <p className="sharing-footnote">
        Projects are started, renamed and deleted at memtrace.io, and people are
        invited there. A personal project holds its owner and two guests. Your
        own computers need no invitation: sign in to MemCode on each.
      </p>
    </>
  );
}

/** The Sharing view for one answer from the runtime. It decides nothing itself. */
export function SharingPanel(props: PanelProps) {
  const { overview, busy, error, onRefresh, onAccount, onSettings } = props;
  // The link is kept on this computer, so it can be shown and undone without the service.
  const remembered =
    overview && overview.state !== "ready"
      ? props.state.sharedProjectLinks?.find(
          (link) => link.projectId === props.project.id,
        )
      : undefined;
  return (
    <div className="sharing-home">
      {error && (
        <p className="sharing-problem" role="alert">
          {error}
        </p>
      )}
      {!overview && (
        <p className="sharing-loading" role="status">
          <LoaderCircle className="spin" size={15} />
          Looking up your shared projects…
        </p>
      )}
      {overview?.state === "ready" && <Lists {...props} overview={overview} />}
      {remembered && (
        <OpenProject
          project={props.project}
          standing={{ kind: "remembered", name: remembered.sharedProjectName }}
          board={boardOf(props.state, props.project)}
          alreadySaid={
            overview?.state === "unavailable" ? overview.detail : undefined
          }
          busy={busy}
          onDisconnect={props.onDisconnect}
          onKeepBoth={props.onKeepBoth}
        />
      )}
      {overview?.state === "signed-out" && (
        <div className="sharing-notice">
          <p>{overview.detail}</p>
          <button className="button primary" onClick={onAccount}>
            Open account settings
          </button>
        </div>
      )}
      {overview?.state === "unavailable" && (
        <div className="sharing-notice">
          <p>{overview.detail}</p>
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={onRefresh}
          >
            <RefreshCw size={13} />
            Try again
          </button>
        </div>
      )}
      {overview?.state === "not-set" && (
        <div className="sharing-notice">
          <p>
            Sharing is not set up. Enter the sharing addresses under Account in
            Settings.
          </p>
          <button className="button secondary" onClick={onSettings}>
            Open settings
          </button>
        </div>
      )}
    </div>
  );
}

/** Shared projects and invitations of the signed-in person, and the open project's link. */
export function SharedProjects({
  state,
  project,
  notify,
  onAccount,
}: {
  state: AppState;
  project: Project;
  notify: (message: string) => void;
  onAccount(): void;
}) {
  const [overview, setOverview] = useState<SharingOverview | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const perform = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setBusy(key);
      setError("");
      try {
        await action();
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy("");
      }
    },
    [],
  );
  const refresh = useCallback(
    () =>
      perform("refresh", async () =>
        setOverview(await window.memcode.sharingOverview()),
      ),
    [perform],
  );
  // The addresses are part of what is shown, so a change in Settings asks again.
  const addresses = `${state.settings.sharing?.memsyncUrl}\n${state.settings.sharing?.tokenUrl}`;
  useEffect(() => {
    setOverview(null);
    void refresh();
  }, [refresh, addresses]);
  // Projects and invitations change at memtrace.io, so coming back to the window looks again.
  useEffect(() => {
    let lookedAt = Date.now();
    const lookAgain = () => {
      if (Date.now() - lookedAt < REFRESH_ON_RETURN_MS) return;
      lookedAt = Date.now();
      void refresh();
    };
    window.addEventListener("focus", lookAgain);
    return () => window.removeEventListener("focus", lookAgain);
  }, [refresh]);
  // Board sync notices first when the service is back. The lists are asked for again then.
  const boardState = state.sharedBoards?.find(
    (board) => board.projectId === project.id,
  )?.state;
  const couldNotAsk = overview?.state === "unavailable";
  useEffect(() => {
    if (couldNotAsk && (boardState === "synced" || boardState === "sending"))
      void refresh();
  }, [boardState, couldNotAsk, refresh]);
  // Signing in, signing out or switching account changes whose projects these are.
  useEffect(() => {
    let signedInAs: string | undefined | null = null;
    return window.memcode.onBetaStatus((status) => {
      const account =
        status.state === "connected" ? status.account?.id : undefined;
      if (signedInAs !== null && account !== signedInAs) void refresh();
      signedInAs = account;
    });
  }, [refresh]);
  return (
    <SharingPanel
      overview={overview}
      state={state}
      project={project}
      busy={busy}
      error={error}
      onRefresh={() => void refresh()}
      onManage={() =>
        void perform("manage", () => window.memcode.openSharedProjectsPage())
      }
      onAccount={onAccount}
      onSettings={onAccount}
      onAccept={(invitation) =>
        void perform(`accept:${invitation.id}`, async () => {
          setOverview(
            await window.memcode.acceptSharedInvitation({
              projectId: invitation.projectId,
              invitationId: invitation.id,
            }),
          );
          notify(`You are now a guest on ${invitation.projectName}`);
        })
      }
      onConnect={(shared) =>
        void perform(`connect:${shared.id}`, async () => {
          await window.memcode.connectSharedProject({
            projectId: project.id,
            sharedProjectId: shared.id,
          });
          notify(`${project.name} is connected to ${shared.name}`);
        })
      }
      onDisconnect={() =>
        void perform("disconnect", async () => {
          await window.memcode.disconnectSharedProject(project.id);
          notify(`${project.name} is no longer connected`);
        })
      }
      onKeepBoth={() =>
        void perform("keep-both", () =>
          window.memcode.keepBothSharedBoards(project.id),
        )
      }
    />
  );
}
