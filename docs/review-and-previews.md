# Reviewing the work in MemCode

## Code review, then acceptance

Completed worker passes enter **Code review**. The card opens a dedicated evidence
workspace with a separate review conversation. Changes, local review rules, AST
complexity, graph reach and actual linked checks are shown as distinct phases.
The **Code review** tab stays between Changes and Artifacts in every lane. Saved
results and their discussion remain accessible in acceptance and Done. Starting
or rerunning the review is enabled only while the task is in Code review.
Expand a finding to open its source line or inspect it in Changes. Missing coverage,
an unverified graph, an intervening worker edit or an older test report prevents a
ready result. The review never substitutes the goal's combined diff for the task's
own changes.

The detector pass uses Memtrace's product code-review workflow: AST detectors,
bundled YAML rules, graph-backed cross-module checks and its shared ranking policy.
Live repository checks add convention and invariant-drift findings. A finding shows
its detector origin and recorded evidence. An affected caller can be highlighted
outside the task's edited files when graph evidence links it to the change; that
does not attribute the caller's source to this worker.

The quality summary is the mean native maintainability index of the measured
changed functions, with the weakest functions available below it. It is not a
correctness or acceptance grade. Partial, stale, missing or contradictory evidence
suppresses the aggregate instead of presenting a successful subset as the whole
change. Individual native measurements remain inspectable. No improvement delta
is shown without a measured baseline.

A connected harness can provide a separate read-only reviewer. Its explanation is
attributed to the actual reported model and kept separate from deterministic
measurements. Unsupported read-only capabilities are shown as unavailable; normal
implementation permissions are not reused. Asking a review question does not start
an implementation worker. Choose **Request fixes** to queue selected findings for
that task's existing worker. A new pass makes the old review stale.

A complete review can move to **Ready for acceptance**. The developer checks the
result and explicitly marks Done. Older In review cards move to acceptance without
claiming a code review happened. Review reports stay local to their execution device;
share an output explicitly when teammates need the saved evidence.
An incomplete review can proceed to acceptance only with an explicit saved coverage
note. That decision preserves its incomplete result; it does not mark missing
checks as passed. Findings and stale or failed reviews still require attention.

## Ship a goal

A goal is one branch, so its tasks ship together in one pull request (see
[How goals work](goals.md) for the full picture). When every task is in review, the goal card shows **Create pull request** (or **Ship quick
changes** for the Quick changes batch). The sheet lists each step before it runs:
commit the goal's files, push its branch, open the PR. The GitHub CLI creates it
when installed; otherwise GitHub opens with the title and description filled in.

The description is written for reviewers: a summary, each task's change in the
agent's own report with local paths made repo-relative, decisions a person made,
and a test plan. The fleet receipt is folded at the end. **Add a MemCode line**
adds one line inside it and an `Orchestrated-by:` trailer to the commit.

With the GitHub CLI, the sheet also shows the PR's review and checks. **Merge pull
request** is available when GitHub would merge it, using the repository's merge
method; otherwise the sheet says why. Merging closes the goal, moves its reviewed
tasks to Done and marks open goals that use the same files **Needs update**.

## Save annotations, then send a follow-up

Saving a comment creates a local annotation. It does not add a conversation
message, call a model or start a worker. Highlights and numbered comment pins
remain in the preview after reopening or reloading it. Clicking a pin opens the
saved comment and its quoted target.

Use **Review comments** to edit or delete unsent notes, select the comments to
include, and choose **Add to follow-up**. This stages attachments in the composer;
it still does not send them. The normal send action sends that follow-up and
starts an available idle worker. If a run is active, Send queues the follow-up
for an automatic next pass after the current process and Fleet cleanup finish.
Multiple queued messages available before the next brief are handled together.
Unread follow-ups are retained even when the active worker produces a long
conversation. Queue authorization and the message are saved atomically in the
local workspace; the renderer does not need to remain on that card.
Comments already added to a conversation remain in its review history. The same
workflow applies to Codex, Claude Code and Cursor; review does not select or
replace the card's assigned harness.

Stop cancels pending automatic delivery while preserving the text. A failed run
or unresolved Fleet conflict pauses its queue for attention instead of retrying
indefinitely. An interrupted active run also pauses on restart; a ready queue
from a clean idle/finished state can continue when the app starts. Queued cards
wait for worker capacity, and a card never runs two harness processes at once.

This follows the distinction in the official Codex workflows: save inline or
visual comments, then send a separate instruction to address them:

