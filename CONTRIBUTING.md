# Contributing to MemCode

Bug reports, reproducible examples, design feedback and documentation
suggestions are welcome. Remove account details, credentials and private
project data before sharing a report.

MemCode is source-available under the PolyForm Noncommercial License 1.0.0.
Third-party components retain their original licenses. A contribution must
not include proprietary Memtrace or MemDB implementation, copied private
code, secrets or material you do not have permission to submit.

Before submitting source changes, open an issue to agree on scope and contact
support@memtrace.io to arrange a contributor agreement. Until that agreement
is in place, maintainers will not merge external source-code contributions.
No contributor agreement is implied merely by opening an issue or sending
feedback. This keeps ownership and future commercial licensing explicit.

`dev` is the integration branch and the default pull-request target.
`main` contains approved release work.

## Core maintainers

Use `dev` for normal development and push validated work there. Repository
administrators and maintainers can update `dev` directly. Keep unrelated or
unfinished work isolated until it has been validated; existing topic branches
are integrated through pull requests into `dev`.

Promote tested work from `dev` to `main` through a release pull request. Use
rebase merge to keep the release history linear. If histories have diverged,
prepare a release branch rebased onto `main`; do not rewrite the shared `dev`
branch. `main` requires an approving code-owner review from someone other than
the last pusher, resolved conversations, and a pull request. Administrators
follow the same `main` review rule.

Force pushes and deletion are blocked on both `main` and `dev`.

## Other contributors

Fork the repository, create a topic branch in your fork, and open a pull request
against `syncable-dev/memcode:dev`. Explain the problem, the change, and how you
tested it. An approving code-owner review is required before merging.
Repository write access alone does not permit direct updates to our working
branches; the maintainer exception is limited to admin and maintain roles.

The repository is currently private; see [LICENSE](LICENSE) for its source license.

## Verification

Run relevant checks locally and include their results in the pull request:

```sh
npm run typecheck
npm test
npm run build
```

Native changes also need the relevant native tests and desktop checks described
in [AGENTS.md](AGENTS.md). Do not dispatch GitHub Actions or add a required CI
check without an explicit request. For a Mac check you cannot run locally,
provide the exact pushed branch/commit and a reproducible test prompt for the
person running the Mac.

Keep generated engines, credentials, private project state, and release signing
keys out of commits. The contribution template records local validation; it
does not claim that GitHub Actions or a release installation has run.
