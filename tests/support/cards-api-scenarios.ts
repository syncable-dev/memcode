import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LoggedCardEntry } from "../../runtime/sharing/memsync/cards-api";
import {
  cast,
  refusedBy,
  signedInTo,
  type SharingWorld,
} from "./projects-api-scenarios";

const entry = (bytes = 24) => ({
  id: randomUUID(),
  payload: randomBytes(bytes),
});
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(isTrue: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!isTrue()) {
    if (Date.now() > deadline) assert.fail(`still waiting for ${what}`);
    await pause(10);
  }
}

/** What MemCode's Cards client must do against any sharing service that follows ADR-0014. */
export function cardsApiScenarios(
  where: string,
  open: () => Promise<SharingWorld>,
  options: { skip?: string | false } = {},
) {
  const scenario = (
    name: string,
    run: (world: SharingWorld) => Promise<void>,
  ) =>
    test(`${where}: ${name}`, { skip: options.skip }, async (context) => {
      const world = await open();
      try {
        if (world.lacks) return context.skip(world.lacks);
        await run(world);
      } finally {
        await world.close();
      }
    });

  scenario(
    "each card has a log of its own, numbered from one, signed by who sent each entry",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        dana = signedInTo(world, people.dana);
      try {
        const project = await alex.website.startProject("Cards");
        await dana.projects.acceptInvitation(
          project,
          await alex.website.invite(project, people.dana.email!),
        );
        const [card, other] = [randomUUID(), randomUUID()];
        const sent = [entry(), entry(3000)];
        const receipts = await alex.cards.append(project, card, sent);
        assert.deepEqual(
          receipts.map((receipt) => receipt.sequence),
          [1, 2],
        );
        assert.deepEqual(
          (await dana.cards.append(project, card, [entry()])).map(
            (receipt) => receipt.sequence,
          ),
          [3],
        );
        assert.deepEqual(await alex.cards.readAfter(project, other, 0), []);
        const read = await dana.cards.readAfter(project, card, 0);
        assert.deepEqual(
          read.map((logged) => [logged.sequence, logged.author]),
          [
            [1, people.alex.accountId],
            [2, people.alex.accountId],
            [3, people.dana.accountId],
          ],
        );
        assert.deepEqual(
          Buffer.from(read[1].payload),
          Buffer.from(sent[1].payload),
        );
        // Sent again, as after a lost answer: nothing is added.
        const again = await alex.cards.append(project, card, [sent[0]]);
        assert.equal(again[0].sequence, 1);
        assert.equal((await alex.cards.readAfter(project, card, 0)).length, 3);
      } finally {
        alex.close();
        dana.close();
      }
    },
  );

  scenario(
    "a watched card hears what is new as it is logged",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex);
      try {
        const project = await alex.website.startProject("Cards");
        const card = randomUUID();
        await alex.cards.append(project, card, [entry()]);
        const heard: LoggedCardEntry[] = [];
        const watching = alex.cards.watchAfter(project, card, 0, (logged) => {
          heard.push(logged);
        });
        const ended = watching.finished.catch(() => {});
        await until(() => heard.length === 1, "the entry already logged");
        await alex.cards.append(project, card, [entry(), entry()]);
        await until(() => heard.length === 3, "the two new entries");
        assert.deepEqual(
          heard.map((logged) => logged.sequence),
          [1, 2, 3],
        );
        watching.cancel();
        await ended;
      } finally {
        alex.close();
      }
    },
  );

  scenario(
    "a file is kept once by its SHA-256, and comes back whole at the largest size allowed",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        dana = signedInTo(world, people.dana);
      try {
        const project = await alex.website.startProject("Cards");
        await dana.projects.acceptInvitation(
          project,
          await alex.website.invite(project, people.dana.email!),
        );
        const content = randomBytes(5 * 1024 * 1024);
        const stored = await alex.cards.upload(project, content);
        assert.equal(stored.sha256, sha(content));
        assert.equal(stored.size, content.length);
        assert.equal(stored.uploadedBy, people.alex.accountId);
        const again = await dana.cards.upload(project, content);
        // Sent again, by anyone: the record of the first upload comes back.
        assert.deepEqual(again, stored);
        const fetched = await dana.cards.download(project, stored.sha256);
        assert.equal(fetched.file.sha256, stored.sha256);
        assert.ok(Buffer.from(fetched.content).equals(content));
      } finally {
        alex.close();
        dana.close();
      }
    },
  );

  scenario(
    "what the service will not take is refused by the name of its rule",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        bo = signedInTo(world, people.bo);
      try {
        const project = await alex.website.startProject("Cards");
        const card = randomUUID();
        await assert.rejects(
          alex.cards.append(project, "not-a-uuid", [entry()]),
          refusedBy("invalid_card_id"),
        );
        await assert.rejects(
          alex.cards.append(project, card, [entry(1024 * 1024 + 1)]),
          refusedBy("update_too_large"),
        );
        await assert.rejects(
          alex.cards.append(
            project,
            card,
            Array.from({ length: 101 }, () => entry()),
          ),
          refusedBy("too_many_updates"),
        );
        await assert.rejects(
          alex.cards.upload(project, randomBytes(5 * 1024 * 1024 + 1)),
          refusedBy("file_too_large"),
        );
        // A hash the project does not keep, and text that is not a hash, are both no file.
        for (const hash of ["0".repeat(64), "A".repeat(64), "not-a-hash"])
          await assert.rejects(
            alex.cards.download(project, hash),
            refusedBy("no_such_file"),
          );
        // An empty file is kept like any other. MemCode never shares one.
        const empty = await alex.cards.upload(project, new Uint8Array());
        assert.equal(empty.size, 0);
        assert.equal(empty.sha256, sha(new Uint8Array()));
        // Someone who is not on the project sees no card of it.
        await assert.rejects(
          bo.cards.readAfter(project, card, 0),
          refusedBy("no_such_project"),
        );
        await assert.rejects(
          bo.cards.upload(project, randomBytes(10)),
          refusedBy("no_such_project"),
        );
      } finally {
        alex.close();
        bo.close();
      }
    },
  );

  scenario("a project keeps at most 50 MiB of files", async (world) => {
    const alex = signedInTo(world, cast().alex);
    try {
      const project = await alex.website.startProject("Cards");
      for (let at = 0; at < 10; at++)
        await alex.cards.upload(project, randomBytes(5 * 1024 * 1024));
      await assert.rejects(
        alex.cards.upload(project, randomBytes(1)),
        refusedBy("project_storage_full"),
      );
    } finally {
      alex.close();
    }
  });
}
