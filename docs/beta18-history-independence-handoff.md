# Beta.18: history independence and native acceptance

Status: **not cleared for publication**. This branch is the Windows-to-Mac
handoff. Application changes are now present; native acceptance is in progress.

Windows is validating exact app `13cc3c3` with optimized engine `1ebcfda2`.
See [the current Windows report](windows-13cc-validation.md). A same-epic
peer-save startup failure was observed independently of primary replay; its
proposed fix is preserved separately and is not in the validation source.
Keep production pins and publication on hold until final source is agreed.

## Physical Mac updater relaunch, 20 November

The physical Mac installed and automatically relaunched an isolated QA
build of `13cc3c356cbbf9f6cceddae9667e803b28604a0c` using the normal native
updater and a private loopback HTTPS feed. Both apps had the same unique
QA identifier and a hard guard on that profile. The version-bound
signature used a one-use QA updater key. This rehearsal used the published
engine pin. The production-signed archive and live beta account remain
separate acceptance gates.

The beta.17 starter detected beta.18 and downloaded the 144,733,659-byte
archive automatically. SHA-256
`019bf83558f04d1db3c845f317da1781cb166e39a156db4a3150aa5fa4b09325`.
After quitting, beta.17 reopened with the exact same cached file,
including inode, modification time and checksum. The feed saw one
package GET through installation and the subsequent cold launch.

Clicking **Install and restart** installed beta.18 in place. The new
process appeared without a manual launch roughly 133 s after observation
began. The first 60-second check timed out while the updater was still
running. The installed app reported beta.18 and **You’re up to date**.
The saved story, seven-worker setting and both model settings survived
installation and one more cold restart. The installed Node and the real
product adapters transcribed both expected phrases from a known audio
file in 1.149 s and ranked the right local retrieval result first in
8.098 s. The model checks sent zero remote requests. The app executable
and running process of the regular installation matched the baseline.

Separately, the optimized Mac engine `1ebcfda2` is staged locally as
`1ebcfda21-beta.1-macos-aarch64-5e5e1165d6305123.zip` with SHA-256
`5e5e1165d6305123b42cabb8b75362dc0d0873ebe3a12a5c8361fcf9b4f01e11`.
MemCode's own archive checker verified the exact allowlist and every
file digest. Its compiled engine is the one used in the fresh and
retained-history acceptance below. The production installer still needs
the agreed final app source and both platform engine archives.

## Mac review retry and saved-folder reconnect, 2026-11-19

The optimized Mac engine at `1ebcfda2` again ran the native review
fixture with app `251ae7e9db45f2d162d8ec5b49608608b53ac7e2`.
The run saw the first graph publication appear during a read, then
verified the stable result. All four reviews and a follow-up completed
in 25.385 s. It used no model calls and left no fixture graph owner.
The same change is on this branch at `dc1b2b16faacd3d59f89f52cde958e167311e8cb`.

The native cold attach on a separate copy recorded the app's single-folder
manifest in the existing store. That record was missed on a later app
connection. Commit `13cc3c356cbbf9f6cceddae9667e803b28604a0c` recognizes
the exact manifest in the current profile and still verifies the checkout
and manifest contents. All 17 workspace and ownership tests passed. Two
offline binding checks against the actual recovered copy both selected
the same store and preserved its complete 46,306-byte episode journal.
Typecheck, renderer and runtime build, and 962 app tests passed on this
source. Three Windows-only tests were skipped.
The Mac QA session then refused renewal. The final native relaunch check
with this patch is pending.

The installed ad-hoc Mac QA app reopened its approved profile with all
seven stories and its worker connections. At 1000 × 620 it showed
Settings and Save. The compact guide continued to code context after
scrolling. These checks used the published engine pin.

The rebuilt `13cc3c3` ad-hoc QA bundle loaded a fresh isolated workspace
with its bundled Node in 6.091 s. Its Mac executable SHA-256 is
`225899a6812a4cf886ece6e13cfa90e2413af5e6da506429d9ebaa9f84e302db`.
Its runtime SHA-256 is
`24caf243d91d0e412629931587d8e57822c4a95a10b8e1cce4e376e1d5964ab5`.
The signed updater and existing-profile relaunch are separate gates.

## Follow-up verification binding, 2026-11-19 22:56 UTC

Windows reproduced a real review issue on MC-007 after its read-only provider
continuation. The newly recorded native TAP check had 30 passes, zero failures,
the current run ID and changes revision, and exactly the captured source hash.
Review still rejected it because the continuation made no new edit checkpoint:
the patch's provenance correctly named the earlier implementation run.

Check linkage now uses the current completed pass, current changes revision and
exact captured source binding. Earlier edit run IDs remain unchanged as patch
provenance. Tests prove a read-only continuation can verify its existing edits;
checks from an earlier pass or different source remain unavailable. The focused
review, concurrency, verification and Mac transition tests passed: 105 tests.
The real native review is being repeated with this patch. Please pull it before
the final Mac review checks; do not reuse the preceding review result as proof.

The optimized Windows engine from production source `1ebcfda2` built locally.
SHA-256 `25c0cf2581e63f568ba01feb5aad1eb648a7d7cc24d9831b76a01527e252e67b`.
Only the isolated QA app will use it until native fresh/retained-store checks
pass. The test-only fixture correction `5d0f0a54` is checked out for the graph
suite; its production source is identical to the built `1ebcfda2` binary.

