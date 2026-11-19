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

## Integration follow-up, 19 November

The incoming Mac fixes at `f92111f8e4d1798b0bc6036549e8379d8cfd40cd`
passed Windows typecheck, all **874 tests**, the frontend and native builds,
desktop smoke, and the actual WebView2 shared-session UI check. This includes
the read-only CLI compatibility changes, canonical checkout aliases, Homebrew
npm discovery and pinned ONNX notices. These are Windows integration results;
the Mac installed-app gates remain separate.

A further real reviewer check found that formatting whitespace could push the
large saved WorkDetail report over the existing 180,000-character input bound.
The native measurements were present; the advisory conversation rejected the
expanded JSON before starting its provider. Compact JSON keeps the same fields
and the same bound. Oversized evidence is still refused, before creating a
context capsule or launching a provider.

With that fix, real installed Codex (`gpt-6.2-astra`) and Claude Code
(`claude-opus-5-5`) both read their saved evidence and answered in 34.2 and
31.4 seconds respectively. This reuses the previously approved QA profiles;
it is a reviewer-startup check, not a new coding or native-analysis run.
The regression fixture preserves all 111 per-function rows, 18 findings,
numeric zeros, unavailable values, coverage notes and the bounded captured
patch. No measurements or findings are discarded to fit the context.

After this context fix, typecheck, all **876 tests**, frontend and native builds,
desktop smoke and the native shared-session UI check passed again. The two
new regression tests cover the large intact payload and the original refusal
for genuinely oversized evidence.

The next, stricter real Claude check requested the exact metrics for a function
near the end of that saved report. It exposed a second adapter bug: Claude
successfully retrieved that row using its allowed native Grep tool, but MemCode
recognized only Read as evidence access. The answer was rejected despite the
successful lookup. MemCode now recognizes successful content lookups of the
exact private evidence file, with the same read-only tool catalog. Other paths,
filename-only searches, counts, no matches and tool failures do not qualify.
The JSON retains line breaks for bounded native reads without repeated
indentation.

With this correction, the real `claude-opus-5-5` reviewer returned the exact
saved row in 22.4 seconds: cognitive 0, cyclomatic 1, nesting 0 and
maintainability 88.55729948050106. All four values and the symbol matched the
native report exactly. This is a targeted evidence-reading check, separate
from the original coding and native-analysis run. The targeted adapter suite
passed all 14 tests, including successful and rejected content lookups.

After the scoped content-lookup correction, all **878 tests** passed in
163.0 seconds. Typecheck, frontend/native builds, desktop smoke and the actual
WebView2 shared-session UI check passed on the same source. Mac validation and
the two-device installed-app checks are still required before publication.
