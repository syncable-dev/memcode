# Account and worker connections

## Connect Memtrace beta

Use the account button at the top right, or open Settings and choose
**Connect Memtrace beta**. Approve the intended Memtrace account in the official
browser flow. After that explicit approval, MemCode verifies and prepares the
separately licensed engine included in the installer. Published installers include Node.js; a
separate global Node installation or Memtrace CLI is not required for beta use.

Your source, local analysis graph and worker execution stay on your computer.
Beta access provides unlimited local Memtrace analysis for eligible
noncommercial use. Coding-model accounts, tokens and subscriptions remain
separate. Connect and approve your installed coding tool in **Workers**.

When connected, choose **Change account** to approve a different Memtrace
account in the browser. **Cancel** ends a pending sign-in. A cancelled or failed
attempt is not presented as a completed account change.

Choose **Sign out of Memtrace beta** and confirm to pause beta access on this
device. Local projects stay saved. Analysis remains paused until you reconnect
or deliberately choose **Use existing CLI setup**. Sign-out, expiry or failed
renewal never silently falls back to paid CLI usage.

## Advanced: existing Memtrace CLI setup

The account panel also supports **Existing Memtrace CLI setup** for developers
who explicitly choose their separately installed engine, account and plan.
That choice disconnects beta access and uses the CLI's own usage limits.
MemCode does not create a second account, read or copy the CLI credential file,
or expose license keys and session tokens to the renderer.

The host reads `memtrace status --json`. A running owner's session state can
establish an existing Memtrace connection; a standalone default `Valid` state
without an owner does not establish a user identity. Explicit sign-in delegates
to `memtrace auth login`, accepts only its official HTTPS `/claim?code=...` URL,
and opens that claim in the system browser through a narrow native action. The
user completes Memtrace's existing sign-in flow. A successful official login
fast path also works before a local owner has started.

There is no `memtrace auth status` command: in the current CLI it falls through
to login. MemCode never calls it. It also never runs global `auth logout` as a
side effect of disconnecting a worker.

### Sign out or use another CLI account

Open the account button at the top right, or **Settings → Your Memtrace account**.
Choose **Switch account** or **Sign out**, then confirm the action in the same panel.
Switch runs the official `memtrace auth logout` command before starting
`memtrace auth login`. **Cancel sign-in** stops only the pending login process
started by MemCode. A failed or cancelled login is not presented as a completed switch.

This changes the shared Memtrace CLI session for the current OS user, across local
projects. It does not delete local MemCode projects, sign your coding tools out
of their providers, or delete saved Team membership. Verified Teams lock locally
until the intended Memtrace person confirms the account in the browser again.
Older invitation-preview memberships stay separate. The browser's memtrace.io
login is separate from the installed CLI session; the Team approval page lets
you explicitly choose a different browser account.

Account changes are blocked while workers are preparing, running or stopping.
After changing the session, restart MemCode before starting more workers. Restart
any Memtrace workspace running separately as well: CLI logout removes saved
credentials but does not replace an already-running daemon's cached authentication.
MemCode does not terminate external workspace daemons. The worker guard applies
to direct starts and automatic queued follow-ups for every adapter.

MemCode records only a non-secret explicit signed-out flag in its local profile,
so refreshing or reopening the app cannot turn a cached owner's old `Valid` status
back into an adopted account. It never reads or copies the Memtrace credential file.
An unreadable local policy is preserved and blocks new worker starts until repaired.

If authentication is managed by `MEMTRACE_LICENSE_KEY`, `MEMTRACE_DEV` or
`MEMTRACE_OFFLINE`, the panel shows the variable names without their values.
In-app switching is disabled because deleting a credential file cannot remove a
launch-environment override. Remove the override from the environment that starts
the app, then restart before using the normal browser sign-in flow.

The Team Sync preview can be tested on two machines signed into the same Memtrace
account. Each machine must join using a fresh invitation and its own local profile;
do not copy the private `team/connections.json` file between machines. This tests
device synchronization and claims, not verified multi-user account permissions.

## Identity boundary

In advanced CLI mode, Memtrace `AuthState` and its stored credential shape contain session,
edition and optional organization/seat principal fields. The current public
status interface does not expose a general signed-in person's account ID,
display name or email. A valid license/session must not be labelled as a verified
person. MemCode shows that distinction in account details, and only supplies a
Memtrace author principal when the CLI actually reports one. Otherwise local
comments use an honest local author.

Verified Team membership uses a separate, supported Memtrace web boundary:
explicit browser approval, a one-time PKCE code and an Ed25519-signed identity
proof bound to that relay and its single-use nonce. Its stable person ID and
name come from the actual Memtrace browser account. Targeted email invitations
require a verified email. CLI credentials, license keys and model accounts are
never sent to a relay. The web issuer must be deployed and enabled; MemCode
checks availability before opening its browser and reports an unavailable
service immediately. Browser cancellation never adopts a new identity.

## Worker approval

An installed or signed-in provider is not automatically connected to MemCode.
The user opens Connect, reviews the execution and context scope, checks the
approval box and explicitly approves. The host validates an existing sign-in
using read-only commands:

| Adapter          | Read-only check                                          |
| ---------------- | -------------------------------------------------------- |
| Codex            | `codex login status`                                     |
| Claude Code      | `claude auth status`                                     |
| Cursor Agent     | `agent status --format json`                             |
| GitHub Copilot   | Model catalog probe; the CLI confirms access on first use |
| DeepSeek Harness | Model catalog probe; the CLI confirms access on first use |

Configured local Codex inference does not require a cloud login. The consent
receipt contains only adapter, executable path, approval time, auth category,
optional harmless account label and scope version. No provider token is stored
in the receipt. Changing the runtime path requires a new approval. Automatic
routing considers only approved installed runtimes; manual starts validate their
specific adapter and path.

Connecting does not start a coding task. Starting a task authorizes work. To
disconnect an adapter, first stop its active workers; disconnect then prevents
future starts without signing the user out of their provider. Local Fleet
coordination and provider permission rules still apply; these consent records
are not hard filesystem write fencing.

The connection tests use real short fixture processes to verify that only the
documented status commands run, approval is explicit, paths are bound, secrets
are omitted and Memtrace sign-in opens only the official claim host. Actual
installed status checks on the Windows development machine confirmed the Codex,
Claude Code and Cursor CLIs had existing provider authentication, without granting
production consent.
