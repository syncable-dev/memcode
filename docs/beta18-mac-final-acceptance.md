# Beta.18 Mac acceptance on the shared worker branch

The Apple silicon candidate was built from `7322ce6c7c0a0b146478800cc89d0f38645651c5` on a physical Mac running macOS 27.2. It includes the Windows fix for replies appearing in an earlier turn and the Mac fix for Claude receiving file paths in the wrong checkout. It also handles an incomplete native graph that could leave a queued worker stuck for 120 seconds after its own edit. **Hold this release.** The queued-worker repair passed. The actual Mac also reproduced a separate failure when project analysis overlapped an epic startup, and a shared command acknowledgement remained stale after retry.

## Source and packages

The isolated QA app and production packages contain runtime SHA-256 `d0ec35172bde58ee8b6780430ba4978f9a9e44182e5d4fe7b50704182ad35eff`. The engine pin remains `1d0e8cb4a4fb3f5b9638fa5ff4841cd1baf378ae`. The Mac engine executable has SHA-256 `55f65a3a0acfe49595eea8a0f92b08fd203f67109acd8fb2842f96a8b3293fb6` and its archive has SHA-256 `3ed166eb0081ff629a632af06a0c63ea67ca27134dd39637e6674dcd3539db36`.

The original development checkout remained on `3f19e161053cc5f1917bd66307f05ea0c7c8c4e5`. Its Git status matched the recorded starting state byte for byte. All QA writes used isolated profiles and disposable projects. Historical MC-039 measurements came from a preserved native report.

## Automated checks and build

| Check | Result | Elapsed |
| --- | --- | ---: |
| npm ci | Passed | 7.08 s |
| Typecheck | Passed | 19.05 s |
| Node tests with concurrency 2 | 919 passed, 0 failed, 3 Windows-only skips | 143.76 s |
| Web build | Passed | 39.28 s |
| Native build | Passed | 135.10 s |
| Rust tests | 40 passed, 1 case awaiting a production updater signature | 111.74 s |
| Bundled engine with global CLI hidden | Passed | 19.04 s |

The first Rust invocation ran before the renderer finished producing a required asset. Cargo stopped before executing tests. Its separate rerun after the renderer build produced the Rust results above. The first full Node suite also timed out in a browser screenshot fixture under load. All four tests in that file subsequently passed, including the timed-out screenshot in 5.54 s. The full-suite rerun is reported in the table.

## Physical Mac UI and real providers

**Queued workers.** The installed production service in a fresh three-epic QA project ran Codex (`gpt-5.6-sol`), Claude Code (`claude-haiku-4-5-20251001`) and Cursor (`composer-2.5`, fast requested). All three made their scoped edit and automatically processed the edited follow-up in the original native session. All six targeted tests passed, the base stayed clean, and the original owners remained distinct across 300 samples. This run took 358.2 s. Normal graph publication completed before the recovery threshold. These were real local providers and the packaged service with disposable data, separate from the hosted board below.

**Native provider memory.** On the final source all three actual adapters edited a disposable file, passed an independent assertion, and recalled a random first-turn value after restarting their provider process in the original conversation. The formal run took 96.3 s. The Cursor adapter emitted no model measurement in this particular script; the separate installed product run confirmed `composer-2.5`.

**Shared project analysis.** Two normal Improve refreshes failed immediately after the QA host restarted, during preparation of the Windows-requested Claude turn. No checkpoint was saved. Two distinct new native jobs at 09:44:27 and 09:44:33 UTC rejected a mismatch between the source writer and the backend store. After the workers went idle, an ordinary refresh yielded a partial checkpoint. Two more refreshes yielded consecutive fully aligned checkpoints, increasing the count from 9 to 11. Insights then displayed 11 symbols, 62 relationships, seven indexed files and five measured functions. The base store had one observed lock holder, and its selected store and live backend identities matched when investigated. These later successes do not erase the concurrent failures. No lock was removed, graph reset or identity guard bypassed.

