# Review a story

Move a finished story into **Code review** to queue its review. Open its card and
choose **Code review** between Changes and Artifacts to follow the checks. You can
also start or repeat a review manually while the story is in that lane. The initial
checks run in the local engine; the reviewer model is used when you ask it a question.

The review captures the story's attributed changes, runs Memtrace's native code
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
start a worker, accept the story or mark a check as passed.

Dismissed findings move into **Dismissed findings**, with the original evidence,
your explanation, identity and time. Choose **Reopen finding** to return one to
the active list. Decisions and earlier reopen events remain in the saved review
conversation and history. A fresh review evaluates its findings again; a dismissal
is not a permanent suppression of that rule.

Finding decisions can be changed only while the story is in Code review and the
captured source is still current. Acceptance and Done keep the saved decisions
readable. Failed checks and incomplete coverage still need attention after all
findings have been dismissed.

The review uses Memtrace's AST, rule-pack, cross-module and online checks. Native
detector coverage is retained in the report. Checks must be linked to this story's
implementation and the captured source to count as verification.

Ask the reviewer about a finding or a tradeoff in the review conversation. This
assistant reads the saved, bounded review evidence; it does not edit files or run
commands. Select findings and request fixes to send an ordinary follow-up to the
story's implementation worker. Review the resulting changes again before accepting.

Only stories in the Code review lane can start a new review. Saved reports and
their conversations remain available in **Ready for acceptance** and **Done**.
Acceptance is a developer action, not an automatic consequence of a worker exiting.

## Several stories and epics

Reviews wait while workers in the same epic are editing. One epic can review while
another epic implements a story. Implementation workers, initial reviews and
reviewer answers share the local worker limit in Settings. Requests waiting for
capacity do not keep another idle epic's graph resident unnecessarily.

A new implementation pass interrupts an active review of that epic before editing
starts. Its findings cannot certify the newer source. One automatic recovery pass
may capture fresh evidence after editing settles; repeated interruption remains
visible for the developer to review. Cancellation or moving out of Code review
does not silently start another pass.

See [Parallel epics](parallel-epics.md) for branch isolation, prerequisites and
bringing changes together through Git.

## Current preview boundaries

The desktop preview does not yet provide permanent rule suppression, GitHub PR
comment publishing or PR watching. Native before-change file content is also
supplied to the detectors. Reviewer
answers use a saved evidence capsule rather than unrestricted live repository
tools. Complete review reports and conversations stay on this device; Team Sync
shares planning and explicitly published results.