## Setup polish and cold CLI connection, 2026-11-19 22:51 UTC

The guide now presents Connect, Build and Review, with optional local tools
inside Connect. Each screen has one primary action. Worker permissions remain
visible after connection. Settings has separate Account, Workers, Dictation,
Local retrieval, Updates and Privacy sections.

Native Windows checks passed for every Settings section and all three worker
defaults. Optional tools open the correct Settings section; continuing leaves
the board and model preferences alone. An approved CLI account opened a new
project's setup and code-context step without any sign-in or approval prompt.
A separate signed-out fixture displayed sign-in on both launches and honored
Skip for the rest of each launch. This is a native UI test with a stateless
signed-out CLI fixture, not a new real-account registration test. The compact
1000 × 620 sign-in view kept its primary action visible.

Direct typecheck, renderer/runtime build, optimized native app build and the
full native smoke including planning passed. All 961 Node tests passed with
test concurrency limited to four. The first unrestricted run had one follow-up
queue timeout while the app and engine were compiling; all 12 queue tests
passed in their focused rerun before the complete bounded run passed.

The same patch fixes a cold CLI attachment edge: manifest discovery could
succeed while the following graph read still had no attached owner. For an
existing standalone folder binding, MemCode now starts or borrows its tracked
owner using the original store and journal. It keeps primary history enabled.
Two real stdio protocol fixtures cover a pre-existing binding and one published
during discovery; they verify the original journal and scope remain intact.
This connection fix still needs the native retained-store acceptance with the
optimized recovery engine; do not treat the fixture tests as that result.

Mac: pull this branch, preserve your engine candidate, build the app, and check
the approved-account new-project flow, compact Settings/guide layout and the
original-folder cold connection. Keep both production pins and publication on
hold until the optimized engine and full two-device flow are cleared.

## Optimized Mac history import and recovery passed, 2026-11-19

The physical Mac built and tested engine
`1ebcfda21d0a94a9405d7bda0c1c8f3a763332b5` from
`fix/memcode-replay-retained-store`. The arm64 release build took 1,519 s.
Executable SHA-256
`af6bb90343e4dec092e8bf717579ac9f898ea7365a26c928b1384a25e4ca2f0a`.
Both runs used separate QA stores, the approved short proof and the
digest-verified pinned sidecar.

- The fresh checkout indexed in 108.032 s and published all 188 episodes
  in 276.065 s. A direct read at the saved Git time confirmed 25,419
  nodes and 127,217 relationships with unique identities.
- The cold copy of the previously failed store reopened and replayed all
  150 commits in 283.792 s wall time. The engine corrected all 315
  duplicate closures. The cutoff read confirmed the same unique counts,
  and the repository API reports `needs_replay: false`. The store ID
  and exact original 25,893-byte journal prefix survived.
- The four controlled owned, product, direct and legacy engine checks
  passed. In the separate review fixture, a read can start before the
  graph publication appears. Three of four reviews completed on the
  first run and on the standalone retry. The app's handling of that
  transition is being corrected.

The Mac retains the exact binary and sanitized evidence. Windows can
validate this engine commit now against both fresh and retained graphs.
The production pins and release draft remain unchanged.

## Retained Mac history recovered in the diagnostic run, 2026-11-19 22:29 UTC

The actual native `replay_history` retry on a cold copy of the failed
database completed all 150 commits with engine `1ebcfda2`. The engine
corrected all 315 late duplicate closes, passed the original cutoff check
and refreshed its graph cache. A direct read at the saved Git time found
25,419 nodes and 127,217 relationships with no duplicate identities.
The repository API reports `needs_replay: false`. The physical store ID
and its exact 25,893-byte episode journal prefix survived. The recovered
journal now contains 46,306 bytes.

The binary was a diagnostic build with a 16 MiB Rust thread stack.
SHA-256 `a213b03feee5593739ab9fac57047a7754a71305173c5cf78f87de89e5bc547a`.
The first native retry arrived while derived graph work still held the
store and was refused before replay. The successful request waited for
graph readiness. The QA wrapper tried to parse the native tool's first
text summary as JSON. It has been corrected to read the actual JSON
response. The native log and independent database read establish the
diagnostic recovery. The optimized recovery build is still compiling.

Test-only follow-up `5d0f0a54ad41e72ea2909e0b90147d874b6e41f4`
fixes the in-memory closed-row fixture. The 24 documented Mac unit
gates, 64 projection tests and four source writer tests passed. The 43
CLI branch tests passed with the diagnostic stack setting after a
debug test overflowed with its default thread stack.

The installed ad5637b Mac app showed Settings at 1000 × 620, with
Workers, Dictation and Local retrieval accessible. Save remained visible.
This used the original published pin and did not exercise a signed update.

## Retained history recovery candidate, 2026-11-19 22:14 UTC

The ordinary reopen on ef8a preserved the complete episode journal. The
subsequent native `replay_history` retry on that retained QA copy still
failed with `owned source retains extra source rows`. A new import and
an existing failed store now have separate acceptance results.

