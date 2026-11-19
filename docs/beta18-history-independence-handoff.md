# Beta.18: history independence and native acceptance

Status: **not cleared for publication**. This branch is the Windows-to-Mac
handoff. Application changes are now present; native acceptance is in progress.

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
