import { useState, type DragEvent } from "react";
import { ArrowLeft, ArrowRight, CalendarDays, GitBranch } from "lucide-react";
import type { WorkItem } from "../shared";
import { isActive } from "../domain";
import {
  addDays,
  dateLabel,
  dayAt,
  dayRange,
  daysBetween,
  isWorkday,
} from "../planning/dates";
import { StageIcon } from "./UI";

interface Props {
  tasks: WorkItem[];
  open: (task: WorkItem) => void;
  notify: (message: string) => void;
}
export function WorkCalendar({ tasks, open, notify }: Props) {
  const today = dayAt();
  const [month, setMonth] = useState(today.slice(0, 7) + "-01"),
    [dragged, setDragged] = useState<string | null>(null),
    [over, setOver] = useState<string | null>(null);
  const firstWeekday = (new Date(month + "T00:00:00Z").getUTCDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, i) =>
    addDays(month, i - firstWeekday),
  );
  const undated = tasks.filter((task) => !task.dueDate && !task.startDate);
  const shift = (delta: number) => {
    const date = new Date(month + "T00:00:00Z");
    date.setUTCMonth(date.getUTCMonth() + delta);
    setMonth(date.toISOString().slice(0, 10));
  };
  const begin = (event: DragEvent, task: WorkItem) => {
    if (isActive(task)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData("application/x-memcode-work", task.id);
    event.dataTransfer.effectAllowed = "move";
    setDragged(task.id);
  };
  const reschedule = async (event: DragEvent, day: string) => {
    event.preventDefault();
    const id =
        event.dataTransfer.getData("application/x-memcode-work") || dragged,
      task = tasks.find((item) => item.id === id);
    setDragged(null);
    setOver(null);
    if (!task || isActive(task)) return;
    const delta = task.dueDate ? daysBetween(task.dueDate, day) : 0;
    const patch = task.dueDate
      ? {
          dueDate: day,
          ...(task.startDate
            ? { startDate: addDays(task.startDate, delta) }
            : {}),
        }
      : task.startDate
        ? { startDate: day }
        : { dueDate: day };
    try {
      await window.memcode.updateTask(task.id, patch);
    } catch (error) {
      notify((error as Error).message);
    }
  };
  return (
    <div className="schedule-view calendar-view">
      <div className="schedule-heading">
        <div>
          <CalendarDays size={16} />
          <h2>{dateLabel(month, { month: "long", year: "numeric" })}</h2>
          <span>
            {tasks.filter((task) => task.startDate || task.dueDate).length}{" "}
            scheduled
          </span>
        </div>
        <div>
          <button
            className="button subtle"
            onClick={() => setMonth(today.slice(0, 7) + "-01")}
          >
            Today
          </button>
          <button
            className="icon-button"
            aria-label="Previous month"
            onClick={() => shift(-1)}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Next month"
            onClick={() => shift(1)}
          >
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
      <div className="calendar-scroll">
        <div className="calendar-weekdays">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div
          className="calendar-grid"
          role="list"
          aria-label="Project calendar"
        >
          {cells.map((day) => (
            <div
              role="listitem"
              aria-label={dateLabel(day, {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
              className={
                "calendar-day " +
                (day.slice(0, 7) !== month.slice(0, 7) ? "outside " : "") +
                (day === today ? "today " : "") +
                (!isWorkday(day) ? "weekend " : "") +
                (over === day ? "drop-target" : "")
              }
              key={day}
              onDragOver={(event) => {
                if (dragged) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setOver(day);
                }
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(event) => void reschedule(event, day)}
            >
              <time dateTime={day}>{Number(day.slice(-2))}</time>
              <div className="calendar-day-stories">
                {tasks
                  .filter((task) => (task.dueDate ?? task.startDate) === day)
                  .map((task) => (
                    <button
                      draggable={!isActive(task)}
                      key={task.id}
                      className={"calendar-story " + task.stage}
                      onDragStart={(event) => begin(event, task)}
                      onDragEnd={() => {
                        setDragged(null);
                        setOver(null);
                      }}
                      onClick={() => open(task)}
                      title={`${task.identifier}: ${task.title}${task.dueDate ? " · due " : " · starts "}${dateLabel(day)}`}
                    >
                      <StageIcon stage={task.stage} />
                      <span>
                        <small>{task.identifier}</small>
                        {task.title}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="schedule-legend">
        <span>
          <i />
          Due date, or start date when no due date is set
        </span>
        <span>Drag a task to reschedule · Open a task to edit dates</span>
      </div>
      <Unscheduled
        tasks={undated}
        open={open}
        begin={begin}
        end={() => {
          setDragged(null);
          setOver(null);
        }}
      />
    </div>
  );
}

export function WorkTimeline({ tasks, open }: Props) {
  const today = dayAt(),
    [start, setStart] = useState(addDays(today, -7));
  const days = dayRange(start, addDays(start, 27));
  const dated = tasks.filter((task) => task.startDate || task.dueDate),
    undated = tasks.filter((task) => !task.startDate && !task.dueDate);
  return (
    <div className="schedule-view timeline-view">
      <div className="schedule-heading">
        <div>
          <GitBranch size={16} />
          <h2>
            {dateLabel(start)} — {dateLabel(days.at(-1)!)}
          </h2>
          <span>28-day window</span>
        </div>
        <div>
          <button
            className="button subtle"
            onClick={() => setStart(addDays(today, -7))}
          >
            Today
          </button>
          <button
            className="icon-button"
            aria-label="Earlier timeline"
            onClick={() => setStart(addDays(start, -14))}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Later timeline"
            onClick={() => setStart(addDays(start, 14))}
          >
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-table">
          <div className="timeline-head">
            <span>
              Scheduled work <small>{dated.length}</small>
            </span>
            <div>
              {days.map((day) => (
                <span
                  key={day}
                  className={
                    (day === today ? "today " : "") +
                    (!isWorkday(day) ? "weekend" : "")
                  }
                  title={dateLabel(day, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  })}
                >
                  {dateLabel(day, { weekday: "narrow" })}
                  <strong>{Number(day.slice(-2))}</strong>
                </span>
              ))}
            </div>
          </div>
          {dated.map((task) => {
            const from = task.startDate ?? task.dueDate!,
              to = task.dueDate ?? task.startDate!,
              left = Math.max(0, daysBetween(start, from)),
              right = Math.min(28, daysBetween(start, to) + 1),
              visible = right > left && left < 28;
            return (
              <div className="timeline-row" key={task.id}>
                <button className="timeline-task" onClick={() => open(task)}>
                  <StageIcon stage={task.stage} />
                  <span>
                    <small>{task.identifier}</small>
                    {task.title}
                  </span>
                </button>
                <div className="timeline-track">
                  <div className="timeline-grid-days" aria-hidden="true">
                    {days.map((day) => (
                      <i
                        key={day}
                        className={
                          (day === today ? "today " : "") +
                          (!isWorkday(day) ? "weekend" : "")
                        }
                      />
                    ))}
                  </div>
                  {visible ? (
                    <button
                      className={"timeline-bar " + task.stage}
                      style={{
                        left: `${(left / 28) * 100}%`,
                        width: `${(Math.max(1, right - left) / 28) * 100}%`,
                      }}
                      aria-label={`${task.identifier}: ${task.title}, ${dateLabel(from)} to ${dateLabel(to)}`}
                      title={`${task.title}: ${dateLabel(from)} – ${dateLabel(to)}`}
                      onClick={() => open(task)}
                    >
                      {task.title}
                    </button>
                  ) : (
                    <span className="outside-timeline">
                      {to < start ? "Before this window" : "After this window"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {!dated.length && (
            <div className="schedule-empty">
              <CalendarDays size={25} />
              <strong>Your schedule starts with a date.</strong>
              <p>
                Add a start or due date to a task to see it on the timeline.
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="schedule-legend">
        <span>
          <i />
          Planned dates · bars show start through due date
        </span>
        <span>Open a task to update its schedule</span>
      </div>
      <Unscheduled tasks={undated} open={open} />
    </div>
  );
}

function Unscheduled({
  tasks,
  open,
  begin,
  end,
}: {
  tasks: WorkItem[];
  open: (task: WorkItem) => void;
  begin?: (event: DragEvent, task: WorkItem) => void;
  end?: () => void;
}) {
  const [expanded, setExpanded] = useState(false),
    shown = expanded ? tasks : tasks.slice(0, 8);
  return (
    <section className="unscheduled-work">
      <header>
        <span>
          Without dates <small>{tasks.length}</small>
        </span>
        <p>
          {begin
            ? "Drag a task onto the calendar, or open it to set dates."
            : "Open a task to add its start and due dates."}
        </p>
      </header>
      {shown.length > 0 ? (
        <div>
          {shown.map((task) => (
            <button
              draggable={!!begin && !isActive(task)}
              key={task.id}
              onDragStart={(event) => begin?.(event, task)}
              onDragEnd={end}
              onClick={() => open(task)}
            >
              <StageIcon stage={task.stage} />
              <small>{task.identifier}</small>
              <span>{task.title}</span>
            </button>
          ))}
          {tasks.length > 8 && (
            <button
              className="unscheduled-more"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show fewer" : `Show ${tasks.length - 8} more`}
            </button>
          )}
        </div>
      ) : (
        <p className="unscheduled-all-set">Every visible task has a date.</p>
      )}
    </section>
  );
}
