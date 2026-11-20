# Beta.18 Mac acceptance for ef14119 and 69e7a3c

**Hold publication.** The Mac packages and saved-work checks passed. The approved Mac QA session did not produce a current access proof, so the new engine's retained-history recovery and live Mac workers are still open.

## Source and local checks

- Application `ef141194efbfa84ff4fe8d1ec0433195f6e9dffd`, from the handoff at `ea26a6201ebb1f653629e866fcd799d73cdf9416`.
- Optimized arm64 engine `69e7a3c0b85b9a66ef0400b1ac77c30eadac7891`, SHA-256 `346bac1d7985980177692e51afbc8ab01bef2dfbbfc1b1dc632ec78ff927bd01`. Rust 1.97.1, full LTO, deployment target 13.5, 1,076 seconds. The MemDB and Tantivy submodules match the source record.
- npm ci, typecheck, renderer/runtime build and native Tauri build passed. The bounded Node rerun passed 978 of 981 tests with three Windows-only skips. The first run hit a helper-exit timing assertion while the engine was compiling. The focused rerun and full rerun passed. Rust passed 40 tests with the production-signature test awaiting a signed payload. The browser updater fixture passed eight scenarios.
- Engine tests passed all 235 graph and 85 replay cases. The app's archive verifier checked all ten files in the local candidate. Using its bundled Node and a disposable profile, MemCode extracted and ran the exact bundled executable for a version check in 2.942 seconds, with the global CLI off PATH.
- All 24 documented product unit checks passed on the exact engine. Six covered owned checkouts, 12 covered beta access, five covered runtime guards, and one covered the linked-worktree watcher.

## Physical Mac application

Two normal quits and cold starts of the installed beta.18 QA app preserved six projects, 19 stories, all settings, and the three connected workers' approvals. Those restarts and the review checks used the published pin. The separate installed QA variant with the newly bundled engine also opened the existing workspace and displayed its saved Insights.

The new bundle's Node ran the product dictation and retrieval adapters with cached local models. Dictation recognized both fixture phrases in 1.618 seconds. Retrieval ranked the expected result first in 1.808 seconds. Both ran offline. This check used recorded audio.

Both Improve refreshes on the installed app with the published pin asked to reconnect MemCode beta. They left all five saved checkpoints intact. With the new bundled engine, the first refresh waited on the native credential request and the next refresh stayed disabled. Insights still showed 12,682 symbols, 127,348 relationships, 682 indexed files, and 8,657 measured functions from the saved checkpoint. Fresh analysis, source certification, store-owner behavior during refresh and parallel epic coding remain unverified on the final Mac candidate.

The cold copy of the failed Mac QA store retains the original store identity and exact 25,893-byte journal. A native sidecar scan at Git commit `127cf9ce34bac316b9d564a2f517cf29bcef812b` found 25,419 unique nodes and 127,217 unique edges. Eighty-five edge identities accounted for 315 extra rows. This establishes the saved baseline. Recovery with `69e7a3c` still needs a current QA proof.

MC-039 rendered all 810 values across 81 functions. Every value matched the saved report at display precision, including 118 zeros and 400 unavailable values. Four charts used the one matched function. A new local Claude Opus 4.8 response agreed with the final row at full precision and explained the ambiguous pairing. It took 26.146 seconds. The original MC-039 report still records incomplete coverage.

The hosted Team service advertises `workerSessions:1`. The Mac opened Windows' MC-007 review with 51 function rows, 255 before/after metric cells, 30 passing checks and the impact-coverage limit. The Mac submitted one read-only question. The original Windows reviewer, shown as Codex GPT-6.2 Sol, returned its answer on the same story. The Mac reopened the result after quitting. The Windows receipt and the visible table agree on the scale and recorded checks. The private native Windows metric file was unavailable for an independent comparison of all 510 values. The paired run used one approved member on two devices. Mac-hosted continuation, queue editing/cancellation and separate-member attribution still need a live pass.

The installed Mac DeepSeek Harness 0.1.0-rc.6 lacks an ACP profile. A disposable copy of 0.2.2-rc.5 initialized ACP and created a session, then refused generation because the provider was unconfigured. Real DeepSeek coding, continuation and review are open.

The installed Mac Copilot CLI advertised 26 models. A direct ACP probe opened a session with Claude Haiku 5.5. The synthetic scoped tool was never called, including on retry, so the probe did not clear Copilot's Mac tool-use gate. Windows' native tool-use result is recorded separately in its receipt.

## Draft packages

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `MemCode-ef14119-69e7a3c-mac-arm64-private.dmg` | 145,369,815 | `ab2fa3d6dc1619fdaadb1110763c08cc03ba0cc6243423f0e10f7ba82ba2be53` |
| `MemCode-ef14119-69e7a3c-mac-arm64-private.app.tar.gz` | 144,833,466 | `217c7b4fa3e4b5e6edda3bef58773203f2acb9bf00b110e2e6d102243ee97b56` |

All 3,734 files and symlinks matched between the built app, mounted DMG and extracted updater. Both copies passed strict Apple code-signature verification with ad-hoc signing. The package's Mac engine archive SHA-256 is `3ac29e78a79a9cdb3d21a79ca119834eb03afb0968dfa22af24d9a3255e294fa`. The private build used a generated Mac-only catalog entry. Git still has the two published engine pins. The bundle requires production signing and notarization before public distribution.

Use the commit-specific files and sanitized receipts in the [private draft](https://github.com/syncable-dev/memcode/releases/tag/beta18-staged-54eef4f). Release remains gated on the authorized Mac history and worker checks, the remaining paired and DeepSeek checks, and both signed installer checks. The earlier physical beta.17-to-beta.18 relaunch used a different app commit and a QA key. The regular Mac app executable and the development checkout's recorded status both matched their starting fingerprints.

GitHub's reported sizes and SHA-256 digests matched both local packages, the checksum list and both receipts. The release remains a draft.