**Hosted Claude retry.** A Windows-authored follow-up had previously failed to confirm Haiku on cb98c2b. On the final build the normal catalog refresh advertised Default, Opus, Fable, Sonnet and Haiku. The subsequent pass cleared model selection and failed one step later when Fleet tried to join the unavailable base graph. These were separate attempts with different causes.

**Historical review on the latest app.** The installed WKWebView table matched the saved native MC-039 report on all 810 cells across 81 functions, including 118 real zeros and 400 unavailable before/after measurements. Four charts used the single matched function. A fresh read-only `claude-opus-4-8` answer matched all ten last-row values in 25.821 s and explained the ambiguous rename/replacement. This was the preserved native report for MC-039 rather than a synthetic story.

**Review verification.** The production service linked two passing TAP checks to each exact worker pass. Codex and Claude each returned three measured rows; Cursor returned one. All three native reviews returned ready with complete coverage, in 103.9 s.

After the base graph recovered, the same Windows MC-003 question completed on the original Mac, in the original Claude session and checkout. The pass took 21.760 s, returned one answer and identified the two passing tests. Windows' later MC-004 question also completed once on the original Cursor host in 15.229 s. Its creation time was after relaunch.

The hosted service still showed the retried Claude command as received after the local worker had used it exactly once. An explicit Team refresh did not advance that acknowledgement. Windows' separate Cursor command reached picked-up as expected. The difference in Claude's shared status remains a failed gate at this commit.

A separate disposable reproduction established the cause of the refresh error. When the epic's database server started, the base daemon changed its live socket from its own database server to the epic's server. Each physical store still had a single lock holder. The native identity guard rejected the mismatched writes. Releasing the disposable epic let the same base write complete. The issue can therefore recur even though idle refresh and Insights subsequently passed.

On the previous Windows-integrated app `0b702d61b09800221dea97f1c9cab7e177fb2a95`, both Improve clicks completed, increasing the saved checkpoint count from four to six. Each checkpoint matched all seven source files. Insights displayed 11 symbols, 62 relationships and five measured functions. The saved MC-039 report matched all 810 displayed metrics, including 118 zeros. The 400 unavailable cells belonged to 80 declarations with no safe before/after pairing. All four charts used matched declarations. A fresh Claude Opus answer for row 81 took 40.398 s. The exact before values were 0, 1, 0, 81.99064198045949 and 41.209025018750054. The five after values were null. The original saved report ID is `eaf2bc59-182e-44f9-a282-1fee640d1878`.

## Real Mac and Windows Team session

The isolated project is **Beta release verification** (`183b45df-9fe3-473b-94a1-47bf1d2ac619`). On cb98c2b the corrected actual shared MC-003 Claude pass edited only the epic file in 66.231 s, passed both tests and left the base byte-identical. The official Team service advertised `workerSessions:1`. Its two registered computers used one Team member identity.

| QA story | Story ID |
| --- | --- |
| MC-002 · Codex total | `b3b1a740-ab63-47aa-8f5d-421c67fa7be8` |
| MC-003 · Claude average | `0e104274-a215-4fa3-aefc-487a01665813` |
| MC-004 · Cursor range | `7ab75437-175b-49b9-b5fc-0e213004fdab` |

