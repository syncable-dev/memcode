import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { StoryReviewRun } from "../../src/code-review";
import { cardIdOf } from "../../runtime/sharing/cards/activity";
import { until } from "./board-computers";
import { at, cardComputer, turn } from "./card-computers";
import { cast, signedInTo, type SharingWorld } from "./projects-api-scenarios";

const review = (taskId: string): StoryReviewRun =>
  ({
    version: 1,
    id: randomUUID(),
    taskId,
    implementationRunIds: [],
    createdAt: at(5),
    updatedAt: at(6),
    state: "completed",
    outcome: "pass",
    metrics: [],
    findings: [
      {
        id: "f1",
        title: "Export closes the file twice",
        explanation: "See /Users/alex/work/website/src/export.ts line 12.",
        severity: "medium",
      },
    ],
    phases: [{ id: "p1", state: "completed" }],
    messages: [],
    snapshot: { id: "s1", branch: "epic/ep-01", files: [] },
    coverage: { complete: true, limitations: [] },
    impact: {},
    checks: [{ name: "tests", state: "passed" }],
  }) as unknown as StoryReviewRun;

/** What card activity must do against any sharing service that follows ADR-0014. */
export function cardActivityScenarios(
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
    test(`${where}: ${name}`, { skip: options.skip }, async (context) => {
      const world = await open();
      const closing: Array<() => unknown> = [];
      try {
        if (world.lacks) return context.skip(world.lacks);
        await run(world, (close) => closing.push(close));
      } finally {
        for (const close of closing.reverse()) await close();
        await world.close();
      }
    });

  /** Alex on a Mac that runs a worker, and Dana, a guest, with the card open. */
  async function project(
    world: SharingWorld,
    later: (close: () => unknown) => void,
  ) {
    const people = cast();
    const alex = signedInTo(world, people.alex),
      dana = signedInTo(world, people.dana);
    later(() => alex.close());
    later(() => dana.close());
    const shared = await alex.website.startProject("Website");
    await dana.projects.acceptInvitation(
      shared,
      await alex.website.invite(shared, people.dana.email!),
    );
    const names = [people.alex, people.dana];
    const mac = await cardComputer(world, people.alex, shared, { names });
    later(() => mac.close());
    const laptop = await cardComputer(world, people.dana, shared, {
      device: "Windows",
      names,
    });
    later(() => laptop.close());
    const id = randomUUID();
    mac.addTask(id);
    laptop.addTask(id);
    return { people, shared, mac, laptop, id, alex, dana };
  }

  scenario(
    "a worker running on one computer is on the other's open card as it happens, with who runs it",
    async (world, later) => {
      const { people, mac, laptop, id } = await project(world, later);
      laptop.activity.follow(id);
      const onMac = mac.find(id),
        onLaptop = () => laptop.find(id);
      onMac.run = {
        state: "running",
        startedAt: at(1),
        activity: {
          phase: "editing",
          label: "apply_patch src/export.ts",
          at: at(2),
        },
      } as never;
      onMac.messages.push(
        turn("m1", "Export the report as CSV.", "user"),
        turn("m2", "Reading /Users/alex/work/website/src/export.ts now."),
        turn("tool-1", "PRIVATE TOOL OUTPUT", "tool"),
      );
      await mac.activity.capture();
      await until(
        () => onLaptop().sharedSession?.messages.length === 2,
        "the laptop's card to show the conversation",
      );
      const shown = onLaptop().sharedSession!;
      assert.equal(onLaptop().sharedFromLog, true);
      assert.equal(shown.owner.name, people.alex.name);
      assert.equal(shown.owner.device, "Mac");
      assert.equal(shown.state, "running");
      assert.equal(shown.activity?.label, "Editing project files");
      assert.equal(shown.harness, onMac.harness);
      assert.deepEqual(
        shown.messages.map((message) => message.text),
        [
          "Export the report as CSV.",
          "Reading <local-home>/work/website/src/export.ts now.",
        ],
      );
      // The laptop's own task is not touched: no worker runs there.
      assert.equal(onLaptop().run.state, "idle");
      assert.deepEqual(onLaptop().messages, []);

      // The worker goes on; the open card follows without being opened again.
      onMac.messages.push(
        turn("m3", "Wrote the export and its test.", "assistant", 3),
      );
      onMac.run.state = "finished";
      onMac.run.finishedAt = at(4);
      await mac.activity.capture();
      await until(
        () => onLaptop().sharedSession?.state === "finished",
        "the laptop to see the run finish",
      );
      assert.equal(
        onLaptop().sharedSession!.messages.at(-1)!.text,
        "Wrote the export and its test.",
      );
    },
  );

  scenario("only what changed in a run is sent again", async (world, later) => {
    const { mac, id, shared } = await project(world, later);
    const onMac = mac.find(id);
    onMac.run = { state: "running", startedAt: at(1) } as never;
    onMac.messages.push(turn("m1", "First turn."));
    await mac.activity.capture();
    await until(() => mac.activity.unsent === 0, "the first entry to be sent");
    const reader = signedInTo(world, cast().alex);
    later(() => reader.close());
    await mac.activity.capture();
    assert.equal(mac.appends, 1);
    onMac.messages.push(turn("m2", "Second turn.", "assistant", 2));
    await mac.activity.capture();
    await until(
      () => mac.activity.unsent === 0 && mac.appends === 2,
      "the new turn",
    );
    // Restarted, it remembers what it sent.
    await mac.restart();
    await mac.activity.capture();
    assert.equal(mac.appends, 2);
    void shared;
  });

  scenario(
    "a run's code review is on the other computer's card, and only its own",
    async (world, later) => {
      const { mac, laptop, id, shared, dana } = await project(world, later);
      const onMac = mac.find(id);
      onMac.run = {
        state: "finished",
        startedAt: at(1),
        finishedAt: at(4),
      } as never;
      onMac.codeReview = {
        runId: "r1",
        state: "completed",
        updatedAt: at(6),
        findingCount: 1,
      } as never;
      mac.reviews.set(id, review(id));
      await mac.activity.capture();
      await until(() => mac.activity.unsent === 0, "the review to be sent");
      // A guest writes a review of their own into Alex's run.
      const [, logged] = await dana.cards.readAfter(shared, cardIdOf(id), 0);
      const forged = JSON.parse(new TextDecoder().decode(logged.payload));
      assert.equal(forged.kind, "review");
      forged.review.findings[0].title = "A forged finding";
      await dana.cards.append(shared, cardIdOf(id), [
        {
          id: randomUUID(),
          payload: new TextEncoder().encode(JSON.stringify(forged)),
        },
      ]);
      laptop.activity.follow(id);
      await until(() => !!laptop.find(id).sharedSession?.review, "the review");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const shown = laptop.find(id).sharedSession!.review!;
      assert.equal(shown.findings[0].title, "Export closes the file twice");
      assert.equal(
        shown.findings[0].explanation,
        "See <local-home>/work/website/src/export.ts line 12.",
      );
      assert.equal(shown.taskId, id);
    },
  );

  scenario(
    "a conversation is shown only from the account that started the worker",
    async (world, later) => {
      const { people, mac, laptop, id, shared, dana } = await project(
        world,
        later,
      );
      const onMac = mac.find(id);
      onMac.run = { state: "running", startedAt: at(1) } as never;
      onMac.messages.push(turn("m1", "The real turn."));
      await mac.activity.capture();
      await until(() => mac.activity.unsent === 0, "the Mac's entry");
      // Dana writes into Alex's run, as a changed MemCode could.
      const [first] = await dana.cards.readAfter(shared, cardIdOf(id), 0);
      const forged = JSON.parse(new TextDecoder().decode(first.payload));
      forged.session.messages = [
        turn("m1", "A forged turn."),
        turn("m9", "Another forged turn."),
      ];
      forged.session.state = "failed";
      await dana.cards.append(shared, cardIdOf(id), [
        {
          id: randomUUID(),
          payload: new TextEncoder().encode(JSON.stringify(forged)),
        },
      ]);
      laptop.activity.follow(id);
      await until(() => !!laptop.find(id).sharedSession, "the card to be read");
      // A moment more for anything else in the log.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const shown = laptop.find(id).sharedSession!;
      assert.equal(shown.owner.name, people.alex.name);
      assert.deepEqual(
        shown.messages.map((message) => message.text),
        ["The real turn."],
      );
      assert.equal(shown.state, "running");
    },
  );

  scenario(
    "the same person's run on another computer is shown, and a computer's own run is not shown back to it",
    async (world, later) => {
      const people = cast();
      const alex = signedInTo(world, people.alex);
      later(() => alex.close());
      const shared = await alex.website.startProject("Website");
      const mac = await cardComputer(world, people.alex, shared);
      later(() => mac.close());
      const pc = await cardComputer(world, people.alex, shared, {
        device: "Windows",
      });
      later(() => pc.close());
      const id = randomUUID();
      mac.addTask(id);
      pc.addTask(id);
      const onMac = mac.find(id);
      onMac.run = {
        state: "finished",
        startedAt: at(1),
        finishedAt: at(3),
      } as never;
      onMac.messages.push(turn("m1", "Done on the Mac."));
      await mac.activity.capture();
      mac.activity.follow(id);
      pc.activity.follow(id);
      await until(
        () => !!pc.find(id).sharedSession,
        "the PC to show the Mac's run",
      );
      assert.equal(pc.find(id).sharedSession!.owner.device, "Mac");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(mac.find(id).sharedSession, undefined);

      // The PC starts a worker of its own later: its card shows its own run again.
      const onPc = pc.find(id);
      onPc.run = { state: "running", startedAt: at(9) } as never;
      onPc.messages.push(turn("p1", "Continued on the PC.", "user", 9));
      await pc.activity.capture();
      await until(
        () => !!mac.find(id).sharedSession,
        "the Mac to show the PC's run",
      );
      assert.equal(mac.find(id).sharedSession!.owner.device, "Windows");
      await until(
        () => pc.find(id).sharedSession === undefined,
        "the PC to show its own run",
      );
    },
  );

  scenario(
    "what a worker does while the service cannot be reached is kept and sent later, also after a restart",
    async (world, later) => {
      const { mac, laptop, id } = await project(world, later);
      mac.isOffline = true;
      const onMac = mac.find(id);
      onMac.run = { state: "running", startedAt: at(1) } as never;
      onMac.messages.push(turn("m1", "Written while offline."));
      await mac.activity.capture();
      assert.ok(mac.activity.unsent > 0);
      await mac.restart();
      assert.equal(
        mac.activity.unsent,
        0,
        "nothing loaded before the first look",
      );
      mac.isOffline = false;
      await mac.activity.capture();
      await until(
        () => mac.activity.unsent === 0,
        "the kept entries to be sent",
      );
      laptop.activity.follow(id);
      await until(
        () =>
          laptop.find(id).sharedSession?.messages[0]?.text ===
          "Written while offline.",
        "the laptop to see it",
      );
    },
  );

  scenario(
    "a file shared from a card is listed on the other computer's card with who shared it",
    async (world, later) => {
      const { people, mac, laptop, id } = await project(world, later);
      laptop.activity.follow(id);
      const bytes = new TextEncoder().encode("<h1>Export report</h1>");
      const result = await mac.activity.shareResult(id, {
        name: "export-report.html",
        mime: "text/html",
        kind: "report",
        bytes,
      });
      await until(
        () => laptop.find(id).sharedResults?.length === 1,
        "the shared file",
      );
      const [listed] = laptop.find(id).sharedResults!;
      assert.equal(listed.name, "export-report.html");
      assert.equal(listed.sharedBy, people.alex.name);
      assert.equal(listed.sha256, result.sha256);
      assert.equal(listed.size, bytes.length);
      assert.equal("account" in listed, false);
    },
  );

  scenario(
    "a task whose id is not a UUID still has a card of its own",
    async (world, later) => {
      const { mac, laptop } = await project(world, later);
      mac.addTask("task-7");
      laptop.addTask("task-7");
      const onMac = mac.find("task-7");
      onMac.run = { state: "finished", startedAt: at(1) } as never;
      onMac.messages.push(turn("m1", "On a card with an old id."));
      await mac.activity.capture();
      laptop.activity.follow("task-7");
      await until(() => !!laptop.find("task-7").sharedSession, "the card");
      assert.equal(cardIdOf("task-7"), cardIdOf("task-7"));
      assert.match(cardIdOf("task-7"), /^[0-9a-f-]{36}$/);
    },
  );
}
