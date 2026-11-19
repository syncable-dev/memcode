# Beta.18: history independence and native acceptance

Status: **not cleared for publication**. This branch is the Windows-to-Mac
handoff. Application changes are now present; native acceptance is in progress.

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

## Confirmed Windows failure

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
