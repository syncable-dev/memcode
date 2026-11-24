import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  Hash,
  Inbox as InboxIcon,
  MessageSquare,
  RotateCcw,
  X,
} from "lucide-react";
import type { Project } from "../shared";
import {
  commentsSince,
  filesOf,
  lastActivity,
  type InboxItem,
  type InboxReply,
  type InboxState,
  type ProjectInbox,
} from "../inbox";
import { InboxEvidence } from "./InboxEvidence";
import { Empty, Spinner, Time } from "./UI";
import "../styles-inbox.css";

interface Props {
  project: Project;
  /** Opens Settings › Integrations, where Slack is connected. */
  onConnectSlack: () => void;
  onDefineGoal: (item: InboxItem) => void;
  notify: (message: string) => void;
}

/** How often an open Inbox looks for new reports. */
const REFRESH_MS = 15_000;

const stateNames: Record<InboxState, string> = {
  new: "New",
  picked_up: "Picked up",
  declined: "Declined",
};
const howBadNames = {
  blocked: "Someone is blocked",
  annoying: "Annoying",
  idea: "An idea",
} as const;
const count = (many: number, one: string) =>
  `${many} ${one}${many === 1 ? "" : "s"}`;

const SEEN = "memcode.inbox.seen";
/** When each report was last looked at on this computer. Only marks what is new. */
function seenReports(): Record<string, string> {
  try {
    const kept = JSON.parse(localStorage.getItem(SEEN) ?? "{}");
    return kept && typeof kept === "object" ? kept : {};
  } catch {
    return {};
  }
}
function rememberSeen(id: string, at: string) {
  try {
    localStorage.setItem(SEEN, JSON.stringify({ ...seenReports(), [id]: at }));
  } catch {
    // Nothing is lost: a comment may be marked new once more.
  }
}

