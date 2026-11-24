import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, Hash, Search } from "lucide-react";
import type { AppState, Project } from "../shared";
import type { ProjectInbox } from "../inbox";
import { isSharedHere } from "./ShareProject";
import { Spinner } from "./UI";
import "../styles-integrations.css";

/** How long to keep looking for a new connection after Slack opens, and how often. */
const WAIT_FOR_SLACK_MS = 3 * 60_000;
const LOOK_EVERY_MS = 4_000;

/** What every integration's page and row get to work with. */
interface IntegrationContext {
  project: Project | undefined;
  shared: boolean;
  /** The project's Inbox and its connections; `null` while loading. */
  inbox: ProjectInbox | null;
  reload: () => Promise<ProjectInbox | null>;
  setInbox: (inbox: ProjectInbox) => void;
  notify: (message: string) => void;
}

/**
 * One integration in Settings › Integrations. Adding another means adding one of these:
 * a row in the list, and a page of its own.
 */
interface Integration {
  id: string;
  name: string;
  /** One line under the name in the list. */
  summary: string;
  /** Extra words the search matches. */
  keywords: string[];
  mark: React.ReactNode;
  connected: (context: IntegrationContext) => boolean;
  Page: (props: { context: IntegrationContext }) => React.ReactElement;
}

const integrations: Integration[] = [
  {
    id: "slack",
    name: "Slack",
    summary: "Report problems to the Inbox by mentioning @MemCode in any channel.",
    keywords: ["chat", "messages", "reports", "inbox", "bot"],
    mark: <Hash size={18} />,
    connected: ({ inbox }) => !!inbox?.workspaces.length,
    Page: SlackPage,
  },
];

type Filter = "all" | "connected";

/**
 * Settings › Integrations: the tools a team works in, connected to the project. A list to
 * search and filter, and a page for each.
 */
