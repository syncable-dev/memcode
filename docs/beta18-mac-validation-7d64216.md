# Mac beta.18 validation at 7d64216

The Apple silicon QA app at `7d642165f7f1169326e8bb13a27f37b84dbbb97b` ran on physical macOS 27.2. The Windows integration at `0b702d61b09800221dea97f1c9cab7e177fb2a95` arrived afterwards. Keep this archive in draft. Its results and hashes apply to the Mac source above.

## Build and packages

| Gate | Result |
| --- | --- |
| npm ci, typecheck, web and native build | Passed in 4.48 s, 2.14 s, 3.70 s and 46.79 s |
| Node tests, concurrency 2 | 899 passed, 0 failed, 3 Windows-only skips in 105.00 s |
| Rust tests | 40 passed, 1 production updater case ignored in 33.68 s. The Keychain rotation case returns early outside CI. |
| Pinned engine | Source `1d0e8cb4a4fb3f5b9638fa5ff4841cd1baf378ae`. Executable SHA-256 `55f65a3a0acfe49595eea8a0f92b08fd203f67109acd8fb2842f96a8b3293fb6`. Archive SHA-256 `3ed166eb0081ff629a632af06a0c63ea67ca27134dd39637e6674dcd3539db36`. |
| QA and production package runtime | SHA-256 `fb1c4dd1d2bd16616a36199bab5ce082168289422374e75c0eedcac81f56f96d` |
| MemCode_0.4.0-beta.18_aarch64-7d64216.dmg | 145266599 bytes. SHA-256 `fbc5a635a4a316ffc3a3954d720a9d4d802adbf2d5d211ab7a3ed61b4f1caae2` |
| MemCode-7d64216.app.tar.gz | 146178450 bytes. SHA-256 `59c795025a06599149d677085e097d62ac878d86af113f140fd5cc5289a0de7b` |

All 3,734 files matched between the mounted DMG and the unpacked updater archive. The package job emitted both files and then exited 1 at the production updater signing step. The app carries an ad-hoc signature. Apple Developer ID, notarization and a signed install/relaunch are outside these results.

## Installed app

- Improve accepted two successive refreshes. Insights showed five measured functions in the shared project, including total, average and range. The earlier initial QA baseline recorded a 12.716 s capture and refreshes of 0.241 s and 0.231 s. Those timings belong to the earlier build.
- The saved MC-039 report `eaf2bc59-182e-44f9-a282-1fee640d1878` matched every one of the 810 displayed cells across 81 functions. The UI preserved 118 zeros and labeled 400 unavailable measurements on 80 ambiguous declarations. All four charts used matched functions. A fresh read-only answer for row 81 returned 0, 1, 0, 81.99064198045949 and 41.209025018750054 before, with five nulls after. The reviewer explained why the declarations could not be safely paired.
- The registered Windows device and the Mac joined the official Team service with workerSessions version 1. They used one member identity. The earlier MC-002 follow-up ran once in the original Codex session at `d087c05350f84b8cc3879d9c72feac93dad55366`. At 7d64216 the Mac picked up two Windows-authored MC-004 messages once each. The cancelled third message never reached the worker. The earlier completed attempt retained its terminal state. The hosted role mapping synced and enabled the real Code review lane.
- MC-002 completed all five review phases while MC-004 was active in another epic for at least 127.113 s. The Mac and Team service stored the same report and native metrics. The verdict correctly remained incomplete because no verification was linked to this worker pass. Windows-side review-question delivery, a second member identity and offline recovery each require separate evidence.
- On MC-003 the resumed Claude requested a read of the shared base file despite the assigned single-file scope. The subsequent Bash request targeted an absolute write to the same base file. Both requests were declined and the worker was stopped before the base was changed. The worker's brief referenced both the epic and the base. The integrated source needs a real retest.
- The earlier installed runs at 2f2da1e and d087c05 established normal QA Connect, authenticated model catalogs, three real workers in parallel and preserved native review history. The installed Claude Code 2.1.212 supports the read-only reviewer mode. The older 2.1.158 does not.

## Packaged-service tests

The production service ran actual authenticated Codex, Claude and Cursor processes in three fresh disposable epics. All three first turns edited only their assigned file. All three automatic follow-ups subsequently timed out awaiting a certified graph. An explicit retry completed each follow-up in its original provider conversation. All six targeted tests passed and the base stayed clean. A separate pass through task verification attached two passed tests per exact worker pass. All three new native reviews then returned ready with complete coverage. That check took 121.5 s. The initial simultaneous follow-ups still required manual recovery.

The separate documented managed-engine local relay remained skipped for all three providers because the QA profile has no managed engine access proof. The real Team and native app tests above used the pinned standalone engine.

The QA project is **Beta release verification**. MC-002 is Codex, MC-003 is Claude and MC-004 is Cursor. Windows can open MC-002's saved review and send a question from the shared card. Record peer identity, report identity and shown answer independently. Production signing must use the exact archive selected after cross-platform acceptance.
