# Beta.18 Mac acceptance at 9251532

The tested MemCode commit is `925153200c09e1fb3485c2aa821ce446bb61f780` on
`fix/beta-approval-stall`. It fixes browser approval and Cancel getting stuck
behind a running analysis. The Mac used the optimized Memtrace
`69e7a3c0b85b9a66ef0400b1ac77c30eadac7891` engine. Its ARM64 executable
SHA-256 is `346bac1d7985980177692e51afbc8ab01bef2dfbbfc1b1dc632ec78ff927bd01`.
The Mac-specific candidate catalog was generated locally. The committed engine
pins still point to the previous engine.

## Physical Mac checks

- On macOS 27.2 ARM64 the installed QA app signed in. Two ordinary quits and
  relaunches retained the connection, the same graph store, six projects, 19
  stories, three worker approvals, saved reviews and settings. The owner
  released the store lock at each quit.
- The two Improve refreshes took 2.353 and 9.106 seconds. Both recorded aligned
  checkpoints. Insights reported 682 indexed files and 8,657 measured functions.
  The primary store had one lock owner and showed no lock errors.
- A cold copy of the retained failed QA store replayed all 150 commits in 237.675
  seconds including the status probe. The recovered graph reported
  `needs_replay: false`. At the saved Git cutoff the native read counted 25,419
  unique nodes and 127,217 unique edges, with no duplicates. The journal grew
  from 25,893 to 46,306 bytes with the original bytes as an exact prefix.
  The store ID and original store remained intact.
- The saved MC-039 report displayed 810 values for 81 functions. Every one
  matched at display precision, including 118 zeros and 400 unavailable
  before/after values. The fresh read-only answer for the last row returned
  full precision in 32.699 seconds and explained the ambiguous pairing.
  The saved report still records incomplete coverage.
- Real Claude Opus 4.8, Codex GPT-6.2 Sol and Cursor Grok 4.7 completed coding
  and queued follow-ups on the original host, independent checks, native review
  and a peer review question. These runs used disposable projects and a local
  two-member relay. The first Codex attempt timed out during concurrent native
  history replay and passed on a fresh run after replay. The first Cursor
  catalog request was empty. Its authenticated retry returned 49 models.
- npm ci, typecheck, frontend and native build passed. App tests passed 981 of
  984 with three Windows-only skips. All 23 targeted beta tests passed. Rust
  passed 40 tests with the real production updater signature test pending.
  The engine passed 235 graph, 85 replay and 24 product tests.

## Physical update rehearsal

The isolated beta.17 app automatically downloaded the whole beta.18 QA archive
once. After quit and reopen, the cached file had the same hash, inode and
modification time. **Install and restart** replaced the app at the same QA path
and a new process appeared within 12.173 seconds of the install observer
starting. Settings reported beta.18 and up to date. The saved story and worker
limit of seven survived the update and another ordinary reopen.

The upgraded app's bundled runtime transcribed the known audio fixture in
401 ms and ranked the expected local retrieval result first in 1,756 ms.
The dictation check used prerecorded fixture audio.
The first attempt failed because the QA HTTPS certificate authority was
untrusted. Only the disposable retry build pinned that QA certificate
authority. The native updater used a version-bound QA signature. Acceptance
of the exact production-signed archive remains open.

## Packages for Windows

| File | SHA-256 |
| --- | --- |
| `MemCode-9251532-69e7a3c-mac-arm64-private.dmg` | `23695741de219c45b58e41990daaa388e1f05e8d4eb4c53d85135b8751c58263` |
| `MemCode-9251532-69e7a3c-mac-arm64-private.app.tar.gz` | `b787d8a903748aa0b65f34827d51838d1d76a476f5059de74df2dbbfecbc80e3` |

The mounted installer and extracted updater matched across all 3,734 entries.
Both passed strict ad-hoc Apple signature verification. The draft asset digests
match the local files. [Private draft and acceptance receipts](https://github.com/syncable-dev/memcode/releases/tag/beta18-staged-54eef4f)

Windows should rerun the changed app source at `9251532` with engine
`69e7a3c`, verify the exact archive checksum and use the existing production
key to sign it for `0.4.0-beta.18`. Upload the corresponding `.sig` without
repacking the archive. The Mac will verify that signature and exercise the
exact production-signed update. Public macOS distribution requires Developer
ID and notarization for the approved final bytes separately from updater signing.

Hosted Team returned `workerSessions:1`. Two distinct members on this build
still need the live pickup, queue edit and cancel, offline resume and shared
review checks. Earlier parallel-epic and Copilot receipts use earlier app
commits. The available DeepSeek setup lacks a provider for real generation.
Keep the draft unpublished until the same-build acceptance gates pass.
