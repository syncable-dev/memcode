<p align="center"><img src="src-tauri/icons/icon.png" alt="" width="72" height="72"></p>
<h1 align="center">MemCode</h1>
<p align="center"><strong>One board for the coding agents you already use.</strong></p>
<p align="center"><a href="https://www.memtrace.io/memcode#downloads">Download the desktop beta</a> &nbsp;·&nbsp; <a href="https://www.memtrace.io/memcode#walkthrough">Try the interactive demo</a> &nbsp;·&nbsp; <a href="https://www.memtrace.io/docs/memcode/getting-started">Getting started</a></p>

Give Claude Code a bug to fix while Codex works on the next feature and you review what Cursor changed. Each story keeps its conversation, diff, artifacts and review together. Open a card and you can pick up where the agent left off.

[![MemCode walkthrough showing a mobile menu story moving from the board into implementation and code review](docs/media/memcode-tour.gif)](https://www.memtrace.io/memcode#walkthrough)

### From a story to a change you can ship

1. **Write the outcome.** “Pressing Escape should close the mobile menu and return focus to the button.” Add the story to an epic. Group stories into a cycle when you want to track what shipped.
2. **Pick a worker, or let MemCode route it.** Memtrace measures complexity in the relevant code and traces what a change could affect. Inspect the suggested model and effort, or choose your own. Workers on one epic coordinate edits on its branch. Another epic can run alongside it in its own Git worktree.
3. **Review what changed.** Move the story to **Code review**. Open a finding at the source, compare complexity before and after, and see which checks ran on this change. Ask the reviewer a question, send a follow-up to the worker, or accept the story.

### Smart routing and measured code review

**Give each story the model it needs.** MemCode measures complexity and nesting in the relevant code, traces what the change could affect, and selects a model and reasoning effort from your connected coding agents. Straightforward changes can use lighter models; complex work gets stronger reasoning. Inspect the recommendation or choose your own worker and model.

**See what the change did to code quality.** Memtrace parses the actual source and compares the same functions before and after: maintainability, cognitive and cyclomatic complexity, and nesting. Review findings include source locations, detector evidence and affected code. Recorded checks stay tied to the reviewed source snapshot. Open a finding, ask the reviewer about it, or send selected fixes back to the worker before accepting the story. The review keeps measurement coverage visible and final acceptance in your hands.

### Start building

| | Available in the open beta |
|---|---|
| Desktop | macOS 13.5+ on Apple Silicon · Windows 10/11 on x64 |
| Coding agents | Claude Code · Codex · Cursor Agent, using your existing provider accounts |
| Team projects | Share the board, comments and published results. Each developer runs workers locally and exchanges code through Git. |

Install MemCode, sign in to Memtrace, choose your project folder and connect a coding agent. The installer includes Memtrace. The noncommercial beta includes unlimited local Memtrace analysis. Your coding provider handles model usage. The shared live agent browser currently runs on Windows.

**On the roadmap** · Linear and other issue and sprint tracker integrations, so teams can bring work from the boards they already use.

[Set up a team](docs/team-quickstart.md) · [Run parallel epics](docs/parallel-epics.md) · [Read a code review](docs/story-code-review.md) · [How routing works](docs/routing-measurement.md)

<details>
<summary><strong>Run MemCode from source</strong></summary>

Install Git, Node.js 22.12+, Rust 1.90+ and the Tauri prerequisites for your platform. On Windows you'll need MSVC Build Tools and WebView2. On macOS start with the [developer quickstart](docs/macos-development.md).

```sh
npm ci
npm run dev
```

The interface reloads as you edit. Finish active workers before restarting the desktop runtime. See [contributing](CONTRIBUTING.md) for the build and release workflow.

</details>

MemCode is available for noncommercial use under [PolyForm Noncommercial 1.0.0](LICENSE). Commercial use, including internal company development, requires a separate license. The bundled Memtrace engine is licensed separately. [Licensing](docs/licensing.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
