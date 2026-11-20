# Beta.18: retained dirty-checkout history gate

Application candidate: `18eae76` on `fix/history-independent-workers`.
Engine candidate: `cee3849677464863c3c2b13b331f368dac43f060` on
`fix/memcode-dirty-replay-intervals` in the private Memtrace repository.
The engine builds on `5d0f0a54` / optimized `1ebcfda21`; no MemDB submodule
revision or production engine pin has changed.

## What Windows found

The retained QA store finished a 155-commit replay, retained its store identity
and exact journal prefix, and reported `needs_replay: false`. However, a read at
its saved Git commit returned 315 extra relationship rows across 85 identities.
The redundant rows came from the same immutable Git event. The earlier
reconciliation ran only when the current checkout could produce a clean Git
certificate, so this dirty checkout did not reach it.

The candidate reconciles these redundant closed intervals during the structural
write, independently of that certificate. It requires matching repository,
branch, identity, event time, relationship payload hash and logical endpoints.
It retains every payload and appends temporal closures. It does not filter
duplicates out of read results, reset the graph, rewrite episodes or certify a
partial graph as ready. Conflicting payloads are refused.

Windows checks so far: 233 graph tests and 84 replay tests passed, including a
real MemDB regression with a dirty working-tree save, historical reads, retained
payloads and an idempotent second save. An initial directly invoked parallel
replay test process lost Git from its environment; the full replay group passed
with an explicit Git PATH and serial execution. The optimized production engine
build and retained-store native verification are in progress. These are not
native acceptance results yet.

## Mac agent: build and validate the same candidate

Preserve your existing fixes, profiles, account, graph and uncommitted work. Fetch
both branches. Use isolated worktrees and the existing approved QA installation.
Do not replace the user's normal app or borrow its credential files.

1. Build the engine from the exact commit above with its recorded submodules.
   Run `cargo test --locked -p code-intelligence --lib graph::` and the replay
   group. Record the binary hash and toolchain. Keep the production pins at
   `1d0e8cb4a`.
2. With the QA app and its verified store owner stopped, take a cold backup of
   the existing failed QA store. Record its store ID, old episode IDs, journal
   size/hash and historical duplicate counts at the saved Git commit. Leave the
   original graph intact. Keep the copied store at its registered checkout path.
3. Launch only that QA app with the candidate. In the actual native app, run
   Improve → Refresh analysis twice and open Insights. Retry history, follow the
   existing job to completion, and require `needs_replay: false`. Confirm zero
   duplicate node and edge identities at the saved Git commit. Confirm the store
   ID and old episode IDs are unchanged, and the old journal bytes are an exact
   prefix of the recovered journal. Quit normally and reopen twice; verify the
   same store and ready source binding on both reopens.
4. Open the saved MC-007 code-review tab and expand measured functions and
   recorded checks. Verify its actual per-function numbers and that its checks
   still link to this story's captured worker/source. Run the paired worker and
   separate reviewer flow while history imports, against Team `workerSessions:1`.
   Use real turns, not prefilled answers. Record native counts/timings and any
   partial coverage explicitly. Complete the real two-device follow-up test with
   the Windows peer; an existing older-source test does not satisfy this gate.
5. Follow `beta18-connectors-windows-handoff.md` for the new adapters and consent
   restrictions. DSH Windows currently lacks a configured provider key; transport
   startup is proven, successful DSH generation is not. Use the Mac's existing
   configured provider if available. Do not invent a pass from a model catalog.

Push sanitized receipts and the exact final package-source proposal to the
handoff branch. Do not publish or change the feeds. Windows will sign only the
new, exact Mac archive and verify its actual bytes with the production updater
key after both platforms' native gates pass. No Actions, hosted runners or key
transfer.
