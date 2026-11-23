import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  FolderOpen,
  LoaderCircle,
  LogOut,
  MoreHorizontal,
  Users,
  X,
} from "lucide-react";
import type { AppState, Project } from "../shared";
import {
  localProjectOf,
  projectSharing,
  type PendingInvitation,
  type SharedBoardStatus,
  type SharedPerson,
  type SharedProject,
  type SharingOverview,
} from "../sharing";
import { boardStanding, type BoardStanding } from "../sharing-board";
import { errorMessage } from "../errors";

type Ready = Extract<SharingOverview, { state: "ready" }>;
type Act = (action: () => Promise<unknown>) => Promise<void>;
const LOOK_AGAIN_ON_RETURN_MS = 15_000;

/**
 * The person's shared projects and invitations, asked for when the app opens,
 * when the person signs in or out, and when they come back to the window.
 * Null while the first answer is on its way.
 */
export function useSharingOverview(signedInAs: string | undefined) {
  const [overview, setOverview] = useState<SharingOverview | null>(null);
  const refresh = useCallback(async () => {
    try {
      setOverview(await window.memcode.sharingOverview());
    } catch (problem) {
      setOverview({ state: "unavailable", detail: errorMessage(problem) });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, signedInAs]);
  useEffect(() => {
    let lookedAt = Date.now();
    const lookAgain = () => {
      if (Date.now() - lookedAt < LOOK_AGAIN_ON_RETURN_MS) return;
      lookedAt = Date.now();
      void refresh();
    };
    window.addEventListener("focus", lookAgain);
    return () => window.removeEventListener("focus", lookAgain);
  }, [refresh]);
  return { overview, setOverview, refresh };
}

/** Whether a project gets a Share button: sharing is offered, and it is a project of the person's own. */
export function offersSharing(
  overview: SharingOverview | null,
  project: Project,
  state: Pick<AppState, "team">,
) {
  return (
    !!overview &&
    overview.state !== "not-set" &&
    !project.example &&
    !state.team?.some((room) => room.projectId === project.id)
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?";

function Avatar({ person }: { person: { name: string } }) {
  return (
    <span className="share-avatar" title={person.name}>
      {initials(person.name)}
    </span>
  );
}

/** The quiet line about who fits on a free project. */
export const placesLine = (guestLimit: number) =>
  `Free projects hold you and ${guestLimit} guest${guestLimit === 1 ? "" : "s"}. Your own computers don't count.`;

interface PanelProps {
  project: Project;
  state: Pick<
    AppState,
    "projects" | "team" | "sharedProjectLinks" | "sharedBoards"
  >;
  overview: SharingOverview;
  busy: string;
  error: string;
  /** The signed-in person's name, for their own row before the project is shared. */
  yourName?: string;
  onInvite(email: string): void;
  onCancel(invitationId: string): void;
  onRemove(person: SharedPerson): void;
  onLeave(): void;
  onStopSharing(): void;
  onSignIn(): void;
  onRetry(): void;
}

function PersonRow({
  person,
  role,
  mayRemove,
  busy,
  onRemove,
}: {
  person: SharedPerson;
  role: string;
  mayRemove: boolean;
  busy: string;
  onRemove(person: SharedPerson): void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <li className="share-person">
      <Avatar person={person} />
      <span>
        {person.name}
        {person.isYou && <small> (you)</small>}
      </span>
      <small className="share-role">{role}</small>
      {mayRemove && (
        <span className="share-person-menu">
          <button
            className="icon-button"
            aria-label={`More for ${person.name}`}
            disabled={!!busy}
            onClick={() => setMenu((open) => !open)}
          >
            {busy === `remove:${person.id}` ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <MoreHorizontal size={14} />
            )}
          </button>
          {menu && (
            <span className="share-menu">
              <button
                onClick={() => {
                  setMenu(false);
                  onRemove(person);
                }}
              >
                Remove
              </button>
            </span>
          )}
        </span>
      )}
    </li>
  );
}

function InviteField({
  disabled,
  busy,
  onInvite,
}: {
  disabled: boolean;
  busy: string;
  onInvite(email: string): void;
}) {
  const [email, setEmail] = useState("");
  const send = () => {
    if (!email.trim()) return;
    onInvite(email.trim());
    setEmail("");
  };
  return (
    <div className="share-invite">
      <input
        type="email"
        aria-label="Email address to invite"
        placeholder="Email address"
        value={email}
        disabled={disabled}
        onChange={(event) => setEmail(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") send();
        }}
      />
      <button
        className="button primary"
        disabled={disabled || !!busy || !email.trim()}
        onClick={send}
      >
        {busy === "invite" && <LoaderCircle className="spin" size={13} />}
        Invite
      </button>
    </div>
  );
}

/** The people on a shared project, and what the person may do about them. */
function People({
  shared,
  busy,
  onCancel,
  onRemove,
}: {
  shared: SharedProject;
  busy: string;
  onCancel(invitationId: string): void;
  onRemove(person: SharedPerson): void;
}) {
  return (
    <ul className="share-people">
      <PersonRow
        person={shared.owner}
        role="Owner"
        mayRemove={false}
        busy={busy}
        onRemove={onRemove}
      />
      {shared.guests.map((guest) => (
        <PersonRow
          key={guest.id}
          person={guest}
          role="Guest"
          mayRemove={shared.youAreOwner}
          busy={busy}
          onRemove={onRemove}
        />
      ))}
      {!shared.youAreOwner && shared.openInvitations.length > 0 && (
        <li className="share-person invited">
          <span className="share-avatar">@</span>
          <span>{shared.openInvitations.length} more invited</span>
        </li>
      )}
      {shared.youAreOwner &&
        shared.openInvitations.map((invitation) => (
          <li className="share-person invited" key={invitation.id}>
            <span className="share-avatar">@</span>
            <span>{invitation.email}</span>
            <small className="share-role">Invited</small>
            <button
              className="share-cancel"
              disabled={!!busy}
              onClick={() => onCancel(invitation.id)}
            >
              {busy === `cancel:${invitation.id}` ? (
                <LoaderCircle className="spin" size={12} />
              ) : (
                "Cancel"
              )}
            </button>
          </li>
        ))}
    </ul>
  );
}

/** How the board of a shared project stands, and what is worth knowing about it. */
function BoardLine({
  standing,
  alreadySaid,
}: {
  standing: BoardStanding;
  alreadySaid?: string;
}) {
  return (
    <div className={`share-board ${standing.tone}`}>
      {standing.line !== alreadySaid && <p>{standing.line}</p>}
      {standing.notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );
}

/** A board the person cannot go on with here: they may stop sharing it on this computer. */
const stuck = (board: SharedBoardStatus | undefined) =>
  board?.state === "apart" || board?.state === "gone";

/** The Share panel while the sharing service cannot be asked. A shared project is still named. */
function PanelWithoutService(props: PanelProps) {
  const { project, state, overview } = props;
  const link = state.sharedProjectLinks?.find(
    (candidate) => candidate.projectId === project.id,
  );
  const board = state.sharedBoards?.find(
    (item) => item.projectId === project.id,
  );
  const detail =
    overview.state === "signed-out"
      ? `Sign in to Memtrace to share ${project.name}.`
      : overview.state === "unavailable"
        ? overview.detail
        : "Sharing is not available.";
  return (
    <div className="share-panel">
      {link && (
        <>
          <h3>
            {project.name} is shared as {link.sharedProjectName}
          </h3>
          <BoardLine
            standing={boardStanding(board, {
              local: project.name,
              shared: link.sharedProjectName,
            })}
            alreadySaid={detail}
          />
        </>
      )}
      <p className="share-note">{detail}</p>
      {overview.state === "signed-out" ? (
        <button className="button primary" onClick={props.onSignIn}>
          Sign in
        </button>
      ) : (
        <button className="button secondary" onClick={props.onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** The Share panel for one answer from the runtime. It decides nothing itself. */
export function SharePanel(props: PanelProps) {
  const { project, state, overview, busy, error } = props;
  if (overview.state !== "ready") return <PanelWithoutService {...props} />;
  const standing = projectSharing(project, state, overview);
  const board = state.sharedBoards?.find(
    (item) => item.projectId === project.id,
  );
  const shared = standing.kind === "connected" ? standing.shared : undefined;
  const line = shared
    ? boardStanding(board, { local: project.name, shared: shared.name })
    : undefined;
  const you: SharedPerson = {
    id: "you",
    name: props.yourName || "You",
    isYou: !!props.yourName,
  };
  const full =
    !!shared &&
    shared.guests.length + shared.openInvitations.length >= shared.guestLimit;
  return (
    <div className="share-panel">
      <h3>Share {project.name}</h3>
      {error && (
        <p className="share-problem" role="alert">
          {error}
        </p>
      )}
      {standing.kind === "gone" ||
      standing.kind === "elsewhere" ||
      stuck(board) ? (
        <>
          <p className="share-note">
            {standing.kind === "gone"
              ? `${standing.name} no longer exists, or you are no longer on it.`
              : standing.kind === "elsewhere"
                ? `${project.name} is shared under another Memtrace account.`
                : line?.line}
          </p>
          <button className="button secondary" onClick={props.onStopSharing}>
            Stop sharing on this computer
          </button>
        </>
      ) : (
        <>
          {(!shared || shared.youAreOwner) && (
            <InviteField
              disabled={full}
              busy={busy}
              onInvite={props.onInvite}
            />
          )}
          <div className="share-heading">People with access</div>
          {shared ? (
            <People
              shared={shared}
              busy={busy}
              onCancel={props.onCancel}
              onRemove={props.onRemove}
            />
          ) : (
            <ul className="share-people">
              <PersonRow
                person={you}
                role="Owner"
                mayRemove={false}
                busy={busy}
                onRemove={props.onRemove}
              />
            </ul>
          )}
          <p className="share-quiet">{placesLine(shared?.guestLimit ?? 2)}</p>
          {line && <BoardLine standing={line} />}
          {shared && !shared.youAreOwner && (
            <button
              className="button secondary share-leave"
              disabled={!!busy}
              onClick={props.onLeave}
            >
              {busy === "leave" ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <LogOut size={13} />
              )}
              Leave {shared.name}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The Share button at the top right of a project, with the people on it beside it. */
export function ShareButton({
  state,
  project,
  overview,
  setOverview,
  refresh,
  notify,
  onSignIn,
  yourName,
}: {
  state: AppState;
  project: Project;
  yourName?: string;
  overview: SharingOverview;
  setOverview(overview: SharingOverview): void;
  refresh(): Promise<void>;
  notify(message: string): void;
  onSignIn(): void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const perform = async (
    key: string,
    action: () => Promise<SharingOverview | unknown>,
    done?: string,
  ) => {
    setBusy(key);
    setError("");
    try {
      const answer = await action();
      if (answer && typeof answer === "object" && "state" in answer)
        setOverview(answer as SharingOverview);
      else await refresh();
      if (done) notify(done);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy("");
    }
  };
  const ready = overview.state === "ready" ? (overview as Ready) : undefined;
  const standing = ready && projectSharing(project, state, ready);
  const shared = standing?.kind === "connected" ? standing.shared : undefined;
  const people = shared ? [shared.owner, ...shared.guests] : [];
  return (
    <div className="share-wrap" ref={root}>
      {people.length > 1 && (
        <span className="share-avatars" aria-label="People on this project">
          {people.slice(0, 3).map((person) => (
            <Avatar key={person.id} person={person} />
          ))}
        </span>
      )}
      <button
        className={"button secondary share-button" + (open ? " open" : "")}
        onClick={() => setOpen((value) => !value)}
      >
        {shared ? <Users size={13} /> : null}
        Share
      </button>
      {open && (
        <div className="share-popover" role="dialog" aria-label="Share">
          <SharePanel
            project={project}
            state={state}
            overview={overview}
            busy={busy}
            error={error}
            yourName={yourName}
            onInvite={(email) =>
              void perform(
                "invite",
                () =>
                  window.memcode.inviteToProject({
                    projectId: project.id,
                    email,
                  }),
                `Invitation sent to ${email}`,
              )
            }
            onCancel={(invitationId) =>
              void perform(`cancel:${invitationId}`, () =>
                window.memcode.cancelProjectInvitation({
                  projectId: project.id,
                  invitationId,
                }),
              )
            }
            onRemove={(person) =>
              void perform(
                `remove:${person.id}`,
                () =>
                  window.memcode.removeFromProject({
                    projectId: project.id,
                    personId: person.id,
                  }),
                `${person.name} is no longer on ${project.name}`,
              )
            }
            onLeave={() =>
              void perform(
                "leave",
                () => window.memcode.leaveProject(project.id),
                `You left ${shared?.name ?? project.name}. Its board stays on this computer.`,
              )
            }
            onStopSharing={() =>
              void perform("stop", () =>
                window.memcode.disconnectSharedProject(project.id),
              )
            }
            onSignIn={onSignIn}
            onRetry={() => void refresh()}
          />
        </div>
      )}
    </div>
  );
}

/** Shared projects not on this computer yet, and invitations, for the project switcher. */
export function sharedInSwitcher(
  state: Pick<AppState, "projects" | "sharedProjectLinks">,
  overview: SharingOverview | null,
): { toOpen: SharedProject[]; invitations: PendingInvitation[] } {
  if (overview?.state !== "ready") return { toOpen: [], invitations: [] };
  return {
    toOpen: overview.projects.filter(
      (shared) =>
        !localProjectOf(
          shared,
          state.sharedProjectLinks ?? [],
          state.projects,
          overview.service,
        ),
    ),
    invitations: overview.invitations,
  };
}

/** The switcher's group for shared projects, those on this computer and those not yet. */
export const SHARED_GROUP = "Shared projects";

/**
 * The switcher's part for shared projects not on this computer, and for
 * invitations. `headed` is false when it goes on from the projects already
 * shared on this computer, under their heading.
 */
export function SwitcherShared({
  state,
  overview,
  act,
  onOpened,
  headed,
}: {
  state: AppState;
  overview: SharingOverview | null;
  act: Act;
  onOpened(): void;
  headed: boolean;
}) {
  const [busy, setBusy] = useState("");
  const { toOpen, invitations } = sharedInSwitcher(state, overview);
  if (!toOpen.length && !invitations.length) return null;
  const run = (key: string, action: () => Promise<unknown>) =>
    void act(async () => {
      setBusy(key);
      try {
        await action();
        onOpened();
      } finally {
        setBusy("");
      }
    });
  return (
    <div>
      {headed && <span className="menu-eyebrow">{SHARED_GROUP}</span>}
      {toOpen.map((shared) => (
        <button
          key={shared.id}
          className="switcher-shared"
          disabled={!!busy}
          onClick={() =>
            run(shared.id, () => window.memcode.openSharedProject(shared.id))
          }
        >
          <span className="project-avatar small">
            {busy === shared.id ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Users size={14} />
            )}
          </span>
          <span>
            {shared.name}
            <small>
              {shared.youAreOwner ? "Yours" : `From ${shared.owner.name}`}
            </small>
          </span>
          <small className="switcher-action">Open</small>
        </button>
      ))}
      {invitations.map((invitation) => (
        <button
          key={invitation.id}
          className="switcher-shared"
          disabled={!!busy}
          onClick={() =>
            run(invitation.id, () =>
              window.memcode.joinSharedProject({
                sharedProjectId: invitation.projectId,
                invitationId: invitation.id,
              }),
            )
          }
        >
          <span className="project-avatar small">
            {busy === invitation.id ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Users size={14} />
            )}
          </span>
          <span>
            {invitation.projectName}
            <small>Invited by {invitation.invitedBy}</small>
          </span>
          <small className="switcher-action join">Join</small>
        </button>
      ))}
    </div>
  );
}

/** Whether a project in the switcher is a shared one. */
export const isSharedHere = (
  state: Pick<AppState, "sharedProjectLinks">,
  projectId: string,
) => !!state.sharedProjectLinks?.some((link) => link.projectId === projectId);

/** On a shared project with no folder on this computer: workers need one to run here. */
export function NoFolderYet({
  open,
  onOpen,
}: {
  open: boolean;
  onOpen(): void;
}) {
  return (
    <div className="share-folder-notice" role="status">
      <FolderOpen size={15} />
      <span>
        This shared project has no folder on this computer yet. Workers run in
        one.
      </span>
      <button className="button secondary" onClick={onOpen}>
        {open ? <X size={13} /> : <Check size={13} />}
        {open ? "Close" : "Work on this computer"}
      </button>
    </div>
  );
}
