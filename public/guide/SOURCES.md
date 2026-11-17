# Guide image sources

Most images are unmodified screenshots of MemCode's actual native UI, captured from an independent disposable onboarding QA profile rather than the user's production profile. Built-in Design preview content is seeded example content. The Team, Terminal and Account illustrations use synthetic renderer fixtures, documented below. A screenshot of a UI or empty state does not verify a model run, code quality or token-saving claim.

The capture script does not launch coding models, grant worker access, sign in, record audio, download models or alter project source. It may add an ordinary file-reference message in the temporary QA story and open a local browser tab. It starts and closes only its own illustrative local terminal.

Captured: 2026-11-14T21:10:48.871Z

The four review images use a separate presentation fixture. From the MemCode checkout, run `node scripts/code-review-experience-smoke.mjs --capture-guide` to regenerate them in `tmp/code-review-experience-evidence`. They show the current review components with a fictional sign-in change.

| Image | Source | What it shows |
| --- | --- | --- |
| review-tour.png | CodeReview component with the example invitation story from `scripts/code-review-experience-smoke.mjs --capture-guide` | Main review workspace with findings, recorded checks and the read-only conversation. |
| review-overview.png | Same rendered example, summary panel | Maintainability of three measured functions, two findings and one passed check. All values in this example are fixture data. |
| review-finding.png | Same rendered example, expanded finding | Finding location, recorded evidence, discussion and dismissal controls. |
| review-quality.png | Same rendered example, quality panel | Before-and-after metrics for two matched functions, with separate function details and coverage. |
| team.png | Actual TeamOnboarding component; synthetic renderer fixture, captured 2026-11-16 by scripts/team-onboarding-smoke.mjs | Sharing an existing project's current state with a named team. The visible fixture label, fictional team/project and example.invalid account are illustrative. No real identity, repository, relay, provider approval or worker is involved. |
| workspace.png | Built-in Design preview (seeded examples) | Board and lane layout; cards are built-in example data where Design preview is available. |
| conversations.png | Built-in Design preview (seeded examples) | Actual conversations overview in the labelled example project. |
| cycles.png | Built-in Design preview (seeded examples) | Cycles UI and its current seeded or empty state; no delivery result was fabricated. |
| decisions.png | Built-in Design preview (seeded examples) | Fleet decisions page, including its current empty/example state. |
| activity.png | Built-in Design preview (seeded examples) | Actual activity view; example activity is not a live worker run. |
| insights.png | Built-in Design preview (seeded examples) | Code intelligence UI in its current example/empty state; displayed records are not a new measurement. |
| improve.png | Built-in Design preview (seeded examples) | Current improvement UI; no analysis or model was started for this image. |
| delivery.png | Built-in Design preview (seeded examples) | Delivery charts in the labelled example/current empty state; no claimed performance improvement. |
| project.png | Disposable onboarding QA project | Actual create/open project dialog. No project is created by this capture script. |
| workers.png | Disposable onboarding QA project | Actual installed/approved worker connection states; no approval was performed for this image. |
| account.png | Actual BetaAccess component; synthetic disconnected fixture, captured 2026-11-16 | Current Connect Memtrace beta panel. Visible example label, no account connected. No browser consent, engine download, real credentials or worker; capture verified zero external requests. |
| dictation.png | Disposable onboarding QA project | Actual local dictation setup/status. This capture never downloads a model, records audio or changes settings. |
| story.png | Disposable onboarding QA project | Actual brief-only onboarding story. Its worker has not been started. |
| routing.png | Disposable onboarding QA project; same frame as story.png | The same actual story inspector shows measured/provisional routing state honestly; no route metrics were injected. |
| comments.png | Disposable onboarding QA project | Story discussion created by the native onboarding test, including an owned edit and deleted-reply tombstone. These are discussion comments, not worker prompts. |
| queue.png | Disposable onboarding QA project | Actual follow-up queue after the native smoke test. A prerequisite prevented dispatch and the test cancelled its request; no model ran. |
| changes.png | Disposable onboarding QA project | Actual Changes state for a story with no coding run. An empty state is intentional; there is no fabricated worker diff. |
| artifacts.png | Disposable onboarding QA project | Actual saved-output list/empty state for the QA story. No fabricated agent-generated artifacts. |
| terminal.png | Actual WorkerTerminal component; website-demo in-memory Lumen fixture, captured 2026-11-16 | Real terminal renderer showing explicitly simulated output and a fictional example/lumen path. No shell command, source checkout, provider or model was used. |
| roadmap.png | Disposable onboarding QA project | Real epic created by the onboarding smoke test, with a deliberately unfinished QA prerequisite. |
| annotations.png | Disposable onboarding QA project | Actual line-number selection from index.ts in the QA project, with its exact quote in the unsent annotation composer. No comment or follow-up is submitted. |
| browser.png | Disposable onboarding QA project | Actual native guest page of a temporary, explicitly labelled local browser illustration, served only during capture. No coding agent is running and this is not evidence of agent/browser synchronization. Native child WebViews are captured separately because a parent screenshot omits them; this is not a composite or a remote website. |
