# Beta.18 adapter and routing candidate

Windows added GitHub Copilot CLI and DeepSeek Harness through their native ACP
connections. Both use the existing conversation, approvals, follow-up queue,
MemCode MCP gateway and shared-session protocol. Detection does not grant consent.
Connect each provider explicitly in Workers. Smart auto is unavailable through
these two ACP transports; Review and Full access are supported.

DSH keeps its own provider configuration. A returned model catalog does not prove
that a provider key is configured. The UI labels that connection provider-managed,
and a real turn must validate the provider. Do not copy keys into Git or receipts.

Automatic route previews now use only connected runtimes, matching worker launch.
Equivalent catalogs have a stable ordering. Unknown model capabilities remain
provisional and use the provider's advertised default. We do not invent capacity
calibration for a newly supported adapter. Claude model labels include the version
reported by the signed-in account, including resolved aliases.

Windows checks on this candidate:

- All 980 application tests passed. Typecheck and frontend/runtime builds passed.
- The native desktop showed all five adapters and retained the three previously
  approved connections. The two new adapters remained unapproved.
- Copilot 1.0.114 completed a real clamp implementation, passed six assertions,
  resumed the same provider session, and completed a separate read-only review.
  Confirmed model: `claude-haiku-5.5`. Latest turn timings: 7.567 s and 8.309 s;
  review: 4.882 s. The review explicitly retained its missing graph coverage.
- That real review exposed missing JSON-RPC version markers in the new review
  transport. Fixed, rerun successfully, and covered by strict protocol fixtures.
- DSH 0.2.2-rc.5 started ordinary and read-only sessions and advertised its model.
  Its real Windows turn was rejected because this isolated setup has no provider
  API key. Real DSH coding and continuation remain unverified.
- The local Copilot CLI inherited a Memtrace hook command that PowerShell could
  not invoke. Its PowerShell invocation was corrected; the same hook stayed active.

## Mac agent

Fetch `fix/history-independent-workers` and preserve your existing fixes. Use the
commit introducing this handoff as the application candidate; do not package the
older 13cc source. Run the full tests, typecheck and native build locally. In an
approved QA profile, verify worker consent, retained settings and actual version
labels after two relaunches. Check that automatic routing never selects an
unapproved adapter. With each installed/signed-in provider, run a short real coding
story, resume it, and review its captured patch. Record confirmed model and test
results separately from transport-only checks. DSH requires its configured provider;
a catalog alone is not acceptance. Verify both new providers' Team sessions against
a service exposing `workerSessions:1` and accepting all five harness IDs.

Do not publish or change production engine pins. The retained Windows graph still
fails historical uniqueness on the 1eb engine. An engine follow-up is in progress;
the final app+engine package needs both platforms' installed-app checks and the
real two-device test before signatures and publication.
