import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime/app";
import type { BetaCredentials, BetaStoredState } from "../runtime/beta";
import type { AppState, Project, WorkItem } from "../src/shared";
import type { StoryComment } from "../src/story-comments";
import type { SharingOverview, SharingSettings } from "../src/sharing";
import { refusalSentences } from "../src/sharing-refusals";
import { signedInBetaStore } from "./support/beta-session";
import { actingAs } from "./support/memsync-owner";
import { until } from "./support/board-computers";
import {
  startStandInMemsync,
  type StandInMemsync,
  type StandInPerson,
} from "./support/memsync-stand-in";
import { cast } from "./support/projects-api-scenarios";

const encoded = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** memtrace.io's token endpoint: the stored session's three values in, a token out. */
async function tokenEndpointFor(
  session: BetaCredentials,
  issue: () => { token: string } | { status: number },
) {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (part) => (body += part));
    request.on("end", () => {
      const sent = JSON.parse(body);
      requests.push(sent);
      const known =
        request.method === "POST" &&
        request.url === "/api/memcode/memsync/token" &&
        Object.keys(sent).sort().join() ===
          "device_id,refresh_token,session_id" &&
        sent.refresh_token === session.refreshToken &&
        sent.device_id === session.deviceId &&
        sent.session_id === session.sessionId;
      const issued = known ? issue() : { status: 401 };
      response.writeHead("token" in issued ? 200 : issued.status, {
        "content-type": "application/json",
      });
      response.end(
        "token" in issued
          ? JSON.stringify({
              access_token: issued.token,
              token_type: "Bearer",
              expires_in: 600,
            })
          : "{}",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/memcode/memsync/token`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The whole local runtime, signed in to the beta, beside a stand-in memtrace.io and sharing service. */
async function fixture(
  signedIn = true,
  beside?: { service: StandInMemsync; people: ReturnType<typeof cast> },
) {
  const root = await mkdtemp(join(tmpdir(), "memcode-sharing-runtime-"));
  const service = beside?.service ?? (await startStandInMemsync());
  const people = beside?.people ?? cast();
  const me: StandInPerson = people.alex;
  const stored: BetaStoredState = signedIn
    ? signedInBetaStore(
        { id: me.accountId, name: me.name, email: me.email },
        join(root, "access.jwt"),
      )
    : { configured: false, credentials: null };
  let serial = 0;
  const tokens = await tokenEndpointFor(
    (stored.credentials ?? {}) as BetaCredentials,
    () => {
      const token = [
        encoded({ alg: "EdDSA", typ: "JWT" }),
        encoded({ sub: me.accountId, serial: ++serial }),
        "c2lnbmF0dXJl",
      ].join(".");
      service.admit(token, me);
      return { token };
    },
  );
  const native: string[] = [];
  const emitted: string[] = [];
  /** What the stand-in memtrace.io lists for sharing. Missing: not offered. */
  let offered: SharingSettings | undefined = {
    memsyncUrl: service.address.href,
    tokenUrl: tokens.url,
  };
  const start = () =>
    createRuntime(
      join(root, "profile"),
      root,
      {
        async call<T>(method: string): Promise<T> {
          native.push(method);
          if (method === "beta_store_read") return structuredClone(stored) as T;
          throw Error("Unexpected native operation " + method);
        },
      },
      (event) => emitted.push(event),
      { findSharing: async () => offered },
    );
  const runtime = { current: await start() };
  const project: Project = {
    id: "local-web",
    name: "website",
    description: "",
    path: join(root, "website"),
    branch: "main",
    analysis: "idle",
    createdAt: "2026-11-21T12:00:00.000Z",
  };
  runtime.current.store.state.projects.push(project);
  const request = <T>(method: string, input?: unknown) =>
    runtime.current.request(method, input) as Promise<T>;
  return {
    root,
    service,
    people,
    me,
    tokens,
    native,
    emitted,
    request,
    state: () => runtime.current.store.state,
    offer: (sharing: SharingSettings | undefined) => {
      offered = sharing;
    },
    website: (person: StandInPerson) =>
      actingAs(service.address, service.tokenFor(person)),
    async restart() {
      await runtime.current.close();
      runtime.current = await start();
    },
    async close() {
      await runtime.current.close();
      await tokens.close();
      if (!beside) await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("sharing is there only while memtrace.io lists it, and nothing about it is typed or kept", async () => {
  const f = await fixture();
  try {
    f.offer(undefined);
    assert.deepEqual(await f.request("sharing:overview"), { state: "not-set" });
    await assert.rejects(
      f.request("sharing:share", { projectId: "local-web" }),
      /not available/,
    );
    assert.equal(f.tokens.requests.length, 0);
    f.offer({ memsyncUrl: "http://sync.example.com", tokenUrl: f.tokens.url });
    const unsafe = await f.request<SharingOverview>("sharing:overview");
    assert.equal(unsafe.state, "unavailable");
    assert.match((unsafe as { detail: string }).detail, /https:\/\//);
    assert.equal(f.tokens.requests.length, 0);
    f.offer({ memsyncUrl: f.service.address.href, tokenUrl: f.tokens.url });
    assert.equal(
      (await f.request<SharingOverview>("sharing:overview")).state,
      "ready",
    );
    await assert.rejects(
      f.request("settings:save", {
        ...f.state().settings,
        sharing: { memsyncUrl: "x", tokenUrl: "y" },
      }),
    );
    const saved: AppState = JSON.parse(
      await readFile(join(f.root, "profile", "workspace.json"), "utf8"),
    );
    assert.equal("sharing" in saved.settings, false);
  } finally {
    await f.close();
  }
});

test("a signed-in MemCode lists shared projects, accepts an invitation and connects the open project", async () => {
  const f = await fixture();
  const { dana } = f.people;
  try {
    const mine = await f.website(f.me).startProject("Launch plan");
    const theirs = await f.website(dana).startProject("Website");
    const invitation = await f.website(dana).invite(theirs, f.me.email!);

    const before = await f.request<SharingOverview>("sharing:overview");
    assert.equal(before.state, "ready");
    if (before.state !== "ready") return;
    assert.deepEqual(
      before.projects.map((project) => project.name),
      ["Launch plan"],
    );
    assert.deepEqual(
      before.invitations.map((waiting) => [
        waiting.projectName,
        waiting.invitedBy,
      ]),
      [["Website", dana.name]],
    );
    // One exchange served every call: the token is renewed, not asked for each time.
    assert.equal(f.tokens.requests.length, 1);

    const after = await f.request<SharingOverview>(
      "sharing:accept-invitation",
      {
        projectId: theirs,
        invitationId: invitation,
      },
    );
    assert.equal(after.state, "ready");
    if (after.state !== "ready") return;
    assert.deepEqual(
      after.projects.map((project) => [project.name, project.youAreOwner]),
      [
        ["Launch plan", true],
        ["Website", false],
      ],
    );
    assert.deepEqual(after.invitations, []);

    f.emitted.length = 0;
    await f.request("sharing:connect", {
      projectId: "local-web",
      sharedProjectId: mine,
    });
    assert.deepEqual(
      f
        .state()
        .sharedProjectLinks?.map((link) => [
          link.projectId,
          link.sharedProjectName,
        ]),
      [["local-web", "Launch plan"]],
    );
    assert.ok(
      f.emitted.includes("workspace:state"),
      "the app's window hears of the link",
    );
    const saved: AppState = JSON.parse(
      await readFile(join(f.root, "profile", "workspace.json"), "utf8"),
    );
    assert.equal(saved.sharedProjectLinks?.[0].sharedProjectId, mine);
    assert.equal("sharing" in saved.settings, false);
    // Neither the session nor a token is written to the workspace file or sent to the window.
    const session = (await f.tokens.requests[0]) as { refresh_token: string };
    assert.ok(!JSON.stringify(saved).includes(session.refresh_token));
    assert.ok(!JSON.stringify(saved).includes("c2lnbmF0dXJl"));

    await f.restart();
    assert.equal(f.state().sharedProjectLinks?.[0].sharedProjectId, mine);
    assert.equal(
      (await f.request<SharingOverview>("sharing:overview")).state,
      "ready",
    );

    await assert.rejects(
      f.request("sharing:connect", {
        projectId: "local-web",
        sharedProjectId: theirs,
      }),
      /already connected to “Launch plan”/,
    );
    await f.request("sharing:disconnect", { projectId: "local-web" });
    assert.deepEqual(f.state().sharedProjectLinks, []);
    await f.website(dana).deleteProject(theirs);
    await assert.rejects(
      f.request("sharing:connect", {
        projectId: "local-web",
        sharedProjectId: theirs,
      }),
      { message: refusalSentences.no_such_project },
    );
  } finally {
    await f.close();
  }
});

test("without a beta sign-in, sharing asks the person to sign in and contacts nobody", async () => {
  const f = await fixture(false);
  try {
    const overview = await f.request<SharingOverview>("sharing:overview");
    assert.equal(overview.state, "signed-out");
    assert.equal(f.tokens.requests.length, 0);
    assert.equal(f.service.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("requests are checked before they run", async () => {
  const f = await fixture();
  try {
    for (const [method, input] of [
      ["sharing:manage", undefined],
      ["sharing:share", {}],
      ["sharing:invite", { projectId: "local-web", email: "" }],
      ["sharing:invite", { projectId: "local-web" }],
      ["sharing:cancel-invitation", { projectId: "local-web" }],
      ["sharing:remove-person", { projectId: "local-web" }],
      ["sharing:leave", { projectId: "" }],
      ["sharing:open", {}],
      ["sharing:join", { sharedProjectId: "x" }],
      ["sharing:connect", { projectId: "local-web" }],
      [
        "sharing:connect",
        { projectId: "local-web", sharedProjectId: "x", extra: 1 },
      ],
      ["sharing:accept-invitation", { projectId: "", invitationId: "x" }],
      ["sharing:disconnect", {}],
      ["sharing:overview", { anything: true }],
    ] as const)
      await assert.rejects(
        f.request(method, input),
        `${method} ${JSON.stringify(input)}`,
      );
  } finally {
    await f.close();
  }
});

test("connecting through sharing makes no Team room, and Team's own requests are still there", async () => {
  const f = await fixture();
  try {
    const mine = await f.website(f.me).startProject("Launch plan");
    await f.request("sharing:connect", {
      projectId: "local-web",
      sharedProjectId: mine,
    });
    assert.equal(
      await f.request("team:status", { projectId: "local-web" }),
      null,
    );
    assert.equal(f.state().team?.length ?? 0, 0);
  } finally {
    await f.close();
  }
});

test("a board connected on two computers of one person follows what is done in the app on either", async () => {
  const mac = await fixture();
  const pc = await fixture(true, mac);
  const tasksOf = (f: typeof mac) =>
    f.state().tasks.filter((task) => task.projectId === "local-web");
  const boardOf = (f: typeof mac) => f.state().sharedBoards?.[0];
  try {
    // The Mac has a goal with two tasks, made in the app.
    const goal = await mac.request<{ id: string }>("epic:create", {
      projectId: "local-web",
      title: "Customers can export reports",
      description: "As CSV and as PDF.",
      phase: "now",
    });
    const made: WorkItem[] = [];
    for (const title of ["Export as CSV", "Export as PDF"])
      made.push(
        await mac.request<WorkItem>("task:create", {
          projectId: "local-web",
          title,
          description: `What “${title}” means.`,
          priority: "medium",
          harness: mac.state().settings.defaultHarness,
          epicId: goal.id,
        }),
      );
    const shared = await mac.website(mac.me).startProject("Website");
    await mac.request("sharing:connect", {
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await until(() => boardOf(mac)?.state === "synced", "the Mac's board");
    assert.ok(mac.service.boards.log(shared).length > 0);

    // The PC connects its own, empty project to the same shared project.
    await pc.request("sharing:connect", {
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await until(
      () => tasksOf(pc).length === 2 && boardOf(pc)?.state === "synced",
      "the PC to take the board",
    );
    assert.deepEqual(
      tasksOf(pc).map((task) => [task.identifier, task.title, task.epicId]),
      made.map((task) => [task.identifier, task.title, goal.id]),
    );
    // It is in the PC's workspace file, and the window was told.
    const onDisk = JSON.parse(
      await readFile(join(pc.root, "profile", "workspace.json"), "utf8"),
    ) as AppState;
    assert.equal(
      onDisk.tasks.filter((task) => task.projectId === "local-web").length,
      2,
    );
    assert.equal(onDisk.sharedProjectLinks![0].applied, 1);
    assert.ok(pc.emitted.includes("workspace:state"));

    // Work goes on from the PC: a task is moved and renamed, and a comment is written.
    await pc.request("task:update", {
      id: made[0].id,
      patch: { title: "Export as CSV, continued on the PC", stage: "working" },
    });
    const comment = await pc.request<StoryComment>("story-comment:add", {
      taskId: made[0].id,
      text: "Picked this up on the PC.",
    });
    assert.deepEqual(comment.author, {
      id: pc.me.accountId,
      name: pc.me.name,
      source: "memtrace",
    });
    await until(
      () =>
        tasksOf(mac).find((task) => task.id === made[0].id)?.stage ===
          "working" && (mac.state().storyComments ?? []).length === 1,
      "the Mac to see what was done on the PC",
    );
    const onMac = tasksOf(mac).find((task) => task.id === made[0].id)!;
    assert.equal(onMac.title, "Export as CSV, continued on the PC");
    assert.deepEqual(mac.state().storyComments![0].author, comment.author);
    assert.equal(
      mac.state().storyComments![0].text,
      "Picked this up on the PC.",
    );
    // The person may change their own comment from the other computer.
    await mac.request("story-comment:edit", {
      taskId: made[0].id,
      id: comment.id,
      text: "Picked this up on the PC, finished on the Mac.",
    });
    await until(
      () =>
        pc.state().storyComments?.[0].text ===
        "Picked this up on the PC, finished on the Mac.",
      "the PC to see the comment change",
    );

    // A goal, a cycle and a task made on the PC are on the Mac without a restart.
    const scheduled = await pc.request<{ id: string }>("epic:create", {
      projectId: "local-web",
      title: "Exports can be scheduled",
      description: "",
      phase: "next",
    });
    const week = await pc.request<{ id: string }>("cycle:create", {
      projectId: "local-web",
      name: "Week 48",
      goal: "Schedule the first export",
      startDate: "2026-11-23",
      endDate: "2026-11-29",
      timeZone: "Europe/Copenhagen",
      capacity: null,
      calendar: "weekdays",
    });
    const weekly = await pc.request<WorkItem>("task:create", {
      projectId: "local-web",
      title: "Schedule a weekly export",
      description: "",
      priority: "medium",
      harness: pc.state().settings.defaultHarness,
      epicId: scheduled.id,
      cycleId: week.id,
    });
    await until(
      () =>
        mac.state().epics.some((goal) => goal.id === scheduled.id) &&
        mac.state().cycles.some((cycle) => cycle.id === week.id) &&
        tasksOf(mac).some((task) => task.id === weekly.id),
      "the Mac to show the goal, the cycle and the task made on the PC",
    );
    const arrived = tasksOf(mac).find((task) => task.id === weekly.id)!;
    assert.equal(arrived.identifier, weekly.identifier);
    assert.equal(arrived.epicId, scheduled.id);
    assert.equal(arrived.cycleId, week.id);
    // The Mac starts the cycle and moves the task; the PC follows.
    await mac.request("cycle:start", week.id);
    await mac.request("task:update", {
      id: weekly.id,
      patch: { stage: "working" },
    });
    await until(
      () =>
        pc.state().cycles.find((cycle) => cycle.id === week.id)?.state ===
          "active" &&
        tasksOf(pc).find((task) => task.id === weekly.id)?.stage === "working",
      "the PC to see the cycle start and the task move",
    );

    // A project that is not shared is as it always was: nothing of it is sent.
    const unshared: Project = {
      id: "local-private",
      name: "private notes",
      description: "",
      path: join(mac.root, "private"),
      branch: "main",
      analysis: "idle",
      createdAt: "2026-11-21T12:00:00.000Z",
    };
    mac.state().projects.push(unshared);
    const sentBefore = mac.service.boards.log(shared).length;
    const mine = await mac.request<WorkItem>("task:create", {
      projectId: "local-private",
      title: "Only on this computer",
      description: "",
      priority: "medium",
      harness: mac.state().settings.defaultHarness,
    });
    await mac.request("task:update", {
      id: mine.id,
      patch: { stage: "working" },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(mac.service.boards.log(shared).length, sentBefore);
    assert.equal(
      pc.state().tasks.some((task) => task.id === mine.id),
      false,
    );
    assert.deepEqual(
      mac.state().sharedBoards!.map((board) => board.projectId),
      ["local-web"],
    );
    assert.equal(
      mac.state().tasks.find((task) => task.id === mine.id)?.stage,
      "working",
    );

    // The PC is restarted. What the Mac does meanwhile is there afterwards.
    await pc.restart();
    await mac.request("task:update", {
      id: made[1].id,
      patch: { title: "Export as PDF, while the PC was off" },
    });
    await until(
      () =>
        tasksOf(pc).find((task) => task.id === made[1].id)?.title ===
        "Export as PDF, while the PC was off",
      "the restarted PC to catch up",
    );

    // Disconnecting on the PC leaves the board there and the Mac alone.
    await pc.request("sharing:disconnect", { projectId: "local-web" });
    assert.deepEqual(pc.state().sharedBoards, []);
    assert.equal(tasksOf(pc).length, 3);
    // The same board, connected again, is still one board: nothing is added to the log.
    const logged = mac.service.boards.log(shared).length;
    await pc.request("sharing:connect", {
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await until(() => boardOf(pc)?.state === "synced", "the PC to be back");
    assert.equal(mac.service.boards.log(shared).length, logged);
    assert.equal(tasksOf(pc).length, 3);

    // A project with tasks of its own is not connected to a board that has work.
    const other: Project = {
      id: "local-other",
      name: "another project",
      description: "",
      path: join(pc.root, "another"),
      branch: "main",
      analysis: "idle",
      createdAt: "2026-11-21T12:00:00.000Z",
    };
    pc.state().projects.push(other);
    await pc.request("task:create", {
      projectId: "local-other",
      title: "A task of its own",
      description: "",
      priority: "medium",
      harness: pc.state().settings.defaultHarness,
    });
    await pc.request("sharing:disconnect", { projectId: "local-web" });
    await assert.rejects(
      pc.request("sharing:connect", {
        projectId: "local-other",
        sharedProjectId: shared,
      }),
      /: another project already has work of its own, so it cannot join Website: connect a project that has none yet\.$/,
    );
    assert.deepEqual(pc.state().sharedProjectLinks, []);
    assert.equal(mac.service.boards.log(shared).length, logged);
  } finally {
    await pc.close();
    await mac.close();
  }
});

test("a worker run on the Mac is on the PC's card when it is opened there, and a follow-up from the PC continues it", async () => {
  const mac = await fixture();
  const pc = await fixture(true, mac);
  try {
    const goal = await mac.request<{ id: string }>("epic:create", {
      projectId: "local-web",
      title: "Customers can export reports",
      description: "",
      phase: "now",
    });
    const made = await mac.request<WorkItem>("task:create", {
      projectId: "local-web",
      title: "Export as CSV",
      description: "Write the CSV export.",
      priority: "medium",
      harness: mac.state().settings.defaultHarness,
      epicId: goal.id,
    });
    const shared = await mac.website(mac.me).startProject("Website");
    await mac.request("sharing:connect", {
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await pc.request("sharing:connect", {
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await until(
      () => pc.state().tasks.some((task) => task.id === made.id),
      "the PC to have the task",
    );
    // The PC opens the card.
    await pc.request("sharing:follow-card", { taskId: made.id });
    // A worker runs on the Mac: what it says is saved with the workspace.
    const onMac = mac.state().tasks.find((task) => task.id === made.id)!;
    onMac.run = {
      state: "running",
      startedAt: new Date().toISOString(),
      activity: {
        phase: "reading",
        label: "Reading",
        at: new Date().toISOString(),
      },
    } as never;
    onMac.messages.push({
      id: "reply-1",
      role: "assistant",
      text: "Found the export in src/export.ts.",
      at: new Date().toISOString(),
    });
    await mac.request("task:update", {
      id: made.id,
      patch: { priority: "high" },
    });
    const onPc = () => pc.state().tasks.find((task) => task.id === made.id)!;
    await until(
      () =>
        !!onPc().sharedSession?.messages.some(
          (message) => message.id === "reply-1",
        ),
      "the PC's card to show the Mac's run",
    );
    assert.equal(onPc().sharedFromLog, true);
    assert.equal(onPc().sharedSession!.owner.name, mac.me.name);
    assert.equal(onPc().sharedSession!.state, "running");
    assert.equal(onPc().run.state, "idle");
    assert.ok(pc.emitted.includes("workspace:state"));
    // The same person on the PC continues the Mac's worker through the card's log.
    const { messageId } = await pc.request<{ messageId: string }>(
      "review:send",
      { taskId: made.id, text: "Also add a header row." },
    );
    await until(
      () =>
        onMac.messages.some(
          (message) =>
            message.id === messageId && message.followupState === "queued",
        ),
      "the Mac to queue the PC's follow-up for its worker",
    );
    assert.equal(
      onMac.messages.find((message) => message.id === messageId)!.actor?.name,
      mac.me.name,
    );
    await until(
      () =>
        onPc().sharedSession?.messages.find(
          (message) => message.id === messageId,
        )?.deliveryLine === "Queued on your Mac",
      "the PC to see it queued on the Mac",
    );
    // Nothing runs on the PC: its own task holds no new turn.
    assert.equal(
      onPc().messages.some((message) => /header row/.test(message.text)),
      false,
    );
    assert.equal(
      await pc.request("code-review:get", { taskId: made.id }),
      null,
    );
    assert.deepEqual(await pc.request("worker:changes", made.id), {
      taskId: made.id,
      checkpoints: [],
      additions: 0,
      deletions: 0,
      files: 0,
    });
    await pc.request("sharing:unfollow-card", { taskId: made.id });
  } finally {
    await pc.close();
    await mac.close();
  }
});
