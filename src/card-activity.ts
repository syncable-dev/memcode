import { isActive } from "./domain";
import type { WorkItem } from "./shared";

/** The one line a board card shows about its running worker. */
export interface CardActivity {
  label: string;
}

/** Longer free text is a worker thinking out loud; a card shows one steady word instead. */
const summaryLength = 72;

export function cardActivity(task: WorkItem): CardActivity | undefined {
  if (!isActive(task)) return undefined;
  const activity = task.run.activity;
  if (!activity) return { label: "Starting" };
  if (activity.phase === "waiting_for_user") return undefined;
  const label = activity.label.replace(/\s+/g, " ").trim();
  if (!label) return { label: "Working" };
  if (activity.phase !== "tool" && label.length > summaryLength) return { label: "Thinking" };
  return { label };
}

type Schedule = (run: () => void, delay: number) => () => void;

const browserSchedule: Schedule = (run, delay) => {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
};

interface Shown {
  value?: CardActivity;
  at: number;
}

/**
 * Keeps each card's activity line outside the board's render: a card's line changes at most
 * once per interval (the newest wins), and only that card's subscribers hear about it.
 */
export class CardActivityFeed {
  private readonly interval: number;
  private readonly clock: () => number;
  private readonly schedule: Schedule;
  private shown = new Map<string, Shown>();
  private waiting = new Map<string, { value: CardActivity; cancel: () => void }>();
  private listeners = new Map<string, Set<() => void>>();

  constructor(options: { interval?: number; clock?: () => number; schedule?: Schedule } = {}) {
    this.interval = options.interval ?? 2000;
    this.clock = options.clock ?? Date.now;
    this.schedule = options.schedule ?? browserSchedule;
  }

  get(id: string): CardActivity | undefined {
    return this.shown.get(id)?.value;
  }

  subscribe(id: string, listener: () => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  publish(tasks: WorkItem[]): void {
    const present = new Set<string>();
    for (const task of tasks) {
      present.add(task.id);
      this.offer(task.id, cardActivity(task));
    }
    for (const id of [...this.shown.keys()])
      if (!present.has(id)) this.forget(id);
  }

  private offer(id: string, value: CardActivity | undefined) {
    const current = this.shown.get(id);
    if (current?.value?.label === value?.label) return this.cancelWaiting(id);
    const now = this.clock();
    const settled = !current?.value || !value || now - current.at >= this.interval;
    if (settled) return this.show(id, value, now);
    const waiting = this.waiting.get(id);
    if (waiting) {
      waiting.value = value;
      return;
    }
    const cancel = this.schedule(() => {
      const latest = this.waiting.get(id);
      this.waiting.delete(id);
      if (latest) this.show(id, latest.value, this.clock());
    }, current.at + this.interval - now);
    this.waiting.set(id, { value, cancel });
  }

  private show(id: string, value: CardActivity | undefined, at: number) {
    this.cancelWaiting(id);
    if (value) this.shown.set(id, { value, at });
    else this.shown.delete(id);
    for (const listener of this.listeners.get(id) ?? []) listener();
  }

  private cancelWaiting(id: string) {
    this.waiting.get(id)?.cancel();
    this.waiting.delete(id);
  }

  private forget(id: string) {
    this.cancelWaiting(id);
    this.shown.delete(id);
  }
}

/** The app's single feed; App publishes tasks into it and cards read their own line. */
export const cardActivityFeed = new CardActivityFeed();
