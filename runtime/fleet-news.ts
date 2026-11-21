/** Something a worker should hear about at its next call: a peer's change, or a decision. */
export interface FleetNewsItem {
  type: "peer_starting" | "peer_changed" | "judge" | "decided";
  at: string;
  /** The update as one plain sentence; the other fields carry the same facts for tools. */
  message: string;
  [detail: string]: unknown;
}

/** A busy hot symbol must not bury a worker: only the latest updates are kept. */
const keptPerWorker = 20;

/**
 * Updates waiting for each worker. A worker cannot be interrupted mid-thought, so it hears
 * them on its next call to MemCode; a worker that is waiting is woken at once.
 */
export class FleetNews {
  private waiting = new Map<string, FleetNewsItem[]>();
  private listeners = new Map<string, Set<() => void>>();

  tell(taskId: string, item: FleetNewsItem) {
    const queue = this.waiting.get(taskId) ?? [];
    queue.push(item);
    this.waiting.set(taskId, queue.slice(-keptPerWorker));
    for (const wake of this.listeners.get(taskId) ?? []) wake();
  }
  /** Hands over what is waiting; each update is delivered once. */
  take(taskId: string): FleetNewsItem[] {
    const queue = this.waiting.get(taskId) ?? [];
    this.waiting.delete(taskId);
    return queue;
  }
  /** Resolves when something arrives for the worker, the time is up, or it was cancelled. */
  async arrival(taskId: string, withinMs: number, signal?: AbortSignal) {
    if (this.waiting.get(taskId)?.length || withinMs <= 0 || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const listeners = this.listeners.get(taskId) ?? new Set();
      this.listeners.set(taskId, listeners);
      const done = () => {
        clearTimeout(timer);
        listeners.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, withinMs);
      listeners.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  forget(taskId: string) {
    this.waiting.delete(taskId);
  }
}