/** Reports people sent from Slack, waiting for someone to pick them up. */
export function Inbox(props: Props) {
  const { project, notify } = props;
  const [inbox, setInbox] = useState<ProjectInbox | null>(null);
  const [problem, setProblem] = useState("");
  const [filter, setFilter] = useState<InboxState>("new");
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(seenReports);
  const look = useCallback((id: string, at: string) => {
    rememberSeen(id, at);
    setSeen((known) => ({ ...known, [id]: at }));
  }, []);

  const load = useCallback(async () => {
    try {
      setInbox(await window.memcode.projectInbox(project.id));
      setProblem("");
    } catch (error) {
      setProblem((error as Error).message);
    }
  }, [project.id]);

  useEffect(() => {
    setInbox(null);
    setSelectedId(undefined);
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (work: () => Promise<ProjectInbox>) => {
    setBusy(true);
    try {
      setInbox(await work());
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const items = inbox?.items ?? [];
  const shown = items.filter((item) => item.state === filter);
  // Like an email inbox: once a report is decided, the next one in the list shows.
  const selected = shown.find((item) => item.id === selectedId) ?? shown[0];
  const counts = useMemo(() => {
    const counted: Record<InboxState, number> = {
      new: 0,
      picked_up: 0,
      declined: 0,
    };
    for (const item of items) counted[item.state] += 1;
    return counted;
  }, [items]);

  // Slack was never connected, or it was and nobody has reported anything.
  const unused =
    inbox &&
    !inbox.channelsUnavailable &&
    !inbox.items.length &&
    !inbox.workspaces.length &&
    !inbox.channels.length;
  if (unused)
    return (
      <div className="inbox-page">
        <Empty
          icon={<InboxIcon size={20} />}
          title="Get problem reports from Slack"
          description="Connect Slack, then mention @MemCode in any channel. What people report there lands here, with their screenshots and files."
          action={
            <button
              type="button"
              className="button primary"
              onClick={props.onConnectSlack}
            >
              Connect Slack
            </button>
          }
        />
      </div>
    );

  return (
    <div className="inbox-page">
      <SlackChannels inbox={inbox} />
      {problem && <p className="inbox-problem">{problem}</p>}
      {!inbox && !problem && (
        <div className="inbox-loading">
          <Spinner /> Reading the Inbox
        </div>
      )}
      {inbox && (
        <div className="inbox-columns">
          <section className="inbox-list" aria-label="Reports">
            <div className="inbox-filters" role="tablist">
              {(Object.keys(stateNames) as InboxState[]).map((state) => (
                <button
                  key={state}
                  role="tab"
                  aria-selected={filter === state}
                  className={filter === state ? "active" : ""}
                  onClick={() => {
                    setFilter(state);
                    setSelectedId(undefined);
                  }}
                >
                  {stateNames[state]} <span>{counts[state]}</span>
                  {items.some(
                    (item) =>
                      item.state === state &&
                      item.id !== selected?.id &&
                      commentsSince(item, seen[item.id]).length > 0,
                  ) && <i className="inbox-dot" aria-label="New comments" />}
                </button>
              ))}
            </div>
            {shown.length === 0 && (
              <p className="inbox-none">
                {filter === "new"
                  ? "Nothing waiting. New reports from Slack show up here."
                  : `No ${stateNames[filter].toLowerCase()} reports.`}
              </p>
            )}
            {shown.map((item) => {
              const fresh =
                item.id === selected?.id
                  ? 0
                  : commentsSince(item, seen[item.id]).length;
              const files = filesOf(item).length;
              return (
                <button
                  key={item.id}
                  className={
                    "inbox-row " + (selected?.id === item.id ? "selected" : "")
                  }
                  onClick={() => setSelectedId(item.id)}
                >
                  <strong>{item.title}</strong>
                  <span>
                    {item.reporter.name} · <Time at={item.reportedAt} />
                    {files > 0 && ` · ${count(files, "file")}`}
                    {item.replies.length > 0 &&
                      ` · ${count(item.replies.length, "comment")}`}
                    {item.alsoHit.length > 0 && ` · +${item.alsoHit.length}`}
                  </span>
                  {fresh > 0 && (
                    <span className="inbox-fresh">
                      <MessageSquare size={11} /> {count(fresh, "new comment")}
                    </span>
                  )}
                  {item.howBad === "blocked" && (
                    <em className="inbox-chip urgent">Blocked</em>
                  )}
                </button>
              );
            })}
          </section>
          {selected ? (
            <Report
              key={selected.id}
              item={selected}
              project={project}
              inbox={inbox}
              notify={notify}
              onLook={look}
              busy={busy}
              onDefineGoal={() => props.onDefineGoal(selected)}
              onDecline={(reason) =>
                act(() =>
                  window.memcode.decideInboxItem({
                    projectId: project.id,
                    itemId: selected.id,
                    decision: { kind: "declined", reason },
                  }),
                )
              }
              onReopen={() =>
                act(() =>
                  window.memcode.decideInboxItem({
                    projectId: project.id,
                    itemId: selected.id,
                    decision: { kind: "reopened" },
                  }),
                )
              }
            />
          ) : (
            <section className="inbox-report empty" />
          )}
        </div>
      )}
    </div>
  );
}

function SlackChannels({ inbox }: { inbox: ProjectInbox | null }) {
  if (!inbox || inbox.channelsUnavailable) return null;
  if (!inbox.workspaces.length && !inbox.channels.length)
    return (
      <p className="inbox-channels inbox-channels-note">
        Not connected to Slack yet. Connect it in Settings › Integrations, then
        mention @MemCode in any channel.
      </p>
    );
  return (
    <section className="inbox-channels" aria-label="Where reports come from">
      <div className="inbox-channel-list">
        <span className="inbox-channels-note">Reports from Slack</span>
        {inbox.workspaces.map((workspace) => (
          <span key={workspace.teamId} className="inbox-channel">
            {workspace.teamName || "Slack workspace"}
          </span>
        ))}
        {inbox.channels.map((channel) => (
          <span
            key={channel.teamId + channel.channelId}
            className="inbox-channel"
          >
            <Hash size={12} />
            {channel.channelName}
          </span>
        ))}
      </div>
      <span className="inbox-channels-note">
        Manage in Settings › Integrations
      </span>
    </section>
  );
}

function Report(props: {
  item: InboxItem;
  project: Project;
  inbox: ProjectInbox;
  busy: boolean;
  onDefineGoal: () => void;
  onDecline: (reason: string) => void;
  onReopen: () => void;
  /** The report was looked at, with everything written about it until then. */
  onLook: (id: string, at: string) => void;
  notify: (message: string) => void;
}) {
  const { item, onLook } = props;
  // What was new when it was opened stays marked while it is open.
  const [seenBefore] = useState(() => seenReports()[item.id]);
  const fresh = new Set(commentsSince(item, seenBefore));
  const latest = lastActivity(item);
  useEffect(() => onLook(item.id, latest), [item.id, latest, onLook]);
  // The window itself never leaves MemCode: a link opens in the person's browser.
  const openLink = (url: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    window.memcode
      .openInboxLink({ projectId: props.project.id, url })
      .catch((error) => props.notify((error as Error).message));
  };
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const channel = props.inbox.channels.find(
    (known) => known.channelId === item.channel,
  );
  return (
    <section className="inbox-report" aria-label={item.title}>
      <div className="inbox-chips">
        <em className={"inbox-chip " + item.state}>{stateNames[item.state]}</em>
        {item.howBad && (
          <em
            className={
              "inbox-chip " + (item.howBad === "blocked" ? "urgent" : "")
            }
          >
            {howBadNames[item.howBad]}
          </em>
        )}
      </div>
      <h2>{item.title}</h2>
      <p className="inbox-meta">
        <strong>{item.reporter.name}</strong>
        {channel && ` in #${channel.channelName}`}
        {" · "}
        <Time at={item.reportedAt} />
        {item.filedBy && ` · sent by ${item.filedBy.name}`}
        {item.alsoHit.length > 0 &&
          ` · also hit: ${item.alsoHit.map((person) => person.name).join(", ")}`}
        {item.permalink && (
          <>
            {" · "}
            <a href={item.permalink} onClick={openLink(item.permalink)}>
              Open in Slack <ExternalLink size={11} />
            </a>
          </>
        )}
      </p>
      <dl className="inbox-fields">
        <dt>What happened</dt>
        <dd>{item.text || item.title}</dd>
        {item.expected && (
          <>
            <dt>Expected</dt>
            <dd>{item.expected}</dd>
          </>
        )}
        {item.where && (
          <>
            <dt>Where</dt>
            <dd>{item.where}</dd>
          </>
        )}
      </dl>
      {item.files.length > 0 && (
        <>
          <h3>Evidence</h3>
          <InboxEvidence
            files={item.files}
            projectId={props.project.id}
            notify={props.notify}
          />
        </>
      )}
      {item.links.length > 0 && (
        <>
          <h3>Links</h3>
          <ul className="inbox-links">
            {item.links.map((link) => (
              <li key={link}>
                <a href={link} onClick={openLink(link)}>
                  {link}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      {item.replies.length > 0 && (
        <>
          <h3>
            Thread in Slack <span>{count(item.replies.length, "comment")}</span>
          </h3>
          <ol className="inbox-thread">
            {item.replies.map((reply, index) => (
              <Comment
                key={reply.writtenAt + index}
                reply={reply}
                isNew={fresh.has(reply)}
                projectId={props.project.id}
                openLink={openLink}
                notify={props.notify}
              />
            ))}
          </ol>
        </>
      )}
      <div className="inbox-actions">
        {item.state === "new" && !declining && (
          <>
            <button
              className="button primary"
              disabled={props.busy}
              onClick={props.onDefineGoal}
            >
              Define a goal
            </button>
            <button disabled={props.busy} onClick={() => setDeclining(true)}>
              Decline
            </button>
          </>
        )}
        {declining && (
          <form
            className="inbox-decline"
            onSubmit={(event) => {
              event.preventDefault();
              props.onDecline(reason.trim());
              setDeclining(false);
            }}
          >
            <label htmlFor="inbox-decline-reason">Why? (optional)</label>
            <textarea
              id="inbox-decline-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
              rows={2}
            />
            <div>
              <button className="button primary" type="submit">
                Decline
              </button>
              <button type="button" onClick={() => setDeclining(false)}>
                <X size={13} /> Cancel
              </button>
            </div>
          </form>
        )}
        {item.state === "picked_up" && item.goal && (
          <p className="inbox-outcome">
            Became the goal <strong>{item.goal.title || "untitled"}</strong>.
          </p>
        )}
        {item.state === "declined" && (
          <p className="inbox-outcome">
            Declined{item.reason ? `: ${item.reason}` : "."}
          </p>
        )}
        {item.state !== "new" && (
          <button disabled={props.busy} onClick={props.onReopen}>
            <RotateCcw size={13} /> Reopen
          </button>
        )}
      </div>
    </section>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?";

/** One comment someone wrote in the report's Slack thread. */
function Comment({
  reply,
  isNew,
  projectId,
  openLink,
  notify,
}: {
  reply: InboxReply;
  isNew: boolean;
  projectId: string;
  openLink: (url: string) => (event: React.MouseEvent) => void;
  notify: (message: string) => void;
}) {
  return (
    <li className={"inbox-comment " + (isNew ? "new" : "")}>
      <span className="inbox-avatar" aria-hidden="true">
        {initials(reply.author.name)}
      </span>
      <div>
        <header>
          <strong>{reply.author.name}</strong>
          <span>
            {reply.text
              ? "commented"
              : `added ${count(reply.files.length, "file")}`}{" "}
            · <Time at={reply.writtenAt} />
          </span>
          {isNew && <em className="inbox-chip new">New comment</em>}
        </header>
        {reply.text && <p>{reply.text}</p>}
        {reply.files.length > 0 && (
          <InboxEvidence
            files={reply.files}
            projectId={projectId}
            notify={notify}
          />
        )}
        {reply.links.length > 0 && (
          <ul className="inbox-links">
            {reply.links.map((link) => (
              <li key={link}>
                <a href={link} onClick={openLink(link)}>
                  {link}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
