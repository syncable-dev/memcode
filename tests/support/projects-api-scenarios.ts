import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  grpcChannel,
  type GrpcChannel,
} from "../../runtime/sharing/memsync/grpc";
import {
  SignedCalls,
  type AccessTokens,
} from "../../runtime/sharing/memsync/signed-calls";
import { MemsyncBoards } from "../../runtime/sharing/memsync/boards-api";
import { MemsyncCards } from "../../runtime/sharing/memsync/cards-api";
import { LARGEST_CARDS_MESSAGE } from "../../runtime/sharing/memsync/cards-contract";
import { MemsyncProjects } from "../../runtime/sharing/memsync/projects-api";
import { SharingRefused } from "../../runtime/sharing/problems";
import type { RefusalRule } from "../../src/sharing-refusals";
import { actingAs } from "./memsync-owner";
import type { StandInPerson } from "./memsync-stand-in";

/** MemCode's Projects client over a channel, signed in with the tokens it is handed. */
export const projectsOver = (
  channel: Pick<GrpcChannel, "unary">,
  access: AccessTokens,
  timeoutMs?: number,
) =>
  new MemsyncProjects(
    new SignedCalls(channel as GrpcChannel, access, timeoutMs),
  );

/** A sharing service to run a scenario against: the stand-in, or a real memsync-server. */
export interface SharingWorld {
  address: URL;
  /** A token the service takes as this person. */
  tokenFor(person: StandInPerson): string;
  /** Only a world that can move its clock has this. */
  daysPass?(days: number): void;
  /** Why this service cannot run a scenario of a newer contract, if it cannot. */
  lacks?: string;
  close(): Promise<void>;
}

/** People who are new in every scenario, so scenarios never see each other's projects. */
export function cast() {
  const unique = randomUUID().slice(0, 8);
  const person = (name: string, verified = true): StandInPerson => ({
    accountId: `${name.toLowerCase()}-${unique}`,
    name: `${name} Example`,
    ...(verified
      ? { email: `${name.toLowerCase()}.${unique}@example.com` }
      : {}),
  });
  return {
    alex: person("Alex"),
    bo: person("Bo"),
    dana: person("Dana"),
    /** Signed in, with no verified email address. */
    chidi: person("Chidi", false),
    chidiAddress: `chidi.${unique}@example.com`,
  };
}

export function signedInTo(world: SharingWorld, person: StandInPerson) {
  const token = world.tokenFor(person);
  const channel = grpcChannel(world.address, {
    maxReplyBytes: LARGEST_CARDS_MESSAGE,
  });
  const access = {
    current: async () => ({ token, accountId: person.accountId }),
    forget() {},
  };
  return {
    token,
    /** MemCode's own clients. */
    projects: projectsOver(channel, access),
    boards: new MemsyncBoards(new SignedCalls(channel, access)),
    cards: new MemsyncCards(new SignedCalls(channel, access, 60_000)),
    /** What the same person does at memtrace.io. */
    website: actingAs(world.address, token),
    close: () => channel.close(),
  };
}

export const refusedBy = (rule: RefusalRule) => (problem: unknown) => {
  assert.ok(problem instanceof SharingRefused, String(problem));
  assert.equal(problem.rule, rule);
  return true;
};

