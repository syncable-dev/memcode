import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import type { AppState, Project } from "../src/shared";
import type { SharingOverview } from "../src/sharing";
import { refusalSentences } from "../src/sharing-refusals";
import { Sharing } from "../runtime/sharing/sharing";
import {
  startStandInMemsync,
  type StandInMemsync,
  type StandInPerson,
} from "./support/memsync-stand-in";
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
async function fixture() {
  const service = await startStandInMemsync();
  const people = cast();
  const state: AppState = initialState();
  state.projects.push(
    localProject("local-web", "website"),
    localProject("local-app", "app"),
  );
  state.activeProjectId = "local-web";
  state.settings.sharing = { memsyncUrl: service.address.href, tokenUrl };
  const world = {
    signedIn: people.alex as StandInPerson | null,
    sessionId: "session-1234567890abcdef",
    saves: 0,
    exchanges: [] as string[],
    tokenEndpointStatus: 200,
    admitAt: service as StandInMemsync,
  };
  let serial = 0;
  const sharing = new Sharing({
    state: () => state,
    changed: async () => void world.saves++,
    session: async () =>
      world.signedIn && {
        refreshToken: "refresh-" + "r".repeat(40),
        deviceId: "device-1234567890abcdef",
        sessionId: world.sessionId,
        accountId: world.signedIn.accountId,
      },
    now: () => at,
    fetcher: (async (url) => {
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
    }) as typeof fetch,
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
    close: async () => {
      sharing.close();
      await service.close();
    },
  };
}
type Ready = Extract<SharingOverview, { state: "ready" }>;
const ready = (overview: SharingOverview): Ready => {
  assert.equal(overview.state, "ready", JSON.stringify(overview));
  return overview as Ready;
};
const quiet = (context: test.TestContext) =>
  context.mock.method(console, "error", () => {});

test("sharing that is not set up is absent: nobody is asked anything", async () => {
  const f = await fixture();
  try {
    for (const unset of [undefined, { memsyncUrl: "", tokenUrl: "" }]) {
      f.state.settings.sharing = unset;
      assert.deepEqual(await f.sharing.overview(), { state: "not-set" });
      await assert.rejects(
        f.sharing.connect({ projectId: "local-web", sharedProjectId: "any" }),
        /not set up/,
      );
    }
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
    await f.as(alex).invite(launch, chidiAddress);
    const website = await f.as(dana).startProject("Website");
    const forAlex = await f.as(dana).invite(website, alex.email!);

    const mine = ready(await f.sharing.overview());
    assert.equal(mine.accountId, alex.accountId);
    assert.equal(mine.service, f.service.address.href);
    assert.deepEqual(mine.projects, [
      {
        id: launch,
        name: "Launch plan",
        owner: { name: alex.name, isYou: true },
        guests: [{ name: bo.name, isYou: false }],
        youAreOwner: true,
        openInvitations: 1,
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
    // Nothing about other people but their names reaches the app's window.
    const shown = JSON.stringify(mine);
    for (const hidden of [
      bo.accountId,
      bo.email!,
      dana.accountId,
      dana.email!,
      chidiAddress,
    ])
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
      { name: bo.name, isYou: true },
    ]);
    assert.deepEqual(asGuest.projects[1].owner, {
      name: alex.name,
      isYou: false,
    });
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
    f.state.settings.sharing = {
      memsyncUrl: "http://sync.example.com",
      tokenUrl,
    };
    const mistyped = await f.sharing.overview();
    assert.equal(mistyped.state, "unavailable");
    assert.match((mistyped as { detail: string }).detail, /https:\/\//);
    f.state.settings.sharing = { memsyncUrl: f.service.address.href, tokenUrl };
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
    // Connecting asks the service only whether the person is on that project.
    assert.deepEqual(
      f.service.calls
        .filter((call) => call.method !== "StartProject")
        .map((call) => call.method),
      ["GetProject"],
    );
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

test("a new sharing address in Settings is used from the next call on", async () => {
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
    f.state.settings.sharing = { memsyncUrl: elsewhere.address.href, tokenUrl };
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