- Windows saw the three Mac-owned stories. A Windows question about MC-002 ran once in the original Mac Codex thread at `d087c05350f84b8cc3879d9c72feac93dad55366`. Both the native session and the Team service retained the finished conversation.
- At `7d642165f7f1169326e8bb13a27f37b84dbbb97b`, two Windows-authored MC-004 messages reached the Mac once each. Windows edited and cancelled a third queued input. Mac verified that the cancelled input was never passed to Cursor. Windows subsequently found that a resumed Cursor reply could appear inside an earlier message. The combined source includes the Windows correction. A later actual hosted MC-004 pass at cb98c2b took 18.886 s and produced a distinct new answer below its question in both the local and hosted records.
- The Windows owner shared the project's original workflow. MC-002 completed all five review phases on the Mac while a worker stayed active in a different epic for 127.113 observed seconds. Both computers identified report `1b0ad628-276f-4c0a-8862-cd390b215abd`. Its two native measurement rows matched the official service. A person reading that report sees an incomplete verdict because no checks were linked to that exact pass.
- Windows sent a review question. The Mac received the exact question with its original author. The same Mac returned one `gpt-5.6-sol` answer in 35.106 s. Windows confirmed the answer and both before/after maintainability pairs in its installed app. This result was observed across two real devices.
- The Mac restarted into the same signed-in QA workspace and caught up with the official Team history. The host was offline from 09:40:38.343 to 09:42:41.856 UTC. No Windows command was recorded as created in that interval. The new Windows MC-004 input was created at 09:51:29.371 UTC. Host restart and post-restart delivery are confirmed. Queuing a new input during that offline interval and verifying receipt on reconnect remain untested.

## Coverage and remaining gates

The separate managed-engine local relay command was skipped for Claude, Codex and Cursor. The isolated Mac profile had no managed-engine access proof. The end-to-end tests above used the pinned standalone engine. Distinct-member attribution and permissions remain untested because both genuine devices use the same approved member.

At `7d64216` all three automatic follow-ups needed a manual retry in a three-epic run. At `cb98c2b` the packaged Mac service reproduced the same 120-second failure on Cursor. Its finished edit and 49-file native graph were preserved. The corrected `7322ce6` path first waits for normal publication. When that expires, only an eligible queued continuation on the original host, provider and checkout can recover. The app checks the unchanged source, the earlier worker's captured edits, the exact completed native job and cancellation before one incremental update. A stable native certificate is still required before starting the provider.

Four targeted reproductions used real native stores and Git worktrees with a synthetic story journal. Each timed out after 120 seconds. Another 12 seconds of read-only waiting on the same owner did not resolve it. One incremental update on each store produced a stable 9/9-file certificate with zero mismatches in roughly 16–17 seconds. On the exact corrected source, two further product preparation runs exercised every guard and returned complete certificates after 130.16 s and 129.87 s. Each queued one incremental job. Two healthy controls took about 1.1 s and queued none. These runs complement the separate packaged workers above. Older failed attempts without a saved whole-source binding must use the normal certified startup path. See the [earlier Mac report](beta18-mac-validation-7d64216.md) for the original failures.

Windows reported 911 passing unit tests, the native build and smoke check at `0b702d6`. Windows also passed 914 tests and native package checks on cb98c2b. It fetched 7322ce6 and confirmed typecheck. Its final platform suite and production signature must correspond to this same source and selected archive. The production updater key stays on Windows. The Mac candidate uses ad-hoc Apple signatures. Production updater signature verification, Apple Developer ID signing/notarization and a real signed install/relaunch are outside these Mac results. The draft remains unpublished.

## Draft files

| Draft file | Bytes | SHA-256 |
| --- | ---: | --- |
| `MemCode_0.4.0-beta.18_aarch64-7322ce6.dmg` | 145294594 | `5fac07c9b66f4629984d9722277b62ccd19034c4c192b68beb29e1907fb88899` |
| `MemCode-7322ce6.app.tar.gz` | 146180304 | `61d2525207761432d72e77e9317a23a82e9322f8f3e6c1614bfacc403f2e28ae` |

The mounted DMG and extracted updater archive contained the same application files. SHA-suffixed asset names distinguish these bytes from earlier signed or unsigned attempts in the same draft. The builders used the standard candidate workflow. Its final signer returned exit 1 after emitting both packages because the production updater key stays on Windows. Sanitized acceptance results and the checksum file accompany the candidate in the draft.
