# Developer ID signing handoff for the physical Mac

Status verified in the signed-in Apple Developer account on 21 November 2026:
membership is active for **Syncable ApS**, Team ID **ZHYSCJZ6R5**, with renewal
on **21 November 2027**. The Account Holder role and accepted Program License
Agreement are visible. Certificates, Identifiers & Profiles opens successfully;
the Certificates page currently shows the initial setup screen with no issued
certificates listed. Enrollment processing is no longer blocking this work.

The next action is to create the CSR/private key on the physical Mac and issue
the Developer ID Application certificate for this team. Do not purchase another
membership. No Developer ID certificate, signed app or notarization result has
been established by this account-status check.

The starting application source is the shipped beta.18 `main` commit
`2e426b0a848c6bb8dad089135a485e3d1612a44d`. It pins Memtrace 1.2.22. Use an
isolated worktree and the existing approved QA profile. Preserve the installed
app, user account, projects, graphs, and unrelated work. Run on the physical Mac;
do not dispatch Actions. Keep the live beta.18 assets and updater feed intact
while preparing this separate private candidate.

## Set up the Apple identity on the Mac

1. Check `security find-identity -v -p codesigning` for an existing usable
   `Developer ID Application: Syncable ApS (TEAMID)` identity and matching private
   key. Require the confirmed team `ZHYSCJZ6R5` and record the actual public
   signing identity from the Mac; do not infer the certificate name from the
   organization name.
2. If none exists, have the Account Holder authorize creation of one Developer
   ID Application certificate. Create its CSR/private key on this Mac using
   Keychain Access or Xcode, submit the CSR through the Apple Developer account,
   download the issued `.cer`, and install it in the matching keychain. Keep the
   private key on the Mac. Developer ID Installer is for `.pkg` installers and
   is not the certificate for the MemCode app/DMG.
3. Set up notarization credentials locally. Use an Apple app-specific password
   or the supported App Store Connect API credentials. Do not put credentials,
   certificate exports, or private keys in Git, chat, test receipts, or uploads.
   Let the user handle credential entry and any new credential authorization.

Apple's [certificate instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
and [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
describe the required account role, CSR, authentication, and ticket handling.

## Prepare a trusted engine archive first

The beta.18 Mac engine pin is an ad-hoc signed archive. Signing the outer
MemCode app does not establish Developer ID trust for executables later
extracted from `engine.zip`. Public packaging deliberately rejects that pin.

Prepare a distinct signed Memtrace 1.2.22 engine release from the exact verified
Mac archive named in `scripts/memtrace-engine.json`. Verify its original archive
and per-file hashes first. Sign all four executable components with the matching
Developer ID Application identity, secure timestamps and hardened runtime:
`memtrace`, `memcore-server`, `memcortex-daemon`, and `memcortex-mcp`.

Submit the signed engine payload to Apple's notarization service and require
an Accepted result. Verify each extracted executable's signature, Team ID and
Gatekeeper assessment on the Mac. Standalone executables cannot have a ticket
stapled to them; retain the notarization receipt and test extraction on a fresh
QA profile. Keep original source/build provenance and record original-to-signed
hashes separately. Produce a new archive ID, hash, size and full file inventory;
do not overwrite the released unsigned/ad-hoc archive or relabel its old hash.
Publish this candidate through the existing engine artifact service, then update
the Mac pin in a separate reviewed commit. Keep Windows engine bytes unchanged.

## Build and validate the app

Use `MEMCODE_MACOS_RELEASE_MODE=public-release`. The current
`scripts/macos-release-trust.mjs` packaging path requires local protected
`APPLE_CERTIFICATE` (base64 PKCS#12), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, and `APPLE_TEAM_ID`, plus either `APPLE_ID` and the
app-specific `APPLE_PASSWORD`, or the complete supported Apple API credential
set. If a PKCS#12 export is needed for this path, keep it on the Mac. Do not
transfer Apple signing material to Windows. A certificate installed in Keychain
alone does not satisfy the current packaging environment check.

Run `node scripts/tauri-package.mjs` locally with those credentials and the
trusted engine pin. Use the existing local QA updater key for the private
candidate. The production Tauri updater key stays on Windows, which signs the
final exact archive after Mac packaging. That updater signature is separate from
Apple Developer ID signing and notarization.

Require native proof of:

- Correct Developer ID, Team ID and hardened runtime on every bundled Mach-O,
  including Node, the app, speech/retrieval native libraries and extracted engine.
- The signed bundled Node passing the existing JIT smoke with its narrow
  entitlement, without widening app entitlements to work around a failure.
- Apple accepting notarization, stapled/validated app and DMG tickets, and
  accepted Gatekeeper assessments for both the installed app and the app
  extracted from the final updater archive. Preserve the existing checks.
- A real downloaded/quarantined DMG install and a production-signed updater
  rehearsal preserving the saved account, story and settings. Run Improve
  refresh, open the saved code review, and smoke dictation and local retrieval.

If a trust check fails, return its exact stage and sanitized native result;
do not switch back to manual-approval mode or mark publicReady as true.
Do not edit an already signed archive: staple/repackage first, calculate final
hashes, and only then send the exact updater bytes to Windows for signing.

Run `node scripts/verify-macos-public-candidate.mjs <candidate.json>` after
the existing native cold-start and actual production updater verification are
recorded. Return source commits, engine/app archive hashes, public identity and
Team ID, notarization submission IDs, trust JSON, installer and updater receipts,
and any unresolved failure. Upload artifacts to a separate private draft with
commit-specific names. Agree on the next update version and matching platform
packages before changing the live feed; beta.18 is already released.
