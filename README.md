# MemCode

**The local Fleet Agentic Worker Suite.** An independent Tauri workspace for
planning work, talking to coding agents, and reviewing what they produce.
Memtrace supplies code intelligence and coordination through its installed MCP
server. Its backend is not copied into this repository.

MemCode is **source-available for noncommercial use** under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use, including
internal company development, requires a separate license. See
[licensing](docs/licensing.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Use the desktop beta

Published installers include Node.js and a verified, separately licensed
Memtrace engine bundle. Choose **Connect Memtrace beta** and approve your account
in the browser; MemCode prepares the included engine in its private app storage.
A separate Memtrace CLI is not
required for beta use. Git and your chosen coding tool still need to be
installed and configured. The shared native agent browser currently requires
Windows WebView2.

Beta sign-out pauses analysis until you reconnect or explicitly choose an
existing CLI setup. It never silently switches to a paid CLI account or plan.

## Develop from source

Requires Node.js 22.12+ and Git. Native development/builds also require Rust 1.90+ and
Tauri prerequisites. Windows builds use MSVC Build Tools and installed WebView2.

```sh
npm install
npm run dev
```

On macOS, install Xcode Command Line Tools and Rust 1.90+ first. Use the
[macOS developer quickstart](docs/macos-development.md) for the current source
preview, Memtrace sign-in and platform limits. This checkout has no signed Mac
installer; the shared live agent browser currently requires Windows WebView2.
Private [Windows](docs/windows-desktop-candidate.md) and
[macOS](docs/macos-desktop-candidate.md) candidate packaging keeps updater
signatures separate from OS trust: the current Windows candidate has no
Authenticode publisher signature; the Mac workflow uses ad-hoc signing and no
Apple notarization. macOS candidate preparation does not establish full live
browser parity.

To develop MemCode using MemCode, close the compiled app after its active workers
finish, then run `npm run dev` from this repository in an external terminal. It builds the local runtime
and opens the Tauri development app against the same workspace data. UI changes
hot-reload while workers and managed servers keep running. Runtime or Rust changes
require a controlled restart: finish/stop active workers, close the app, and rerun
`npm run dev`. Native automatic restarts are disabled. Restarting the desktop app
currently ends its worker sessions; unattended self-updates with session reattachment
are not implemented yet.

For the compiled desktop app:

```sh
npm run build
npm run build:native
npm start
```

Fresh checkouts and installers start with onboarding, without a development backlog.
A separate **Design preview** project is clearly labelled as example data.
Use **Add a project**
to choose an existing folder or start a new Git repository from a project brief.
MemCode then uses its managed Memtrace engine to analyze it. A valid private engine
cache is checked before any download, so restarting does not require the engine
release service. Account sign-in and renewal still need the Memtrace service.

An existing global Memtrace CLI can stay installed. MemCode's managed engine does
not replace its executable, settings or credentials, and each project's MemCode
graph stays under `.memcode/memtrace`. **Use existing CLI setup** remains an
explicit advanced option with that CLI account's plan and limits. See
[bundled engine](docs/bundled-engine.md).

## The first working version

- Board, grouped list, calendar and timeline views, with saved filters and grouping.
- Independently scrolling lanes, custom workflow states and advisory WIP limits.
- Cycles with explicit scope, manual points, capacity, start/finish and carryover.
- Recorded burndown/burnup, throughput and evidence-gated pace projections.
- Labels, child stories, related/duplicate links, custom fields and bulk edits.
- A persisted Now / Next / Later roadmap, epics, stories, source scope and cycle-checked prerequisites.
- Project briefs, editable runbooks, conversations, worker status and change review.
- Visible follow-up queues with edit/cancel until pickup, plus separate story discussions.
- Opt-in [Team Sync preview](docs/team-sync-preview.md): shared planning, authored comments,
  activity, story claims and deliberately published files, with local workers and Git source exchange.
- Native questions, approval choices and plan review beside the conversation input for Codex, Claude Code and Cursor, with replies sent to the same waiting session.
- Worker-wide Review / Smart auto / Full access defaults, inherited across projects with optional story overrides. Cursor ACP currently supports Review and Full access; unsupported automatic review is explicit.
- Delete stories, epics and cycles with a clear confirmation. Epic/cycle deletion preserves their stories; active workers must stop first.
- Progressive project → approved worker → epic → story onboarding and a searchable, illustrated Docs tab.
- Native folder selection and project creation. State stays in the local workspace
  directory (`%APPDATA%\MemCode` on Windows), preserving existing desktop data.
- Local CLI worker adapters for **Codex, Claude Code and Cursor Agent**, including Windows standalone/runtime discovery.
- Official bundled SVG marks with provenance in [adapter sources](public/adapters/SOURCES.md).
- Automatic routing to a concrete harness, model and reasoning effort, with manual overrides and visible reasons.
- One Git branch per epic, with story workers sharing the project folder.
- Memtrace Fleet intent, reservations, handoffs and semantic disagreement resolution on the shared epic branch.
- Memtrace MCP indexing, relevant-symbol context and measured quality/impact inputs.
- Cooperative Fleet preflight, typed declared intent and independent heartbeats.
- Code Insights for quality, architecture, flows, APIs, history, style and governance.
- Improve checkpoints comparing compatible, revision-bound measurements over time.
- Live per-card browser tabs shared by the worker and user, using native WebViews without the app RPC capability.
- Per-card persistent terminals shared with workers, with selectable output and explicit session controls.
- Worker checkpoint diffs with syntax colors, additions/deletions, pinned gutters and horizontal scrolling.
- Separate saved artifacts: HTML, Markdown, Word, Excel, PowerPoint, PDF, images, video, audio and source text.
- Lazy artifact gallery thumbnails: images, PDF first pages, video frames and readable document, worksheet and source excerpts, with bounded format fallbacks.
- Precise saved annotations for text, source lines, spreadsheet cells, HTML elements/areas and media timestamps; send selected comments as an explicit follow-up.
- Separate output folders under `.memcode/workers/<story-id>/artifacts/` and readable project-file links.
- Local dictation with explicit Whisper Tiny setup on Windows x64, or an existing local whisper.cpp server; transcripts enter the draft for review.

Execution, credentials, local repository bindings and approvals stay on this computer.
Personal projects remain local. Opt-in Team Sync shares planning, comments, activity
and explicitly published files through a private relay. A harness
may use its configured cloud model. Codex can alternatively use an installed Ollama
model; select local-model mode and its model name in Settings. MemCode does not
provide a hosted control plane or require a MemCode account.

Tauri uses the operating system's WebView. A bundled Node service retains installed
harness and MCP integrations over private, validated stdio RPC. Node remains a
prerequisite. The app no longer bundles Chromium or Electron. The current native
build produces a local executable, not a signed installer.

## Engine and harness boundaries

Install/configure [Memtrace](https://memtrace.io/docs) separately. The app discovers
`memtrace` on PATH; Settings also accepts an absolute executable or JavaScript entry
point. It connects with the MCP SDK and scopes indexing to the selected repository.
Engine authentication and licensing remain Memtrace's responsibility.

If an existing Folder Group does not admit the selected repository, MemCode can
open an explicit, single-project index under `.memcode/memtrace/`. It keeps that
index separate from the existing workspace and exposes the binding in coverage
details; it does not reindex the parent directory.
Cold local owners are started headlessly for that exact project when needed.
Opening an empty folder creates its Git baseline automatically. Existing nonempty
folders require Git setup; MemCode does not commit their source changes.

Installed runtimes remain disconnected until the user explicitly approves the
specific local executable in Workers. MemCode reuses Memtrace's existing session
and official sign-in flow; it stores no separate MemCode account or provider credentials.
See [account and worker boundaries](docs/account-and-workers.md).

All three local runtimes were detected on the development machine. Codex model IDs
come from its local model cache; Cursor models come from `--list-models`; Claude
supports its documented CLI aliases. Provider authentication, entitlements and actual
execution are confirmed at connection and launch. The [three-harness conformance checks](docs/worker-conformance.md)
record real Codex, Claude Code and Cursor runs and their limits. Opening the app or
creating a story never launches a coding session.

Automatic assignment uses AST cognitive/cyclomatic complexity, nesting, observed
primary-anchor blast radius, affected processes and module roots. Unknown values
remain unknown and block the fast tier. The four capability envelopes adapt the
previous orchestrator's policy; their thresholds and model-to-tier mappings are
**provisional**, not calibrated probabilities. Task length is not a complexity input.
The route records source/graph revisions and explains incomplete coverage.

Workers now have a [context broker pilot](docs/context-broker.md): three
small retrieval capabilities backed by host-run Memtrace workflows, literal
source, revision checks and preserved project constraints. Fleet remains under
host supervision. Settings also offers optional local retrieval assistance through
cached ONNX weights or a loopback model server. It starts disabled, uses no automatic
model downloads, and falls back to deterministic retrieval if assistance fails.
The [initial pilot results](docs/context-broker-results.md) and
[Codex/Cursor coding comparison](docs/context-coding-results.md) include reproducible
token/quality measurements and explicit limits on shell-search control and generalization.

For local speech, choose **Set up local dictation** in Settings. On Windows x64,
this explicitly downloads the pinned CPU runtime and multilingual Whisper Tiny
(about 82 MB), verifies their hashes, and runs inference on loopback. Other systems
can configure an existing local runtime or `/inference` server. Nothing downloads
at startup. The microphone is activated only by the dictation control. Transcription
never sends a follow-up automatically. Speech endpoints are constrained to
loopback. The per-card browser accepts HTTPS and loopback development addresses;
privileged URLs and remote plaintext HTTP are rejected. Saved artifacts open
separately from that live browser.

The [onboarding and collaboration verification](docs/onboarding-verification.md)
records native form, consent, queue, discussion and local-speech checks.

## An honest prototype boundary

A finished worker enters **Code review** when that workflow is configured. Its
dedicated review screen brings together the story's attributed patch, Memtrace
findings, measured complexity, observed impact and matching verification.
Missing or stale measurements remain incomplete. **Ready for acceptance** is a
separate lane for the developer's final look. Neither lane proves that unrecorded tests
passed or automatically publishes a change. Review the actual diff and evidence.
There is no automatic Git merge, push or deployment.

Fleet scope comes from qualification seeds and is explicitly incomplete where the
graph says so. Typed intents describe the declared story category; refactor/fix
subtypes are coarse defaults, not a post-diff semantic classification. Story workers
share the epic branch and its files. The host acquires and renews Fleet reservations,
checks intent overlaps and polls escalations. Ordinary shared-file overlap follows
the earlier worker's plan, waits for a handoff and rereads the current source.
Workers can propose a different solution; unresolved semantic disagreement appears
in **Decisions** for a human. Decisions are recorded without resetting files.
Fleet coordination depends on clients honoring the protocol; it is not hard filesystem
write fencing. The developer owns reconciliation and acceptance of shared changes.

The app is a single local owner with serialized atomic JSON persistence. The Team Sync
preview adds a durable command journal and explicit story ownership to shared metadata;
it does not replicate uncommitted source or Fleet across computers. Account-based
Team membership uses Memtrace sign-in. Calibrated model routing, authoritative write
fencing, independent acceptance checks and broader adapter validation remain future
iterations, tracked in the dogfood
backlog. See [the product brief](docs/PRODUCT.md) and [design rules](docs/DESIGN.md).

See [the planning comparison](docs/PLANNING.md) for the itsaplan reference and chart
semantics. Planning estimates are separate from measured routing complexity.
Historical delivery begins when MemCode records it; existing completed stories
are a baseline. Improve keeps missing metrics unknown and excludes stale or
incompatible captures from comparisons. Successive valid checkpoints build history;
a hotspot leaving the top results does not prove it was repaired.

## Dogfood

Open **MemCode → Roadmap**. Expand an epic, pick a ready story, and use **Plan
worker** to inspect its measured route, then launch story workers. Workers on one
epic share its branch and checkout. With an engine advertising the owned-worktree
protocol, other epics run concurrently in separate Git worktrees that share Git
storage. Their graphs and source certificates remain checkout-specific; an older
engine retains the sequential execution path. See [parallel epics](docs/parallel-epics.md)
for integration, prerequisite and resource limits. Review each conversation, runbook and output alongside that worker's recorded
checkpoint diffs. Attribution comes from worker checkpoints, rather than assigning
the complete shared branch diff to every card. See [reviewing the work](docs/review-and-previews.md)
for saved comments, file links and rich previews. **Sync build plan** adds
missing stories without replacing edited briefs, dependencies or progress.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke
```

Tests use fixture harnesses to exercise actual concurrent worker processes on one
epic branch, separate artifact ownership, overlap pausing and human resolution,
without calling a model. The desktop smoke test uses a temporary profile, the real
native WebView and a private test inspector. It checks preview isolation and RPC.
Additional native browser and review checks are in `scripts/native-browser-smoke.mjs`
and `scripts/review-smoke.mjs`; real-model evidence is separate from those fixtures.

Source is maintained in the private [syncable-dev/memcode repository](https://github.com/syncable-dev/memcode).
Repository access is required to clone or download it. An open-source license and
release policy remain to be selected; this preview is not a public release.
