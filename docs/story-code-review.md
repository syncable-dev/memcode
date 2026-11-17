# Review a story

Move a finished story into **Code review**, open its card, and choose **Code
review** between Changes and Artifacts. Click **Start review** when you want to
review its current contribution. Moving a card alone does not start a model.

The review captures the story's attributed changes, runs Memtrace's native code
review detectors, measures the changed functions, traces their impact, and links
the recorded verification to that exact source snapshot. The progress steps show
what has finished and what still needs attention.

## Read the result

Start with the outcome and coverage. A maintainability score describes measured
code structure; it is not a probability that the change is correct. Missing or
stale measurements do not become a passing score. Open a finding to see its rule,
source location, detector evidence and affected code before deciding what to do.

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

The desktop preview does not yet provide per-finding dismissal/suppression,
GitHub PR comment publishing or PR watching, or a before/after quality chart.
Native before-change file content is still supplied to the detectors. Reviewer
answers use a saved evidence capsule rather than unrestricted live repository
tools. Complete review reports and conversations stay on this device; Team Sync
shares planning and explicitly published results.
