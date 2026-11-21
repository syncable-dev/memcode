import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initialState } from "../src/seed";
import type { AppState, Project } from "../src/shared";
import { TeamSyncClient } from "../runtime/team/client";

const at = "2026-11-15T12:00:00Z";
function state(projectId: string, name: string, privateText: string): AppState {
  const value = initialState();
  const project: Project = { id: projectId, name, description: "", path: null, branch: "main", analysis: "idle", createdAt: at };
  value.projects = [project]; value.activeProjectId = projectId;
  value.tasks = [{ ...value.tasks[0], id: "seeded-story", identifier: "MC-001", projectId, example: false,
    title: name + " story", epicId: "seeded-epic", cycleId: "seeded-cycle", parentId: null, scope: [],
    messages: [{ id: "private-message", role: "tool", text: privateText, at }], run: { state: "idle" } }];
  value.epics = [{ id: "seeded-epic", projectId, identifier: "EP-01", title: name + " epic", description: "", phase: "now", color: "mint", order: 0 }];
  value.cycles = [{ id: "seeded-cycle", projectId, name: name + " cycle", goal: "", startDate: "2026-11-15", endDate: "2026-11-29", state: "active", timeZone: "UTC", capacity: 10, calendar: "weekdays", snapshots: [], createdAt: at }];
  value.storyComments = [{ id: "seeded-comment", taskId: "seeded-story", text: name + " comment", author: { id: "local-owner", name: "You", source: "local" }, createdAt: at, updatedAt: at }];
  value.artifacts = []; value.reviewComments = []; value.team = [];
  return value;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memcode-team-invite-"));
  const aState = state("host-project", "Shared project", "HOST-PRIVATE-TOOL-TEXT");
  const bState = state("personal-project", "Personal project", "PERSONAL-PRIVATE-TOOL-TEXT");
  const bodies: string[] = [];
  const transport: typeof fetch = (input, init) => { if (typeof init?.body === "string") bodies.push(init.body); return fetch(input, init); };
  const a = new TeamSyncClient(() => aState, join(root, "a"), async () => {}, { background: false });
  let b = new TeamSyncClient(() => bState, join(root, "b"), async () => {}, { background: false, fetch: transport });
  await a.initialize(); await b.initialize(); await a.create({ projectId: "host-project", displayName: "Alice" });
  const invite = JSON.stringify(await a.invite("host-project"));
  return { root, a, aState, bState, bodies, get b() { return b; }, invite,
    async restartB() { await b.close(); b = new TeamSyncClient(() => bState, join(root, "b"), async () => {}, { background: false, fetch: transport }); await b.initialize(); },
    async close() { await b.close(); await a.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("an invitation opens the complete shared board without an empty local project and preserves colliding personal records", async () => {
  const f = await fixture();
  try {
    const privateBefore = structuredClone({ project: f.bState.projects[0], task: f.bState.tasks[0], epic: f.bState.epics[0], cycle: f.bState.cycles[0], comment: f.bState.storyComments![0] });
    const output = join(f.root, "a", "captures", "seeded-story", "report.md"); await mkdir(dirname(output), { recursive: true }); await writeFile(output, "# Existing result\n\nReady before the invitation.\n");
    f.aState.artifacts.push({ id: "host-report", projectId: "host-project", taskId: "seeded-story", name: "report.md", path: output, kind: "text", purpose: "report", source: "fixture", createdAt: at });
    const result = await f.a.publish({ projectId: "host-project", taskId: "seeded-story", artifactId: "host-report" });
    const joined = await f.b.join({ invite: f.invite, displayName: "Bob" });
    const project = f.bState.projects.find((item) => item.id === joined.projectId)!;
    const task = f.bState.tasks.find((item) => item.projectId === project.id)!;
    assert.equal(project.name, "Shared project"); assert.equal(project.path, null); assert.equal(project.analysis, "idle");
    assert.equal(f.bState.activeProjectId, project.id); assert.notEqual(project.id, "personal-project");
    assert.notEqual(task.id, "seeded-story"); assert.match(task.id, /^[A-Za-z0-9_-]{1,200}$/);
    assert.equal(task.title, "Shared project story"); assert.equal(task.run.state, "idle");
    assert.equal(task.messages[0].role, "system");
    assert.equal(joined.workspace.stories[0].id, task.id);
    assert.equal(joined.workspace.comments[0].storyId, task.id);
    assert.equal(joined.workspace.results[0].storyId, task.id);
    assert.equal(f.bState.epics.find((item) => item.id === task.epicId)?.title, "Shared project epic");
    assert.equal(f.bState.cycles.find((item) => item.id === task.cycleId)?.name, "Shared project cycle");
    assert.deepEqual({ project: f.bState.projects.find((item) => item.id === "personal-project"), task: f.bState.tasks.find((item) => item.id === "seeded-story"), epic: f.bState.epics.find((item) => item.id === "seeded-epic"), cycle: f.bState.cycles.find((item) => item.id === "seeded-cycle"), comment: f.bState.storyComments!.find((item) => item.id === "seeded-comment") }, privateBefore);
    assert.doesNotMatch(JSON.stringify(joined), /PRIVATE-TOOL-TEXT|capability|localIds/);
    const artifact = await f.b.download(project.id, result.id);
    assert.equal(artifact.taskId, task.id); assert.match(await readFile(artifact.path, "utf8"), /Existing result/);

    task.title = "Edited from the invited board";
    f.bState.storyComments!.push({ id: "bob-comment", taskId: task.id, text: "Hello from Bob", author: f.b.identity(project.id)!, createdAt: at, updatedAt: at });
    f.bState.tasks.push({ ...task, id: "bob-new-story", identifier: "MC-002", parentId: task.id, title: "Bob child", messages: [], run: { state: "idle" } });
    await f.b.synchronize(project.id); await f.a.synchronize("host-project");
    assert.equal(f.aState.tasks.find((item) => item.id === "seeded-story")!.title, task.title);
    assert.equal(f.aState.tasks.find((item) => item.id === "bob-new-story")!.parentId, "seeded-story");
    assert.equal(f.aState.tasks.find((item) => item.id === "bob-new-story")!.epicId, "seeded-epic");
    assert.ok(f.aState.storyComments!.some((item) => item.taskId === "seeded-story" && item.text === "Hello from Bob"));
    assert.ok(!f.aState.storyComments!.some((item) => item.text === "Personal project comment"));
    await f.b.acquire(task.id, project.id); await f.a.synchronize("host-project");
    assert.equal(f.b.status(project.id)!.workspace.claims[0].storyId, task.id);
    await assert.rejects(f.a.acquire("seeded-story", "host-project"), /Bob already owns/);
    await f.b.release(task.id, project.id); await f.a.acquire("seeded-story", "host-project");
    await assert.rejects(f.b.assertDeletionAllowed("story:delete", task.id), /active task claim/);
    await f.a.release("seeded-story", "host-project");
    const bobOutput = join(f.root, "b", "captures", task.id, "bob-report.md"); await mkdir(dirname(bobOutput), { recursive: true }); await writeFile(bobOutput, "# Bob result\n");
    f.bState.artifacts.push({ id: "bob-report", projectId: project.id, taskId: task.id, name: "bob-report.md", path: bobOutput, kind: "text", purpose: "report", source: "fixture", createdAt: at });
    const bobResult = await f.b.publish({ projectId: project.id, taskId: task.id, artifactId: "bob-report" });
    assert.equal(bobResult.storyId, task.id);
    await f.a.synchronize("host-project");
    const hostDownload = await f.a.download("host-project", bobResult.id);
    assert.equal(hostDownload.taskId, "seeded-story"); assert.equal(await readFile(hostDownload.path, "utf8"), "# Bob result\n");
    assert.ok(!f.bodies.join("").includes(task.id), "Device-local namespaced IDs never go to the relay");
    assert.ok(!f.bodies.join("").includes("PERSONAL-PRIVATE-TOOL-TEXT"));
    const stableId = task.id;
    await f.restartB(); await f.b.synchronize(project.id);
    assert.equal(f.bState.tasks.find((item) => item.projectId === project.id && item.identifier === "MC-001")!.id, stableId);
    assert.ok(f.bState.tasks.find((item) => item.id === "bob-new-story"), "A locally created story keeps its own stable UUID");
  } finally { await f.close(); }
});

test("a late rejected deletion restores a namespaced story's private history", async () => {
  const f = await fixture();
  try {
    const joined = await f.b.join({ invite: f.invite, displayName: "Bob" });
    const task = f.bState.tasks.find((item) => item.projectId === joined.projectId)!;
    task.messages.push({ id: "joined-private-message", role: "assistant", text: "Private joined conversation", at });
    await f.b.assertDeletionAllowed("story:delete", task.id);
    const deletion = await f.b.beginDeletion("story:delete", task.id);
    await f.a.acquire("seeded-story", "host-project");
    f.bState.tasks = f.bState.tasks.filter((item) => item.id !== task.id);
    f.bState.storyComments = f.bState.storyComments!.filter((item) => item.taskId !== task.id);
    await f.b.capture(); await f.b.finishDeletion(deletion);
    await f.restartB(); await f.b.synchronize(joined.projectId);
    const restored = f.bState.tasks.find((item) => item.id === task.id)!;
    assert.equal(restored.projectId, joined.projectId);
    assert.ok(restored.messages.some((item) => item.text === "Private joined conversation"));
    assert.ok(f.bState.tasks.some((item) => item.id === "seeded-story" && item.projectId === "personal-project"));
    await f.a.release("seeded-story", "host-project");
  } finally { await f.close(); }
});

test("opening an already joined invitation selects its linked project without consuming it again", async () => {
  const f = await fixture();
  try {
    const joined = await f.b.join({ invite: f.invite, displayName: "Bob" });
    const projectCount = f.bState.projects.length;
    f.bState.activeProjectId = "personal-project";
    const opened = await f.b.join({ invite: f.invite, displayName: "Bob again" });
    assert.equal(opened.projectId, joined.projectId); assert.equal(f.bState.projects.length, projectCount);
    assert.equal(f.bState.activeProjectId, joined.projectId);
    await f.a.synchronize("host-project"); assert.equal(f.a.status("host-project")!.workspace.members.length, 2);
  } finally { await f.close(); }
});

test("a linked board recovers from credentials saved before the public workspace save", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-team-join-crash-"));
  const aState = state("host", "Shared project", "HOST-SECRET"), before = state("personal", "Personal", "PERSONAL-SECRET");
  let bState = structuredClone(before);
  const a = new TeamSyncClient(() => aState, join(root, "a"), async () => {}, { background: false });
  let b = new TeamSyncClient(() => bState, join(root, "b"), async () => { throw Error("Fixture public save failed"); }, { background: false });
  try {
    await a.initialize(); await b.initialize(); await a.create({ projectId: "host", displayName: "Alice" });
    await assert.rejects(b.join({ invite: JSON.stringify(await a.invite("host")), displayName: "Bob" }), /public save failed/);
    const linked = bState.projects.find((item) => item.id !== "personal")!;
    const taskId = bState.tasks.find((item) => item.projectId === linked.id)!.id;
    await b.close(); bState = structuredClone(before);
    b = new TeamSyncClient(() => bState, join(root, "b"), async () => {}, { background: false });
    await b.initialize(); await b.synchronize(linked.id);
    assert.equal(bState.projects.find((item) => item.id === linked.id)?.name, "Shared project");
    assert.equal(bState.activeProjectId, linked.id);
    assert.equal(bState.tasks.find((item) => item.id === taskId)?.projectId, linked.id);
    assert.deepEqual(bState.tasks.find((item) => item.projectId === "personal"), before.tasks[0]);
  } finally { await b.close(); await a.close(); await rm(root, { recursive: true, force: true }); }
});
