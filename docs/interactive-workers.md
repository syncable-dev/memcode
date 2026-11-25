# Interactive worker sessions

MemCode uses each installed harness's native interactive protocol rather than
closing a one-shot prompt's stdin:

| Harness     | Transport                                  | Input returned to                                      |
| ----------- | ------------------------------------------ | ------------------------------------------------------ |
| Codex       | app-server JSON-RPC                        | Original server request / active turn                  |
| Claude Code | Bidirectional stream JSON control protocol | Original control request / active session              |
| Cursor      | Agent Client Protocol (ACP)                | Original JSON-RPC permission, question or plan request |

Questions and permissions appear directly above the conversation input with a
**Waiting for you** state. A compact summary keeps the conversation visible;
the complete native action is available in expandable details. Offered decisions
remain harness decisions. Answers go to the waiting
session immediately. They do not become queued follow-ups. Stale, cancelled,
wrong-task or wrong-run replies are refused. Secret answers are returned to the
native session but redacted from persisted workspace history and renderer drafts.

## Permission modes

Set a default once for each connected harness in **Workers → Default permissions**.
Existing and new tasks inherit that harness's current default across projects.
The card's selector shows **Worker default** unless an explicit override was saved;
select Worker default again to clear an override. Automatic routing applies the
default of its selected harness, while a task override takes precedence.

The resolved mode and worker defaults are captured when a worker pass starts.
Changes during preparation or execution affect its next pass; they do not silently
grant a pending request or change a running session. Memtrace account/session
settings live in Settings and the compact profile menu, separate from Workers.

| Mode                             | Codex                                          | Claude Code            | Cursor ACP                                 |
| -------------------------------- | ---------------------------------------------- | ---------------------- | ------------------------------------------ |
| Review (existing default)        | Workspace sandbox, on-request, user reviewer   | acceptEdits            | Native allowlist / approval requests       |
| Smart auto                       | Workspace sandbox, native auto_review reviewer | Native auto classifier | Unavailable in the installed ACP transport |
| Full access (explicit selection) | never + danger-full-access                     | bypassPermissions      | force + sandbox disabled                   |

Native deny rules and administrator policy can still restrict what a harness may
do. Questions about the task and MemCode Fleet decisions remain visible in every
mode. Per-worker configuration overlays preserve global settings. Automatic model
routing excludes transports that cannot provide the chosen mode; it never silently
substitutes a more permissive mode.

Cursor CLI advertises `--auto-review`, but the installed ACP session factory only
uses its force flag and exposes model/behavior selectors. Its Smart Auto classifier
is wired in the interactive CLI path, not the ACP path. Writing an approvalMode
setting alone therefore does not supply automatic review. The unavailable choice
is disabled for manually assigned Cursor workers instead of claiming it works.

Native references: [Claude permission modes](https://code.claude.com/docs/en/permission-modes),
[Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions),
[Cursor run modes](https://cursor.com/docs/agent/security/run-modes),
[Cursor ACP](https://cursor.com/docs/cli/acp) and
[Cursor CLI flags](https://cursor.com/docs/cli/reference/parameters).
The Cursor ACP limitation is an installed-source finding, not a claim made by
those product documents. A no-prompt Codex app-server probe confirmed effective
`auto_review`/workspaceWrite and `never`/dangerFullAccess settings before any model
input was sent. Protocol fixtures cover the selected flags, effective-policy
rejection, question routing and persistent worker overlays.

Codex's installed default-mode question capability is enabled for the MemCode
process only. The installed version otherwise hides that tool outside planning
mode. Existing global configuration is preserved. Cursor CLI model aliases are
matched to the same model and effort in advertised ACP selectors; unavailable
variants produce an explicit error instead of a silent model substitution.

Worker status distinguishes tool work, waiting for the developer, Fleet handoff
and final result collection. Tool failures are visible as they happen. The old
generic “continuing implementation” status no longer hides the last observed
activity or an extended period without updates. A new attempt clears the prior
attempt's exit code and session identifier. Queue delivery is marked at the
actual prompt boundary after protocol initialization.

## The Cursor stall

In the Lishuai-test-2 incident, Cursor installed dependencies, started Next.js and
tested browser controls after its last visible assistant message. MemCode's
one-shot parser discarded Cursor tool events, including repeated MCP screenshot
timeouts. Claude then waited behind Cursor's earlier Fleet reservation. The
captured tool results did not show a pending human approval or question.

Native verification also reproduced a related hidden-page actionability failure:
hidden WebView2 pages did not produce the frames needed by some Playwright input
checks. Worker actions now briefly paint the same page outside the client area,
without taking focus or showing another card's page. Native captures and same-page
CDP fallback are bounded. If both fail, DOM observations remain available with an
explicit no-image diagnostic.

On Windows, workers' pages run in a browser of their own, with its files in
`webview-workers` next to MemCode's own `webview`. The runtime drives them over a local
debugging port, which the system picks and which is there only while a page is open. It
reaches workers' pages alone. MemCode's window has no such port: a development build, or a
profile of its own (`MEMCODE_DATA_DIR`), can ask for one with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, and nothing MemCode starts inherits that.
`scripts/worker-port-check.mjs` checks all of it against a running build.

## Verification

- All three transports have child-process protocol fixtures for exact request IDs,
  answer/decision mapping, cancellation, invalid replies and logical completion.
- Actual installed Codex and Claude Code completed native question and approval
  round-trips. The harmless approved command was Node's version check.
- Actual Cursor ACP permission cancellation was observed. Questions and plan
  responses have protocol-fixture coverage; the model did not produce a native
  question during the bounded real probes. No stronger live claim is made.
- Native MemCode UI verification selected a radio answer, sent it, inspected the
  exact command, chose Allow once, and observed the same session/run finish.
- Native browser verification covered hidden/visible animated pages, typing and
  clicking, another card's responsiveness and a forced native-failure/CDP fallback.
- Task, goal and cycle deletion passed through the actual UI. Source byte hashes
  were unchanged. Goal/cycle deletion keeps their tasks; active workers block
  deletion before mutation.

Evidence is saved outside the repository under `../tmp/memcode-interaction-ui/`,
`../tmp/memcode-browser-capture/` and the labelled native harness probe folders.
The UI test script retains earlier assertion-only failures alongside the final
passing run. No user project was used for these tests.
