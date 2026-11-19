import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppState, Project, WorkItem } from "../src/shared";
import { isActive } from "../src/domain";
import {
  activeCodeReviewFindings,
  codeReviewDismissalReasons,
  codeReviewPhases,
  reviewFindingDisposition,
  type CodeReviewDismissalReason,
  type CodeReviewFinding,
  type StoryReviewRun,
} from "../src/code-review";
import type { StoryAuthor } from "../src/story-comments";
import {
  attributedReviewPaths,
  captureStoryReview,
  type StoryReviewCapture,
} from "./code-review-snapshot";
import {
  analyzeStoryReview,
  measureCapturedStoryQuality,
  type ReviewEngine,
} from "./code-review-analysis";
import { checkSourceBinding } from "./verification";
import { replaceWorkspace } from "./persistence";
import type { ReadonlyReviewAgent } from "./review-agent";
import { isCodeReviewTask } from "../src/code-review-workflow";
import { ReviewAdmission, type ReviewWait } from "./review-admission";

interface ReviewHooks {
  onSaved?(run: StoryReviewRun): void;
  queueFixes(taskId: string, text: string): Promise<void>;
  accept(taskId: string): Promise<void>;
  reviewProject?(task: WorkItem, project: Project): Project;
  /** Actual connected engine version; absence is displayed as not reported. */
  engineVersion?(project: Project): string;
  reviewer?: ReadonlyReviewAgent;
  prepare?(
    task: WorkItem,
    project: Project,
    update: (note: string) => void,
    assertActive: () => void,
    capturedPaths: string[],
  ): Promise<Project>;
  repairPublication?(
    task: WorkItem,
    project: Project,
    update: (note: string) => void,
    assertActive: () => void,
    expectedSourceRevision: string,
  ): Promise<void>;
  implementationCount?(): number;
  implementationStarting?(taskId: string): boolean;
  capacityChanged?(): void;
  settled?(task: WorkItem, project: Project): Promise<void>;
  actor?(task: WorkItem): StoryAuthor | undefined;
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
  automaticRetries?: number;
  retryOf?: string;
  interrupted?: boolean;
  retryAllowed?: boolean;
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
const findingEvidenceHash = ({
  evidenceHash: _prior,
  ...finding
}: CodeReviewFinding) =>
  createHash("sha256").update(JSON.stringify(finding)).digest("hex");
const bindFindingEvidence = (run: StoryReviewRun) => {
  for (const finding of run.findings)
    finding.evidenceHash = findingEvidenceHash(finding);
  if (run.state === "completed" && run.findingDispositions?.length)
    run.outcome =
      activeCodeReviewFindings(run).length ||
      run.checks.some((check) => check.state === "failed")
        ? "changes-requested"
        : run.coverage.complete
          ? "ready"
          : "incomplete";
};
class ReviewStopped extends Error {}
class ReviewSourceChanged extends Error {}

/** Review is a separate, read-only process. It never inherits worker shell permissions. */
export class CodeReviewManager {
  private saved = new Map<string, SavedReview>();
  private loading = new Map<string, Promise<SavedReview | null>>();
  private operations = new Map<string, Promise<unknown>>();
  private admission: ReviewAdmission;
  private executionWork = new Map<string, Promise<void>>();
  private graphRetirements = new Map<string, Promise<void>>();
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
    this.admission = new ReviewAdmission(
      () => this.state().settings.maxWorkers,
      () =>
        this.hooks.implementationCount?.() ??
        this.state().tasks.filter((task) => !task.example && isActive(task))
          .length,
      () => this.hooks.capacityChanged?.(),
    );
  }

