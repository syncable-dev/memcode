# MemCode

MemCode is an independent Tauri app. Official installers include a pinned,
separately licensed compiled Memtrace engine, staged during release packaging.
Do not copy the Memtrace backend source into this repository or commit generated
engine binaries. Keep managed engines separate from a user's global CLI setup.

## Product

- Visual quality is a first-prototype requirement. Use the benchmark-derived
  charcoal, paper, mint and cyan tokens in `src/styles.css`.
- Keep the board, conversation, runbook and artifact experience coherent.
- Keep execution, credentials, local repository bindings and approvals local.
  Personal projects stay local. Opt-in Team Sync may share planning, comments,
  activity and explicitly published results; source changes use Git in this
  preview. Cloud models may be used by an explicitly selected installed harness.
- On a shared project (MemSync), a worker's conversation is its person's alone, on
  each of their computers. Everyone else gets the request, how the run stands, a
  summary of each round of work, its review, what it changed and the documents and
  images its worker made. Only the worker's own account continues it.
- Do not invent live workers, successful tests, metric values or confidence.
  The example project must remain visibly labelled as example data.
- A worker exit creates a review candidate, never an automatically verified change.
- Every task belongs to a goal (epic). Commit, push, pull-request creation, merge and
  Update from dev happen only from explicit actions that list each step first.
  Never deploy.

## Engineering

- Use Memtrace graph context for nontrivial discovery and impact when indexed.
  Follow results with bounded source reads. Index this repository, never its parent.
- Keep Node capabilities in the local runtime sidecar. Tauri owns native windows,
  dialogs and previews. Use the typed, validated stdio/Rust IPC boundary.
- Isolate browser/artifact content from the app and its preload.
- Never interpolate prompts into shell commands. Spawn with argument arrays.
- An epic owns one Git branch. Story workers share the project checkout on that
  branch, edit it at the same time and coordinate through Memtrace Fleet: declare,
  edit, record. Do not create per-worker branches or worktrees, and do not add
  locks or turn-taking between workers. Preserve shared changes on stop/failure.
  Only a disagreement the workers involved cannot settle goes to a human, and it
  holds only the contested code.
- Prefer small modules and native APIs over extra frameworks.
- Run `npm run typecheck`, `npm test`, `npm run build` and the Tauri smoke
  check for relevant changes. Inspect the actual desktop UI for visual changes.

## Updates and release verification

- Normal app updates preserve the profile, approved account and projects. Offer
  download progress and an explicit restart action; never require a new account
  approval merely because the app or bundled engine version changed.
- Reuse an already approved, isolated QA profile for release verification. Refresh
  its session through the native credential store. CI receives only a temporary
  signed engine proof, never a refresh credential or the user's normal profile.
- Remove temporary proof files and CI secrets after a run. Keep a persistent QA
  account approved across releases; revoke it when explicitly disposable or when
  the user asks. Do not create fresh browser-approval loops for routine updates.

## Iteration

- `dev` is the default integration branch. Normal validated maintainer pushes
  target `dev`; fork contributions and isolated topic work use PRs into `dev`.
- Promote release work to `main` through an approved PR using rebase merge.
  Never push release changes directly to `main`, force-push either shared
  branch, or merge unrelated work merely to change the branch structure.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md). Preserve other agents' working
  changes and pending platform verification when integrating topic branches.
- Run verification locally. Do not dispatch GitHub Actions, create mandatory
  CI checks, or spend hosted runner minutes without an explicit user request.
  Hand off a pushed branch and exact local-test instructions for Mac checks.

Use this app's own dogfood backlog to improve it. Keep a clear distinction
between functionality available now and planned correctness/policy hardening.
Never describe cooperative Fleet coordination as hard write fencing.
