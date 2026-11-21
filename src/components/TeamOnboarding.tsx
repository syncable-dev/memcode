import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Copy,
  FolderOpen,
  GitBranch,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import type { AppState, Artifact, Project, WorkItem } from "../shared";
import type {
  TeamDirectory,
  TeamInvitationPreview,
  WorkspaceTeam,
} from "../team-space";
import type { RepositoryDescriptor } from "../repository";
import { teamErrorMessage } from "../team-presentation";
import { Select } from "./Select";
import { TeamWorkspace } from "./TeamWorkspace";
import { LocalProjectSetup } from "./LocalProjectSetup";

interface Props {
  state: AppState;
  project: Project;
  notify: (message: string) => void;
  open: (task: WorkItem) => void;
  openArtifact: (artifact: Artifact) => void;
  onWorkers: () => void;
  onInsights?: () => void;
  joinRequested?: number;
  localSetupRequested?: boolean;
  onLocalSetupHandled?: () => void;
  onJoinHandled?: () => void;
}

export function TeamOnboarding({
  state,
  project,
  notify,
  open,
  openArtifact,
  onWorkers,
  onInsights,
  joinRequested = 0,
  localSetupRequested,
  onLocalSetupHandled,
  onJoinHandled,
}: Props) {
  const [directory, setDirectory] = useState<TeamDirectory | null>(null);
  const [selected, setSelected] = useState("");
  const [panel, setPanel] = useState<
    "" | "create" | "join" | "share" | "invite"
  >("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [invitation, setInvitation] = useState("");
  const [preview, setPreview] = useState<TeamInvitationPreview | null>(null);
  const [email, setEmail] = useState("");
  const [inviteURL, setInviteURL] = useState("");
  const [repository, setRepository] = useState<
    RepositoryDescriptor | undefined
  >();
  const [sourceOpen, setSourceOpen] = useState(false);
  const team =
    directory?.teams.find((entry) => entry.id === selected) ??
    directory?.teams[0];
  const linked = directory?.teams
    .flatMap((entry) =>
      entry.projects.map((item) => ({ team: entry, project: item })),
    )
    .find((entry) => entry.project.localProjectId === project.id);
  const room = state.team?.find((entry) => entry.projectId === project.id);
  const refresh = async () => {
    const value = await window.memcode.teamsList();
    setDirectory(value);
    return value;
  };
  useEffect(() => {
    let live = true;
    void window.memcode
      .teamsList()
      .then((value) => {
        if (live) setDirectory(value);
      })
      .catch((reason) => {
        if (live) setError(teamErrorMessage(reason));
      });
    return () => {
      live = false;
    };
  }, [project.id]);
  useEffect(() => {
    if (joinRequested) {
      setPanel("join");
      setPreview(null);
      onJoinHandled?.();
    }
  }, [joinRequested]);
  useEffect(() => {
    if (linked) setSelected(linked.team.id);
  }, [project.id, linked?.team.id]);
  useEffect(() => {
    setSourceOpen(false);
    setRepository(undefined);
  }, [project.id]);
  useEffect(() => {
    if (localSetupRequested) {
      setSourceOpen(true);
      onLocalSetupHandled?.();
    }
  }, [project.id, localSetupRequested, onLocalSetupHandled]);
  const perform = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(teamErrorMessage(reason));
    } finally {
      setBusy("");
    }
  };
  const showShare = () => {
    const owner = directory?.teams.find((entry) => entry.role === "owner");
    if (directory?.teams.length && !owner) {
      setError("Ask a team owner to share this project with the team.");
      return;
    }
    if (owner) setSelected(owner.id);
    setPanel(directory?.teams.length ? "share" : "create");
    setRepository(undefined);
    if (project.path)
      void perform("repository", async () => {
        const value = await window.memcode.inspectProjectRepository(project.id);
        setRepository(value.repository);
      });
  };
  const create = () =>
    void perform("create", async () => {
      const value = await window.memcode.createTeamWorkspace({
        name: name.trim(),
      });
      setSelected(value.id);
      await refresh();
      setPanel("share");
      notify(`Team ${value.name} created`);
    });
  const share = () =>
    team &&
    void perform("share", async () => {
      await window.memcode.shareTeamProject({
        teamId: team.id,
        projectId: project.id,
        repository,
      });
      await refresh();
      setPanel("invite");
      notify("Project shared with your team");
    });
  const join = () =>
    void perform("accept", async () => {
      const result = await window.memcode.acceptTeamInvitation({
        invite: invitation.trim(),
      });
      setSelected(result.team.id);
      await refresh();
      if (result.project)
        await window.memcode.selectProject(result.project.projectId);
      setPanel("");
      setInvitation("");
      setPreview(null);
      notify(
        result.project ? "Shared project opened" : `Joined ${result.team.name}`,
      );
    });
  const close = () => {
    setPanel("");
    setPreview(null);
    setInviteURL("");
    setError("");
  };
  const renderTeam = (value: WorkspaceTeam) => (
    <div className="collab-team-content">
      <div className="collab-section-heading">
        <div>
          <span className="team-kicker">TEAM PROJECTS</span>
          <h3>{value.name}</h3>
        </div>
        <span className="collab-role">
          {value.role === "owner" ? "Owner" : "Member"}
        </span>
      </div>
      {value.connection === "offline" && (
        <p className="collab-notice" role="status">
          Team service is offline. Your saved projects are available; membership
          changes need a connection.
        </p>
      )}
      {value.connection === "signed-out" && (
        <div className="collab-notice">
          <ShieldCheck size={18} />
          <div>
            <strong>Confirm your Memtrace account to reconnect.</strong>
            <p>
              Your saved board is available. Shared changes wait here until the
              original team member signs in again.
            </p>
            <button
              className="button secondary"
              disabled={!!busy || !directory?.identityAvailable}
              onClick={() =>
                void perform("reconnect", async () => {
                  await window.memcode.reauthenticateTeam({ teamId: value.id });
                  await refresh();
                  notify("Team account reconnected");
                })
              }
            >
              Reconnect with Memtrace
            </button>
          </div>
        </div>
      )}
      {value.connection === "revoked" && (
        <p className="collab-notice" role="status">
          Your access to this team was removed. Saved local files remain
          available. Ask the owner for a new invitation if you need access
          again.
        </p>
      )}
      <div className="collab-projects">
        {value.projects.map((item) => (
          <button
            key={item.workspaceId}
            className={`collab-project ${item.localProjectId === project.id ? "selected" : ""}`}
            disabled={!!busy}
            onClick={() =>
              void perform("open", async () => {
                const opened = await window.memcode.openTeamProject({
                  teamId: value.id,
                  workspaceId: item.workspaceId,
                });
                await window.memcode.selectProject(opened.projectId);
              })
            }
          >
            <span className="project-avatar">
              <FolderOpen size={17} />
            </span>
            <span>
              <strong>{item.name}</strong>
              <small>
                {item.repository?.identity ?? "Shared planning and results"}
              </small>
            </span>
            {item.localProjectId === project.id ? (
              <Check size={15} />
            ) : (
              <ArrowRight size={15} />
            )}
          </button>
        ))}
        {!value.projects.length && (
          <p className="collab-empty">
            Share a project to bring its tasks and discussions into this team.
          </p>
        )}
      </div>
      <div className="collab-section-heading">
        <h3>People</h3>
        {value.role === "owner" && (
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => {
              setPanel("invite");
              setInviteURL("");
            }}
          >
            <Plus size={13} />
            Invite teammate
          </button>
        )}
      </div>
      <div className="collab-members">
        {value.members
          .filter((member) => member.status === "active")
          .map((member) => (
            <div className="collab-member" key={member.id}>
              <span className="team-avatar">
                {member.name.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{member.name}</strong>
                <small>
                  {member.email ??
                    `${member.devices.length} connected ${member.devices.length === 1 ? "device" : "devices"}`}
                </small>
              </div>
              <span className="collab-role">{member.role}</span>
              {value.role === "owner" && member.role !== "owner" && (
                <button
                  className="team-text-button"
                  disabled={!!busy}
                  onClick={() =>
                    void perform(`remove:${member.id}`, async () => {
                      await window.memcode.revokeTeamMember({
                        teamId: value.id,
                        memberId: member.id,
                      });
                      await refresh();
                      notify("Team access removed");
                    })
                  }
                >
                  Remove access
                </button>
              )}
            </div>
          ))}
      </div>
      {value.role === "owner" && !!value.invitations?.length && (
        <section className="collab-invitations">
          <h4>Pending invitations</h4>
          {value.invitations.map((invite) => (
            <div className="collab-member" key={invite.id}>
              <Link2 size={15} />
              <div>
                <strong>{invite.email ?? "Private invitation link"}</strong>
                <small>
                  Expires {new Date(invite.expiresAt).toLocaleDateString()}
                </small>
              </div>
              <button
                className="team-text-button"
                disabled={!!busy}
                onClick={() =>
                  void perform("revoke-invite", async () => {
                    await window.memcode.revokeTeamInvitation({
                      teamId: value.id,
                      invitationId: invite.id,
                    });
                    await refresh();
                    notify("Invitation cancelled");
                  })
                }
              >
                Cancel invitation
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
  return (
    <section className="collab-home">
      <header className="collab-header">
        <div>
          <span className="team-kicker">BUILD TOGETHER</span>
          <h2>A team around the work.</h2>
          <p>One shared plan. Each developer’s own code, tools and workers.</p>
        </div>
        <div className="collab-actions">
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => {
              setPanel("join");
              setPreview(null);
            }}
          >
            <Link2 size={14} />
            Join with invitation
          </button>
          <button
            className="button secondary"
            disabled={!!busy}
            aria-label="Refresh teams"
            onClick={() =>
              void perform("refresh", async () => {
                await refresh();
              })
            }
          >
            <RefreshCw
              size={14}
              className={busy === "refresh" ? "team-spin" : ""}
            />
          </button>
        </div>
      </header>
      {error && (
        <div className="team-error" role="alert">
          {error}
        </div>
      )}
      {["create", "accept", "reconnect"].includes(busy) && (
        <div className="collab-notice" role="status">
          <LoaderCircle size={17} className="team-spin" />
          <div>
            <strong>Waiting for your Memtrace approval.</strong>
            <p>
              Confirm the account in your browser. Return here when you finish.
            </p>
          </div>
          <button
            className="button secondary"
            onClick={() =>
              void window.memcode
                .cancelTeamSignIn()
                .catch((reason) => setError(teamErrorMessage(reason)))
            }
          >
            Cancel sign-in
          </button>
        </div>
      )}
      {!directory && !error && (
        <div className="collab-loading">
          <LoaderCircle size={17} className="team-spin" />
          Loading your teams…
        </div>
      )}
      {directory && !directory.configured && (
        <div className="collab-notice">
          <ShieldCheck size={17} />
          <div>
            <strong>Team service needs setup on this computer.</strong>
            <p>
              {directory.detail ??
                "Your workspace administrator can connect the private team service. An invitation includes the address, so teammates can join directly."}
            </p>
          </div>
        </div>
      )}
      {directory && !directory.identityAvailable && (
        <div className="collab-notice" role="status">
          <ShieldCheck size={17} />
          <div>
            <strong>Memtrace team sign-in is not available yet.</strong>
            <p>
              {directory.detail ??
                "The team identity service must be enabled before creating or joining an account-based team. Your local projects stay available."}
            </p>
          </div>
        </div>
      )}
      {directory && !directory.teams.length && !panel && (
        <div className="collab-welcome">
          <span className="team-symbol">
            <Users size={24} />
          </span>
          <div>
            <h3>Bring your project’s people together.</h3>
            <p>
              Create a named team, share a project, then invite the people you
              build with. They see its current board as soon as they join.
            </p>
            <button
              className="button primary"
              disabled={
                !!busy ||
                !(directory.canCreate ?? directory.configured) ||
                !directory.identityAvailable
              }
              onClick={showShare}
            >
              <Plus size={14} />
              Create a team
              <ArrowRight size={14} />
            </button>
          </div>
          <ol>
            <li>
              <span>01</span>A shared board and discussions
            </li>
            <li>
              <span>02</span>Clear task ownership
            </li>
            <li>
              <span>03</span>Results published on your terms
            </li>
          </ol>
        </div>
      )}
      {panel && (
        <section
          className="collab-flow"
          aria-label={panel === "join" ? "Join a team" : "Team setup"}
        >
          <div className="collab-flow-top">
            <span className="team-kicker">
              {panel === "join"
                ? "YOUR INVITATION"
                : panel === "create"
                  ? "FIRST, YOUR TEAM"
                  : panel === "share"
                    ? "CHOOSE WHAT TO SHARE"
                    : "INVITE YOUR PEOPLE"}
            </span>
            <button
              className="icon-button"
              aria-label="Close team setup"
              disabled={!!busy}
              onClick={close}
            >
              <X size={16} />
            </button>
          </div>
          {panel === "create" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
            >
              <h3>What’s your team called?</h3>
              <p>
                A space for your people and projects. Your personal projects
                stay available.
              </p>
              <label className="team-field">
                <span>Team name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="For example, Syncable"
                  maxLength={80}
                  autoFocus
                />
              </label>
              <div className="collab-flow-footer">
                <small>
                  Continue in your browser to confirm your Memtrace identity.
                </small>
                <button
                  className="button primary"
                  disabled={!!busy || !name.trim()}
                >
                  {busy === "create" ? (
                    <LoaderCircle size={14} className="team-spin" />
                  ) : (
                    <ArrowRight size={14} />
                  )}
                  Create team
                </button>
              </div>
            </form>
          )}
          {panel === "share" && (
            <>
              <h3>Share {project.name}</h3>
              <p>
                The team gets the project’s current goals, tasks, cycles and
                discussions.
              </p>
              {directory && directory.teams.length > 1 && (
                <label className="team-field">
                  <span>Team</span>
                  <Select value={team?.id ?? ""} onValueChange={setSelected}>
                    {directory.teams.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              <div className="collab-share-summary">
                <FolderOpen size={19} />
                <div>
                  <strong>{project.name}</strong>
                  <small>
                    {
                      state.tasks.filter(
                        (item) => item.projectId === project.id,
                      ).length
                    }{" "}
                    tasks ·{" "}
                    {
                      state.epics.filter(
                        (item) => item.projectId === project.id,
                      ).length
                    }{" "}
                    goals
                  </small>
                </div>
              </div>
              {repository && (
                <div className="collab-repository">
                  <GitBranch size={15} />
                  <span>{repository.identity}</span>
                  <small>Code changes through Git</small>
                </div>
              )}
              {!repository && busy !== "repository" && (
                <p className="collab-caption">
                  <strong>Planning-only connection.</strong> No remote
                  repository is linked to this project yet. Teammates can plan
                  and review immediately; connect a Git remote to offer cloning.
                </p>
              )}
              <p className="collab-caption">
                Published files are shared explicitly. Your local source folder,
                model credentials and running sessions stay on this computer.
              </p>
              <div className="collab-flow-footer">
                <span />
                <button
                  className="button primary"
                  disabled={
                    !!busy ||
                    !!project.example ||
                    !team ||
                    team.role !== "owner"
                  }
                  onClick={share}
                >
                  {busy === "share" ? (
                    <LoaderCircle size={14} className="team-spin" />
                  ) : (
                    <Users size={14} />
                  )}
                  Share with {team?.name ?? "team"}
                </button>
              </div>
            </>
          )}
          {panel === "join" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (preview) join();
                else
                  void perform("preview", async () =>
                    setPreview(
                      await window.memcode.previewTeamInvitation({
                        invite: invitation.trim(),
                      }),
                    ),
                  );
              }}
            >
              <h3>
                {preview ? `Join ${preview.teamName}` : "Open your invitation."}
              </h3>
              <p>
                {preview
                  ? "Accept the invitation with your Memtrace account. The shared project opens with its existing work."
                  : "Paste the link your teammate sent. You don’t need to create a project first."}
              </p>
              {!preview ? (
                <label className="team-field">
                  <span>Invitation link</span>
                  <input
                    value={invitation}
                    onChange={(event) => setInvitation(event.target.value)}
                    placeholder="Paste your private invitation"
                    spellCheck={false}
                    autoComplete="off"
                    autoFocus
                  />
                </label>
              ) : (
                <div className="collab-invite-preview">
                  <Users size={21} />
                  <div>
                    <strong>{preview.teamName}</strong>
                    <span>{preview.projectName ?? "Team membership"}</span>
                    {preview.invitedBy && (
                      <small>Invited by {preview.invitedBy}</small>
                    )}
                    {preview.repository && (
                      <small>
                        <GitBranch size={12} /> {preview.repository.identity} ·
                        Repository access is checked separately.
                      </small>
                    )}
                    <small>
                      {preview.invitedEmail
                        ? `Invited account: ${preview.invitedEmail}`
                        : "Sign in with your Memtrace account"}{" "}
                      · expires{" "}
                      {new Date(preview.expiresAt).toLocaleDateString()}
                    </small>
                  </div>
                </div>
              )}
              <div className="collab-flow-footer">
                {preview ? (
                  <button
                    type="button"
                    className="team-text-button"
                    disabled={!!busy}
                    onClick={() => setPreview(null)}
                  >
                    Use a different invitation
                  </button>
                ) : (
                  <small>Your existing projects stay available.</small>
                )}
                <button
                  className="button primary"
                  disabled={
                    !!busy ||
                    !invitation.trim() ||
                    (!!preview && !directory?.identityAvailable)
                  }
                >
                  {busy ? (
                    <LoaderCircle size={14} className="team-spin" />
                  ) : (
                    <ArrowRight size={14} />
                  )}
                  {preview ? "Accept and open" : "Continue"}
                </button>
              </div>
            </form>
          )}
          {panel === "invite" && team && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform("invite", async () => {
                  const value = await window.memcode.inviteTeamMember({
                    teamId: team.id,
                    ...(linked?.team.id === team.id
                      ? { projectWorkspaceId: linked.project.workspaceId }
                      : {}),
                    ...(email.trim() ? { email: email.trim() } : {}),
                  });
                  setInviteURL(value.url);
                });
              }}
            >
              <h3>Invite someone to {team.name}</h3>
              <p>
                They’ll join your team and open the shared project. Repository
                access is managed separately through Git.
              </p>
              {!inviteURL ? (
                <>
                  <label className="team-field">
                    <span>
                      Email address{" "}
                      <small>Optional · restrict who can accept</small>
                    </span>
                    <input
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="teammate@company.com"
                      maxLength={320}
                    />
                  </label>
                  <div className="collab-flow-footer">
                    <small>Share the invitation privately.</small>
                    <button className="button primary" disabled={!!busy}>
                      {busy ? (
                        <LoaderCircle size={14} className="team-spin" />
                      ) : (
                        <Link2 size={14} />
                      )}
                      Create invitation
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label className="team-field">
                    <span>Invitation link</span>
                    <input
                      readOnly
                      value={inviteURL}
                      onFocus={(event) => event.target.select()}
                    />
                  </label>
                  <div className="collab-flow-footer">
                    <small>Memtrace sign-in is required to accept.</small>
                    <button
                      type="button"
                      className="button primary"
                      onClick={() =>
                        void perform("copy", async () => {
                          await navigator.clipboard.writeText(inviteURL);
                          notify("Invitation copied");
                        })
                      }
                    >
                      <Copy size={14} />
                      Copy invitation
                    </button>
                  </div>
                </>
              )}
            </form>
          )}
          {busy && !["refresh", "copy", "repository"].includes(busy) && (
            <p className="collab-pending" role="status">
              {busy === "create" || busy === "accept"
                ? "Continue the Memtrace approval in your browser. This window will update when you finish."
                : "Saving your team changes…"}
            </p>
          )}
        </section>
      )}
      {directory && directory.teams.length > 0 && (
        <div className="collab-directory">
          <aside className="collab-team-list">
            <span className="team-kicker">YOUR TEAMS</span>
            {directory.teams.map((item) => (
              <button
                key={item.id}
                className={team?.id === item.id ? "selected" : ""}
                onClick={() => setSelected(item.id)}
              >
                <Users size={15} />
                <span>{item.name}</span>
                <small>
                  {
                    item.members.filter((member) => member.status === "active")
                      .length
                  }
                </small>
              </button>
            ))}
            {directory.canCreate !== false && (
              <button
                disabled={!!busy || !directory.configured}
                onClick={() => setPanel("create")}
              >
                <Plus size={14} />
                New team
              </button>
            )}
          </aside>
          {team && renderTeam(team)}
        </div>
      )}
      {directory &&
        directory.teams.length > 0 &&
        !linked &&
        !project.example && (
          <div className="collab-current-project">
            <FolderOpen size={20} />
            <div>
              <strong>{project.name} is a personal project.</strong>
              <p>
                {directory.teams.some((entry) => entry.role === "owner")
                  ? "Share its current work with your team whenever you’re ready."
                  : "A team owner can add this project to the shared workspace."}
              </p>
            </div>
            {directory.teams.some((entry) => entry.role === "owner") && (
              <button
                className="button primary"
                disabled={!!busy}
                onClick={showShare}
              >
                <Users size={14} />
                Share project
              </button>
            )}
          </div>
        )}
      {linked && (
        <div className="collab-current-project">
          <ShieldCheck size={20} />
          <div>
            <strong>
              {project.name} · {linked.team.name}
            </strong>
            <p>
              {project.path
                ? "Local code is connected on this computer. Workers use your approved provider setup."
                : "The shared board is ready. Connect local code when you want to run workers."}
            </p>
          </div>
          <button
            className="button secondary"
            onClick={() => setSourceOpen((value) => !value)}
          >
            <FolderOpen size={14} />
            {project.path ? "Local setup" : "Work on this computer"}
          </button>
        </div>
      )}
      {sourceOpen && (
        <LocalProjectSetup
          project={project}
          repository={linked?.project.repository}
          notify={notify}
          onWorkers={onWorkers}
          onInsights={onInsights}
        />
      )}
      {room && (
        <TeamWorkspace
          state={state}
          project={project}
          notify={notify}
          open={open}
          openArtifact={openArtifact}
          managed={!!linked}
        />
      )}
      <footer className="collab-principle">
        <GitBranch size={14} />
        <span>
          Team sync carries planning and published results. Git carries code.
          Your Memtrace analysis and workers run locally.
        </span>
      </footer>
    </section>
  );
}
