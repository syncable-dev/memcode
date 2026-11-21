import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import * as Y from "yjs";
import { idOf, whyNotApplied } from "../runtime/sharing/board/updates";
import {
  agree,
  computer,
  giveWork,
  task,
  until,
  type Computer,
} from "./support/board-computers";
import { boardSyncScenarios } from "./support/board-sync-scenarios";
import { startStandInMemsync } from "./support/memsync-stand-in";
import {
  cast,
  signedInTo,
  type SharingWorld,
} from "./support/projects-api-scenarios";

boardSyncScenarios("stand-in sharing service", async () => {
  const service = await startStandInMemsync();
  return {
    address: service.address,
    tokenFor: (person) => service.tokenFor(person),
    close: () => service.close(),
  };
});

// What follows needs a sharing service that can be made to misbehave.

/** The same person on a Mac with a board and on a PC without one, against the stand-in. */
async function standIn(context: test.TestContext) {
  const service = await startStandInMemsync();
  const world: SharingWorld = {
    address: service.address,
    tokenFor: (person) => service.tokenFor(person),
    close: () => service.close(),
  };
  const people = cast();
  const alex = signedInTo(world, people.alex);
  const shared = await alex.website.startProject("Website");
  const mac = await computer(world, people.alex, "mac");
  const pc = await computer(world, people.alex, "pc");
  giveWork(mac.state, mac.projectId);
  await mac.save();
  context.after(async () => {
    await mac.close();
    await pc.close();
    alex.close();
    await service.close();
  });
  return { service, world, people, alex, shared, mac, pc };
}
const find = (on: Computer, id: string) =>
  on.state.tasks.find((one) => one.id === id)!;
const quiet = (context: test.TestContext) =>
  context.mock.method(console, "error", () => {});
/** The log as a document, and the entry that first held an id. */
function logAsDocument(log: Array<{ sequence: number; payload: Uint8Array }>) {
  const doc = new Y.Doc();
  const madeAt = new Map<string, number>();
  for (const entry of log) {
    Y.applyUpdate(doc, entry.payload);
    for (const collection of ["tasks", "goals", "comments"] as const)
      for (const id of doc.getMap(collection).keys())
        if (!madeAt.has(id)) madeAt.set(id, entry.sequence);
  }
  return { doc, madeAt };
}