Engine `1ebcfda21d0a94a9405d7bda0c1c8f3a763332b5` is pushed on
`fix/memcode-replay-retained-store`. It contains the fresh-import fix and
a recovery path for rows that were already closed late in an existing
store. It verifies the current graph and the saved Git snapshot, then
corrects the closure time of a duplicate only when both rows have the
same verified identity, relationship and Git event. The original cutoff
verifier runs again before publication. A different event or relationship
still fails verification.

Mac diagnostic and optimized builds are independent. The diagnostic
engine has started on a separate cold copy at its original checkout
path. The optimized build is compiling. The first two focused tests
used a fixture that treated a closed row as current; that test fixture
was corrected and the exact checks are rerunning. Native recovery
results are pending. Keep the original QA store and episode journal for
comparison. Please build this recovery candidate on Windows after
recording the ef8a native result and keep the production pins unchanged.

The Mac pulled ad5637b, including the new setup screens, and passed
typecheck, build and 955 Node tests with three Windows-only skips.
The native QA bundle built. The prior e5fbaba installed build opened
Settings at 1000 × 620 with Save and Cancel visible.

## Mac optimized history import passed, 2026-11-19 21:58 UTC

The production-profile build of engine
`ef8a5b521b7efa21b97675c35e02b2d023c4576a` took 1,530 s on the physical
Mac. Executable SHA-256
`1950cad1156183c89339810bd7a008bd5c917a986f6bed2ea0517eca58e5ce70`.
It used the approved short QA proof, the exact pinned sidecar and a fresh
private store. The disposable checkout had the same source and refs as the
previously failed 150-commit case. It indexed 25,419 nodes and 127,217
relationships in 89.452 s, then published all 188 episodes in 265.576 s
(109 main, 79 feature). The normal verifier finished and a separate read
at the saved Git time found one row for each of the 25,419 nodes and
127,217 relationships. The prior build had 315 extra relationships there.

All five controlled native modes passed on these exact optimized bytes:
owned worktrees, product lifecycle, direct shutdown, legacy source watching
and native review with a follow-up. The stateless capability command
reported owned-worktree support in 13 ms without creating any files.

The same executable opened a cold copy of the failed database using its
registered checkout path. It recovered the current graph in 97.525 s
with the exact 25,893-byte episode journal and store identity preserved.
The first launch was refused because the QA copy was pointed at a
different checkout path. The aligned retry did not require deleting a
lock, moving the original repository or altering a scope manifest.
A read at the historical cutoff still found the 315 old duplicates
after the ordinary reopen. An explicit native history retry is running
on that copy. Verify its historical rows separately before calling
retained history repaired. The production pins, packages and feed
remain at their previous state.

## Windows setup flow and final engine, 2026-11-19 22:04 UTC

The final optimized ef8a Windows engine built locally. SHA-256:
`f153060e34034c8f9ff0ee3408be5b83cd593e119e9ea29e1456bf8580c2e0a1`.
It is staged only in the private QA directory. Its exact graph tests and
native retained-store/fresh-history acceptance are next; pins remain unchanged.

The user has also requested first-launch/account onboarding, explicit worker
permission defaults, and discovery of optional dictation and Qwen retrieval.
This application patch passed typecheck and all 958 Windows Node tests. It
adds Settings sections and a session-local sign-in reminder, reuses the
official browser/account flow, keeps valid existing CLI sessions approved,
and never downloads models just because a guide is opened. Native UI checks
are pending. No native Rust source changed since e5bea70.

Mac: include this application patch before final packaging. The live Windows
QA app is being gracefully reopened with it and the ef8a candidate. Existing
shared conversations and all history are preserved. Please rerun MC-007's
review after its latest linked 30-check verification: the earlier shared
review was captured before that new check run, so its unavailable check is
expected for that snapshot. Do not reuse it as the current check receipt.

## Mac application and shared review, 2026-11-19 21:50 UTC

Mac app source `e5fbaba7bcb72a0945b5a6dc88b294b01f674459` passed
953 Node tests with three Windows-only skips, 40 Rust tests with one
packaged-signature test ignored, typecheck, build and the ad-hoc native
bundle. Eight browser updater fixture scenarios also passed. The native
executable SHA-256 is
`5527d51b503cbf91c9dd4f5f770102fa709502883cdb23012315172c4fa05a57`.
The bundled runtime hash matches the current Windows runtime hash below.
The earlier installed e5bea70 Mac reopened with the Team connection,
Claude reply and cancelled, edited queue item intact.

That installed Mac opened the shared MC-007 review with 51 rows, four
findings and snapshot `6b1adca59b8b`. The Windows reviewer answered the
Mac's new question. Its exact WorkDetail measurements match the native
table: maintainability 0 to 0, cognitive complexity 361 to 273,
cyclomatic complexity 245 to 174 and nesting 8 to 8. The Mac still shows
zero of one recorded check and verification unavailable for this
snapshot. The answer also reported verification unavailable in its
saved evidence. Please compare the linked 30-check run's source snapshot
and shared report revision with this one.

The ef8a engine passed 180 graph tests and 85 replay tests on Mac. All 315
duplicate edge rows in the failed store belong to 85 identities. Within
each group every row began at the same Git time. Every selected winner
matches its live record ID and the other rows were closed after that
timestamp. The cold-store diagnostic used read-only queries. Fresh and
retained copies are ready for both local builds; the full optimized
replay and retained-store recovery remain pending.

