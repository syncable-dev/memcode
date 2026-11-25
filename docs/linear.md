# Linear

A project can be kept in step with a Linear team. Issues are tasks, and edits go both ways.
Workers, code and conversations stay in MemCode, and nothing in Linear starts a worker.

## Connect

Open the project, then **Settings › Integrations › Linear**.

- **Connect Linear** opens the browser. Choose **Authorize** there. MemCode asks Linear for
  read and write, as you, and waits for the answer on this computer
  (`http://localhost:47215`, `47216` or `47217`). There is no client secret.
- **Use an API key instead** takes a personal API key from Linear › Settings › Security &
  access, with Read and Write.

The sign-in is kept in the operating system's credential store under
`dev.memcode.integrations`, per profile and connection. It is never written to the workspace,
the shared board, a log or the window.

MemCode talks to Linear from this computer. There is no server in between, so while MemCode
is closed nothing goes back and forth. The next start catches up.

**Disconnect** forgets the sign-in here and ends it at Linear, the renewal and the access both.
When Linear cannot be reached it says so, and MemCode can be removed there in Settings ›
Security & access. An API key is ended where it was made.

MemCode is registered in Linear as an application without a secret (`LINEAR_CLIENT_ID` in
`runtime/trackers/linear/auth.ts`, or `MEMCODE_LINEAR_CLIENT_ID` for another one). It is **Public**
there, so that people in any workspace can sign in, with webhooks and client credentials off:
MemCode uses neither. A build without an application offers the API key only.

## Bring issues in

Choose a team, what to bring (open work, the current cycle, everything) and what becomes a
goal. Everything is filled in already, and nothing changes until **Import**. Running it again
adds nothing twice. It can be taken back for seven days: cards that were brought in and nobody
here touched go, and Linear is not told. They come back only when someone brings work in again.

| In Linear | Here |
| --- | --- |
| Issue | Task, with the issue's key on the card |
| Milestone, or a project without any | Goal |
| Parent issue | Parent task, or a goal when chosen |
| Cycle | Cycle, started and ended by Linear |
| Status | Lane, by what the status means |
| Priority, estimate, labels, due date, assignee | The same |
| Comment, reply | Comment, marked "from Linear" |
| Pull request link | Written by MemCode when a goal's pull request opens |

## In step

Linear is asked what changed every 30 seconds, and a change here is sent about two seconds
after it is made. Goals, cycles, people and labels are read every two minutes, and when a
person asks for a look. That is some 420 calls and 200,000 points an hour, of the 2,500 calls
and 3,000,000 points Linear allows an API key; a sign-in was allowed 10,000 and 4,000,000 when
it was measured. What is compared is each field, not the whole issue:

- Changed on one side: the other follows.
- Changed on both: the newest stays. The other value is kept on the card, with **Put it back**.
- Refused by Linear: the card says why, and it is asked again when it changes or on **Try
  again**. One refused value does not hold back the others, and a new task is an issue without
  it.

Linear hears a worker's steps, not the lane a card stands in: started is In Progress,
finished is In Review, merged is Done. Other statuses can be chosen. Several statuses in one
lane stay what they were until someone moves the card.

Linear itself changes some of what it hears, and the card follows: it writes Markdown its own
way, takes away a due date when a deadline rule applies, and puts a started issue in the
current cycle and on the person who started it.

While a worker runs, a change that would move its card waits; a cycle does not move it. Work
that has not shipped is never moved, canceled or taken away by Linear: the card says what Linear wanted. An issue
canceled there while its worker runs stays canceled there when the worker ends. Shipping the
work, moving the card or canceling it here settles it.

A new task here becomes an issue unless **Keep in MemCode** is ticked where it is made.
**Cancel task and its issue** cancels both. **Archive** hides the card here only. A card deleted here leaves its
issue alone and is not brought in again.

Linear says nothing when an issue is deleted, put back or moved to another team, or when a
comment is deleted: none of them changes when it was last updated. A deleted issue is seen at
the next look. The rest is asked about by name every two minutes, and what is missing counts
as gone the second time, since an answer can be short.

## Shared projects

On a project shared through MemSync one MemCode keeps it in step, and the shared board says
which. Everyone's edits reach Linear through it, as the person who connected. Another person
who has connected can choose **Do it from here**; the first one hears so and stops.

Two MemCodes must not both write what Linear said into the same board: the board merges text
edits, so the same edit made twice would be there twice.

## Not built

- Ending a Linear cycle from MemCode: Linear ends them by date.
- Making a Linear project or milestone out of a new goal.
- Webhooks. They need a server that Linear can reach.
- Attachments: files on an issue stay in Linear, as links in its description.

## Where it is

| | |
| --- | --- |
| `runtime/trackers/linear/operations.ts` | Every GraphQL operation |
| `api.ts`, `auth.ts` | Calls, limits, sign-in and renewal |
| `read.ts` | What comes from the network is only taken for what it can be |
| `fields.ts`, `merge.ts` | What each field is on both sides, and the three-way merge |
| `memory.ts` | What both sides held when they last agreed (`trackers/` in the profile) |
| `service.ts` | Import, looking, sending, comments, pull requests, who keeps it |
| `tests/linear-*.test.ts` | Against a stand-in Linear (`tests/support/fake-linear.ts`) |

`LINEAR_RUNS=2500 LINEAR_STEPS=220 node --import tsx --test tests/linear-converges.test.ts`
runs random edits on both sides with lost answers, an offline network and restarts, and checks
that both end up the same with the newest of everything.
