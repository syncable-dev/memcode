# MemCode beta.18 on Apple silicon

MemCode `0.4.0-beta.18` on physical macOS 27.2 (arm64). The tested application commit is `127cf9ce34bac316b9d564a2f517cf29bcef812b`, on `feat/shared-worker-sessions`. It includes the Mac changes through `46d7e78` and the Windows receipt repair `205d672`. Validation started at `2f2da1e1b8fbbf4a694a8e0ae503a19d1333637a`.

**Worker, review and two-device checks passed. Hold publication.** The installed Mac app preserved its main graph during parallel work. All three workers continued in their original conversations. A Windows edit, cancellation and new message survived a real host shutdown. Windows also passed its platform suite on the same source. The signed updater bytes passed verification on both systems. One Mac relaunch showed a blank window until reload. The pinned engine also has a separate issue for external IDE clients during an epic.

The [relaunch and signed updater results](beta18-mac-updater-127cf9c.md) cover the foreground launch, the single download across restart, and the remaining production install check.

## What changed

When an epic started, a MemCode connection could switch the main project's analysis to the epic's database. The engine refused the mismatched write. The app now connects an ordinary single-repository project to its original database from a private launch folder outside Git. Its store ID, scope and saved graph are preserved. This keeps existing explicit connections and workspace configurations intact.

A failed worker could leave its shared follow-up looking unclaimed after a manual retry. MemCode checks a paused input for remote edits or cancellation before handing it to the worker. It can also repair an older receipt when the same host has already sent that exact input.

## Installed Mac app and hosted sharing

**Concurrent Improve and Insights passed in the installed app.** While Claude worked on MC-003, two clicks on Refresh analysis saved checkpoints 12 and 13 at 10:21:34.740 and 10:21:39.861 UTC. Both matched all seven files with zero mismatches. Opening Insights showed 11 symbols, 62 relationships and five measured functions. This is the same overlap that failed twice on 7322ce6.

**Historical MC-039 passed.** The real Code review tab showed 81 functions. All 810 before/after cells agreed with saved native report `eaf2bc59-182e-44f9-a282-1fee640d1878` (SHA-256 `99fe553b40b114cccd1c87e4201fdf20c80fe3ed00a915865eb30ff5364a9afd`). There were 118 genuine zeros and 400 unavailable values across 80 declarations without an unambiguous match between revisions. The charts used the matched functions only.

In the installed app, Claude Code 2.1.212 accepted the read-only review mode. The authenticated reviewer `claude-opus-4-8` answered a question about row 81 in 22.599 seconds. It returned cognitive complexity 0, cyclomatic complexity 1, nesting 0, maintainability 81.99064198045949 and Halstead volume 41.209025018750054. It identified all five unavailable after-values and explained why the native report could not safely pair the declarations.

Screenshots retained with the isolated Mac receipts include `insights-concurrent-epic.png`, `mc039-native-table.png` and `mc039-last-function-answered.png`.

The physical Windows and Mac apps joined the hosted QA project **Beta release verification** (`183b45df-9fe3-473b-94a1-47bf1d2ac619`). The service advertised `workerSessions:1`. It reported two devices and one approved member. Cross-device results below cover that member on both machines. Distinct-member authorization remains untested.

| Shared story | ID |
| --- | --- |
| MC-002, Codex | `b3b1a740-ab63-47aa-8f5d-421c67fa7be8` |
| MC-003, Claude Code | `0e104274-a215-4fa3-aefc-487a01665813` |
| MC-004, Cursor | `7ab75437-175b-49b9-b5fc-0e213004fdab` |

Earlier paired runs established that Windows could see all three workers, edit and cancel work before pickup, and receive a clear refusal after pickup. The same Mac continued the original sessions. Both devices displayed Codex review `1b0ad628-276f-4c0a-8862-cd390b215abd`, including the two per-function measurements. Its incomplete verdict accurately reported a missing verification for that particular pass. Another epic stayed active for at least 127.113 seconds during review. A Windows-authored review question received one answer on the original Mac in 35.106 seconds. The earlier Mac report identifies the revisions on which these observations were made.

On the current build the older MC-003 Windows command advanced on the live service from received (revision 2) to picked up (revision 3). One local user message was marked as sent, and all 18 shared assistant messages and the finish timestamp stayed identical across the repair.

**A Windows edit, cancellation and new message survived a real Mac shutdown.** The old app and Team service process were both gone and its profile lock released by 10:26:17.523 UTC. Windows edited one pending Claude message at 10:28:46.712, cancelled the other at 10:28:46.774 and submitted a new Cursor follow-up at 10:28:47.316. The Mac host stayed offline until 10:29:02.979. These times came from the live service and physical host.

MC-004 automatically picked up the new Windows message and answered once on its original Cursor conversation. MC-003 had been deliberately interrupted while waiting for local tool permission. Its old claim was still held. The owner verified that the original worker was gone, refreshed Team, reopened the story, released that device's old claim in Team and used Resume. Claude answered `PAIR-127-A-FINAL` once at 10:33:15.820 in the original conversation and checkout. The earlier text and the cancelled message were never sent. Thus offline delivery was automatic for the eligible Cursor worker. An interrupted approval on Claude required the documented manual recovery. A previously opened story initially continued to show the reconnect requirement after Team was in sync. Reopening the story enabled Resume.

In the same installed app, MC-002 ran a read-only Codex follow-up in a different epic and finished its native review while Claude waited for permission. The two measurements were present. The verdict accurately indicated that this particular read-only pass lacked linked checks. The independent packaged test below covers six linked passing checks.

