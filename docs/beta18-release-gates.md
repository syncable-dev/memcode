# Beta.18 release preparation

The next candidate is `0.4.0-beta.18`. Preparing its version does not publish it.
Keep both compiled Memtrace engine pins on
`1d0e8cb4a4fb3f5b9638fa5ff4841cd1baf378ae`.

The shared worker fixes and incoming Mac CLI/path fixes passed Windows
typecheck, all 878 tests, frontend/native builds, desktop smoke and the actual
shared-session WebView2 check. Large saved review conversations now fit the
existing bound without losing evidence, and successful Claude content lookups
of that evidence are recognized. A real Claude answer copied the exact metrics
of a function near the end of the large report. Mac validation must include
these latest fixes from `feat/shared-worker-sessions` before packaging.

The [beta.18 Mac acceptance report](beta18-mac-acceptance.md) records the
installed-app results and unsigned package hashes. The Mac reproduced failures
in first-time review preparation and Codex follow-up continuity. Live
two-device acceptance is pending.

The [continuation integration checks](beta18-integration-checks.md) record the
Windows integration of the subsequent Mac fixes. The original uploaded packages
are superseded candidates: rebuild the integrated source before signing them.

After both platforms pass on the final source, integrate through the required
approved PRs, verify both version-bound production updater signatures, publish
the immutable installers and update the website catalog. Verify the website
download and beta.12/beta.17 update offers for both platforms. No publication
or passing Mac result is implied by this preparation commit.

## Mac results from the beta.17 integration

On 19 November the installed QA app ran on macOS 27.2 (Apple silicon) at
`f92111f8e4d1798b0bc6036549e8379d8cfd40cd`. Windows later tested beta.18
through `54eef4f7cedc4ea5f43a8413a15a361c119a6602`, including two changes
to how the reviewer reads evidence. The Mac results below cover the earlier
build. [Windows results](shared-worker-windows-validation.md)

| Check | Mac result at `f92111f` |
| --- | --- |
| Build | Typecheck, frontend and native builds passed. The unit suite passed 871 tests in 97.90 s and skipped three Windows-only cases. |
| Improve and Insights | Clicked Refresh analysis twice, then opened Insights. All three checkpoints, including the baseline, matched 670 source files each. One store owner held the lock throughout and released it on quit. |
| MC-039 | All 810 displayed metric values matched the saved native report, including 118 zeros. The 400 missing values belonged to 80 declarations the report could not safely pair between revisions. |
| Coding and review | Codex, Claude Code and Cursor answered direct prompts with models from their authenticated catalogs. Cursor answered a review question on synthetic evidence. Codex completed its read-only handshake. The selected Claude CLI lacked a supported read-only mode. |
| Sessions | The Team service advertised `workerSessions:1`. Five local relay tests passed. The QA profile lacked worker approval for simultaneous epics, and a second approved device was unavailable. |

The pinned Mac engine executable had SHA-256
`55f65a3a0acfe49595eea8a0f92b08fd203f67109acd8fb2842f96a8b3293fb6`.
The unsigned **beta.17** Mac updater archive had SHA-256
`488cfeec8192e24009dc7e16c63e82d97c177690f21d1b0092ae66c7dc52214c`.
The Mac had no production updater key or Apple signing identity. Beta.18 still
needs its own Mac acceptance, the two-device test and signed release artifacts.
