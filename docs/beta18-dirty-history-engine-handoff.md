# Beta.18 native acceptance handoff

Application candidate: `ef141194efbfa84ff4fe8d1ec0433195f6e9dffd` on
`fix/history-independent-workers`. Later documentation-only commits do not change
its application code. Preserve the Mac agent's existing fixes.

Engine candidate: `69e7a3c0b85b9a66ef0400b1ac77c30eadac7891` on
`fix/memcode-dirty-replay-intervals` in private Memtrace. It builds on
`5d0f0a54` / `1ebcfda21`; the MemDB submodule and production pins are unchanged.
Optimized Windows `memtrace.exe`: 191,878,144 bytes, SHA-256
`7f39c302c84528df563d666b842846ad1b988be79b2c79e566ce9439031bc3b7`.

## Verified on physical Windows

- All 981 app tests pass. Typecheck, frontend/runtime build and the native desktop
  smoke pass. Earlier full-suite attempts hit a legacy queue fixture timeout
  under concurrent import load; the isolated fixture and bounded full rerun pass.
- The engine passes 235 graph and 84 replay tests. Its optimized retained
  155-commit replay completed in 590,803 ms. `needs_replay` is false. A read at
  the saved Git cutoff contains 25,421 unique nodes and 127,225 unique edges,
  with zero duplicate identities.
- Retained store ID: `v1:01M7TJG7B4BZ8PHYKR0S0N2MCV`. Its journal grew from
  48,663 to 70,839 bytes during replay; the original bytes remain an exact prefix.
  The original 23,472-byte failed-store journal also remains a prefix. The normal
  graph and account were not replaced.
- Codex `gpt-6.2-sol` and Cursor `composer-2.5` completed real scoped coding turns
  while primary history replay ran. Each two-file TAP run passed 11 tests. Their
  turn durations were about 105 and 143 seconds respectively.
- The substantial saved MC-007 refactor received a new completed native review
  on the optimized engine: 51 function measurements, four changed files, all five
  phases complete, and 30 passing linked checks. A separate Codex GPT-6.2 Sol
  reviewer requested changes. Bounded impact limitations remain explicit.
- The hosted Team service accepts all five harness IDs and `workerSessions:1`.
  Six public/negative-auth checks pass. Deployed relay SHA-256:
  `b38c674523a8bd35c24c83a2faf9de836319c6fdd7b5cbc51ab4b1f9839c10dc`.

Private receipts are under Windows `tmp/memcode-beta18-final-verification`:
`optimized-primary-replay.json`, `enriched-retained-branch-historical.json`,
`optimized-big-review.private.json` and `beta18-final-app-tests.log`.
Do not publish source text, credentials or private account details.

## Final Windows native repetition

Claude's preparation timed out when a native source-verification walk was treated
as an unreported startup job. The source-only view now follows verification
directly. A stable completed peer save can request ordinary incremental catch-up;
writer arbitration and a fresh certificate remain mandatory. Partial revisions
are not accepted and primary history validation is unchanged. The 61 targeted
publication checks and full suite pass. The actual Claude retry completed with
confirmed `claude-opus-5-5` and nine passing tests. Copilot continued the same
conversation, used MemCode understand and Fleet inspect/checkpoint, and passed
eight tests with `claude-haiku-5.5`.

The final native Improve refreshes took 30,935 and 15,689 ms and produced current
checkpoints. Insights displayed actual source measurements. Both normal app
reopens preserved the same store, seven projects, 15 stories, saved review/checks
and worker approvals. The second cold diagnostic exceeded its short limit;
a subsequent native check certified the exact source with no failures. A fresh
review on app `ef14119` completed in 88,101 ms, including its separate model
reviewer. All 51 function rows and 255 metric cells render, including explicit
before-only/after-only values for removed and added functions. The 30 passing
checks remain linked. The real native smoke and graceful shutdown also pass.

The fresh optimized import completed 155 episodes (517,973 ms for its
embedding/replay stage, with embeddings deliberately skipped). Its historical
cutoff also has 25,421 unique nodes and 127,225 unique edges, no duplicates and
`needs_replay: false`. The recovered store still preserves all 400 sampled
records and nine full payloads; 315 redundant intervals alone were closed.

The detailed Windows receipt is the commit-specific
`windows-ef14119-69e7a3c-native-acceptance.json` asset in the
[private release draft](https://github.com/syncable-dev/memcode/releases/tag/beta18-staged-54eef4f).
This is native functional validation with a rebuilt runtime override, not the
final signed-installer acceptance. The CLI-mode test's external owner had to be
restarted after the cold backup; it is not evidence of app-managed ownership of
an external manifest. Mac built both exact commits and opened the Windows review
on the physical QA app. The [Mac acceptance report](beta18-mac-acceptance-ef14119.md)
records the package digests and remaining native, paired and signing checks.

Do not package rejected engine `cee3849`: its payload-equality guard rejected
parser annotation versions. Candidate `69e7a3c0b` reconciles redundant closed
intervals only for the same repository, branch, logical identity, Git event and
endpoints, using replay's existing canonical-event rule. Original payloads and
episodes remain stored. No graph reset or read-time duplicate filter is used.

## Mac agent: use these exact candidates

Use the existing approved QA installation/profile. Preserve the normal app,
source changes, graphs and account. No fresh login approval loop, Actions,
hosted runners, signing-key transfer or publication.

1. Fetch both branches and build the exact optimized engine with recorded
   submodules. Record toolchain, binary hash and actual launched path. Run graph
   and replay tests. Keep production pins at `1d0e8cb4a`.
2. Stop QA and its verified owner normally; take a cold copy of the failed QA
   store at its registered checkout path. Record store ID, sampled episode IDs,
   journal size/hash and duplicate counts at a saved Git commit. Preserve the
   original. Retry history to completion; require `needs_replay: false`, zero
   duplicate identities, unchanged store/episodes and exact journal prefix.
3. In the actual app run Improve -> Refresh analysis twice, then Insights. Require
   current certificates and real metrics. Quit/reopen twice; prove the same store,
   worker consent and settings. Test verification progress after a peer save.
4. Open saved MC-007 Code review; expand measured functions and linked checks.
   Inspect every numeric cell. Real MI zero remains zero; unavailable is not zero.
   Run paired coding and separate reviewer checks while history imports, recording
   native timings/counts and coverage limits.
5. Follow `beta18-connectors-windows-handoff.md`. Validate configured DSH with a
   real coding turn, continuation, captured diff and separate read-only review.
   A catalog/initialized ACP session is not a generation pass.
6. Complete the real two-device Team `workerSessions:1` test: owner and observer
   see the same confirmed model, progress and review; follow-ups from either user
   reach the claimed worker once, including reconnect and queue behavior. An
   older-source paired receipt does not clear the final gate.

Push sanitized receipts and propose the same final app commit for both packages.
Upload the exact new Mac archive and SHA-256 to private draft
`beta18-staged-54eef4f` with commit-specific filenames. Windows signs only the new
bytes with the existing production updater key and verifies the actual payload.
Production pins, downloads and feed remain unchanged until both native installer
checks, archive verification and the real paired test pass.
