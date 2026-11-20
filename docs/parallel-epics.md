# Parallel epics

Keep stories that build one outcome in the same epic. Their workers share an epic
branch and coordinate before editing through Memtrace Fleet. A different epic uses
a separate Git worktree. Both worktrees share Git's object storage; MemCode does
not create a clone for each epic or a checkout for each worker.

Your existing checkout and uncommitted changes stay where they are. MemCode keeps
managed epic checkouts under its local profile. Reopening an epic reuses its branch
and preserves its unfinished changes. A foreign branch, checkout identity or
filesystem link is an error to inspect, never permission to reset files.

## Analysis and coordination

Parallel execution requires the engine's explicit `owned-worktree-v1` capability.
Each epic has one exact private source graph and certificate, shared by its story
workers. An old engine continues to use sequential epic execution; passing an
unsupported worktree argument cannot make canonical measurements private.

The owner manifest lives inside the linked checkout and names exactly that root.
Its graph store is confined to the manifest's `.memdb` directory. The native engine
binds that store to the checkout's Git identity across restarts and refuses indexing
another path. Quality, impact, source retrieval and live updates use this owned graph.

Fleet operations use the original project broker, the actual epic branch and stable
source-file identities. Workers within an epic see each other's plans and handoffs.
Different epic branches do not contend for an identical file reservation. Accepted
repository decisions remain shared through the canonical decision-memory broker;
current source facts always come from the selected epic.

## Bringing changes together

Worktrees isolate ongoing edits. MemCode integrates only when you click, after
listing each step: **Create pull request** commits and pushes a goal's branch and
opens its PR, **Merge** merges an approved PR through the GitHub CLI, and **Update
from dev** brings the integration branch into a goal. It never deploys.

New goals branch from the team's integration branch, read from where merged pull
requests actually went (`dev` before `main` when both exist), and follow the team's
branch naming. When a goal merges, MemCode compares the files it changed with each
open goal's files. Only goals that share files are marked **Needs update**; the open
Quick changes batch always is, because its base moved. Updating saves the goal's
work as a commit, merges the newer integration branch, and refreshes that goal's
code graph (about a minute on a mid-size repository). A conflicting update is
aborted in full and names the files. Stop affected workers before updating, then
run the relevant checks.

Small tasks without a goal share one **Quick changes** batch per project: one
worktree, one branch, one pull request. A batch closes when its PR merges; a batch
whose base moved takes no new tasks, so the next small task starts a fresh one.

A cross-epic prerequisite being marked Done is insufficient. Before starting the
dependent worker, MemCode checks that its checkpointed prerequisite file content is
present in the target checkout. A missing or different contribution blocks startup
with the prerequisite and file named. This is intentionally conservative: matching
file bytes prove a concrete handoff, not semantic compatibility or passing tests.

Team members still execute workers and analyze their own local checkout. The shared
board and comments do not synchronize uncommitted source or create cross-machine
Fleet authority. Use Git to receive another developer's source changes.

## Keeping resource use bounded

Worker preparation is serialized, while launched workers and code reviews share the
configured worker limit. Reviews of the same epic wait for editing to settle and run
one at a time; a waiting epic does not block another eligible epic. An active epic has one graph owner, regardless of its worker
count. Epic owners use structural and lexical retrieval without loading another
embedding model. The project can retain its normal semantic setup separately.

The [story review guide](story-code-review.md) explains the review lane, coverage,
findings, reviewer conversation and sending fixes back to a worker.

An idle epic's MemCode-owned graph process is retired after workers and reviews
finish. Its checkout, reports and graph cache remain on disk for reuse. MemCode never
stops a graph process borrowed from an external Memtrace session. Multiple active
epics still consume additional memory and working-file space; shared Git storage
does not make those costs disappear.