**Mac window during reconnect.** On this launch, the QA window stayed blank for more than a minute even though the worker service received the Cursor message. Reloading the window restored it in under one second. The native bridge recorded a five-second unacknowledged snapshot. The cause of the blank window remains under investigation. Screenshot `reconnect-webview-before-reload.png` is retained locally.

## Independent native and provider checks

The installed runtime ran three real workers simultaneously in disposable epics. Each edited only its assigned file and automatically continued the original native provider conversation with the final queued text. Cancelled input stayed cancelled. The shared base remained unchanged. Across 322 lock samples, each physical store had at most one owner. This run used actual provider programs, took 365.2 seconds and was separate from the hosted Team UI.

| Worker | Confirmed model | Tests linked to this pass | Native review |
| --- | --- | --- | --- |
| Codex | `gpt-5.6-sol` | 2/2 passed | Ready, 3 measured functions |
| Claude Code | `claude-haiku-4-5-20251001` | 2/2 passed | Ready, 3 measured functions |
| Cursor | `composer-2.5` (fast requested) | 2/2 passed | Ready, 1 measured function |

These three reviews finished in 95.6 seconds. The installed runtime and bundled Node produced reports linked to the exact implementation passes. The earlier native adapter restart-and-recall probe passed for all three on 7322ce6. The relevant adapter, PTY and probe source objects were identical on 127cf9c. The packaged three-provider run above was performed independently on 127cf9c.

A separate installed-runtime cancellation and retry took 68.2 seconds. Codex's original review owner released its store after 4.6 seconds. Its replacement acquired it at 5.5 seconds. The neighboring Claude epic kept the same owner throughout. Both reports finished ready and the original source diffs and saved linked reports stayed byte-identical.

Two disposable native runs covered an existing primary graph and a newly indexed primary graph. Each passed two main-project updates while an epic was active and one update after the epic closed. The original failure recorded 92 samples in which the main client connected to the epic's database. The fixed MemCode client recorded zero. With a separate command-line client already holding the primary store, the corrected MemCode refresh passed before, during and after the epic in 12.955 s, 3.610 s and 10.737 s respectively. The original store ID survived.

**Separate engine limitation.** An ordinary IDE-style Memtrace client outside MemCode can still change its connection to the epic while reporting the main repository. A second client opened during that interval refused to start because the scopes disagreed. After the epic closed, the first client returned to its original store and a fresh connection worked. This was reproduced using disposable stores and the exact pinned executable. The test used read-only probes from the external clients.

## Build, package and test receipts

| Local check | Result | Elapsed |
| --- | --- | ---: |
| npm ci | Passed | 5.48 s |
| Typecheck | Passed | 2.14 s |
| Node unit and integration suite, concurrency 2 | 928 passed, 0 failed, 3 skipped | 141.87 s |
| Web build | Passed | 4.44 s |
| Native build | Passed | 78.47 s |
| Rust tests | 40 passed, plus the real production-signature case run separately | 40.19 s |
| Bundled engine with the global CLI hidden | Passed | 7.89 s |

The Mac-only run skipped three Windows-specific cases. The macOS Keychain test also returns early outside its hosted environment. The separate managed-engine relay harness lacked an approved short-lived QA proof and was skipped for all three providers. The actual provider and Team tests used the pinned standalone engine with their own existing QA authorizations.

| Draft file | Bytes | SHA-256 |
| --- | ---: | --- |
| `MemCode_0.4.0-beta.18_aarch64-127cf9c.dmg` | 145289643 | `a1ef5f4a36603565cbec03f425335f4b9ad4554359ddc5ba3f6e79577254b2fb` |
| `MemCode-127cf9c.app.tar.gz` | 146179489 | `50490bea7238e8337f977c93eeb19b8cfcabb5be9364655efd37a9243df7f5b6` |

The pinned Memtrace commit is `1d0e8cb4a4fb3f5b9638fa5ff4841cd1baf378ae`. Its Mac executable has SHA-256 `55f65a3a0acfe49595eea8a0f92b08fd203f67109acd8fb2842f96a8b3293fb6`. Its pinned archive has SHA-256 `3ed166eb0081ff629a632af06a0c63ea67ca27134dd39637e6674dcd3539db36`. The installed QA runtime and production package runtime have SHA-256 `ed53e58697ab509fe830686d980a557f3f1f31715ac430fa9b01f20e91c0bd49`. The mounted DMG and extracted updater archive matched across 3,734 application files, with valid deep ad-hoc Apple signatures. Windows signed the exact updater archive. On the Mac, the real native verifier accepted it in 6.54 seconds and rejected a modified payload, an incorrect key and a relabelled version. The signature file has SHA-256 `a9542e760f65ad14a77561919b8d9dd29422ab0061cd655e4cbbebde1693307d`. Apple Developer ID signing and notarization are separate and were not performed. The original development checkout retained its recorded HEAD and identical Git status.

The draft tag is `beta18-staged-54eef4f`. Use the SHA-suffixed filenames above to select this candidate. The earlier [Mac acceptance at 7322ce6](beta18-mac-final-acceptance.md) records the original failures, cross-device review and historical results.

The physical Windows agent reported results for the same application source, `127cf9ce34bac316b9d564a2f517cf29bcef812b`. Typecheck, 931 tests, the native build, desktop smoke, the extracted NSIS installer, updater access controls and the installer private-data scan passed. Windows verified the production updater signature for that Windows installer. The packaged Windows app reopened its existing approved profile at 10:22:55 UTC and saw the live Mac worker waiting for permission. That Windows installer had SHA-256 `45e2c19a0f3edfffde96e55b6af8090975797fde383a4ed6396d2ae7c612c643`. The Windows agent also signed the exact Mac archive staged here.
