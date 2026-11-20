# Measuring routing outcomes

The question is: **which model requests produce accepted work for a comparable,
measured scope, and how much execution and rework do they require?** These are
observational product records. They do not establish that a model is the best
choice, or prove that accepted code is correct.

## Outcomes have different meanings

- An attempt begins when a coding harness actually launches. Preparation failures
  must not become model-performance samples.
- A process finishing records an execution outcome. Exit zero is not human
  acceptance or a successful test suite.
- Human acceptance is an explicit local Done action linked to a recorded attempt
  and its corresponding change revision. Unlinked completions remain separate.
- Reopening accepted work is a later rework signal. It does not identify the cause
  of the rework, and should retain the original accepted-attempt relationship.
- A follow-up can add new requirements. It is not automatically a rejection.
- First-attempt acceptance requires complete captured attempt history. Enabling
  reporting on an existing story cannot establish its earlier history.

Accepted shares must show their denominator and pending/unlinked review counts.
Unknown outcomes are not successes or failures. Structured verification and token
counts are usable only when the adapter actually reports them; prose such as
“tests passed” is not structured verification.

## Compare scope, not just the selected tier

Freeze source measurements at attempt start: scoped AST cognitive and cyclomatic
maxima, nesting, observed impact and process counts, scope size and index-alignment
state. Preserve partial coverage, unknowns and lower bounds. Do not substitute a
repository-wide hotspot or a post-edit measurement for the planned scope.

The `memcode-envelope-v2` tier is a routing policy output with provisional
thresholds. Incomplete evidence can still select a balanced-or-higher model, so
that selection is not proof of measured complexity. Partial and unknown evidence
need their own cohorts. Source paths, symbol names, branches and revision hashes
are unnecessary for these comparisons and must not be transmitted.

Distinguish requested models from models confirmed by structured harness output.
Keep manual versus automatic selection, policy version and originating app
version. Queueing across an upgrade must not relabel old events as the new build.
Custom or unrecognized model names use a fixed non-content bucket.

Show sample counts and measurement/model coverage beside comparisons. Wall-clock
duration includes machine, tool and human waits; it is not pure model latency.
Router selection, task mix and review delays can bias comparisons. This feature
collects observational evidence for later investigation. Controlled calibration
uses its own opt-in input.

## Controlled routing comparisons

Compare the current, wording-only, graph-only and combined policies on the
same frozen stories. Decide the policy versions, candidate catalog, effort,
verification and rework budget before starting. Put all checkouts of each
repository in one group. Reserve whole repositories for evaluation before
fitting policy thresholds or estimating model performance. Use unfamiliar
repositories for the holdout and independent blind review for each first pass.

Record one initial worker run per frozen story and candidate. Candidate identity
includes the harness, exact requested model, effort and resolved model when the
catalog supplies one. Keep candidate receipts tied to the same source revision
and cohort. Collect the provider-confirmed model, the applied effort, structured
verification, blind review and explicit first-pass acceptance. A failed check,
rejected delivery or observed provider fallback counts against the route. An
unfinished run or missing proof stays unresolved. Record token usage, elapsed
time and actual USD cost in millionths through the same bounded rework window.
Use `null` for unavailable totals, including costs a subscription cannot expose.

Run the evaluator locally from a development checkout with dependencies installed.

```sh
node --import tsx scripts/routing-evaluate.ts path/to/frozen-outcomes.json
```

The input uses `version: 1`, `heldOutRepoIds`, `outcomes` and `decisions`. Use
opaque `repoId` and `storyId` values and the frozen Git commit as `revision`.
Each outcome supplies `cohort` (`kind`, `tier`, `coverage`), `candidate`
(`harness`, `model`, `effort`, optional `resolvedModel`), `observedModel`,
`observedEffort`, `execution`, `checks`, `blindReview`, `acceptance` and the
nullable totals `totalCostMicros`, `totalTokens` and `totalDurationMs`. A policy
decision has the same frozen story identity and a `routes` map with the four
policy names. Each route is the selected candidate or `null` for an abstention.
The execution states are `running`, `completed` and `failed`. For checks and
blind review, use `passed`, `failed` or `unverified`. For acceptance, use
`accepted`, `rejected` or `pending`.
For a cohort routed with inferred wording, copy `languageModelDigest` from
the route's wording evidence. For an edit with an observed maintainability index
below 10, include `lowMaintainability: true`. These optional cohort fields bind
outcome estimates to the evidence used to make those decisions.
Keep the raw experiment file local. The evaluator reads measurements and emits
aggregates. It launches no workers and makes no network calls.

The held-out report compares policies on stories with an observed choice for
every policy and reports coverage for each. Cost, tokens and duration each use a
common denominator across policies. A missing outcome stays visible in the
coverage counts. Keep those counts alongside any reported improvement.

