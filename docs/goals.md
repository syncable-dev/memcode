# How goals work

A **goal** is an outcome you want, like “Customers can export reports”. A **task**
is one piece of work a worker does. **Quick changes** are small tasks that ship
together. You never need this page to use MemCode; it explains what happens
underneath when you plan, run and ship goals.

## From a request to a plan

Choose **New work** (or press **C**) and say what you want. Your connected worker
reads the code and plans it. Nothing changes yet.

- One small task becomes a quick change.
- Bigger work becomes a goal with a few tasks.
- Separate outcomes become separate goals.
- If an open goal is already changing the same code, the new work joins it.
  MemCode compares the files the plan touches with each open goal's files and
  names the shared file when it suggests joining.

Without a connected worker, the request becomes one task you can edit. The review
screen shows the plan and where each part goes. Change either, then add it, or add
it and start.

## Each goal works in its own space

Every goal gets its own branch and an isolated workspace: a Git worktree that
MemCode keeps under its local profile. Your own checkout and its uncommitted
changes stay where they are. Worktrees share Git's object storage, so MemCode does
not clone the repository for each goal or create a checkout for each worker.
Reopening a goal reuses its branch and keeps its unfinished changes. A foreign
branch, checkout identity or filesystem link is an error to inspect, never
permission to reset files.

A new goal starts from your team's **integration branch**. MemCode reads it from
where merged pull requests actually went (or from merge commits when the GitHub
CLI isn't available) and picks the most common target, such as `dev`, `staging`
or `main`. With no history yet, it uses `develop`, `development` or `dev` when one
exists, and otherwise the repository's default branch. Branch names follow the
team's prefix (for example `feat/`); a taken name gets a numeric suffix, so new
work never picks up an old branch.

You can change where goals start on the **Roadmap** (`runtime/branches.ts`,
`src/components/Roadmap.tsx`):

- **Goals branch from**, beside New goal, shows the base. Opening it says which
  rule chose it, for example "34 of your last 40 merged pull requests went to
  dev". Pick a branch to always use it (saved as the project's `baseBranch`), or
  go back to letting MemCode work it out.
- Each goal card has a branch line. Before a goal's work starts it reads "New
  branch from dev when work starts", and you can pick another branch for that goal
  alone (its own `baseBranch`, which wins over the project's). Once a worker has
  run, it shows the goal's branch. A goal that names a branch no worker here has
  used, such as one copied from another project, offers **Start fresh from dev**:
  its next work gets a new branch from the base. A goal whose work has started
  keeps its branch; use Update from its base instead.

The project switcher shows the GitHub repository (owner/name) under the project's
name, or the folder's name when it has no GitHub remote. Nothing here deletes or
switches a branch.

### When a goal ships

After a goal's pull request merges, MemCode tidies up its checkout
(`runtime/shipped-goal.ts`, ADR-0001):

1. It keeps the checkout as it is if a worker is still running there or the checkout
   has changes that aren't committed.
2. It stops the goal's own code index and asks the project's engine to count the
   goal's history (`import_goal_history` with `dry_run`), then to add it to the
   project's index: the goal's saves, the code versions they made and its Fleet
   records, under the goal's branch, marked as merged into the pull request's base.
   Searches on that base then include the goal's steps.
3. It moves the tasks' records (the change journal behind Changes and code review,
   and the documents workers made) into MemCode's data folder, so they still open.
4. Only if the import moved what the count said does it remove the checkout with
   `git worktree remove`. The branch stays.

If anything stops it, nothing is removed and the Roadmap's shipped note says why,
for example when the bundled engine can't import goal history yet.

## Tasks in a goal share it

Tasks in one goal run side by side on the goal's branch and workspace, and their
workers edit at the same time. Nothing is locked and nobody takes turns.

Before each group of edits a worker **declares** what it is about to change: the
symbols (as `file::symbol`), the kind of change, and why. MemCode passes that to
Memtrace Fleet and answers with who is editing those symbols right now and what
changed there lately. The worker edits straight away. Right after the edit it
**records** it and gets a class:

- **A.** Nobody else was on those symbols. Carry on.
- **B.** Another worker changed the same symbol at the same time, compatibly. Both
  edits are in the files; the worker re-reads the symbol and builds on it.
- **C.** A change that breaks callers (a signature change, a move or a removal) met
  another worker's edit. The workers involved read each other's reasons and judge:
  the two fit together, one should stand, or it is a question for a person.

Workers hear about each other's changes as they land. A worker cannot be
interrupted mid-thought, so the update arrives with its next call to MemCode: who
changed what, what kind of change, and why. It then carries on, re-aligns its own
work, or objects when asked to judge.

**When a person is asked.** Fleet's referee settles a class C without you when the
order is safe (a signature change over an ordinary edit) or when the workers
involved agree. It comes to **Decisions** when they disagree, when one of them
asks, or when code is being moved or removed under someone's edit. The decision
shows what each worker is changing, why, and its verdict. Only the contested
symbols are held meanwhile. The workers carry on with the rest and hear your
decision at once.

**Workers wait for you.** A worker never edits contested code while a decision is
open. When it has nothing else left to do, it stops and its task shows **Paused
until you decide**; it is not handed to review half done. When you decide, MemCode
brings that worker back with your decision as its next instruction: go ahead, or
rebuild on the change that stands. Take as long as you need.

**Two tasks, two shapes.** When one task has changed a symbol's signature, moved
it or removed it, and a second task in the goal wants to reshape the same symbol
differently, the second worker is stopped before it edits. Otherwise whichever
went in last would quietly replace the other. You choose which shape stands, and
the decision shows what each task wants. This holds until the first task's work
has been accepted; after that its shape is simply the code to build on.

**The one short hold.** While a worker is changing a symbol's signature, moving it
or removing it, another worker that wants the same symbol holds off until that
change is recorded, then builds on the new version. It keeps working on its other
symbols meanwhile.

**Whose change is whose.** Every file being edited has one moving baseline per
goal: whoever records next is credited with what changed since. Each change is
recorded exactly once. When two workers had unrecorded edits in the same file, the
record says so, and code review still shows each task its own lines.

Limits worth knowing. Fleet does not merge text: both edits land because each
worker's edit tool patches the file as it is at that moment. A worker that edits
without declaring is still recorded for its planned files when its turn ends, but
its peers hear about it late. Fleet coordination is cooperative; it is not an
operating-system fence against arbitrary file writes.

Parallel goals require the engine's explicit `owned-worktree-v1` capability. Each
goal has one private source graph and certificate, shared by its task workers. An
older engine keeps running goals one at a time; passing an unsupported worktree
argument cannot make canonical measurements private.

The owner manifest lives inside the goal's checkout and names exactly that root.
Its graph store is confined to the manifest's `.memdb` directory. The native engine
binds that store to the checkout's Git identity across restarts and refuses to
index another path. Quality, impact, source retrieval and live updates use this
owned graph.

Fleet operations use the original project broker, the goal's actual branch and
stable `file::symbol` identities. Workers in one goal see each other's
declarations and changes. Workers in different goals are never peers. Accepted
repository decisions stay shared through the canonical decision-memory broker;
current source facts always come from the selected goal.

## Quick changes

Small tasks without a goal share one **Quick changes** batch per project: one
worktree, one short-lived branch, one pull request. The batch closes when its pull
request merges. A batch whose base moved takes no new tasks, so the next small task
starts a fresh one.

## Shipping a goal

A goal is one branch, so its tasks ship together in one pull request. When every
task is in review, the goal's card shows **Create pull request** (or **Ship quick
changes** for the Quick changes batch). The sheet lists each step before it runs:
commit the goal's files, push its branch, open the pull request. The GitHub CLI
creates it when installed; otherwise GitHub opens in the browser with the title and
description filled in.

