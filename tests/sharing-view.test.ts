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
  type SharedBoardStatus,
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
type Shown = Pick<
  AppState,
  "projects" | "team" | "sharedProjectLinks" | "sharedBoards"
>;
const board = (
  changes: Partial<SharedBoardStatus> = {},
): SharedBoardStatus => ({
  projectId: website.id,
  state: "synced",
  waiting: 0,
  leftOut: [],
  setAside: false,
  tooLarge: 0,
  ...changes,
});
/** The page for the open project, connected, with its board standing a certain way. */
const connected = (changes: Partial<SharedBoardStatus> = {}) =>
  text(
    render(
      ready(),
      shown({ sharedProjectLinks: [link()], sharedBoards: [board(changes)] }),
    ),
  );
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
      onKeepBoth() {},
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

test("a connected project says so, says how its board stands, and offers to disconnect", () => {
  const page = connected();
  assert.match(page, /website is connected to Launch plan/);
  assert.match(page, /The board is in sync/);
  assert.match(page, /Connected to this project/);
  assert.match(page, /Disconnect/);
  // A project that is connected is not offered a second shared project.
  assert.doesNotMatch(page, /Connect website/);
  assert.doesNotMatch(page, /Keep both/);

  assert.match(connected({ state: "starting" }), /Reading the shared board/);
  assert.match(
    connected({ state: "sending", waiting: 1 }),
    /Sending 1 change to the shared board/,
  );
  assert.match(
    connected({ state: "sending", waiting: 12 }),
    /Sending 12 changes to the shared board/,
  );
  // Just connected: board sync has not said anything yet.
  assert.match(
    text(render(ready(), shown({ sharedProjectLinks: [link()] }))),
    /Getting the board ready to sync/,
  );
});

test("while the service cannot be reached, the page says so and how many changes wait here", () => {
  const offline = connected({
    state: "offline",
    detail:
      "The sharing service could not be reached. Check your connection and try again.",
    waiting: 3,
  });
  assert.match(offline, /The sharing service could not be reached/);
  assert.match(
    offline,
    /3 changes made here are kept on this computer and sent when it works again/,
  );
  const nothingWaiting = connected({
    state: "offline",
    detail:
      "The sharing service could not be reached. Check your connection and try again.",
  });
  assert.doesNotMatch(nothingWaiting, /kept on this computer/);
});

test("two boards that both have work ask before anything is added, and say what keeping both does", () => {
  const page = text(
    render(
      ready(),
      shown({
        sharedProjectLinks: [link()],
        sharedBoards: [
          board({ state: "choose", choice: { shared: 30, added: 12 } }),
        ],
      }),
    ),
  );
  assert.match(
    page,
    /Launch plan already has 30 tasks, and website has 12 of its own/,
  );
  assert.match(
    page,
    /Keeping both adds them to Launch plan\. Nothing is replaced/,
  );
  assert.match(page, /Keep both/);
  assert.match(page, /Disconnect/);
  assert.match(
    connected({ state: "choose", choice: { shared: 1, added: 1 } }),
    /already has 1 task, and website has 1 of its own/,
  );
  // While something is running, the button waits like every other.
  const busy = render(
    ready(),
    shown({
      sharedProjectLinks: [link()],
      sharedBoards: [
        board({ state: "choose", choice: { shared: 2, added: 2 } }),
      ],
    }),
    website,
    { busy: "keep-both" },
  );
  assert.match(busy, /disabled=""[^>]*>(<svg[^>]*>.*?<\/svg>)?Keep both/s);
});

test("changes that could not be read are named by person and day, and never stop the rest", () => {
  const page = connected({
    leftOut: [
      { by: "Dana Ek", on: "2026-11-21", count: 2 },
      { by: "Bo Li", on: "2026-11-22", count: 1 },
    ],
    setAside: true,
  });
  assert.match(page, /The board is in sync/);
  assert.match(
    page,
    /2 changes from Dana Ek on 21 November could not be read and were left out/,
  );
  assert.match(
    page,
    /1 change from Bo Li on 22 November could not be read and was left out/,
  );
  assert.match(
    page,
    /Some changes are set aside until one they build on arrives/,
  );
  assert.doesNotMatch(connected(), /left out|set aside|too large/);
});

test("a value too large to share is said to stay on this computer", () => {
  assert.match(
    connected({ tooLarge: 1 }),
    /1 value is too large for the sharing service and stays on this computer/,
  );
  assert.match(
    connected({ tooLarge: 4 }),
    /4 values are too large for the sharing service and stay on this computer/,
  );
});

test("a board that cannot be changed from here, or cannot go on, shows the sentence it was given", () => {
  for (const [state, detail] of [
    [
      "newer",
      "A newer MemCode laid this board out. Update MemCode to change it from this computer.",
    ],
    [
      "gone",
      "That shared project no longer exists, or you are no longer on it.",
    ],
    [
      "stopped",
      "The workspace could not be saved, so changes from the shared board are waiting.",
    ],
  ] as const) {
    const page = connected({ state, detail });
    assert.ok(page.includes(detail), page);
    assert.doesNotMatch(page, /The board is in sync/);
  }
});

test("how a board stands is shown for the open project only", () => {
  const page = text(
    render(
      ready(),
      shown({
        sharedProjectLinks: [link({ projectId: app.id })],
        sharedBoards: [
          board({ projectId: app.id, state: "sending", waiting: 5 }),
        ],
      }),
    ),
  );
  assert.doesNotMatch(page, /Sending 5 changes/);
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

test("when the service cannot be reached the reason is said once, with what waits on this computer", () => {
  const detail =
    "The sharing service could not be reached. Check your connection and try again.";
  const page = text(
    render(
      { state: "unavailable", detail },
      shown({
        sharedProjectLinks: [link()],
        sharedBoards: [board({ state: "offline", detail, waiting: 2 })],
      }),
    ),
  );
  assert.equal(page.split(detail).length - 1, 1, page);
  assert.match(page, /website is connected to Launch plan/);
  assert.match(
    page,
    /2 changes made here are kept on this computer and sent when it works again/,
  );
  // A board that says something else keeps its own line.
  const stopped = text(
    render(
      { state: "unavailable", detail },
      shown({
        sharedProjectLinks: [link()],
        sharedBoards: [
          board({
            state: "stopped",
            detail: "The workspace could not be saved.",
          }),
        ],
      }),
    ),
  );
  assert.match(stopped, /The workspace could not be saved\./);
});
