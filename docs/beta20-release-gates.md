# Beta.20 release preparation

The next candidate is `0.4.0-beta.20`. Preparing its version does not publish it.
The release owner asked for beta.20, so beta.19 is skipped.

The application source is `296cfb17ff281eb8b842c320e64115570500d88a` on
`feat/story-pull-requests`, [PR 14](https://github.com/syncable-dev/memcode/pull/14)
into `dev`. It carries the engine pins of the released beta.18 `main`
(`2e426b0`, Memtrace 1.2.22), taken in as `36b2e05`, and the Windows fix
`8fe20f3` for Copilot and DeepSeek worker permissions.

## What changed since the released beta.18

- **Workers in a goal edit at the same time.** Nothing is locked and nobody takes
  turns. A worker declares what it is about to change, edits, and records it.
  Peers hear about the change with their next call. See [goals](goals.md).
- **Two tasks, two shapes.** A second task that wants a different signature for a
  symbol another task just reshaped is stopped before it edits. The person
  chooses, seeing what each task wants and why.
- **Workers wait for the person.** A worker whose turn ends while a decision is
  open is paused instead of going to review. It is brought back with the decision
  as its next instruction.
- **Planner.** Tasks that share a file stay separate. Only tasks that need each
  other's result are merged.
- **Worker slots.** Up to 50 workers can run at once. The limit was 8.
- **Engine recovery.** MemCode no longer reuses an engine whose owner process has
  died, and reconnects when one dies. Before this, every request for the main
  project could wait 120 seconds and fail after an unclean exit.

## Mac results

Physical Mac, macOS 27.2 on Apple silicon, Node 26.0.0 and rustc 1.96.0. The
hosted candidate workflow uses Rust 1.97.1.

Typecheck, the Node tests, the build and the Rust tests ran on `62cfa85`. The
packaged commit `296cfb1` adds only the two refreshed lock fingerprints in
`third_party/inventory.json`.

| Check | Result |
| --- | --- |
| Typecheck | Passed |
| Node tests | 1,121 passed, 0 failed, 3 Windows-only skips. `tests/queued-followups.test.ts` ran on its own: 12 passed |
| Web and runtime build | Passed |
| Rust tests | 41 passed, 0 failed, 1 ignored |
| Third-party notices | Passed. Only the version changed in both lock files |
| Packaging in `manual-approval-beta` mode | Passed in 125 s |
| Bundled engine with the global CLI hidden | Passed. The packaged engine reports `memtrace 1.2.22` and was prepared from the bundle with no download |

`npm run test:smoke` and the native cold-start check were not run on this
source.

## Real workers

These runs used the development build of this source with an isolated test
profile, a disposable project and real Codex workers. A script pressed the app's
own commands; nobody clicked through the dialogs.

- **14 workers, three goals, started in the same second.** Fourteen Codex
  processes were live at once with four engines. All finished within four
  minutes and all 14 reviews completed. Every task's change was in the code, no
  conflict markers, and the three goals passed 12, 14 and 9 tests. The workers
  declared 30 edits: 18 class A and 12 class B. This run used the previous Mac
  engine pin, `1d0e8cb4a-beta.1`.
- **Two tasks given incompatible signatures for one function.** Before the fix
  the second worker replaced the first one's version, the first restored its
  own, and the last writer won with no decision. After it, the second worker was
  stopped before it edited and a decision opened with both tasks' reasons. Both
  workers paused with nothing running for two minutes. Both came back within
  seconds of the decision. The chosen one built its version and its five tests
  passed. The other reported that its task could no longer be done as written.

The same two tasks were run again on the engine this candidate ships,
`3a87836d4-beta.1` (Memtrace 1.2.22), with the development build of `296cfb1`.
The result was the same. The second worker was stopped before it edited, the
decision opened with both reasons, and both workers paused. Both came back
within seconds of the decision. The chosen one built its version and its six
tests passed. The other reported that its task could no longer be done as
written and stopped without editing. The 14-worker run was not repeated on
1.2.22.

## Mac packages for Windows

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `MemCode-296cfb1-3a87836d4-mac-arm64-private.dmg` | 145462484 | `b1c8db2d6627912e297603f67cbfaff5e26d8c2d71975eb19dbc01a911e1f154` |
| `MemCode-296cfb1-3a87836d4-mac-arm64-private.app.tar.gz` | 146322803 | `26724b6cf1c12b09daa88c2f8c074f037f279b72d5d3073c3e410f3bad1258c3` |

The mounted installer and the extracted updater archive hold the same app
across all 5,219 entries. Both pass strict ad-hoc Apple signature
verification. The app reports version `0.4.0-beta.20` and bundles engine
`3a87836d4-beta.1`, archive SHA-256
`e8b0565600d5a587c0085295890361644f49e133c9401c2f8aacc70dc75a2138`.

Both files and `SHA256SUMS` are in the private draft
[`beta20-staged-296cfb1`](https://github.com/syncable-dev/memcode/releases/tag/beta20-staged-296cfb1).
Keep the draft unpublished.

Packaging used a one-use test updater key so the bundler would emit the
archive. That signature is not valid for release and was not uploaded. The
production updater key stays on Windows.

## What is left

For Windows:

1. Fetch `296cfb1` and run typecheck, the tests, the native build and the
   desktop smoke check on Windows.
2. Build the Windows installer from the same source.
3. Sign the exact Mac updater archive above with the production updater key, and
   sign the Windows packages. Verify both version-bound signatures.
4. Integrate through the approved pull requests: PR 14 into `dev`, then the
   promotion to `main` by rebase merge.
5. Publish the installers and update the website catalog and updater feed only
   when the release owner says to.

Not done on the Mac:

- **Apple Developer ID and notarization.** This Mac has no code-signing
  identity, and the Apple Developer account was still pending on 20 November.
  Like beta.17 and beta.18, this is a manual-approval Mac build.
- **Installed-app acceptance of these packages.** Cold start, the update from
  beta.18 with the production signature, and account retention across it.
- **Two-device Team checks.**
- **More than 14 workers at once.**

Known limits in this source:

- A decision the workers settle between themselves does not bring back a worker
  that had already paused for it.
- A task the person decides against ends as finished, with its own message
  saying it could not be done. It has no separate status.
- The New work dialog still places a planned goal into an existing goal that
  touches the same code, starts only the first new goal, and starts workers
  three at a time. The release owner confirmed this stays: agents do not start
  by themselves.
