import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cardActivityScenarios } from "./support/card-activity-scenarios";
import { until } from "./support/board-computers";
import { at, cardComputer, turn } from "./support/card-computers";
import { startStandInMemsync } from "./support/memsync-stand-in";
import { cast, signedInTo } from "./support/projects-api-scenarios";

cardActivityScenarios("stand-in sharing service", async () => {
  const service = await startStandInMemsync();
  return {
    address: service.address,
    tokenFor: (person) => service.tokenFor(person),
    close: () => service.close(),
  };
});

test("an open card whose stream ends watches again from the last entry it has", async (context) => {
  const service = await startStandInMemsync();
  const world = {
    address: service.address,
    tokenFor: (person: Parameters<typeof service.tokenFor>[0]) =>
      service.tokenFor(person),
    close: () => service.close(),
  };
  const people = cast();
  const alex = signedInTo(world, people.alex);
  const shared = await alex.website.startProject("Website");
  const mac = await cardComputer(world, people.alex, shared);
  const pc = await cardComputer(world, people.alex, shared, {
    device: "Windows",
  });
  context.after(async () => {
    await mac.close();
    await pc.close();
    alex.close();
    await service.close();
  });
  const id = randomUUID();
  mac.addTask(id);
  pc.addTask(id);
  const onMac = mac.find(id);
  onMac.run = { state: "running", startedAt: at(1) } as never;
  onMac.messages.push(turn("m1", "Before the stream ended."));
  await mac.activity.capture();
  pc.activity.follow(id);
  await until(
    () => pc.find(id).sharedSession?.messages.length === 1,
    "the first turn",
  );
  // The Mac watches too: it runs the worker, and reads the card for messages to it.
  await until(
    () => service.cards.watching === 2,
    "the PC and the Mac to be watching",
  );
  const reads = service.cards.calls.filter(
    (call) => call.method === "ReadCardEntries",
  ).length;

  // MemSync stops: the stream ends with UNAVAILABLE and no rule name.
  service.cards.cutWatchers();
  onMac.messages.push(turn("m2", "After it ended.", "assistant", 2));
  await mac.activity.capture();
  await until(
    () => pc.find(id).sharedSession?.messages.length === 2,
    "the turn after the cut",
  );
  await until(
    () => service.cards.watching === 2,
    "the PC and the Mac to watch again",
  );
  const watches = service.cards.calls.filter(
    (call) => call.method === "WatchCardEntries",
  );
  assert.equal(watches.length, 4);
  // Each went on from where it was: one more read for what came meanwhile, no second copy of anything.
  assert.ok(
    service.cards.calls.filter((call) => call.method === "ReadCardEntries")
      .length <=
      reads + 4,
  );
  assert.deepEqual(
    pc.find(id).sharedSession!.messages.map((message) => message.id),
    ["m1", "m2"],
  );
});
