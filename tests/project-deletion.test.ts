import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../src/seed";
import type { AppState, Project, WorkItem } from "../src/shared";
import { initializePlanning } from "../src/planning/history";
import { registerDeletion } from "../runtime/deletion";
import { createExampleArtifacts } from "../runtime/examples";
import { projectDeletionNote } from "../src/deletion";

const WEBSITE = "website";
const AT = "2026-11-23T12:00:00.000Z";

const project = (id: string, name: string): Project => ({
  id,
  name,
  description: "",
  path: `/work/${id}`,
  branch: "main",
  analysis: "idle",
  createdAt: AT,
});

/** The example project, and a "website" project with something in every place a project keeps things. */
function workspace(options: { forgotten?: string[] } = {}) {
  const state = initialState();
  initializePlanning(state);
  state.projects.push(project(WEBSITE, "Website"));
  const [template] = state.tasks;
  const task = (id: string, changes: Partial<WorkItem> = {}): WorkItem => ({
    ...template,
    id,
    identifier: id.toUpperCase(),
    projectId: WEBSITE,
    example: false,
    epicId: "website-goal",
    cycleId: "website-cycle",
    messages: [],
    run: { state: "idle" },
    ...changes,
  });
  state.tasks.push(task("web-1"), task("web-2"));
  state.epics.push({
    id: "website-goal",
    projectId: WEBSITE,
    identifier: "EP-01",
    title: "Launch",
    description: "",
    phase: "now",
    color: "mint",
    order: 0,
  });
  state.cycles.push({
    id: "website-cycle",
    projectId: WEBSITE,
    name: "First",
  } as never);
  state.workflowStates.push({ id: `${WEBSITE}:planned`, projectId: WEBSITE } as never);
  state.customFields.push({ id: "web-field", projectId: WEBSITE } as never);
  state.savedViews.push({ id: "web-view", projectId: WEBSITE } as never);
  state.qualitySnapshots.push({ id: "web-quality", projectId: WEBSITE } as never);
  state.artifacts.push({
    id: "web-report",
    taskId: "web-1",
    projectId: WEBSITE,
    name: "report.md",
    kind: "text",
    path: "/work/website/.memcode/report.md",
    createdAt: AT,
    source: "codex",
  });
  state.storyComments = [
    {
      id: "web-comment",
      taskId: "web-1",
      text: "Looks good",
      author: { id: "local", name: "You", source: "local" },
      createdAt: AT,
      updatedAt: AT,
    },
  ];
  state.fleetDeclarations = [
    { id: "web-declaration", taskId: "web-1", projectId: WEBSITE } as never,
  ];
  state.fleetProposals = [{ id: "web-proposal", projectId: WEBSITE } as never];
  state.fleetConflicts.push({
    id: "web-conflict",
    projectId: WEBSITE,
    taskIds: ["web-2"],
  } as never);
  state.pullRequests = [{ epicId: "website-goal" } as never];
  state.planning.events.push({
    id: "web-event",
    taskId: "web-1",
    projectId: WEBSITE,
  } as never);
  state.planning.authoritativeProjects = [WEBSITE];
  state.reviewWorkflows = { [WEBSITE]: {} as never };
  state.projectOnboarding = { [WEBSITE]: {} as never };
  state.sharedBoards = [{ projectId: WEBSITE } as never];
  state.activeProjectId = WEBSITE;

  const routes = new Map<string, { schema: any; run: (input: any) => unknown }>();
  let saved = 0;
  registerDeletion(
    (name, schema, run) => routes.set(name, { schema, run }),
    () => state,
    async () => void saved++,
    {
      forgetSharing: async (projectId) => {
        options.forgotten?.push(projectId);
      },
    },
  );
  return {
    state,
    saved: () => saved,
    deleteProject: async (id: string) => {
      const route = routes.get("project:delete")!;
      return route.run(route.schema.parse({ id }));
    },
  };
}

/** Every record anywhere in the workspace that still names the project. */
const traces = (state: AppState, projectId: string) =>
  JSON.stringify(state)
    .split(`"${projectId}`)
    .slice(1).length;