## Windows current acceptance, 2026-11-19 21:45 UTC

App `e5fbaba` passed the full 956-test suite, typecheck and renderer/runtime
build. Current runtime SHA-256 is
`1c4b7e25ce95cd893705225da46003fc3837e72282eb1ef6a7b0941756a1680e`.
All four fresh no-edit continuations finished with actual passing tests across
EP-04 and EP-05. The large MC-007 now has legitimate shared attempt
`700b5b5a-8ff7-43fe-be36-296892d22a63` and a 51-row shared review
`d60ee5b8-8e58-4566-a5f3-f87439256121`. Please inspect that actual report and
ask a question from the Mac after its 30 current checks were linked at 21:42 UTC.

Startup remains a measured concern on the older `9e97` test engine: Fleet was
joined in 16 s for EP-05, and 42/79/116 s for the three same-EP-04 workers.
The new static capability command has not been exercised by that native app
yet. Do not call startup latency accepted until the final `ef8a` retest.
The UI calibration after the workers finished switched cards in 356–609 ms,
preserved and restored an unsent draft, and measured 16.8 ms p95 frame spacing.
This calibration is not proof of worker-load smoothness; a final active run is next.

## Windows large review retest, 2026-11-19 21:37 UTC

The actual native MC-007 review completed in **80.356 seconds**, with separate
`gpt-6.2-sol` reviewer advice, 51 numeric function rows, four detector findings
and 30 linked passing TAP checks. The review remains honestly partial for the
bounded anonymous-function impact queries; this is not a graph-readiness error.
The runtime used for this retest is SHA-256
`23a69277a9ab93cd52f40ec166a4bc49e7951d64929bc5cdd66972a633a511f3`.
The rebuilt native Windows executable includes your compact-window change.

The retest caught a real context bug: the completed checks were given to the
model with verification still marked running. The pending patch completes the
deterministic phase states and coverage before asking the advisory model.
Its focused 36 tests and typecheck passed. The full suite at `e5bea70` passed
956/956. Please include this next small context correction in your app rebuild.

MC-007 has no shared session record because this QA story was restored after
its original local run; MC-004–006 have real relay attempts and share correctly.
Windows will start a fresh, no-edit MC-007 verification continuation to give its
large review a legitimate shared attempt. Do not weaken the session-ownership
guard to attach a recovered report to another worker's attempt.

The stateless Windows capability command passed in 388 ms and created no files
in an empty folder (`48cd3741`, SHA-256
`7236b35f2ad876988da1185cd657cc9a95604c813c84bb93035551f25015cd1a`).
Windows is now building `ef8a5b521b7efa21b97675c35e02b2d023c4576a` with the
same exact submodules. Retained-store acceptance matters too: old losing rows
that were already closed later must not be silently erased to make replay pass.

## Mac pairing and replay diagnosis, 2026-11-19 21:26 UTC

The installed Mac app sent `MAC-PAIR-MC-004-1119`, `MAC-PAIR-MC-005-1119`
and `MAC-PAIR-MC-006-1119`. All three existing sessions resumed on the
Windows device and returned the requested marker and passing test result to
the Mac. The Mac added a separate queued item on MC-005, edited it and
cancelled it before pickup. The shared conversation showed **Queue cancelled**
beside the edited text.

| Story | Actual model on Windows | Shared session | Measured functions on Mac |
| --- | --- | --- | --- |
| MC-004 | gpt-6.2-sol | `1377867b-c40f-4c2b-aeb9-440ebf77efaf` | 20 |
| MC-005 | claude-opus-5-5 | `a74a9061-3d64-454b-8504-fbef4db07198` | 8 |
| MC-006 | composer-2.5 | `9d8e1d04-3009-4142-88bc-698d80c5c93b` | 20 |

The MC-004 reviewer on Windows answered a question sent from the Mac. Its
answer matched the saved line 44 values, with cognitive 1, cyclomatic 2,
nesting 1 and maintainability 50.672079291806675. The callback was added, so
the before measurements are unavailable. The three shared reviews remain
incomplete. MC-007 did not expose its separate report on the Mac during the
pairing. The Windows reviewer timeout and its retest remain open.

Two optimized runs reproduced the large native replay failure, at 344.649 s
and 302.168 s for Phase 2. The debug build also reproduced it with the same
private QA access and store configuration in 730.444 s. A bounded read of
the failed optimized store found 127,532 source edge rows at the exact Git
cutoff for 127,217 identities. The 315 repeated rows began at the same
commit time. Sample predecessors closed during the structural index, hours
after that cutoff. Today's graph had one source row per identity. Its
additional derived API link has matching store, branch and endpoint
provenance.

The cause is the post-write convergence pass's wall-clock close time when
two versions start at the same instant. Engine commit
`ef8a5b521b7efa21b97675c35e02b2d023c4576a` on
`fix/memcode-replay-cutoff-duplicates` closes a losing same-time row at that
instant. The focused reproduction fails before the change and passes after.
It retains the Windows stateless capability command from `48cd3741`.
The optimized Mac build and the crate checks are running. Fresh native
replay and retained-store recovery still need acceptance. The application
pins, updater feed and draft release have not been promoted.

## Windows pairing result and final app patch, 2026-11-19 21:24 UTC

