# ADR-0001: Keep a shipped goal's history in the project's index

- Status: Accepted
- Date: 2026-11-23

## Context

### What a person expects

After a goal ships, "how did this come about?" should still be answerable from the
project: which worker changed which code, in what order and why, labelled with the
goal and its branch. A worker on a later goal that asks why some code is there should
get the earlier goal's reasoning, not only a commit message. Nobody expects each
finished goal to keep costing a gigabyte of disk.

### What happens today

- Every goal gets its own Git worktree under MemCode's data folder
  (`<data>/epic-checkouts/<id>`, `runtime/epic-checkout.ts`) and its own Memtrace
  store inside it (`<checkout>/.memcode/memtrace`, `projectMcpWorkspace` with
  `checkout_mode = "owned-worktree-v1"`, `runtime/memtrace-workspace.ts`).
- That store holds the checkout's whole current structure plus the goal's own live
  edit episodes. It is started with `MEMTRACE_NO_REPLAY=1` and `MEMTRACE_SKIP_EMBED=1`
  (`runtime/memtrace.ts`): "Git history belongs to the primary project graph.
  Replaying it in every epic duplicates work and holds its current-source publication
  while workers and reviews need that exact checkout's live structure."
- Separate stores were chosen so goals run side by side without waiting for the
  project's history import or for each other, and so Fleet admission, leases and
  reviews read the exact structure of that goal's checkout (introduced in `f8d2672`,
  hardened during beta.18: `docs/beta18-history-independence-handoff.md`).
- Shipping makes one commit of the goal's work (`commitAll`,
  `runtime/pull-request.ts`); the merge sets `closedAt`. The project's own index, and
  every goal started afterwards, only ever see that commit. MemCode stops the goal's
  engine when it is idle (`releaseEpic`), the goal leaves the Roadmap, and nothing
  reads its store again. Nothing removes it either.
- Measured on the owner's Mac (2026-11-23): 6 goal checkouts, 3.2 GB. Each goal's
  store is 0.4–1.1 GB, almost all of it a copy of the whole project's structure
  (`paged-records`); the goal's own edits are a small part. Task records
  (`.memcode/workers/<task>`: change journals for Changes and code review, worker
  documents and images) total about 32 MB. Installed packages are about 0.8 GB.

So nothing is deleted when a goal merges, but its step-by-step history is already
unreachable, and a full copy of the project's structure is kept for every goal
forever.

### Constraints

- Episodes are append-only. Save-by-save history is never deleted or pruned.
- A goal's workers must keep reading their own checkout's live structure, and goals
  must keep running in parallel without waiting on each other or on history import.
- Task records (`.memcode/workers/<task>`) stay readable after shipping: the Changes
  tab, code review and the worker's documents are opened after a goal ships.
- Removing a goal's checkout is safe only when it has no uncommitted or untracked
  work and no worker or review is using it.

### What the engine can do today (Memtrace `staging`, 414287019)

- **One index can hold several branches.** Versions are keyed by symbol, branch and
  time; a feature branch inherits main; a write on one branch never supersedes
  another branch's current row (`partition_nodes_open_aware`,
  `crates/code-intelligence/src/graph/memdb.rs:740`, since `3ef92bae0`).
  `sweep_stale_branches` keeps a merged branch's versions and episodes.
- **But a linked worktree's saves don't become history there.** In the project's
  index a worktree only refreshes "overlay" rows with the latest file state and
  records no episode (`crates/memtrace-mcp/src/watcher.rs:3795-3830`).
- **Nothing copies history between indexes.** `record_external_episode` refuses
  `working_tree` and `git_commit` episodes and makes new ids
  (`tools/external.rs:55-61`); `ingest_graph_fragment` writes nodes without
  episodes; `replay_history` rebuilds commits only, never saves.
- **Fleet's records live in the goal's index.** Intents, reasons and A/B/C classes
  are episode rows in the same store, plus `fleet-provenance.jsonl` next to it.
  Deleting a goal's index deletes them. Cortex decisions are separate
  (`~/.memtrace/cortex-store`) and survive.
- **Searching dev can't see a merged branch.** Evolution filters by exact branch
  name or returns every branch; lineage lets a feature see main, never main see a
  merged feature.
- **The goal-index mode isn't on `staging`.** `owned-worktree-v1` (`88a9e5dd4` and
  follow-ups) lives only on MemCode engine branches such as
  `beta/memcode-engine-1.2.21`. Engine work for this decision has to land on the
  line MemCode's engine is built from, and that line needs merging back.

### Options considered

1. **Leave it.** History is kept but unreachable; every finished goal keeps a full
   copy of the project's structure. Rejected: it meets neither expectation.
