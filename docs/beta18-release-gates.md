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

Mac installed-app and two-device results remain pending. Return a sanitized,
tracked validation summary with the tested source commit, engine hash, actual
Improve refresh and MC-039 review-tab results, real harness outcomes, and
candidate artifact hashes. Keep private receipts, credentials, profiles and
engine binaries outside Git. Preserve failed and skipped gates honestly.

After both platforms pass on the final source, integrate through the required
approved PRs, verify both version-bound production updater signatures, publish
the immutable installers and update the website catalog. Verify the website
download and beta.12/beta.17 update offers for both platforms. No publication
or passing Mac result is implied by this preparation commit.
