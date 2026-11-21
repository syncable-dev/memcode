import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import {
  activateProjectGuide,
  beginProjectGuide,
  firstRunGuide,
  projectGuide,
  previousGuideStep,
  needsAccountSetup,
} from "../src/onboarding";
import { registerOnboarding } from "../runtime/onboarding";
import { projectSharedState, sharedCommands } from "../runtime/team/projection";
function harness() {
  const state = initialState(),
    routes = new Map<
      string,
      { schema: any; handle: (input: any) => unknown }
    >();
  let saves = 0;
  registerOnboarding(
    (name, schema, handle) => routes.set(name, { schema, handle }),
    () => state,
    async () => {
      saves++;
    },
  );
  return {
    state,
    saves: () => saves,
    call: async (input: unknown) => {
      const route = routes.get("onboarding:update")!;
      return route.handle(route.schema.parse(input));
    },
  };
}
test("launch asks signed-out users to connect and preserves approved or temporarily unavailable sessions", () => {
  const beta = {
    state: "disconnected",
    accessMode: "beta",
    detail: "",
    loginPending: false,
  } as const;
  assert.equal(needsAccountSetup(beta), true);
  assert.equal(needsAccountSetup({ ...beta, state: "expired" }), true);
  assert.equal(needsAccountSetup({ ...beta, state: "connected" }), false);
  assert.equal(needsAccountSetup({ ...beta, state: "unavailable" }), false);
  assert.equal(needsAccountSetup(), false);
  const cli = { ...beta, accessMode: "installed-cli" } as const;
  const account = {
    status: "needs-sign-in",
    label: "",
    detail: "",
    loginPending: false,
  } as const;
  assert.equal(needsAccountSetup(cli), false);
  assert.equal(needsAccountSetup(cli, account), true);
  assert.equal(
    needsAccountSetup(cli, { ...account, status: "connected" }),
    false,
  );
  assert.equal(
    needsAccountSetup(cli, { ...account, status: "unavailable" }),
    true,
  );
  assert.equal(
    needsAccountSetup(cli, {
      ...account,
      status: "unknown",
      sessionVerified: true,
    }),
    false,
  );
});
test("first-run guidance appears for a new workspace, without taking over an existing project", () => {
  assert.equal(
    firstRunGuide({
      projects: [{ id: "example", example: true }, { id: "memcode-dogfood" }],
    }),
    false,
  );
  assert.equal(firstRunGuide({ projects: [{ id: "my-project" }] }), false);
  assert.equal(
    firstRunGuide({ projects: [{ id: "example", example: true }] }),
    true,
  );
  assert.equal(
    firstRunGuide({
      projects: [],
      onboarding: { version: 1, step: "worker", dismissed: true },
    }),
    false,
  );
});

test("optional local tools have a saved setup step without changing model preferences", async () => {
  const h = harness(),
    project = {
      ...h.state.projects[0],
      id: "local-tools-project",
      example: false,
    };
  h.state.projects.push(project);
  const settings = structuredClone(h.state.settings);
  await h.call({ projectId: project.id, step: "worker" });
  await h.call({ step: "local-tools" });
  await h.call({ dismissed: true });
  const restored = JSON.parse(JSON.stringify(h.state));
  assert.equal(projectGuide(restored, project.id)?.step, "local-tools");
  assert.equal(previousGuideStep("local-tools"), "worker");
  assert.equal(previousGuideStep("epic"), "local-tools");
  assert.equal(
    previousGuideStep("story"),
    "local-tools",
    "first work is one step; Back never stops at the old goal-first screen",
  );
  assert.deepEqual(h.state.settings, settings);
  await h.call({ dismissed: false, step: "epic" });
  assert.deepEqual(h.state.settings, settings);
});
test("guide progress validates project ownership and can pause, complete and explicitly restart", async () => {
  const h = harness(),
    project = { ...h.state.projects[0], id: "guide-project", example: false },
    other = { ...project, id: "other" };
  h.state.projects.push(project, other);
  h.state.epics.push({
    id: "guide-epic",
    projectId: project.id,
    identifier: "EP-01",
    title: "First outcome",
    description: "",
    phase: "now",
    color: "mint",
    order: 0,
  });
  const story = {
    ...h.state.tasks[0],
    id: "guide-story",
    projectId: project.id,
    epicId: "guide-epic",
    example: false,
  };
  h.state.tasks.push(story);
  await h.call({ step: "worker", projectId: project.id });
  await assert.rejects(h.call({ epicId: "missing" }), /goal in this project/);
  assert.equal(h.saves(), 1);
  await h.call({ step: "story", epicId: "guide-epic" });
  await h.call({ dismissed: true });
  assert.equal(h.state.onboarding?.step, "story");
  await h.call({ dismissed: false, storyId: story.id, step: "ready" });
  await assert.rejects(
    h.call({ projectId: other.id, epicId: "guide-epic" }),
    /goal in this project/,
  );
  await h.call({ complete: true });
  assert.ok(h.state.onboarding?.completedAt);
  assert.equal(h.state.onboarding?.dismissed, true);
  const reset = (await h.call({
    restart: true,
    step: "welcome",
    dismissed: false,
  })) as any;
  assert.equal(reset.completedAt, undefined);
  assert.equal(reset.projectId, undefined);
  assert.equal(reset.storyId, undefined);
  assert.equal(reset.dismissed, false);
});