/** What MemCode's Projects client must do against any sharing service that follows the contract. */
export function projectsApiScenarios(
  where: string,
  open: () => Promise<SharingWorld>,
  options: { skip?: string | false } = {},
) {
  const scenario = (
    name: string,
    run: (world: SharingWorld) => Promise<void>,
    needs?: "a clock to move",
  ) =>
    test(`${where}: ${name}`, { skip: options.skip }, async (context) => {
      const world = await open();
      try {
        if (needs && !world.daysPass)
          return context.skip("this sharing service's clock cannot be moved");
        await run(world);
      } finally {
        await world.close();
      }
    });

  scenario("someone new has no projects and no invitations", async (world) => {
    const bo = signedInTo(world, cast().bo);
    try {
      assert.deepEqual(await bo.projects.listProjects(), []);
      assert.deepEqual(await bo.projects.listInvitations(), []);
    } finally {
      bo.close();
    }
  });

  scenario(
    "an owner sees their project with its open invitation",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex);
      try {
        const id = await alex.website.startProject("  Launch plan ✈  ");
        const invitationId = await alex.website.invite(id, people.bo.email!);
        const [listed] = await alex.projects.listProjects();
        assert.equal(listed.id, id);
        assert.equal(listed.name, "Launch plan ✈");
        assert.deepEqual(listed.owner, people.alex);
        assert.deepEqual(listed.guests, []);
        assert.equal(listed.guestLimit, 2);
        assert.equal(listed.openInvitations.length, 1);
        const [open] = listed.openInvitations;
        assert.equal(open.id, invitationId);
        assert.equal(open.email, people.bo.email);
        assert.deepEqual(open.invitedBy, people.alex);
        const lifetimeDays =
          (Date.parse(open.expiresAt) - Date.parse(open.sentAt)) / 86400000;
        assert.equal(lifetimeDays, 14);
        assert.deepEqual(await alex.projects.getProject(id), listed);
      } finally {
        alex.close();
      }
    },
  );

  scenario(
    "an invited person finds the invitation, accepts it and is a guest",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        bo = signedInTo(world, people.bo);
      try {
        const id = await alex.website.startProject("Launch plan");
        const invitationId = await alex.website.invite(id, people.bo.email!);
        const waiting = await bo.projects.listInvitations();
        assert.equal(waiting.length, 1);
        assert.equal(waiting[0].id, invitationId);
        assert.equal(waiting[0].projectId, id);
        assert.equal(waiting[0].projectName, "Launch plan");
        assert.equal(waiting[0].invitedBy?.name, people.alex.name);
        assert.deepEqual(await bo.projects.listProjects(), []);

        const joined = await bo.projects.acceptInvitation(id, invitationId);
        assert.deepEqual(joined.guests, [people.bo]);
        assert.deepEqual(joined.openInvitations, []);
        assert.deepEqual(await bo.projects.listInvitations(), []);
        assert.deepEqual(
          (await bo.projects.listProjects()).map((project) => project.id),
          [id],
        );
        assert.deepEqual((await alex.projects.getProject(id)).guests, [
          people.bo,
        ]);
      } finally {
        alex.close();
        bo.close();
      }
    },
  );

  scenario("projects come listed by name", async (world) => {
    const alex = signedInTo(world, cast().alex);
    try {
      for (const name of ["Website", "Android app", "Launch plan"])
        await alex.website.startProject(name);
      assert.deepEqual(
        (await alex.projects.listProjects()).map((project) => project.name),
        ["Android app", "Launch plan", "Website"],
      );
    } finally {
      alex.close();
    }
  });

  scenario(
    "a project someone is not on reads as no such project",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        dana = signedInTo(world, people.dana);
      try {
        const id = await alex.website.startProject("Private");
        for (const asked of [id, randomUUID(), "not-an-id", ""])
          await assert.rejects(
            dana.projects.getProject(asked),
            refusedBy("no_such_project"),
          );
      } finally {
        alex.close();
        dana.close();
      }
    },
  );

  scenario(
    "an invitation cannot be accepted by someone it was not sent to",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        bo = signedInTo(world, people.bo),
        dana = signedInTo(world, people.dana),
        chidi = signedInTo(world, people.chidi);
      try {
        const id = await alex.website.startProject("Launch plan");
        const forBo = await alex.website.invite(id, people.bo.email!);
        await assert.rejects(
          dana.projects.acceptInvitation(id, forBo),
          refusedBy("no_such_invitation"),
        );
        await assert.rejects(
          bo.projects.acceptInvitation(id, randomUUID()),
          refusedBy("no_such_invitation"),
        );
        await assert.rejects(
          bo.projects.acceptInvitation(randomUUID(), forBo),
          refusedBy("no_such_project"),
        );
        // Signed in, but with no verified address to match the invitation against.
        const forChidi = await alex.website.invite(id, people.chidiAddress);
        await assert.rejects(
          chidi.projects.acceptInvitation(id, forChidi),
          refusedBy("email_not_verified"),
        );
        assert.deepEqual((await alex.projects.getProject(id)).guests, []);
      } finally {
        for (const person of [alex, bo, dana, chidi]) person.close();
      }
    },
  );

  scenario(
    "accepting twice, or as someone already on the project, changes nothing",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        bo = signedInTo(world, people.bo);
      try {
        const id = await alex.website.startProject("Launch plan");
        const forBo = await alex.website.invite(id, people.bo.email!);
        await bo.projects.acceptInvitation(id, forBo);
        await assert.rejects(
          bo.projects.acceptInvitation(id, forBo),
          refusedBy("no_such_invitation"),
        );
        const forDana = await alex.website.invite(id, people.dana.email!);
        await assert.rejects(
          bo.projects.acceptInvitation(id, forDana),
          refusedBy("already_on_project"),
        );
        const now = await alex.projects.getProject(id);
        assert.deepEqual(now.guests, [people.bo]);
        assert.equal(now.openInvitations.length, 1);
      } finally {
        alex.close();
        bo.close();
      }
    },
  );

  scenario(
    "a cancelled invitation is gone from the invited person's list",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        bo = signedInTo(world, people.bo);
      try {
        const id = await alex.website.startProject("Launch plan");
        const forBo = await alex.website.invite(id, people.bo.email!);
        await alex.website.cancelInvitation(id, forBo);
        assert.deepEqual(await bo.projects.listInvitations(), []);
        await assert.rejects(
          bo.projects.acceptInvitation(id, forBo),
          refusedBy("no_such_invitation"),
        );
      } finally {
        alex.close();
        bo.close();
      }
    },
  );

  scenario(
    "a removed guest and a deleted project both read as no such project",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        bo = signedInTo(world, people.bo);
      try {
        const kept = await alex.website.startProject("Kept"),
          deleted = await alex.website.startProject("Deleted");
        for (const id of [kept, deleted])
          await bo.projects.acceptInvitation(
            id,
            await alex.website.invite(id, people.bo.email!),
          );
        assert.equal((await bo.projects.listProjects()).length, 2);
        await alex.website.removeGuest(kept, people.bo.accountId);
        await alex.website.deleteProject(deleted);
        assert.deepEqual(await bo.projects.listProjects(), []);
        for (const id of [kept, deleted])
          await assert.rejects(
            bo.projects.getProject(id),
            refusedBy("no_such_project"),
          );
        assert.deepEqual(
          (await alex.projects.listProjects()).map((project) => project.id),
          [kept],
        );
      } finally {
        alex.close();
        bo.close();
      }
    },
  );

  scenario(
    "an invitation older than fourteen days is no longer listed and cannot be accepted",
    async (world) => {
      const people = cast();
      const alex = signedInTo(world, people.alex),
        bo = signedInTo(world, people.bo);
      try {
        const id = await alex.website.startProject("Launch plan");
        const forBo = await alex.website.invite(id, people.bo.email!);
        world.daysPass!(13);
        assert.equal((await bo.projects.listInvitations()).length, 1);
        world.daysPass!(2);
        assert.deepEqual(await bo.projects.listInvitations(), []);
        await assert.rejects(
          bo.projects.acceptInvitation(id, forBo),
          refusedBy("invitation_expired"),
        );
        assert.deepEqual(
          (await alex.projects.getProject(id)).openInvitations,
          [],
        );
      } finally {
        alex.close();
        bo.close();
      }
    },
    "a clock to move",
  );
}