export function Integrations({
  state,
  notify,
}: {
  state: AppState;
  notify: (message: string) => void;
}) {
  const project = state.projects.find((item) => item.id === state.activeProjectId);
  const shared = !!project && isSharedHere(state, project.id);
  const [inbox, setInbox] = useState<ProjectInbox | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const reload = useCallback(async () => {
    if (!project || !shared) return null;
    try {
      const read = await window.memcode.projectInbox(project.id);
      setInbox(read);
      return read;
    } catch (error) {
      notify((error as Error).message);
      return null;
    }
  }, [project?.id, shared]);

  useEffect(() => {
    setInbox(null);
    void reload();
  }, [reload]);

  const context: IntegrationContext = { project, shared, inbox, reload, setInbox, notify };
  const open = integrations.find((integration) => integration.id === openId);
  if (open)
    return (
      <div className="integrations">
        <button type="button" className="integration-back" onClick={() => setOpenId(null)}>
          <ArrowLeft size={14} /> Integrations
        </button>
        <open.Page context={context} />
      </div>
    );

  const words = query.trim().toLowerCase();
  const shown = integrations.filter(
    (integration) =>
      (filter === "all" || integration.connected(context)) &&
      (!words ||
        [integration.name, integration.summary, ...integration.keywords].some((text) =>
          text.toLowerCase().includes(words),
        )),
  );
  const connectedCount = integrations.filter((integration) =>
    integration.connected(context),
  ).length;

  return (
    <div className="integrations">
      <p className="integrations-intro">
        Connect the tools your team works in to{" "}
        <strong>{project?.name ?? "this project"}</strong>.
      </p>
      <div className="integrations-toolbar">
        <label className="integrations-search">
          <Search size={14} />
          <input
            id="integrations-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search integrations"
            aria-label="Search integrations"
          />
        </label>
        <div className="integrations-filter" role="tablist" aria-label="Show">
          {(
            [
              ["all", `All ${integrations.length}`],
              ["connected", `Connected ${connectedCount}`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              className={filter === id ? "active" : ""}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="integrations-list">
        {shown.map((integration) => {
          const on = integration.connected(context);
          return (
            <button
              key={integration.id}
              type="button"
              className="integration-row"
              onClick={() => setOpenId(integration.id)}
            >
              <span className={"integration-mark " + integration.id}>{integration.mark}</span>
              <span className="integration-row-text">
                <strong>{integration.name}</strong>
                <span>{integration.summary}</span>
              </span>
              <em className={"integration-state " + (on ? "on" : "")}>
                {on ? "Connected" : "Connect"}
              </em>
              <ChevronRight size={15} className="integration-chevron" />
            </button>
          );
        })}
        {shown.length === 0 && (
          <p className="integration-note">
            {words
              ? `No integration matches “${query.trim()}”.`
              : "Nothing is connected yet."}
          </p>
        )}
      </div>
    </div>
  );
}

/** Slack's page: connect workspaces, see where reports come from, and how people report. */
function SlackPage({ context }: { context: IntegrationContext }) {
  const { project, shared, inbox, reload, setInbox, notify } = context;
  const [busy, setBusy] = useState(false);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);

  // After Slack opens in the browser, look for the new connection until it appears.
  useEffect(() => {
    if (waitingSince === null) return;
    const before = inbox?.workspaces.length ?? 0;
    const timer = window.setInterval(async () => {
      const read = await reload();
      const connected = (read?.workspaces.length ?? 0) > before;
      if (connected || Date.now() - waitingSince > WAIT_FOR_SLACK_MS) {
        setWaitingSince(null);
        if (connected) notify("Slack is connected. Mention @MemCode in any channel.");
      }
    }, LOOK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [waitingSince]);

  const addToSlack = async () => {
    if (!project) return;
    setBusy(true);
    try {
      await window.memcode.addToSlack(project.id);
      setWaitingSince(Date.now());
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (teamId: string) => {
    if (!project) return;
    setBusy(true);
    try {
      setInbox(await window.memcode.disconnectSlack({ projectId: project.id, teamId }));
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const workspaces = inbox?.workspaces ?? [];
  const channels = inbox?.channels ?? [];
  const canConnect = shared && !!inbox && !inbox.channelsUnavailable;

  return (
    <article className="integration-page" aria-label="Slack">
      <header className="integration-page-header">
        <span className="integration-mark slack large">
          <Hash size={22} />
        </span>
        <div>
          <h3>Slack</h3>
          <p>
            Your team reports problems where they already talk. Each report lands in{" "}
            <strong>{project?.name ?? "this project"}</strong>’s Inbox with its
            screenshots, files and links, and MemCode answers in the thread.
          </p>
        </div>
        {canConnect && (
          <button
            type="button"
            className={"button " + (workspaces.length ? "secondary" : "primary")}
            disabled={busy || waitingSince !== null}
            onClick={addToSlack}
          >
            {workspaces.length ? "Add another workspace" : "Add to Slack"}
          </button>
        )}
      </header>

      {waitingSince !== null && (
        <p className="integration-note">
          <Spinner /> Slack opened in your browser. Choose Allow there, and this updates by
          itself.
        </p>
      )}
      {!shared && (
        <p className="integration-note">
          Share this project first. Slack reports go to a shared project’s Inbox, so your
          team sees them too.
        </p>
      )}
      {shared && !inbox && (
        <p className="integration-note">
          <Spinner /> Checking the connection
        </p>
      )}
      {shared && inbox?.channelsUnavailable && (
        <p className="integration-note">The sharing service does not offer Slack yet.</p>
      )}

      <section>
        <h4>Workspaces</h4>
        {workspaces.length === 0 && (
          <p className="integration-note">Not connected to a Slack workspace yet.</p>
        )}
        {workspaces.map((workspace) => {
          const used = channels.filter((channel) => channel.teamId === workspace.teamId);
          return (
            <div key={workspace.teamId} className="integration-connection">
              <div>
                <strong>{workspace.teamName || "Slack workspace"}</strong>
                <span>
                  {used.length
                    ? `Reports so far from ${used.map((channel) => "#" + channel.channelName).join(", ")}`
                    : "No reports yet. Mention @MemCode in any channel."}
                </span>
              </div>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => disconnect(workspace.teamId)}
              >
                Disconnect
              </button>
            </div>
          );
        })}
      </section>

      <section>
        <h4>How your team reports</h4>
        <ul className="integration-how">
          <li>
            <strong>Mention @MemCode</strong> in any message. It goes to the Inbox as
            written, with its files. In a thread, the thread’s first message is sent. The
            first time in a channel, Slack offers to add MemCode to it: choose Add.
          </li>
          <li>
            <strong>Send to MemCode</strong> in a message’s menu opens a short form: what
            happened, what you expected, where, how bad, and more files.
          </li>
          <li>
            When a workspace is connected to several projects, MemCode asks once per
            channel which one, and remembers.
          </li>
        </ul>
      </section>
    </article>
  );
}