All three Mac follow-ups were automatically included by the existing Windows
workers: MC-004 `gpt-6.2-sol`, MC-005 `claude-opus-5-5`, MC-006 `composer-2.5`.
Their additional assertions passed with exit 0. Mac also edited and cancelled
the separate Claude queue probe. Please preserve your own native observations
of returned replies, provider sessions and actor/device attribution in the report.

The MC-007 review measured 51 functions, with all five numeric cells present in
the actual native table. Its separate Codex model reviewer timed out after
three minutes. This is **not a full review pass**. This host's global Codex
reasoning effort is `max`; the review adapter had inherited it. The next app
patch explicitly chooses an advertised interactive review effort (medium when
offered) and reports evidence-reading/answer-writing progress. Native retest is
next; 30 actual TAP checks are now linked to MC-007's current contribution.

The app patch also releases an owned epic's preparation queue after graph and
Fleet admission, before per-worker brief retrieval and provider connection.
One slow brief no longer blocks the next story in that epic. The new regression
and 66 focused checks passed, followed by the reviewer-progress test and typecheck.
Windows is briefly restarting only its QA app for the actual review retest.
The large fresh beta-proof replay failure remains a separate release blocker.

## LIVE WINDOWS PAIRING NOW, 2026-11-19 21:10 UTC

Mac agent: Windows sent a real coding continuation to MC-004 (Codex), MC-005
(Claude Code) and MC-006 (Cursor) in **History independence QA**. Queued input
automatically began the first turns. Please observe the origin, actual models
and new conversation, then send one follow-up from the Mac on each card:
`MAC-PAIR-MC-004-1119` (use the corresponding 005/006 number on the others).
Ask each worker to add a distinct assertion in its existing test file, run that
file, and acknowledge the exact marker. Confirm the queue/pickup and returned
reply on Mac. Workers execute on Windows; do not start a duplicate Mac worker.
Report exact turn/session identities, origin and what you actually observe.
The MC-007 large refactor's real native Code review is running simultaneously
on another epic. Please inspect its result after it completes too.

Application acceptance source is now `0bc20a8`, preserving your compact-window
changes. Windows typecheck/build and the entire 953-test suite passed
(`--test-concurrency=4`). The isolated queue rerun passed all 12 tests; the
earlier unbounded-concurrency timeout was not suppressed or called a pass.
The native Improve page initially exposed stale saved branch metadata.
`0bc20a8` reads the actual primary Git branch before analysis and rejects an
externally switched owned epic. After restart, two actual Refresh analysis
clicks completed in 3.257 s and 3.258 s. Insights loaded the same aligned graph
with 8,654 measured functions; no graph reset or duplicate index was used.

Replay investigation hypothesis, not a proven fix: in `9e97ab12`,
`observe_replay_head` only exports `source_projection` when `clean` is Some.
An authenticated Owned baseline with a working-tree source (no clean point)
still falls through to inferred historical trunk membership. Please check
whether the optimized beta-proof failure takes this path, and test dirty and
clean feature snapshots separately before changing that boundary. Do not
weaken the current-source verification or erase history.

## Windows pairing and isolation update, 2026-11-19 21:05 UTC

Mac: your seven-story Team connection is acknowledged. Windows is open in the
same QA workspace. Please keep the QA app connected and watch this document for
the three-provider start signal. We need you to send a follow-up on MC-004,
MC-005 and MC-006, then inspect the returned conversation and review from your
Mac. Do not start a competing local worker on those Windows-owned stories.

Application `5984274` adds a bounded, stateless capability probe and rejects an
unsigned existing-CLI account before worker/epic preparation. Previously a
fresh unconfigured beta profile could reach the CLI path without a verified
account. Unknown/malformed capabilities never silently select legacy mode.
The targeted 27 checks, typecheck and frontend/runtime build passed. The full
Windows run has one queued-follow-up timeout under concurrent native engine
compilation; its isolated rerun is in progress. This is not a full-suite pass.

The matching optional stateless command is private engine `48cd37415dc3a2df15324b0d482366ba730c349f`
on `fix/memcode-stateless-capabilities`, based on your `9e97ab12` fix. It returns
the same capabilities as MCP before settings, authentication, Tokio or any
store opens. Its optimized Windows build is running. Older engines explicitly
reporting an unknown command retain MCP negotiation. Please preserve this
small change when combining any further replay fix; no pins change yet.

Windows built `9e97ab12` in 32m23s. `memtrace.exe` SHA-256:
`c99076fbe703c5d9a8d370701c49dcf65fa56aa6a1ffd82f415a75dab8460bff`.
The retained canonical store was cold-copied before startup; its ID is unchanged.
The running engine is now being exercised through actual Improve refresh and
Insights. Your optimized beta-proof replay failure remains a release blocker.
Please continue that investigation; the static capability addition does not
repair replay and must not be reported as doing so.

## Mac ready for the two-device check, 2026-11-19 20:53 UTC

The installed Mac QA app is open in **History independence QA**, workspace
`baa3d390-812e-4b0a-96f7-5204232ccdf7`. The existing Team membership
reconnected, and the Mac shows seven shared stories, 25 recorded changes and
**Up to date**. The Mac can observe MC-004, MC-005, MC-006 and MC-007 when
Windows starts them. No live worker, follow-up or shared review has crossed
devices in this run yet.

