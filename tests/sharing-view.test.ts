import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SharePanel,
  SwitcherShared,
  offersSharing,
  placesLine,
  sharedInSwitcher,
} from "../src/components/ShareProject";
import type { AppState, Project } from "../src/shared";
import { initialState } from "../src/seed";
import {
  localProjectOf,
  projectSharing,
  type PendingInvitation,
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
  owner: { id: "acct-alex", name: "Alex Holm", isYou: true },
  guests: [{ id: "acct-bo", name: "Bo Li", isYou: false }],
  youAreOwner: true,
  openInvitations: [
    { id: "invitation-chidi", email: "chidi@example.com", sentAt: at },
  ],
  guestLimit: 2,
};
const redesign: SharedProject = {
  id: "shared-redesign",
  name: "Website redesign",
  owner: { id: "acct-dana", name: "Dana Ek", isYou: false },
  guests: [{ id: "acct-alex", name: "Alex Holm", isYou: true }],
  youAreOwner: false,
  openInvitations: [],
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
/** The Share panel for the open project, shared, with its board standing a certain way. */
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
  onInvite() {},
  onCancel() {},
  onRemove() {},
  onLeave() {},
  onStopSharing() {},
  onSignIn() {},
  onRetry() {},
};
const render = (
  overview: SharingOverview,
  state: Shown = shown(),
  project: Project = website,
  extra: { busy?: string; error?: string } = {},
) =>
  renderToStaticMarkup(
    createElement(SharePanel, {
      overview,
      state,
      project,
      busy: extra.busy ?? "",
      error: extra.error ?? "",
      yourName: "Alex Holm",
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
const team = (projectId: string) => [
  { projectId } as NonNullable<AppState["team"]>[number],
];
const invitation: PendingInvitation = {
  id: "invitation-1",
  projectId: "shared-garden",
  projectName: "Garden app",
  invitedBy: "Dana Ek",
  expiresAt: "2026-12-05T09:30:00.000Z",
};

test("a project of your own gets a Share button whenever sharing is offered", () => {
  for (const overview of [
    ready(),
    { state: "signed-out", detail: "Sign in." },
    { state: "unavailable", detail: "Down." },
  ] as const)
    assert.equal(offersSharing(overview, website, shown()), true);
  assert.equal(offersSharing({ state: "not-set" }, website, shown()), false);
  assert.equal(offersSharing(null, website, shown()), false);
  assert.equal(offersSharing(ready(), example, shown()), false);
  assert.equal(
    offersSharing(ready(), website, shown({ team: team(website.id) })),
    false,
  );
});

test("sharing a project that is not shared yet asks only for an email", () => {
  const markup = render(ready());
  const page = text(markup);
  assert.match(page, /Share website/);
  assert.match(
    markup,
    /<input[^>]*type="email"[^>]*placeholder="Email address"/,
  );
  assert.match(page, /Invite/);
  assert.match(page, /People with access AH Alex Holm \(you\) Owner/);
  assert.match(
    page,
    /Free projects hold you and 2 guests\. Your own computers don't count\./,
  );
  assert.doesNotMatch(page, /\bteam\b|address|memtrace\.io|Connect/i);
});

test("the owner sees each guest with a way to remove them, and each invitation with Cancel", () => {
  const markup = render(
    ready(),
    shown({ sharedProjectLinks: [link()], sharedBoards: [board()] }),
  );
  const page = text(markup);
  assert.match(page, /Alex Holm \(you\) Owner/);
  assert.match(page, /Bo Li Guest/);
  assert.match(markup, /aria-label="More for Bo Li"/);
  assert.match(page, /chidi@example\.com Invited Cancel/);
  assert.match(page, /The board is in sync/);
  assert.doesNotMatch(page, /Leave/);
});

test("with every guest place taken, nobody more can be invited", () => {
  const full: SharedProject = {
    ...launch,
    guests: [
      ...launch.guests,
      { id: "acct-eve", name: "Eve Sand", isYou: false },
    ],
    openInvitations: [],
  };
  const markup = render(
    ready({ projects: [full, redesign] }),
    shown({ sharedProjectLinks: [link()] }),
  );
  assert.match(markup, /<input[^>]*type="email"[^>]*disabled=""/);
  assert.equal(
    placesLine(1),
    "Free projects hold you and 1 guest. Your own computers don't count.",
  );
});

test("a guest sees who is on the project, cannot change it, and can leave", () => {
  const markup = render(
    ready(),
    shown({ sharedProjectLinks: [link({ sharedProjectId: redesign.id })] }),
  );
  const page = text(markup);
  assert.match(page, /Dana Ek Owner/);
  assert.match(page, /Alex Holm \(you\) Guest/);
  assert.match(page, /Leave Website redesign/);
  const withInvitation = text(
    render(
      ready({
        projects: [
          launch,
          {
            ...redesign,
            openInvitations: [{ id: "i", email: "", sentAt: at }],
          },
        ],
      }),
      shown({ sharedProjectLinks: [link({ sharedProjectId: redesign.id })] }),
    ),
  );
  assert.match(withInvitation, /1 more invited/);
  assert.doesNotMatch(markup, /type="email"|aria-label="More for|>Cancel</);
});

test("how the board stands is said under the people, with what is worth knowing", () => {
  const linked = (changes: Partial<SharedBoardStatus>) =>
    text(
      render(
        ready(),
        shown({ sharedProjectLinks: [link()], sharedBoards: [board(changes)] }),
      ),
    );
  assert.match(
    text(render(ready(), shown({ sharedProjectLinks: [link()] }))),
    /Getting the board ready to sync/,
  );
  assert.match(linked({ state: "starting" }), /Reading the shared board/);
  assert.match(
    linked({ state: "sending", waiting: 12 }),
    /Sending 12 changes to the shared board/,
  );
  assert.match(
    linked({
      state: "offline",
      detail: "The sharing service could not be reached.",
      waiting: 3,
    }),
    /3 changes made here are kept on this computer and sent when it works again/,
  );
  const notes = linked({
    leftOut: [{ by: "Dana Ek", on: "2026-11-21", count: 2 }],
    setAside: true,
    tooLarge: 1,
  });
  assert.match(notes, /The board is in sync/);
  assert.match(
    notes,
    /2 changes from Dana Ek on 21 November could not be read and were left out/,
  );
  assert.match(
    notes,
    /Some changes are set aside until one they build on arrives/,
  );
  assert.match(
    notes,
    /1 value is too large for the sharing service and stays on this computer/,
  );
  for (const [state, detail] of [
    [
      "newer",
      "A newer MemCode laid this board out. Update MemCode to change it from this computer.",
    ],
    [
      "stopped",
      "The workspace could not be saved, so changes from the shared board are waiting.",
    ],
  ] as const) {
    const page = linked({ state, detail });
    assert.ok(page.includes(detail), page);
    assert.doesNotMatch(page, /The board is in sync/);
  }
  // Only the open project's board.
  assert.doesNotMatch(
    text(
      render(
        ready(),
        shown({
          sharedProjectLinks: [link({ projectId: app.id })],
          sharedBoards: [
            board({ projectId: app.id, state: "sending", waiting: 5 }),
          ],
        }),
      ),
    ),
    /Sending 5 changes/,
  );
});

test("a project with work of its own that meets a shared board says so in one plain sentence, and can stop", () => {
  const page = text(
    render(
      ready(),
      shown({
        sharedProjectLinks: [link()],
        sharedBoards: [board({ state: "apart" })],
      }),
    ),
  );
  assert.match(
    page,
    /website already has work of its own, so it cannot join Launch plan: connect a project that has none yet\./,
  );
  assert.match(page, /Stop sharing on this computer/);
  assert.doesNotMatch(page, /Keep both|The board is in sync|merged|Invite/);
});

test("a shared project that is gone, or shared under another account, says so and can stop", () => {
  const gone = text(
    render(
      ready({ projects: [redesign] }),
      shown({ sharedProjectLinks: [link()] }),
    ),
  );
  assert.match(
    gone,
    /Launch plan no longer exists, or you are no longer on it/,
  );
  assert.match(gone, /Stop sharing on this computer/);
  const elsewhere = text(
    render(
      ready({ accountId: "acct-other" }),
      shown({ sharedProjectLinks: [link()] }),
    ),
  );
  assert.match(elsewhere, /website is shared under another Memtrace account/);
  assert.match(elsewhere, /Stop sharing on this computer/);
});

test("signed out, the panel asks the person to sign in; unavailable, to try again", () => {
  const signedOut = text(render({ state: "signed-out", detail: "x" }));
  assert.match(signedOut, /Sign in to Memtrace to share website\. Sign in/);
  const unavailable = text(
    render({
      state: "unavailable",
      detail: "The sharing service could not be reached.",
    }),
  );
  assert.match(
    unavailable,
    /The sharing service could not be reached\. Try again/,
  );
  assert.doesNotMatch(unavailable, /is shared as/);
});

test("while the service cannot be asked, a shared project is still named, and the reason is said once", () => {
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
  assert.match(page, /website is shared as Launch plan/);
  assert.match(
    page,
    /2 changes made here are kept on this computer and sent when it works again/,
  );
});

test("a refusal is shown where the person is looking, and buttons wait while one is working", () => {
  const markup = render(
    ready(),
    shown({ sharedProjectLinks: [link()] }),
    website,
    { busy: "invite", error: "Free projects have room for 2 guests." },
  );
  assert.match(
    markup,
    /role="alert"[^>]*>[^<]*Free projects have room for 2 guests\./,
  );
  assert.match(markup, /aria-label="More for Bo Li"[^>]*disabled=""/);
  assert.match(markup, /<button class="share-cancel" disabled=""/);
});

test("names from the sharing service are shown as text, never as markup", () => {
  const hostile: SharedProject = {
    ...launch,
    name: '<img src=x onerror="alert(1)">',
    guests: [{ id: "acct-x", name: "<script>alert(2)</script>", isYou: false }],
    openInvitations: [{ id: "i", email: "<b>x</b>@example.com", sentAt: at }],
  };
  const markup = render(
    ready({ projects: [hostile] }),
    shown({ sharedProjectLinks: [link()] }),
  );
  assert.doesNotMatch(markup, /<img|<script|<b>/);
});

test("the switcher lists shared projects not on this computer yet, and invitations", () => {
  const linked = shown({ sharedProjectLinks: [link()] });
  const listed = sharedInSwitcher(linked, ready({ invitations: [invitation] }));
  assert.deepEqual(
    listed.toOpen.map((shared) => shared.name),
    ["Website redesign"],
  );
  assert.deepEqual(listed.invitations, [invitation]);
  for (const overview of [null, { state: "not-set" } as const])
    assert.deepEqual(sharedInSwitcher(linked, overview), {
      toOpen: [],
      invitations: [],
    });
  const page = text(
    renderToStaticMarkup(
      createElement(SwitcherShared, {
        state: { ...initialState(), ...linked } as AppState,
        overview: ready({ invitations: [invitation] }),
        act: async () => {},
        onOpened() {},
        headed: true,
      }),
    ),
  );
  assert.match(page, /Shared projects Website redesign From Dana Ek Open/);
  assert.match(page, /Garden app Invited by Dana Ek Join/);
  assert.doesNotMatch(page, /Launch plan/);
  // Under projects already shared on this computer, it goes on without a heading of its own.
  const continued = text(
    renderToStaticMarkup(
      createElement(SwitcherShared, {
        state: { ...initialState(), ...linked } as AppState,
        overview: ready({ invitations: [invitation] }),
        act: async () => {},
        onOpened() {},
        headed: false,
      }),
    ),
  );
  assert.doesNotMatch(continued, /Shared projects/);
  assert.match(continued, /Website redesign From Dana Ek Open/);
  assert.equal(
    renderToStaticMarkup(
      createElement(SwitcherShared, {
        state: { ...initialState(), ...linked } as AppState,
        overview: ready({ projects: [launch] }),
        act: async () => {},
        onOpened() {},
        headed: true,
      }),
    ),
    "",
  );
});
