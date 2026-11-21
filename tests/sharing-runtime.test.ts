import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime/app";
import type { BetaCredentials, BetaStoredState } from "../runtime/beta";
import type { AppState, Project } from "../src/shared";
import type { SharingOverview } from "../src/sharing";
import { refusalSentences } from "../src/sharing-refusals";
import { signedInBetaStore } from "./support/beta-session";
import { actingAs } from "./support/memsync-owner";
import {
  startStandInMemsync,
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
async function fixture(signedIn = true) {
  const root = await mkdtemp(join(tmpdir(), "memcode-sharing-runtime-"));
  const service = await startStandInMemsync();
  const people = cast();
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
  const start = () =>
    createRuntime(
      join(root, "profile"),
      root,
      {
        async call<T>(method: string): Promise<T> {
          native.push(method);
          if (method === "beta_store_read") return structuredClone(stored) as T;
          if (method === "open_memcode_projects") return null as T;
          throw Error("Unexpected native operation " + method);
        },
      },
      (event) => emitted.push(event),
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
    saveAddresses: (sharing: { memsyncUrl: string; tokenUrl: string }) =>
      request("settings:save", {
        ...runtime.current.store.state.settings,
        sharing,
      }),
    website: (person: StandInPerson) =>
      actingAs(service.address, service.tokenFor(person)),
    async restart() {
      await runtime.current.close();
      runtime.current = await start();
    },
    async close() {
      await runtime.current.close();
      await tokens.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("sharing is absent until its two addresses are saved in Settings", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.request("sharing:overview"), { state: "not-set" });
    assert.equal(f.state().settings.sharing, undefined);
    await assert.rejects(
      f.saveAddresses({ memsyncUrl: f.service.address.href, tokenUrl: "" }),
      /both addresses/,
    );
    await assert.rejects(
      f.saveAddresses({
        memsyncUrl: "http://sync.example.com",
        tokenUrl: f.tokens.url,
      }),
      /https:\/\//,
    );
    await assert.rejects(
      f.saveAddresses({
        memsyncUrl: f.service.address.href,
        tokenUrl: "https://tokens.example.com/token",
      }),
      /only to www\.memtrace\.io/,
    );
    assert.equal(f.state().settings.sharing, undefined);
    assert.equal(f.tokens.requests.length, 0);
    await f.saveAddresses({
      memsyncUrl: f.service.address.href,
      tokenUrl: f.tokens.url,
    });
    assert.equal(
      (await f.request<SharingOverview>("sharing:overview")).state,
      "ready",
    );
    // Emptying both fields takes sharing away again, and a later save of other settings keeps that.
    await f.saveAddresses({ memsyncUrl: " ", tokenUrl: "" });
    assert.equal(f.state().settings.sharing, undefined);
    assert.deepEqual(await f.request("sharing:overview"), { state: "not-set" });
  } finally {
    await f.close();
  }
});

test("a signed-in MemCode lists shared projects, accepts an invitation and connects the open project", async () => {
  const f = await fixture();
  const { dana } = f.people;
  try {
    await f.saveAddresses({
      memsyncUrl: f.service.address.href,
      tokenUrl: f.tokens.url,
    });
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
    assert.deepEqual(saved.settings.sharing, {
      memsyncUrl: f.service.address.href,
      tokenUrl: f.tokens.url,
    });
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
    await f.saveAddresses({
      memsyncUrl: f.service.address.href,
      tokenUrl: f.tokens.url,
    });
    const overview = await f.request<SharingOverview>("sharing:overview");
    assert.equal(overview.state, "signed-out");
    assert.equal(f.tokens.requests.length, 0);
    assert.equal(f.service.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("managing projects opens memtrace.io in the browser, and requests are checked before they run", async () => {
  const f = await fixture();
  try {
    await f.request("sharing:manage");
    assert.ok(f.native.includes("open_memcode_projects"));
    for (const [method, input] of [
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
    await f.saveAddresses({
      memsyncUrl: f.service.address.href,
      tokenUrl: f.tokens.url,
    });
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