test("a call whose answer is lost is made again, and nothing is in the log twice", async (context) => {
  const { service, shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  pc.connect(shared);
  await agree(mac, pc);
  const logged = service.boards.log(shared).length;

  service.boards.loseNextReceipts();
  await mac.edit(() => void (find(mac, "task-1").title = "Sent, answer lost"));
  await agree(mac, pc);
  assert.equal(find(pc, "task-1").title, "Sent, answer lost");
  assert.equal(service.boards.log(shared).length, logged + 1);
  assert.equal(mac.status().waiting, 0);
});

test("a whole board goes to the service in calls of at most a hundred updates, one entry an update", async (context) => {
  const { service, shared, mac, pc } = await standIn(context);
  for (let at = 10; at < 260; at++)
    mac.state.tasks.push(
      task(mac.projectId, `task-${at}`, {
        description: `What task ${at} is about. `.repeat(20),
      }),
    );
  await mac.save();
  mac.connect(shared);
  await mac.synced();
  // 252 tasks, a goal, a cycle, a comment, two lanes, a field and a view.
  const entries = 252 + 1 + 1 + 1 + 2 + 1 + 1;
  assert.equal(service.boards.log(shared).length, entries);
  assert.ok(
    mac.appends.every((sent) => sent <= 100),
    String(mac.appends),
  );
  assert.ok(mac.appends.length >= 3);
  assert.ok(mac.appendBytes.every((bytes) => bytes <= 3 * 1024 * 1024));

  pc.connect(shared);
  await agree(mac, pc);
  assert.equal(
    pc.state.tasks.filter((one) => one.projectId === pc.projectId).length,
    252,
  );
  // The PC took the board in a few saves, not one for every entry.
  assert.ok(pc.saves < 20, String(pc.saves));
});

test("an update that cannot be read is left out and said so, and the log goes on being read", async (context) => {
  const { service, people, shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  await mac.synced();
  // A fault in storage, after the Mac has read its own update back whole.
  const log = service.boards.log(shared);
  const damaged = logAsDocument(log).madeAt.get("task-2")!;
  service.boards.damage(shared, damaged, Uint8Array.of(0xff, 0xff, 0xff, 7));

  pc.connect(shared);
  await pc.synced();
  assert.equal(find(pc, "task-2"), undefined);
  assert.equal(find(pc, "task-1").title, "Export as CSV");
  assert.deepEqual(pc.status().leftOut, [
    {
      by: people.alex.name,
      on: new Date(log[damaged - 1].loggedAt).toISOString().slice(0, 10),
      count: 1,
    },
  ]);
  // What the Mac wrote after it in the same run builds on it, and is set aside.
  assert.deepEqual(pc.state.storyComments, []);
  assert.equal(pc.status().setAside, true);

  // The Mac is started again. What it writes now does not build on the lost update.
  await mac.quit();
  mac.reopen();
  await mac.synced();
  await mac.edit(() => {
    find(mac, "task-2").title = "Changed on the Mac";
    find(mac, "task-1").title = "Also changed";
  });
  await until(
    () => find(pc, "task-1").title === "Also changed",
    "the PC to take what it can",
  );
  assert.equal(find(pc, "task-2"), undefined);
  assert.equal(pc.status().state, "synced");

  // The entry is not asked for again after a restart: it was dealt with.
  await pc.quit();
  pc.reads.length = 0;
  pc.reopen();
  await pc.synced();
  assert.equal(pc.reads[0], service.boards.log(shared).length);
  assert.equal(pc.status().leftOut[0].count, 1);
});

test("an update of this computer's own that the log holds damaged is sent again, and what waited for it takes effect", async (context) => {
  const { service, shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  pc.connect(shared);
  await agree(mac, pc);

  service.boards.damageNextLogged();
  await mac.edit((state) => {
    state.tasks.push(
      task(mac.projectId, "task-5", { title: "Damaged on the way" }),
    );
  });
  // Changes that build on it follow at once.
  await mac.edit(() => void (find(mac, "task-5").priority = "high"));
  await mac.edit(() => void (find(mac, "task-5").title = "Arrived after all"));
  await agree(mac, pc);
  assert.equal(find(pc, "task-5").title, "Arrived after all");
  assert.equal(find(pc, "task-5").priority, "high");
  assert.equal(pc.status().setAside, false);
  // Both say that one entry of the log could not be read.
  assert.equal(pc.status().leftOut[0].count, 1);
  assert.equal(mac.status().leftOut[0].count, 1);
  assert.equal(mac.status().waiting, 0);

  // The repair is sent once. The Mac is not still sending it.
  const logged = service.boards.log(shared).length;
  await mac.edit(() => void (find(mac, "task-1").estimate = 5));
  await agree(mac, pc);
  assert.equal(service.boards.log(shared).length, logged + 1);
});

test("an update that reads as one and still cannot be applied is left out, and sync goes on from what was saved", async (context) => {
  quiet(context);
  const { service, alex, shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  pc.connect(shared);
  await agree(mac, pc);

  // Someone's MemCode writes bytes that read as an update and cannot be applied.
  const { doc } = logAsDocument(service.boards.log(shared));
  doc.clientID = 20261121;
  let real: Uint8Array | undefined;
  doc.on("update", (update: Uint8Array) => void (real = update));
  const made = new Y.Map<unknown>();
  doc.getMap("tasks").set("task-made-elsewhere", made);
  made.set("title", "Made by another MemCode");
  assert.ok(real);
  let poison: Uint8Array | undefined;
  for (let bit = 0; bit < real.length * 8 && !poison; bit++) {
    const flipped = Uint8Array.from(real);
    flipped[bit >> 3] ^= 1 << (bit & 7);
    if (whyNotApplied(idOf(flipped), flipped)) continue;
    const reader = logAsDocument(service.boards.log(shared)).doc;
    try {
      Y.applyUpdate(reader, flipped);
    } catch {
      poison = flipped;
    }
  }
  assert.ok(poison, "no bytes found that read as an update and do not apply");

  pc.reads.length = 0;
  const before = service.boards.log(shared).length;
  await alex.boards.append(shared, [{ id: idOf(poison), payload: poison }]);
  await mac.edit(() => void (find(mac, "task-1").title = "After the bad one"));
  await agree(mac, pc);
  assert.equal(find(pc, "task-1").title, "After the bad one");
  for (const one of [mac, pc]) {
    assert.equal(one.status().leftOut[0].count, 1);
    assert.equal(one.status().state, "synced");
  }
  // The PC went back to what it had saved and read the log again from there.
  assert.ok(pc.reads.includes(before), String(pc.reads));
  assert.deepEqual(pc.board(), mac.board());
});

test("a board laid out by a newer MemCode is shown and not changed", async (context) => {
  const { service, alex, shared, mac } = await standIn(context);
  mac.connect(shared);
  await mac.synced();

  // A newer MemCode changes a task and says the layout is 2.
  const { doc } = logAsDocument(service.boards.log(shared));
  const made: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => void made.push(update));
  doc.transact(() => {
    doc.getMap("meta").set("layout", 2);
    (doc.getMap("tasks").get("task-1") as Y.Map<unknown>).set(
      "title",
      "Renamed by a newer MemCode",
    );
  });
  await alex.boards.append(
    shared,
    made.map((payload) => ({ id: idOf(payload), payload })),
  );
  await until(() => mac.status().state === "newer", "the Mac to notice");
  assert.match(mac.status().detail ?? "", /newer MemCode/);
  assert.equal(find(mac, "task-1").title, "Renamed by a newer MemCode");

  const sent = mac.appends.length;
  await mac.edit(
    () => void (find(mac, "task-2").title = "Changed on an old MemCode"),
  );
  assert.equal(mac.appends.length, sent);
  assert.equal(mac.status().waiting, 0);
  assert.equal(mac.status().state, "newer");
  // The change is still on this computer.
  assert.equal(find(mac, "task-2").title, "Changed on an old MemCode");
});

test("MemCode stopped before the workspace file was written: the change from the log is applied once, after the restart", async (context) => {
  quiet(context);
  const { shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  pc.connect(shared);
  await agree(mac, pc);
  const appliedBefore = pc.file().sharedProjectLinks![0].applied;

  pc.failingSaves = Infinity;
  await mac.edit((state) => {
    find(mac, "task-1").description = "Line one.\nLine two.\nLine three.";
    state.tasks.push(
      task(mac.projectId, "task-4", { title: "Arrives during the crash" }),
    );
  });
  await until(() => pc.status().state === "stopped", "the PC to fail to save");
  assert.match(pc.status().detail ?? "", /could not be saved/);
  await pc.quit();
  // The workspace file is as it was. Board sync's save for the change is beside it, not in place.
  assert.equal(pc.file().sharedProjectLinks![0].applied, appliedBefore);
  assert.ok(
    (await readdir(join(pc.folder, "board"))).includes("sync.json.next"),
  );

  pc.failingSaves = 0;
  pc.appends.length = 0;
  pc.reopen();
  await agree(mac, pc);
  assert.equal(
    find(pc, "task-1").description,
    "Line one.\nLine two.\nLine three.",
  );
  assert.equal(find(pc, "task-4").title, "Arrives during the crash");
  // Nothing of it was taken for a change made on the PC.
  assert.deepEqual(pc.appends, []);
  assert.deepEqual((await readdir(join(pc.folder, "board"))).sort(), [
    "log.bin",
    "sync.json",
  ]);
});

test("MemCode stopped after the workspace file was written: the change is not applied again and not sent back", async (context) => {
  quiet(context);
  const { service, shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  pc.connect(shared);
  await agree(mac, pc);

  // The file is written, and MemCode is gone before board sync hears of it.
  pc.afterNextSave = () => {
    pc.failingSaves = Infinity;
    throw new Error("MemCode was stopped");
  };
  await mac.edit((state) => {
    find(mac, "task-1").description = "Line one.\nLine two.\nLine three.";
    state.tasks.push(
      task(mac.projectId, "task-4", { title: "Arrives during the crash" }),
    );
  });
  await until(() => pc.status().state === "stopped", "the PC to stop");
  await pc.quit();
  assert.equal(
    pc.file().tasks.find((one) => one.id === "task-4")?.title,
    "Arrives during the crash",
  );
  assert.ok(
    (await readdir(join(pc.folder, "board"))).includes("sync.json.next"),
  );

  pc.failingSaves = 0;
  pc.appends.length = 0;
  pc.reads.length = 0;
  const logged = service.boards.log(shared).length;
  pc.reopen();
  await agree(mac, pc);
  assert.equal(
    find(pc, "task-1").description,
    "Line one.\nLine two.\nLine three.",
  );
  // The PC knew it had dealt with the whole log, and sent nothing.
  assert.equal(pc.reads[0], logged);
  assert.deepEqual(pc.appends, []);
  assert.equal(service.boards.log(shared).length, logged);
});

test("while the workspace cannot be saved, changes from the shared board wait, and are taken up when it can", async (context) => {
  quiet(context);
  const { shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  pc.connect(shared);
  await agree(mac, pc);

  pc.failingSaves = 4;
  await mac.edit(
    () => void (find(mac, "task-2").title = "While the disk was full"),
  );
  await until(() => pc.status().state === "stopped", "the PC to say so");
  await agree(mac, pc);
  assert.equal(
    pc.file().tasks.find((one) => one.id === "task-2")?.title,
    "While the disk was full",
  );
  assert.equal(pc.status().detail, undefined);
});

test("a stream that is cut is started again after the last entry that was dealt with", async (context) => {
  const { service, shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  await mac.synced();
  pc.connect(shared);
  await agree(mac, pc);
  const logged = service.boards.log(shared).length;
  assert.deepEqual(pc.watches, [logged]);

  await until(() => service.boards.watching === 2, "both to be listening");
  service.boards.cutWatchers();
  await until(
    () => pc.watches.length === 2 && mac.watches.length === 2,
    "both to listen again",
  );
  assert.equal(pc.watches[1], logged);
  await mac.edit(() => void (find(mac, "task-1").title = "After the cut"));
  await agree(mac, pc);
  assert.equal(find(pc, "task-1").title, "After the cut");
});

test("a value too large for the sharing service stays on this computer, and the rest of the task is shared", async (context) => {
  const { shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  pc.connect(shared);
  await agree(mac, pc);
  await mac.edit(() => {
    find(mac, "task-2").title = "Shared all the same";
    find(mac, "task-2").category = "c".repeat(1024 * 1024);
  });
  await until(
    () => find(pc, "task-2").title === "Shared all the same",
    "the PC",
  );
  assert.equal(mac.status().tooLarge, 1);
  assert.equal(find(pc, "task-2").category, "Work");
  await mac.synced();
  await pc.synced();
});

test("a project that is taken off this computer is not a board that was emptied", async (context) => {
  const { service, shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  await mac.synced();
  pc.connect(shared);
  await agree(mac, pc);
  const logged = service.boards.log(shared).length;

  await mac.edit((state) => {
    state.projects = state.projects.filter((one) => one.id !== mac.projectId);
    state.tasks = state.tasks.filter((one) => one.projectId !== mac.projectId);
    state.epics = state.epics.filter((one) => one.projectId !== mac.projectId);
  });
  await pc.edit(() => void (find(pc, "task-1").estimate = 13));
  await pc.synced();
  assert.equal(service.boards.log(shared).length, logged + 1);
  assert.equal(find(pc, "task-2").title, "Export as PDF");
  assert.equal(
    pc.state.epics.some((one) => one.id === "goal-1"),
    true,
  );
});

test("a task a worker is on here stays here when someone deletes it, and is back for everyone once it changes", async (context) => {
  const { shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  await mac.synced();
  pc.connect(shared);
  await agree(mac, pc);

  // A worker is running on the PC's copy of the task when the Mac deletes it.
  find(pc, "task-2").run = { state: "running" };
  await mac.edit((state) => {
    state.tasks = state.tasks.filter((one) => one.id !== "task-2");
  });
  await mac.synced();
  await pc.synced();
  assert.equal(find(mac, "task-2"), undefined);
  assert.equal(find(pc, "task-2").title, "Export as PDF");

  // The worker finishes and the task moves on.
  await pc.edit(() => {
    const kept = find(pc, "task-2");
    kept.run = { state: "idle" };
    kept.stage = "review";
    kept.statusId = "pc-project:review";
  });
  await agree(mac, pc);
  assert.equal(find(mac, "task-2").stage, "review");
  assert.equal(find(mac, "task-2").title, "Export as PDF");
});

test("when the service refuses a change by one of its rules, sending stops with the sentence and reading goes on", async (context) => {
  const { service, shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  await mac.synced();
  pc.connect(shared);
  await agree(mac, pc);
  await until(() => service.boards.watching === 2, "both to be listening");

  // MemCode is written never to meet this. If it does, asking again changes nothing.
  service.refuseNextCallBy("update_too_large", 3);
  await mac.edit(
    () => void (find(mac, "task-1").title = "Refused by the service"),
  );
  await until(() => mac.status().state === "stopped", "the Mac to say so");
  assert.equal(
    mac.status().detail,
    "One change to the board was too large to share. Shorten the text you just added and try again.",
  );
  assert.equal(mac.status().waiting, 1);
  const calls = mac.appends.length;

  // What others do still arrives, and the change stays on this computer.
  await pc.edit(() => void (find(pc, "task-2").title = "Still arriving"));
  await until(
    () => find(mac, "task-2").title === "Still arriving",
    "the Mac to go on reading",
  );
  assert.equal(mac.status().state, "stopped");
  assert.equal(find(mac, "task-1").title, "Refused by the service");
  assert.equal(find(pc, "task-1").title, "Export as CSV");
  // It did not keep asking in a loop.
  assert.ok(mac.appends.length <= calls + 1, String(mac.appends));
});

test("ending sync does not wait for a call the service never answers", async (context) => {
  const { shared, pc } = await standIn(context);
  pc.isSilent = true;
  pc.connect(shared);
  await until(
    () => pc.reads.length === 0 && pc.status().state === "starting",
    "the PC to be asking",
  );
  const started = Date.now();
  await pc.quit();
  assert.ok(Date.now() - started < 1000);
});

test("bytes that are not what their id says are left out, even when they would apply as a real change", async (context) => {
  const { service, shared, mac, pc } = await standIn(context);
  mac.connect(shared);
  await mac.synced();
  await mac.edit(() => void (find(mac, "task-2").title = "Written by the Mac"));
  await mac.synced();

  // In storage, the last entry's bytes become another update that reads perfectly well.
  const log = service.boards.log(shared);
  const { doc } = logAsDocument(log.slice(0, -1));
  let forged: Uint8Array | undefined;
  doc.on("update", (update: Uint8Array) => void (forged = update));
  (doc.getMap("tasks").get("task-2") as Y.Map<unknown>).set("title", "Forged");
  assert.ok(forged);
  assert.equal(whyNotApplied(idOf(forged), forged), undefined);
  service.boards.damage(shared, log.length, forged);

  pc.connect(shared);
  await pc.synced();
  assert.equal(find(pc, "task-2").title, "Export as PDF");
  assert.equal(pc.status().leftOut[0].count, 1);
});