2. **Remove a shipped goal's checkout.** Frees the disk. Rejected: it deletes the
   goal's save history, its Fleet records, its tasks' change journals and its
   workers' documents.
3. **Goals write into the project's index from the start.** No copies at all.
   Rejected for now: it brings back the waiting that separate indexes removed (one
   owner, one live branch per repository per process, history import gating work),
   and it needs the largest engine change (worktree saves as full branch versions
   and episodes instead of overlays, several live branches per process).
4. **Fold a shipped goal's own history into the project's index, then drop the
   copy.** Goals stay isolated while they run. At ship time only what the goal
   itself produced moves: its save episodes, the symbol versions they created, and
   its Fleet records. The copied structure doesn't move; the project's index already
   has it.

## Decision

We will do option 4.

**Engine (Memtrace):**

1. An "import branch history" operation that appends one goal index's own
   episodes, with the node and edge versions they created and its Fleet records,
   into the project's index under the goal's branch name. It keeps episode ids,
   times, `episode_uuid`/`invalidating_episode_uuid` links, agent and seat
   attribution and diffs; maps the goal's `repo_id` and paths onto the project's;
   writes through the branch-aware partition so dev's rows are untouched; and is
   idempotent (a second run adds nothing, and it doesn't duplicate commit episodes a
   replay already recorded).
2. Searches on dev include branches merged into dev, labelled with their branch, so
   "how did this come about?" finds the goal's steps.
3. A count it returns (episodes, versions, Fleet records) that MemCode can compare
   with the goal index before anything is removed.

**MemCode:**

1. Task records move out of the checkout into MemCode's own data folder, and every
   reader (`runtime/changes.ts`, `runtime/files.ts`, `runtime/artifact-catalog.ts`,
   `runtime/fleet-source.ts`, `runtime/fleet.ts`, `runtime/claude-changes.ts`,
   `runtime/code-review-snapshot.ts`, `runtime/measurement-audit.ts`) finds them
   through one function instead of joining `task.run.workspace` itself.
2. When a goal's merge is recorded (`finishMerge`), MemCode imports its history,
   checks the counts, and only then removes the checkout with `git worktree
   remove` (never forced): no uncommitted or untracked work, and no worker or review
   using it. The branch stays. If any check fails, everything stays and the goal
   says why.
3. Until the engine operation ships, nothing is removed. A shipped goal may free
   its installed packages only.

## Consequences

- A finished goal's steps, workers and reasons become searchable from the project
  and from later goals, under the goal's branch name.
- Disk returns to roughly one copy of the project's structure plus each goal's own
  history; the 0.4–1.1 GB per finished goal goes away once its import is verified.
- Goals keep running side by side without waiting on each other.
- Work splits across two repositories: engine first (import, merged-branch search,
  counts), then MemCode (task records, the ship step). The engine's MemCode support
  must be merged onto the line MemCode builds from.
- A goal shipped before this lands still has its index on disk; the same import
  can be run on it later, so nothing already recorded is lost.
- Squash merges: dev holds one commit for the goal, while the imported history
  carries the steps under the goal's branch. Searches must show both without
  counting the change twice.

## Engine implementation notes (2026-11-23, branch `feat/import-goal-history`)

- The engine tool is `import_goal_history` (`goal_store`, `goal_checkout`,
  `repo_id`, `project_path`, `branch`, `merged_into`, `dry_run`). It returns
  counts of episodes, Fleet records, nodes, edges and rows already imported.
- Every imported record carries `imported_from` (`<goal store>:<rid>`, what makes
  a second import add nothing) and `merged_into`. Evolution and change searches
  on a branch include episodes stamped as merged into it.
- A branch purge keeps imported history and reports how many episodes it kept.
- Known gap: a symbol the goal deleted is not carried. The engine has no
  branch-scoped deletion (a feature branch can only close its own versions, never
  inherited ones), and `invalidating_episode_uuid`, which evolution reads for
  removals, is not written anywhere. That needs an engine branch-model change.
- Not yet copied: Fleet's `fleet-provenance.jsonl` file next to the goal store.

## MemCode implementation notes (2026-11-23, branch `feat/ship-goal-history`)

- `runtime/worker-records.ts`: one function says where a task's records are. A task
  gets `run.records` once its goal has shipped; documents are re-pointed with it.
- `runtime/shipped-goal.ts`: after `finishMerge`, in the background, it checks for
  running workers and uncommitted work, releases the goal's engine, runs
  `import_goal_history` as a dry run and for real, compares the counts, moves the
  task records, then runs `git worktree remove` without `--force`.
- A goal whose checkout stays gets `checkoutKept`, shown in the Roadmap's shipped
  note. With an engine that has no `import_goal_history`, every checkout stays.
