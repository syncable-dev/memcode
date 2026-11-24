import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  FileText,
  Hash,
  Inbox as InboxIcon,
  Link2,
  RotateCcw,
  X,
} from "lucide-react";
import type { Project } from "../shared";
import type {
  InboxFile,
  InboxItem,
  InboxState,
  ProjectInbox,
} from "../inbox";
import { Empty, Spinner, Time } from "./UI";
import "../styles-inbox.css";

interface Props {
  project: Project;
  /** Whether the project is shared through MemSync; only a shared one has an Inbox. */
  shared: boolean;
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
const notKeptNames = {
  too_big: "Too big to copy. Open it in Slack.",
  no_room: "The project's files are full. Open it in Slack.",
  unreadable: "Slack did not hand it over. Open it in Slack.",
} as const;

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Reports people sent from Slack, waiting for someone to pick them up. */
export function Inbox(props: Props) {
  const { project, shared, notify } = props;
  const [inbox, setInbox] = useState<ProjectInbox | null>(null);
  const [problem, setProblem] = useState("");
  const [filter, setFilter] = useState<InboxState>("new");
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!shared) return;
    try {
      setInbox(await window.memcode.projectInbox(project.id));
      setProblem("");
    } catch (error) {
      setProblem((error as Error).message);
    }
  }, [project.id, shared]);

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

  if (!shared)
    return (
      <div className="inbox-page">
        <Empty
          icon={<InboxIcon size={20} />}
          title="Share this project to get reports from Slack"
          description="The Inbox belongs to a shared project. Choose Share at the top of the workspace. Then someone on the project can link a Slack channel, and what people report there lands here."
        />
      </div>
    );

  return (
    <div className="inbox-page">
      <SlackChannels
        inbox={inbox}
        busy={busy}
        onLink={(code) =>
          act(() =>
            window.memcode.linkSlackChannel({ projectId: project.id, code }),
          )
        }
        onUnlink={(teamId, channelId) =>
          act(() =>
            window.memcode.unlinkSlackChannel({
              projectId: project.id,
              teamId,
              channelId,
            }),
          )
        }
      />
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
            {shown.map((item) => (
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
                  {item.files.length > 0 && ` · ${item.files.length} files`}
                  {item.alsoHit.length > 0 && ` · +${item.alsoHit.length}`}
                </span>
                {item.howBad === "blocked" && (
                  <em className="inbox-chip urgent">Blocked</em>
                )}
              </button>
            ))}
          </section>
          {selected ? (
            <Report
              key={selected.id}
              item={selected}
              project={project}
              inbox={inbox}
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

function SlackChannels(props: {
  inbox: ProjectInbox | null;
  busy: boolean;
  onLink: (code: string) => void;
  onUnlink: (teamId: string, channelId: string) => void;
}) {
  const [code, setCode] = useState("");
  const channels = props.inbox?.channels ?? [];
  if (props.inbox?.channelsUnavailable)
    return (
      <p className="inbox-channels-note">
        The sharing service does not take Slack channels yet.
      </p>
    );
  return (
    <section className="inbox-channels" aria-label="Slack channels">
      <div className="inbox-channel-list">
        {channels.length === 0 && (
          <span className="inbox-channels-note">
            No Slack channel reports here yet.
          </span>
        )}
        {channels.map((channel) => (
          <span key={channel.teamId + channel.channelId} className="inbox-channel">
            <Hash size={12} />
            {channel.channelName}
            {channel.teamName && <small>{channel.teamName}</small>}
            <button
              aria-label={`Stop #${channel.channelName} sending reports`}
              title="Stop this channel sending reports"
              disabled={props.busy}
              onClick={() => props.onUnlink(channel.teamId, channel.channelId)}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <form
        className="inbox-link-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim()) props.onLink(code.trim());
          setCode("");
        }}
      >
        <label htmlFor="inbox-link-code">Link a Slack channel</label>
        <input
          id="inbox-link-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Code from /memcode link"
          maxLength={20}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={props.busy || code.trim().length < 8}>
          <Link2 size={13} /> Link
        </button>
      </form>
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
}) {
  const { item } = props;
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const channel = props.inbox.channels.find(
    (known) => known.channelId === item.channel,
  );
  return (
    <section className="inbox-report" aria-label={item.title}>
      <div className="inbox-chips">
        <em className={"inbox-chip " + item.state}>
          {stateNames[item.state]}
        </em>
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
            <a href={item.permalink} target="_blank" rel="noreferrer">
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
          <div className="inbox-files">
            {item.files.map((file, index) => (
              <Evidence
                key={index + file.name}
                file={file}
                projectId={props.project.id}
              />
            ))}
          </div>
        </>
      )}
      {item.links.length > 0 && (
        <>
          <h3>Links</h3>
          <ul className="inbox-links">
            {item.links.map((link) => (
              <li key={link}>
                <a href={link} target="_blank" rel="noreferrer">
                  {link}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      {item.replies.length > 0 && (
        <>
          <h3>In the thread</h3>
          {item.replies.map((reply, index) => (
            <p key={index} className="inbox-reply">
              <strong>{reply.author.name}</strong> {reply.text}
            </p>
          ))}
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

/** One file a report brought: a picture is shown, anything else named. */
function Evidence({ file, projectId }: { file: InboxFile; projectId: string }) {
  const [picture, setPicture] = useState<string>();
  const isPicture = file.mime.startsWith("image/") && !!file.sha256;
  useEffect(() => {
    if (!isPicture || !file.sha256) return;
    let current = true;
    window.memcode
      .inboxFile({ projectId, sha256: file.sha256 })
      .then(({ base64 }) => {
        if (current) setPicture(`data:${file.mime};base64,${base64}`);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [file.mime, file.sha256, isPicture, projectId]);
  return (
    <figure className="inbox-file">
      {picture ? (
        <a href={file.slackUrl} target="_blank" rel="noreferrer">
          <img src={picture} alt={file.name} />
        </a>
      ) : (
        <div className="inbox-file-kind">
          <FileText size={18} />
        </div>
      )}
      <figcaption>
        <a href={file.slackUrl} target="_blank" rel="noreferrer">
          {file.name}
        </a>
        <span>{size(file.size)}</span>
        {file.notKept && <small>{notKeptNames[file.notKept]}</small>}
      </figcaption>
    </figure>
  );
}
