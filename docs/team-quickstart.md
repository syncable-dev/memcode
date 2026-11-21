# Your first shared project

MemCode shares the plan and the results. Each developer keeps their own source checkout, Memtrace analysis and coding workers on their computer.

MemCode is source-available for noncommercial work. Company-internal and commercial use require separate permission; see the [license](../LICENSE). Team collaboration follows the same terms as individual use.

## Invite your team

1. Open an existing project. In **Team**, choose **Create a team**, name it and approve your Memtrace account in the browser.
2. Choose **Share with your team**. Check the project and repository. Its existing goals, tasks, cycles, runbooks and discussions become the shared starting point. Current clients also transfer the original planning history and cycle checkpoints, so joining does not reset the delivery charts.
3. Choose **Invite teammate**, optionally restrict the invitation to their verified email, then copy the link and send it privately.

MemCode discovers the official Team service when it is enabled. You do not set up a server or receive a setup secret. If Team creation is not available yet, keep working locally and retry after service activation. Invitations include the service address automatically; private service operation is an advanced option.

## Accept an invitation

1. In your existing MemCode installation, choose **Join with invitation** in Team or the project selector.
2. Paste the link, review the team and project, then choose **Accept and open** with the intended Memtrace account.
3. Start planning, commenting and reviewing the project's existing work. Your personal projects remain separate.

You do not need to create an empty project or download MemCode again. Accepting a Team invitation does not grant access to the source repository or start a worker.

In **Team**, check **Planning history in sync**. Its recorded-change and cycle-checkpoint counts describe the history received from the shared service. A service-update or sync error is shown separately from the board connection; a connected board alone does not confirm that its historical charts were transferred. Keep the original project until history sync is confirmed on both computers.

## Start coding on your computer

1. Choose **Work on this computer** in the shared project.
2. Reuse a matching checkout, or select where to clone the repository. Git access is checked separately. Existing local changes are preserved; unrelated folders are not adopted.
3. Let Memtrace analyze the checkout. If setup needs attention, use **Check local engine** to inspect this computer's branch, source/index alignment and watch state.
4. In **Workers**, explicitly connect and approve your installed coding tool. MemCode supports Codex, Claude Code, Cursor, GitHub Copilot and DeepSeek Harness. Set its default permissions once.
5. Choose **New work** (or press **C**) and say what you want, or open a task that's already planned. Confirm the brief and start its worker. MemCode confirms your shared task claim before starting work.

A goal is an outcome you want; a task is one piece of work a worker does. You can just say what you want and let your worker plan the goals and tasks. Cycles can wait until your team wants a delivery rhythm.

## Share a result

Review the worker's changes and checks. Publish selected reports or artifacts through Team when ready, up to **5 MiB per file**. Teammates receive that saved file. A published HTML file does not include its linked assets or running development server.

Task discussion belongs in **Comments**. Instructions for a worker belong in **Conversation**; follow-ups sent while it is busy appear in **Queue**, where you can edit or cancel them before pickup. Saving a selected-text review comment does not send it to a worker until you explicitly send the follow-up.

## Know what is synchronized

| Shared with the team | Kept on this computer |
| --- | --- |
| Goals, tasks, cycles, runbooks, planning history, authored comments and activity | Source files, local paths and Memtrace graph |
| Confirmed task claims | Coding-provider credentials and approvals |
| Worker conversation, actual model, progress and saved review | Raw tool output, approval prompts, browser sessions and terminal processes |
| Files you explicitly publish | Coding-provider sessions and credentials |

### Continue a shared worker

Open the task on either computer. The card shows who is running it, where it runs, the confirmed model, and the shared conversation. Send a follow-up from the same composer. **Queue** shows whether it is waiting, received by the host, or picked up; the author can edit or cancel it before pickup.

The executing computer keeps the coding session. Teammates do not need that provider installed to send a follow-up or read its saved review. If the host is offline, the request waits for it to return. MemCode never silently starts a second worker on your computer.

In **Code review**, read the same saved measurements and findings, ask a question, or request a new review on the executing computer while the task is in the Code review lane. Missing evidence remains labelled; synchronization does not turn a partial result into a pass. Source-changing actions and approvals remain on the host.

Both apps and the Team service must support shared sessions. An older service shows an update message; sending is not reported as delivered when it is unavailable.

**Git still carries the code.** Each goal ships as its own pull request; fetch teammates' merged work through Git as usual. See [How goals work](goals.md). A current board does not mean your checkout is current. Each computer analyzes its own checkout.

Claims prevent a second official worker from starting the same task. Different tasks can still edit the same files. Local Fleet coordinates local workers; this beta does not provide cross-computer Fleet coordination or live shared-file editing.

Planning edits can queue offline; starting a new shared worker requires an online claim. Removing Team access blocks future service requests, but cannot erase downloaded files, change Git permissions or stop another computer's processes.

For service operation, recovery and detailed limits, see [Team Sync](team-sync-preview.md). Application updates are separate from joining a project or fetching its source.