test("deleting a project removes its board and everything MemCode kept for it", async () => {
  const w = workspace();
  const examplesBefore = w.state.tasks.filter((task) => task.projectId === "example").length;
  await w.deleteProject(WEBSITE);
  assert.equal(traces(w.state, WEBSITE), 0, "nothing names the project");
  assert.deepEqual(
    w.state.projects.map((item) => item.id),
    ["example"],
  );
  assert.equal(
    w.state.tasks.filter((task) => task.projectId === "example").length,
    examplesBefore,
    "the other project keeps its tasks",
  );
  assert.equal(w.state.activeProjectId, "example");
  assert.equal(w.saved(), 1);
});

test("deleting a project leaves its folder and the files in it", async () => {
  const folder = await mkdtemp(join(tmpdir(), "memcode-project-delete-"));
  try {
    const w = workspace();
    w.state.projects.find((item) => item.id === WEBSITE)!.path = folder;
    await writeFile(join(folder, "index.ts"), "export const kept = true;");
    await w.deleteProject(WEBSITE);
    assert.equal(
      await readFile(join(folder, "index.ts"), "utf8"),
      "export const kept = true;",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a shared project is disconnected from this computer before it is deleted", async () => {
  const forgotten: string[] = [];
  const w = workspace({ forgotten });
  w.state.sharedProjectLinks = [{ projectId: WEBSITE } as never];
  await w.deleteProject(WEBSITE);
  assert.deepEqual(forgotten, [WEBSITE]);
  assert.equal(w.state.projects.some((item) => item.id === WEBSITE), false);
});

test("a project with a worker running is not deleted, and nothing of it is removed", async () => {
  const w = workspace();
  w.state.tasks.find((task) => task.id === "web-1")!.run = {
    state: "running",
    startedAt: AT,
  };
  const before = JSON.stringify(w.state);
  await assert.rejects(
    () => w.deleteProject(WEBSITE),
    /Stop the workers running in Website before deleting it\./,
  );
  assert.equal(JSON.stringify(w.state), before);
  assert.equal(w.saved(), 0);
});

test("a project still in a Team Sync team is not deleted until its team is left", async () => {
  const w = workspace();
  w.state.team = [{ projectId: WEBSITE } as never];
  await assert.rejects(
    () => w.deleteProject(WEBSITE),
    /Website is in a Team Sync team\. Leave the team on its Team page first\./,
  );
  assert.ok(w.state.projects.some((item) => item.id === WEBSITE));
});

test("the last project is not deleted", async () => {
  const w = workspace();
  await w.deleteProject("example");
  await assert.rejects(
    () => w.deleteProject(WEBSITE),
    /Add another project before deleting the last one\./,
  );
  assert.deepEqual(
    w.state.projects.map((item) => item.id),
    [WEBSITE],
  );
});

test("a project that is not there is not deleted", async () => {
  const w = workspace();
  await assert.rejects(() => w.deleteProject("nowhere"), /Project not found\./);
  assert.equal(w.saved(), 0);
});

test("once the example project is deleted, its sample files are not made again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memcode-example-gone-"));
  try {
    const w = workspace();
    await w.deleteProject("example");
    await createExampleArtifacts({ state: w.state, dir } as never);
    assert.equal(
      w.state.artifacts.some((artifact) => artifact.projectId === "example"),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the confirmation says what goes and that the folder stays", () => {
  assert.equal(
    projectDeletionNote(project(WEBSITE, "Website"), false),
    "This removes Website from MemCode: its board, tasks, goals, cycles, conversations and reviews. The folder /work/website and everything in it stay on your computer.",
  );
});

test("for a shared project the confirmation says it stays shared for the others", () => {
  assert.match(
    projectDeletionNote(project(WEBSITE, "Website"), true),
    /It stays shared for everyone else, and you can open it again from this menu\. To delete it for everyone, go to memtrace\.io\.$/,
  );
});

test("the example project's confirmation speaks of its sample tasks", () => {
  assert.equal(
    projectDeletionNote({ ...project("example", "Design preview"), example: true }, false),
    "This removes the example project and its sample tasks from MemCode.",
  );
});
