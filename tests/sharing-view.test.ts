import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SharingPanel } from "../src/components/SharedProjects";
import { SharingSettings } from "../src/components/SharingSettings";
import type { AppState, Project } from "../src/shared";
import {
  localProjectOf,
  projectSharing,
  sharingIsSet,
  type SharedProject,
  type SharedProjectLink,
  type SharingOverview,
} from "../src/sharing";

const at = "2026-11-21T12:00:00.000Z";
const local = (
  id: string,
  name: string,
  extra: Partial<Project> = {},
): Project => ({
  id,
  name,
  description: "",
  path: `/work/${name}`,
  branch: "main",
  analysis: "idle",
  createdAt: at,
  ...extra,
});
const website = local("local-web", "website"),
  app = local("local-app", "app"),
  example = local("example", "Design preview", { example: true, path: null });
const launch: SharedProject = {
  id: "shared-launch",
  name: "Launch plan",
  owner: { name: "Alex Holm", isYou: true },
  guests: [{ name: "Bo Li", isYou: false }],
  youAreOwner: true,
  openInvitations: 1,
  guestLimit: 2,
};
const redesign: SharedProject = {
  id: "shared-redesign",
  name: "Website redesign",
  owner: { name: "Dana Ek", isYou: false },
  guests: [{ name: "Alex Holm", isYou: true }],
  youAreOwner: false,
  openInvitations: 0,
  guestLimit: 2,
};
type Ready = Extract<SharingOverview, { state: "ready" }>;
const ready = (changes: Partial<Ready> = {}): Ready => ({
  state: "ready",
  accountId: "acct-alex",
  service: "https://sync.memtrace.io/",
  projects: [launch, redesign],
  invitations: [],
  ...changes,
});
const link = (changes: Partial<SharedProjectLink> = {}): SharedProjectLink => ({
  projectId: website.id,
  sharedProjectId: launch.id,
  sharedProjectName: "Launch plan",
  accountId: "acct-alex",
  service: "https://sync.memtrace.io/",
  connectedAt: at,
  ...changes,
});
type Shown = Pick<AppState, "projects" | "team" | "sharedProjectLinks">;
const shown = (changes: Partial<Shown> = {}): Shown => ({
  projects: [example, website, app],
  ...changes,
});

test("sharing is in the app only when both addresses are set", () => {
  assert.equal(sharingIsSet(undefined), false);
  assert.equal(
    sharingIsSet({ memsyncUrl: "https://sync.memtrace.io", tokenUrl: "" }),
    false,
  );
  assert.equal(
    sharingIsSet({ memsyncUrl: " ", tokenUrl: "https://www.memtrace.io/t" }),
    false,
  );
  assert.equal(
    sharingIsSet({
      memsyncUrl: "https://sync.memtrace.io",
      tokenUrl: "https://www.memtrace.io/t",
    }),
    true,
  );
});

test("the open project is free, connected, or says why it cannot be connected", () => {
  assert.deepEqual(projectSharing(website, shown(), ready()), { kind: "free" });
  assert.deepEqual(projectSharing(example, shown(), ready()), {
    kind: "example",
  });
  assert.deepEqual(
    projectSharing(
      website,
      shown({
        team: [
          { projectId: website.id } as NonNullable<AppState["team"]>[number],
        ],
      }),
      ready(),
    ),
    { kind: "team" },
  );
  assert.deepEqual(
    projectSharing(website, shown({ sharedProjectLinks: [link()] }), ready()),
    { kind: "connected", shared: launch },
  );
});

test("a link whose shared project is gone, or that was made elsewhere, is told apart from a live one", () => {
  const linked = shown({ sharedProjectLinks: [link()] });
  assert.deepEqual(
    projectSharing(website, linked, ready({ projects: [redesign] })),
    {
      kind: "gone",
      name: "Launch plan",
    },
  );
  assert.deepEqual(
    projectSharing(website, linked, ready({ accountId: "acct-other" })),
    {
      kind: "elsewhere",
      name: "Launch plan",
    },
  );
  assert.deepEqual(
    projectSharing(
      website,
      linked,
      ready({ service: "https://sync.company.example/" }),
    ),
    { kind: "elsewhere", name: "Launch plan" },
  );
});

