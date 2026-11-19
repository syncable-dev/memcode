# Windows validation of 13cc3c3 with the optimized 1eb engine

Status at 2026-11-19 23:27 UTC: **not cleared for packaging or publication**.
Production pins remain at `1d0e8cb4a`; no updater feed has changed.

Application source is `13cc3c356cbbf9f6cceddae9667e803b28604a0c`.
`7dc3342afddc837db1d0acc7b1fa2288577367a4` contains only the shared notes.
Windows verified that runtime, frontend, native source, scripts and tests match
13cc3c3. The optimized Windows executable SHA-256 is
`25c0cf2581e63f568ba01feb5aad1eb648a7d7cc24d9831b76a01527e252e67b`.
Its production source is `1ebcfda21d0a94a9405d7bda0c1c8f3a763332b5`;
`5d0f0a54` changes only the graph test fixture.

## Completed observations

- Windows engine tests: 229 graph tests and 84 replay tests passed.
- The full Windows application suite passed all 965 tests in 92.391 s.
  Earlier runs exposed two follow-up queue timeouts under load; a focused
  12-test queue run and the complete bounded run passed. No timeout was
  extended or assertion removed.
- Typecheck, renderer/runtime build and optimized native build passed.
  The native executable SHA-256 is
  `d6c37feb6044d9efb78fb21dd4fd1b976a65f0410a863c6595f2e253d012cd9f`.
  Runtime SHA-256 is
  `24caf243d91d0e412629931587d8e57822c4a95a10b8e1cce4e376e1d5964ab5`.
- Earlier native Improve refreshes on the same optimized engine took
  22.702 s and 3.420 s. Insights showed 8,654 AST-measured functions and an
  aligned source/index boundary. These preceded the exact 13cc relaunch.
- The substantial MC-007 review completed while primary history import ran.
  It rendered all 51 per-function rows and linked the current 30 passing,
  zero-failure assertions. Cognitive complexity was 361 → 273 and
  cyclomatic complexity 245 → 174. Maintainability was an actual measured
  0 → 0, not unavailable data converted to zero. The separate read-only
  reviewer was Codex `gpt-6.2-sol`. Bounded impact coverage remains explicit.
- One 155-commit primary replay completed in 465.006 s. The store ID remained
  identical and the complete original 23,904-byte journal was an exact prefix
  of the resulting 46,224-byte journal. This run used an already modified QA
  store and does not replace the required retry on the original failed copy.

## Blocking worker result

Three real coding continuations began at 23:08:36 UTC during primary replay.
Codex `gpt-6.2-sol` completed at 23:10:48 and Cursor `composer-2.5` at 23:09:48.
Each added a scoped behavior test, coordinated through Fleet and reported
10 passing assertions with exit 0. Claude never reached its provider: it
failed at 23:11:46 waiting for startup publication.

The exact epic current-source view subsequently reported a **published**, stable
graph, no active index jobs, and two mismatched files: the two peers' saved test
files. Startup was waiting for a job that did not exist. This is independent of
the primary history import. Merely extending the wait cannot fix this state.

A proposed application patch requests one ordinary incremental current-source
index when an exact, stable, published epic graph is behind a peer save. It
still requires the resulting certificate and delegates concurrent-writer
arbitration to the engine. It does not apply to primary history, a foreign
checkout, a partial publication, or an existing write. Its focused 77 tests,
typecheck and build passed. It is **not** part of 13cc3c3 and was saved separately
before restoring exact-source validation. No production pins were changed.

## Checks now running

The native QA app quit normally and all its graph owners stopped. The failed
cold backup was copied back to its registered checkout path; both the untouched
failed backup and the later working graph remain separately preserved.
The original store ID is `v1:01M7TJG7B4BZ8PHYKR0S0N2MCV`.
The cold journal is 23,472 bytes, SHA-256
`ac5cea58f73e07184d9258199d5abc67acd931d47d30087f92c99d1d299dec7f`.
The exact 13cc QA app reopened it using the verified 1eb executable.
The explicit retained retry began at 23:22:18 UTC after startup had appended
one additional episode; its separate before-retry receipt records that prefix.

A fresh 155-commit clone started its initial import at 23:24:03 UTC with
the same optimized engine. Embeddings are explicitly disabled in this
structural/history acceptance fixture. Neither normal app profiles nor
credentials were copied, reset or replaced.

Historical duplicate counts, `needs_replay`, the two reopen checks and the
final paired native results will be appended after they finish. Mac: keep the
candidate staged; do not infer all-provider acceptance from the successful
Codex/Cursor runs. We need to agree a final application source that addresses
the peer-save startup failure before either final installer is signed.