The calibration snapshot uses paired stories from the training repositories.
Each repository contributes one equally weighted first-pass acceptance share
per cohort and candidate. Unresolved runs contribute zero to the lower bound.
The bound uses a one-sided Hoeffding margin with a correction for the candidates
compared in the cohort. It assumes independently sampled repository groups and
applies only to the frozen protocol and cohort. [Hoeffding, 1963](https://doi.org/10.1080/01621459.1963.10500830)

Automatic calibrated selection requires at least 30 paired stories across eight
repositories, complete cost coverage, an exact eligible model and effort, and a
lower bound at or above the task’s reliability target. The targets are 80% for
fast, 85% for balanced, 90% for frontier and 95% for extreme. A model alias
needs its concrete provider identity before its results can apply.

To enable calibrated selection, save only the evaluator’s `calibration` object
as `routing-calibration.json` in the local MemCode data directory shown in
Settings. MemCode reads that snapshot when planning and when starting a worker.
The snapshot digest detects accidental alteration of the aggregate. The
operator supplies the underlying receipts and vouches for the experiment's
provenance. Missing, malformed or sparse evidence leads to the deterministic
envelope policy.

## Routing a story locally

The router reads the story title, brief and declared scope. It resolves exact
references against that checkout and records which targets came from search.
Work size uses AST measurements and scope. Impact uses the union of the observed
callers, files and flows across up to five anchors. Module counts are available
when the graph returns module identities. Incomplete coverage raises the minimum
tier and missing counts stay unknown. Review the inputs under **Why this model?**
on the story card.

Automatic routing compares the account catalogs of connected, approved workers.
Story overrides take precedence. When a follow-up can resume a verified local
conversation, its provider takes priority unless a story or workspace choice
specifies another provider. The story brief remains the routing input for that
pass.

Memtrace returns the native maintainability index alongside AST complexity.
The lowest verified index for the measured functions is shown in the story's
routing explanation. An edit with a measured index below 10 has a balanced
minimum. This guard does not raise an already higher tier. The native index
includes cyclomatic complexity in its formula. Keep it as an independent input
and use separate evaluation cohorts for these edits. [Maintainability index bands](https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-maintainability-index-range-and-meaning?view=visualstudio)

## Train the optional local wording classifier

Create a local JSON file with `version: 1`, `calibrationRepoIds`,
`heldOutRepoIds`, and `stories`. Each story needs a `repoId`, `storyId`,
`title`, `description`, and a human-labeled `kinds` array made from
`explain`, `research`, `test`, `fix`, `implement`, `refactor`, and `rename`.
Keep complete repositories in separate training, calibration, and held-out
groups. A calibration or held-out repository must have stories in the file.
Separate mixed intentions into multiple labels. Include short briefs, dictation
errors, and constraints with multiple clauses. Keep the labeled source file
private. It contains real story text.

```sh
node --import tsx scripts/routing-language-train.ts path/to/labeled-stories.json path/to/new/routing-language.json
```

Read the held-out report before enabling the profile. To enable it, place the
generated `routing-language.json` in the MemCode data folder shown in Settings.
Planning and worker startup read it on demand and reuse the compiled weights
until the file changes. Move the file out of that folder to go back to the rules.
Rules handle explicit intent and constraints. The classifier helps when the rules
find no action and may abstain. Its intent scores describe wording evidence.
The chance of first-pass acceptance comes from the separate outcome evaluation.
No training snapshots are preinstalled.

The classifier runs inside MemCode's local runtime. It creates no extra model
process and makes no network calls. A profile is bounded to 256 KiB on disk
and at most 448 KiB in packed weights. Maintainability uses an existing Memtrace
response. Measure cold parsing and warm classifier time on the current machine
with the following command. Giving it a profile path benchmarks that snapshot.
Omitting the path runs a synthetic maximum-size profile to measure overhead.

```sh
node --expose-gc --import tsx scripts/routing-language-benchmark.ts
```

## Planning and privacy

Locally authored entity transitions measure creation, deletion, completion and
reopening. Incoming Team synchronization must not count as another locally
authored transition. Workspace snapshots describe the reporting local replica;
summing replicas does not yield globally unique Team stories or projects.

Reporting is optional and off until explicitly enabled. Ordinary local use and
worker execution remain available without reporting. Disabling it discards
pending local records. Example projects and QA traffic stay out of production
aggregates, and historical outcomes are not fabricated or backfilled.

The transport accepts a versioned allowlist of numeric values, enums and opaque
reporting references. It must never receive story/epic/cycle text, prompts,
conversations, code, file paths, branches, commands, raw errors, provider-session
identifiers, artifact content or arbitrary metadata objects. Reporting references
are separate from the original work-item identifiers.

Authenticated reporting is content-free and pseudonymous, not a promise of
anonymity from the service operator. Its write permission has its own token
purpose; engine and Team identity proofs cannot substitute for it. Credentials
remain in the host runtime and must not reach renderers, harnesses or terminals.
