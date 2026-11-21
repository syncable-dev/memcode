# Build with your team

MemCode shares a team’s board, goals, tasks, cycles, comments, activity and published results. Each developer runs their own workers and Memtrace analysis locally. Git carries the code between their computers.

You can join, plan and comment before downloading the project’s source.

Start with the [team quickstart](team-quickstart.md) for the shortest path from invitation to your first local worker.

## Start with one project

1. Open the project you already use. In **Team**, choose **Create a team**, give it a name and complete the Memtrace approval in your browser.
2. Choose **Share with your team**. Check the project and repository shown. Planning and worker conversations become visible to project members. Source checkout, provider credentials and execution stay on their owner's computer.
3. Choose **Invite teammate**. Optionally restrict the invitation to their verified email, then copy the link and send it privately. Your teammate sees the team and project before accepting.

One team can have several projects. Existing personal projects stay available and separate. Creating a team does not start a worker.

MemCode discovers the official Team service when it is enabled. Normal users do not configure a server or receive a setup secret. If Team creation is not available yet, the Team screen explains that it needs service activation; you can continue working locally. Invitations include the service address automatically. Private service operation remains an advanced option.

## Join the work

1. Open your existing MemCode installation. Choose **Join with invitation** in Team, or the join action in the project selector.
2. Paste the link, check its team and project, then choose **Accept and open**. Approve the intended Memtrace account in the browser. Email-restricted invitations must match that account’s verified email.
3. The shared project opens with its current goals, tasks, cycles and discussions. Your personal projects are preserved. There is no empty-project prerequisite.
4. Move a task, leave a comment or review a published result. None of those actions starts a worker on anyone’s computer.

An invitation grants Team membership. It does not grant GitHub access, connect a coding provider or download source files automatically. Expired, revoked or wrong-account invitations need a new invitation or the intended account.

## Work on the code locally

In the shared project, choose **Work on this computer** when you are ready to run a worker.

- **Already have the code?** Use the matching checkout MemCode finds, or choose its existing folder. MemCode checks the repository identity and preserves its current branch and uncommitted changes. A folder belonging to another repository stays unbound.
- **Need the code?** Choose **Clone the repository**, check access, pick a destination and name a new folder. MemCode first checks the computer’s existing Git credentials, including authorized SSH setups. GitHub sign-in is offered only when needed and requires an explicit action. Progress and cancellation are visible; failed or cancelled clone folders are preserved.
- Memtrace then analyzes that local checkout. Open **Workers** to connect your own installed coding provider with explicit approval. Start a task’s worker when you are ready; it first confirms the shared task claim.

Team identity, Git repository access and coding-provider authentication are separate connections:

| Connection | What it grants |
| --- | --- |
| Memtrace browser identity | Membership of a named MemCode team |
| Git / GitHub credentials | Access to clone, fetch and push the source repository |
| Codex, Claude Code or Cursor connection | Permission for MemCode to run that developer’s local coding tool |

A shared checkout already used by another active local project cannot be rebound or run through a second project alias at the same time. This prevents two sets of workers switching the same local branch underneath one another.

## Share results deliberately

Publish a saved report or artifact from Team when it is ready. This uploads the selected file, up to **5 MiB**. Teammates can download and view that exact saved output. Markdown, PDF, images and self-contained Office documents are useful first tests.

A published HTML file does not bundle its linked assets or share its running development server. Browser sessions, terminal processes, raw tool output, approval prompts, model credentials and local analysis stay local. Worker conversation, confirmed model, progress, and saved review reports sync with project members. Include only information intended for the team in prompts and comments.

## Stay in sync

The connection indicator, queued-change count and unread activity describe different things. Accepted planning changes are journaled, retried operations are deduplicated, and reconnecting clients catch up from their last received event.

Current clients use an additional authenticated history channel to preserve original task dates, runbooks, archive state, workflow configuration, planning events, cycle baselines and historical checkpoints when an existing project is first shared. The import is owner-only and retry-safe. Future shared planning history is derived from accepted service events, giving each computer the same recorded chronology. Shared worker conversations use a separate authenticated session channel; terminals and the Memtrace graph stay local.

The Team screen reports history sync separately from the current board. An older service can still sync its supported board fields, but cannot confirm historical planning transfer; update it before relying on matching charts. Older clients can keep using the original board protocol, while an updated client is required to display the preserved history.

Metadata edits can wait in the local outbox while offline. New shared workers need a reachable service to confirm ownership. A registered device or cached claim is not evidence that a worker is currently running.

**A synchronized board does not mean synchronized source.** Code moves through Git: each goal ships as its own pull request, and you fetch teammates’ merged work as usual. A task claim prevents a second official worker on the same task; different tasks can still change the same files. Local Memtrace Fleet coordinates workers on each computer. This pilot does not provide live shared-file editing or cross-computer Fleet coordination.

Routine completion and explicit Stop release a task claim. After a crash, the owning device must check that its worker stopped before releasing the saved claim.

Owners can remove a teammate’s access. Revocation blocks subsequent Team requests, including pending long polls; it cannot erase already downloaded files, change GitHub repository permissions or stop another computer’s local process. Account changes require reconnecting verified Team membership rather than silently reusing another person’s access.

## Updating MemCode is separate from joining a project

A teammate who already installed MemCode uses that installation. They do not clone the MemCode application repository again just to accept an invitation.

If an application update is needed, update the existing MemCode checkout using the installation instructions. Choosing or cloning the team project’s source is a separate step under **Work on this computer**.

## Advanced: pilot service operation

The pilot uses a small authoritative HTTP relay with a durable journal, published-file storage and per-client outboxes. It does not require a managed database, host a Memtrace analysis engine or replicate source folders. It is not a peer-to-peer filesystem or a DeltaDB integration.

An operator can run the standalone relay after building the runtime:

```powershell
npm run build
npm run team:relay -- --data-dir C:\private\memcode-team --port 9331
```

For remote participants, configure a reachable HTTPS endpoint and the required scoped Memtrace identity issuer/verifier. The owner’s private Team service configuration selects that endpoint and setup capability. Keep setup capabilities and service credentials out of invitations, public issues and screenshots. No public service or tunnel is deployed automatically.

The service must stay running for live synchronization. An embedded service depends on its host application; a separately hosted service can run independently. A temporary HTTPS tunnel provides transport only. It is not membership, repository authorization or project hosting.

### Legacy standalone workspace previews

Older builds exposed raw workspace invitation objects, display names and **Advanced connection** relay settings. Those standalone preview memberships are not verified named-team membership. They remain a compatibility path for older pilots, rather than the normal onboarding flow.

Use **Create a team → Share project → Invite teammate** for new collaboration. Joining a named team never requires an unrelated empty local project, manual JSON editing or another clone of the MemCode application.
