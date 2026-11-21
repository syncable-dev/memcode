import test from "node:test";
import assert from "node:assert/strict";
import {
  agree,
  computer,
  giveWork,
  task,
  until,
  type Computer,
} from "./board-computers";
import { cast, signedInTo, type SharingWorld } from "./projects-api-scenarios";

const find = (on: Computer, id: string) =>
  on.state.tasks.find((one) => one.id === id)!;

/** What board sync must do against any sharing service that follows the contract. */
export function boardSyncScenarios(
  where: string,
  open: () => Promise<SharingWorld>,
  options: { skip?: string | false } = {},
) {
  const scenario = (
    name: string,
    run: (
      world: SharingWorld,
      later: (close: () => unknown) => void,
    ) => Promise<void>,
  ) =>
    test(`${where}: ${name}`, { skip: options.skip }, async () => {
      const world = await open();
      const closing: Array<() => unknown> = [];
      try {
        await run(world, (close) => closing.push(close));
      } finally {
        for (const close of closing.reverse()) await close();
        await world.close();
      }
    });

  /** The same person on a Mac that has a board and a PC that has none, both connected. */
  async function twoComputers(
    world: SharingWorld,
    later: (close: () => unknown) => void,
  ) {
    const people = cast();
    const website = signedInTo(world, people.alex);
    later(() => website.close());
    const shared = await website.website.startProject("Website");
    const mac = await computer(world, people.alex, "mac");
    later(() => mac.close());
    const pc = await computer(world, people.alex, "pc");
    later(() => pc.close());
    giveWork(mac.state, mac.projectId);
    await mac.save();
    return { people, shared, mac, pc, website };
  }

  scenario(
    "a board that exists on one computer is written out, and the person's second computer takes it",
    async (world, later) => {
      const { people, shared, mac, pc, website } = await twoComputers(
        world,
        later,
      );
      const before = structuredClone(mac.board());
      mac.connect(shared);
      await mac.synced();
      // Writing the board out changes nothing on the computer it came from.
      assert.deepEqual(mac.board(), before);
      assert.equal(mac.status().waiting, 0);

      pc.connect(shared);
      await agree(mac, pc);
      assert.deepEqual(pc.board(), before);

      // What stays on a computer never left the Mac.
      const taken = find(pc, "task-1");
      assert.equal(taken.projectId, pc.projectId);
      assert.equal(taken.statusId, "pc-project:working");
      assert.equal(taken.run.state, "idle");
      assert.equal(taken.run.workspace, undefined);
      assert.doesNotMatch(JSON.stringify(pc.state), /PRIVATE|\/private\//);
      // The brief a worker on the PC would start from.
      assert.equal(taken.messages[0].text, "Line one.\nLine two.");

      // Who and when come from the log, not from the Mac's own clock or name.
      const logged = await website.boards.readAfter(shared, 0);
      const times = logged.map((update) => update.loggedAt);
      assert.ok(times.includes(taken.createdAt), taken.createdAt);
      const [comment] = pc.state.storyComments!;
      assert.deepEqual(comment.author, {
        id: people.alex.accountId,
        name: people.alex.name,
        source: "memtrace",
      });
      assert.ok(times.includes(comment.createdAt));

      // The PC's workspace file holds the board, and the PC sent nothing of its own.
      assert.deepEqual(
        pc
          .file()
          .tasks.filter((one) => one.projectId === pc.projectId)
          .map((one) => one.id)
          .sort(),
        ["task-1", "task-2"],
      );
      assert.deepEqual(pc.appends, []);
      assert.equal(new Set(logged.map((update) => update.author)).size, 1);
    },
  );

  scenario(
    "a change on either computer shows on the other, and changes to different parts of one task both stay",
    async (world, later) => {
      const { shared, mac, pc } = await twoComputers(world, later);
      mac.connect(shared);
      pc.connect(shared);
      await agree(mac, pc);

      await pc.edit((state) => {
        const one = state.tasks.find((each) => each.id === "task-1")!;
        one.stage = "review";
        one.statusId = "pc-project:review";
        one.checklist[1].done = true;
      });
      await until(
        () => find(mac, "task-1").stage === "review",
        "the Mac to see the move made on the PC",
      );
      assert.equal(find(mac, "task-1").statusId, "mac-project:review");
      assert.equal(find(mac, "task-1").checklist[1].done, true);
      // The Mac's own parts of the task were not touched.
      assert.equal(find(mac, "task-1").messages[0].text, "PRIVATE TOOL OUTPUT");
      assert.equal(find(mac, "task-1").run.workspace, "/private/checkout");

      // Both change the same task at the same moment, in different places.
      await Promise.all([
        mac.edit((state) => {
          const one = state.tasks.find((each) => each.id === "task-1")!;
          one.title = "Export as CSV, with a header row";
          one.description = "Line zero.\nLine one.\nLine two.";
          one.labels = ["urgent", "export"];
        }),
        pc.edit((state) => {
          const one = state.tasks.find((each) => each.id === "task-1")!;
          one.priority = "low";
          one.description = "Line one.\nLine two.\nLine three.";
          one.labels = ["urgent", "customer"];
        }),
      ]);
      await agree(mac, pc);
      const merged = find(pc, "task-1");
      assert.equal(merged.title, "Export as CSV, with a header row");
      assert.equal(merged.priority, "low");
      assert.equal(
        merged.description,
        "Line zero.\nLine one.\nLine two.\nLine three.",
      );
      assert.deepEqual([...merged.labels!].sort(), [
        "customer",
        "export",
        "urgent",
      ]);

      // A new task, a comment and a deletion travel too.
      await pc.edit((state) => {
        state.tasks.push(
          task(pc.projectId, "task-3", { title: "Made on the PC" }),
        );
        state.storyComments!.push({
          id: "comment-2",
          taskId: "task-3",
          text: "Started here, to be continued on the Mac.",
          author: { id: "local-owner", name: "You", source: "local" },
          createdAt: "2026-11-21T13:00:00.000Z",
          updatedAt: "2026-11-21T13:00:00.000Z",
        });
        state.tasks = state.tasks.filter((each) => each.id !== "task-2");
      });
      await agree(mac, pc);
      assert.equal(find(mac, "task-3").title, "Made on the PC");
      assert.equal(find(mac, "task-2"), undefined);
      assert.equal(
        mac.state.storyComments!.find((each) => each.id === "comment-2")?.text,
        "Started here, to be continued on the Mac.",
      );
    },
  );

  scenario(
    "changes made while the service cannot be reached wait, survive a restart, and are sent when it is back",
    async (world, later) => {
      const { shared, mac, pc } = await twoComputers(world, later);
      mac.connect(shared);
      pc.connect(shared);
      await agree(mac, pc);

      pc.goOffline();
      await until(() => pc.status().state === "offline", "the PC to notice");
      await pc.edit((state) => {
        find(pc, "task-2").title = "Export as PDF, landscape";
        state.tasks.push(
          task(pc.projectId, "task-7", { title: "Made offline" }),
        );
      });
      assert.equal(pc.status().state, "offline");
      assert.ok(pc.status().waiting > 0);
      assert.match(pc.status().detail ?? "", /cannot be reached/);

      // Meanwhile the Mac goes on.
      await mac.edit(() => void (find(mac, "task-1").priority = "low"));
      await mac.synced();

      // MemCode on the PC is quit and started again, still offline.
      await pc.quit();
      pc.reopen();
      await until(() => pc.status().state === "offline", "the PC, restarted");
      assert.ok(pc.status().waiting > 0);
      assert.equal(find(pc, "task-7").title, "Made offline");

      pc.comeBack();
      await agree(mac, pc);
      assert.equal(find(mac, "task-2").title, "Export as PDF, landscape");
      assert.equal(find(mac, "task-7").title, "Made offline");
      assert.equal(find(pc, "task-1").priority, "low");
      assert.equal(pc.status().waiting, 0);
    },
  );

  scenario(
    "a computer that is started again goes on from where it stopped, and sends nothing twice",
    async (world, later) => {
      const { shared, mac, pc, website } = await twoComputers(world, later);
      mac.connect(shared);
      pc.connect(shared);
      await agree(mac, pc);
      const logged = (await website.boards.readAfter(shared, 0)).length;
      assert.ok(logged > 0);

      await pc.quit();
      await mac.edit(
        () => void (find(mac, "task-2").title = "Changed meanwhile"),
      );
      await mac.synced();
      pc.reads.length = 0;
      pc.appends.length = 0;
      pc.reopen();
      await agree(mac, pc);
      assert.equal(find(pc, "task-2").title, "Changed meanwhile");
      // It asked for what came after the last entry it had dealt with, not for the whole log.
      assert.equal(pc.reads[0], logged);
      assert.deepEqual(pc.appends, []);
      assert.equal(
        (await website.boards.readAfter(shared, 0)).length,
        logged + 1,
      );
    },
  );

  scenario(
    "changes made while board sync was not running are found and sent at the next start",
    async (world, later) => {
      const { shared, mac, pc } = await twoComputers(world, later);
      mac.connect(shared);
      pc.connect(shared);
      await agree(mac, pc);

      // Signed out on the PC, say: MemCode runs, sync does not.
      await pc.quit();
      await pc.editUnseen((state) => {
        find(pc, "task-1").estimate = 8;
        state.tasks.push(task(pc.projectId, "task-9", { title: "While away" }));
      });
      pc.reopen();
      // Nothing prompts it: starting is enough for the PC to find what changed.
      await until(
        () => find(mac, "task-9")?.title === "While away",
        "the Mac to get what was made while the PC was not syncing",
      );
      await mac.edit(
        () => void (find(mac, "task-1").title = "Renamed on the Mac"),
      );
      await agree(mac, pc);
      assert.equal(find(mac, "task-1").estimate, 8);
      assert.equal(find(pc, "task-1").title, "Renamed on the Mac");
    },
  );

  scenario(
    "two boards that both have work are left as they are until the person says to keep both",
    async (world, later) => {
      const people = cast();
      const alex = signedInTo(world, people.alex);
      later(() => alex.close());
      const dana = signedInTo(world, people.dana);
      later(() => dana.close());
      const shared = await alex.website.startProject("Website");
      const invitation = await alex.website.invite(shared, people.dana.email!);
      await dana.projects.acceptInvitation(shared, invitation);
      const everyone = [people.alex, people.dana];

      const mac = await computer(world, people.alex, "mac", {
        people: everyone,
      });
      later(() => mac.close());
      giveWork(mac.state, mac.projectId);
      await mac.save();
      mac.connect(shared);
      await mac.synced();

      const laptop = await computer(world, people.dana, "laptop", {
        people: everyone,
      });
      later(() => laptop.close());
      laptop.state.tasks.push(
        task(laptop.projectId, "dana-1", {
          identifier: "MC-001",
          title: "Dana's own task",
        }),
        task(laptop.projectId, "dana-2", { title: "Dana's second" }),
      );
      await laptop.save();
      const mine = structuredClone(laptop.board());
      laptop.connect(shared);
      await until(
        () => laptop.status().state === "choose",
        "the question whether to keep both",
      );
      assert.deepEqual(laptop.status().choice, { shared: 2, added: 2 });
      // Nothing was added to either board, and nothing was sent.
      assert.deepEqual(laptop.board(), mine);
      assert.deepEqual(laptop.appends, []);

      // The question is still there after a restart.
      await laptop.quit();
      laptop.reopen();
      await until(
        () => laptop.status().state === "choose",
        "the question again",
      );
      assert.deepEqual(laptop.board(), mine);

      await laptop.sync.keepBoth();
      await agree(mac, laptop);
      assert.deepEqual(
        mac.state.tasks
          .filter((one) => one.projectId === mac.projectId)
          .map((one) => one.id)
          .sort(),
        ["dana-1", "dana-2", "task-1", "task-2"],
      );
      assert.equal(find(laptop, "task-1").title, "Export as CSV");
      // Both boards began at MC-001. The shared board's tasks keep their numbers,
      // and the ones that were added take the next ones, the same on both computers.
      for (const on of [mac, laptop])
        assert.deepEqual(
          Object.fromEntries(
            on.state.tasks
              .filter((one) => one.projectId === on.projectId)
              .map((one) => [one.id, one.identifier]),
          ),
          {
            "task-1": "MC-001",
            "task-2": "MC-002",
            "dana-1": "MC-003",
            "dana-2": "MC-004",
          },
        );
      // A comment made on the Mac is by the person who is signed in there.
      assert.equal(
        laptop.state.storyComments![0].author.name,
        people.alex.name,
      );
    },
  );

  scenario(
    "two computers that both number a new task MC-003 while apart end with one MC-003 and one MC-004",
    async (world, later) => {
      const { shared, mac, pc } = await twoComputers(world, later);
      mac.connect(shared);
      await mac.synced();
      pc.connect(shared);
      await agree(mac, pc);

      pc.goOffline();
      await until(() => pc.status().state === "offline", "the PC to notice");
      await pc.edit((state) => {
        state.tasks.push(
          task(pc.projectId, "made-on-pc", {
            identifier: "MC-003",
            title: "Made on the PC",
          }),
        );
      });
      await mac.edit((state) => {
        state.tasks.push(
          task(mac.projectId, "made-on-mac", {
            identifier: "MC-003",
            title: "Made on the Mac",
          }),
        );
      });
      await mac.synced();
      pc.comeBack();
      await agree(mac, pc);
      // The Mac's reached the log first, so it is the one that keeps the number.
      for (const on of [mac, pc]) {
        assert.equal(find(on, "made-on-mac").identifier, "MC-003");
        assert.equal(find(on, "made-on-pc").identifier, "MC-004");
        assert.equal(find(on, "task-1").identifier, "MC-001");
      }
      // The next task made on either takes the number after those.
      await mac.edit((state) => {
        const highest = Math.max(
          ...state.tasks
            .filter((one) => one.projectId === mac.projectId)
            .map((one) => Number(one.identifier.split("-")[1])),
        );
        assert.equal(highest, 4);
      });
    },
  );

  scenario(
    "a person taken off a project keeps the board on their computer, and it stops syncing",
    async (world, later) => {
      const people = cast();
      const alex = signedInTo(world, people.alex);
      later(() => alex.close());
      const dana = signedInTo(world, people.dana);
      later(() => dana.close());
      const shared = await alex.website.startProject("Website");
      const invitation = await alex.website.invite(shared, people.dana.email!);
      await dana.projects.acceptInvitation(shared, invitation);
      const mac = await computer(world, people.alex, "mac");
      later(() => mac.close());
      giveWork(mac.state, mac.projectId);
      await mac.save();
      mac.connect(shared);
      const laptop = await computer(world, people.dana, "laptop");
      later(() => laptop.close());
      laptop.connect(shared);
      await agree(mac, laptop);

      await alex.website.removeGuest(shared, people.dana.accountId);
      // The service looks every ten seconds at who may still watch. A change says so at once.
      await laptop.edit(
        () => void (find(laptop, "task-2").title = "After being removed"),
      );
      await until(
        () => laptop.status().state === "gone",
        () => `the laptop to be told: ${JSON.stringify(laptop.status())}`,
      );
      assert.match(
        laptop.status().detail ?? "",
        /no longer|not exist|does not/i,
      );
      // The board is still on the laptop, with the change that could not be sent.
      assert.equal(find(laptop, "task-2").title, "After being removed");
      assert.equal(find(laptop, "task-1").title, "Export as CSV");
      await mac.edit(() => void (find(mac, "task-1").title = "Not for Dana"));
      await mac.synced();
      assert.equal(find(mac, "task-2").title, "Export as PDF");
      assert.equal(find(laptop, "task-1").title, "Export as CSV");
    },
  );
}
