import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createServer as createHttp2Server,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { initialState } from "../src/seed";
import type { AppState, Project } from "../src/shared";
import type { SharingOverview, SharingSettings } from "../src/sharing";
import { refusalSentences } from "../src/sharing-refusals";
import { Sharing, type CardHost } from "../runtime/sharing/sharing";
import { shareableFile } from "../runtime/sharing/cards/files";
import type { WorkerChanges } from "../src/changes";
import {
  startStandInMemsync,
  type StandInMemsync,
  type StandInPerson,
} from "./support/memsync-stand-in";
import { giveWork, task, until } from "./support/board-computers";
import { actingAs } from "./support/memsync-owner";
import { cast } from "./support/projects-api-scenarios";

const tokenUrl = "http://127.0.0.1:9/api/memcode/memsync/token";
const at = "2026-11-21T12:00:00.000Z";
const localProject = (id: string, name: string): Project => ({
  id,
  name,
  description: "",
  path: `/work/${name}`,
  branch: "main",
  analysis: "idle",
  createdAt: at,
});
const encoded = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** MemCode's sharing with a sign-in the test controls, a stand-in memtrace.io and a stand-in service. */
async function fixture(beside?: {
  service: StandInMemsync;
  people: ReturnType<typeof cast>;
}) {
  const service = beside?.service ?? (await startStandInMemsync());
  const people = beside?.people ?? cast();
  const state: AppState = initialState();
  state.projects.push(
    localProject("local-web", "website"),
    localProject("local-app", "app"),
  );
  state.activeProjectId = "local-web";
  const world = {
    /** Where memtrace.io says sharing lives. Missing: sharing is not offered. */
    addresses: { memsyncUrl: service.address.href, tokenUrl } as
      SharingSettings | undefined,
    signedIn: people.alex as StandInPerson | null,
    sessionId: "session-1234567890abcdef",
    saves: 0,
    exchanges: [] as string[],
    tokenEndpointStatus: 200,
    admitAt: service as StandInMemsync,
    /** What each task changed, as this computer's Changes tab would show it. */
    changes: new Map<string, WorkerChanges>(),
  };
  let serial = 0;
  const issueToken = (async (url) => {
    world.exchanges.push(String(url));
    if (world.tokenEndpointStatus !== 200)
      return new Response("{}", { status: world.tokenEndpointStatus });
    const token = [
      encoded({ alg: "EdDSA", typ: "JWT" }),
      encoded({ sub: world.signedIn!.accountId, serial: ++serial }),
      "c2lnbmF0dXJl",
    ].join(".");
    world.admitAt.admit(token, world.signedIn!);
    return Response.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: 600,
    });
  }) as typeof fetch;
  const boardsFolder = await mkdtemp(join(tmpdir(), "memcode-sharing-"));
  const dataDir = join(boardsFolder, "profile");
  const cards: CardHost = {
    reviewOf: async () => null,
    shareableFile: (taskId, artifactId) =>
      shareableFile(dataDir, state, taskId, artifactId),
    changesOf: async (taskId) =>
      world.changes.get(taskId) ?? {
        taskId,
        checkpoints: [],
        additions: 0,
        deletions: 0,
        files: 0,
      },
    filesFolder: (taskId) => join(dataDir, "captures", taskId),
  };
  const sharing = new Sharing({
    state: () => state,
    changed: async () => {
      world.saves++;
      await sharing.workspaceSaved();
    },
    boardsFolder,
    cards,
    saveWorkspace: async (first) => {
      await first();
      world.saves++;
    },
    session: async () =>
      world.signedIn && {
        refreshToken: "refresh-" + "r".repeat(40),
        deviceId: "device-1234567890abcdef",
        sessionId: world.sessionId,
        accountId: world.signedIn.accountId,
      },
    now: () => at,
    fetcher: issueToken,
    addresses: async () => world.addresses,
    makeProject: async (name) => {
      const made: Project = {
        ...localProject(`made-${++serial}`, name),
        path: null,
      };
      state.projects.push(made);
      state.activeProjectId = made.id;
      return made;
    },
  });
  const as = (person: StandInPerson) =>
    actingAs(service.address, service.tokenFor(person));
  return {
    service,
    people,
    state,
    world,
    sharing,
    as,
    boardsFolder,
    dataDir,
    /** MemCode is started again on the same profile: what was kept is still there. */
    restarted: () =>
      new Sharing({
        state: () => state,
        changed: async () => void world.saves++,
        boardsFolder,
        saveWorkspace: async (first) => {
          await first();
          world.saves++;
        },
        session: async () =>
          world.signedIn && {
            refreshToken: "refresh-" + "r".repeat(40),
            deviceId: "device-1234567890abcdef",
            sessionId: world.sessionId,
            accountId: world.signedIn.accountId,
          },
        fetcher: issueToken,
        addresses: async () => world.addresses,
      }),
    close: async () => {
      await sharing.close();
      if (!beside) await service.close();
      await rm(boardsFolder, { recursive: true, force: true });
    },
  };
}
/** Waits until board sync has nothing left to do for the connected projects. */
const boardsSynced = (
  f: { state: AppState },
  boards: number,
  state = "synced",
) =>
  until(
    () =>
      f.state.sharedBoards?.length === boards &&
      f.state.sharedBoards.every((board) => board.state === state),
    () => `the boards to be ${state}: ${JSON.stringify(f.state.sharedBoards)}`,
  );