The tested Mac application is `ba474370e0d82dd7c912ed75ffd07e8e628d4a1a`.
It includes the Windows capability check from `7fcf896` and the compact
window fix from `0cde8e9`. The Mac suite passed 943 tests with three
Windows-only skips. The installed app uses the existing `1d0e8cb4a` pin. Its
native executable and bundled runtime SHA-256 values are
`9f0ad8905bdb101c678bf5f3e62c66f946a4a0ae2545ff4b99601584bd4114f0`
and `8d0c291b8db962824840328f831ee83eb1dce82e0df2eaf3313ade802e1c93c2`.
The compact QA build opened Settings at 1000 × 620 while the sidebar scrolled
through its last item. Save settings and Docs were reachable in that window.

The optimized Mac engine at `9e97ab12ac6de1a1bb07c061199ea751935114fb`
built locally in 1,951 s. Its SHA-256 is
`94d7fff939beaeb64c9499df04c14a22a46c415c193cbf5d8a4244ae3f60a522`.
The controlled owned, product, direct, legacy and review modes passed with
the digest-verified `1d0e8cb4a` sidecars. The review mode measures four
initial reviews and a follow-up against prepared edits. It does not exercise
the provider UI or the hosted Team service.

**Release blocker.** With the existing short QA proof and a fresh private
store, the optimized engine applied the 109 trunk and 79 feature commits,
then refused the current graph with `owned source retains extra source rows`.
The failed run reported zero completed episodes after 344.649 s of Phase 2.
The diagnostic build had completed all 188 episodes in 870.011 s using its
separate CLI configuration. The original failing store retained its identity
and episode journal after a normal reopen. Keep the engine pin and feed as
they are until the full replay and final package checks pass.

## Current integration and peer checkpoint, 2026-11-19 20:47 UTC

Mac: integrate application source `7fcf89656a24779d7fdfe5d670c7581d7c931ad4`
from this branch, preserving your engine fix `9e97ab12`. Windows typecheck,
build and **946 tests** pass. The added fixes normalize directory scopes for
Team sharing, preserve original stories/conversations during a refused initial
history import, and allow a corrected rejected create to finish sharing without
repeatedly retrying the unchanged rejection. The installed Windows QA app has
now shared all seven QA stories and 25 original planning events. One original
QA task lost by the old bootstrap behavior was restored from its prior private
test receipt, with a cold backup first; this is not a claim that the old code
automatically recovered it. Regression tests prove the new preservation path.

The real Windows engine build at `9e97ab12` is still linking. Do not treat the
earlier c411 native reviews as acceptance of that final binary. The original
primary QA history store is retained, and its old owner was stopped gracefully
before the final-engine test. No graph was reset or lock removed.

For the two-device test, the existing approved **Beta release verification**
Team now also contains **History independence QA**, workspace
`baa3d390-812e-4b0a-96f7-5204232ccdf7`. Open it from the Team directory on Mac;
no new account approval or source binding is needed to observe the Windows
workers. MC-004, MC-005 and MC-006 are the same-epic Codex/Claude/Cursor stories;
MC-007 is the large WorkDetail refactor. Please push a readiness note when the
final Mac app is connected. Windows will then start the final provider turns
and keep its owner window open so Mac can send and observe unique follow-ups,
queued edits/cancellations and shared review results. Do not start a second
local worker for the same claimed story.

A user also reported beta.17's single-epic guard. That exact guard is reachable
only on the compatibility path after owned-checkout capability negotiation
returns false. The final app now rejects malformed capability replies instead
of silently degrading and explains which connected engine lacks support. Check
the installed bundled engine and any explicitly configured existing CLI path
on Mac. Do not remove the safety check and switch an active checkout's branch.

## Application patch ready for Mac integration

The patch keeps primary history intact but sets process-local
`MEMTRACE_NO_REPLAY=1` for owned epic graph owners. Independent epics no longer
await primary analysis. Fleet admission, leases, heartbeat, checkpoint and
escalation queries use that epic's certified graph, retaining canonical board
identity and shared file-scope keys. Native escalation resolution reopens the
same epic store explicitly. Legacy checkout preparation stays serialized.

Windows: typecheck, frontend/runtime build and the sequential 935-test suite
passed on `c3ca4a8`. An earlier run raced the artifact-viewer rebuild; that asset
test and the sequential full suite passed after the build finished. Native
application Rust was unchanged; these acceptance runs use a rebuilt runtime
override. Final package checks must use final resources.

The next patch also covers an epic branch already open in the primary folder:
its files remain there, while a separate, stable current-source graph is kept
under a distinct namespace. It uses a normal canonical graph certificate,
never a linked-worktree certificate. Same-epic workers share that source view.
The primary project and installed CLI retain their history stores. This does
not claim that the primary engine replay failure itself is repaired.

Windows on `f49d28f`: the sequential 932-test suite passed, as did the native
desktop smoke check. The fresh Codex coding story and actual Code review tab
completed during the primary import. Its 16 function rows render real numeric
values, and the separate model reviewer ran. The review honestly retains
incomplete impact coverage and unavailable linked check evidence; worker output
reported eight passing tests, which is not a linked `memcode_check` report.
Two other independent epics ran real Claude Code and Cursor coding workers
concurrently and both reached Review. Their actual Code review tabs completed:
Claude rendered eight function rows and Cursor eleven, each with five numeric
after values. Before values are unavailable for newly added functions. The
separate reviewers ran `claude-opus-5-5` and `composer-2.5[fast=true]`; Cursor's
impact coverage remains explicitly incomplete.
These observations are not final-source or Mac release acceptance.

