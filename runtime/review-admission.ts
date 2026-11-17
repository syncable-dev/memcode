export type ReviewWait = "writers" | "epic" | "capacity";

interface ReviewJob {
  id: string;
  taskId: string;
  key: string;
  ready(): boolean;
  waiting(reason: ReviewWait): void;
  run(): Promise<void>;
}
interface PendingJob extends ReviewJob {
  resolve(): void;
  reject(error: unknown): void;
  reason?: ReviewWait;
}

/** One review per epic, with a shared local budget. Blocked epics do not stall others. */
export class ReviewAdmission {
  private pending: PendingJob[] = [];
  private running = new Map<string, PendingJob>();
  private timer?: ReturnType<typeof setTimeout>;
  private scheduled = false;
  private closed = false;

  constructor(
    private readonly capacity: () => number,
    private readonly implementations: () => number,
    private readonly released: () => void = () => {},
  ) {}

  occupied(exceptTask?: (taskId: string) => boolean): number {
    return [...this.running.values()].filter((job) => !exceptTask?.(job.taskId))
      .length;
  }
  isRunning(id: string): boolean {
    return this.running.has(id);
  }
  busy(key: string): boolean {
    return [...this.running.values()].some((job) => job.key === key);
  }
  submit(job: ReviewJob): Promise<void> {
    if (this.closed)
      return Promise.reject(Error("The review queue is closing."));
    const work = new Promise<void>((resolve, reject) => {
      this.pending.push({ ...job, resolve, reject });
    });
    this.notify();
    return work;
  }
  cancel(id: string): void {
    const index = this.pending.findIndex((job) => job.id === id);
    if (index >= 0) this.pending.splice(index, 1)[0].resolve();
    this.notify();
  }
  notify(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }
  private pump(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    const keys = new Set([...this.running.values()].map((job) => job.key));
    for (let index = 0; index < this.pending.length;) {
      const job = this.pending[index];
      let reason: ReviewWait | undefined;
      try {
        reason = !job.ready()
          ? "writers"
          : keys.has(job.key)
            ? "epic"
            : this.implementations() + this.running.size >=
                Math.max(1, this.capacity())
              ? "capacity"
              : undefined;
      } catch (error) {
        this.pending.splice(index, 1);
        job.reject(error);
        continue;
      }
      // Preserve FIFO inside an epic even when its oldest request is blocked.
      keys.add(job.key);
      if (reason) {
        if (job.reason !== reason) {
          job.reason = reason;
          job.waiting(reason);
        }
        index++;
        continue;
      }
      this.pending.splice(index, 1);
      this.running.set(job.id, job);
      void Promise.resolve()
        .then(() => job.run())
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running.delete(job.id);
          this.released();
          this.notify();
        });
    }
    if (this.pending.length) {
      // Worker state and settings can change outside the review service.
      this.timer = setTimeout(() => this.pump(), 100);
      this.timer.unref?.();
    }
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const job of this.pending.splice(0)) job.resolve();
  }
}
