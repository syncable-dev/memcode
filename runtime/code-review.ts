import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppState, Project, WorkItem } from "../src/shared";
import { isActive } from "../src/domain";
import { codeReviewPhases, type StoryReviewRun } from "../src/code-review";
import {
  captureStoryReview,
  type StoryReviewCapture,
} from "./code-review-snapshot";
import { analyzeStoryReview, type ReviewEngine } from "./code-review-analysis";
import { checkSourceBinding } from "./verification";
import { replaceWorkspace } from "./persistence";
import type { ReadonlyReviewAgent } from "./review-agent";

interface ReviewHooks {
  queueFixes(taskId: string, text: string): Promise<void>;
  accept(taskId: string): Promise<void>;
  reviewProject?(task: WorkItem, project: Project): Project;
  /** Actual connected engine version; absence is displayed as not reported. */
  engineVersion?(project: Project): string;
  reviewer?: ReadonlyReviewAgent;
  settled?(task: WorkItem, project: Project): Promise<void>;
}
interface ReviewDependencies {
  capture?: typeof captureStoryReview;
  sourceBinding?: typeof checkSourceBinding;
}
interface SavedReview {
  run: StoryReviewRun;
  sourceBinding: string | null;
  changesRevision?: string;
  queued: boolean;
  patch?: string;
  patchTruncated?: boolean;
  reviewerReads?: Array<{
    at: string;
    model: string;
    harness: WorkItem["harness"];
    method: string;
    sha256: string;
  }>;
}
const timestamp = () => new Date().toISOString();
const terminal = (run: StoryReviewRun) =>
  !["queued", "running"].includes(run.state);
const clone = <T>(value: T): T => structuredClone(value);
class ReviewStopped extends Error {}

/** Review is a separate, read-only process. It never inherits worker shell permissions. */
export class CodeReviewManager {
  private saved = new Map<string, SavedReview>();
  private loading = new Map<string, Promise<SavedReview | null>>();
  private operations = new Map<string, Promise<unknown>>();
  private projectQueues = new Map<string, Promise<void>>();
  private active = new Set<string>();
  private reviewerControllers = new Map<string, AbortController>();
  private reviewerWork = new Map<string, Promise<void>>();
  private closed = false;
  private capture: typeof captureStoryReview;
  private sourceBinding: typeof checkSourceBinding;

  constructor(
    private readonly dataDir: string,
    private readonly state: () => AppState,
    private readonly engine: ReviewEngine,
    private readonly changed: () => unknown | Promise<unknown>,
    private readonly hooks: ReviewHooks,
    dependencies: ReviewDependencies = {},
  ) {
    this.capture = dependencies.capture ?? captureStoryReview;
    this.sourceBinding = dependencies.sourceBinding ?? checkSourceBinding;
  }

