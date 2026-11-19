import type { Project, WorkItem } from "../src/shared";
import { attributedReviewPaths, captureStoryReview } from "./code-review-snapshot";
import { completedEpicIndex, StartupPublicationTimeout } from "./memtrace-peer-index";
import { queuedFollowups } from "./followup-queue";
import { resumableProviderSession, type ProviderSession } from "./provider-session";
import { repairReviewPublication } from "./review-analysis-prepare";
import { checkSourceBinding } from "./verification";

interface StartOptions {
  previous?: ProviderSession;
  source?: string | null;
  changedBranch: boolean;
  update: (note: string) => void;
  signal: AbortSignal;
}

/** A queued worker can leave its watched graph behind its last saved edit. */
export async function prepareWorkerAnalysis(
  engine: Parameters<typeof repairReviewPublication>[0],
  project: Project,
  task: WorkItem,
  { previous, source, changedBranch, update, signal }: StartOptions,
): Promise<string> {
  let timeout: StartupPublicationTimeout;
  try {
    return await engine.analyze(project, update, changedBranch, undefined, signal);
  } catch (error) {
    if (!(error instanceof StartupPublicationTimeout)) throw error;
    timeout = error;
  }
  const { path, repoId } = project;
  const runId = task.run.changeRunId;
  if (
    changedBranch || project.analysisCheckout !== "owned-worktree-v1" ||
    !repoId || !path || !previous || !source || !runId ||
    !queuedFollowups(task).length || !(await resumableProviderSession(previous, task, path))
  ) throw timeout;

  signal.throwIfAborted();
  // An absent or incomplete journal cannot authorize a refresh.
  const capture = await captureStoryReview(task, runId).catch(() => undefined);
  if (!capture || capture.sourceBinding !== source || capture.limitations.length)
    throw timeout;
  const paths = attributedReviewPaths(capture);
  if (!paths.length) throw timeout;

  const assertQueued = () => {
    signal.throwIfAborted();
    if (!queuedFollowups(task).length) throw Error("The follow-up is no longer queued.");
  };
  const assertSource = async () => {
    assertQueued();
    if (await checkSourceBinding(path) !== source)
      throw Error("The epic checkout changed while preparing the queued follow-up. Retry on the current source.");
    assertQueued();
  };
  const beforeIndex = async (matchedRepoId?: string) => {
    assertQueued();
    if (matchedRepoId !== repoId) throw timeout;
    const jobs = await engine.call(project, "list_jobs", {}, signal);
    if (!completedEpicIndex(jobs, project, repoId)) throw timeout;
    await assertSource();
  };
  await repairReviewPublication(engine, project, update, assertQueued, undefined, paths, {
    signal, beforeIndex,
  });
  await assertSource();
  return repoId;
}
