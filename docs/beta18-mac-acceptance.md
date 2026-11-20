# MemCode beta.18 Mac acceptance

On 19 November 2026 the installed Apple silicon QA app passed the analysis,
historical review and three real coding checks. Hold this candidate. The
first automatic review failed on all three stories, and a Codex follow-up
started a new provider conversation. The two-device check is still open.

## Build tested

| Item | Value |
| --- | --- |
| MemCode | `2f2da1e1b8fbbf4a694a8e0ae503a19d1333637a`, version `0.4.0-beta.18` |
| Identical application code tested on Windows | `54eef4f7cedc4ea5f43a8413a15a361c119a6602` |
| Physical Mac | macOS 27.2, arm64 |
| Memtrace engine source | `1d0e8cb4a4fb3f5b9638fa5ff4841cd1baf378ae` |
| Engine executable SHA-256 | `55f65a3a0acfe49595eea8a0f92b08fd203f67109acd8fb2842f96a8b3293fb6` |
| Engine archive SHA-256 | `3ed166eb0081ff629a632af06a0c63ea67ca27134dd39637e6674dcd3539db36` |
| Bundled service SHA-256 in QA and both packages | `0aa2f55f8e79ac12170488f884a317e6d06e32a2575c99632887f9dc005c253c` |

The checkout, installed QA app, profile and three-epic project were isolated.
The QA app used the pinned local CLI. Fixture tests and actual app results
are listed separately.

## Local tests and builds

| Local command | Result | Elapsed |
| --- | --- | ---: |
| `npm ci` | Passed | 4.45 s |
| `npm run typecheck` | Passed | 2.53 s |
| `node --import tsx --test --test-concurrency=2 tests/*.test.ts` | 875 passed, 0 failed, 3 Windows-only skips | 115.38 s |
| `npm run build` | Passed | 4.69 s |
| `npm run build:native` | Passed | 85.17 s |
| Rust tests | 40 passed, 1 signed-updater case ignored. The Keychain rotation case returns early outside CI. | 106.84 s |
| Installed QA app bundle build | Passed | 41.52 s |

## Installed Mac app

- **Improve and Insights passed.** The baseline took 12.716 s. The two
  Refresh analysis clicks produced saved checkpoints after 0.241 s and
  0.231 s. All three matched all seven project files. Insights showed five
  measured functions, 11 symbols and 62 relationships. At peak the primary
  store and three epic stores had one owner each. No competing lock was seen.
- **MC-039 passed.** The real Code review tab opened a preserved copy of
  native report `eaf2bc59-182e-44f9-a282-1fee640d1878`, SHA-256
  `99fe553b40b114cccd1c87e4201fdf20c80fe3ed00a915865eb30ff5364a9afd`.
  All 810 displayed values across 81 functions agreed with the report at the
  UI's display precision, including 118 zeros. The 400 unavailable cells belong
  to 80 declarations with an uncertain rename or replacement. The expanded
  row explained the ambiguity. All four charts used the single matched function.
- **Late-function question passed.** In the actual review tab, Claude
  `claude-opus-4-8` answered for row 81 in 24.407 s. Its before values were
  cognitive complexity 0, cyclomatic complexity 1, maximum nesting 0,
  maintainability index 81.99064198045949 and Halstead volume 41.209025018750054.
  All five after values were null. All ten matched the native row.
- **Three real coding passes passed.** All three workers were approved
  through Connect in the QA profile. Each fixed its assigned file, exited
  successfully and passed an independent test that failed before the edit.
  The three epics ran concurrently. Codex used `gpt-5.6-sol` on B18-001,
  Claude used `haiku` (confirmed `claude-haiku-4-5-20251001`) on B18-002,
  and Cursor requested `composer-2.5[fast=true]` (confirmed `composer-2.5`)
  on B18-003. The refreshed Codex menu matched all three advertised CLI
  models, Sol, Terra and Luna from the GPT-5.6 family.
- **New reviews failed on the first attempt.** All three reported that the
  epic source and graph publication could not be verified immediately after
  the edit. Cancelling and retrying Codex worked. All five phases of the retry
  finished in 144.871 s and saved two native measurement rows. Its verdict was
  incomplete because the exact worker pass had no linked verification report.
  The other epic kept its original owner during the review.
- **Local queue editing and cancellation passed. Provider continuity failed.**
  The edited text persisted, the cancelled message stayed cancelled, and the
  Mac automatically picked up the remaining follow-up once and returned its
  two passing tests. Codex recorded two separate provider threads for the
  initial turn and follow-up. The conversation visible in the app retained
  the messages.

## Additional provider checks

The bundled service ran a separate, real read-only review for each provider
against private copies of the same historical report. Claude matched row 81
in 30.52 s, Codex in 35.88 s and Cursor in 34.80 s. The QA launch selected
the already-installed Claude Code 2.1.212, which supports safe mode. The older
2.1.158 installation rejected both read-only switches. A separate first
single-turn Sonnet probe missed its expected result. Its Haiku retry passed.

In a second isolated packaged-service run, a cold Claude story missed the
30 s source-verification window. A later ordinary retry started successfully.
Cancelling and retrying a Codex review released the previous store owner before
its replacement acquired the lock. The concurrent Claude owner stayed live.

## Pairing and signing

The hosted Team service returned `workerSessions:1`. Windows reported its
packaged QA app was ready in **Beta release verification**. The Mac QA profile
has no membership in that shared workspace. The two-device checks for live
progress, peer queue edits, reconnect, host restart and shared review answers
remain untested. The QA project `beta18-mac-worker-qa` and stories
`b18-alpha`, `b18-bravo` and `b18-charlie` are local to the Mac.

The documented managed-engine two-member relay script was skipped for all
three providers. The isolated QA profiles had no current managed access proof.
The real single-Mac tests above used the pinned standalone engine.

| File in draft `beta18-staged-54eef4f` | Bytes | SHA-256 |
| --- | ---: | --- |
| `MemCode_0.4.0-beta.18_aarch64.dmg` | 145266319 | `897c31158c90a198a7acbf563efc99f6e3b392a43a1ab7575a174b36de253d2f` |
| `MemCode.app.tar.gz` | 146178175 | `b530869082690fb255076072b120afbe23a7cbc09332a2d39087f99876f24ef7` |

The DMG was mounted read-only and the archive unpacked. All 3,734 application
files matched across packages. Both app copies passed strict ad-hoc signature
verification. These are unsigned updater candidates. Production updater
signing, Apple Developer ID signing, notarization and an actual signed updater
install/relaunch are outside these results.
