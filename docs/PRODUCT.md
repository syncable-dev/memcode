# MemCode: Fleet Agentic Worker Suite

MemCode is an independent local Tauri app for planning work and running coding
agents. You say what you want; your connected worker plans it into **goals**
(outcomes you want) and **tasks** (one piece of work each). A task owns its brief,
runbook, conversation, worker attempt, changes and artifacts. Memtrace provides the
understanding underneath the experience.

## Two starting points

**Existing code:** choose a folder, analyze it with Memtrace and say what you want.
Your worker plans it: a small fix becomes a quick change, bigger work becomes a goal
with a few tasks, and work that touches code an open goal is already changing joins
that goal. Tasks in a goal run side by side and stay coordinated.

**New idea:** choose a location, describe the project, create the initial brief and
runbook, then iteratively turn that into working software. Dictation is another
way to write the brief, not a separate product flow.

## Implementation boundary

React renders the workspace. A narrow Tauri bridge exposes validated IPC. Rust owns
native windows, folder dialogs and isolated preview WebViews. A bundled local Node
service owns project files, persistence, process launches and Memtrace MCP.
Installed harnesses own model execution; the app normalizes their observable output.
The browser never receives the desktop bridge.

Each goal owns a branch and an isolated workspace (a Git worktree under MemCode's
profile), started from the team's integration branch. Its task workers share that
workspace and edit it at the same time; nothing is locked. Memtrace Fleet supplies
intent, conflict classification and the referee for disagreements. An overlap is
merged by the workers as they go. A disagreement the workers involved cannot settle
enters the human decision queue with what each of them wants, and holds only the
contested code. Changes remain in place; a decision does not reset files, and the
workers involved hear it at once. Commit, push, pull request, merge and
Update from dev happen only from explicit actions that list each step first. See
[How goals work](goals.md).

There is no mandatory cloud service and no MemCode account. Cloud model use is
optional through a user's harness. Transcription uses a loopback speech server.

## Dogfood loop

Open the MemCode repository as a project. Use Memtrace to examine it. Improve the
app through small tasks, inspect the produced change, and record what the
iteration taught us. Keep the experience useful while gradually strengthening its
evidence and execution contracts.

Suggested next tasks:

1. Extract the heaviest UI and IPC functions using measured source impact.
2. Add host-run verification receipts bound to candidate revisions.
3. Qualify actual diffs and refine Fleet intents instead of reusing scope seeds.
4. Conformance-test each harness, cancellation and resume behavior.
5. Make routing explainable in shadow mode before optimizing model selection.
6. Improve voice onboarding and offer a managed local speech model installation.
7. Add authoritative acceptance fencing before automated parallel integration.

The product should earn trust through useful changes and an excellent workflow.
It should not claim deterministic task difficulty, guaranteed correctness, or
unlimited safe concurrency.
