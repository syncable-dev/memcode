# Beta.18 adapters and routing

App candidate: `ef141194efbfa84ff4fe8d1ec0433195f6e9dffd` on
`fix/history-independent-workers`. Subsequent documentation is not a new app-code
candidate. See `beta18-dirty-history-engine-handoff.md` for engine/native gates.

GitHub Copilot CLI and DeepSeek Harness use the existing conversation, approvals,
follow-up queue and shared-session protocol. Detection does not grant consent.
Connect each in Workers. Review and Full access are supported; these ACP
transports do not expose Smart auto.

Routing considers only explicitly connected, available runtimes and authenticated
catalogs, with stable ordering. Unknown capabilities stay provisional and use an
advertised default. Claude labels include reported model versions and resolved
aliases. Do not infer availability from this host agent's own model list.

## Copilot transport correction

Copilot 1.0.114 rejects client-supplied stdio MCP servers in ACP `session/new`.
The first native coding turn completed but lacked MemCode tools: a real failure,
not tool coverage. The fix supplies private per-worker `copilot-mcp.json` through
its documented `--additional-mcp-config @<path>` launch argument. Global provider
configuration and project rules are preserved. ACP creation does not resend the
rejected stdio entries. DSH still receives scoped servers through ACP. Read-only
review remains restricted.

Official references:
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server

Strict ACP fixtures verify the launch file, allowlist and unchanged original
config. A real Copilot `claude-haiku-5.5` turn called a private test MCP tool and
returned its unpredictable response in 6,559 ms. Full native MemCode gateway
continuation is being recorded separately; the small probe does not replace it.

## Windows evidence and limits

- 981 app tests, typecheck and frontend/runtime build pass.
- Native detection exposes five adapters and retains existing approvals. New
  providers begin unapproved. Copilot was approved only in the isolated QA app.
- Real Copilot coding, same-session continuation and a separate read-only review
  passed with confirmed `claude-haiku-5.5` before the gateway correction. These
  prove provider execution, not the originally missing MemCode tool connection.
- DSH 0.2.2-rc.5 starts ordinary/read-only sessions and advertises a model. This
  isolated Windows setup lacks a `deepseek-official` provider API key, so real
  generation was rejected. DSH coding and continuation remain unverified. Use
  the Mac's already configured provider if available; never paste keys into Git.
- Missing provider token counters remain unavailable, not zero or estimated.
- Hosted Team accepts Copilot/DSH and advertises `workerSessions:1`. Matching web
  collector/admin fixes are at private Memtrace branch
  `fix/memcode-beta18-connectors-telemetry`, commit `2b13c82d9`. Its 36 targeted
  tests, typecheck and production build pass. That web change is not yet deployed.

## Mac validation

Preserve existing fixes and approved QA sign-in. Run local full tests, typecheck,
build and native checks on the exact agreed app source. Verify retained consent,
local model settings and version labels after two normal relaunches. Automatic
routing must not choose unapproved adapters.

For each new installed/configured connector, run a real narrow coding story;
verify relevant MemCode context and Fleet tools, resume the provider conversation,
and run a separate read-only review of captured changes. Record requested versus
confirmed model, real tests, tool use and unavailable measurements. Complete the
paired-user session/follow-up test. A picker entry is not provider acceptance.

Do not publish, alter production pins or transfer keys. Both platforms must clear
native and paired gates before production updater signatures/publication.