test("a shared project knows which local project it is connected to on this computer", () => {
  const links = [link({ projectId: app.id })];
  const projects = [example, website, app];
  const service = "https://sync.memtrace.io/";
  assert.equal(localProjectOf(launch, links, projects, service), app);
  assert.equal(localProjectOf(redesign, links, projects, service), undefined);
  assert.equal(
    localProjectOf(launch, links, projects, "https://other.example/"),
    undefined,
  );
  // A link to a local project that is no longer in the workspace holds nothing.
  assert.equal(
    localProjectOf(launch, links, [example, website], service),
    undefined,
  );
});

const actions = {
  onRefresh() {},
  onManage() {},
  onAccount() {},
  onSettings() {},
  onAccept() {},
  onConnect() {},
  onDisconnect() {},
};
const render = (
  overview: SharingOverview | null,
  state: Shown = shown(),
  project: Project = website,
  extra: { busy?: string; error?: string } = {},
) =>
  renderToStaticMarkup(
    createElement(SharingPanel, {
      overview,
      state,
      project,
      busy: extra.busy ?? "",
      error: extra.error ?? "",
      ...actions,
    }),
  );
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

test("my shared projects are listed with who owns them, who is on them and a way to connect", () => {
  const page = text(render(ready()));
  assert.match(
    page,
    /Launch plan You own it · with Bo Li · 2 of 2 guest places taken/,
  );
  assert.match(
    page,
    /Website redesign Shared by Dana Ek · 1 of 2 guest places taken/,
  );
  assert.match(page, /website is not connected to a shared project/);
  assert.equal((page.match(/Connect website/g) ?? []).length, 2);
  assert.match(page, /Manage at memtrace\.io/);
  assert.doesNotMatch(page, /\bteam\b/i);
});

test("a connected project says so, says the board does not sync yet, and offers to disconnect", () => {
  const page = text(render(ready(), shown({ sharedProjectLinks: [link()] })));
  assert.match(page, /website is connected to Launch plan/);
  assert.match(page, /does not sync between computers yet/);
  assert.match(page, /Connected to this project/);
  assert.match(page, /Disconnect/);
  // A project that is connected is not offered a second shared project.
  assert.doesNotMatch(page, /Connect website/);
});

test("a shared project connected to another local project says which, and cannot be taken twice", () => {
  const page = text(
    render(
      ready(),
      shown({ sharedProjectLinks: [link({ projectId: app.id })] }),
    ),
  );
  assert.match(page, /Launch plan .* Connected to app/);
  assert.equal((page.match(/Connect website/g) ?? []).length, 1);
});

test("the example project and a Team project are told why they cannot be connected", () => {
  const forExample = text(render(ready(), shown(), example));
  assert.match(forExample, /example project cannot be connected/);
  assert.doesNotMatch(forExample, /Connect Design preview/);
  const forTeam = text(
    render(
      ready(),
      shown({
        team: [
          { projectId: website.id } as NonNullable<AppState["team"]>[number],
        ],
      }),
    ),
  );
  assert.match(forTeam, /shared through Team Sync/);
  assert.doesNotMatch(forTeam, /Connect website/);
});

test("a link that leads nowhere any more says so and can be disconnected", () => {
  const gone = text(
    render(
      ready({ projects: [redesign] }),
      shown({ sharedProjectLinks: [link()] }),
    ),
  );
  assert.match(gone, /no longer exists, or you are no longer on it/);
  assert.match(gone, /Disconnect/);
  const elsewhere = text(
    render(
      ready({ accountId: "acct-other" }),
      shown({ sharedProjectLinks: [link()] }),
    ),
  );
  assert.match(elsewhere, /another Memtrace account or sharing service/);
  assert.match(elsewhere, /Disconnect/);
});

test("invitations waiting for me say who sent them and until when, and can be accepted", () => {
  const page = text(
    render(
      ready({
        projects: [],
        invitations: [
          {
            id: "invitation-1",
            projectId: "shared-redesign",
            projectName: "Website redesign",
            invitedBy: "Dana Ek",
            expiresAt: "2026-12-05T09:30:00.000Z",
          },
        ],
      }),
    ),
  );
  assert.match(page, /Invitations for you/);
  assert.match(page, /Website redesign From Dana Ek · open until 5 December/);
  assert.match(page, /Accept/);
  assert.match(page, /You have no shared projects yet/);
});

