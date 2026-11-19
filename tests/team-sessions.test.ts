import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../src/seed";
import { settleFollowupQueue } from "../runtime/followup-queue";
import { claimReviewContext, markReviewContext } from "../runtime/review-context";
import type { AppState, Harness } from "../src/shared";
import type { StoryReviewRun } from "../src/code-review";
import { TeamSyncClient } from "../runtime/team/client";
import {
  publishSession,
  addSessionCommand,
  editSessionCommand,
  receiptSessionCommand,
  applySessionRecord,
  emptySessions,
  sessionPublish,
} from "../runtime/team/session-protocol";

const at = "2026-11-18T19:00:00.000Z";
function makeState(id: string, populated = false): AppState {
  const state = initialState(),
    base = state.tasks[0];
  state.projects = [
    {
      id,
      name: "Shared session test",
      description: "",
      branch: "main",
      path: null,
      analysis: "idle",
      createdAt: at,
    },
  ];
  state.tasks = populated
    ? (["claude", "codex", "cursor"] as Harness[]).map((harness) => ({
        ...base,
        id: "story-" + harness,
        projectId: id,
        identifier: "MC-" + harness,
        title: "Shared " + harness,
        harness,
        example: false,
        stage: "working",
        run: { state: "idle" },
        epicId: null,
        cycleId: null,
        scope: [],
        messages: [
          {
            id: "brief-" + harness,
            role: "user",
            text: "Implement the selected story",
            at,
          },
        ],
      }))
    : [];
  Object.assign(state, {
    activeProjectId: id,
    epics: [],
    cycles: [],
    storyComments: [],
    reviewComments: [],
    artifacts: [],
    team: [],
  });
  return state;
}
function report(taskId: string, harness: Harness): StoryReviewRun {
  return {
    version: 1,
    id: "review-" + harness,
    taskId,
    implementationRunIds: ["pass-1"],
    createdAt: at,
    updatedAt: at,
    state: "completed",
    outcome: "incomplete",
    phases: [],
    snapshot: {
      id: "snapshot",
      patchHash: "hash",
      journalRevision: "journal",
      branch: "epic/a",
      commit: null,
      sourceRevision: "source",
      graphRevision: "graph",
      files: [],
      additions: 4,
      deletions: 2,
    },
    engine: { version: "test" },
    coverage: { complete: false, limitations: ["A check is unavailable"] },
    findings: [],
    metrics: [
      {
        symbol: "WorkDetail",
        path: "src/WorkDetail.tsx",
        line: 1,
        cognitive: 93,
        cyclomatic: 80,
        nesting: 4,
        maintainabilityIndex: 0,
        source: "ast",
        before: {
          source: "ast",
          cognitive: 260,
          cyclomatic: 178,
          nesting: 7,
          maintainabilityIndex: 0,
        },
      },
    ],
    checks: [{ name: "Tests", state: "unavailable" }],
    impact: { symbols: 8, files: 3, processes: 1, complete: true },
    messages: [],
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memcode-shared-sessions-"));
  const aState = makeState("A", true),
    bState = makeState("B");
  let offline = false,
    dropAck = false;
  const received: string[] = [];
  const aOptions = {
    background: false,
    onSessionCommand: async (task: AppState["tasks"][number], command: any) => {
      const prior = task.messages.find((m) => m.id === command.id);
      if (prior) {
        if (!prior.promptedAt) prior.text = command.text;
        return;
      }
      task.messages.push({
        id: command.id,
        sourceCommandId: command.id,
        actor: command.author,
        role: "user",
        at: command.createdAt,
        text: command.text,
        followupState: "queued",
      });
      received.push(command.id);
    },
  };
  const transport: typeof fetch = async (input, init) => {
    if (offline) throw Error("Network offline");
    const reply = await fetch(input, init);
    if (dropAck && String(input).endsWith("/v1/session-commands")) {
      dropAck = false;
      throw Error("Lost accepted reply");
    }
    return reply;
  };
  let a = new TeamSyncClient(
    () => aState,
    join(root, "a"),
    async () => {},
    aOptions,
  );
  let b = new TeamSyncClient(
    () => bState,
    join(root, "b"),
    async () => {},
    { background: false, fetch: transport },
  );
  await a.initialize();
  await b.initialize();
  await a.create({ projectId: "A", displayName: "Alice" });
  const invite = await a.invite("A");
  await b.join({
    projectId: "B",
    displayName: "Bob",
    invite: JSON.stringify(invite),
  });
  const start = async (harness: Harness) => {
    const task = aState.tasks.find((t) => t.harness === harness)!;
    await a.acquire(task.id, "A");
    task.run = {
      state: "running",
      startedAt: at,
      activity: { phase: "working", label: "Implementing " + harness, at },
      measurements: {
        modelId: harness + "-actual",
        modelSource: "test-fixture",
      } as any,
    };
    await a.synchronize("A");
    await b.synchronize("B");
    return task;
  };
  return {
    root,
    aState,
    bState,
    received,
    start,
    get a() {
      return a;
    },
    get b() {
      return b;
    },
    offline(v: boolean) {
      offline = v;
    },
    dropAck() {
      dropAck = true;
    },
    async restartA() {
      await a.close();
      a = new TeamSyncClient(
        () => aState,
        join(root, "a"),
        async () => {},
        aOptions,
      );
      await a.initialize();
    },
    async restartB() {
      await b.close();
      b = new TeamSyncClient(
        () => bState,
        join(root, "b"),
        async () => {},
        { background: false, fetch: transport },
      );
      await b.initialize();
    },
    async close() {
      await b.close();
      await a.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a retry keeps the failed preflight intact while it waits for a new Team claim", async () => {
  const f = await fixture();
  try {
    const task = f.aState.tasks.find(item => item.harness === "codex")!;
    task.run = {state: "preparing", startedAt: at};
    await f.a.acquire(task.id, "A");
    await f.a.synchronize("A");
    Object.assign(task.run, {state: "failed", finishedAt: "2026-11-18T19:00:01.000Z", error: "Source verification failed"});
    await f.a.release(task.id, "A");
    await f.b.synchronize("B");
    const failed = structuredClone(f.b.status("B")!.sessions![0]);
    assert.equal(failed.state, "failed");

    const retryStart = "2026-11-18T19:00:02.000Z";
    task.run = {state: "preparing", startedAt: retryStart};
    await f.a.synchronize("A");
    await f.b.synchronize("B");
    assert.deepEqual(f.b.status("B")!.sessions, [failed]);

    await f.a.acquire(task.id, "A");
    Object.assign(task.run, {state: "finished", finishedAt: "2026-11-18T19:00:03.000Z"});
    await f.a.release(task.id, "A");
    await f.b.synchronize("B");
    const attempts = f.b.status("B")!.sessions!;
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.find(s => s.id === failed.id), failed);
    const completed = attempts.find(s => s.id !== failed.id)!;
    assert.equal(completed.state, "finished");
    assert.equal(completed.startedAt, retryStart);
    assert.ok(completed.epoch > failed.epoch);
  } finally { await f.close(); }
});

test("a retained execution claim can be released but cannot be reused for another pass", async () => {
  const f = await fixture();
  try {
    const task = await f.start("codex");
    task.run.state = "failed";
    await f.a.synchronize("A");
    const failed = structuredClone(f.a.status("A")!.sessions![0]);
    task.run = {state: "preparing", startedAt: "2026-11-18T19:00:02.000Z"};
    await assert.rejects(f.a.acquire(task.id, "A"), /previous worker|previous pass/i);
    await f.a.release(task.id, "A");
    await f.b.synchronize("B");
    assert.deepEqual(f.b.status("B")!.sessions, [failed]);
    await f.a.acquire(task.id, "A");
    task.run.state = "finished";
    await f.a.release(task.id, "A");
    await f.b.synchronize("B");
    assert.equal(f.b.status("B")!.sessions!.length, 2);
  } finally { await f.close(); }
});

test("Claude Code, Codex and Cursor share their actual conversation, model, author and saved review across members", async () => {
  const f = await fixture();
  try {
    for (const harness of ["claude", "codex", "cursor"] as Harness[]) {
      const task = await f.start(harness);
      task.messages.push({
        id: "answer-" + harness,
        role: "assistant",
        at,
        text: "Implemented by " + harness,
      });
      const review = report(task.id, harness);
      review.coverage.limitations.push(
        "Saved on C:\\Users\\alice\\project; /Users/alice",
      );
      f.a.reviewSaved(review);
      task.codeReview = {
        runId: review.id,
        state: "completed",
        updatedAt: at,
        findingCount: 0,
      };
      task.run.state = "finished";
      await f.a.release(task.id, "A");
      await f.b.synchronize("B");
      const remote = f.bState.tasks.find(
        (t) => t.id === task.id,
      )!.sharedSession!;
      assert.equal(remote.harness, harness);
      assert.equal(remote.actualModel, harness + "-actual");
      assert.equal(remote.owner.name, "Alice");
      assert.equal(remote.messages.at(-1)!.text, "Implemented by " + harness);
      assert.equal(
        remote.messages.at(-1)!.actor!.memberId,
        remote.owner.memberId,
      );
      assert.equal(remote.review!.metrics[0].cognitive, 93);
      assert.equal(remote.review!.metrics[0].maintainabilityIndex, 0);
      assert.equal(remote.review!.coverage.complete, false);
      assert.equal(
        remote.review!.coverage.limitations.at(-1),
        "Saved on <local-home>\\project; <local-home>",
      );
      assert.equal(
        f.bState.tasks.find((t) => t.id === task.id)!.run.state,
        "idle",
        "a remote session never starts a local worker",
      );
    }
    await f.restartB();
    assert.equal(
      f.bState.tasks.find((t) => t.id === "story-cursor")?.sharedSession?.review
        ?.metrics[0].cyclomatic,
      80,
    );
    await f.restartA();
    await f.a.synchronize("A");
    await f.b.synchronize("B");
    assert.equal(
      f.bState.tasks
        .find((t) => t.id === "story-codex")
        ?.sharedSession?.messages.at(-1)?.text,
      "Implemented by codex",
    );
  } finally {
    await f.close();
  }
});

test("a teammate's edited follow-up is received once and sealed atomically before prompt pickup", async () => {
  const f = await fixture();
  try {
    const task = await f.start("codex");
    const id = await f.b.sendSessionCommand(
      task.id,
      "followup",
      "First wording",
    );
    await f.b.synchronize("B");
    await f.a.synchronize("A");
    await f.b.synchronize("B");
    assert.equal(
      f.b.status("B")!.sessionCommands!.find((c) => c.id === id)!.state,
      "received",
    );
    await f.b.editSessionCommand(task.id, id, "Final wording");
    await f.a.prepareFollowups(task);
    assert.equal(task.messages.find((m) => m.id === id)!.text, "Final wording");
    assert.equal(task.messages.find((m) => m.id === id)!.actor!.name, "Bob");
    await f.b.synchronize("B");
    await assert.rejects(
      f.b.editSessionCommand(task.id, id, "Too late"),
      /picked up/,
    );
    await assert.rejects(
      f.b.editSessionCommand(task.id, id, undefined, true),
      /picked up/,
    );
    assert.equal(f.received.filter((value) => value === id).length, 1);
    assert.ok(task.messages.find((m) => m.id === id)!.pickedUpAt);
  } finally {
    await f.close();
  }
});

test("resuming a paused follow-up seals the peer's latest edit and skips their cancellation", async () => {
  const f = await fixture();
  try {
    const task = await f.start("claude");
    const edited = await f.b.sendSessionCommand(task.id, "followup", "First wording");
    const cancelled = await f.b.sendSessionCommand(task.id, "followup", "Will cancel");
    await f.b.synchronize("B");
    await f.a.synchronize("A");
    await f.b.synchronize("B");
    settleFollowupQueue(task, "paused");
    task.run.state = "failed";
    await f.a.release(task.id, "A");

    await f.b.editSessionCommand(task.id, edited, "Final wording");
    await f.b.editSessionCommand(task.id, cancelled, undefined, true);
    task.run = { state: "preparing", startedAt: "2026-11-18T19:01:00.000Z" };
    await f.a.acquire(task.id, "A");
    await f.a.prepareFollowups(task);
    const prompt = claimReviewContext(task.messages, "2026-11-18T19:01:01.000Z");

    assert.equal(prompt.find(message => message.id === edited)?.text, "Final wording");
    assert.ok(!prompt.some(message => message.id === cancelled));
    await f.b.synchronize("B");
    const commands = f.b.status("B")!.sessionCommands!;
    assert.equal(commands.find(command => command.id === edited)?.state, "picked-up");
    assert.equal(commands.find(command => command.id === cancelled)?.state, "cancelled");
    await assert.rejects(f.b.editSessionCommand(task.id, edited, "After pickup"), /picked up/);
    await assert.rejects(f.b.editSessionCommand(task.id, edited, undefined, true), /picked up/);
  } finally {
    await f.close();
  }
});

for (const harness of ["claude", "codex", "cursor"] as const)
  test(`${harness} retry seals a paused remote follow-up before consuming it`, async () => {
    const f = await fixture();
    try {
      const task = await f.start(harness);
      const id = await f.b.sendSessionCommand(task.id, "followup", "Before retry");
      await f.b.synchronize("B");
      await f.a.synchronize("A");
      assert.equal(settleFollowupQueue(task, "paused"), true);
      task.run.state = "failed";
      await f.b.synchronize("B");
      await f.b.editSessionCommand(task.id, id, "Edited while preparation was paused");
      await f.restartA();
      await f.a.prepareFollowups(task);
      const snapshot = claimReviewContext(task.messages, "2026-11-18T19:01:00.000Z");
      markReviewContext(task.messages, snapshot, "2026-11-18T19:01:01.000Z");
      await f.a.synchronize("A");
      await f.b.synchronize("B");
      const command = f.b.status("B")!.sessionCommands!.find(c => c.id === id)!;
      assert.equal(command.state, "picked-up");
      assert.equal(task.messages.find(m => m.id === id)!.text, command.text);
      assert.equal(command.text, "Edited while preparation was paused");
      assert.equal(f.received.filter(value => value === id).length, 1);
      await assert.rejects(f.b.editSessionCommand(task.id, id, "Too late"), /picked up/);
      await assert.rejects(f.b.editSessionCommand(task.id, id, undefined, true), /picked up/);
    } finally { await f.close(); }
  });

test("a host restart repairs a consumed follow-up receipt without delivering it again", async () => {
  const f = await fixture();
  try {
    const task = await f.start("claude");
    const id = await f.b.sendSessionCommand(task.id, "followup", "Already answered on the host");
    await f.b.synchronize("B");
    await f.a.synchronize("A");
    // Earlier versions consumed a locally paused request without sealing its remote receipt.
    task.messages.find(m => m.id === id)!.followupState = "paused";
    const snapshot = claimReviewContext(task.messages, "2026-11-18T19:01:00.000Z");
    markReviewContext(task.messages, snapshot, "2026-11-18T19:01:01.000Z");
    await f.restartA();
    await f.a.synchronize("A");
    await f.b.synchronize("B");
    const command = f.b.status("B")!.sessionCommands!.find(c => c.id === id)!;
    assert.equal(command.state, "picked-up");
    assert.equal(f.received.filter(value => value === id).length, 1);
    assert.ok(task.messages.find(m => m.id === id)!.promptedAt);
    await assert.rejects(f.b.editSessionCommand(task.id, id, "Too late"), /picked up/);
  } finally { await f.close(); }
});

test("a consumed receipt cannot acknowledge text edited after an older app's unsealed pickup", async () => {
  const f = await fixture();
  try {
    const task = await f.start("claude");
    const id = await f.b.sendSessionCommand(task.id, "followup", "Original consumed wording");
    await f.b.synchronize("B");
    await f.a.synchronize("A");
    const snapshot = claimReviewContext(task.messages, "2026-11-18T19:01:00.000Z");
    markReviewContext(task.messages, snapshot, "2026-11-18T19:01:01.000Z");
    await f.b.synchronize("B");
    await f.b.editSessionCommand(task.id, id, "Different wording not sent to the worker");
    await f.restartA();
    await f.a.synchronize("A");
    await f.b.synchronize("B");
    const command = f.b.status("B")!.sessionCommands!.find(c => c.id === id)!;
    assert.equal(command.state, "received");
    assert.equal(command.text, "Different wording not sent to the worker");
    assert.equal(task.messages.find(m => m.id === id)!.text, "Original consumed wording");
    assert.equal(f.received.filter(value => value === id).length, 1);
  } finally { await f.close(); }
});

test("cancel received input, recover an offline outbox and lost ACK without duplicate worker input", async () => {
  const f = await fixture();
  try {
    const task = await f.start("claude");
    const cancelled = await f.b.sendSessionCommand(
      task.id,
      "followup",
      "Cancel me",
    );
    await f.b.synchronize("B");
    await f.a.synchronize("A");
    await f.b.synchronize("B");
    await f.b.editSessionCommand(task.id, cancelled, undefined, true);
    await f.a.prepareFollowups(task);
    assert.equal(
      task.messages.find((m) => m.id === cancelled)!.followupState,
      "cancelled",
    );
    f.offline(true);
    const waiting = await f.b.sendSessionCommand(
      task.id,
      "followup",
      "Survive reconnect",
    );
    await f.restartB();
    assert.equal(
      f.b.status("B")!.sessionCommands!.find((c) => c.id === waiting)!.state,
      "queued",
    );
    f.offline(false);
    f.dropAck();
    await f.b.synchronize("B");
    await f.b.synchronize("B");
    await f.a.synchronize("A");
    await f.a.synchronize("A");
    assert.equal(task.messages.filter((m) => m.id === waiting).length, 1);
    const saved = JSON.parse(
      await readFile(join(f.root, "b/team/connections.json"), "utf8"),
    );
    assert.equal(saved.connections[0].sessionOutbox.length, 0);
  } finally {
    await f.close();
  }
});

test("session ownership fences old hosts and authors cannot impersonate teammates", async () => {
  const f = await fixture();
  try {
    const task = await f.start("codex"),
      board = structuredClone(f.a.status("A")!.workspace);
    const session = structuredClone(f.a.status("A")!.sessions![0]),
      state = emptySessions();
    // The transport fixture has matching story identifiers on both profiles.
    session.storyId = task.id;
    state.sessions = [session];
    state.cursor = session.sequence;
    const host = session.owner,
      other = board.members.find((m) => m.id !== host.memberId)!;
    const peer = {
      memberId: other.id,
      name: other.name,
      deviceId: other.devices[0].id,
      device: other.devices[0].name,
    };
    const input = sessionPublish.parse({
      workspaceId: board.workspaceId,
      expectedRevision: session.revision,
      session: {
        id: session.id,
        storyId: task.id,
        epoch: session.epoch,
        harness: "codex",
        state: "running",
        messages: [
          {
            id: "forged",
            role: "user",
            text: "Cannot forge an author",
            at,
            actor: peer,
          },
        ],
      },
    });
    assert.throws(
      () => publishSession(state, board, peer, input, at),
      /executing device/,
    );
    const published = publishSession(state, board, host, input, at);
    assert.equal(published.kind, "worker_session");
    if (published.kind === "worker_session")
      assert.deepEqual(published.session.messages[0].actor, host);
    const record = addSessionCommand(
      state,
      board,
      peer,
      {
        workspaceId: board.workspaceId,
        id: "remote-input",
        sessionId: session.id,
        kind: "followup",
        text: "From peer",
      },
      at,
    );
    applySessionRecord(state, record);
    assert.throws(
      () =>
        editSessionCommand(
          state,
          host,
          {
            workspaceId: board.workspaceId,
            id: "remote-input",
            expectedRevision: 1,
            text: "Stolen edit",
          },
          at,
        ),
      /Only its author/,
    );
    assert.throws(
      () =>
        receiptSessionCommand(
          state,
          board,
          peer,
          {
            workspaceId: board.workspaceId,
            id: "remote-input",
            state: "picked-up",
          },
          at,
        ),
      /executing device/,
    );
    board.claims = [
      {
        ...board.claims[0],
        attemptId: "new-claim",
        epoch: session.epoch + 1,
        memberId: peer.memberId,
        deviceId: peer.deviceId,
      },
    ];
    assert.throws(
      () => publishSession(state, board, host, input, at),
      /Another worker/,
    );
    assert.throws(
      () =>
        receiptSessionCommand(
          state,
          board,
          host,
          {
            workspaceId: board.workspaceId,
            id: "remote-input",
            state: "picked-up",
          },
          at,
        ),
      /Another worker/,
    );
  } finally {
    await f.close();
  }
});

test("delta publication and durable journal replay retain earlier messages and every native metric", async () => {
  const f = await fixture();
  try {
    const task = await f.start("claude"),
      run = report(task.id, "claude");
    f.a.reviewSaved(run);
    task.messages.push({
      id: "answer",
      role: "assistant",
      text: "First answer",
      at,
    });
    await f.a.synchronize("A");
    await f.b.synchronize("B");
    task.messages.push({
      id: "answer2",
      role: "assistant",
      text: "Second answer",
      at,
    });
    await f.a.synchronize("A");
    await f.b.synchronize("B");
    const session = f.bState.tasks.find(
      (t) => t.id === task.id,
    )!.sharedSession!;
    assert.equal(session.messages.length, 3);
    assert.equal(session.review!.metrics[0].maintainabilityIndex, 0);
    await f.restartA();
    await f.a.synchronize("A");
    await f.b.synchronize("B");
    const restored = f.bState.tasks.find(
      (t) => t.id === task.id,
    )!.sharedSession!;
    assert.deepEqual(
      restored.messages.map((m) => m.text),
      session.messages.map((m) => m.text),
    );
    assert.deepEqual(restored.review!.metrics, run.metrics);
    const journal = await readFile(
      join(
        f.root,
        "a/team/relay/workspaces",
        f.a.status("A")!.workspace.workspaceId + ".jsonl",
      ),
      "utf8",
    );
    const updates = journal
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === "worker_session");
    const delivery = updates.findLast((r) =>
      r.session.messages.some((m: any) => m.id === "answer2"),
    );
    assert.equal(delivery.delta, true);
    assert.equal(delivery.session.messages.length, 1);
    assert.equal(
      delivery.session.review,
      undefined,
      "An unchanged report is not copied into each progress event",
    );
  } finally {
    await f.close();
  }
});
