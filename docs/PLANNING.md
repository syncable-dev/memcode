# Planning workflows

Reference: [itsaplan](https://github.com/croffasia/itsaplan/tree/f0dc15e67c8860632bdc078b7deda8f499a5dfe1),
reviewed at commit `f0dc15e67c8860632bdc078b7deda8f499a5dfe1`.
The README and cycle/chart source were inspected to identify useful workflows.
MemCode implements its own domain model and UI; no itsaplan source is incorporated.

| Reference workflow | MemCode implementation |
| --- | --- |
| Kanban, table, timeline, calendar | Four views over the same local tasks; each board lane scrolls independently |
| Saved views and filters | Named views with mode, grouping, sorting and filters |
| Cycles and carryover | Planned/active/completed cycles with a short Focus line, scope, points, capacity and explicit carryover; one cycle can hold work from many goals |
| Custom states and fields | Named lanes bound to execution stages; advisory WIP limits; text, number and choice fields |
| Labels and relationships | Labels, parent/child hierarchy, existing prerequisites, related tasks and duplicate links |
| Bulk organization | Atomic changes and archive/restore, honoring active worker constraints |
| Delivery dashboards | Burndown, burnup, recorded Done transitions, scope/state breakdowns and conditional pace projections |
| Initiative direction | Now/Next/Later roadmap of goals, one branch per goal and the dogfood backlog |

Account management, SSO, team permissions, general document canvases, and broad
import/template systems remain separate product decisions for this local prototype.

## Chart meaning

The inspected reference delivery curve is a burnup. MemCode provides burnup and
the requested burndown, using recorded cycle snapshots. An accessible daily table
exposes chart values. Estimates are manual points, not Memtrace complexity
or time predictions.

On upgrade, existing tasks become a present-day baseline. Earlier chart dates
are unknown. Each transition into Done counts as recorded delivery; reopening and
accepting again produces another transition. The chart is labelled **Done
transitions**, not unique delivered tasks. Future actuals remain unknown.

A baseline is captured when a cycle starts. Closing captures final scope before
moving unfinished tasks. Closing metrics remain frozen even when carried tasks
change later. Developers explicitly retain unfinished work, move it to backlog, or
carry it to an unfinished cycle. Active workers must finish or stop first.

Weekday/calendar ideal lines, cycle time zones and date-only arithmetic are explicit.
Observed-pace projections require seven observed days, three productive days and
five Done transitions. This is an extrapolation, not a calibrated completion promise.

## Code improvement evidence

Code Insights and Improve are Memtrace-specific additions. Measurements identify
their source, branch, graph publication and coverage. Comparisons require compatible
measurement versions, a ready source/index binding and a stable capture. Missing
metrics stay unknown; bounded hotspot samples never substitute for full-repository
totals. Newly recorded checkpoints establish actual improvement history.
