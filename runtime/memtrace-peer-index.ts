import { setTimeout as pause } from "node:timers/promises";
import type { Project } from "../src/shared";

type Json = Record<string, any>;
interface PeerIndexClient {
  call(
    project: Project,
    name: string,
    args: Json,
    signal?: AbortSignal,
  ): Promise<any>;
}
export interface PeerIndexWaitOptions {
  discoveryMs?: number;
  timeoutMs?: number;
  readTimeoutMs?: number;
  pollMs?: number;
  publicationMs?: number;
  requireCertificate?: boolean;
  completedJob?: boolean;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export const pathKey = (value: string) => {
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};
const jobPath = (job: Json) =>
  job.runtime_context?.requested_path ?? job.path ?? job.result?.path;
const jobBranch = (job: Json) => job.branch ?? job.result?.branch;
const usable = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 500;

async function readWithDeadline(
  query: (signal: AbortSignal) => Promise<any>,
  ms: number,
  timeoutMessage: string,
  cancelled?: AbortSignal,
) {
  const read = new AbortController();
  const cancel = () => read.abort(Error("Memtrace analysis was cancelled."));
  const timer = setTimeout(
    () => read.abort(Error(timeoutMessage)),
    Math.max(1, ms),
  );
  const stopped = new Promise<never>((_resolve, reject) =>
    read.signal.addEventListener("abort", () => reject(read.signal.reason), {
      once: true,
    }),
  );
  cancelled?.addEventListener("abort", cancel, { once: true });
  try {
    if (cancelled?.aborted) cancel();
    return await Promise.race([
      stopped,
      Promise.resolve().then(() => {
        read.signal.throwIfAborted();
        return query(read.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    cancelled?.removeEventListener("abort", cancel);
  }
}

export function exactRevisionSource(
  value: Json | undefined,
  project: Project,
  repoId: string,
) {
  return (
    !!project.path &&
    value?.repo_id === repoId &&
    typeof value.worktree === "string" &&
    pathKey(value.worktree) === pathKey(project.path) &&
    value.branch === project.branch &&
    (project.analysisCheckout === "owned-worktree-v1"
      ? value.checkout_mode === "owned-worktree-v1" &&
        value.graph_scope === "owned_worktree_graph"
      : value.checkout_mode !== "owned-worktree-v1" &&
        value.graph_scope !== "owned_worktree_graph")
  );
}

export class StartupPublicationTimeout extends Error {}
/** The same checkout advanced while its current-source certificate was pending. */
export class SourcePublicationChanged extends Error {}

/** A stable published epic graph can lag a peer's save without an index job. */
export function currentSourceNeedsIndex(
  value: Json | undefined,
  project: Project,
  repoId: string,
): boolean {
  const boundary = value?._meta?.graph_revision ?? value?.graph_revision;
  return (
    (project.analysisCurrentSource === true ||
      project.analysisCheckout === "owned-worktree-v1") &&
    exactRevisionSource(value, project, repoId) &&
    value?.ready === false &&
    value.status === "partial" &&
    value.reason === undefined &&
    value.publication?.status === "published" &&
    boundary?.publication_unchanged_during_call === true &&
    value.requested_source_matches === true &&
    value.requested_revision_matches === true &&
    value.source_unchanged_during_observation === true &&
    value.ambiguous_indexed_files === false &&
    value.default_branch_matches === true &&
    value.retry_query_group !== true &&
    Number.isSafeInteger(value.mismatched_files) &&
    value.mismatched_files > 0
  );
}

/** A worker may refresh only after its exact checkout's previous job has finished. */
export function completedEpicIndex(
  result: unknown,
  project: Project,
  repoId: string,
): boolean {
  const jobs: unknown = Array.isArray(result)
    ? result
    : (result as { jobs?: unknown } | null)?.jobs;
  if (
    !Array.isArray(jobs) ||
    !project.path ||
    !jobs.every(
      (job) => job && ["completed", "failed", "cancelled"].includes(job.status),
    )
  )
    return false;
  return jobs.some(
    (job) =>
      job.status === "completed" &&
      job.repo_id === repoId &&
      typeof jobPath(job) === "string" &&
      pathKey(jobPath(job)) === pathKey(project.path!) &&
      jobBranch(job) === project.branch,
  );
}

/** A saved failure may only be superseded by this checkout's stable native certificate. */
export function certifiedPublication(
  value: Json | undefined,
  project: Project,
  repoId: string,
) {
  return (
    exactRevisionSource(value, project, repoId) &&
    verifiedIndexRevision(value, project, repoId) &&
    value?.status === "complete" &&
    value.ambiguous_indexed_files !== true &&
    (value.mismatched_files ?? 0) === 0 &&
    value.publication?.status === "published" &&
    value.requested_source_matches === true &&
    value.requested_revision_matches === true &&
    value.source_unchanged_during_observation === true &&
    (value._meta?.graph_revision ?? value.graph_revision)
      ?.publication_unchanged_during_call === true
  );
}

/** The native reader can return a stable source with a partial graph and no reason code. */
export function incompletePublication(value: Json | undefined) {
  if (value?.ready !== false || value.status !== "partial") return false;
  const reason =
    value.reason ??
    value._meta?.graph_revision?.reason ??
    value.graph_revision?.reason;
  if (reason) return reason === "branch_publication_incomplete";
  return (
    value.requested_source_matches === true &&
    value.requested_revision_matches === true &&
    value.source_unchanged_during_observation === true &&
    value.default_branch_matches !== false &&
    value.ambiguous_indexed_files !== true &&
    value.mismatched_files === 0 &&
    Number.isSafeInteger(value.source_file_count) &&
    value.source_file_count >= 0 &&
    value.indexed_file_count === value.source_file_count
  );
}

/** Bind the checkout, its complete file inventory and the native publication boundary. */
function matchedOwnedPublication(
  value: Json,
  project: Project,
  repoId: string,
  status: "partial" | "published",
) {
  const boundary = value?._meta?.graph_revision;
  const published = status === "published";
  return (
    project.analysisCheckout === "owned-worktree-v1" &&
    exactRevisionSource(value, project, repoId) &&
    value.ready === published &&
    value.status === (published ? "complete" : "partial") &&
    value.reason === undefined &&
    value.requested_source_matches === true &&
    value.requested_revision_matches === true &&
    value.source_unchanged_during_observation === true &&
    value.default_branch_matches === true &&
    value.ambiguous_indexed_files === false &&
    value.retry_query_group === false &&
    value.mismatched_files === 0 &&
    Array.isArray(value.mismatched_paths) &&
    value.mismatched_paths.length === 0 &&
    Number.isSafeInteger(value.source_file_count) &&
    value.source_file_count >= 0 &&
    value.indexed_file_count === value.source_file_count &&
    usable(value.source_revision) &&
    usable(value.indexing_revision) &&
    usable(value.token) &&
    value.publication?.status === status &&
    usable(value.publication.token) &&
    boundary?.token === value.publication.token &&
    (boundary.status === status ||
      (published && boundary.status === undefined)) &&
    boundary.publication_unchanged_during_call === published &&
    value._meta.stale !== true &&
    Object.keys(boundary).every((key) =>
      ["status", "token", "publication_unchanged_during_call"].includes(key),
    ) &&
    ["error", "_error", "error_code", "message"].every(
      (key) => value[key] === undefined,
    )
  );
}

/** Native contention responses carry the digest of the source the writer observed. */
export function writingSourceRevision(
  value: Json | undefined,
  project: Project,
  repoId: string,
): string | undefined {
  if (
    exactRevisionSource(value, project, repoId) &&
    value?.status === "partial" &&
    value.ready === false &&
    value.reason === "index_write_in_progress" &&
    value.requested_source_matches === true &&
    usable(value.source_revision)
  )
    return value.source_revision;
}

/** Native early envelopes are progress, never evidence that a graph is ready. */
export function verifyingSourceRevision(
  value: Json | undefined,
  project: Project,
  repoId: string,
): string | undefined {
  if (
    exactRevisionSource(value, project, repoId) &&
    value?.status === "partial" &&
    value.ready === false &&
    [
      "index_write_in_progress",
      "index_verification_running",
      "branch_publication_incomplete",
    ].includes(value.reason) &&
    value.token === null &&
    value.indexing_revision === null &&
    value.requested_source_matches === true &&
    value.requested_revision_matches === true &&
    value.retry_query_group === false &&
    usable(value.source_revision) &&
    value.error === undefined &&
    value._error === undefined &&
    value.error_code === undefined
  )
    return value.source_revision;
}

/** Counts and a current repository summary are not a source/publication certificate. */
export const verifiedIndexRevision = (
  value: Json | null | undefined,
  project: Project,
  repoId: string,
) => {
  // Current native responses carry the publication boundary in the MCP
  // envelope. Older engines returned it at the top level. Prefer the envelope
  // even when it explicitly reports instability; never replace it with an older
  // top-level success value.
  const nativeEnvelopePresent =
    value?._meta != null &&
    Object.prototype.hasOwnProperty.call(value._meta, "graph_revision");
  const graphRevision = nativeEnvelopePresent
    ? value._meta.graph_revision
    : value?.graph_revision;
  return (
    ((!nativeEnvelopePresent && graphRevision == null) ||
      (graphRevision !== null &&
        typeof graphRevision === "object" &&
        !Array.isArray(graphRevision))) &&
    (project.analysisCheckout === "owned-worktree-v1" ||
      (value?.checkout_mode !== "owned-worktree-v1" &&
        value?.graph_scope !== "owned_worktree_graph")) &&
    (project.analysisCheckout !== "owned-worktree-v1" ||
      (value?.checkout_mode === "owned-worktree-v1" &&
        value?.graph_scope === "owned_worktree_graph" &&
        value?.repo_id === repoId &&
        typeof value.worktree === "string" &&
        pathKey(value.worktree) === pathKey(project.path!) &&
        value?.source_unchanged_during_observation === true &&
        graphRevision?.publication_unchanged_during_call === true)) &&
    value?.ready === true &&
    value.branch === project.branch &&
    (!value.repo_id || value.repo_id === repoId) &&
    (!value.worktree ||
      (typeof value.worktree === "string" &&
        pathKey(value.worktree) === pathKey(project.path!))) &&
    value.source_unchanged_during_observation !== false &&
    value.requested_source_matches !== false &&
    value.requested_revision_matches !== false &&
    value.default_branch_matches !== false &&
    value.publication?.status !== "partial" &&
    value.status !== "partial" &&
    graphRevision?.status !== "partial" &&
    value.retry_query_group !== true &&
    graphRevision?.publication_unchanged_during_call !== false
  );
};

/** A completed parse/embed job can precede the independent source certificate. */
export async function waitForIndexPublication(
  client: PeerIndexClient,
  project: Project,
  repoId: string,
  update: (note: string) => void,
  options: PeerIndexWaitOptions = {},
  initialRevision?: Json,
): Promise<string> {
  const now = options.now ?? Date.now,
    sleep =
      options.sleep ??
      ((ms: number) => pause(ms, undefined, { signal: options.signal })),
    path = pathKey(project.path ?? ""),
    branch = project.branch,
    started = now(),
    hardDeadline = started + (options.timeoutMs ?? 600_000),
    pollMs = Math.max(1, options.pollMs ?? 1000);
  let deadline = Math.min(
    hardDeadline,
    started +
      (options.publicationMs ??
        (options.requireCertificate ? 120_000 : 30_000)),
  );
  const assertActive = () => {
    if (
      options.signal?.aborted ||
      options.isCancelled?.() ||
      !project.path ||
      pathKey(project.path) !== path ||
      project.branch !== branch
    )
      throw Error(
        "Memtrace analysis was cancelled or its local checkout/branch changed. Its result was not adopted.",
      );
  };
  let reason = "",
    expectedSource: string | undefined,
    delay = pollMs;
  let first = true,
    waitingForOwnedPublication = false;
  while (now() < deadline) {
    assertActive();
    // Allow the first read the native request budget even if the shorter
    // polling window expires while it computes hashes for a large checkout.
    const readDeadline =
      first && options.publicationMs === undefined ? hardDeadline : deadline;
    const revision: Json =
      (first && initialRevision) ||
      (await readWithDeadline(
        (signal) =>
          client.call(
            project,
            "get_query_revision",
            {
              repo_id: repoId,
              branch,
              ...(expectedSource
                ? { expected_source_revision: expectedSource }
                : {}),
            },
            signal,
          ),
        Math.min(options.readTimeoutMs ?? 120_000, readDeadline - now()),
        "Memtrace source verification did not respond before its deadline.",
        options.signal,
      ));
    first = false;
    assertActive();
    if (
      (revision?.repo_id != null && revision.repo_id !== repoId) ||
      (revision?.worktree != null &&
        (typeof revision.worktree !== "string" ||
          pathKey(revision.worktree) !== path)) ||
      (revision?.branch != null && revision.branch !== branch)
    )
      throw Error(
        `Memtrace job completed, but current source on branch ${branch} is not verified: Memtrace reported another repository, checkout or branch. Its result was not adopted.`,
      );
    const writerSource =
      verifyingSourceRevision(revision, project, repoId) ??
      writingSourceRevision(revision, project, repoId);
    if (
      (revision?.reason === "index_write_in_progress" && !writerSource) ||
      (expectedSource &&
        (!exactRevisionSource(revision, project, repoId) ||
          revision.source_revision !== expectedSource ||
          revision.requested_source_matches === false))
    ) {
      const message =
        "Memtrace could not verify the same source revision while publishing this checkout. Retry analysis for the current files.";
      if (
        expectedSource &&
        exactRevisionSource(revision, project, repoId) &&
        usable(revision.source_revision) &&
        revision.source_revision !== expectedSource &&
        !revision.error &&
        !revision._error &&
        !revision.error_code
      )
        throw new SourcePublicationChanged(message);
      throw Error(message);
    }
    if (writerSource && !expectedSource) {
      expectedSource = writerSource;
      deadline = hardDeadline;
    }
    if (
      options.completedJob &&
      !expectedSource &&
      matchedOwnedPublication(revision, project, repoId, "partial")
    ) {
      expectedSource = revision.source_revision;
      waitingForOwnedPublication = true;
      deadline = Math.min(
        hardDeadline,
        started + (options.publicationMs ?? 120_000),
      );
    }
    const verify =
      options.requireCertificate || expectedSource
        ? certifiedPublication
        : verifiedIndexRevision;
    if (
      verify(revision, project, repoId) &&
      (!waitingForOwnedPublication ||
        matchedOwnedPublication(revision, project, repoId, "published"))
    )
      return repoId;
    reason =
      typeof revision?.reason === "string" ? revision.reason.slice(0, 200) : "";
    update(
      expectedSource
        ? `Memtrace is finishing the code graph for ${branch}. Work will continue automatically once the source is verified.`
        : `Waiting for Memtrace to verify code context on branch ${branch}…`,
    );
    if (now() >= deadline) break;
    await sleep(Math.min(delay, Math.max(0, deadline - now())));
    if (expectedSource) delay = Math.min(5000, delay * 2);
  }
  assertActive();
  if (expectedSource)
    throw Error(
      `Memtrace is still verifying the graph for ${branch} after an index write. Retry to follow the existing graph.`,
    );
  throw Error(
    `Memtrace job completed, but current source on branch ${branch} is not verified${reason ? ` (${reason})` : ""}. Retry to follow its publication; no duplicate index was queued.`,
  );
}

/** Follow an existing owner's job. Never enqueue, clear a store or infer completion from a lease. */
export async function waitForPeerIndex(
  client: PeerIndexClient,
  project: Project,
  response: Json,
  existingRepoId: string | undefined,
  update: (note: string) => void,
  options: PeerIndexWaitOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now,
    sleep =
      options.sleep ??
      ((ms) => pause(ms, undefined, { signal: options.signal })),
    started = now(),
    discoveryDeadline = started + (options.discoveryMs ?? 8000),
    deadline = started + (options.timeoutMs ?? 900000),
    pollMs = Math.min(
      10000,
      Math.max(
        options.pollMs ?? 1000,
        typeof response.retry_after_s === "number" &&
          Number.isFinite(response.retry_after_s)
          ? Math.max(0, response.retry_after_s * 1000)
          : 0,
      ),
    );
  let repoId = existingRepoId ?? response.repo_id;
  if (!project.path || (repoId !== undefined && !usable(repoId)))
    throw Error(
      "Memtrace reported a peer index without a verified repository identity and local checkout.",
    );
  if (
    (response.repo_id && response.repo_id !== repoId) ||
    (response.branch && response.branch !== project.branch)
  )
    throw Error(
      "The reported Memtrace index belongs to another repository or branch. This project's analysis was not adopted.",
    );
  const requestedPath = pathKey(project.path),
    requestedBranch = project.branch;
  const assertActive = () => {
    if (
      options.signal?.aborted ||
      options.isCancelled?.() ||
      !project.path ||
      pathKey(project.path) !== requestedPath ||
      project.branch !== requestedBranch
    )
      throw Error(
        "Memtrace analysis was cancelled or its local checkout/branch changed. Its result was not adopted.",
      );
  };
  const read = async (name: string, args: Json): Promise<any> => {
    assertActive();
    const result = await readWithDeadline(
      (signal) => client.call(project, name, args, signal),
      Math.min(
        options.readTimeoutMs ??
          (name === "get_query_revision" ? 120_000 : 8000),
        deadline - now(),
      ),
      `Memtrace ${name} did not respond while inspecting the existing index.`,
      options.signal,
    );
    assertActive();
    return result;
  };
  const belongs = (job: Json) =>
    !!job &&
    typeof job === "object" &&
    job.repo_id === repoId &&
    typeof jobPath(job) === "string" &&
    pathKey(jobPath(job)) === pathKey(project.path!) &&
    (!jobBranch(job) || jobBranch(job) === project.branch);
  const hint = response.job_id ?? response.blocking_job?.id;
  const fail = (job: Json): never => {
    throw Error(
      `Memtrace indexing job ${job.id} failed: ${job.error ?? job.message ?? "The engine did not provide an error."}`,
    );
  };
  let backgroundObserved = false;
  const binding = async (trackedJob = false) => {
    if (!repoId) {
      const listed = await read("list_indexed_repositories", {});
      const repos = Array.isArray(listed)
        ? listed
        : (listed?.repos ?? listed?.repositories ?? []);
      const match = repos.find(
        (repo: Json) =>
          pathKey(repo.repo_path ?? repo.path ?? "") === requestedPath &&
          (!repo.branch || repo.branch === requestedBranch),
      );
      if (!usable(match?.repo_id)) return null;
      repoId = match.repo_id;
    }
    const value = await read("get_query_revision", {
      repo_id: repoId,
      branch: requestedBranch,
    });
    if (writingSourceRevision(value, project, repoId!))
      return waitForIndexPublication(
        client,
        project,
        repoId!,
        update,
        { ...options, timeoutMs: Math.min(600_000, deadline - now()) },
        value,
      );
    const exactSource =
      value?.repo_id === repoId &&
      typeof value.worktree === "string" &&
      pathKey(value.worktree) === requestedPath &&
      value.branch === requestedBranch;
    if (exactSource) backgroundObserved = true;
    const verify = options.requireCertificate
      ? certifiedPublication
      : verifiedIndexRevision;
    if (!verify(value, project, repoId)) return null;
    if (!trackedJob && !exactSource) {
      const listed = await read("list_indexed_repositories", {});
      const repos = Array.isArray(listed)
        ? listed
        : (listed?.repos ?? listed?.repositories ?? []);
      if (
        !repos.some(
          (repo: Json) =>
            repo.repo_id === repoId &&
            pathKey(repo.repo_path ?? repo.path ?? "") === requestedPath &&
            (!repo.branch || repo.branch === requestedBranch),
        )
      )
        return null;
    }
    return value;
  };
  let current: Json | undefined;
  const publicationDeadline = Math.min(
    deadline,
    started + (options.publicationMs ?? 120000),
  );
  while (now() <= deadline) {
    assertActive();
    const listed = await read("list_jobs", {});
    const jobs: Json[] = Array.isArray(listed)
      ? listed
      : Array.isArray(listed?.jobs)
        ? listed.jobs
        : [];
    const scoped = [
      ...new Map(
        jobs
          .filter(belongs)
          .filter((job) => usable(job.id))
          .map((job) => [job.id, job]),
      ).values(),
    ];
    if (usable(hint)) {
      const hinted =
        jobs.find((job) => job.id === hint) ??
        (await read("check_job_status", { job_id: hint }).catch(() => null));
      if (hinted && !belongs(hinted))
        throw Error(
          "The existing Memtrace job does not match this local checkout and branch. Its result was not adopted.",
        );
      if (hinted?.status === "failed") fail(hinted);
      if (
        hinted &&
        ["pending", "running", "paused", "completed"].includes(hinted.status)
      )
        current = hinted;
    }
    if (!current) {
      const active = scoped.filter((job) =>
        ["pending", "running", "paused"].includes(job.status),
      );
      if (active.length > 1)
        throw Error(
          "Memtrace lists multiple active jobs for this checkout. Inspect its jobs before reconnecting; no index was queued again.",
        );
      current = active[0];
    }
    if (current) break;
    if (await binding()) return repoId!;
    const acquired =
      typeof response.acquired_at === "string"
        ? Date.parse(response.acquired_at)
        : Number.NaN;
    const failed = scoped
      .filter(
        (job) =>
          job.status === "failed" &&
          Number.isFinite(Date.parse(job.updated_at)) &&
          Date.parse(job.updated_at) >=
            (Number.isFinite(acquired) ? acquired : started - 15000),
      )
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    if (failed[0]) fail(failed[0]);
    const waitUntil = backgroundObserved
      ? publicationDeadline
      : discoveryDeadline;
    if (now() >= waitUntil) break;
    update(
      backgroundObserved
        ? "Waiting for Memtrace startup to publish verified code context…"
        : "Memtrace reported an index owner; checking for this checkout's active job…",
    );
    await sleep(Math.min(pollMs, Math.max(0, waitUntil - now())));
  }
  if (!current && backgroundObserved)
    throw new StartupPublicationTimeout(
      "Memtrace's startup graph has not finished verifying this checkout and branch. Retry to follow its publication; no duplicate index was queued.",
    );
  if (!current)
    throw Error(
      "Memtrace reported another index owner, but no active job for this local checkout and branch could be verified. The owner may still be starting or its lease may be stale. Retry when it is ready; no duplicate index was queued.",
    );
  let followed: Json = current;
  const trackedId = followed.id;
  while (now() <= deadline) {
    assertActive();
    if (!belongs(followed))
      throw Error(
        "The existing Memtrace job changed repository or checkout scope. Its result was not adopted.",
      );
    if (followed.status === "failed") fail(followed);
    if (followed.status === "paused")
      throw Error(
        `Memtrace indexing job ${followed.id} is paused: ${followed.message ?? followed.stage ?? "Check the engine diagnostics."}`,
      );
    if (followed.status === "completed") {
      // Current Rust jobs omit branch while active. Their completion is useful
      // only after the engine independently certifies this exact branch/source.
      return waitForIndexPublication(client, project, repoId!, update, {
        ...options,
        completedJob: true,
        now,
        sleep,
        pollMs,
        timeoutMs: Math.min(600_000, deadline - now()),
      });
    }
    if (!["pending", "running"].includes(followed.status))
      throw Error(
        `Memtrace indexing job ${followed.id} is ${followed.status ?? "unavailable"}. Check the engine diagnostics before reconnecting.`,
      );
    const progress = followed.progress;
    const measured =
      typeof progress?.completed === "number" &&
      typeof progress.total === "number" &&
      progress.total > 0
        ? ` · ${progress.completed}/${progress.total} ${progress.unit ?? "items"}`
        : "";
    update(
      `Following Memtrace job ${followed.id} · ${followed.stage ?? followed.status}${measured}${followed.message ? " · " + String(followed.message).slice(0, 300) : ""}`,
    );
    if (now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    const status = await read("check_job_status", { job_id: trackedId });
    if (!status || status.id !== trackedId)
      throw Error(
        `Memtrace could not verify status for indexing job ${trackedId}. Its result was not adopted.`,
      );
    followed = status;
  }
  throw Error(
    `Memtrace job ${followed.id} is still running. Reconnect to follow that existing job; no duplicate index was queued.`,
  );
}