/** The folders kept for connected boards. Beside them is this computer's id for card logs. */
const boardFolders = async (folder: string) =>
  (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
type Ready = Extract<SharingOverview, { state: "ready" }>;
const ready = (overview: SharingOverview): Ready => {
  assert.equal(overview.state, "ready", JSON.stringify(overview));
  return overview as Ready;
};
const quiet = (context: test.TestContext) =>
  context.mock.method(console, "error", () => {});

test("sharing memtrace.io does not offer is absent: nobody is asked anything", async () => {
  const f = await fixture();
  try {
    f.world.addresses = undefined;
    assert.deepEqual(await f.sharing.overview(), { state: "not-set" });
    await assert.rejects(
      f.sharing.connect({ projectId: "local-web", sharedProjectId: "any" }),
      /not available/,
    );
    await assert.rejects(f.sharing.shareProject("local-web"), /not available/);
    assert.equal(f.world.exchanges.length, 0);
    assert.equal(f.service.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("the overview lists my projects and the invitations waiting for me", async () => {
  const f = await fixture();
  const { alex, bo, dana, chidiAddress } = f.people;
  try {
    const launch = await f.as(alex).startProject("Launch plan");
    await f.as(bo).startProject("Bo's own project");
    const forBo = await f.as(alex).invite(launch, bo.email!);
    f.world.signedIn = bo;
    f.world.sessionId = "session-bo-1234567890abcdef";
    await f.sharing.acceptInvitation({
      projectId: launch,
      invitationId: forBo,
    });
    f.world.signedIn = alex;
    f.world.sessionId = "session-1234567890abcdef";
    const forChidi = await f.as(alex).invite(launch, chidiAddress);
    const website = await f.as(dana).startProject("Website");
    const forAlex = await f.as(dana).invite(website, alex.email!);

    const mine = ready(await f.sharing.overview());
    assert.equal(mine.accountId, alex.accountId);
    assert.equal(mine.service, f.service.address.href);
    assert.deepEqual(mine.projects, [
      {
        id: launch,
        name: "Launch plan",
        owner: { id: alex.accountId, name: alex.name, isYou: true },
        guests: [{ id: bo.accountId, name: bo.name, isYou: false }],
        youAreOwner: true,
        openInvitations: [{ id: forChidi, email: chidiAddress, sentAt: at }],
        guestLimit: 2,
      },
    ]);
    assert.equal(mine.invitations.length, 1);
    assert.deepEqual(
      { ...mine.invitations[0], expiresAt: "" },
      {
        id: forAlex,
        projectId: website,
        projectName: "Website",
        invitedBy: dana.name,
        expiresAt: "",
      },
    );
    assert.ok(Date.parse(mine.invitations[0].expiresAt) > Date.parse(at));
    // Other people's email addresses never reach the app's window. The owner
    // sees the addresses they invited, to cancel an invitation.
    const shown = JSON.stringify(mine);
    for (const hidden of [bo.email!, dana.email!])
      assert.ok(!shown.includes(hidden), hidden);

    f.world.signedIn = bo;
    f.world.sessionId = "session-bo-1234567890abcdef";
    const asGuest = ready(await f.sharing.overview());
    assert.deepEqual(
      asGuest.projects.map((project) => [project.name, project.youAreOwner]),
      [
        ["Bo's own project", true],
        ["Launch plan", false],
      ],
    );
    assert.deepEqual(asGuest.projects[1].guests, [
      { id: bo.accountId, name: bo.name, isYou: true },
    ]);
    assert.deepEqual(asGuest.projects[1].owner, {
      id: alex.accountId,
      name: alex.name,
      isYou: false,
    });
    // A guest sees that a place is taken by an invitation, not whose address it is.
    assert.deepEqual(asGuest.projects[1].openInvitations, [
      { id: forChidi, email: "", sentAt: at },
    ]);
    assert.ok(!JSON.stringify(asGuest).includes(chidiAddress));
  } finally {
    await f.close();
  }
});

test("accepting an invitation answers with the lists as they are now", async () => {
  const f = await fixture();
  const { alex, dana } = f.people;
  try {
    const website = await f.as(dana).startProject("Website");
    const forAlex = await f.as(dana).invite(website, alex.email!);
    const after = ready(
      await f.sharing.acceptInvitation({
        projectId: website,
        invitationId: forAlex,
      }),
    );
    assert.deepEqual(after.invitations, []);
    assert.deepEqual(
      after.projects.map((project) => [project.name, project.youAreOwner]),
      [["Website", false]],
    );
  } finally {
    await f.close();
  }
});

test("a refusal reaches the person as the sentence for its rule", async () => {
  const f = await fixture();
  const { alex, dana } = f.people;
  try {
    const website = await f.as(dana).startProject("Website");
    await assert.rejects(
      f.sharing.acceptInvitation({
        projectId: website,
        invitationId: "no-such-id",
      }),
      { message: refusalSentences.no_such_invitation },
    );
    await assert.rejects(
      f.sharing.connect({ projectId: "local-web", sharedProjectId: website }),
      { message: refusalSentences.no_such_project },
    );
    assert.equal(f.state.sharedProjectLinks, undefined);
    assert.equal(alex.accountId.length > 0, true);
  } finally {
    await f.close();
  }
});

test("without a Memtrace sign-in the overview says so, and nothing is sent", async () => {
  const f = await fixture();
  try {
    f.world.signedIn = null;
    const overview = await f.sharing.overview();
    assert.equal(overview.state, "signed-out");
    assert.match(
      (overview as { detail: string }).detail,
      /Sign in to Memtrace/,
    );
    await assert.rejects(
      f.sharing.acceptInvitation({ projectId: "p", invitationId: "i" }),
      /Sign in to Memtrace/,
    );
    assert.equal(f.world.exchanges.length, 0);
    assert.equal(f.service.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("a problem on the way is an overview that says what to do, never an exception", async (context) => {
  quiet(context);
  const f = await fixture();
  try {
    f.world.tokenEndpointStatus = 503;
    assert.deepEqual(await f.sharing.overview(), {
      state: "unavailable",
      detail:
        "Sharing is switched off or not set up at memtrace.io right now. Try again later.",
    });
    f.world.tokenEndpointStatus = 401;
    assert.equal((await f.sharing.overview()).state, "signed-out");
    f.world.tokenEndpointStatus = 200;
    f.service.refuseNextCallBy("no_such_project");
    assert.deepEqual(await f.sharing.overview(), {
      state: "unavailable",
      detail: refusalSentences.no_such_project,
    });
    f.world.addresses = {
      memsyncUrl: "http://sync.example.com",
      tokenUrl,
    };
    const mistyped = await f.sharing.overview();
    assert.equal(mistyped.state, "unavailable");
    assert.match((mistyped as { detail: string }).detail, /https:\/\//);
    f.world.addresses = { memsyncUrl: f.service.address.href, tokenUrl };
    await f.service.close();
    const down = await f.sharing.overview();
    assert.equal(down.state, "unavailable");
    assert.match((down as { detail: string }).detail, /could not be reached/);
  } finally {
    await f.close();
  }
});

test("connecting records which shared project a local project's board belongs to", async () => {
  const f = await fixture();
  const { alex } = f.people;
  try {
    const launch = await f.as(alex).startProject("Launch plan");
    const link = await f.sharing.connect({
      projectId: "local-web",
      sharedProjectId: launch,
    });
    assert.deepEqual(link, {
      projectId: "local-web",
      sharedProjectId: launch,
      sharedProjectName: "Launch plan",
      accountId: alex.accountId,
      service: f.service.address.href,
      connectedAt: at,
    });
    assert.deepEqual(f.state.sharedProjectLinks, [link]);
    assert.equal(f.world.saves, 1);
    // Connecting asks the service whether the person is on that project. The
    // rest is board sync: who is on the project, and the board's log.
    const asked = f.service.calls
      .filter((call) => call.method !== "StartProject")
      .map((call) => call.method);
    assert.equal(asked[0], "GetProject");
    assert.deepEqual(
      [...new Set(asked)].sort(),
      ["GetProject", "ReadUpdates", "WatchUpdates"].filter((method) =>
        asked.includes(method),
      ),
    );
    assert.ok(asked.includes("ReadUpdates"));
  } finally {
    await f.close();
  }
});

test("a local project is connected to one shared project, and a shared project to one local project", async () => {
  const f = await fixture();
  const { alex } = f.people;
  try {
    const launch = await f.as(alex).startProject("Launch plan"),
      website = await f.as(alex).startProject("Website");
    await f.sharing.connect({
      projectId: "local-web",
      sharedProjectId: launch,
    });
    await assert.rejects(
      f.sharing.connect({ projectId: "local-web", sharedProjectId: website }),
      /already connected to “Launch plan”/,
    );
    await assert.rejects(
      f.sharing.connect({ projectId: "local-app", sharedProjectId: launch }),
      /“Launch plan” is already connected to “website” on this computer/,
    );
    assert.equal(f.state.sharedProjectLinks!.length, 1);
    assert.equal(f.world.saves, 1);
    await f.sharing.connect({
      projectId: "local-app",
      sharedProjectId: website,
    });
    assert.deepEqual(
      f.state.sharedProjectLinks!.map((link) => [
        link.projectId,
        link.sharedProjectName,
      ]),
      [
        ["local-web", "Launch plan"],
        ["local-app", "Website"],
      ],
    );
  } finally {
    await f.close();
  }
});

test("two connects for one project at the same moment leave one link", async () => {
  const f = await fixture();
  const { alex } = f.people;
  try {
    const launch = await f.as(alex).startProject("Launch plan"),
      website = await f.as(alex).startProject("Website");
    const outcomes = await Promise.allSettled([
      f.sharing.connect({ projectId: "local-web", sharedProjectId: launch }),
      f.sharing.connect({ projectId: "local-web", sharedProjectId: website }),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [
      "fulfilled",
      "rejected",
    ]);
    assert.equal(f.state.sharedProjectLinks!.length, 1);
  } finally {
    await f.close();
  }
});

test("the example project, a Team project and a project that is not there cannot be connected", async () => {
  const f = await fixture();
  const { alex } = f.people;
  try {
    const launch = await f.as(alex).startProject("Launch plan");
    await assert.rejects(
      f.sharing.connect({ projectId: "example", sharedProjectId: launch }),
      /example project/,
    );
    f.state.team = [
      { projectId: "local-app" } as NonNullable<AppState["team"]>[number],
    ];
    await assert.rejects(
      f.sharing.connect({ projectId: "local-app", sharedProjectId: launch }),
      /Team Sync/,
    );
    await assert.rejects(
      f.sharing.connect({ projectId: "gone", sharedProjectId: launch }),
      /Project not found/,
    );
    assert.equal(f.state.sharedProjectLinks, undefined);
    assert.equal(f.world.saves, 0);
    assert.ok(!f.service.calls.some((call) => call.method === "GetProject"));
  } finally {
    await f.close();
  }
});

test("disconnecting forgets the link on this computer and asks the service nothing", async () => {
  const f = await fixture();
  const { alex } = f.people;
  try {
    const launch = await f.as(alex).startProject("Launch plan"),
      website = await f.as(alex).startProject("Website");
    await f.sharing.connect({
      projectId: "local-web",
      sharedProjectId: launch,
    });
    await f.sharing.connect({
      projectId: "local-app",
      sharedProjectId: website,
    });
    // Board sync has read both logs and asked who is on the projects.
    await boardsSynced(f, 2);
    await until(
      () =>
        ["local-web", "local-app"].every(
          (id) => f.sharing.author(id)?.name === alex.name,
        ),
      "board sync to know who is on the projects",
    );
    await until(() => f.service.boards.watching === 2, "both to be listening");
    const asked = f.service.calls.length;
    await f.sharing.disconnect("local-web");
    assert.deepEqual(
      f.state.sharedProjectLinks!.map((link) => link.projectId),
      ["local-app"],
    );
    assert.equal(f.world.saves, 3);
    await f.sharing.disconnect("local-web");
    assert.equal(f.world.saves, 3);
    assert.equal(f.service.calls.length, asked);
    // The person is still on the shared project, and can connect it again.
    await f.sharing.connect({
      projectId: "local-web",
      sharedProjectId: launch,
    });
    f.world.signedIn = null;
    await f.sharing.disconnect("local-app");
    assert.deepEqual(
      f.state.sharedProjectLinks!.map((link) => link.projectId),
      ["local-web"],
    );
  } finally {
    await f.close();
  }
});

test("an address memtrace.io lists that is not a sharing service says so, without sending anyone to Settings", async () => {
  const f = await fixture();
  const page = createHttp2Server().on("stream", (stream: ServerHttp2Stream) => {
    stream.respond({ ":status": 200, "content-type": "text/html" });
    stream.end("<h1>Welcome</h1>");
  });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = page.address() as AddressInfo;
    f.world.addresses = { memsyncUrl: `http://127.0.0.1:${port}`, tokenUrl };
    const overview = await f.sharing.overview();
    assert.equal(overview.state, "unavailable");
    const { detail } = overview as { detail: string };
    assert.match(detail, /not a sharing service/);
    assert.match(detail, /Try again later/);
    assert.doesNotMatch(detail, /Settings/);
  } finally {
    await f.close();
    await new Promise((resolve) => page.close(resolve));
  }
});

test("a new sharing address from memtrace.io is used from the next call on", async () => {
  const f = await fixture();
  const elsewhere = await startStandInMemsync();
  const { alex } = f.people;
  try {
    await f.as(alex).startProject("On the first service");
    await actingAs(elsewhere.address, elsewhere.tokenFor(alex)).startProject(
      "On the second service",
    );
    assert.deepEqual(
      ready(await f.sharing.overview()).projects.map((project) => project.name),
      ["On the first service"],
    );
    f.world.addresses = { memsyncUrl: elsewhere.address.href, tokenUrl };
    f.world.admitAt = elsewhere;
    const moved = ready(await f.sharing.overview());
    assert.deepEqual(
      moved.projects.map((project) => project.name),
      ["On the second service"],
    );
    assert.equal(moved.service, elsewhere.address.href);
    // The token for the first service was not carried over to the second.
    assert.equal(f.world.exchanges.length, 2);
  } finally {
    await f.close();
    await elsewhere.close();
  }
});

test("connecting writes the project's board to the shared project, and the person's second computer takes it", async () => {
  const mac = await fixture();
  const pc = await fixture(mac);
  const { alex } = mac.people;
  try {
    giveWork(mac.state, "local-web");
    const shared = await mac.as(alex).startProject("Website");
    await mac.sharing.connect({
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await boardsSynced(mac, 1);
    assert.equal(mac.state.sharedBoards![0].projectId, "local-web");
    assert.ok(mac.service.boards.log(shared).length > 0);
    assert.deepEqual(await boardFolders(mac.boardsFolder), [
      (await boardFolders(mac.boardsFolder))[0],
    ]);

    await pc.sharing.connect({
      projectId: "local-app",
      sharedProjectId: shared,
    });
    await boardsSynced(pc, 1);
    const taken = pc.state.tasks.filter((one) => one.projectId === "local-app");
    assert.deepEqual(taken.map((one) => one.title).sort(), [
      "Export as CSV",
      "Export as PDF",
    ]);
    // The second computer saved the workspace with the board in it, as one change.
    assert.equal(pc.state.sharedProjectLinks![0].applied, 1);

    // A change made on the Mac after a save of its workspace reaches the PC.
    mac.state.tasks.find((one) => one.id === "task-2")!.title =
      "Export as PDF/A";
    await mac.sharing.workspaceSaved();
    await until(
      () =>
        pc.state.tasks.find((one) => one.id === "task-2")?.title ===
        "Export as PDF/A",
      "the PC to see the change",
    );
  } finally {
    await pc.close();
    await mac.close();
  }
});

test("a comment written in a connected project is by the person signed in to Memtrace", async () => {
  const f = await fixture();
  const { alex } = f.people;
  try {
    assert.equal(f.sharing.author("local-web"), undefined);
    const shared = await f.as(alex).startProject("Website");
    await f.sharing.connect({
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await boardsSynced(f, 1);
    await until(
      () => f.sharing.author("local-web")?.name === alex.name,
      "the name of the person signed in",
    );
    assert.deepEqual(f.sharing.author("local-web"), {
      id: alex.accountId,
      name: alex.name,
      source: "memtrace",
    });
    assert.equal(f.sharing.author("local-app"), undefined);
  } finally {
    await f.close();
  }
});

test("disconnecting ends sync for the board and forgets what was kept for it", async () => {
  const f = await fixture();
  const { alex } = f.people;
  try {
    giveWork(f.state, "local-web");
    const shared = await f.as(alex).startProject("Website");
    await f.sharing.connect({
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await boardsSynced(f, 1);
    assert.equal((await boardFolders(f.boardsFolder)).length, 1);
    const logged = f.service.boards.log(shared).length;

    await f.sharing.disconnect("local-web");
    assert.deepEqual(f.state.sharedBoards, []);
    assert.deepEqual(await boardFolders(f.boardsFolder), []);
    assert.equal(f.service.boards.watching, 0);
    // The board stays on this computer, and what changes on it now goes nowhere.
    assert.equal(
      f.state.tasks.filter((one) => one.projectId === "local-web").length,
      2,
    );
    f.state.tasks.find((one) => one.id === "task-1")!.title = "Mine alone";
    await f.sharing.workspaceSaved();
    assert.equal(f.service.boards.log(shared).length, logged);
  } finally {
    await f.close();
  }
});

test("a board is synchronized only for the account that connected it, on the service it was connected at", async () => {
  const f = await fixture();
  const { alex, dana } = f.people;
  try {
    giveWork(f.state, "local-web");
    const shared = await f.as(alex).startProject("Website");
    await f.sharing.connect({
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await boardsSynced(f, 1);
    const logged = f.service.boards.log(shared).length;

    // Someone else signs in to Memtrace on this computer.
    f.world.signedIn = dana;
    await f.sharing.syncBoards();
    assert.deepEqual(f.state.sharedBoards, []);
    f.state.tasks.find((one) => one.id === "task-1")!.title =
      "While Dana was signed in";
    await f.sharing.workspaceSaved();
    assert.equal(f.service.boards.log(shared).length, logged);

    // Nobody is signed in.
    f.world.signedIn = null;
    await f.sharing.syncBoards();
    assert.deepEqual(f.state.sharedBoards, []);

    // Alex signs in again: the board takes up where it stopped, with the change made meanwhile.
    f.world.signedIn = alex;
    await f.sharing.syncBoards();
    await boardsSynced(f, 1);
    assert.equal(f.service.boards.log(shared).length, logged + 1);

    // memtrace.io stops offering sharing.
    f.world.addresses = undefined;
    await f.sharing.syncBoards();
    assert.deepEqual(f.state.sharedBoards, []);
    assert.equal(f.state.sharedProjectLinks!.length, 1);
  } finally {
    await f.close();
  }
});

test("boards connected on an earlier run are synchronized again when MemCode starts", async () => {
  const f = await fixture();
  const { alex } = f.people;
  try {
    giveWork(f.state, "local-web");
    const shared = await f.as(alex).startProject("Website");
    await f.sharing.connect({
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await boardsSynced(f, 1);
    const logged = f.service.boards.log(shared).length;
    await f.sharing.close();
    f.state.sharedBoards = [
      { ...f.state.sharedBoards![0], state: "offline", detail: "left over" },
    ];

    const again = f.restarted();
    try {
      // How a board stood on the last run is not shown as how it stands now.
      assert.equal(f.state.sharedBoards?.length, 0);
      f.state.tasks.push(
        task("local-web", "task-3", { title: "Made while MemCode was closed" }),
      );
      await again.syncBoards();
      await boardsSynced(f, 1);
      assert.equal(f.state.sharedBoards![0].detail, undefined);
      assert.equal(f.service.boards.log(shared).length, logged + 1);
    } finally {
      await again.close();
    }
  } finally {
    await f.close();
  }
});

test("a project with tasks cannot be connected to a shared project that already has a board, and nothing stays connected", async () => {
  const mac = await fixture();
  const laptop = await fixture(mac);
  const { alex, dana } = mac.people;
  try {
    laptop.world.signedIn = dana;
    giveWork(mac.state, "local-web");
    const shared = await mac.as(alex).startProject("Website");
    const invitation = await mac.as(alex).invite(shared, dana.email!);
    await laptop.sharing.acceptInvitation({
      projectId: shared,
      invitationId: invitation,
    });
    await mac.sharing.connect({
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await boardsSynced(mac, 1);
    const logged = mac.service.boards.log(shared).length;

    laptop.state.tasks.push(
      task("local-app", "dana-1", { title: "Dana's own" }),
    );
    await assert.rejects(
      laptop.sharing.connect({
        projectId: "local-app",
        sharedProjectId: shared,
      }),
      (refusal: Error) => {
        assert.equal(
          refusal.message,
          "app already has work of its own, so it cannot join Website: connect a project that has none yet.",
        );
        return true;
      },
    );
    assert.deepEqual(laptop.state.sharedProjectLinks ?? [], []);
    assert.equal(laptop.state.sharedBoards?.length, 0);
    assert.deepEqual(await boardFolders(laptop.boardsFolder), []);
    assert.equal(mac.service.boards.log(shared).length, logged);
    assert.equal(
      laptop.state.tasks.filter((one) => one.projectId === "local-app").length,
      1,
    );

    // The project that has no tasks joins, and gets the board.
    await laptop.sharing.connect({
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await boardsSynced(laptop, 1);
    assert.equal(
      laptop.state.tasks.filter((one) => one.projectId === "local-web").length,
      2,
    );
    assert.equal(mac.service.boards.log(shared).length, logged);
  } finally {
    await laptop.close();
    await mac.close();
  }
});

test("a board connected at one sharing service is not synchronized at another", async () => {
  const f = await fixture();
  const other = await startStandInMemsync();
  const { alex } = f.people;
  try {
    giveWork(f.state, "local-web");
    const shared = await f.as(alex).startProject("Website");
    await f.sharing.connect({
      projectId: "local-web",
      sharedProjectId: shared,
    });
    await boardsSynced(f, 1);

    // memtrace.io now names another sharing service. The link still names the first.
    f.world.admitAt = other;
    f.world.addresses = { memsyncUrl: other.address.href, tokenUrl };
    await f.sharing.syncBoards();
    assert.deepEqual(f.state.sharedBoards, []);
    await until(
      () => f.service.boards.watching === 0,
      "the first service to see the stream end",
    );
    f.state.tasks.find((one) => one.id === "task-1")!.title =
      "Not for the other service";
    await f.sharing.workspaceSaved();
    assert.equal(ready(await f.sharing.overview()).projects.length, 0);
    assert.deepEqual(
      other.calls
        .map((call) => call.method)
        .filter((method) => /Updates/.test(method)),
      [],
    );
  } finally {
    await f.close();
    await other.close();
  }
});

/** The same person's Mac and PC, both connected to one shared project with the Mac's board. */
async function macAndPc() {
  const mac = await fixture();
  const pc = await fixture(mac);
  giveWork(mac.state, "local-web");
  const shared = await mac.as(mac.people.alex).startProject("Website");
  await mac.sharing.connect({
    projectId: "local-web",
    sharedProjectId: shared,
  });
  await boardsSynced(mac, 1);
  await pc.sharing.connect({ projectId: "local-app", sharedProjectId: shared });
  await boardsSynced(pc, 1);
  const onMac = () => mac.state.tasks.find((one) => one.id === "task-1")!;
  const onPc = () => pc.state.tasks.find((one) => one.id === "task-1")!;
  return {
    mac,
    pc,
    onMac,
    onPc,
    close: async () => {
      await pc.close();
      await mac.close();
    },
  };
}

test("a worker run on one computer is on the other's open card, live, and nothing can be sent to it", async () => {
  const { mac, pc, onMac, onPc, close } = await macAndPc();
  try {
    pc.sharing.followCard("task-1");
    onMac().run = {
      state: "running",
      startedAt: "2026-11-22T10:00:00.000Z",
    } as never;
    onMac().messages = [
      {
        id: "m1",
        role: "user",
        text: "Export the report as CSV.",
        at: "2026-11-22T10:00:00.000Z",
      },
    ];
    await mac.sharing.workspaceSaved();
    await until(
      () => onPc().sharedSession?.messages.length === 1,
      "the PC's open card to show the run",
    );
    assert.equal(onPc().sharedSession!.owner.name, mac.people.alex.name);
    assert.equal(pc.sharing.showsRunElsewhere("task-1"), true);
    assert.equal(mac.sharing.showsRunElsewhere("task-1"), false);
    // Live: a new turn arrives on the open card.
    onMac().messages.push({
      id: "m2",
      role: "assistant",
      text: "Done.",
      at: "2026-11-22T10:01:00.000Z",
    });
    mac.sharing.workerActivity();
    await until(
      () => onPc().sharedSession?.messages.length === 2,
      "the new turn",
    );
    // Closed and opened again, the card reads the log again.
    pc.sharing.unfollowCard("task-1");
    pc.sharing.followCard("task-1");
    await until(
      () => onPc().sharedSession?.messages.length === 2,
      "the card again",
    );
  } finally {
    await close();
  }
});

test("a file and the changes shared from a card open on the other computer, with who shared them", async () => {
  const { mac, pc, onMac, onPc, close } = await macAndPc();
  try {
    onMac().run = {
      state: "finished",
      startedAt: "2026-11-22T10:00:00.000Z",
    } as never;
    const folder = join(mac.dataDir, "captures", "task-1");
    await mkdir(folder, { recursive: true });
    const html = "<h1>Export report</h1>";
    await writeFile(join(folder, "report.html"), html);
    mac.state.artifacts.push({
      id: "artifact-1",
      projectId: "local-web",
      taskId: "task-1",
      name: "report.html",
      kind: "html",
      path: join(folder, "report.html"),
      createdAt: at,
      source: "Worker",
      purpose: "report",
    });
    pc.sharing.followCard("task-1");
    const shared = await mac.sharing.shareResult({
      taskId: "task-1",
      artifactId: "artifact-1",
    });
    assert.equal(shared.name, "report.html");
    await until(
      () => onPc().sharedResults?.length === 1,
      "the shared file on the PC's card",
    );
    assert.equal(onPc().sharedResults![0].sharedBy, mac.people.alex.name);
    const opened = await pc.sharing.openSharedResult({
      taskId: "task-1",
      resultId: onPc().sharedResults![0].id,
    });
    assert.equal(await readFile(opened.path, "utf8"), html);
    assert.equal(opened.source, mac.people.alex.name);
    assert.equal(opened.purpose, "report");
    assert.ok(pc.state.artifacts.some((item) => item.id === opened.id));
    assert.ok(opened.path.startsWith(join(pc.dataDir, "captures", "task-1")));

    const changes: WorkerChanges = {
      taskId: "task-1",
      checkpoints: [
        {
          id: "c1",
          runId: "r1",
          taskId: "task-1",
          agentId: "a1",
          harness: "codex",
          branch: "epic/ep-01",
          startedAt: at,
          at,
          basis: "native-edit",
          files: [
            {
              path: "src/export.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              binary: false,
              hunks: [
                {
                  oldStart: 1,
                  newStart: 1,
                  lines: [
                    {
                      kind: "add",
                      text: "export const csv = true;",
                      newLine: 1,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      additions: 1,
      deletions: 0,
      files: 1,
    };
    // The run finished: its changes are shared with the project, without a click.
    mac.world.changes.set("task-1", changes);
    onMac().codeReview = {
      runId: "r1",
      state: "completed",
      updatedAt: at,
      findingCount: 0,
    } as never;
    await mac.sharing.captureCards();
    await until(
      () => !!onPc().sharedResults?.some((item) => item.kind === "patch"),
      "the shared changes",
    );
    assert.deepEqual(await pc.sharing.sharedChanges("task-1"), changes);
  } finally {
    await close();
  }
});

test("only a task's own saved file, at most 5 MB, can be shared, and only from a shared project", async () => {
  const { mac, close } = await macAndPc();
  try {
    const outside = join(mac.dataDir, "elsewhere.txt");
    await mkdir(mac.dataDir, { recursive: true });
    await writeFile(outside, "not this task's");
    mac.state.artifacts.push({
      id: "outside",
      projectId: "local-web",
      taskId: "task-1",
      name: "elsewhere.txt",
      kind: "text",
      path: outside,
      createdAt: at,
      source: "Worker",
    });
    await assert.rejects(
      mac.sharing.shareResult({ taskId: "task-1", artifactId: "outside" }),
      /Only files this task saved can be shared/,
    );
    const folder = join(mac.dataDir, "captures", "task-1");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
    mac.state.artifacts.push({
      id: "big",
      projectId: "local-web",
      taskId: "task-1",
      name: "big.bin",
      kind: "text",
      path: join(folder, "big.bin"),
      createdAt: at,
      source: "Worker",
    });
    await assert.rejects(
      mac.sharing.shareResult({ taskId: "task-1", artifactId: "big" }),
      /larger than 5 MB/,
    );
    await writeFile(join(folder, "empty.txt"), "");
    mac.state.artifacts.push({
      id: "empty",
      projectId: "local-web",
      taskId: "task-1",
      name: "empty.txt",
      kind: "text",
      path: join(folder, "empty.txt"),
      createdAt: at,
      source: "Worker",
    });
    await assert.rejects(
      mac.sharing.shareResult({ taskId: "task-1", artifactId: "empty" }),
      /^Error: That file is empty, so there is nothing in it to share\.$/,
    );
  } finally {
    await close();
  }
});

test("a file of 5 MB, the most a project shares, goes from one computer to the other whole", async () => {
  const { mac, pc, onMac, onPc, close } = await macAndPc();
  try {
    onMac().run = {
      state: "finished",
      startedAt: "2026-11-22T10:00:00.000Z",
    } as never;
    const folder = join(mac.dataDir, "captures", "task-1");
    await mkdir(folder, { recursive: true });
    const bytes = Buffer.alloc(5 * 1024 * 1024, "a");
    await writeFile(join(folder, "large-report.txt"), bytes);
    mac.state.artifacts.push({
      id: "large",
      projectId: "local-web",
      taskId: "task-1",
      name: "large-report.txt",
      kind: "text",
      path: join(folder, "large-report.txt"),
      createdAt: at,
      source: "Worker",
      purpose: "report",
    });
    pc.sharing.followCard("task-1");
    await mac.sharing.shareResult({ taskId: "task-1", artifactId: "large" });
    await until(
      () => onPc().sharedResults?.length === 1,
      "the large file on the PC's card",
    );
    const opened = await pc.sharing.openSharedResult({
      taskId: "task-1",
      resultId: onPc().sharedResults![0].id,
    });
    assert.ok((await readFile(opened.path)).equals(bytes));
  } finally {
    await close();
  }
});

// ── Sharing from inside MemCode: Share, Invite, Join and Open ─────────────

const asked = (f: { service: StandInMemsync }, method: string) =>
  f.service.calls.filter((call) => call.method === method).length;
const signIn = (
  f: Awaited<ReturnType<typeof fixture>>,
  person: StandInPerson,
) => {
  f.world.signedIn = person;
  f.world.sessionId = `session-${person.accountId}-1234567890abcdef`;
};

test("Share starts a shared project named after the local one and shares its board, once", async () => {
  const f = await fixture();
  try {
    giveWork(f.state, "local-web");
    const link = await f.sharing.shareProject("local-web");
    assert.equal(link.projectId, "local-web");
    assert.equal(link.sharedProjectName, "website");
    const mine = ready(await f.sharing.overview());
    assert.deepEqual(
      mine.projects.map((one) => [one.name, one.youAreOwner, one.guests]),
      [["website", true, []]],
    );
    await boardsSynced(f, 1);
    assert.ok(f.service.boards.log(link.sharedProjectId).length > 0);
    assert.deepEqual(await f.sharing.shareProject("local-web"), link);
    assert.equal(asked(f, "StartProject"), 1);
  } finally {
    await f.close();
  }
});

test("the example project and a Team project cannot be shared, and nothing is started for them", async () => {
  const f = await fixture();
  try {
    f.state.team = [
      { projectId: "local-app" } as NonNullable<AppState["team"]>[number],
    ];
    const exampleId = f.state.projects.find((one) => one.example)!.id;
    for (const projectId of [exampleId, "local-app", "not-here"])
      await assert.rejects(f.sharing.shareProject(projectId));
    assert.equal(asked(f, "StartProject"), 0);
  } finally {
    await f.close();
  }
});

test("inviting from a project not shared yet shares it first, and the owner sees whom they invited", async () => {
  const f = await fixture();
  const { dana, bo } = f.people;
  try {
    const after = ready(
      await f.sharing.invite({
        projectId: "local-app",
        email: ` ${dana.email!} `,
      }),
    );
    const app = after.projects.find((one) => one.name === "app")!;
    assert.deepEqual(
      app.openInvitations.map((one) => one.email),
      [dana.email],
    );
    await f.sharing.invite({ projectId: "local-app", email: bo.email! });
    assert.equal(asked(f, "StartProject"), 1);

    const cancelled = ready(
      await f.sharing.cancelInvitation({
        projectId: "local-app",
        invitationId: app.openInvitations[0].id,
      }),
    );
    assert.deepEqual(
      cancelled.projects[0].openInvitations.map((one) => one.email),
      [bo.email],
    );
    signIn(f, dana);
    assert.deepEqual(ready(await f.sharing.overview()).invitations, []);
  } finally {
    await f.close();
  }
});

test("a guest joins from an invitation and gets the owner's board as a new project; opening it again selects it", async () => {
  const owner = await fixture();
  const guest = await fixture(owner);
  const { dana } = owner.people;
  try {
    giveWork(owner.state, "local-web");
    await owner.sharing.invite({ projectId: "local-web", email: dana.email! });
    await boardsSynced(owner, 1);
    signIn(guest, dana);
    const waiting = ready(await guest.sharing.overview()).invitations;
    assert.equal(waiting.length, 1);
    const before = guest.state.projects.length;
    const { projectId } = await guest.sharing.join({
      sharedProjectId: waiting[0].projectId,
      invitationId: waiting[0].id,
    });
    const made = guest.state.projects.find((one) => one.id === projectId)!;
    assert.equal(made.name, "website");
    assert.equal(made.path, null);
    assert.equal(guest.state.activeProjectId, projectId);
    await boardsSynced(guest, 1);
    assert.deepEqual(
      guest.state.tasks
        .filter((one) => one.projectId === projectId)
        .map((one) => one.title)
        .sort(),
      ["Export as CSV", "Export as PDF"],
    );
    guest.state.activeProjectId = "local-web";
    assert.deepEqual(await guest.sharing.openShared(waiting[0].projectId), {
      projectId,
    });
    assert.equal(guest.state.activeProjectId, projectId);
    assert.equal(guest.state.projects.length, before + 1);
    // The owner sees the guest, and may remove them.
    const shared = ready(await owner.sharing.overview()).projects[0];
    assert.deepEqual(
      shared.guests.map((one) => one.name),
      [dana.name],
    );
    const removed = ready(
      await owner.sharing.removePerson({
        projectId: "local-web",
        personId: shared.guests[0].id,
      }),
    );
    assert.deepEqual(removed.projects[0].guests, []);
  } finally {
    await guest.close();
    await owner.close();
  }
});

test("the person's other computer opens a shared project from the list and gets its board", async () => {
  const mac = await fixture();
  const pc = await fixture(mac);
  try {
    giveWork(mac.state, "local-web");
    const link = await mac.sharing.shareProject("local-web");
    await boardsSynced(mac, 1);
    const listed = ready(await pc.sharing.overview()).projects;
    assert.deepEqual(
      listed.map((one) => one.id),
      [link.sharedProjectId],
    );
    const { projectId } = await pc.sharing.openShared(link.sharedProjectId);
    await boardsSynced(pc, 1);
    assert.equal(
      pc.state.tasks.filter((one) => one.projectId === projectId).length,
      2,
    );
    assert.equal(asked(mac, "StartProject"), 1);
  } finally {
    await pc.close();
    await mac.close();
  }
});

test("a shared project that cannot be opened leaves no project behind", async () => {
  const f = await fixture();
  try {
    const before = f.state.projects.length;
    await assert.rejects(f.sharing.openShared("no-such-project"), {
      message: refusalSentences.no_such_project,
    });
    assert.equal(f.state.projects.length, before);
  } finally {
    await f.close();
  }
});

test("a guest who leaves keeps the board on this computer, no longer shared; the owner cannot leave", async () => {
  const owner = await fixture();
  const guest = await fixture(owner);
  const { dana } = owner.people;
  try {
    giveWork(owner.state, "local-web");
    await owner.sharing.invite({ projectId: "local-web", email: dana.email! });
    await assert.rejects(owner.sharing.leave("local-web"), {
      message: refusalSentences.the_owner_cannot_leave,
    });
    signIn(guest, dana);
    const [waiting] = ready(await guest.sharing.overview()).invitations;
    const { projectId } = await guest.sharing.join({
      sharedProjectId: waiting.projectId,
      invitationId: waiting.id,
    });
    await boardsSynced(guest, 1);
    const left = ready(await guest.sharing.leave(projectId));
    assert.deepEqual(left.projects, []);
    assert.deepEqual(guest.state.sharedProjectLinks, []);
    assert.equal(
      guest.state.tasks.filter((one) => one.projectId === projectId).length,
      2,
    );
    assert.deepEqual(
      ready(await owner.sharing.overview()).projects[0].guests,
      [],
    );
  } finally {
    await guest.close();
    await owner.close();
  }
});
