# Collaboration onboarding contract

MemCode shares a team's plan and published results. Each developer chooses a local source checkout and runs their own approved workers. Git exchanges code; the board's sync status does not imply that local source is current.

## Established patterns

- [Linear workspaces](https://linear.app/docs/workspaces) and [member invitations](https://linear.app/docs/invite-members): a named organization, explicit membership, then projects.
- [Zed authentication](https://zed.dev/docs/authentication) and [channels](https://zed.dev/docs/collaboration/channels): browser sign-in, named private collaboration spaces, invitations and clearly granted access. Zed's guests edit the host's files; MemCode's independent local-worker model needs its own checkout step.
- [GitHub Desktop cloning](https://docs.github.com/en/desktop/adding-and-cloning-repositories/cloning-and-forking-repositories-from-github-desktop): repository access and a user-selected local destination. Repository authorization is separate from a collaboration invitation.
- [Live Share joining](https://learn.microsoft.com/en-us/visualstudio/liveshare/quickstart/join): accept an invitation and open shared work directly, without first creating an unrelated empty project.
- [Delta thread collaboration](https://delta.dev/docs/collaboration/collaborate-thread): Share, choose access, invite, authenticate, open the shared work. Its replicated filesystem is a different source-sharing architecture from this MVP.

## Owner

1. Open a personal project. Choose Team, then create a named team once.
2. Complete the Memtrace browser approval. Membership uses the authenticated person's identity, never an editable display name or a license owner inferred from CLI status.
3. Share the selected project's current board, goals, tasks, cycles, comments and activity. Confirm its sanitized repository metadata when available. Source files, local paths, model credentials, terminals and private outputs remain local.
4. Invite a teammate. A normal invitation is a link, identifies the team/project, has an expiry and can be restricted to a verified email. Members and revocation are visible to the owner.

## Invitee

1. Choose Join from the project selector or Team screen; paste the invitation. No empty project, relay address, setup secret or app re-clone.
2. Preview the team/project/access, approve Memtrace sign-in and accept membership.
3. Open the shared project's existing state immediately. Existing personal projects remain separate, including when record IDs collide.
4. Plan, comment and review published results without local source.
5. When ready to code, choose a matching existing checkout or select a parent folder and clone the project's repository. Check existing Git credentials first; offer GitHub sign-in only when needed. Show wrong-account/no-access/offline errors distinctly. Never reset, stash or overwrite an existing folder.
6. Analyze that checkout with local Memtrace. Connect a coding provider with explicit approval. Then start a worker, which acquires the task claim before doing work.

## State and recovery

- Team membership, repository access and coding-provider connection are separate, visible states.
- One team can contain multiple project rooms. Each room retains its ordered, durable change journal and local outbox.
- A member's revocation denies subsequent requests, including a pending long poll. It does not change GitHub repository permissions or transfer a live worker's ownership.
- Metadata edits can wait locally while offline. A new shared worker needs an online claim; cached presence is never described as a running worker.
- Multiple local project records may point to one checkout. They cannot run workers concurrently through different records because that could switch their shared branch underneath one another.
- Remote participants use the existing MemCode installation. Updating the application is separate from joining a project.
- Pilot relay hosting is configured by the owner/operator. Invited members receive the service address through their invitation. A temporary tunnel is transport, not team membership or project hosting.

## Acceptance gates

Test owner creation, current-state invite join, existing-personal-project preservation, multiple projects, authenticated membership, wrong identity/email, expiry/replay, revocation during long poll, offline/outbox recovery, task-claim races, explicit output publication and download. Test existing checkout reuse, wrong repository, dirty checkout preservation, approved clone destination, cancellation and provider access errors. Verify the actual native onboarding UI; report physical macOS/remote acceptance separately from isolated local tests.