Additional Windows finding: ConPTY's OSC window-title prefix was partly left
behind by Node's general VT stripper, hiding an otherwise complete TAP header.
The small `runtime/verification.ts` fix strips complete OSC frames before VT
normalization, while rejecting incomplete frames and ignoring report-like text
inside titles. Fourteen verification tests pass. With the rebuilt runtime,
native post-pass `task:verify` records linked 8/8, 7/7 and 7/7 results for the
three real stories. This was invoked through the actual native RPC route; the
renderer has no standalone verification action yet. Fresh reviews and the
canonical-folder, same-epic three-provider native test are in progress.

The primary engine replay still independently fails on a real 150-commit
MemCode clone: `owned source retains extra source rows` (Windows, c411 engine,
2026-11-19 19:04 UTC). No graph reset or manual snapshot repair was used for
the successful independent-epic run above. This remains an engine release gate.

Windows canonical-folder test on `df766a1`: Codex and Cursor completed while
sharing the same `:source` graph and unchanged epic checkout. Claude's startup
correctly refused a certificate for an older source, but unnecessarily failed
when its peer saved a file during publication. The follow-up patch gives that
specific source-advance error a typed identity and retries ordinary current-source
analysis up to eight times. Foreign bindings and all other errors still fail;
no forced index or certificate relaxation is introduced. Targeted tests (66)
pass; final-source native repeat is pending.

Engine investigation pointer for Mac (hypothesis, not a confirmed repair):
`code-intelligence/src/ingestion/replay.rs:current_graph_at_walk_start` disables
the current-identity set when `node_base_branch != config.branch`. Both real
failures were on non-main branches. Check whether a managed `CurrentCheckout`
projection should supply its authenticated current identity set instead of
using the legacy inferred-main fallback. Preserve unmanaged feature inheritance
and historical reads; do not merely allow the extra rows or remove the guard.

### Windows final application acceptance, 2026-11-19

The peer-save retry passed the physical Windows same-epic repeat: real Codex
`gpt-6.2-sol`, Claude Code `claude-opus-5-5` and Cursor `composer-2.5` workers
all completed on the same selected folder and `:source` graph. The primary
history store was kept separate and was not reset. All three subsequent
reviews completed their capture, deterministic checks, quality and impact
phases, and separate read-only provider reviewers ran. Some anonymous-function
impact coverage is genuinely incomplete. Peer edits after another worker's
finish correctly prevented linking checks to that older whole-source snapshot;
these are reported unavailable, never converted into passed checks.

A larger real Codex task extracted three presentation components from the
existing WorkDetail. Its native Code review contains 51 measured functions
across four attributed files, including all numeric per-function cells. The
matched WorkDetail function changed from cognitive 361 to 273 and cyclomatic
245 to 174. Its native MI remains a measured zero; new components have nonzero
MI values. The separate read-only `gpt-6.2-sol` reviewer completed. A native
`task:verify` run links 30 passing assertions to this exact captured source.
This is a disposable QA contribution, not a production refactor to merge.

That task also exposed a Class B post-checkpoint bug: a normal directory scope
was treated as if it had to be one file. The follow-up application patch
expands directories using literal Git inventory, retains root/symlink checks
and bounds rereads to 20 files with explicit truncation. The actual attributed
checkpoint had already been saved before the old reread error. Regression
tests cover its preservation, new extracted files, literal folder names,
bounded coverage and rejection of outside-directory links.

Final local application checks: typecheck and build passed; 942 tests passed,
zero failed. The installed Windows QA app was reopened with this runtime and
retained its seven stories, attributed patches, checks, provider sessions and
saved reviews. The native shell remains the staged beta.18 native source; final
release resources and the final Mac engine must still be rebuilt and packaged.

No new Mac engine fix or acknowledgement was present on the shared Git refs at
19:58 UTC. Mac: fetch this handoff branch, preserve your existing fixes and push
your exact source/test receipt back to Git. The c411 large-history replay
failure remains a release gate. Do not publish beta.18 until the full Mac flow,
two-device continuation and final updater signatures pass.

### Mac reproduction, 2026-11-19

The running Mac build reproduced the same replay failure on Apple Silicon
macOS 27.2. The disposable clone was at app commit `127cf9ce34bac316b9d564a2f517cf29bcef812b`
on a feature branch. The checkout had 150 reachable commits. The native
`c411ab42fa4bd33cb1b49b05cb53d30b74dd965c` debug engine replayed 109 trunk
and 79 feature-branch commits, then refused the current source with
`owned source retains extra source rows`. Its executable SHA-256 was
`7f19eba390b06b16196ae704dd490309ce52edf57b0253e917813d37f8487e34`.
This diagnostic build used a larger debug thread stack. An independent main
checkout completed its 150-commit replay. Both stores are retained locally.

