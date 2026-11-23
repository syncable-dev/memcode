import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamWorkspace } from "../src/components/TeamWorkspace";
import { guideArticles } from "../src/guide-content";
import {
  hasTeamPage,
  teamClaimForStory,
  teamStartBlocked,
  teamSyncLabel,
} from "../src/team-presentation";
import type {
  AppState,
  Artifact,
  Project,
  TeamWorkspaceState,
} from "../src/shared";

const project: Project = {
  id: "local-project",
  name: "Local project",
  path: "C:/local/project",
  description: "",
  branch: "main",
  analysis: "idle",
  createdAt: "2026-11-15T12:00:00Z",
};
function workspace(
  patch: Partial<TeamWorkspaceState> = {},
): TeamWorkspaceState {
  return {
    projectId: project.id,
    connection: "online",
    memberId: "alice",
    deviceId: "alice-pc",
    pendingCount: 0,
    unreadCount: 2,
    workspace: {
      workspaceId: "workspace",
      name: "Team project",
      head: 4,
      members: [
        {
          id: "alice",
          name: "Alice",
          role: "owner",
          joinedAt: "2026-11-15T12:00:00Z",
          devices: [{ id: "alice-pc", name: "Alice laptop" }],
        },
        {
          id: "bob",
          name: "Bob",
          role: "editor",
          joinedAt: "2026-11-15T12:00:00Z",
          devices: [{ id: "bob-pc", name: "Bob desktop" }],
        },
      ],
      stories: [],
      epics: [],
      cycles: [],
      comments: [],
      claims: [],
      results: [],
      activity: [],
      readCursors: [],
    },
    ...patch,
  };
}
function render(team?: TeamWorkspaceState, artifacts: Artifact[] = []) {
  return renderToStaticMarkup(
    createElement(TeamWorkspace, {
      state: {
        tasks: [],
        artifacts,
        team: team ? [team] : undefined,
      } as unknown as AppState,
      project,
      notify() {},
      open() {},
      openArtifact() {},
    }),
  );
}

test("shared story Start requires an online claim check, while local work stays available", () => {
  assert.equal(teamStartBlocked(undefined, "story"), undefined);
  assert.equal(teamStartBlocked(workspace(), "story"), undefined);
  assert.match(
    teamStartBlocked(workspace({ connection: "offline" }), "story")!,
    /Reconnect Team Sync/,
  );
  assert.match(
    teamStartBlocked(workspace({ connection: "connecting" }), "story")!,
    /Reconnect Team Sync/,
  );
  assert.equal(
    teamSyncLabel(workspace({ pendingCount: 3 })),
    "3 changes waiting",
  );
  assert.equal(
    teamSyncLabel(workspace({ connection: "offline", pendingCount: 3 })),
    "Offline",
  );
});

test("claim identity distinguishes the same member on another device and never infers Running", () => {
  const team = workspace();
  team.workspace.claims.push({
    storyId: "story",
    attemptId: "attempt",
    epoch: 1,
    memberId: "bob",
    deviceId: "bob-pc",
    acquiredAt: "2026-11-15T12:00:00Z",
  });
  assert.deepEqual(teamClaimForStory(team, "story")?.device, "Bob desktop");
  assert.match(
    teamStartBlocked(team, "story")!,
    /Bob holds this task on Bob desktop/,
  );
  team.memberId = "bob";
  assert.equal(teamClaimForStory(team, "story")?.local, false);
  team.deviceId = "bob-pc";
  assert.equal(teamStartBlocked(team, "story"), undefined);
  const markup = render(team);
  assert.match(markup, /Claim held/);
  assert.match(markup, /does not imply a worker is currently running/);
  assert.doesNotMatch(markup, />Running</);
});

test("legacy standalone setup explains current-state joining and its preview identity boundary", () => {
  const markup = render().replace(/\s+/g, " ");
  assert.match(markup, /Share this project/);
  assert.match(markup, /Join a project/);
  assert.match(markup, /open the project’s current board/);
  assert.match(markup, /Connect a local code folder later/);
  assert.match(markup, /not verified Memtrace team identities/);
  assert.match(markup, /uses Git for code/);
  assert.doesNotMatch(markup, /Alice|Bob|Account connected/);
});

test("the sharing guide explains Share, guests, own computers and what stays private", () => {
  const article = guideArticles.find((item) => item.id === "team")!;
  assert.equal(article.destination, "board");
  assert.ok(
    article.related?.every((id) =>
      guideArticles.some((item) => item.id === id),
    ),
  );
  const text = [...article.steps, article.note].join(" ");
  for (const detail of [
    "Share at the top right",
    "two guests",
    "choose Join",
    "choose Open",
    "approves their own coding tool in Workers",
    "Its conversation stays yours",
    "the request, how it stands, a summary of each round of work, its changes and its review",
    "Documents and images a worker makes are shared by themselves",
    "up to 5 MB each",
    "Share other files from a card’s Artifacts tab",
    "Use Git to exchange code",
    "Only you can continue your workers",
  ])
    assert.ok(text.includes(detail), detail);
  assert.doesNotMatch(text, /Create a team|Invite teammate|task claim/);
  assert.doesNotMatch(
    text,
    /empty MemCode project|enters a display name|Advanced connection/,
  );
  assert.ok(
    guideArticles.every(
      (item) =>
        item.related?.every((id) =>
          guideArticles.some((target) => target.id === id),
        ) ?? true,
    ),
  );
  assert.doesNotMatch(
    guideArticles.find((item) => item.id === "comments")!.steps.join(" "),
    /multiplayer is a later feature/,
  );
});

test("published result metadata is escaped and no local source path is exposed", () => {
  const team = workspace();
  const artifacts = [
    "quality-report.md",
    "explore-watch.mts",
    "runtime.log",
  ].map(
    (name) =>
      ({
        id: name,
        name,
        path: `C:/private/.memcode/workers/story/artifacts/${name}`,
        taskId: "story",
        projectId: project.id,
        source: "claude",
        kind: "text",
        createdAt: "2026-11-15T12:00:00Z",
      }) as Artifact,
  );
  team.workspace.results.push({
    id: "result",
    storyId: "story",
    name: "<img src=x onerror=alert(1)>.md",
    mime: "text/markdown",
    hash: "hash",
    size: 99,
    kind: "report",
    memberId: "bob",
    deviceId: "bob-pc",
    createdAt: "2026-11-15T12:00:00Z",
  });
  const markup = render(team, artifacts);
  assert.doesNotMatch(markup, /explore-watch|runtime\.log|C:\/private/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;\.md/);
  assert.doesNotMatch(markup, /<img src=x/);
  assert.match(markup, /does not report live teammate presence/);
});

test("the Team page is only for a project still in a Team Sync team", () => {
  const state = { team: [{ projectId: "in-a-team" }] } as never;
  assert.equal(hasTeamPage(state, "in-a-team"), true);
  assert.equal(hasTeamPage(state, "personal"), false);
  assert.equal(hasTeamPage({} as never, "personal"), false);
});
