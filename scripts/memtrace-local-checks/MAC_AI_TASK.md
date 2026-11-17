# Local Mac verification task

Validate the private MemCode parallel-epic engine on this physical Mac. Run locally only. Do not start GitHub Actions, rent a Mac, publish installers, change app engine pins, or change the user's normal project data. Do not read/export Keychain credentials, refresh credentials, normal CLI auth, or private keys. Do not sign out or revoke the existing MemCode account.

The engine source and compiled runtime are separately licensed private Memtrace components. No Memtrace source or binaries belong in the MemCode source repository.

The exact candidate native source is `6ec252fb65599d3a2aaae8df7daf5ae934c6a58a` on private `syncable-dev/memtrace`, branch `beta/memcode-engine-1.2.21`. Existing released engine and the old Mac artifact from source189 do **not** prove this candidate. Windows release-optimized6ec passed; Mac is still unverified.

## Get ready

Use this updated MemCode checkout, with its installed Node dependencies. Preserve any existing modifications. Start from the folder that contains `package.json` and `runtime/`:

```bash
memcode_app="$PWD"
node --version
git status --short
```

Node22.12+ is required. The build scripts require the normal local Xcode command-line tools, pinned Rust1.97.1, CMake, and protoc. Inspect what's already installed first. If required, install developer prerequisites locally through their official distribution. Do not install/replace global Memtrace or any coding harness.

Use an isolated private source checkout; leave any existing dirty Memtrace checkout untouched:

```bash
engine_source="$(dirname "$memcode_app")/memtrace-memcode-6ec"
git clone --branch beta/memcode-engine-1.2.21 --single-branch --no-checkout git@github.com:syncable-dev/memtrace.git "$engine_source"
git -C "$engine_source" checkout --detach 6ec252fb65599d3a2aaae8df7daf5ae934c6a58a
git -C "$engine_source" submodule update --init --recursive
git -C "$engine_source" submodule status
```

If that destination already exists, verify its identity and exact clean commit instead of overwriting it. If repository access is unavailable, report that blocker; do not substitute public/unrelated sources.

## Build the real Mac engine

```bash
checks="$memcode_app/scripts/memtrace-local-checks"
evidence="$(mktemp -d -t memcode-local-gates)"
chmod 700 "$evidence"
node "$checks/build-local-engine.mjs" --engine-source "$engine_source" --output "$evidence/build"
```

This builds the real embedded UI and production engine with opt3, full LTO, one codegen unit, unwind, deployment target13.5, at most two Cargo jobs, and **no diagnostic thread-stack override**. It records the compiler, source/submodule identities, command and SHA256 of the compiled engine. Do not label a debug/custom-stack binary a production pass.

Then run exact-source local unit gates:

```bash
node "$checks/run-local-gates.mjs" --engine-source "$engine_source" --output "$evidence/unit"
```

Expected owned guards6, beta auth12, runtime guards5 on Mac, and linked-overlay watcher regression1. The parser verifies the qualified test inventory. Any failure stays a failure; preserve logs and report it before proceeding.

## Exercise the actual native/product paths

Keep the already approved MemCode app open. The helper reads **only its current short access JWT** from the exact normal app-data namespace, never Keychain or refresh credentials. It derives the signed device/session binding, verifies it through MemCode, uses private disposable fixture roots, and removes copied proof files on completion. It does not modify/revoke the original account.

If the short proof is missing/near expiry, refresh the existing account from MemCode, then rerun. Do not create another browser-approval loop. For a deliberately custom profile, supply `--app-data /absolute/profile-root`; if the app's config location differs, supply its exact `--access-file /absolute/access.jwt`. Do not print the file contents.

```bash
node "$checks/run-local-native.mjs" \
  --app "$memcode_app" \
  --engine-source "$engine_source" \
  --engine "$engine_source/target/aarch64-apple-darwin/release/memtrace" \
  --build-receipt "$evidence/build/local-build.json" \
  --mode all
```

The helper downloads or reuses the **digest-verified current1af Mac sidecar archive**, verifies every file, and replaces only its main engine with the compiled6ec binary in a temporary directory. It never changes the installed app.

Five independent modes must pass:

1. `owned`: canonical plus two linked epic worktrees with the same repo name/ID, shared Git objects, independent full graphs; exact branch/path certificates; different AST complexity, impact/callers/processes; review workflow/detector coverage; foreign path/branch refusals; same canonical Fleet broker; extra MCP clients do not add graph owners; concurrent saves stay isolated; restart preserves source certificates and watchers.
2. `product`: actual current `MemtraceEngine` bootstrap, full analyze, owner count2→1→0, retireA whileB stays queryable, reopenA from cache, strict publication metadata and actual PID/daemon-state cleanup.
3. `direct`: cold direct MCP bootstrap, saved-source watch, natural SDK transport close, native exit status and no residual servers.
4. `legacy`: ordinary canonical/legacy worktree overlay watcher refreshes source publication without contaminating canonical symbols.
5. `review`: the actual `CodeReviewManager` and native engine review two stories in each of two epics. Real reservation journals preserve disjoint edits to the same file. Real `node --test` output is bound to each exact source snapshot; all four initial reviews must be Ready with measured quality/impact and complete linked verification. A follow-up then modifies the earlier story, preserves the peer's changes, records a second journal segment and must return Ready after review. Late partial publications use the real bounded index-repair path. All native owners must retire naturally. These are controlled source patches for review validation; no provider-generated coding or native PTY behavior is claimed.

`--mode owned|product|direct|legacy|review` reruns a single failing mode with a fresh disposable fixture. Do not call manually killing leaked processes a successful natural-shutdown test; the receipt marks forced cleanup as failure. No credentials appear in stdout/reports.

## Report and package evidence

Return the generated `local-build.json`, unit `summary.json`, native `local-validation.json` and each mode's `result.json`, together with exact app/source hashes. Do not return a JWT, refresh credential, Keychain export, or private source/binary in chat.

Report cold timings and process residency honestly as a tiny structural fixture; summed RSS includes shared pages. Do not infer large-project performance from this test.

Do not publish/update the app yet. The Windows coordinator must match both platforms' validated immutable bytes, resolve the host shutdown-budget gate, and then prepare the engine archive/update. Local packaging provenance must say `buildOrigin: local`; never invent a CI run ID.