test("the lists can be asked for again without leaving the page", () => {
  assert.match(render(ready()), /<button[^>]*aria-label="Look again"/);
  assert.match(
    render(ready(), shown(), website, { busy: "refresh" }),
    /<button[^>]*aria-label="Look again"[^>]*disabled=""/,
  );
});

test("with nothing waiting, the page says so instead of showing an empty list", () => {
  const page = text(render(ready({ projects: [launch] })));
  assert.match(page, /No invitations are waiting for you/);
});

test("each state that is not a list says what to do next", () => {
  assert.match(text(render(null)), /Looking up your shared projects/);
  const signedOut = text(
    render({
      state: "signed-out",
      detail: "Sign in to Memtrace to see the projects you share.",
    }),
  );
  assert.match(
    signedOut,
    /Sign in to Memtrace to see the projects you share\./,
  );
  assert.match(signedOut, /Open account settings/);
  const unavailable = text(
    render({
      state: "unavailable",
      detail: "The sharing service could not be reached.",
    }),
  );
  assert.match(unavailable, /The sharing service could not be reached\./);
  assert.match(unavailable, /Try again/);
  const notSet = text(render({ state: "not-set" }));
  assert.match(notSet, /Sharing is not set up/);
  assert.match(notSet, /Open settings/);
});

test("a connected project is still named, and can be disconnected, while the service cannot be asked", () => {
  const linked = shown({ sharedProjectLinks: [link()] });
  for (const overview of [
    {
      state: "unavailable",
      detail: "The sharing service could not be reached.",
    },
    {
      state: "signed-out",
      detail: "Sign in to Memtrace to see the projects you share.",
    },
  ] as const) {
    const page = text(render(overview, linked));
    assert.match(page, /website is connected to Launch plan/);
    assert.match(page, /Disconnect/);
    assert.doesNotMatch(text(render(overview)), /is connected to|Disconnect/);
  }
  assert.doesNotMatch(text(render(null, linked)), /Disconnect/);
});

test("a refusal is shown where the person is looking, and buttons wait while one is working", () => {
  const markup = render(
    ready({
      invitations: [
        {
          id: "invitation-1",
          projectId: "shared-x",
          projectName: "X",
          invitedBy: "Dana Ek",
          expiresAt: "2026-12-05T09:30:00.000Z",
        },
      ],
    }),
    shown(),
    website,
    { busy: "accept:invitation-1", error: "This invitation has expired." },
  );
  assert.match(markup, /role="alert"[^>]*>[^<]*This invitation has expired\./);
  assert.ok((markup.match(/disabled=""/g) ?? []).length >= 3);
});

test("names from the sharing service are shown as text, never as markup", () => {
  const hostile: SharedProject = {
    ...launch,
    name: '<img src=x onerror="alert(1)">',
    guests: [{ name: "<script>alert(2)</script>", isYou: false }],
  };
  const markup = render(ready({ projects: [hostile] }));
  assert.doesNotMatch(markup, /<img|<script/);
});

test("Settings shows the two sharing addresses as they are saved, empty when there are none", () => {
  const fields = (value?: { memsyncUrl: string; tokenUrl: string }) =>
    [
      ...renderToStaticMarkup(
        createElement(SharingSettings, { value, change() {} }),
      ).matchAll(/<input aria-label="([^"]+)"[^>]*value="([^"]*)"/g),
    ].map(([, label, shown]) => [label, shown]);
  assert.deepEqual(fields(), [
    ["Sharing service address", ""],
    ["Sign-in address for sharing", ""],
  ]);
  assert.deepEqual(
    fields({
      memsyncUrl: "https://sync.memtrace.io",
      tokenUrl: "https://www.memtrace.io/api/memcode/memsync/token",
    }),
    [
      ["Sharing service address", "https://sync.memtrace.io"],
      [
        "Sign-in address for sharing",
        "https://www.memtrace.io/api/memcode/memsync/token",
      ],
    ],
  );
});
