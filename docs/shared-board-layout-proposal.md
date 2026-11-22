# The board as one Yjs document

Status: accepted. Alex approved this layout on 21 November 2026 and asked for board sync
to be built on it. It is built on the branch `feat/memsync-shared-projects`, and
[Shared projects](shared-projects.md) says how it runs. Nothing is deployed.

MemSync keeps a board as a log of Yjs updates and never looks inside one
(its ADR-0004 and ADR-0013). What is inside is MemCode's to define. This page says what
that layout is, how a board that already exists on a computer becomes the first updates,
and what MemCode does with an update it cannot apply.

It was written as a proposal and is kept as the record of what was decided. Where
building it showed the proposal wrong, or where Alex decided otherwise, the text says so
under **As built** or **Corrected**. What is still missing is listed under
[Not built](#not-built).

## What a board holds today

Team Sync already draws the line between what is shared and what stays on a computer, in
`runtime/team/projection.ts` and `runtime/team/history.ts`. The proposal keeps that line.

| On the board | Not on the board |
| --- | --- |
| Goals: identifier, title, description, phase, color, order, branch, base revision | Worker conversations and tool output |
| Cycles: name, goal, dates, time zone, state, capacity, calendar | The worker, model, route and permissions of a task |
| Tasks: identifier, title, description, stage, lane, priority, kind, goal, cycle, parent, estimate, dates, labels, scope, what it depends on, related tasks, runbook, custom fields, archived | Run state, changes, measurements, review runs |
| Comments on tasks, with their replies | Local paths, the checkout, credentials |
| Lanes, custom field definitions and saved views of the project | Insights from code analysis |

Claims, messages to a worker, conversations and published results are not board data.
MemSync's ADR-0005 gives them their own calls, and none of them is in this document.

**Corrected.** The right-hand column was first headed "Stays on the computer", as if that
were the product. It is not. Alex's rule of 21 November 2026: someone on a project who
opens a card sees its conversation, how it was solved, its artifacts and changes and who
did it, as it happens. Only running the worker stays on the computer it runs on. None of
that belongs in the board document, and MemSync does not carry it yet: its ADR-0005, a log
for each conversation and calls for claims and messages, is accepted and not built. Until
it is, a card that arrives on another computer has its brief, its runbook and its
comments, and not its conversation, artifacts or changes.

## The document

One Yjs document per shared project. Every collection is a map at the top of the document,
named once and never created at run time. An entry is a map of fields under the id of the
thing it describes.

```
goals      id → { identifier, title, description, phase, color, order, branch, baseRevision, baseBranch, closed, deleted }
cycles     id → { name, goal, startDate, endDate, timeZone, state, capacity, calendar, deleted }
tasks      id → { identifier, title, description, stage, lane, priority, kind, goal, cycle, parent,
                  estimate, startDate, dueDate, duplicateOf, category, archived, deleted,
                  label:<text>, scope:<path>, depends:<task id>, related:<task id>,
                  field:<field id>, step:<step id> }
comments   id → { task, parent, text, reference, deleted }
lanes      id → { name, stage, color, order, wipLimit, deleted }
fields     id → { name, type, options, deleted }
views      id → { name, mode, groupBy, sortBy, filters, deleted }
meta       { layout: 1 }
```

`description` on a goal and on a task is a Yjs text. Every other value is plain: text, a
number, true or false, nothing, or a small object that is always replaced as a whole.

### Why it is shaped this way

- **Collections at the top, entries by id.** Two computers that add different tasks never
  touch the same key, and two that edit different fields of one task both keep their edit.
  Two that set the same field at the same moment end with one of the two values, the same
  one everywhere.
- **An entry is made once.** When two computers each put a new map under the same id, one
  whole map replaces the other and edits to the loser are gone. Measured with Yjs 13.6.33:
  an entry made as "from A" and then edited on A read "from B" on both computers after
  they met. So MemCode writes fields into an entry that is already there and makes a new
  entry only for an id the document has never held.
- **A set is one key per member.** `label:urgent`, `depends:<task id>` and `step:<step id>`
  are keys of the task's own entry. Adding a label on one computer and another label on a
  second keeps both, where a list stored as one value would keep one computer's list.
  A step of the runbook holds `{ text, done, order }`, so a worker ticking one step and a
  person rewording another do not undo each other.
- **Descriptions merge.** A description is long and two people do edit one at once. As a
  Yjs text, MemCode writes the difference between the old and the new wording, and edits
  in different places both stay. Titles and comment texts are replaced whole.
- **Stage and lane are written together.** A task has both today. Each move writes both
  in one step. Two computers moving the same task at once then end with one computer's
  pair, never a stage from one and a lane from the other: 200 rounds, no mixed pair.
- **Deleting marks, it does not remove.** `deleted: true` hides the entry. Removing the
  key would throw away an edit made at the same moment on another computer, and would
  leave nothing to restore. A marked entry is small and stays in the document.

### Order

- **Tasks have no order of their own.** A column is sorted by the view: priority, updated,
  created, due or estimate. Nothing is stored. If cards are ever ordered by hand, a task
  gets a `rank` field then, and the layout number stays 1.
- **Goals keep the `order` number they are given when they are made.** They cannot be
  reordered today.
- **Lanes keep `order` as their position.** Reordering lanes writes the position of every
  lane in one step, as it does today. Two computers reordering at once end with one
  computer's order, whole. Two lanes with the same number are shown by id, so every
  computer shows the same order.

### Ids

Ids in the document are the ids the first computer already uses for its goals, cycles,
tasks and comments. They are UUIDs, so a second computer takes them as its own.

Lane ids are the exception: today they begin with the local project's id
(`<project id>:backlog`). In the document they are written without it (`backlog`,
`planned`), and each computer puts its own project id back in front. Team Sync does the
same translation today.

### Identifiers such as MC-014

Two computers that are offline can both create MC-014. Nobody numbers tasks for them,
because MemSync does not read the board.

The rule: the log decides. Every computer applies the log in the same order, so every
computer sees the same task arrive first with a given identifier. A task that arrives with
an identifier already taken gets the number after the highest one in use, and that new
identifier is written to the document as an ordinary change. Every computer works
out the same number from the same log, so it does not matter which of them writes it.

Existing identifiers never change when a board is first shared.

**As built.** A task arrives with the log entry that made it, and MemCode keeps that
number for every task. A task that is not in the log yet gives way to one that is. Two
that arrived in the same entry are told apart by id. The rule is in
`runtime/sharing/board/identifiers.ts`.

### Who and when

A Yjs update carries no time and no author that can be trusted. MemSync stamps both on
every update: `logged_at` and `author_account_id`.

- A task, goal, cycle or comment was **created** when the update that first held it was
  logged, and **changed** when the last update that touched it was logged.
- A comment's **author** is the account that logged its first update. A change to a
  comment logged by anyone else is not shown.
- The **delivery history** (when a task changed stage, cycle or estimate, which is what
  burn-down is drawn from) is read off the same way, update by update, so every computer
  draws the same chart. Cycle baselines and snapshots are worked out, not stored.
- A change that has not reached the log yet is shown with the computer's own clock until
  its receipt arrives.

Nothing in the document says who wrote it or when.

**As built.** What arrives from the log is dated and signed this way: when a task, cycle
or comment was made and last changed, and who wrote a comment. Three parts of this
section are not built. A change made on this computer keeps this computer's clock, also
after the log has dated it. A change to someone else's comment is shown like any other.
The delivery history is still each computer's own.

### Not trusting what is read

Anyone on the project can add an update, and an update can hold anything. MemCode checks
each value as it reads it, with the limits Team Sync has today (a title of at most 240
characters, a text of at most 20,000, and so on). A value that does not pass is left out
and the last good value stays on screen. A field MemCode does not know is kept and
ignored, which is how a newer MemCode can add one.

`meta.layout` is 1. A MemCode that finds a higher number shows the board without writing
to it and asks to be updated.

## On each computer

The board the app shows stays what it is today: the workspace file. Beside it, for each
connected project, MemCode keeps:

- the document as the log has built it so far,
- the number of the last log entry it has dealt with,
- its own changes that are not in the log yet, each with the id it will be sent under,
- the log entries it could not apply.

**As built.** These are two files in a folder of their own under `shared-boards/` in the
profile: `log.bin` is the document, `sync.json` is the rest, with the board as this
computer last wrote or took it. Changes made here are found by comparing the workspace
with that board. A change that comes from the log is saved together with the workspace
file. The save is written beside what is there, then the workspace file is written, then
the save is put in place. Both carry the same counter, so after a crash MemCode can tell
whether the workspace got there, and finishes the save or drops it.

A local change becomes a Yjs update against the document and joins the unsent changes.
An update from the log is applied to the document and then copied into the workspace
file, field by field. Workers, conversations and everything else in the right-hand column
of the first table never pass through the document.

Reading follows MemSync's runtime view: `ReadUpdates` in pages until a page is empty, then
`WatchUpdates` from the last number, and again from that number when the stream ends.

## A board that already exists

The first computer to connect a board with content to a shared project whose log is empty
writes the board into the log.

1. Read the log. If it is not empty, see "Two boards meet" below.
2. Build the updates: `meta` first, then lanes, fields and views, then cycles, goals, tasks
   and comments. One entry is one update.
3. Write every update to disk with a new id before sending any.
4. Send them in calls of at most 100 updates and at most 3 MiB together, in order.
   MemSync takes 4 MiB a call unless it is set up otherwise.
5. A call whose answer is lost is sent again as it was. MemSync adds nothing twice,
   because the ids are the same.

Step 3 is what makes this safe to interrupt. If the updates were built again after a crash
they would be different bytes with different ids, and every entry would be made twice.

Measured with Yjs 13.6.33: a task with a 600-character description is an update of 953
bytes, and one with the longest description allowed today, 20,000 characters, is 20,366
bytes. A board of 2,000 tasks is 2,000 updates and 1.95 MB, which is 20 calls.

No update comes near 1 MiB unless one value is that large by itself. MemCode splits a
change that would exceed 1 MiB into several updates: the entry first, then a long text in
pieces. A single value over 1 MiB cannot be split. MemCode refuses to save it, with the
sentence for `update_too_large`.

**As built.** A change is written in pieces of about 256 KiB. An entry stays whole when
it fits in one, and an entry that is larger goes key by key. A single value of about
1 MiB or more is not written to the board. It stays on the computer it was typed on, and
the Sharing view says so. MemCode does not refuse to save it.

### Two boards meet

The second computer finds a log that already has a board. If its own local project is
empty, it takes the board from the log. That is the case of a second computer.

If both have content, the proposal is to keep everything: the entries of the local board
are added to the log as new entries. Ids cannot collide, and identifiers that do are
renumbered by the rule above. Nothing is lost and nothing is merged by guesswork. The
person is told how many tasks will be added before it happens.

**Corrected: nothing is merged.** Alex decided otherwise on 21 November 2026: "you either
share your own project, or you join someone else's and get their board. Nothing is ever
merged. That is as simple as that." So:

- Sharing your own project puts your board into a shared project whose log has no work
  in it.
- Joining, whether someone else's project or your own from another computer, gives you
  the board that is in the log. The joining computer adds nothing of its own, not a lane
  and not a custom field.
- A project that already has work is never merged into a board that already exists.
  Connecting answers with one sentence, and the project is not connected: "app already
  has work of its own, so it cannot join Website: connect a project that has none yet."

A first version of the code did keep both, behind a question. It was taken out again.

The same board on two computers of one person, with the same ids, is not two boards: the
second computer finds its ids in the document and adds only what is missing.

Two computers that both find the log empty at the same moment will both write. MemSync
has no way to say "add this only if the log is still empty". For one board on two
computers that means entries made twice under the same id, which is the case measured
above where one whole entry wins. It needs both computers to connect for the first time
within the same seconds. A small addition to MemSync would close it; see below.

## An update that cannot be applied

MemSync cannot tell a damaged update from a good one, so every computer may be handed one.
The rule is MemSync's: skip it and say so, never stop syncing.

What the Yjs library does, measured with version 13.6.33 on a small document:

| What was done to a real update | Tries | Refused | Applied as if real | Left waiting |
| --- | --- | --- | --- | --- |
| Cut short at every length | 677 | 677 | 0 | 0 |
| One byte inverted, at every position | 677 | 677 | 0 | 0 |
| One bit flipped, at every position | 5,416 | 1,007 | 4,051 | 358 |
| Random bytes | 5,000 | 5,000 | 0 | 0 |
| Counts that promise far more than the bytes hold | 4 | 4 | 0 | 0 |

No try took longer than 40 milliseconds, and none grew the memory in use.

Three things follow.

**A refused update can still change the document.** In 48 of the tries above, applying
threw an error and the document was no longer what it had been. Applying is not all or
nothing. In all 48, reading the update without applying it (`decodeUpdate`) had already
failed. So:

1. An update larger than 1 MiB, or one that `decodeUpdate` refuses, is never applied.
2. An update is applied to the document inside a guard. If applying throws anyway, the
   document in memory is dropped and loaded again from disk as it was after the last entry
   that applied.
3. Either way the entry is written down as not applied (its number, id, author and time)
   and the next entry is read. The number of the last entry dealt with moves on.

**As built: reading first is not enough.** The proposal said that reading an update had
refused every update that went on to fail. A second measurement, kept as a test, found
otherwise. Of 2,241 damaged copies of two small updates, 839 made `applyUpdate` throw,
and 7 of those had read fine with `decodeUpdate`. So the guard in rule 2 is used, not just
kept in reserve. MemCode then goes back to the documents it last saved, reads the log
again from there and leaves that entry out.

**Damage that still reads as an update cannot be seen.** Three quarters of the single
flipped bits gave an update that applied: a changed letter, a changed number. MemCode
cannot know. What it can do is give every update an id made from its bytes (a UUID built
from their SHA-256). A reader that finds bytes which do not match their id knows the
update changed after it was written, and treats it as not applied. This catches damage in
storage and on the way. It does not catch a MemCode that writes nonsense on purpose, and
nothing in a board without a server that reads it can.

**An update can wait for one that never comes.** Yjs applies an update that builds on
something missing by setting it aside. In the measurement, two changes to a task applied
without the update that created it left the task invisible and the document waiting. That
is what happens to everything a person wrote after a damaged update of theirs, on every
other computer.

The repair is that whoever has more than the log sends it. After catching up, each
computer compares its own document with the one the log builds and sends the difference
as a new update. In the measurement the author's difference was 350 bytes, and the two
waiting changes took effect on arrival. As long as one computer still holds what a damaged
update carried, the board heals. If none does, the waiting updates stay set aside and are
listed with the updates that could not be applied.

**As built: what waits, and who repairs.** Two things are narrower than the paragraphs
above say.

What waits is wider than one task. Yjs takes the changes of one writer in order, and a
writer is one run of MemCode on one computer. After a left-out update, everything that
run wrote later is set aside on the computers that left it out, whatever it touches.
MemCode started again is a new writer, and what it writes from then on arrives, unless it
changes something the lost update made.

The repair is done by one computer only: the one that wrote the update. It sees its own
update come back from the log damaged, and sends what the log lacks as a new update. The
same bytes can be sent under up to eight ids, so the repair is never mistaken for the
entry it repairs. A computer that alone could not read an update, because of a fault on
its own side or because it runs a MemCode that reads updates differently, is not
repaired by anyone: nobody else knows. It shows the line about changes left out, and
"Some changes are set aside until one they build on arrives". Damage that appears in the
log after the author has read the update back is in the same place.

What the person sees: a line in the Sharing view such as "2 changes from Dana Ek on
21 November could not be read and were left out", with nothing else interrupted.

Two computers with different versions of MemCode could disagree about one update. The one
that left it out will set later changes aside. The proposal said the same repair covers
it. It does not, for the reason above. Updating MemCode on that computer and connecting
the project again does.

## What this added to MemCode

- The `yjs` package, 13.6.33 (MIT, three packages with what it needs). It is the first
  package added for sharing, and it is in the lock file and the third-party notices.
  MemSync's tests use `yrs`, which reads and writes the same v1 updates.
- Two more calls of the kind MemCode already made, and one that stays open
  (`WatchUpdates`). The gRPC client learned to read a reply that has many parts.
- The measurements on this page as tests, in `tests/sharing-board-updates.test.ts` and
  `tests/sharing-board-document.test.ts`.

## Not built

- **The next step: a card's conversation for everyone on the project.** How it was
  solved, its artifacts, its changes and who did it. Only running the worker stays on
  the computer it runs on. MemSync does not carry these yet. Its ADR-0005 plans them
  as a log for each card, and it is not built.
- **A change to someone else's comment is shown.** MemCode itself lets only the author
  change a comment. Nothing stops a changed MemCode from writing one, and other computers
  would show it.
- **The delivery history is not read off the log.** Burn-down and cycle snapshots stay
  each computer's own, drawn from what that computer saw and when.
- **A change made on this computer keeps this computer's clock.** Other computers date it
  by the log. Sorting by "updated" can differ by seconds between computers.
- **Nobody repairs a computer that alone could not read an update.** See above.
- **A value of about 1 MiB or more is not shared.** No field in MemCode accepts one today.
- **A snapshot.** A new computer reads the whole log.
- **Two computers that both find the log empty in the same second both write the board.**
  It needs the same board, with the same ids, on both. MemSync has no "only if the log is
  still empty".

## What would help from MemSync

None of this blocks a first version.

- **Add only if the log is at a number.** One optional field on `AppendUpdates` closes the
  case of two computers writing a first board at once.
- **A snapshot.** The log only grows and a new computer reads all of it. At 2,000 tasks
  that is 2 MB. MemSync's own notes already list this.
- **A reader for the delivery history** that is safe on bytes from outside, and that reads
  this layout. Until then MemCode works the history out itself, as described above.

## Decisions

Alex was asked on 21 November 2026 whether he approved the layout on this page so that
board sync could be built on it, and answered "Yes, build it". The ten points below were
put to him as one question and were not gone through one by one. Point 3 he decided the
other way the same evening.

1. **Is this the layout?** Collections at the top, an entry per id, one key per member of
   a set, descriptions as Yjs text, everything else replaced whole.
2. **Deleting on a shared board marks the entry and keeps it.** Today a deleted task is
   gone. The alternative is to remove it, which loses a simultaneous edit and cannot be
   undone.
3. **When two boards with content meet, keep everything from both.** The alternatives
   were to refuse and make the person choose one, or to let the shared board replace the
   local one. **Decided otherwise:** nothing is merged, and the project is not connected.
   See "Two boards meet".
4. **Anyone on a project can change anything on its board**, guests included, except
   another person's comment. MemSync lets everyone on a project add updates, so a stricter
   rule would live in MemCode alone and could be worked around.
5. **A second MC-014 is renumbered by log order.** The alternative is a prefix per person.
6. **Saved views, lanes and custom fields are shared**, as Team Sync shares them. Views
   could be each person's own instead.
7. **The runbook is shared**, as it is in Team Sync, so the other computer sees a worker
   tick its steps.
8. **Update ids are made from the bytes.** MemSync only asks for a UUID, so this needs no
   change there.
9. **Add `yjs` to MemCode.**
10. **A project in Team Sync is not carried over by this.** Moving the two boards that
    exist on the relay is a step of its own.

## Looked at and left out

- **One list per collection instead of a map by id.** Order would be free, but Yjs has no
  move: moving an entry is removing and adding it, and two computers moving the same one
  leave it there twice.
- **Everything as one value per task.** Simple, and any two edits to the same task at once
  would lose one.
- **Every set as a nested Yjs map.** It merges like one key per member, at the price of
  several nested types per task. Each nested type is something two computers can make at
  the same moment, with one replacing the other.
- **A collection per task at the top of the document**, so that nothing nested is ever
  made at run time. It removes the "made once" rule and leaves thousands of names at the
  top that can never be removed. The rule is simpler than that.
- **Checking an update on a server before logging it.** MemSync decided against reading
  updates, because the Rust library it would use is not safe on bytes from outside.
