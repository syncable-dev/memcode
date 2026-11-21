import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { grpcChannel } from "../runtime/sharing/memsync/grpc";
import { MemsyncBoards } from "../runtime/sharing/memsync/boards-api";
import { SignedCalls } from "../runtime/sharing/memsync/signed-calls";
import { SharingUnavailable } from "../runtime/sharing/problems";
import { boardsApiScenarios } from "./support/boards-api-scenarios";
import { startStandInMemsync } from "./support/memsync-stand-in";
import { actingAs } from "./support/memsync-owner";
import { cast } from "./support/projects-api-scenarios";

boardsApiScenarios("stand-in sharing service", startStandInMemsync);

/** MemCode's Boards client on a project of its own, with tokens the test hands out. */
async function fixture() {
  const service = await startStandInMemsync();
  const { alex } = cast();
  const state = { token: service.tokenFor(alex) };
  const forgotten: string[] = [];
  const channel = grpcChannel(service.address);
  const boards = new MemsyncBoards(
    new SignedCalls(channel, {
      current: async () => ({ token: state.token, accountId: alex.accountId }),
      forget: (token) => {
        forgotten.push(token);
        state.token = service.tokenFor(alex);
      },
    }),
  );
  const project = await actingAs(service.address, state.token).startProject(
    "Board",
  );
  return {
    service,
    boards,
    project,
    state,
    forgotten,
    close: async () => {
      channel.close();
      await service.close();
    },
  };
}
const update = () => ({ id: randomUUID(), payload: randomBytes(16) });
const quiet = (context: test.TestContext) =>
  context.mock.method(console, "error", () => {});

test("updates whose receipts were lost are sent again as they were and logged once", async (context) => {
  quiet(context);
  const f = await fixture();
  try {
    const sent = [update(), update()];
    f.service.boards.loseNextReceipts();
    await assert.rejects(f.boards.append(f.project, sent), SharingUnavailable);
    assert.equal(f.service.boards.log(f.project).length, 2);
    const receipts = await f.boards.append(f.project, sent);
    assert.deepEqual(
      receipts.map((receipt) => receipt.sequence),
      [1, 2],
    );
    assert.equal(f.service.boards.log(f.project).length, 2);
  } finally {
    await f.close();
  }
});

test("a watcher whose stream is cut is told the service is unavailable, so it can watch again from its number", async (context) => {
  quiet(context);
  const f = await fixture();
  try {
    await f.boards.append(f.project, [update(), update()]);
    const seen: number[] = [];
    const watching = f.boards.watchAfter(f.project, 0, (logged) => {
      seen.push(logged.sequence);
    });
    while (seen.length < 2)
      await new Promise((resolve) => setTimeout(resolve, 5));
    f.service.boards.cutWatchers();
    await assert.rejects(watching.finished, SharingUnavailable);
    await f.boards.append(f.project, [update()]);
    const again = f.boards.watchAfter(f.project, seen.at(-1)!, (logged) => {
      seen.push(logged.sequence);
    });
    while (seen.length < 3)
      await new Promise((resolve) => setTimeout(resolve, 5));
    again.cancel();
    await again.finished;
    assert.deepEqual(seen, [1, 2, 3]);
  } finally {
    await f.close();
  }
});

test("a watcher whose token is turned away watches again with a new one, once", async (context) => {
  quiet(context);
  const f = await fixture();
  try {
    await f.boards.append(f.project, [update()]);
    const first = f.state.token;
    f.service.expire(first);
    const seen: number[] = [];
    const watching = f.boards.watchAfter(f.project, 0, (logged) => {
      seen.push(logged.sequence);
    });
    while (!seen.length) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(f.forgotten, [first]);
    watching.cancel();
    await watching.finished;
    f.service.turnAwayNextCall();
    f.service.turnAwayNextCall();
    await assert.rejects(
      f.boards.watchAfter(f.project, 0, () => {}).finished,
      (problem) =>
        problem instanceof SharingUnavailable &&
        /did not accept this sign-in/.test(problem.message),
    );
  } finally {
    await f.close();
  }
});

test("hanging up before the token has arrived starts no watch", async () => {
  const service = await startStandInMemsync();
  const channel = grpcChannel(service.address);
  try {
    let hand!: (token: string) => void;
    const boards = new MemsyncBoards(
      new SignedCalls(channel, {
        current: () =>
          new Promise((resolve) => {
            hand = (token) => resolve({ token, accountId: "a" });
          }),
        forget() {},
      }),
    );
    const watching = boards.watchAfter("any", 0, () => {});
    watching.cancel();
    hand("a token that arrives too late");
    await watching.finished;
    assert.equal(service.calls.length, 0);
  } finally {
    channel.close();
    await service.close();
  }
});
