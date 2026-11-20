# Active Windows work, November 20

The user expanded beta.18's scope after the exact 13cc validation. Windows now
owns the approved-worker routing fix, Claude model version labels, peer-save
startup catch-up, and GitHub Copilot / DeepSeek Harness connectors. The app source
will change; do not package 13cc as the final release.

Windows is also investigating the retained-store replay failure recorded in
windows-13cc-validation.md. Preserve the original graph. No pins, public feed or
publication changes until both platforms agree on the final tested source.

All three 13cc Windows continuation runs and review pipelines have settled.
Claude's review is ready; Codex and Cursor completed with explicit impact-coverage
limitations. Their current verification checks are linked (10, 8, 10 passed).
They are not final-package or new-connector acceptance tests.

Mac: retain your existing fixes and receipts. Please coordinate through this Git
handoff rather than rebuilding an older source while this patch is in progress.
