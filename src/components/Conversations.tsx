import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  LayoutGrid,
  List,
  MessageSquare,
  Search,
} from "lucide-react";
import type { WorkItem } from "../shared";
import { harnessNames } from "../shared";
import { presentedTask } from "../team-presentation";
import { stageLabel } from "../domain";
import { Empty, HarnessMark, StageIcon } from "./UI";

function lastMessage(task: WorkItem) {
  return task.messages
    .filter(
      (message) => message.role === "assistant" || message.role === "user",
    )
    .at(-1);
}
function initialMode(): "cards" | "table" {
  try {
    return localStorage.getItem("memcode.conversations.layout") === "table"
      ? "table"
      : "cards";
  } catch {
    return "cards";
  }
}
export function Conversations({
  tasks,
  open,
}: {
  tasks: WorkItem[];
  open: (task: WorkItem) => void;
}) {
  const [mode, setMode] = useState(initialMode),
    [query, setQuery] = useState("");
  const conversations = useMemo(
    () =>
      tasks.map(presentedTask)
        .filter(
          (task) =>
            !task.archivedAt &&
            task.messages.length &&
            `${task.identifier} ${task.title} ${harnessNames[task.harness]} ${lastMessage(task)?.text ?? ""}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          (lastMessage(b)?.at ?? b.updatedAt).localeCompare(
            lastMessage(a)?.at ?? a.updatedAt,
          ),
        ),
    [tasks, query],
  );
  const changeMode = (value: "cards" | "table") => {
    setMode(value);
    try {
      localStorage.setItem("memcode.conversations.layout", value);
    } catch {
      /* The preference is optional. */
    }
  };
  return (
    <section className="conversations-view">
      <div className="conversation-toolbar">
        <div>
          <span className="section-title">
            All conversations <small>{conversations.length}</small>
          </span>
          <div className="segmented-control" aria-label="Conversation layout">
            <button
              aria-label="Conversation cards"
              aria-pressed={mode === "cards"}
              className={mode === "cards" ? "active" : ""}
              onClick={() => changeMode("cards")}
            >
              <LayoutGrid size={13} />
              Cards
            </button>
            <button
              aria-label="Conversation table"
              aria-pressed={mode === "table"}
              className={mode === "table" ? "active" : ""}
              onClick={() => changeMode("table")}
            >
              <List size={14} />
              Table
            </button>
          </div>
        </div>
        <label className="conversation-search">
          <Search size={14} />
          <input
            aria-label="Search conversations"
            placeholder="Find a conversation…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {!conversations.length ? (
        <Empty
          icon={<MessageSquare size={25} />}
          title={
            query ? "No conversations match." : "A place to pick up the thread."
          }
          description={
            query
              ? "Try a work item, title or message."
              : "Your work item conversations will appear here."
          }
        />
      ) : mode === "table" ? (
        <div className="conversation-table-wrap">
          <table className="conversation-table">
            <thead>
              <tr>
                <th>Conversation</th>
                <th>Harness</th>
                <th>Status</th>
                <th>Messages</th>
                <th>Last message</th>
                <th>
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((task) => {
                const last = lastMessage(task),
                  at = last?.at ?? task.updatedAt;
                return (
                  <tr key={task.id}>
                    <td>
                      <button
                        className="conversation-title"
                        onClick={() => open(task)}
                      >
                        <small>{task.identifier}</small>
                        <strong>{task.title}</strong>
                        <span>{last?.text ?? task.description}</span>
                      </button>
                    </td>
                    <td>
                      <span className="conversation-harness">
                        <HarnessMark id={task.harness} small />
                        {harnessNames[task.harness]}
                      </span>
                    </td>
                    <td>
                      <span className="conversation-stage">
                        <StageIcon stage={task.stage} />
                        {stageLabel(task.stage)}
                      </span>
                    </td>
                    <td className="conversation-message-count">
                      {
                        task.messages.filter(
                          (message) =>
                            message.role === "user" ||
                            message.role === "assistant",
                        ).length
                      }
                    </td>
                    <td>
                      <time dateTime={at} title={new Date(at).toLocaleString()}>
                        {task.example
                          ? "Example"
                          : new Date(at).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })}
                      </time>
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`Open conversation ${task.identifier}`}
                        onClick={() => open(task)}
                      >
                        <ArrowUpRight size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="conversations-grid">
          {conversations.map((task) => (
            <button
              className="conversation-card"
              key={task.id}
              onClick={() => open(task)}
            >
              <div>
                <HarnessMark id={task.harness} small />
                <span>{task.identifier}</span>
                <StageIcon stage={task.stage} />
              </div>
              <h3>{task.title}</h3>
              <p>{lastMessage(task)?.text ?? task.description}</p>
              <footer>
                {task.example
                  ? "Example conversation"
                  : new Date(
                      lastMessage(task)?.at ?? task.updatedAt,
                    ).toLocaleDateString()}
                <ArrowUpRight size={14} />
              </footer>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
