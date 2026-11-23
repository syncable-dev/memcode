# Run MemCode from source on macOS

Use this route to test current `dev` changes on your Mac. If you already have the installed app and want to open your team's board, skip directly to [Join a team](#join-a-team).

## Install the prerequisites once

- Git and Node.js **22.12 or newer**. Check `git --version` and `node --version`.
- Rust with Cargo, **Rust 1.88 or newer**, using [rustup](https://rustup.rs/). Check `rustc --version` and `cargo --version`.
- Xcode Command Line Tools. Desktop development does not require the complete Xcode app:

```bash
xcode-select --install
```

Finish the installer before building. See [Tauri's macOS prerequisites](https://v2.tauri.app/start/prerequisites/#macos).

## Get the current source and open the app

Authenticate Git with the GitHub account that has access to the private [syncable-dev/memcode repository](https://github.com/syncable-dev/memcode), then run:

```bash
git clone --branch dev https://github.com/syncable-dev/memcode.git
cd memcode
npm ci
npm run dev
```

`npm ci` installs the lockfile's dependencies. `npm run dev` starts the renderer, local runtime and native shell. The first native build downloads and compiles Rust dependencies. Keep that Terminal open while using development mode.

For an existing clean clone already on `dev`, use `git pull --ff-only origin dev`. If you have ongoing fixes on a different branch, commit or otherwise preserve them and integrate `origin/dev` into your working branch before rebuilding.

UI edits hot-reload. Runtime/Rust edits require finishing or stopping active workers, closing MemCode and rerunning `npm run dev`. The current app does not detach and reattach running workers across a desktop restart.

## Connect Memtrace and a worker

In the installed app, open the project guide and choose **Connect Memtrace beta**. The installer includes the local engine. For a source build using a separately installed CLI, sign in to that CLI:

```bash
npm install -g memtrace
memtrace auth login
```

Open a real local project in MemCode. It discovers `memtrace` on PATH and can start the selected project's local owner when needed. If it is not found, choose the installed executable in Settings. See [Memtrace getting started](https://memtrace.io/docs/getting-started).

Install and sign in to at least one supported coding CLI using that provider's official instructions. Then approve its connection in **Workers**. The Cursor desktop editor alone is not a substitute for its Agent CLI. Provider credentials and model configuration stay on the Mac.

You can inspect the board and participate in planning before connecting a worker.

## Open a shared project

1. Open the project selector. A project shared with you, or shared from another of your own computers, is listed there: choose **Join** for an invitation, or **Open** for your own.
2. To share a project yourself, open it and choose **Share** at the top right, then invite people by email.
3. Open **Cycles** to see current and completed cycles. Look in **Workspace → Done** for completed stories and clear any board filters that hide them.
4. When you want to run a worker, connect your existing checkout or clone the repository. Sharing carries the board, summaries, changes and the files you share. Git carries source changes.

See [shared projects](shared-projects.md). The **Team** page is only shown for a project still in a Team Sync team, so it can be left; see [the Team Sync guide](team-sync-preview.md).

## Find the product tour and review guide

Open **Docs → Your first project → Watch product tour** to replay the welcome presentation. Choose **Open guided setup** to continue with your project. Inside any story, choose **Story guide** to explore its tabs.

Open **Docs → Code review** for a walkthrough with three illustrated examples. Move a story into the **Code review** lane when you are ready to start a review manually. Its **Code review** tab, between **Changes** and **Artifacts**, keeps the saved findings and measurements available through Acceptance and Done.

## Current platform limits

- The shared live agent browser currently uses Windows WebView2. It reports unsupported on macOS. Do not use that feature as a claimed macOS acceptance test yet.
- Native visible-preview screenshot capture is currently implemented for Windows. This is separate from ordinary saved-document rendering.
- For packaged runtime and installer checks, follow the [macOS desktop candidate guide](macos-desktop-candidate.md).
- `npm run build:native` currently uses `--no-bundle`. It does not produce a signed/notarized `.app` or `.dmg` installer. Use `npm run dev` for this source preview.

If a build fails, share the command, macOS version, Apple Silicon/Intel architecture, Node/Rust versions and the first actual error from Terminal. Keep credentials and private project text out of the shared log.
