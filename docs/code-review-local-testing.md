# Test quality comparisons and finding decisions locally

The app changes are on MemCode's `dev` branch. Keep local modifications intact;
fetch and fast-forward a clean dev checkout, then run `npm ci` and `npm run dev`.
The Windows implementation was checked locally. An installed beta is a separate
release and does not update merely because dev was pushed.

## Native engine patch for the Mac AI

Before/after measurements require the native `source_quality_v1` capability.
The old released engine remains usable, but explicitly reports that before
measurements are unavailable. Do not replace this with estimated values.

In the private **Memtrace** engine checkout, integrate commit
`5addbb2fa5d36975f2bff2d79ac58b7d0e86cc63` from
`origin/feature/memcode-source-quality` onto the Mac native-fix branch.
Cherry-pick that commit only; keep the Mac's owned-checkout/watcher fixes.
The patch changes the function-quality tool and its capability advertisement,
not ownership, watcher or platform test gates. No private engine source or
binary should be copied into the MemCode repository.

Record the resulting full engine commit and rebuild it locally. The local
helpers accept `--expected-engine-commit FULL_SHA` on build, unit and native
checks; without the flag they retain the original 6ec candidate check.
The source must match exactly and the native check still verifies the build
receipt, compiled binary hash and reviewed sidecar hashes.

After the Mac's existing unit and ownership gates pass, run the actual story
review fixture with its new engine:

```bash
engine_commit="$(git -C "$engine_source" rev-parse HEAD)"
node "$checks/run-local-native.mjs" \
  --app "$memcode_app" \
  --engine-source "$engine_source" \
  --expected-engine-commit "$engine_commit" \
  --engine "$engine_source/target/aarch64-apple-darwin/release/memtrace" \
  --build-receipt "$evidence/build/local-build.json" \
  --mode review --require-source-quality
```

Use the same expected commit for `build-local-engine.mjs` and
`run-local-gates.mjs`. The build receipt must come from that build, not the old
6ec binary. Keep MemCode's already-approved account open; refresh its existing
session if its short access proof has expired. No new browser approval,
Keychain export, hosted runner, engine-pin change or installer publication is
required for these local checks.

## App and interaction checks

```bash
npm run typecheck
npm test
npm run build
node scripts/code-review-experience-smoke.mjs
```

The last command uses real React components and a clearly labelled simulated
review API. On a Mac, set `MEMCODE_BROWSER_EXECUTABLE` to an installed Chromium
browser, for example `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
It checks comparison layout, dismissal/reopen, reload, failed-check blocking,
Acceptance read-only behavior, narrow layouts and switching cards during a
delayed save. It does not claim to validate the native engine or coding providers.

For interactive dogfood with the validated engine, move a finished story into
Code review. Compare paired functions, expand a finding, save a reason, reopen
it, then request a fix and review the new snapshot. A new review must not inherit
the old dismissal. Saved results remain readable in Acceptance and Done.

Keep failed platform gates as failures. Do not publish a new engine or installer
until the Mac fixes and both platform checks have passed.
