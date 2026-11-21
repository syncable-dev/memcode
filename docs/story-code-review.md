# Review a task

Move a finished task into **Code review** to queue its review. Open its card and
choose **Code review** between Changes and Artifacts to follow the checks. You can
also start or repeat a review manually while the task is in that lane. The initial
checks run in the local engine. A separate read-only model reviewer then explains
the captured patch and measurements; you can ask follow-up questions in that same
review discussion. It normally uses the task's selected worker and model, with
the confirmed reviewer model shown in the report.

The review captures the task's attributed changes, runs Memtrace's native code
review detectors, measures the changed functions, traces their impact, and links
the recorded verification to that exact source snapshot. The progress steps show
what has finished and what still needs attention.

## Read the result

Start with the outcome and coverage. A maintainability score describes measured
code structure; it is not a probability that the change is correct. Missing or
stale measurements do not become a passing score. Open a finding to see its rule,
source location, detector evidence and affected code before deciding what to do.

### Compare the quality

**Before & after** lists every function reported in the review. Each cell shows
its before and after measurements. A dash marks an unavailable value. Select a
function name to open its current source or inspect the captured changes for a
removed declaration. **Matched function averages** shows how maintainability,
cognitive complexity, cyclomatic complexity and nesting changed across functions
with both measurements. Each chart gives its own matched function count.

A native maintainability value of **0** is a measured result. It is different
from a dash, which means the engine did not supply that measurement. Reducing
complexity does not guarantee that every other metric increases.

In a team project, the saved review appears on every member's card, including
all per-function measurements and coverage notes. Ask a question from either
computer; the existing review host answers in the same shared discussion.
**Review on [device]** requests a new review on that host while the task is in
the Code review lane. The implementation session and its approvals stay there.
If the host is offline, the request remains queued. The application does not
run a second review against a different local checkout.

Both sides are measured by Memtrace's native AST parser from the captured source,
without changing your checkout or opening another index. New and removed
functions stay separate. Renames, duplicate declarations, missing measurements
and bounded comparison coverage are labelled instead of being counted as zero.
These are measurements of the captured change, not a correctness grade or a
project-wide trend.

An older engine or a report saved before comparisons were supported can show
current measurements without a baseline. Update the engine and run a new review
to capture both sides. Existing reports are not silently rewritten.

### Dismiss a finding deliberately

Open a finding and choose **Dismiss with reason**. Select a reason, add your
explanation and choose **Save dismissal**. This saves a decision; it does not
start a worker, accept the task or mark a check as passed.

Dismissed findings move into **Dismissed findings**, with the original evidence,
your explanation, identity and time. Choose **Reopen finding** to return one to
the active list. Decisions and earlier reopen events remain in the saved review
conversation and history. A fresh review evaluates its findings again; a dismissal
is not a permanent suppression of that rule.

Finding decisions can be changed only while the task is in Code review and the
captured source is still current. Acceptance and Done keep the saved decisions
readable. Failed checks and incomplete coverage still need attention after all
findings have been dismissed.

The review uses Memtrace's AST, rule-pack, cross-module and online checks. Native
detector coverage is retained in the report. Checks must be linked to this task's
implementation and the captured source to count as verification.

Ask the reviewer about a finding or a tradeoff in the review conversation. This
assistant reads the saved, bounded review evidence; it does not edit files or run
commands. Select findings and request fixes to send an ordinary follow-up to the
task's implementation worker. Review the resulting changes again before accepting.

Only tasks in the Code review lane can start a new review. Saved reports and
their conversations remain available in **Ready for acceptance** and **Done**.
Acceptance is a developer action, not an automatic consequence of a worker exiting.

## Several tasks and goals

Reviews wait while workers in the same goal are editing. One goal can review while
another goal implements a task. Implementation workers, initial reviews and
reviewer answers share the local worker limit in Settings. Requests waiting for
capacity do not keep another idle goal's graph resident unnecessarily.

A new implementation pass interrupts an active review of that goal before editing
starts. Its findings cannot certify the newer source. One automatic recovery pass
may capture fresh evidence after editing settles; repeated interruption remains
visible for the developer to review. Cancellation or moving out of Code review
does not silently start another pass.

When every task in a goal has been reviewed, ship the goal. See
[How goals work](goals.md) for branches, prerequisites, shipping and keeping goals
current.

## Current preview boundaries

The desktop preview does not yet provide permanent rule suppression or publishing
review findings as GitHub pull request comments. Native before-change file content is also
supplied to the detectors. Reviewer
answers use a saved evidence capsule rather than unrestricted live repository
tools. Complete review reports and conversations stay on this device; Team Sync
shares planning and explicitly published results.
