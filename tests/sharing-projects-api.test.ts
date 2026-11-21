import test from "node:test";
import assert from "node:assert/strict";
import { grpcChannel, grpcStatus } from "../runtime/sharing/memsync/grpc";
import { MemsyncProjects } from "../runtime/sharing/memsync/projects-api";
import {
  SharingRefused,
  SharingSignedOut,
  SharingUnavailable,
} from "../runtime/sharing/problems";
import { refusalRules, refusalSentences } from "../src/sharing-refusals";
import { startStandInMemsync } from "./support/memsync-stand-in";
import {
  cast,
  projectsApiScenarios,
  signedInTo,
} from "./support/projects-api-scenarios";

projectsApiScenarios("stand-in sharing service", startStandInMemsync);

/** MemCode's client with access tokens the test hands out and takes back. */
async function fixture(timeoutMs?: number) {
  const service = await startStandInMemsync();
  const people = cast();
  const forgotten: string[] = [];
  let issued = 0;
  const channel = grpcChannel(service.address);
  const state = { token: service.tokenFor(people.alex) };
  const projects = new MemsyncProjects(
    channel,
    {
      current: async () => {
        issued++;
        return { token: state.token, accountId: people.alex.accountId };
      },
      forget: (token) => {
        forgotten.push(token);
        state.token = service.tokenFor(people.alex);
      },
    },
    timeoutMs,
  );
  return {
    service,
    people,
    projects,
    state,
    forgotten,
    get issued() {
      return issued;
    },
    close: async () => {
      channel.close();
      await service.close();
    },
  };
}
const unavailable = (sentence: RegExp) => (problem: unknown) => {
  assert.ok(problem instanceof SharingUnavailable, String(problem));
  assert.match(problem.message, sentence);
  return true;
};
const quietly = async <T>(context: test.TestContext, run: () => Promise<T>) => {
  const logged = context.mock.method(console, "error", () => {});
  try {
    return { result: await run(), logged };
  } finally {
    logged.mock.restore();
  }
};

test("every call carries the access token as a bearer token", async () => {
  const f = await fixture();
  try {
    await f.projects.listProjects();
    await f.projects.listInvitations();
    assert.deepEqual(f.service.calls, [
      { method: "ListProjects", token: f.state.token },
      { method: "ListInvitations", token: f.state.token },
    ]);
  } finally {
    await f.close();
  }
});

test("a token the service turns away is handed back and the call made once more with a new one", async () => {
  const f = await fixture();
  try {
    const first = f.state.token;
    f.service.expire(first);
    assert.deepEqual(await f.projects.listProjects(), []);
    assert.deepEqual(f.forgotten, [first]);
    assert.deepEqual(
      f.service.calls.map((call) => call.token),
      [first, f.state.token],
    );
  } finally {
    await f.close();
  }
});

test("a service that takes no token at all is unavailable, after two tries and no more", async (context) => {
  const f = await fixture();
  try {
    f.service.turnAwayNextCall();
    f.service.turnAwayNextCall();
    const { logged } = await quietly(context, () =>
      assert.rejects(
        f.projects.listProjects(),
        unavailable(/did not accept this sign-in/),
      ),
    );
    assert.equal(f.service.calls.length, 2);
    assert.equal(f.forgotten.length, 2);
    assert.equal(logged.mock.callCount(), 1);
  } finally {
    await f.close();
  }
});

test("each rule the service can name reaches the person as MemCode's sentence for it", async () => {
  const f = await fixture();
  try {
    for (const rule of refusalRules) {
      f.service.refuseNextCallBy(rule);
      await assert.rejects(f.projects.listProjects(), (problem) => {
        assert.ok(problem instanceof SharingRefused, rule);
        assert.equal(problem.rule, rule);
        assert.equal(problem.message, refusalSentences[rule]);
        return true;
      });
    }
  } finally {
    await f.close();
  }
});

test("a rule from a newer service is said plainly and written to the log by name", async (context) => {
  const f = await fixture();
  try {
    f.service.refuseNextCallBy("project_is_archived");
    const { logged } = await quietly(context, () =>
      assert.rejects(
        f.projects.listProjects(),
        unavailable(/this version of MemCode does not know/),
      ),
    );
    assert.match(
      String(logged.mock.calls[0].arguments[0]),
      /project_is_archived/,
    );
    assert.match(String(logged.mock.calls[0].arguments[0]), /ListProjects/);
  } finally {
    await f.close();
  }
});

test("a refusal for an unverified address hands the token back, so the next try carries the new address", async () => {
  const f = await fixture();
  try {
    const first = f.state.token;
    f.service.refuseNextCallBy("email_not_verified");
    await assert.rejects(f.projects.listInvitations(), SharingRefused);
    assert.deepEqual(f.forgotten, [first]);
    f.service.refuseNextCallBy("no_such_project", grpcStatus.NOT_FOUND);
    await assert.rejects(f.projects.listInvitations(), SharingRefused);
    assert.deepEqual(f.forgotten, [first]);
  } finally {
    await f.close();
  }
});

test("a service in trouble, out of reach, too slow or unreadable is unavailable, each in its own words", async (context) => {
  const f = await fixture(150);
  try {
    await quietly(context, async () => {
      f.service.failNextCall(grpcStatus.UNAVAILABLE);
      await assert.rejects(
        f.projects.listProjects(),
        unavailable(/having trouble/),
      );
      f.service.failNextCall(grpcStatus.INTERNAL);
      await assert.rejects(
        f.projects.listProjects(),
        unavailable(/having trouble/),
      );
      f.service.stallNextCall();
      await assert.rejects(f.projects.listProjects(), unavailable(/in time/));
      f.service.garbleNextReply();
      await assert.rejects(
        f.projects.listProjects(),
        unavailable(/could not read/),
      );
      await f.service.close();
      await assert.rejects(
        f.projects.listProjects(),
        unavailable(/could not be reached/),
      );
    });
  } finally {
    await f.close();
  }
});

test("a reply that lacks what it always holds is not passed on half read", async (context) => {
  const f = await fixture();
  try {
    const alex = signedInTo(f.service, f.people.alex);
    const id = await alex.website.startProject("Launch plan");
    alex.close();
    // The same bytes read as an invitation have no project id, sender or dates.
    const channel = grpcChannel(f.service.address);
    context.after(() => channel.close());
    const asInvitation = new MemsyncProjects(
      {
        unary: (call) =>
          channel.unary({
            ...call,
            path: call.path.replace("ListInvitations", "ListProjects"),
          }),
        close() {},
      },
      {
        current: async () => ({ token: f.state.token, accountId: "" }),
        forget() {},
      },
    );
    await quietly(context, () =>
      assert.rejects(
        asInvitation.listInvitations(),
        unavailable(/could not read/),
      ),
    );
    assert.equal((await f.projects.getProject(id)).name, "Launch plan");
  } finally {
    await f.close();
  }
});

test("having no sign-in, or no way to get a token, stops the call before it is made", async () => {
  const service = await startStandInMemsync();
  const channel = grpcChannel(service.address);
  try {
    for (const problem of [
      new SharingSignedOut(),
      new SharingUnavailable("memtrace.io could not be reached."),
    ]) {
      const projects = new MemsyncProjects(channel, {
        current: async () => {
          throw problem;
        },
        forget() {},
      });
      await assert.rejects(
        projects.listProjects(),
        (thrown) => thrown === problem,
      );
    }
    assert.equal(service.calls.length, 0);
  } finally {
    channel.close();
    await service.close();
  }
});