test("a guided story without an epic can reach review, even when removed between sessions", async () => {
  const h = harness();
  const project = {
    ...h.state.projects[0],
    id: "first-review",
    example: false,
  };
  const story = {
    ...h.state.tasks[0],
    id: "first-story",
    projectId: project.id,
    epicId: null,
  };
  h.state.projects.push(project);
  h.state.tasks.push(story);
  await h.call({ projectId: project.id, step: "ready", storyId: story.id });
  await h.call({ step: "code-review", dismissed: true });
  assert.equal(projectGuide(h.state, project.id)?.storyId, story.id);
  h.state.tasks = h.state.tasks.filter((task) => task.id !== story.id);
  await h.call({ projectId: project.id, dismissed: false });
  assert.equal(projectGuide(h.state, project.id)?.step, "code-review");
  assert.equal(projectGuide(h.state, project.id)?.storyId, undefined);
  await h.call({ complete: true });
  assert.ok(projectGuide(h.state, project.id)?.completedAt);
});

test("each new project remembers its own guide; skip and future-project preference are separate", async () => {
  const h = harness();
  const projects = ["one", "two", "three"].map((id) => ({
    ...h.state.projects[0],
    id,
    example: false,
    path: `/synthetic/${id}`,
  }));
  h.state.projects.push(...projects);
  beginProjectGuide(h.state, projects[0]);
  assert.equal(projectGuide(h.state, "one")?.step, "context");
  await h.call({ projectId: "one", step: "memtrace" });
  await h.call({ projectId: "one", dismissed: true });
  beginProjectGuide(h.state, projects[1]);
  assert.equal(projectGuide(h.state, "two")?.dismissed, false);
  assert.equal(projectGuide(h.state, "one")?.dismissed, true);
  await h.call({
    projectId: "two",
    showForNewProjects: false,
    dismissed: true,
  });
  beginProjectGuide(h.state, projects[2]);
  assert.equal(projectGuide(h.state, "three")?.dismissed, true);
  await h.call({
    projectId: "three",
    restart: true,
    step: "context",
    dismissed: false,
  });
  assert.equal(projectGuide(h.state, "three")?.dismissed, false);
  assert.equal(h.state.onboardingPreferences?.showForNewProjects, false);
  activateProjectGuide(h.state, "one");
  assert.equal(h.state.onboarding?.step, "memtrace");
  assert.equal(h.state.onboarding?.dismissed, true);
  assert.equal(projectGuide(h.state, "two")?.dismissed, true);
  const restored = JSON.parse(JSON.stringify(h.state));
  activateProjectGuide(restored, "three");
  assert.equal(restored.onboarding.step, "context");
  assert.equal(restored.onboarding.dismissed, false);
});

test("finishing setup never requires or creates an epic, story or cycle", async () => {
  const h = harness(),
    project = { ...h.state.projects[0], id: "empty-project", example: false };
  h.state.projects.push(project);
  const before = {
    tasks: structuredClone(h.state.tasks),
    epics: structuredClone(h.state.epics),
    cycles: structuredClone(h.state.cycles),
  };
  beginProjectGuide(h.state, project);
  await h.call({ projectId: project.id, step: "epic", complete: true });
  assert.ok(projectGuide(h.state, project.id)?.completedAt);
  assert.equal(projectGuide(h.state, project.id)?.dismissed, true);
  assert.deepEqual(h.state.tasks, before.tasks);
  assert.deepEqual(h.state.epics, before.epics);
  assert.deepEqual(h.state.cycles, before.cycles);
});

test("an existing or joined board is not taken over by another project's guide", () => {
  const state = initialState(),
    local = { ...state.projects[0], id: "local", example: false },
    joined = { ...local, id: "joined", path: null };
  state.projects.push(local, joined);
  beginProjectGuide(state, local);
  const tasks = structuredClone(state.tasks);
  activateProjectGuide(state, joined.id);
  assert.equal(state.onboarding, undefined);
  assert.equal(projectGuide(state, joined.id), undefined);
  assert.equal(projectGuide(state, local.id)?.step, "context");
  assert.deepEqual(state.tasks, tasks);
  assert.equal(firstRunGuide(state), false);
});

test("personal setup progress and future-guide preferences never become Team changes", () => {
  const state = initialState(),
    project = {
      ...state.projects[0],
      id: "shared-personal-setup",
      example: false,
    };
  state.projects.push(project);
  const before = projectSharedState(state, project.id);
  beginProjectGuide(state, project);
  state.projectOnboarding![project.id].dismissed = true;
  state.onboardingPreferences = { showForNewProjects: false };
  const after = projectSharedState(state, project.id);
  assert.deepEqual(after, before);
  assert.deepEqual(sharedCommands(before, after), []);
  assert.doesNotMatch(
    JSON.stringify(after),
    /onboarding|showForNewProjects|dismissed/,
  );
});
