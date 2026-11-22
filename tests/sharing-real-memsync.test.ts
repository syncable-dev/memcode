import test, { after } from "node:test";
import assert from "node:assert/strict";
import { grpcChannel } from "../runtime/sharing/memsync/grpc";
import { SharingUnavailable } from "../runtime/sharing/problems";
import { refusalRules } from "../src/sharing-refusals";
import { actingAs } from "./support/memsync-owner";
import { boardSyncScenarios } from "./support/board-sync-scenarios";
import { boardsApiScenarios } from "./support/boards-api-scenarios";
import { cardsApiScenarios } from "./support/cards-api-scenarios";
import {
  cast,
  projectsApiScenarios,
  projectsOver,
  signedInTo,
} from "./support/projects-api-scenarios";
import {
  cardsMissing,
  realMemsyncMissing,
  startRealMemsync,
  worldOn,
  type RealMemsync,
  type TokenChanges,
} from "./support/real-memsync";

// MemCode's client against the real server: its wire format, its statuses and its rules.
// Skipped unless a built server and a PostgreSQL server for tests are named:
//   MEMSYNC_SERVER_BINARY=/path/to/memsync-server \
//   MEMSYNC_TEST_DATABASE_URL=postgres://memsync@127.0.0.1:54329/postgres \
//   node --import tsx --test tests/sharing-real-memsync.test.ts
let started: Promise<RealMemsync> | undefined;
const server = () => (started ??= startRealMemsync());
after(async () => {
  await (await started)?.stop();
});

projectsApiScenarios(
  "real memsync-server",
  async () => worldOn(await server()),
  {
    skip: realMemsyncMissing,
  },
);
boardsApiScenarios("real memsync-server", async () => worldOn(await server()), {
  skip: realMemsyncMissing,
});
boardSyncScenarios("real memsync-server", async () => worldOn(await server()), {
  skip: realMemsyncMissing,
});
cardsApiScenarios(
  "real memsync-server",
  async () => {
    const real = await server();
    return { ...worldOn(real), lacks: await cardsMissing(real) };
  },
  { skip: realMemsyncMissing },
);

test(
  "real memsync-server: a token it has no reason to trust is turned away",
  { skip: realMemsyncMissing },
  async (context) => {
    const real = await server();
    const { alex } = cast();
    const untrusted: Array<[string, TokenChanges]> = [
      ["signed with another key", { unknownKey: true }],
      ["made for another service", { claims: { aud: "memcode-team" } }],
      [
        "made for another purpose",
        { claims: { purpose: "memcode-engine-beta" } },
      ],
      ["from another issuer", { claims: { iss: "https://example.com" } }],
      ["expired", { claims: { iat: 1700000000, exp: 1700000600 } }],
      [
        "longer-lived than fifteen minutes",
        { claims: { exp: Math.floor(Date.now() / 1000) + 3600 } },
      ],
    ];
    context.mock.method(console, "error", () => {});
    for (const [what, changes] of untrusted) {
      const channel = grpcChannel(real.address);
      const forgotten: string[] = [];
      const token = real.tokenFor(alex, changes);
      const projects = projectsOver(channel, {
        current: async () => ({ token, accountId: alex.accountId }),
        forget: (refused) => forgotten.push(refused),
      });
      try {
        await assert.rejects(
          projects.listProjects(),
          (problem) => {
            assert.ok(problem instanceof SharingUnavailable, what);
            assert.match(problem.message, /did not accept this sign-in/);
            return true;
          },
          what,
        );
        assert.deepEqual(forgotten, [token, token], what);
      } finally {
        channel.close();
      }
    }
  },
);

test(
  "real memsync-server: every rule it names is one MemCode has a sentence for",
  { skip: realMemsyncMissing },
  async () => {
    const world = worldOn(await server());
    const people = cast();
    const alex = signedInTo(world, people.alex),
      bo = signedInTo(world, people.bo),
      dana = signedInTo(world, people.dana);
    const named: string[] = [];
    const naming = async (attempt: Promise<unknown>) => {
      try {
        await attempt;
        assert.fail("expected the service to turn this down");
      } catch (problem) {
        const rule = (problem as { metadata?: Record<string, string> })
          .metadata?.["memsync-refusal"];
        assert.ok(rule, String(problem));
        named.push(rule);
      }
    };
    try {
      const id = await alex.website.startProject("Rules");
      await naming(alex.website.startProject("   "));
      await naming(alex.website.invite(id, "not an address"));
      await naming(alex.website.invite(id, people.alex.email!));
      const forBo = await alex.website.invite(id, people.bo.email!);
      await naming(alex.website.invite(id, people.bo.email!));
      await bo.projects.acceptInvitation(id, forBo);
      await naming(bo.website.invite(id, people.dana.email!));
      await naming(bo.website.deleteProject(id));
      await naming(alex.website.removeGuest(id, people.dana.accountId));
      await alex.website.invite(id, people.dana.email!);
      await naming(alex.website.invite(id, "one.more@example.com"));
      await naming(dana.website.deleteProject(id));
      await naming(
        actingAs(world.address, dana.token).cancelInvitation(id, forBo),
      );
      assert.deepEqual(named, [
        "invalid_project_name",
        "invalid_email",
        "already_on_project",
        "already_invited",
        "only_the_owner_invites",
        "not_the_owner",
        "no_such_guest",
        "guest_limit_reached",
        "no_such_project",
        "no_such_project",
      ]);
      for (const rule of named)
        assert.ok((refusalRules as readonly string[]).includes(rule), rule);
    } finally {
      for (const person of [alex, bo, dana]) person.close();
    }
  },
);

test(
  "real memsync-server: the same person signed in on two computers sees the same projects",
  { skip: realMemsyncMissing },
  async () => {
    const world = worldOn(await server());
    const { alex } = cast();
    const mac = signedInTo(world, alex),
      windows = signedInTo(world, alex);
    try {
      const id = await mac.website.startProject("On both computers");
      const seen = await windows.projects.listProjects();
      assert.deepEqual(
        seen.map((project) => project.id),
        [id],
      );
      assert.deepEqual(seen[0].guests, []);
      // Nobody invited the second computer: signing in is all it took.
      assert.deepEqual(await windows.projects.listInvitations(), []);
      assert.deepEqual(seen[0].openInvitations, []);
    } finally {
      mac.close();
      windows.close();
    }
  },
);
