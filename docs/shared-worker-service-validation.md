# Shared sessions: hosted service validation, 19 November 2026

The existing Team service at `https://teams.hosted.memtrace.io` now advertises
`workerSessions:1`. Its relay bundle was built from MemCode commit
`c95eb1db6e173bdd4a0edc8c6a7efbabec29ae2d`; the compiled relay SHA-256 is
`205b294d2951a62d531ff634dbcda09949a8d5f11d7359981ab146676299794c`.
This was a code-only service update. No infrastructure or desktop installer was
changed.

All 48 targeted relay, Team history, membership and session tests passed locally
before deployment. After the service restarted, the prefixes of both existing
board journals matched their pre-update hashes, and both Team membership files
were unchanged. The installed relay digest matched the reviewed bundle.

Public HTTPS checks passed: service discovery, HTTP redirect, HSTS, restricted
browser origins, rejected unauthenticated reads and rejected unsigned account
proofs. A separately approved QA membership was reused without another browser
approval or access to a normal user profile.

Authenticated requests against the hosted service checked all three harness
session types: claim ownership, server-stamped authors, idempotent follow-ups,
edit/cancel before pickup, revision checks, rejection of edits after pickup,
review questions and saved per-function values including numeric zero. Session
updates left the planning journal head and snapshot unchanged. Follow-ups could
still target the retained session after its claim ended.

A subsequent service restart restored all three saved session/report fixtures,
their per-function values and queue statuses. Existing board journal prefixes
and Team membership files still matched their pre-update hashes.

These hosted requests used explicitly labelled synthetic transport fixtures.
They did not execute coding models and are not a two-person or two-device desktop
acceptance test. The separate real Windows coding runs are documented in
[Windows validation](shared-worker-windows-validation.md). The actual Mac app
and two-device gates remain in [the Mac handoff](shared-worker-mac-validation.md).

Temporary test stories were deleted and their claims released. Existing QA
stories, membership and saved sign-in were preserved. Private deployment and
acceptance receipts are retained outside source control; no credentials or
private Team contents are included here.