  private task(id: string): WorkItem {
    const task = this.state().tasks.find(
      (item) => item.id === id && !item.archivedAt,
    );
    if (!task) throw Error("This story is no longer available.");
    return task;
  }
  private project(task: WorkItem): Project {
    const project = this.state().projects.find(
      (item) => item.id === task.projectId,
    );
    if (!project) throw Error("This story's project is no longer available.");
    return (
      this.hooks.reviewProject?.(task, project) ?? {
        ...project,
        path: task.run.workspace ?? project.path,
        branch: task.run.branch ?? project.branch,
      }
    );
  }
  private directory(taskId: string): string {
    return join(
      this.dataDir,
      "code-reviews",
      createHash("sha256").update(taskId).digest("hex"),
    );
  }
  private exclusive<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.operations.get(taskId) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(operation);
    this.operations.set(taskId, pending);
    void pending
      .finally(() => {
        if (this.operations.get(taskId) === pending)
          this.operations.delete(taskId);
      })
      .catch(() => {});
    return pending;
  }
  private async persist(saved: SavedReview): Promise<void> {
    saved.run.updatedAt = timestamp();
    const directory = this.directory(saved.run.taskId),
      path = join(directory, saved.run.id + ".json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path + ".next", JSON.stringify(saved), { mode: 0o600 });
    await replaceWorkspace(path + ".next", path);
    await writeFile(
      join(directory, "latest.json.next"),
      JSON.stringify({ runId: saved.run.id }),
      { mode: 0o600 },
    );
    await replaceWorkspace(
      join(directory, "latest.json.next"),
      join(directory, "latest.json"),
    );
    const task = this.state().tasks.find(
      (item) => item.id === saved.run.taskId,
    );
    if (task)
      task.codeReview = {
        runId: saved.run.id,
        state: saved.run.state,
        outcome: saved.run.outcome,
        updatedAt: saved.run.updatedAt,
        findingCount: saved.run.findings.length,
        phase: saved.run.phases.find((phase) => phase.state === "running")?.id,
      };
    await this.changed();
  }
  private async load(taskId: string): Promise<SavedReview | null> {
    const cached = this.saved.get(taskId);
    if (cached) return cached;
    const existing = this.loading.get(taskId);
    if (existing) return existing;
    const pending = (async () => {
      try {
        const directory = this.directory(taskId);
        const pointer = JSON.parse(
          await readFile(join(directory, "latest.json"), "utf8"),
        );
        if (!/^[a-f0-9-]{36}$/.test(pointer.runId ?? ""))
          throw Error("The saved review reference is invalid.");
        const path = join(directory, pointer.runId + ".json");
        if ((await stat(path)).size > 4_000_000)
          throw Error("The saved review exceeds its read limit.");
        const value = JSON.parse(await readFile(path, "utf8")) as SavedReview;
        if (
          value.run?.version !== 1 ||
          value.run.taskId !== taskId ||
          !Array.isArray(value.run.findings) ||
          !Array.isArray(value.run.phases) ||
          !Array.isArray(value.run.messages)
        )
          throw Error(
            "This saved review is not recognized. Start a new review; the saved file was preserved.",
          );
        const interrupted = !terminal(value.run);
        const interruptedReviewer = value.run.reviewer?.state === "running";
        if (interrupted) {
          value.run.state = "cancelled";
          value.run.note =
            "The app stopped before this review completed. Run a fresh review to continue.";
          value.run.completedAt = timestamp();
          value.queued = false;
        }
        if (interruptedReviewer)
          value.run.reviewer = {
            ...value.run.reviewer!,
            state: "unavailable",
            note: "The app stopped before this reviewer answer completed. Ask again to continue.",
          };
        this.saved.set(taskId, value);
        if (interrupted || interruptedReviewer) await this.persist(value);
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    })();
    this.loading.set(taskId, pending);
    try {
      return await pending;
    } finally {
      this.loading.delete(taskId);
    }
  }
  private async current(taskId: string, runId?: string): Promise<SavedReview> {
    this.task(taskId);
    const saved = await this.load(taskId);
    if (!saved || (runId && runId !== saved.run.id))
      throw Error("This review is no longer the current review for the story.");
    return saved;
  }
  private async stale(saved: SavedReview): Promise<boolean> {
    if (
      !terminal(saved.run) ||
      saved.run.state === "stale" ||
      saved.run.state === "cancelled" ||
      saved.run.state === "failed"
    )
      return saved.run.state === "stale";
    const task = this.task(saved.run.taskId),
      project = this.project(task);
    const source = project.path
      ? await this.sourceBinding(project.path).catch(() => null)
      : null;
    const changed =
      isActive(task) ||
      saved.changesRevision !== task.changesRevision ||
      project.branch !== saved.run.snapshot.branch ||
      !source ||
      !saved.sourceBinding ||
      source !== saved.sourceBinding;
    if (changed) {
      saved.run.state = "stale";
      saved.run.coverage.complete = false;
      saved.run.note =
        "The source, story contribution or execution branch changed. Run a fresh review before acceptance.";
      await this.persist(saved);
    }
    return changed;
  }

  async get(taskId: string): Promise<StoryReviewRun | null> {
    return this.exclusive(taskId, async () => {
      this.task(taskId);
      const saved = await this.load(taskId);
      if (!saved) return null;
      await this.stale(saved);
      return clone(saved.run);
    });
  }
  async start(taskId: string): Promise<StoryReviewRun> {
    return this.exclusive(taskId, async () => {
      if (this.closed) throw Error("The review service is closing.");
      const task = this.task(taskId),
        project = this.project(task);
      if (isActive(task))
        throw Error(
          "Finish this story's worker pass before reviewing its contribution.",
        );
      if (task.example || project.example || !project.path)
        throw Error("Connect a real local project to review its code.");
      const previous = await this.load(taskId);
      if (previous && !terminal(previous.run)) return clone(previous.run);
      if (previous && this.reviewerControllers.has(previous.run.id))
        throw Error(
          "Wait for the reviewer's answer, or stop it before starting a new review.",
        );
      const at = timestamp(),
        id = randomUUID();
      const saved: SavedReview = {
        queued: true,
        sourceBinding: null,
        changesRevision: task.changesRevision,
        run: {
          version: 1,
          id,
          taskId,
          implementationRunIds: [],
          createdAt: at,
          updatedAt: at,
          state: "queued",
          phases: codeReviewPhases.map(({ id }) => ({ id, state: "queued" })),
          snapshot: {
            id: "",
            patchHash: "",
            journalRevision: "",
            branch: project.branch,
            commit: null,
            sourceRevision: null,
            graphRevision: null,
            files: [],
            additions: 0,
            deletions: 0,
          },
          engine: {
            version: this.hooks.engineVersion?.(project) || "Not reported",
          },
          coverage: { complete: false, limitations: [] },
          findings: [],
          metrics: [],
          impact: {
            symbols: null,
            files: null,
            processes: null,
            complete: false,
          },
          checks: [],
          messages: [
            {
              id: randomUUID(),
              role: "system",
              at,
              text: this.hooks.reviewer
                ? "Memtrace checks this story's recorded changes locally, then a separate read-only model reviewer explains the captured patch and measurements. The implementation worker is not running in this review conversation."
                : "Memtrace review checks this story's recorded changes locally. This is a deterministic review; no model or implementation worker is running in this conversation.",
            },
          ],
        },
      };
      this.saved.set(taskId, saved);
      await this.persist(saved);
      const key = project.id,
        prior = this.projectQueues.get(key) ?? Promise.resolve();
      const pending = prior
        .catch(() => {})
        .then(() => this.execute(saved))
        .catch(async (error) => {
          if (saved.run.state === "cancelled" || error instanceof ReviewStopped)
            return;
          await this.exclusive(taskId, async () => {
            saved.run.state = "failed";
            saved.run.outcome = "incomplete";
            saved.run.completedAt = timestamp();
            saved.run.note = (error as Error).message;
            for (const phase of saved.run.phases)
              if (phase.state === "running") phase.state = "failed";
            saved.run.coverage.complete = false;
            await this.persist(saved);
          });
        })
        .finally(async () => {
          const task = this.state().tasks.find((item) => item.id === taskId);
          if (task) await this.hooks.settled?.(task, this.project(task));
        });
      this.projectQueues.set(key, pending);
      void pending
        .finally(() => {
          if (this.projectQueues.get(key) === pending)
            this.projectQueues.delete(key);
        })
        .catch((error) =>
          console.error("Could not persist story review:", error),
        );
      return clone(saved.run);
    });
  }
  private async execute(saved: SavedReview): Promise<void> {
    const taskId = saved.run.taskId,
      run = saved.run;
    const assertActive = () => {
      if (
        this.closed ||
        run.state === "cancelled" ||
        this.saved.get(taskId) !== saved
      )
        throw new ReviewStopped();
      const task = this.task(taskId);
      if (isActive(task) || task.changesRevision !== saved.changesRevision)
        throw Error(
          "The story began changing while review was running. Wait for its worker and run a fresh review.",
        );
    };
    assertActive();
    this.active.add(run.id);
    saved.queued = false;
    const phase = async (
      id: StoryReviewRun["phases"][number]["id"],
      note: string,
    ) => {
      await this.exclusive(taskId, async () => {
        assertActive();
        run.state = "running";
        for (const item of run.phases) {
          if (item.state === "running") item.state = "complete";
          if (item.id === id) {
            item.state = "running";
            item.note = note;
          }
        }
        await this.persist(saved);
      });
    };
    try {
      const task = this.task(taskId),
        project = this.project(task);
      await phase(
        "capture",
        "Capturing only this story's attributed checkpoints.",
      );
      const capture = await this.capture(clone(task));
      assertActive();
      saved.sourceBinding = capture.sourceBinding;
      run.snapshot = capture.snapshot;
      saved.patch = capture.patch.slice(0, 60000);
      saved.patchTruncated = saved.patch.length < capture.patch.length;
      run.implementationRunIds = capture.implementationRunIds;
      run.coverage.limitations = [...capture.limitations];
      if (!capture.patch) {
        const noSource =
          !capture.snapshot.files.length &&
          task.kind === "research" &&
          !capture.limitations.length;
        run.outcome = noSource ? "not-applicable" : "incomplete";
        run.note = noSource
          ? "This research story has no recorded source change. Review its deliverables before final acceptance."
          : "There is no current, attributable source patch to review. Inspect this story's Changes and capture its contribution first.";
        for (const item of run.phases) {
          item.state = item.id === "capture" ? "complete" : "unavailable";
        }
      } else if (!project.repoId) {
        run.outcome = "incomplete";
        run.coverage.limitations.push(
          "Analyze this story's exact local checkout before running graph-backed review.",
        );
        for (const item of run.phases)
          item.state = item.id === "capture" ? "complete" : "unavailable";
      } else {
        const result = await analyzeStoryReview(
          this.engine,
          project,
          capture,
          ({ phase: id, note }) => phase(id, note),
          assertActive,
        );
        assertActive();
        run.findings = result.findings;
        run.metrics = result.metrics;
        run.impact = result.impact;
        run.snapshot.sourceRevision = result.sourceRevision;
        run.snapshot.graphRevision = result.graphRevision;
        run.engine.audit = result.audit;
        run.engine.version =
          this.hooks.engineVersion?.(project) || "Not reported";
        run.coverage.limitations = result.limitations;
        await phase(
          "verification",
          "Linking actual checks to this exact worker contribution and source snapshot.",
        );
        this.checks(saved, task, capture);
        if (this.hooks.reviewer) {
          await this.reviewAnswer(
            saved,
            "Review the captured story patch and Memtrace findings. Explain the most important correctness, maintainability and refactoring concerns with exact captured paths and lines. Separate measured facts from your own suggestions. If no concern is justified, say so without claiming that unverified checks passed.",
          );
        } else {
          run.reviewer = {
            harness: task.harness,
            model: "Not reported",
            state: "unavailable",
            note: "A verified read-only model adapter is not connected. The measured review remains available.",
          };
        }
      }
      const sourceAfter = await this.sourceBinding(project.path!);
      assertActive();
      if (!saved.sourceBinding || sourceAfter !== saved.sourceBinding) {
        run.state = "stale";
        run.outcome = "incomplete";
        run.coverage.limitations.push(
          "Source changed during this review. Its findings are saved, but this review cannot approve the current code.",
        );
      } else {
        run.state = "completed";
        run.coverage.limitations = [...new Set(run.coverage.limitations)];
        run.coverage.complete =
          !run.coverage.limitations.length &&
          run.impact.complete &&
          run.checks.length > 0 &&
          run.checks.every((check) => check.state === "passed");
        run.outcome ??=
          run.findings.length ||
          run.checks.some((check) => check.state === "failed")
            ? "changes-requested"
            : run.coverage.complete
              ? "ready"
              : "incomplete";
      }
      run.completedAt = timestamp();
      for (const item of run.phases)
        if (item.state === "running") item.state = "complete";
      run.messages.push({
        id: randomUUID(),
        role: "system",
        at: timestamp(),
        text: this.explanation(run),
      });
      await this.exclusive(taskId, async () => {
        assertActive();
        await this.persist(saved);
      });
    } finally {
      this.active.delete(run.id);
    }
  }
  private checks(
    saved: SavedReview,
    task: WorkItem,
    capture: StoryReviewCapture,
  ): void {
    const check = task.run.checks;
    const linked =
      check &&
      check.linked &&
      capture.implementationRunIds.includes(check.runId) &&
      check.runId === task.run.changeRunId &&
      check.revision === task.changesRevision &&
      task.run.finishedSourceBinding === capture.sourceBinding &&
      !!capture.sourceBinding &&
      !check.timedOut;
    if (
      !linked ||
      check.passed === null ||
      check.failed === null ||
      check.exitCode === null ||
      check.passed + check.failed === 0
    ) {
      saved.run.checks = [
        {
          name: "Recorded verification",
          state: "unavailable",
          detail:
            "No complete check report is linked to this exact worker pass and source snapshot.",
        },
      ];
      saved.run.coverage.limitations.push(
        "Verification is missing, incomplete or belongs to an earlier source revision.",
      );
      return;
    }
    saved.run.checks = [
      {
        name: "Recorded verification",
        state: check.failed === 0 && check.exitCode === 0 ? "passed" : "failed",
        detail: `${check.passed} passed · ${check.failed} failed`,
        at: check.finishedAt,
      },
    ];
  }
  private explanation(run: StoryReviewRun): string {
    return (
      `Memtrace review · deterministic evidence\n\n${run.findings.length} findings across ${run.snapshot.files.length} recorded files. ${run.metrics.length} changed functions measured.\n\n` +
      (run.outcome === "ready"
        ? "The available detectors, graph measurements and linked verification completed against one stable source snapshot. Ready for your final look; this does not automatically mark the story done."
        : run.outcome === "not-applicable"
          ? "No recorded source change applies to this research story. Inspect its reports and deliverables."
          : run.outcome === "changes-requested"
            ? "Review the findings and failed checks. Select findings to send them back to the implementation worker."
            : "The review is incomplete. Resolve the coverage notes or missing checks before acceptance.")
    );
  }

  async cancel(taskId: string, runId: string): Promise<void> {
    await this.exclusive(taskId, async () => {
      const saved = await this.current(taskId, runId);
      if (terminal(saved.run) && !this.reviewerControllers.has(runId)) return;
      this.reviewerControllers.get(saved.run.id)?.abort();
      if (terminal(saved.run)) {
        if (saved.run.reviewer)
          saved.run.reviewer = {
            ...saved.run.reviewer,
            state: "unavailable",
            note: "The review answer was cancelled.",
          };
        await this.persist(saved);
        return;
      }
      saved.run.state = "cancelled";
      saved.run.completedAt = timestamp();
      saved.queued = false;
      saved.run.note =
        "Review stopped. The implementation and saved findings were preserved.";
      saved.run.coverage.complete = false;
      await this.persist(saved);
    });
    await this.reviewerWork.get(runId);
  }
  /** Starting implementation invalidates review, even if an old optional file is missing. */
  async interruptForWorker(taskId: string, note?: string): Promise<void> {
    let runId: string | undefined;
    await this.exclusive(taskId, async () => {
      const task = this.task(taskId);
      let saved: SavedReview | null;
      try {
        saved = await this.load(taskId);
      } catch {
        if (task.codeReview)
          task.codeReview = {
            ...task.codeReview,
            state: "stale",
            updatedAt: timestamp(),
          };
        await this.changed();
        return; // Preserve an unreadable old file; it cannot gate implementation.
      }
      if (!saved) {
        if (task.codeReview)
          task.codeReview = {
            ...task.codeReview,
            state: "stale",
            updatedAt: timestamp(),
          };
        await this.changed();
        return;
      }
      runId = saved.run.id;
      this.reviewerControllers.get(runId)?.abort();
      saved.run.state = terminal(saved.run) ? "stale" : "cancelled";
      saved.run.coverage.complete = false;
      saved.run.note =
        note?.trim().slice(0, 1000) ||
        "Implementation is starting a new pass. Run a fresh review after its changes are recorded.";
      await this.persist(saved);
    });
    if (runId) await this.reviewerWork.get(runId);
  }
  async discuss(
    taskId: string,
    runId: string,
    input: string,
  ): Promise<StoryReviewRun> {
    const saved = await this.exclusive(taskId, async () => {
      const text = input.trim();
      if (!text || text.length > 20000)
        throw Error("Write a review question of up to 20,000 characters.");
      const saved = await this.current(taskId, runId);
      if (this.reviewerControllers.has(runId))
        throw Error(
          "Wait for the reviewer's current answer before sending another question.",
        );
      if (!terminal(saved.run))
        throw Error(
          "Wait for the initial review before discussing its evidence.",
        );
      await this.stale(saved);
      saved.run.messages.push({
        id: randomUUID(),
        role: "user",
        at: timestamp(),
        text,
      });
      await this.persist(saved);
      return saved;
    });
    if (this.hooks.reviewer) await this.reviewAnswer(saved, input.trim());
    else
      await this.exclusive(taskId, async () => {
        const matching = saved.run.findings
          .filter(
            (finding) =>
              input.toLowerCase().includes(finding.id.toLowerCase()) ||
              (finding.path &&
                input.toLowerCase().includes(finding.path.toLowerCase())) ||
              (finding.ruleId &&
                input.toLowerCase().includes(finding.ruleId.toLowerCase())),
          )
          .slice(0, 8);
        const answer = matching.length
          ? matching
              .map(
                (finding) =>
                  `**${finding.title}**${finding.path ? ` · ${finding.path}${finding.line ? `:${finding.line}` : ""}` : ""}\n\n${finding.explanation}${finding.recommendation ? `\n\n${finding.recommendation}` : ""}`,
              )
              .join("\n\n")
          : this.explanation(saved.run);
        saved.run.messages.push({
          id: randomUUID(),
          role: "system",
          at: timestamp(),
          text: `Memtrace review · deterministic evidence\n\n${answer}\n\nNo model is connected to this review conversation yet. This reply summarizes saved measurements; it does not claim to interpret an arbitrary question or change source.`,
        });
        if (saved.run.messages.length > 100)
          saved.run.messages.splice(1, saved.run.messages.length - 100);
        await this.persist(saved);
      });
    return this.exclusive(taskId, async () => {
      await this.stale(saved);
      return clone(saved.run);
    });
  }
  private reviewAnswer(saved: SavedReview, question: string): Promise<void> {
    const pending = this.performReviewAnswer(saved, question);
    this.reviewerWork.set(saved.run.id, pending);
    void pending
      .finally(() => {
        if (this.reviewerWork.get(saved.run.id) === pending)
          this.reviewerWork.delete(saved.run.id);
      })
      .catch(() => {});
    return pending;
  }
  private async performReviewAnswer(
    saved: SavedReview,
    question: string,
  ): Promise<void> {
    const reviewer = this.hooks.reviewer;
    if (!reviewer) return;
    const task = clone(this.task(saved.run.taskId)),
      run = saved.run,
      controller = new AbortController();
    await this.exclusive(task.id, async () => {
      if (this.closed || run.state === "cancelled") throw new ReviewStopped();
      if (this.reviewerControllers.has(run.id))
        throw Error("The reviewer is already answering.");
      this.reviewerControllers.set(run.id, controller);
      run.reviewer = {
        harness: task.harness,
        model: "Not yet reported",
        state: "running",
        note: "Connecting a separate read-only reviewer. Implementation permissions do not apply.",
      };
      await this.persist(saved);
    });
    try {
      const result = await reviewer.ask({
        task,
        review: clone(run),
        question,
        patch: saved.patch,
        patchTruncated: saved.patchTruncated,
        signal: controller.signal,
        onModel: (model) => {
          void this.exclusive(task.id, async () => {
            if (
              !this.closed &&
              !controller.signal.aborted &&
              this.saved.get(task.id) === saved &&
              run.reviewer
            ) {
              run.reviewer.model = model;
              await this.persist(saved);
            }
          }).catch(() => {});
        },
      });
      await this.exclusive(task.id, async () => {
        if (
          controller.signal.aborted ||
          this.closed ||
          this.saved.get(task.id) !== saved
        )
          return;
        run.reviewer = {
          harness: result.harness,
          model: result.model,
          state: "idle",
          note: "Read-only reviewer advice; deterministic findings and measurements stay separate.",
        };
        if (result.evidenceRead) {
          (saved.reviewerReads ??= []).push({
            at: timestamp(),
            model: result.model,
            harness: result.harness,
            ...result.evidenceRead,
          });
          if (saved.reviewerReads.length > 100)
            saved.reviewerReads.splice(0, saved.reviewerReads.length - 100);
        }
        run.messages.push({
          id: randomUUID(),
          role: "assistant",
          at: timestamp(),
          text: result.text,
        });
        if (run.messages.length > 100)
          run.messages.splice(1, run.messages.length - 100);
        await this.persist(saved);
      });
    } catch (error) {
      await this.exclusive(task.id, async () => {
        if (this.closed || this.saved.get(task.id) !== saved) return;
        run.reviewer = {
          ...run.reviewer!,
          state: "unavailable",
          note: controller.signal.aborted
            ? "The review answer was cancelled."
            : (error as Error).message,
        };
        await this.persist(saved);
      });
    } finally {
      if (this.reviewerControllers.get(run.id) === controller)
        this.reviewerControllers.delete(run.id);
    }
  }
  async requestFixes(
    taskId: string,
    runId: string,
    findingIds: string[],
    input = "",
  ): Promise<void> {
    await this.exclusive(taskId, async () => {
      const saved = await this.current(taskId, runId);
      if (this.reviewerControllers.has(runId))
        throw Error("Wait for the reviewer's answer before requesting fixes.");
      if (!terminal(saved.run))
        throw Error("Wait for this review to finish before requesting fixes.");
      if (await this.stale(saved))
        throw Error(
          "The source changed. Run a fresh review before sending fixes for it.",
        );
      if (
        !Array.isArray(findingIds) ||
        findingIds.length > 100 ||
        new Set(findingIds).size !== findingIds.length
      )
        throw Error("Choose findings from this review.");
      const selected = findingIds.map((id) =>
        saved.run.findings.find((finding) => finding.id === id),
      );
      if (selected.some((finding) => !finding))
        throw Error("A selected finding is not part of this review.");
      if ((!selected.length && !input.trim()) || input.length > 20000)
        throw Error("Select a finding or describe the changes you want.");
      const brief =
        `Address these review comments for ${this.task(taskId).identifier}. Review snapshot ${saved.run.snapshot.id}; patch ${saved.run.snapshot.patchHash}. Preserve other Fleet contributions and coordinate before editing.\n\n` +
        selected
          .map(
            (finding) =>
              `- [${finding!.severity}] ${finding!.path ?? "Story"}${finding!.line ? `:${finding!.line}` : ""}: ${finding!.explanation}${finding!.locationScope === "affected-code" ? `\n  Affected consumer evidence, linked to ${finding!.relatedCapturedPaths?.join(", ")}. This location is not an authored change of this story; requalify and coordinate any additional edit scope.` : ""}${finding!.recommendation ? `\n  ${finding!.recommendation}` : ""}`,
          )
          .join("\n") +
        (input.trim() ? `\n\nUser instruction:\n${input.trim()}` : "");
      if (brief.length > 20000)
        throw Error(
          "Choose fewer findings so the implementation follow-up stays within its 20,000-character limit.",
        );
      await this.hooks.queueFixes(taskId, brief);
      saved.run.state = "stale";
      saved.run.coverage.complete = false;
      saved.run.note =
        "Fixes were sent to the implementation worker. Run a fresh review after its next pass.";
      await this.persist(saved);
    });
  }
  async accept(
    taskId: string,
    runId: string,
    inputReason?: string,
  ): Promise<void> {
    await this.exclusive(taskId, async () => {
      const saved = await this.current(taskId, runId);
      if (this.reviewerControllers.has(runId))
        throw Error("Wait for the reviewer's answer before acceptance.");
      if (await this.stale(saved))
        throw Error(
          "The source changed. Run a fresh review before acceptance.",
        );
      const reason = inputReason?.trim() ?? "";
      if (reason.length > 2000)
        throw Error("Keep the coverage decision to 2,000 characters.");
      const withCoverageNotes =
        saved.run.state === "completed" &&
        saved.run.outcome === "incomplete" &&
        !!reason;
      if (
        !withCoverageNotes &&
        (saved.run.state !== "completed" ||
          !["ready", "not-applicable"].includes(saved.run.outcome ?? ""))
      )
        throw Error(
          "Resolve this review's findings and coverage before moving to final acceptance.",
        );
      if (withCoverageNotes) {
        saved.run.messages.push({
          id: randomUUID(),
          role: "system",
          at: timestamp(),
          text: `Human review decision · continue with coverage notes\n\nRequested final acceptance with this explanation:\n\n${reason}\n\nThe review remains incomplete. No unavailable metric or check was marked as passed.`,
        });
        await this.persist(saved);
      }
      await this.hooks.accept(taskId);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.reviewerControllers.values())
      controller.abort();
    for (const saved of this.saved.values())
      if (!terminal(saved.run) || saved.run.reviewer?.state === "running") {
        await this.exclusive(saved.run.taskId, async () => {
          if (!terminal(saved.run)) {
            saved.run.state = "cancelled";
            saved.run.completedAt = timestamp();
            saved.run.coverage.complete = false;
            saved.run.note =
              "The app closed before this review completed. Start a fresh review when you return.";
          }
          if (saved.run.reviewer?.state === "running")
            saved.run.reviewer = {
              ...saved.run.reviewer,
              state: "unavailable",
              note: "The app closed before this reviewer answer completed.",
            };
          await this.persist(saved);
        });
      }
    // Drain only local file writes. An in-flight read-only engine query may
    // finish later, but assertActive prevents it from publishing after close.
    await Promise.allSettled([...this.operations.values()]);
    await Promise.allSettled([...this.reviewerWork.values()]);
  }
}
