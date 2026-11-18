# Shared sessions: Windows evidence, 18 November 2026

These are local Windows results. They do not certify macOS or a deployed Team
service. The Mac installed-app gates are in
[the Mac handoff](shared-worker-mac-validation.md).

## Application checks

- Typecheck passed; all **871 tests** passed with test concurrency limited to 2.
- Native release build and desktop smoke check passed. The smoke check exercised
  planning, cycle history, bulk changes, saved views, independent board lanes,
  Insights and graceful shutdown.
- The actual WebView2 app passed the labelled shared-session UI fixture: remote
  transcript/model, authored follow-up, edit/cancel before pickup, and saved
  per-function numbers including a real numeric zero. This UI fixture is
  distinct from the real provider tests below.

## Real provider runs

Each run used an installed authenticated harness, a disposable coding repository,
and a local relay with two separate member/device identities. A peer sent a
follow-up, the host continued automatically, a native review ran, and a peer
review question received a model answer. The peer's report ID and metric rows
matched the host. No production story was modified.

| Coding harness | Confirmed coding model | Initial review time | Saved per-function rows |
| --- | --- | ---: | ---: |
| Codex | `gpt-6.2-astra` | 95.9 s | 3 |
| Cursor | `composer-2.5` | 41.0 s | 5 |
| Claude Code | `claude-opus-5-5` | 115.5 s | 111 |

Codex and Cursor fixed the small numeric total/mean fixture; independent
typecheck and both behavioral tests passed. Cursor's reviewer reported
`composer-2.5[fast=true]`; Codex's reviewer reported `gpt-6.2-astra`.

Claude worked on the real WorkDetail source archived from base
`790cc0df61abca4030bf61e03103a7447a5dcb03`. It extracted five presentation
modules, preserved the six declared-file scope, and passed typecheck. Its saved
raw follow-up test log reports **864 passed, 0 failed** in 55.3 seconds.
An independent typecheck also passed. This experimental refactor was not merged
into the product by this acceptance task, and its extracted screens were not
given a separate desktop acceptance run.

The native report measured WorkDetail as follows:

| Metric | Before | After |
| --- | ---: | ---: |
| Cognitive complexity | 365 | 143 |
| Cyclomatic complexity | 234 | 128 |
| Maximum nesting | 8 | 4 |
| Maintainability index | 0 | 0 |

The report completed with **changes requested**, raising 18 findings for
inspection. These are detector findings, not 18 independently confirmed bugs.
Only one declaration was safely matched across both versions; new, removed and
ambiguous declarations remained separate. Graph impact/quality lookups cover
the first 24 affected functions, while captured-source rows have their own
coverage. The review retained those limits instead of presenting a full pass.

The Claude advisory reviewer was a separate read-only process using
`claude-opus-5-5`. Current selection normally follows the implementation's
harness/model; it does not promise an independent model family.

## Failures that informed the patch

- Immediate review used to retire and reopen a healthy epic owner. It now reuses
  that owner; an owner already draining is awaited before reopening.
- A queued continuation could lose its warm graph. It now retains it through
  pickup and releases it after the last pass.
- A provider's Finished state could precede its final contribution/checkpoint
  drain. Review admission and capacity now include that settling process.
- Whole-project verification inherited the 2 MB source-preview limit. A normal
  2.9 MB vendored archive made the fingerprint unavailable. The fingerprint has
  a separate 8 MB per-file bound and retains its 32 MB total bound.
- The first large test's directory scope was invalid for Fleet. Corrected runs
  declared exact paths and obtained edit permission. Failed receipts were kept.
- The first remote review-question driver omitted the review ID. The production
  handler already passed it correctly; the corrected driver exercised the real
  route successfully.

The native engine pin was unchanged. QA disabled embedding to isolate structural
analysis; these timings do not establish production embedding or Mac startup
latency. There is no normal-setup token-savings comparison in this test.

The test scripts save their receipts in private temporary lab folders. Remove
short-lived engine proof files after testing, retain the approved QA sign-in, and
never commit provider credentials or raw private conversations.
