import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  FileText,
  FolderOpen,
  GitBranch,
  Globe2,
  Link2,
  LoaderCircle,
  LogOut,
  MessageSquare,
  Monitor,
  RefreshCw,
  Send,
  ShieldCheck,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import type {
  AppState,
  Artifact,
  Project,
  TeamWorkspaceState,
  WorkItem,
} from "../shared";
import { groupedArtifacts } from "../artifact-purpose";
import { isActive } from "../domain";
import {
  teamClaimForStory,
  teamErrorMessage,
  teamSyncLabel,
} from "../team-presentation";
import { Select } from "./Select";
import { Time } from "./UI";

interface Props {
  state: AppState;
  project: Project;
  notify: (message: string) => void;
  open: (task: WorkItem) => void;
  openArtifact: (artifact: Artifact) => void;
  managed?: boolean;
}

export function TeamWorkspace({
  state,
  project,
  notify,
  open,
  openArtifact,
  managed = false,
}: Props) {
  const [team, setTeam] = useState<TeamWorkspaceState | null>(
    () => state.team?.find((item) => item.projectId === project.id) ?? null,
  );
  const [busy, setBusy] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [bootstrapSecret, setBootstrapSecret] = useState("");
  const [shareOnLAN, setShareOnLAN] = useState(false);
  const [advertisedHost, setAdvertisedHost] = useState("");
  const [invitation, setInvitation] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [publishId, setPublishId] = useState("none");
  const [leaving, setLeaving] = useState(false);
  const [joining, setJoining] = useState(false);
  const tasks = state.tasks.filter((task) => task.projectId === project.id);
  const artifacts = groupedArtifacts(
    state.artifacts.filter((item) => item.projectId === project.id),
  ).primary;
  useEffect(() => {
    setTeam(state.team?.find((item) => item.projectId === project.id) ?? null);
  }, [state.team, project.id]);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => window.memcode.teamStatus(project.id))
      .then((result) => {
        if (live) setTeam(result);
      })
      .catch((reason) => {
        if (live) setError(teamErrorMessage(reason));
      });
    return () => {
      live = false;
    };
  }, [project.id]);
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
  const refresh = () =>
    void perform("refresh", async () =>
      setTeam(await window.memcode.teamStatus(project.id)),
    );
  const memberName = (id: string) =>
    team?.workspace.members.find((item) => item.id === id)?.name ??
    "Workspace member";
  const online =
    team?.connection === "online" || team?.connection === "syncing";
  const joinProject = () =>
    void perform("join", async () => {
      const next = await window.memcode.teamJoin({
        displayName: displayName.trim(),
        invite: invitation.trim(),
      });
      await window.memcode.selectProject(next.projectId);
      setTeam(next);
      setJoining(false);
      setInvitation("");
      notify("Shared project opened");
    });
  const connectFolder = () =>
    void perform("folder", async () => {
      const path = await window.memcode.selectFolder();
      if (!path) return;
      await window.memcode.bindProjectFolder(project.id, path);
      notify("Local project folder connected");
    });
  const joinForm = (
    <form
      className="team-panel team-setup-panel team-join-panel"
      onSubmit={(event) => {
        event.preventDefault();
        joinProject();
      }}
    >
      <div className="team-join-heading">
        <span className="team-panel-icon">
          <Link2 size={19} />
        </span>
        {team && (
          <button
            type="button"
            className="icon-button"
            aria-label="Close join project"
            onClick={() => setJoining(false)}
          >
            <X size={15} />
          </button>
        )}
      </div>
      <h3>Join a project</h3>
      <p>
        Paste an invitation to open the project’s current board, goals, comments
        and published results.
      </p>
      <label className="team-field">
        <span>Your display name</span>
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="How teammates know you"
          maxLength={80}
          autoComplete="nickname"
        />
      </label>
      <label className="team-field">
        <span>Workspace invitation</span>
        <textarea
          value={invitation}
          onChange={(event) => setInvitation(event.target.value)}
          placeholder="Paste the invitation from your teammate"
          rows={3}
          spellCheck={false}
        />
      </label>
      <button
        className="button primary team-setup-submit"
        disabled={!!busy || !displayName.trim() || !invitation.trim()}
      >
        {busy === "join" ? (
          <LoaderCircle className="team-spin" size={14} />
        ) : (
          <ArrowRight size={14} />
        )}
        Join project
      </button>
      <small className="team-form-note">
        Your existing projects stay as they are. Connect a local code folder
        later when you want to run workers.
      </small>
    </form>
  );
  if (!team)
    return (
      <section className="team-workspace">
        <div className="team-intro">
          <span className="team-symbol">
            <Users size={23} />
          </span>
          <div>
            <span className="team-kicker">PRIVATE PREVIEW</span>
            <h2>A shared plan. Your own workspace.</h2>
            <p>
              Share the board, discussions and finished work. Everyone runs
              their own workers and uses Git for code.
            </p>
          </div>
        </div>
        {error && (
          <div className="team-error" role="alert">
            {error}
            <button className="button secondary" onClick={refresh}>
              <RefreshCw size={12} />
              Retry
            </button>
          </div>
        )}
        <div className="team-setup-grid">
          <form
            className="team-panel team-setup-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void perform("create", async () => {
                setTeam(
                  await window.memcode.teamCreate({
                    projectId: project.id,
                    displayName: displayName.trim(),
                    ...(endpoint.trim()
                      ? {
                          endpoint: endpoint.trim(),
                          bootstrapSecret: bootstrapSecret.trim(),
                        }
                      : {
                          shareOnLAN,
                          ...(advertisedHost.trim()
                            ? { advertisedHost: advertisedHost.trim() }
                            : {}),
                        }),
                  }),
                );
                setBootstrapSecret("");
              });
            }}
          >
            <span className="team-panel-icon">
              <Users size={19} />
            </span>
            <h3>Share this project</h3>
            <p>
              Start a private team workspace with this project’s goals, tasks
              and cycles.
            </p>
            <div className="team-setup-context">
              <GitBranch size={14} />
              <span>
                {project.path
                  ? project.name
                  : "Choose a local project to share"}
              </span>
            </div>
            <label className="team-field">
              <span>Your display name</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="How teammates know you"
                maxLength={80}
                autoComplete="nickname"
              />
            </label>
            <label className="team-lan-option">
              <input
                type="checkbox"
                checked={shareOnLAN}
                disabled={!!endpoint.trim()}
                onChange={(event) => setShareOnLAN(event.target.checked)}
              />
              <span>
                Allow teammates on this local network
                <small>
                  Private invitation required. Keep this computer running.
                </small>
              </span>
            </label>
            <details className="team-advanced">
              <summary>
                <ChevronDown size={12} />
                Advanced connection
              </summary>
              <label className="team-field">
                <span>
                  Relay address <small>Optional</small>
                </span>
                <input
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  placeholder="Start on this computer"
                  inputMode="url"
                />
              </label>
              {endpoint.trim() ? (
                <label className="team-field">
                  <span>Relay setup secret</span>
                  <input
                    type="password"
                    value={bootstrapSecret}
                    onChange={(event) => setBootstrapSecret(event.target.value)}
                    placeholder="From the relay administrator"
                    autoComplete="off"
                    required
                  />
                </label>
              ) : shareOnLAN ? (
                <label className="team-field">
                  <span>
                    Advertised host <small>Optional</small>
                  </span>
                  <input
                    value={advertisedHost}
                    onChange={(event) => setAdvertisedHost(event.target.value)}
                    placeholder="Detect local network address"
                    autoComplete="off"
                  />
                </label>
              ) : null}
            </details>
            <button
              className="button primary team-setup-submit"
              disabled={
                !!busy ||
                !displayName.trim() ||
                (!!endpoint.trim() && !bootstrapSecret.trim()) ||
                !project.path ||
                !!project.example
              }
            >
              {busy === "create" ? (
                <LoaderCircle className="team-spin" size={14} />
              ) : (
                <Link2 size={14} />
              )}
              Share project
              <ArrowRight size={14} />
            </button>
            <small className="team-form-note">
              {endpoint.trim()
                ? "Uses your specified private relay."
                : shareOnLAN
                  ? "Invitations use this computer’s network address. Both devices must reach it."
                  : "Without network access, invitations work on this computer only."}
            </small>
          </form>
          {joinForm}
        </div>
        <div className="team-sharing-note">
          <ShieldCheck size={17} />
          <p>
            <strong>Invite access, with clear boundaries.</strong> Invitations
            grant workspace access. Display names in this preview are not
            verified Memtrace team identities. Model credentials, terminal
            sessions and local analysis are not shared. Worker conversations,
            progress and saved review reports are visible to project members.
          </p>
        </div>
      </section>
    );
  const workspace = team.workspace;
  const currentMember = workspace.members.find(
    (item) => item.id === team.memberId,
  );
  const activity = workspace.activity.slice(-30).reverse();
  return (
    <section className="team-workspace">
      <div className="team-overview">
        <div className="team-overview-title">
          <span className="team-symbol">
            <Users size={22} />
          </span>
          <div>
            <span className="team-kicker">
              {managed ? "PROJECT ACTIVITY" : "PRIVATE PREVIEW · INVITE ACCESS"}
            </span>
            <h2>{workspace.name}</h2>
            <p>Shared work. Local workers. Source changes through Git.</p>
          </div>
        </div>
        <div className="team-overview-actions">
          <span
            className={`team-sync-state ${online ? "" : "disconnected"}`}
            role="status"
          >
            {online ? (
              <span className="team-sync-dot" />
            ) : (
              <WifiOff size={13} />
            )}
            {teamSyncLabel(team)}
          </span>
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={refresh}
            aria-label="Refresh team sync"
          >
            <RefreshCw
              className={busy === "refresh" ? "team-spin" : ""}
              size={13}
            />
          </button>
          {!managed && (
            <button
              className="button primary"
              disabled={!!busy || !online}
              onClick={() =>
                void perform("invite", async () => {
                  const value = await window.memcode.teamInvite(project.id);
                  setInvite(JSON.stringify(value));
                })
              }
            >
              <Link2 size={14} />
              Invite teammate
            </button>
          )}
          {!managed && (
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={() => setJoining((value) => !value)}
            >
              <Link2 size={13} />
              Join another project
            </button>
          )}
        </div>
      </div>
      {team.planningHistory && (
        <div
          className={`team-history-status ${team.planningHistory.state}`}
          role="status"
        >
          {team.planningHistory.state === "synced" ? (
            <Check size={15} />
          ) : team.planningHistory.state === "pending" &&
            !team.planningHistory.importAvailable ? (
            <LoaderCircle size={15} className="team-spin" />
          ) : (
            <FileText size={15} />
          )}
          <div>
            <strong>
              {team.planningHistory.state === "synced"
                ? online
                  ? "Planning history in sync"
                  : "Planning history saved on this computer"
                : team.planningHistory.state === "pending"
                  ? team.planningHistory.importAvailable
                    ? "Original history ready to share"
                    : "Syncing planning history"
                  : team.planningHistory.state === "unsupported"
                    ? "History sync needs a service update"
                    : "Planning history needs attention"}
            </strong>
            <span>
              {team.planningHistory.state === "synced"
                ? `${team.planningHistory.eventCount.toLocaleString()} recorded changes · ${team.planningHistory.cycleSnapshotCount.toLocaleString()} cycle checkpoints`
                : team.planningHistory.detail ||
                  "Your saved history is preserved on this computer."}
            </span>
          </div>
          {team.planningHistory.importAvailable &&
            currentMember?.role === "owner" && (
              <button
                className="button secondary"
                disabled={!!busy || !online || tasks.some(isActive)}
                onClick={() =>
                  void perform("history", async () => {
                    setTeam(await window.memcode.importTeamHistory(project.id));
                  })
                }
              >
                {busy === "history" ? (
                  <LoaderCircle size={13} className="team-spin" />
                ) : (
                  <ArrowUpRight size={13} />
                )}
                Share original history
              </button>
            )}
        </div>
      )}
      {(error || team.error) && (
        <div className="team-error" role="alert">
          {error || team.error}
        </div>
      )}
      {joining && joinForm}
      {!managed && !project.path && (
        <div className="team-folder-note">
          <FolderOpen size={19} />
          <div>
            <strong>Your shared project is ready.</strong>
            <p>
              Plan work, discuss tasks and view results now. Connect your
              existing local code folder when you want to run workers.
            </p>
          </div>
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={connectFolder}
          >
            {busy === "folder" ? (
              <LoaderCircle className="team-spin" size={13} />
            ) : (
              <FolderOpen size={13} />
            )}
            Connect local folder
          </button>
        </div>
      )}
      {!online && (
        <div className="team-offline-note">
          <WifiOff size={15} />
          <div>
            <strong>Your local work is available.</strong>
            <span>
              Shared changes wait here until the relay reconnects. New shared
              workers need an online task claim.
            </span>
          </div>
          {team.lastSyncedAt && (
            <small>
              Last sync <Time at={team.lastSyncedAt} />
            </small>
          )}
        </div>
      )}
      {invite && (
        <div className="team-invite-panel">
          <div>
            <strong>Your workspace invitation</strong>
            <p>
              Share privately. Anyone holding this invitation can join this
              preview.
            </p>
          </div>
          <textarea
            aria-label="Workspace invitation to copy"
            value={invite}
            readOnly
            rows={3}
            onFocus={(event) => event.target.select()}
          />
          <button
            className="button secondary"
            onClick={() =>
              void perform("copy", async () => {
                await navigator.clipboard.writeText(invite);
                notify("Workspace invitation copied");
              })
            }
          >
            <Copy size={13} />
            Copy invitation
          </button>
          <button className="team-text-button" onClick={() => setInvite("")}>
            Hide invitation
          </button>
        </div>
      )}
      <div className="team-summary-strip">
        <span>
          <strong>{workspace.members.length}</strong>{" "}
          {workspace.members.length === 1 ? "teammate" : "teammates"}
        </span>
        <span>
          <strong>{workspace.stories.length}</strong>{" "}
          {workspace.stories.length === 1 ? "shared task" : "shared tasks"}
        </span>
        <span>
          <strong>{workspace.claims.length}</strong>{" "}
          {online
            ? workspace.claims.length === 1
              ? "held claim"
              : "held claims"
            : workspace.claims.length === 1
              ? "last known claim"
              : "last known claims"}
        </span>
        <span>
          <strong>{workspace.results.length}</strong>{" "}
          {workspace.results.length === 1
            ? "published result"
            : "published results"}
        </span>
        <span className="team-summary-self">
          You’re <strong>{currentMember?.name ?? "a workspace member"}</strong>
          <small>{managed ? "Team member" : "Preview identity"}</small>
        </span>
      </div>
      <div className="team-main-grid">
        <div className="team-main-column">
          <section className="team-panel team-activity-panel">
            <div className="team-panel-heading">
              <div>
                <span className="team-kicker">KEEP UP WITH THE TEAM</span>
                <h3>
                  Shared activity{" "}
                  {team.unreadCount > 0 && (
                    <span className="team-count">{team.unreadCount} new</span>
                  )}
                </h3>
              </div>
              <button
                className="team-text-button"
                disabled={!!busy || !online || !team.unreadCount}
                onClick={() =>
                  void perform("read", async () =>
                    setTeam(await window.memcode.teamRead(project.id)),
                  )
                }
              >
                <Check size={13} />
                Mark read
              </button>
            </div>
            {activity.length ? (
              <ol className="team-activity-list">
                {activity.map((item) => {
                  const task = tasks.find(
                    (entry) => entry.id === item.entityId,
                  );
                  return (
                    <li key={item.id}>
                      <span className="team-avatar">
                        {memberName(item.memberId).slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <p>
                          <strong>{memberName(item.memberId)}</strong>
                          <span>{item.summary}</span>
                        </p>
                        <small>
                          <Time at={item.at} />
                          {task && (
                            <button onClick={() => open(task)}>
                              {task.identifier}
                              <ArrowUpRight size={11} />
                            </button>
                          )}
                        </small>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="team-empty-inline">
                <MessageSquare size={21} />
                <strong>A shared history starts here.</strong>
                <p>
                  Task changes, comments, claims and published results appear
                  as they happen.
                </p>
              </div>
            )}
          </section>
          <section className="team-panel">
            <div className="team-panel-heading">
              <div>
                <span className="team-kicker">
                  FINISHED WORK, SHARED ON PURPOSE
                </span>
                <h3>Published results</h3>
              </div>
              <FileText size={18} />
            </div>
            <div className="team-publish">
              <label className="team-field">
                <span>Choose a local report or artifact</span>
                <Select
                  aria-label="Result to publish"
                  value={publishId}
                  onValueChange={setPublishId}
                >
                  <option value="none">Select finished work…</option>
                  {artifacts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {tasks.find((entry) => entry.id === item.taskId)
                        ?.identifier ?? "Task"}{" "}
                      · {item.name}
                    </option>
                  ))}
                </Select>
              </label>
              <button
                className="button secondary"
                disabled={!!busy || !online || publishId === "none"}
                onClick={() =>
                  void perform("publish", async () => {
                    const artifact = artifacts.find(
                      (item) => item.id === publishId,
                    );
                    if (!artifact) return;
                    await window.memcode.teamPublish({
                      projectId: project.id,
                      taskId: artifact.taskId,
                      artifactId: artifact.id,
                    });
                    setPublishId("none");
                    notify("Result published to the workspace");
                  })
                }
              >
                {busy === "publish" ? (
                  <LoaderCircle className="team-spin" size={13} />
                ) : (
                  <Send size={13} />
                )}
                Publish
              </button>
            </div>
            <p className="team-section-caption">
              Only the selected file is uploaded. Supporting evidence stays
              local.
            </p>
            {workspace.results.length ? (
              <div className="team-results-list">
                {[...workspace.results].reverse().map((result) => (
                  <button
                    key={result.id}
                    className="team-result-row"
                    disabled={!!busy}
                    onClick={() =>
                      void perform(result.id, async () => {
                        const artifact =
                          await window.memcode.teamDownloadResult(
                            project.id,
                            result.id,
                          );
                        openArtifact(artifact);
                      })
                    }
                  >
                    <span className="team-result-icon">
                      <FileText size={18} />
                    </span>
                    <span>
                      <strong>{result.name}</strong>
                      <small>
                        {memberName(result.memberId)} ·{" "}
                        {Math.max(1, Math.ceil(result.size / 1024))} KB ·{" "}
                        <Time at={result.createdAt} />
                      </small>
                    </span>
                    {busy === result.id ? (
                      <LoaderCircle className="team-spin" size={15} />
                    ) : (
                      <ArrowDownToLine size={15} />
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <div className="team-empty-inline compact">
                <p>
                  No results published yet. Choose a report or artifact when it
                  is ready for your team.
                </p>
              </div>
            )}
          </section>
        </div>
        <aside className="team-side-column">
          <section className="team-panel">
            <div className="team-panel-heading">
              <h3>People & devices</h3>
              <Users size={17} />
            </div>
            <div className="team-member-list">
              {workspace.members.map((member) => (
                <div className="team-member" key={member.id}>
                  <span className="team-avatar">
                    {member.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <strong>
                      {member.name}
                      {member.id === team.memberId && <small>You</small>}
                    </strong>
                    {member.devices.map((device) => (
                      <span key={device.id}>
                        <Monitor size={11} />
                        {device.name}
                        {device.id === team.deviceId &&
                        member.id === team.memberId
                          ? " · this device"
                          : ""}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="team-section-caption">
              Registered devices are shown here. This preview does not report
              live teammate presence.
            </p>
          </section>
          <section className="team-panel">
            <div className="team-panel-heading">
              <h3>Task claims</h3>
              <ShieldCheck size={17} />
            </div>
            {workspace.claims.length ? (
              <div className="team-claims-list">
                {workspace.claims.map((claim) => {
                  const task = tasks.find((item) => item.id === claim.storyId);
                  const story = workspace.stories.find(
                    (item) => item.id === claim.storyId,
                  );
                  const owner = teamClaimForStory(team, claim.storyId)!;
                  return (
                    <div className="team-claim-entry" key={claim.storyId}>
                      <button
                        disabled={!task}
                        onClick={() => task && open(task)}
                      >
                        <span className="team-claim-identifier">
                          {story?.identifier ?? "Task"}
                          <span>
                            {online ? "Claim held" : "Last known claim"}
                          </span>
                        </span>
                        <strong>{story?.title ?? "Shared task"}</strong>
                        <small>
                          {owner.name} · {owner.device}
                        </small>
                      </button>
                      {owner.local && (
                        <button
                          className="team-text-button team-release-claim"
                          disabled={
                            !!busy || !online || (!!task && isActive(task))
                          }
                          title={
                            task && isActive(task)
                              ? "Stop the worker before releasing its claim"
                              : "Release this device’s task claim"
                          }
                          onClick={() =>
                            void perform(`release:${claim.storyId}`, async () =>
                              setTeam(
                                await window.memcode.teamRelease(
                                  project.id,
                                  claim.storyId,
                                ),
                              ),
                            )
                          }
                        >
                          Release claim
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="team-empty-inline compact">
                <p>
                  No task is claimed. Starting a worker reserves that task for
                  one device.
                </p>
              </div>
            )}
            <p className="team-section-caption">
              A claim protects the task from a second worker start. It does not
              imply a worker is currently running.
            </p>
          </section>
          <section className="team-local-note">
            <GitBranch size={17} />
            <div>
              <strong>Code stays in your workflow.</strong>
              <p>
                Use Git to exchange source changes. Each computer keeps its
                workers, model access and Memtrace Fleet local.
              </p>
            </div>
          </section>
        </aside>
      </div>
      <footer className="team-footer">
        <span>
          <Globe2 size={12} />
          Private Team Sync preview · {workspace.head} shared events
        </span>
        {leaving ? (
          <div>
            <span>Disconnect this local project?</span>
            <button
              className="team-text-button"
              disabled={!!busy}
              onClick={() =>
                void perform("leave", async () => {
                  await window.memcode.teamLeave(project.id);
                  setTeam(null);
                  setLeaving(false);
                  setInvite("");
                })
              }
            >
              Disconnect
            </button>
            <button
              className="team-text-button"
              onClick={() => setLeaving(false)}
            >
              Keep connected
            </button>
          </div>
        ) : (
          <button className="team-text-button" onClick={() => setLeaving(true)}>
            <LogOut size={12} />
            Disconnect project
          </button>
        )}
      </footer>
    </section>
  );
}
