# Shared worker sessions: Mac validation handoff

This patch shares worker conversation, confirmed model, progress, queue commands
and saved review reports between team members. A follow-up executes on the
computer that owns the coding session. Provider resume tokens, approvals, local
graphs, browser sessions and terminal processes remain on that computer.

## Integrate without losing existing Mac fixes

1. Record `git status`, branch and HEAD in the Mac checkout. Preserve unrelated
   changes and any existing Memtrace engine fixes. Do not reset, clean or replace
   its profile, credentials, projects or graphs.
2. Fetch `origin/feat/shared-worker-sessions`. Inspect its diff against its base
   `790cc0df61abca4030bf61e03103a7447a5dcb03`. Work in a separate integration
   checkout; merge the topic branch into the existing Mac validation branch and
   resolve conflicts while preserving platform fixes. Do not reapply older
   beta.17 QA scripts over newer local versions.
3. Keep the existing pinned private Memtrace engine. This patch changes the
   app's engine lifecycle and review preparation, not the native engine source.
   Do not commit native binaries, account state or signing material.

## Local gates

Run `npm ci`, `npm run typecheck`, and
`node --import tsx --test --test-concurrency=2 tests/*.test.ts`, then
`npm run build` and `npm run build:native`. Save command output and exit codes.
Do not dispatch hosted CI.

Pay particular attention to `memtrace-owner-lifecycle`, `memtrace-peer-index`,
`parallel-epic-fleet`, `review-analysis-prepare`, `code-review-concurrency`,
`code-review-runtime`, `verification`, `codex-models` and `team-sessions` tests.
The Windows-only `verify-shared-session-ui.mts` uses WebView2 CDP; it is not a
macOS WKWebView test. Inspect the actual built Mac app with native UI automation
or a supervised manual run instead.

## Actual Mac application gates

Use a separately approved QA profile, the installed bundle and the existing
native credential-store refresh flow. Do not ask for another routine account
approval or borrow the user's normal refresh credential.

- Open a real connected project. In **Improve**, run **Refresh analysis** twice,
  then open **Insights**. Observe one owner for each physical store; a drain
  must finish before a replacement opens. Verify that no second owner waits on
  `.server.lock`, and that the source certificate is aligned before claiming
  current analysis. Do not remove a lock or kill an unrelated Memtrace process.
- Open MC-039 in the existing dogfood project. Preserve its recorded history.
  Read the actual **Code review** tab, expand **Measured functions**, and inspect
  cognitive, cyclomatic, nesting and maintainability values for individual
  functions. Compare the displayed numbers with the saved native report.
  A real maintainability value of zero must stay zero; unavailable values must
  say why. Before/after charts must compare only matched functions.
- Start a new review only in the Code review lane. Confirm progress continues
  through a recognized temporary graph publication, with no duplicate index
  request. Cancel once, retry once, and confirm the prior owner's shutdown has
  drained. An unknown, foreign or stale graph must still fail visibly.
- Keep two epics active. Starting, reviewing or retiring one must not stop or
  replace the other epic's owner. Preserve all shared source edits.

## Real harness and team tests

`scripts/verify-shared-worker-local.mts` uses real installed coding tools in a
disposable repository and a local two-member relay. It is not a production-board
test and does not alter personal stories. It needs a short-lived engine proof
descriptor produced through the approved QA refresh flow:

```sh
QA_HARNESS=codex QA_MODEL='<an advertised model ID>' QA_SMALL=1 \
QA_ENGINE_BINARY='<the pinned Mac memtrace executable>' \
QA_ENGINE_PROOF='<private short-lived QA proof descriptor>' \
node --import tsx scripts/verify-shared-worker-local.mts
```

Repeat with `claude` and `cursor`, using models their authenticated catalogs
actually advertise. Use `opus` only when the Claude account supports it. The
script verifies real coding, an authored peer follow-up, automatic pickup,
independent typecheck/tests, native review metrics, a remote review question,
and the same report on the peer. Keep receipts, including failures. QA disables
embedding to isolate structural review; it does not measure production embedding
latency. Proofs and credentials must never enter receipts or source control.

Then test the real two-computer flow against a Team service advertising
`workerSessions:1`. A desktop update alone cannot add those server routes.
The permanent service was updated on 19 November; see
[hosted validation](shared-worker-service-validation.md). Verify its capability
again before starting the two-device acceptance.

1. Use two QA members/devices in one isolated shared project. Run Claude Code,
   Codex and Cursor stories on the Mac; view each from the other member's app.
2. Compare confirmed model, live assistant text, owner, activity timestamps and
   completion. Send follow-ups while busy and after completion; they must use
   the original session on the Mac without starting a second local worker.
3. Edit and cancel a queued item before pickup. Confirm its author, exact final
   text and durable status. After pickup, editing must be rejected clearly.
4. Disconnect the receiving member, queue input and reconnect. Restart the host
   once between passes. Confirm catch-up, one delivery, retained conversation
   and no duplicate coding process. Keep approvals on the host.
5. From the other member's app, request a review in the correct lane, read the
   same per-function report, ask a review question and see the answer. Verify
   the report ID, native metrics and actual reviewer model match on both apps.
6. Refresh Codex's model catalog in the card. Compare its choices with that
   Mac's authenticated CLI catalog; show Astra/6.1/6.2 when advertised. Never
   add unavailable IDs to make the list look complete.

## Release gate

Return the tested MemCode commit, engine commit/hash, command results, real
harness receipts, Mac screenshots, Improve refresh timings and any remaining
limitations. Preserve the user's existing app/profile. Prepare the candidate
using the existing Mac signing/updater pipeline; distinguish updater signature
from Apple Developer ID/notarization. Do not publish a passing result for a gate
that was skipped, substitute a fixture for MC-039's report, or publish until
both platform gates and the Team service compatibility check pass.
