# Desktop update verification

Run these checks locally. Do not dispatch GitHub Actions for this work.
Keep the source version at beta.12 until the platform checks are complete;
this branch is a fix candidate, not a published beta.13 release.

## Local regression checks

Use a separate checkout, Node 22.12 or newer, Rust 1.90 or newer, and the
normal native build prerequisites for the operating system.

```sh
npm ci
node scripts/prepare-desktop-runtime.mjs
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/app-updates-smoke.mjs
```

The browser check requires the matching Playwright browser. On macOS, install it
with `npx playwright install chromium` if it is not already installed.

The native tests use the real Tauri signature verifier, restart a separate
process to restore its saved download without a network request, reject a
tampered payload or relabelled version, and remove an obsolete cached update.
The Settings browser fixture labels its synthetic native responses; it does
not claim that an installer was executed.

## Actual macOS update acceptance

Use a private QA application bundle and a private `MEMCODE_DATA_DIR`. Leave the
normal Applications copy, account, keychain entries, CLI, and project folders
alone. Do not request another account approval or copy authentication files.

1. Build this branch as a local QA app with a **generated, uncommitted Tauri
   configuration override** setting `version` to `0.4.0-beta.11`. Use a unique
   product name and bundle identifier. The override exercises the official
   beta.11-to-beta.12 update feed using this branch's updater code. Do not
   change the production key, download URL, verifier, or installation guards.
   Package only the QA `.app`; local verification does not need a release key,
   a DMG, or notarization. Prepare the pinned runtime assets normally.
2. Put the QA app in its own writable directory under `~/Applications`. Launch
   its executable with a private `MEMCODE_DATA_DIR`, without
   `MEMCODE_NATIVE_TEST_PROFILE`, `MEMCODE_APP_PATH`, or `MEMCODE_SERVICE_PATH`:
   those variables deliberately disable installed-app updates. Record the
   exact application path and running version before proceeding.
3. Create synthetic saved work and a settings change. Configure dictation and
   retrieval in that private profile. Existing verified model files may be
   reused without copying account credentials or changing the normal profile.
4. Open Settings. The official beta.12 release should be detected and downloaded
   automatically. Wait for the **Install and restart** button beside the
   status, above the release notes. Record the saved package's size and hash.
5. Quit and reopen the **QA app**, before installing. Its verified package must
   remain ready without another package GET. Rechecking or reopening Settings
   must not discard it. Observe the actual native process and network activity;
   do not inject a successful UI state or call installation a mock.
6. Click **Install and restart**. Observe the old process exit and the updated
   app reopen itself at the **same QA bundle path** as beta.12. Confirm the
   synthetic work, settings, and model paths remain. Test real dictation with
   the known audio fixture and confirm retrieval still runs locally. A stopped
   speech process between uses is normal; recording must start it automatically.
7. Opening Settings in beta.12 must report the actual installed version and no
   newer release from the current public feed. Repeat an ordinary restart and
   verify the saved work and models again.

Stop if the installer would touch the normal app or profile. Report each
observed step, exact versions, hashes and failures. Do not call the complete
update flow verified if only the signature, development guard, source tests or
rendered fixture passed. Remove only the QA application's own temporary files.