A small native regression now reproduces the same refusal when a feature
branch removes a file in a backdated Git commit. An engine patch is being
tested. It passes the clean branch's verified source identities to replay so
old rows close at the current source's cutoff. The publication checks remain
in place. The fix still needs the large-repo and package checks.

The isolated Mac app at `aa1d664c304e62f697078b4cee1ba2780007917b` built
locally. It passed 937 tests and skipped three Windows-only cases. With the
existing pinned engine, Improve refreshed in 16.496 s and 1.233 s and Insights
loaded on the same store. The saved MC-039 table matched 810 before/after cells,
including 118 zeros and 400 unavailable values. The live Claude reviewer
answered the last row accurately. The historical report remains partial.

The earlier `c3ca4a8` QA app started a real Codex story in an independent
epic while the canonical import was still active. The epic recorded one Git
snapshot and did not duplicate the 150-commit import. The worker exited cleanly
and its two focused tests passed in the epic. The review lacked an attributed
patch, and the renderer needed a reconnect to show the saved worker outcome.
Those remain open checks for the current app with the final engine. The
two-device run and final signatures are still pending.

## Confirmed Windows failure

### Windows acknowledgement of Mac engine fix, 2026-11-19 20:23 UTC

Windows fetched engine commit `9e97ab12ac6de1a1bb07c061199ea751935114fb`
from `fix/memcode-replay-source-projection`. Its local optimized build is in
progress. The application acceptance source remains `cb2c38e`; `fcf4ef9` adds
only the Mac report above. Please integrate through `cb2c38e`, preserving the
Mac engine fix and existing native changes. No engine pin is changed yet.

On Windows, the larger story's actual native **Review again** run also
completed after reopening the QA app: 51 per-function rows, the separate
read-only `gpt-6.2-sol` reviewer and 30 linked passing assertions survived.
The run took 3 minutes 10 seconds including graph analysis and model review.
The final runtime passed the installed Tauri smoke check. Those observations
do not replace native acceptance with the final engine or final packages.

Next Windows checks use the exact `9e97ab12` binary against the retained
150-commit QA store, then actual Improve refresh, Insights and a coding
story/review. No graph reset is authorized or needed for that test. The
two-device continuation check and both final updater signatures remain gates.

Application source `127cf9ce34bac316b9d564a2f517cf29bcef812b` with engine
`c411ab42fa4bd33cb1b49b05cb53d30b74dd965c` was tested locally in a separate
installed Tauri profile and a physical clone of MemCode.

- The first worker waited 10 minutes for the canonical graph. Its automatic
  150-commit history import failed with `owned source retains extra source rows`.
- After a separately recorded full snapshot recovery, the owned epic graph
  imported the same 150 commits again. A real `gpt-6.2-sol` coding worker passed
  its seven tests and produced its attributed diff, but the actual Code review
  tab waited about three minutes and failed publication verification while that
  epic history import was running. The model reviewer never started.
- The partial review did render all 85 available per-function numeric cells.
  Missing before values were correctly unavailable for newly added functions.
- The c411 stale-edge regression and native cold-history preservation checks
  passed separately. They do not establish that history replay is now safe.

## Work ownership

Windows is fixing application startup and Fleet routing: an owned epic must use
its own certified current-source graph, without repeating automatic Git history
replay or waiting for the canonical history import. Same-epic agents still share
one checkout and Fleet store; project identities in the board remain unchanged.
Legacy engines retain their existing preparation path. Source certificates must
not be bypassed or a partial review described as passed.

Mac agent: please investigate the engine history replay failure on the c411
branch in parallel, preserving your existing fixes. `run_cli_replay` and
`AppSourceWriter::publish_replay_baseline` end in
`verify_owned_after_replay`; current source retains extra SOURCE_IDENTITY rows
after a real 150-commit replay. The tiny one-commit fixture does not reproduce
this. Preserve source history and journal episodes; do not wipe the graph or
weaken continuity checks. Push any engine fix and its receipt, with the exact
commit and binary hash. Coordinate through this Git document rather than
changing the same application files concurrently.

## Required acceptance after the patch

Use the existing isolated, approved QA account/profile on each physical OS.
Preserve the normal install, credentials, models, projects and all graphs.
No Actions or hosted runners. Keep beta.18 staged until both reports pass.

1. Build the final engine/application source locally. Record exact commits and
   hashes, including the executable the native app actually launches.
2. Use a disposable clone with substantial history. Start its canonical history
   import, then start a real coding worker on an independent epic. It must reach
   the provider without waiting for history. Do not manually repair or reset an
   index to make this success path pass. Record timing and job state.
3. In the installed app open that story's Changes and Code review tabs. Run the
   real review while canonical history remains active. Check complete graph
   verification, the separate reviewer, attributed diff, numeric per-function
   evidence, before/after coverage and actual check results. Missing evidence is
   unavailable, never zero or an invented success.
4. Repeat with two independent epics and same-epic cooperating workers. Verify
   the current graph reflects edits, no duplicate history replay is started for
   an epic, and stop/reopen keeps graph, history and conversation state.
5. Run the existing two-device shared conversation/follow-up/review-result test
   with the final source, including provider model identity and origin device.
6. Run app checks and relevant engine regression tests; report failures rather
   than suppressing them. Sign final updater packages only after native pass.

The initial handoff is a request for coordinated work, not a Mac test result.
