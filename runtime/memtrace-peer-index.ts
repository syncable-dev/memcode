import type { Project } from "../src/shared";

type Json = Record<string, any>;
interface PeerIndexClient {
  call(project: Project, name: string, args: Json): Promise<any>;
}
export interface PeerIndexWaitOptions {
  discoveryMs?: number;
  timeoutMs?: number;
  readTimeoutMs?: number;
  pollMs?: number;
  publicationMs?: number;
  isCancelled?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
const pathKey = (value: string) => {
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

/** Counts and a current repository summary are not a source/publication certificate. */
export const verifiedIndexRevision = (
  value: Json | null | undefined,
  project: Project,
  repoId: string,
) =>
  (project.analysisCheckout !== "owned-worktree-v1" ||
    (value?.checkout_mode === "owned-worktree-v1" &&
      value?.graph_scope === "owned_worktree_graph" &&
      value?.repo_id === repoId &&
      typeof value.worktree === "string" &&
      pathKey(value.worktree) === pathKey(project.path!) &&
      value?.source_unchanged_during_observation === true &&
      value?.graph_revision?.publication_unchanged_during_call === true)) &&
  value?.ready === true &&
  value.branch === project.branch &&
  (!value.repo_id || value.repo_id === repoId) &&
  (!value.worktree || pathKey(value.worktree) === pathKey(project.path!)) &&
  value.source_unchanged_during_observation !== false &&
  value.requested_source_matches !== false &&
  value.requested_revision_matches !== false &&
  value.default_branch_matches !== false &&
  value.publication?.status !== "partial" &&
  value.status !== "partial" &&
  value.graph_revision?.status !== "partial" &&
  value.retry_query_group !== true &&
  value.graph_revision?.publication_unchanged_during_call !== false;

/** A completed parse/embed job can precede the independent source certificate. */
export async function waitForIndexPublication(
  client: PeerIndexClient,
  project: Project,
  repoId: string,
  update: (note: string) => void,
  options: PeerIndexWaitOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now,
    sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    path = pathKey(project.path ?? ""),
    branch = project.branch,
    deadline = now() + (options.timeoutMs ?? 30_000),
    pollMs = Math.max(1, options.pollMs ?? 1000);
  const assertActive = () => {
    if (
      options.isCancelled?.() ||
      !project.path ||
      pathKey(project.path) !== path ||
      project.branch !== branch
    )
      throw Error(
        "Memtrace analysis was cancelled or its local checkout/branch changed. Its result was not adopted.",
      );
  };
  let reason = "";
  while (now() < deadline) {
    assertActive();
    let timer: ReturnType<typeof setTimeout> | undefined, revision: Json;
    try {
      revision = await Promise.race([
        client.call(project, "get_query_revision", { repo_id: repoId, branch }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  "Memtrace source verification did not respond before its deadline.",
                ),
              ),
            Math.max(
              1,
              Math.min(options.readTimeoutMs ?? 5000, deadline - now()),
            ),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
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
    if (verifiedIndexRevision(revision, project, repoId)) return repoId;
    reason =
      typeof revision?.reason === "string" ? revision.reason.slice(0, 200) : "";
    update(`Waiting for Memtrace to verify code context on branch ${branch}…`);
    if (now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  assertActive();
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
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        client.call(project, name, args),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  `Memtrace ${name} did not respond while inspecting the existing index.`,
                ),
              ),
            options.readTimeoutMs ?? 8000,
          );
        }),
      ]);
      assertActive();
      return result;
    } finally {
      clearTimeout(timer);
    }
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
    const value = await read("get_query_revision", { repo_id: repoId });
    const exactSource =
      value?.repo_id === repoId &&
      typeof value.worktree === "string" &&
      pathKey(value.worktree) === requestedPath &&
      value.branch === requestedBranch;
    if (exactSource) backgroundObserved = true;
    if (!verifiedIndexRevision(value, project, repoId)) return null;
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
    throw Error(
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
        now,
        sleep,
        pollMs,
        timeoutMs: Math.min(options.publicationMs ?? 30_000, deadline - now()),
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