The description is written for reviewers: a summary, each task's change in the
worker's own report with local paths made repo-relative, decisions a person made,
and a test plan. **Add a MemCode line** adds one line to it and an
`Orchestrated-by:` trailer to the commit.

With the GitHub CLI, the sheet also shows the pull request's reviews and checks.
**Merge pull request** is available when GitHub would merge it, using the
repository's merge method; otherwise the sheet says why. Merging closes the goal and
moves its reviewed tasks to Done.

## Keeping goals current

When a goal merges, MemCode compares the files it changed with each open goal's
files. Only goals that share files are marked **Needs update**; the open Quick
changes batch always is, because its base moved. **Update from dev** (named after
the goal's integration branch) saves the goal's work as a commit, merges the newer
integration branch and refreshes that goal's code graph, which takes about a minute
on a mid-size repository. A conflicting update is aborted in full and names the
files. Stop affected workers before updating, then run the relevant checks.

## Nothing happens without a click

Commit, push, pull-request creation, merge and Update from dev happen only from an
explicit action that lists each step first. MemCode never deploys.

## Prerequisites across goals

A prerequisite in another goal being marked Done is not enough. Before starting the
dependent worker, MemCode checks that the prerequisite's checkpointed file content
is present in the target checkout. A missing or different contribution blocks the
start and names the prerequisite and file. This is intentionally conservative:
matching file bytes prove a concrete handoff, not semantic compatibility or passing
tests.

## Teams

Each team member runs workers and analysis on their own local checkout. The shared
board and comments do not sync uncommitted source or create cross-machine Fleet
authority. Use Git to receive another developer's changes.

## Keeping resource use bounded

Worker preparation is serialized, while running workers and code reviews share the
configured worker limit. Reviews in one goal wait for editing to settle and run one
at a time; a waiting goal does not block another eligible goal. An active goal has
one graph owner, however many workers it has. Goal owners use structural and
lexical retrieval without loading another embedding model. The project can keep its
normal semantic setup separately.

An idle goal's MemCode-owned graph process is retired after its workers and reviews
finish. Its checkout, reports and graph cache stay on disk for reuse. MemCode never
stops a graph process borrowed from an external Memtrace session. Several active
goals still use more memory and disk space; shared Git storage does not make those
costs disappear.

The [task review guide](story-code-review.md) explains the review lane, coverage,
findings, the reviewer conversation and sending fixes back to a worker.
