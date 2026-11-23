import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { LoggedUpdate } from "../../runtime/sharing/memsync/boards-api";
import {
  cast,
  refusedBy,
  signedInTo,
  type SharingWorld,
} from "./projects-api-scenarios";

const update = (bytes = 24) => ({
  id: randomUUID(),
  payload: randomBytes(bytes),
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(isTrue: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!isTrue()) {
    if (Date.now() > deadline) assert.fail(`still waiting for ${what}`);
    await pause(10);
  }
}
/** Reads a whole log the way MemCode does: page after page until one is empty. */
async function wholeLog(
  boards: ReturnType<typeof signedInTo>["boards"],
  project: string,
) {
  const all: LoggedUpdate[] = [];
  for (;;) {
    const page = await boards.readAfter(project, all.at(-1)?.sequence ?? 0);
    if (!page.length) return all;
    all.push(...page);
  }
}

/** What MemCode's Boards client must do against any sharing service that follows the contract. */
export function boardsApiScenarios(
  where: string,
  open: () => Promise<SharingWorld>,
  options: { skip?: string | false } = {},
) {
  const scenario = (
    name: string,
    run: (world: SharingWorld) => Promise<void>,
  ) =>
    test(`${where}: ${name}`, { skip: options.skip }, async () => {
      const world = await open();
      try {
        await run(world);
      } finally {
        await world.close();
      }
    });

  scenario(
    "updates are numbered from one, dated, and read back as the bytes that were sent",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex);
      try {
        const project = await alex.website.startProject("Board");
        assert.deepEqual(await alex.boards.readAfter(project, 0), []);
        const sent = [update(), update(1), update(5000)];
        const receipts = await alex.boards.append(project, sent);
        assert.deepEqual(
          receipts.map((receipt) => [receipt.id, receipt.sequence]),
          sent.map((one, at) => [one.id, at + 1]),
        );
        // Updates sent in one call share a time.
        assert.equal(
          new Set(receipts.map((receipt) => receipt.loggedAt)).size,
          1,
        );
        assert.ok(
          Math.abs(Date.parse(receipts[0].loggedAt) - Date.now()) <
            400 * 86400000,
        );
        const read = await alex.boards.readAfter(project, 0);
        assert.deepEqual(
          read.map((logged) => [
            logged.id,
            logged.sequence,
            logged.loggedAt,
            logged.author,
          ]),
          receipts.map((receipt) => [
            receipt.id,
            receipt.sequence,
            receipt.loggedAt,
            people.alex.accountId,
          ]),
        );
        for (const [at, logged] of read.entries())
          assert.deepEqual(
            Buffer.from(logged.payload),
            Buffer.from(sent[at].payload),
          );
        assert.deepEqual(
          (await alex.boards.readAfter(project, 1)).map(
            (logged) => logged.sequence,
          ),
          [2, 3],
        );
        assert.deepEqual(await alex.boards.readAfter(project, 3), []);
      } finally {
        alex.close();
      }
    },
  );

  scenario(
    "an update sent again adds nothing and is told the number it already has",
    async (world) => {
      const alex = signedInTo(world, cast().alex);
      try {
        const project = await alex.website.startProject("Board");
        const first = [update(), update()];
        const before = await alex.boards.append(project, first);
        const again = await alex.boards.append(project, [
          first[1],
          update(),
          first[0],
        ]);
        assert.deepEqual(
          again.map((receipt) => receipt.sequence),
          [2, 3, 1],
        );
        assert.equal(again[2].loggedAt, before[0].loggedAt);
        assert.equal((await wholeLog(alex.boards, project)).length, 3);
      } finally {
        alex.close();
      }
    },
  );

  scenario(
    "a later call is never dated before an earlier one",
    async (world) => {
      const alex = signedInTo(world, cast().alex);
      try {
        const project = await alex.website.startProject("Board");
        const times: string[] = [];
        for (let call = 0; call < 5; call++)
          times.push(
            (await alex.boards.append(project, [update()]))[0].loggedAt,
          );
        assert.deepEqual(times, [...times].sort());
      } finally {
        alex.close();
      }
    },
  );

  scenario(
    "a guest reads and adds like the owner, and anyone else finds no such project",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        bo = signedInTo(world, people.bo),
        dana = signedInTo(world, people.dana);
      try {
        const project = await alex.website.startProject("Board");
        await bo.projects.acceptInvitation(
          project,
          await alex.website.invite(project, people.bo.email!),
        );
        await alex.boards.append(project, [update()]);
        const [fromBo] = await bo.boards.append(project, [update()]);
        assert.equal(fromBo.sequence, 2);
        assert.deepEqual(
          (await alex.boards.readAfter(project, 0)).map(
            (logged) => logged.author,
          ),
          [people.alex.accountId, people.bo.accountId],
        );
        await assert.rejects(
          dana.boards.append(project, [update()]),
          refusedBy("no_such_project"),
        );
        await assert.rejects(
          dana.boards.readAfter(project, 0),
          refusedBy("no_such_project"),
        );
        await assert.rejects(
          dana.boards.watchAfter(project, 0, () => {}).finished,
          refusedBy("no_such_project"),
        );
        await assert.rejects(
          alex.boards.readAfter("not-an-id", 0),
          refusedBy("no_such_project"),
        );
        assert.equal((await wholeLog(alex.boards, project)).length, 2);
      } finally {
        for (const person of [alex, bo, dana]) person.close();
      }
    },
  );

  scenario(
    "what the log will not take is refused by the name of its rule, and what it just takes is taken",
    async (world) => {
      const alex = signedInTo(world, cast().alex);
      try {
        const project = await alex.website.startProject("Board");
        const mebibyte = 1024 * 1024;
        await assert.rejects(
          alex.boards.append(
            project,
            Array.from({ length: 101 }, () => update(1)),
          ),
          refusedBy("too_many_updates"),
        );
        await assert.rejects(
          alex.boards.append(project, [
            { id: randomUUID(), payload: new Uint8Array() },
          ]),
          refusedBy("empty_update"),
        );
        await assert.rejects(
          alex.boards.append(project, [update(mebibyte + 1)]),
          refusedBy("update_too_large"),
        );
        await assert.rejects(
          alex.boards.append(project, [
            { id: "not-a-uuid", payload: randomBytes(4) },
          ]),
          refusedBy("invalid_update_id"),
        );
        // A call that is turned down logs none of its updates.
        await assert.rejects(
          alex.boards.append(project, [
            update(),
            { id: "nope", payload: randomBytes(4) },
          ]),
          refusedBy("invalid_update_id"),
        );
        assert.deepEqual(await alex.boards.readAfter(project, 0), []);
        const hundred = await alex.boards.append(
          project,
          Array.from({ length: 100 }, () => update(8)),
        );
        assert.equal(hundred.at(-1)!.sequence, 100);
        const [largest] = await alex.boards.append(project, [update(mebibyte)]);
        assert.equal(largest.sequence, 101);
        const read = await wholeLog(alex.boards, project);
        assert.equal(read.length, 101);
        assert.equal(read.at(-1)!.payload.length, mebibyte);
      } finally {
        alex.close();
      }
    },
  );

  scenario(
    "a log longer than a page is read whole, page after page, in order",
    async (world) => {
      const alex = signedInTo(world, cast().alex);
      try {
        const project = await alex.website.startProject("Board");
        const sent = Array.from({ length: 230 }, () => update(16));
        for (let from = 0; from < sent.length; from += 100)
          await alex.boards.append(project, sent.slice(from, from + 100));
        const read = await wholeLog(alex.boards, project);
        assert.deepEqual(
          read.map((logged) => logged.id),
          sent.map((one) => one.id),
        );
        assert.deepEqual(
          read.map((logged) => logged.sequence),
          sent.map((_, at) => at + 1),
        );
      } finally {
        alex.close();
      }
    },
  );

  scenario(
    "a watcher is sent what the log holds after a number, then each new update as it is logged",
    async (world) => {
      const people = cast();
      const mac = signedInTo(world, people.alex),
        windows = signedInTo(world, people.alex);
      try {
        const project = await mac.website.startProject("Board");
        const early = [update(), update(), update()];
        await mac.boards.append(project, early);
        const seen: LoggedUpdate[] = [];
        const watching = windows.boards.watchAfter(project, 1, (logged) => {
          seen.push(logged);
        });
        await until(() => seen.length === 2, "what the log already held");
        const late = update(300);
        const [receipt] = await mac.boards.append(project, [late]);
        await until(
          () => seen.length === 3,
          "the update logged while watching",
        );
        assert.deepEqual(
          seen.map((logged) => [logged.id, logged.sequence]),
          [
            [early[1].id, 2],
            [early[2].id, 3],
            [late.id, 4],
          ],
        );
        assert.equal(seen[2].loggedAt, receipt.loggedAt);
        assert.deepEqual(
          Buffer.from(seen[2].payload),
          Buffer.from(late.payload),
        );
        watching.cancel();
        await watching.finished;
        await mac.boards.append(project, [update()]);
        await pause(60);
        assert.equal(seen.length, 3, "nothing arrives after hanging up");
      } finally {
        mac.close();
        windows.close();
      }
    },
  );

  scenario(
    "a guest who is removed stops being sent updates, and is told the project is gone",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        bo = signedInTo(world, people.bo);
      try {
        const project = await alex.website.startProject("Board");
        await bo.projects.acceptInvitation(
          project,
          await alex.website.invite(project, people.bo.email!),
        );
        const seen: number[] = [];
        const watching = bo.boards.watchAfter(project, 0, (logged) => {
          seen.push(logged.sequence);
        });
        // The stream may end at any moment from here on, so its end is awaited from the start.
        const toldItIsGone = assert.rejects(
          watching.finished,
          refusedBy("no_such_project"),
        );
        await alex.boards.append(project, [update()]);
        await until(() => seen.length === 1, "the first update");
        await alex.website.removeGuest(project, people.bo.accountId);
        // MemSync asks who is on the project again when the log grows.
        await alex.boards.append(project, [update()]);
        await toldItIsGone;
        assert.deepEqual(seen, [1]);
      } finally {
        alex.close();
        bo.close();
      }
    },
  );
}