- [Codex code review](https://learn.chatgpt.com/docs/code-review?surface=app)
- [Browser annotation mode](https://learn.chatgpt.com/docs/browser#comment-on-the-page)

## Targets

| Surface           | Saved target                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Markdown and Word | Exact quote, surrounding text, text offsets, document page when present                                                     |
| PDF               | Page, exact text position and quote; native-resolution canvas plus selectable text layer                                    |
| Source file       | File, selected line or text range, version and quote                                                                        |
| Changes           | Worker checkpoint, file, old/new side and line range                                                                        |
| Spreadsheet       | Workbook, worksheet and cell range such as `A2:B3`                                                                          |
| HTML artifact     | DOM selector, element or normalized area inside that element, and selected text                                             |
| Editable field    | DOM selector, field character offsets and text lines; character geometry is measured without replacing or editing the field |
| Terminal          | Owned session ID, output row/column positions and quoted output                                                             |
| Video/audio       | File and playback timestamp                                                                                                 |

Source versions and exact quotes travel to the worker with the explicit
follow-up. The conversation displays compact source references instead of raw
absolute paths and version strings. Existing comments created by the earlier
conversation-based UI are migrated into visible annotation history without
deleting their messages.

Text offset anchors are checked against the quote. An offset that no longer
matches falls back only to a unique literal match. Ambiguous or removed text is
not assigned a guessed highlight. Comments on another page or worksheet become
visible when that page or sheet is selected. These are MemCode annotations;
they do not rewrite Word/PDF/Excel files into a proprietary review format.

## File links and previews

Conversation links resolve to the owning card's saved artifact or a readable
project file, including editor-style line suffixes. Web links open that card's
Browser immediately. Opening a URL already in that card selects its existing
tab and preserves page state. A stopped local server produces a readable error
in Browser. A link cannot restart an arbitrary command by itself.

Artifacts remain separate from live browser tabs. Readers are loaded on demand:
Markdown, Word, Excel, PowerPoint, PDF, source text, images, video and audio.
Office previews show saved content, not a complete Office editing engine. The
spreadsheet view shows stored values; it does not recalculate formulas.

PDF uses PDF.js with a device-scale canvas, text layer, page controls, fit/zoom,
font/CMap/image support and password entry. Media uses native playback controls
and HTTP byte ranges for seeking; large media is not buffered into the React
app or sidecar. Codec support follows the system browser. Preview limits are
25 MB for document/text assets, 250 MB for PDF and 4 GB for media. Office ZIP
expansion is separately bounded.

## Boundaries and verification

The guest receives a private read-only file capability and a narrow selection
transport. It never receives the desktop bridge. Selection events can open a
draft; only the main app saves or shares annotations. Annotation updates use one
scoped event stream rather than polling every agent. Project paths are resolved
and checked after following filesystem links.

`scripts/review-smoke.mjs` runs actual Tauri/WebView2 checks in a disposable
profile. It verifies file links, source lines, Word, Excel ranges, PDF selection
and navigation, native video/audio playback, timestamps, diff and terminal
comments, HTML element/area selection, field offsets, persistent highlights,
save-without-send, explicit sharing and same-card web navigation. Local viewer
fixtures are labeled separately from real-harness evidence. The smoke script
reads only the fixture directory you choose; it never reads another person's
MemCode workspace or copies that person's saved outputs.
`tests/review-comments.test.ts` also verifies persistence, editing,
ownership, migration and explicit sharing without worker invocation.

Native browser checks cover real selection, clipboard, input, nested/page
scrolling, popups, isolated storage, background capture, concurrent startup and
RPC liveness. The desktop observations in this iteration are Windows checks.
They do not establish native UI parity on macOS or Linux.

## Prepare your own viewer fixtures

Use the ignored `tmp/verification-fixtures` directory, or set
`MEMCODE_REVIEW_FIXTURE_DIR` to another directory you control. The native smoke
checks expect these files:

- `claude-creative-brief.docx`, containing “Atelier creative brief”.
- `codex-mission-planner.xlsx`, with “ORBIT MISSION PLANNER” on its first
  sheet and a `Destinations` sheet containing the Mars example at row 3.
- `cursor-field-notes.pptx`, an ordinary local presentation.
- `review-guide.pdf` and `review-tone.wav` from the PDF/audio helper below.

The provider names identify the original fixture scenario. Regenerated files
are local test fixtures and must not be presented as fresh provider results.
Historical benchmark JSON uses `<USER_HOME>` in place of personal machine
paths; its measurements and methodology are unchanged by that redaction.

If you have the document tool runtime used by the original optional proof,
set `MEMCODE_DOCUMENT_RUNTIME` to its installed dependencies directory and
`MEMCODE_DOCUMENT_SKILL_DIR` to the installed document skill directory for the
chosen format. Optional `MEMCODE_DOCUMENT_NODE`, `MEMCODE_DOCUMENT_PYTHON` and
`MEMCODE_DOCUMENT_PACKAGES` select your local executables and packages.
The runtime must provide the packages imported by
`scripts/fixtures/office-builder.mjs`; it is not included with MemCode.
Run `node scripts/fixtures/create-office-fixture.mjs claude` for Word,
`codex` for Excel and `cursor` for PowerPoint, selecting the appropriate skill
directory for each. The helper preserves an existing output.

Generate the PDF and WAV with Python and `reportlab` installed:

```sh
python scripts/fixtures/review-document.py tmp/verification-fixtures
```

Then build the native app and run
`node --import tsx scripts/review-smoke.mjs`. Missing prerequisites produce a
clear error before a native test app starts. No account, worker approval or
model invocation is part of fixture preparation or the viewer smoke check.
