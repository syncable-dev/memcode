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

Windows: typecheck, frontend/runtime build, 18 targeted regressions passed.
The first full test run raced the artifact-viewer rebuild (931 passed, one
missing-built-assets failure); that artifact test passed after the build and
the full suite is being rerun sequentially. A fresh installed-app worker has
joined Fleet and reached real GPT-6.2-Sol while primary history imports.
Its review has not passed yet. These are progress observations, not release
clearance. Native application binary was unchanged; this early acceptance run
uses a rebuilt runtime override. Final package checks must use final resources.

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
concurrently and both reached Review. Their native reviews are being checked.
These observations are not final-source or Mac release acceptance.

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