  /** Workers may replace a same-epic review only after beforeWorker drains it. */
  occupiedSlots(task?: WorkItem): number {
    return this.admission.occupied(
      task
        ? (id) => {
            const peer = this.state().tasks.find((item) => item.id === id);
            return !!peer && this.sameEpic(task, peer);
          }
        : undefined,
    );
  }
  private sameEpic(first: WorkItem, second: WorkItem): boolean {
    if (first.projectId !== second.projectId) return false;
    if (first.epicId && first.epicId === second.epicId) return true;
    if (
      first.run.analysisProjectId &&
      first.run.analysisProjectId === second.run.analysisProjectId
    )
      return true;
    // First-pass stories have no private graph id yet. Epic identity above is
    // authoritative; this fallback also protects the legacy shared checkout.
    const root = this.state().projects.find(
      (project) => project.id === first.projectId,
    )?.path;
    const a = first.run.workspace ?? root,
      b = second.run.workspace ?? root;
    const key = (path: string) =>
      process.platform === "win32"
        ? resolve(path).toLowerCase()
        : resolve(path);
    return !!a && !!b && key(a) === key(b);
  }
  private inReviewLane(task: WorkItem): boolean {
    return this.state().reviewWorkflows?.[task.projectId]
      ? isCodeReviewTask(this.state(), task)
      : task.stage === "review";
  }
  private quiet(task: WorkItem): boolean {
    return !this.state().tasks.some(
      (other) =>
        this.sameEpic(task, other) &&
        (isActive(other) || this.hooks.implementationStarting?.(other.id)),
    );
  }
  private waitNote(reason: ReviewWait): string {
    return reason === "writers"
      ? "Waiting for this epic's workers to finish editing. Review has not captured or certified the source."
      : reason === "epic"
        ? "Waiting for the earlier review in this epic."
        : "Waiting for local capacity. Reviews and implementation workers share the limit in Settings.";
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
    bindFindingEvidence(saved.run);
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
    this.hooks.onSaved?.(clone(saved.run));
    const task = this.state().tasks.find(
      (item) => item.id === saved.run.taskId,
    );
    if (task)
      task.codeReview = {
        runId: saved.run.id,
        state: saved.run.state,
        outcome: saved.run.outcome,
        updatedAt: saved.run.updatedAt,
        findingCount: activeCodeReviewFindings(saved.run).length,
        phase: saved.run.phases.find((phase) => phase.state === "running")?.id,
      };
    await this.changed();
  }
  /** The current-run pointer is unchanged; the final report rename commits triage. */
  private async persistDisposition(
    current: SavedReview,
    candidate: SavedReview,
    task: WorkItem,
  ): Promise<void> {
    bindFindingEvidence(candidate.run);
    candidate.run.updatedAt = timestamp();
    const directory = this.directory(candidate.run.taskId),
      path = join(directory, candidate.run.id + ".json"),
      previousSummary = clone(task.codeReview);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Prepare without publishing any mutation to the cache or workspace summary.
    await writeFile(path + ".next", JSON.stringify(candidate), { mode: 0o600 });
    task.codeReview = {
      runId: candidate.run.id,
      state: candidate.run.state,
      outcome: candidate.run.outcome,
      updatedAt: candidate.run.updatedAt,
      findingCount: activeCodeReviewFindings(candidate.run).length,
      phase: candidate.run.phases.find((phase) => phase.state === "running")
        ?.id,
    };
    try {
      // Save the derived summary first. If this or the final rename fails, the
      // authoritative report and in-memory review both retain the old decision.
      await this.changed();
      await replaceWorkspace(path + ".next", path);
      this.saved.set(candidate.run.taskId, candidate);
    } catch (error) {
      task.codeReview = previousSummary;
      this.saved.set(current.run.taskId, current);
      // A notification failure can follow a successful workspace write. Try to
      // save its restored summary too; acceptance still reads the old report.
      await Promise.resolve()
        .then(() => this.changed())
        .catch(() => {});
      throw error;
    }
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
          (value.run.findingDispositions !== undefined &&
            !Array.isArray(value.run.findingDispositions)) ||
          !Array.isArray(value.run.phases) ||
          !Array.isArray(value.run.messages)
        )
          throw Error(
            "This saved review is not recognized. Start a new review; the saved file was preserved.",
          );
        const savedOutcome = value.run.outcome;
        bindFindingEvidence(value.run);
        const interrupted = !terminal(value.run);
        value.automaticRetries = value.automaticRetries === 1 ? 1 : 0;
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
        if (
          interrupted ||
          interruptedReviewer ||
          savedOutcome !== value.run.outcome
        )
          await this.persist(value);
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
      !this.quiet(task) ||
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
    return this.enqueue(taskId);
  }
  private async enqueue(
    taskId: string,
    automaticRetries = 0,
    retryFrom?: SavedReview,
  ): Promise<StoryReviewRun> {
    return this.exclusive(taskId, async () => {
      if (this.closed) {
        if (retryFrom) return clone(retryFrom.run);
        throw Error("The review service is closing.");
      }
      const task = this.task(taskId),
        project = this.project(task);
      if (retryFrom && isActive(task)) return clone(retryFrom.run);
      if (isActive(task))
        throw Error(
          "Finish this story's worker pass before reviewing its contribution.",
        );
      if (task.example || project.example || !project.path)
        throw Error("Connect a real local project to review its code.");
      const previous = await this.load(taskId);
      if (
        retryFrom &&
        (previous !== retryFrom ||
          retryFrom.retryAllowed === false ||
          !this.inReviewLane(task))
      )
        return clone(previous?.run ?? retryFrom.run);
      if (previous && !terminal(previous.run)) return clone(previous.run);
      if (previous && this.reviewerControllers.has(previous.run.id))
        throw Error(
          "Wait for the reviewer's answer, or stop it before starting a new review.",
        );
      const at = timestamp(),
        id = randomUUID();
      const saved: SavedReview = {
        queued: true,
        automaticRetries,
        ...(retryFrom ? { retryOf: retryFrom.run.id } : {}),
        retryAllowed: true,
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
          ...(retryFrom
            ? {
                note: "The epic changed during review. One fresh review is queued after its workers finish; the earlier snapshot is preserved.",
              }
            : {}),
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
              text: retryFrom
                ? "The previous review was interrupted by edits in this epic. A fresh snapshot will be reviewed after editing finishes. Automatic recovery is limited to this one additional pass; nothing is accepted automatically."
                : this.hooks.reviewer
                  ? "Memtrace checks this story's recorded changes locally, then a separate read-only model reviewer explains the captured patch and measurements. The implementation worker is not running in this review conversation."
                  : "Memtrace review checks this story's recorded changes locally. This is a deterministic review; no model or implementation worker is running in this conversation.",
            },
          ],
        },
      };
      this.saved.set(taskId, saved);
      await this.persist(saved);
      this.schedule(saved);
      return clone(saved.run);
    });
  }
  private async settleGraph(
    saved: SavedReview,
    finishing = false,
  ): Promise<void> {
    const task = this.state().tasks.find(
      (item) => item.id === saved.run.taskId,
    );
    if (!task || !this.hooks.settled) return;
    const project = this.project(task),
      key = project.id;
    if (!finishing && this.admission.busy(key)) return;
    const previous = this.graphRetirements.get(key) ?? Promise.resolve();
    const retirement = previous
      .catch(() => {})
      .then(() => this.hooks.settled!(task, project));
    this.graphRetirements.set(key, retirement);
    try {
      await retirement;
    } finally {
      if (this.graphRetirements.get(key) === retirement)
        this.graphRetirements.delete(key);
    }
  }
  private schedule(saved: SavedReview): void {
    const { taskId, id } = saved.run;
    let retry = false;
    const failure = async (error: unknown) => {
      if (
        saved.run.state === "cancelled" ||
        this.closed ||
        this.saved.get(taskId) !== saved
      )
        return;
      await this.exclusive(taskId, async () => {
        saved.queued = false;
        saved.run.state =
          error instanceof ReviewStopped
            ? "cancelled"
            : retry
              ? "stale"
              : "failed";
        saved.run.outcome = "incomplete";
        saved.run.completedAt = timestamp();
        saved.run.note =
          error instanceof ReviewStopped
            ? "Review stopped because this story left the Code review lane. Its saved evidence is preserved."
            : retry
              ? "The epic changed during review. This snapshot cannot approve the current source."
              : error instanceof Error
                ? error.message
                : String(error);
        for (const phase of saved.run.phases)
          if (phase.state === "running")
            phase.state = retry ? "unavailable" : "failed";
        saved.run.coverage.complete = false;
        await this.persist(saved);
      });
    };
    const work = (async () => {
      // Reuse a live graph when this review can start now. Only queued work
      // retires its idle owner while waiting for writers, its epic or capacity.
      const task = this.task(taskId), key = this.project(task).id;
      const canStart = this.quiet(task) && !this.admission.busy(key) &&
        (this.hooks.implementationCount?.() ?? this.state().tasks.filter(t => !t.example && isActive(t)).length) +
          this.admission.occupied() < Math.max(1, this.state().settings.maxWorkers);
      if (!canStart) await this.settleGraph(saved);
      if (
        this.closed ||
        saved.run.state === "cancelled" ||
        this.saved.get(taskId) !== saved
      )
        return;
      await this.admission.submit({
        id,
        taskId,
        key: this.project(this.task(taskId)).id,
        ready: () => {
          const task = this.task(taskId);
          if (!this.inReviewLane(task)) throw new ReviewStopped();
          return this.quiet(task);
        },
        waiting: (reason) => {
          void this.exclusive(taskId, async () => {
            if (
              !saved.queued ||
              this.saved.get(taskId) !== saved ||
              saved.run.state !== "queued"
            )
              return;
            saved.run.note = this.waitNote(reason);
            await this.persist(saved);
          }).catch(() => {});
        },
        run: async () => {
          try {
            await this.execute(saved);
          } catch (error) {
            if (error instanceof ReviewSourceChanged) retry = true;
            await failure(error);
          } finally {
            await this.settleGraph(saved, true);
          }
        },
      });
    })().catch(failure);
    this.executionWork.set(id, work);
    void work
      .then(async () => {
        if (
          retry &&
          !this.closed &&
          saved.retryAllowed !== false &&
          (saved.automaticRetries ?? 0) < 1 &&
          this.saved.get(taskId) === saved &&
          this.inReviewLane(this.task(taskId))
        )
          await this.enqueue(taskId, (saved.automaticRetries ?? 0) + 1, saved);
      })
      .finally(() => {
        if (this.executionWork.get(id) === work) this.executionWork.delete(id);
      })
      .catch((error) =>
        console.error("Could not persist story review:", error),
      );
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
      if (!this.inReviewLane(task)) throw new ReviewStopped();
      if (saved.interrupted)
        throw new ReviewSourceChanged(
          "Another worker is starting edits in this epic.",
        );
      if (!this.quiet(task))
        throw new ReviewSourceChanged(
          "Another worker began editing this epic during review.",
        );
      if (isActive(task) || task.changesRevision !== saved.changesRevision)
        throw new ReviewSourceChanged(
          "The story began changing while review was running. Wait for its worker and run a fresh review.",
        );
    };
    assertActive();
    this.active.add(run.id);
    saved.queued = false;
    run.note = undefined;
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
    let captured: StoryReviewCapture | undefined;
    let reviewProject: Project | undefined;
    try {
      const task = this.task(taskId);
      let project = this.project(task);
      await phase(
        "capture",
        "Capturing only this story's attributed checkpoints.",
      );
      const capture = await this.capture(clone(task));
      assertActive();
      captured = capture;
      reviewProject = project;
      saved.sourceBinding = capture.sourceBinding;
      run.snapshot = capture.snapshot;
      saved.patch = capture.patch.slice(0, 60000);
      saved.patchTruncated = saved.patch.length < capture.patch.length;
      run.implementationRunIds = capture.implementationRunIds;
      run.coverage.limitations = [...capture.limitations];
      if (capture.patch) {
        this.checks(saved, task, capture);
        await phase(
          "review",
          "Preparing Memtrace for this story's captured changes.",
        );
        await this.graphRetirements.get(project.id);
        assertActive();
        if (this.hooks.prepare) {
          project = await this.hooks.prepare(
            task,
            project,
            (note) => {
              void phase("review", note).catch(() => {});
            },
            assertActive,
            attributedReviewPaths(capture),
          );
          assertActive();
          reviewProject = project;
        }
      }

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
          this.hooks.repairPublication
            ? async (sourceRevision) => {
                await this.hooks.repairPublication!(
                  task,
                  project,
                  (note) => {
                    void phase("review", note).catch(() => {});
                  },
                  assertActive,
                  sourceRevision,
                );
              }
            : undefined,
        );
        assertActive();
        run.findings = result.findings;
        run.metrics = result.metrics;
        run.qualityComparison = result.qualityComparison;
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

        if (this.hooks.reviewer) {
          await this.reviewAnswer(
            saved,
            "Review the captured story patch and Memtrace findings. Explain the most important correctness, maintainability and refactoring concerns with exact captured paths and lines. Separate measured facts from your own suggestions. If no concern is justified, say so without claiming that unverified checks passed.",
            true,
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
      await this.exclusive(taskId, async () => {
        assertActive();
        if (
          saved.sourceBinding &&
          sourceAfter &&
          sourceAfter !== saved.sourceBinding
        )
          throw new ReviewSourceChanged("Source changed during this review.");
        // Readers and finding decisions share this queue. Publish completion only
        // after its report, current-run pointer and story summary have been saved.
        const final = clone(run);
        if (!saved.sourceBinding || sourceAfter !== saved.sourceBinding) {
          final.state = "stale";
          final.outcome = "incomplete";
          final.coverage.limitations.push(
            "Source changed during this review. Its findings are saved, but this review cannot approve the current code.",
          );
        } else {
          final.state = "completed";
          final.coverage.limitations = [...new Set(final.coverage.limitations)];
          final.coverage.complete =
            !final.coverage.limitations.length &&
            final.impact.complete &&
            final.checks.length > 0 &&
            final.checks.every((check) => check.state === "passed");
          final.outcome ??=
            final.findings.length ||
            final.checks.some((check) => check.state === "failed")
              ? "changes-requested"
              : final.coverage.complete
                ? "ready"
                : "incomplete";
        }
        final.completedAt = timestamp();
        for (const item of final.phases)
          if (item.state === "running") item.state = "complete";
        final.messages.push({
          id: randomUUID(),
          role: "system",
          at: timestamp(),
          text: this.explanation(final),
        });
        await this.persist({ ...saved, run: final });
        saved.run = final;
      });
    } catch (error) {
      assertActive();
      if (captured?.patch && reviewProject?.repoId && !run.qualityComparison) {
        try {
          const comparison = await measureCapturedStoryQuality(
            this.engine,
            reviewProject,
            captured,
            assertActive,
          );
          assertActive();
          run.metrics = comparison.metrics;
          run.qualityComparison = comparison.coverage;
        } catch {
          assertActive();
        }
      }
      throw error;
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
      `Memtrace review · deterministic evidence\n\n${activeCodeReviewFindings(run).length} active findings across ${run.snapshot.files.length} recorded files. ${run.metrics.length} changed functions measured.\n\n` +
      (run.outcome === "ready"
        ? "The available detectors, graph measurements and linked verification completed against one stable source snapshot. Ready for your final look; this does not automatically mark the story done."
        : run.outcome === "not-applicable"
          ? "No recorded source change applies to this research story. Inspect its reports and deliverables."
          : run.outcome === "changes-requested"
            ? "Review the findings and failed checks. Select findings to send them back to the implementation worker."
            : "The review is incomplete. Resolve the coverage notes or missing checks before acceptance.")
    );
  }

  async dismissFinding(
    taskId: string,
    runId: string,
    findingId: string,
    reason: CodeReviewDismissalReason,
    explanation: string,
  ): Promise<StoryReviewRun> {
    if (!codeReviewDismissalReasons.some((item) => item.id === reason))
      throw Error("Choose a reason for dismissing this finding.");
    const text = typeof explanation === "string" ? explanation.trim() : "";
    if (!text || text.length > 2000)
      throw Error("Explain the dismissal in 1 to 2,000 characters.");
    return this.changeFindingDisposition(taskId, runId, findingId, {
      status: "dismissed",
      reason,
      explanation: text,
    });
  }

  async reopenFinding(
    taskId: string,
    runId: string,
    findingId: string,
  ): Promise<StoryReviewRun> {
    return this.changeFindingDisposition(taskId, runId, findingId, {
      status: "reopened",
    });
  }

  private async changeFindingDisposition(
    taskId: string,
    runId: string,
    findingId: string,
    decision: {
      status: "dismissed" | "reopened";
      reason?: CodeReviewDismissalReason;
      explanation?: string;
    },
  ): Promise<StoryReviewRun> {
    return this.exclusive(taskId, async () => {
      if (this.closed) throw Error("The local review service is closing.");
      const current = await this.current(taskId, runId),
        saved = clone(current),
        task = this.task(taskId),
        run = saved.run;
      const requireEditable = () => {
        if (this.task(taskId) !== task)
          throw Error(
            "The story changed while saving this decision. Reload its review.",
          );
        if (!this.inReviewLane(task))
          throw Error(
            "Move this story to the Code review lane to change a finding.",
          );
        if (run.state !== "completed" || !this.quiet(task))
          throw Error(
            "Wait for a current completed review before changing a finding.",
          );
        if (
          this.reviewerControllers.has(runId) ||
          run.reviewer?.state === "running"
        )
          throw Error(
            "Wait for the reviewer's answer before changing a finding.",
          );
      };
      requireEditable();
      const finding = run.findings.find((item) => item.id === findingId);
      if (!finding)
        throw Error("This finding is not part of the current review.");
      if (await this.stale(current))
        throw Error(
          "The source changed. Run a fresh review before changing a finding.",
        );
      requireEditable();
      bindFindingEvidence(run);
      const previous = reviewFindingDisposition(run, findingId);
      if (decision.status === "dismissed" && previous?.status === "dismissed")
        throw Error(
          "This finding is already dismissed. Reopen it before changing the reason.",
        );
      if (decision.status === "reopened" && previous?.status !== "dismissed")
        throw Error("This finding is not dismissed.");
      if ((run.findingDispositions?.length ?? 0) >= 500)
        throw Error(
          "This review has reached its decision history limit. Start a fresh review.",
        );
      const actor = this.hooks.actor?.(task) ?? {
        id: "local-owner",
        name: "Local user",
        source: "local" as const,
      };
      const at = timestamp();
      (run.findingDispositions ??= []).push({
        id: randomUUID(),
        findingId,
        ...decision,
        at,
        actor: clone(actor),
        snapshotId: run.snapshot.id,
        patchHash: run.snapshot.patchHash,
        evidenceHash: finding.evidenceHash!,
      });
      // A human dismissal changes triage, never detector evidence, checks or coverage.
      run.outcome =
        activeCodeReviewFindings(run).length ||
        run.checks.some((check) => check.state === "failed")
          ? "changes-requested"
          : run.coverage.complete
            ? "ready"
            : "incomplete";
      run.messages.push({
        id: randomUUID(),
        role: "system",
        at,
        text:
          decision.status === "dismissed"
            ? `Human review decision · finding dismissed\n\n${finding.title}\n\n${codeReviewDismissalReasons.find((item) => item.id === decision.reason)!.label}: ${decision.explanation}\n\nSaved by ${actor.name}. This decision applies only to this review snapshot. The detector evidence and verification results are unchanged.`
            : `Human review decision · finding reopened\n\n${finding.title}\n\nReopened by ${actor.name}. It is active again; the earlier dismissal remains in the decision history.`,
      });
      await this.persistDisposition(current, saved, task);
      return clone(run);
    });
  }

  async cancel(taskId: string, runId: string): Promise<void> {
    let activeId = runId;
    await this.exclusive(taskId, async () => {
      const saved = await this.current(taskId);
      if (saved.run.id !== runId && saved.retryOf !== runId)
        throw Error(
          "This review is no longer the current review for the story.",
        );
      activeId = saved.run.id;
      saved.retryAllowed = false;
      this.admission.cancel(activeId);
      this.admission.cancel(`answer:${activeId}`);
      if (terminal(saved.run) && !this.reviewerControllers.has(activeId))
        return;
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
    await this.reviewerWork.get(activeId);
  }
  async leaveLane(taskId: string): Promise<void> {
    const pending = await this.exclusive(taskId, async () => {
      const saved = await this.load(taskId);
      if (!saved) return;
      saved.retryAllowed = false;
      return terminal(saved.run) ? undefined : saved.run.id;
    });
    if (pending) await this.cancel(taskId, pending);
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
      saved.retryAllowed = false;
      this.admission.cancel(runId);
      this.admission.cancel(`answer:${runId}`);
      this.reviewerControllers.get(runId)?.abort();
      saved.run.state = terminal(saved.run) ? "stale" : "cancelled";
      saved.run.coverage.complete = false;
      saved.run.note =
        note?.trim().slice(0, 1000) ||
        "Implementation is starting a new pass. Run a fresh review after its changes are recorded.";
      await this.persist(saved);
    });
    if (runId) {
      await this.reviewerWork.get(runId);
      await this.executionWork.get(runId);
    }
  }
  /** Called while the worker holds a start reservation, before Preparing. */
  async beforeWorker(taskId: string): Promise<void> {
    await this.interruptForWorker(taskId);
    const owner = this.task(taskId);
    const drains: Promise<unknown>[] = [];
    for (const saved of this.saved.values()) {
      if (saved.run.taskId === taskId) continue;
      const peer = this.state().tasks.find(
        (item) => item.id === saved.run.taskId,
      );
      if (!peer || !this.sameEpic(owner, peer)) continue;
      if (this.admission.isRunning(saved.run.id)) {
        await this.exclusive(peer.id, async () => {
          saved.interrupted = true;
          this.reviewerControllers.get(saved.run.id)?.abort();
          saved.run.note =
            "Another story is starting edits in this epic. This review is stopping before a fresh snapshot can be captured.";
          await this.persist(saved);
        });
        const work = this.executionWork.get(saved.run.id);
        if (work) drains.push(work);
      }
      if (this.reviewerControllers.has(saved.run.id)) {
        this.reviewerControllers.get(saved.run.id)?.abort();
        this.admission.cancel(`answer:${saved.run.id}`);
        const answer = this.reviewerWork.get(saved.run.id);
        if (answer) drains.push(answer);
      }
    }
    await Promise.allSettled(drains);
    this.admission.notify();
  }
  async discuss(
    taskId: string,
    runId: string,
    input: string,
    author?: {id: string; actor: import("../src/team-session").SessionActor},
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
        id: author?.id ?? randomUUID(),
        role: "user",
        actor: author?.actor,
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
  private reviewAnswer(
    saved: SavedReview,
    question: string,
    admitted = false,
  ): Promise<void> {
    if (this.reviewerControllers.has(saved.run.id))
      return Promise.reject(Error("The reviewer is already answering."));
    const controller = new AbortController();
    this.reviewerControllers.set(saved.run.id, controller);
    const pending = this.performReviewAnswer(
      saved,
      question,
      controller,
      admitted,
    );
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
    controller: AbortController,
    admitted: boolean,
  ): Promise<void> {
    const reviewer = this.hooks.reviewer;
    if (!reviewer) return;
    const task = clone(this.task(saved.run.taskId)),
      run = saved.run;
    try {
      await this.exclusive(task.id, async () => {
        if (
          this.closed ||
          run.state === "cancelled" ||
          controller.signal.aborted
        )
          throw new ReviewStopped();
        run.reviewer = {
          harness: task.harness,
          model: "Not yet reported",
          state: "running",
          note: admitted
            ? "Connecting a separate read-only reviewer. Implementation permissions do not apply."
            : "Waiting for local capacity. This answer uses the saved review snapshot only.",
        };
        await this.persist(saved);
      });
      const answer = async () => {
        if (
          controller.signal.aborted ||
          this.closed ||
          this.saved.get(task.id) !== saved
        )
          return;
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
      };
      if (controller.signal.aborted || this.closed) return;
      if (admitted) await answer();
      else
        await this.admission.submit({
          id: `answer:${run.id}`,
          taskId: task.id,
          key: this.project(task).id,
          ready: () => !controller.signal.aborted,
          waiting: (reason) => {
            void this.exclusive(task.id, async () => {
              if (
                controller.signal.aborted ||
                this.saved.get(task.id) !== saved ||
                !run.reviewer
              )
                return;
              run.reviewer.note = `${this.waitNote(reason)} This answer reads saved evidence only.`;
              await this.persist(saved);
            }).catch(() => {});
          },
          run: answer,
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
        activeCodeReviewFindings(saved.run).find(
          (finding) => finding.id === id,
        ),
      );
      if (selected.some((finding) => !finding))
        throw Error(
          "A selected finding is not part of the active findings in this review. Reopen dismissed findings before requesting a fix.",
        );
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
      if (
        activeCodeReviewFindings(saved.run).length ||
        saved.run.checks.some((check) => check.state === "failed")
      )
        throw Error(
          "Resolve active findings and failed checks before final acceptance.",
        );
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
    this.admission.close();
    for (const saved of this.saved.values()) saved.retryAllowed = false;
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
