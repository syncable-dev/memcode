/**
 * Coordinates DeepSeek Harness setup changes with the separate dsh processes
 * that read the profile. Setup does not start while a dsh reviewer or planner
 * runs, and none of them starts while setup may be rewriting the profile.
 * Shutdown waits for a running setup so its verification or rollback finishes.
 */
export class DshSetupGate {
  private current: { operation: string; mutates: boolean; done: Promise<void> } | null = null;
  private readers = 0;
  private closed = false;

  /** The setup operation in progress, if any. */
  get operation(): string | null {
    return this.current?.operation ?? null;
  }

  /** Whether the running operation may rewrite the profile or the CLI. */
  get mutating(): boolean {
    return this.current?.mutates === true;
  }

  /**
   * Admit one dsh process that reads the profile. Call the returned function
   * once the process has exited.
   */
  admit(activity = "review"): () => void {
    if (this.mutating)
      throw new Error(
        `Wait for DeepSeek Harness setup to finish before starting a DeepSeek Harness ${activity}.`,
      );
    this.readers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.readers--;
    };
  }

  /**
   * Run one setup operation. Operations never overlap; one that `mutates`
   * also waits for no dsh reader and keeps new readers out until it settles.
   */
  async run<T>(
    operation: string,
    fn: () => Promise<T>,
    { mutates = true }: { mutates?: boolean } = {},
  ): Promise<T> {
    if (this.closed) throw new Error("MemCode is shutting down. Try again after it restarts.");
    if (this.current)
      throw new Error(
        "Another DeepSeek Harness setup operation is already in progress. Wait for it to finish.",
      );
    if (mutates && this.readers > 0)
      throw new Error(
        "Wait for the DeepSeek Harness review or plan in progress to finish before changing its setup.",
      );
    let settle!: () => void;
    this.current = { operation, mutates, done: new Promise<void>((resolve) => (settle = resolve)) };
    try {
      return await fn();
    } finally {
      this.current = null;
      settle();
    }
  }

  /** Refuse new setup operations and wait for a running one to finish. */
  async close(): Promise<void> {
    this.closed = true;
    while (this.current) await this.current.done;
  }
}
