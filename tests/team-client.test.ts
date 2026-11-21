import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../src/seed";
import type { AppState, Project } from "../src/shared";
import { TeamSyncClient } from "../runtime/team/client";

function state(projectId: string, populated = false): AppState {
  const value = initialState();
  const project: Project = { id: projectId, name: "Fixture team", description: "", path: null, branch: "main", analysis: "idle", createdAt: "2026-11-15T12:00:00Z" };
  value.projects = [project]; value.activeProjectId = projectId;
  value.tasks = populated ? [{ ...value.tasks[0], id: "team-story", identifier: "MC-001", projectId, example: false, scope: [], epicId: null, cycleId: null, parentId: null, run: { state: "idle" }, messages: [{ id: "private", role: "tool", text: "PRIVATE-TOOL-SECRET", at: "2026-11-15T12:00:00Z" }] }] : [];
  value.epics = []; value.cycles = []; value.storyComments = []; value.reviewComments = []; value.artifacts = []; value.team = [];
  value.settings.memtracePath = "C:/PRIVATE/Memtrace.exe";
  return value;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memcode-team-client-"));
  const aState = state("local-A", true), bState = state("local-B");
  let offline = false, loseClaimAck = false, loseCommandAck = false;
  const bodies: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    if (offline) throw Error("Fixture transport offline");
    const body = typeof init?.body === "string" ? init.body : "";
    if (body) bodies.push(body);
    const response = await fetch(input, init);
    if (loseClaimAck && body.includes('"type":"claim.acquire"')) { loseClaimAck = false; throw Error("Fixture dropped accepted claim ACK"); }
    if (loseCommandAck && body.includes('"type":"story.patch"')) { loseCommandAck = false; throw Error("Fixture dropped accepted edit ACK"); }
    return response;
  };
  const a = new TeamSyncClient(() => aState, join(root, "a"), async () => {}, { background: false });
  let b = new TeamSyncClient(() => bState, join(root, "b"), async () => {}, { background: false, fetch: transport });
  await a.initialize(); await b.initialize();
  await a.create({ projectId: "local-A", displayName: "Alice" });
  const invite = await a.invite("local-A");
  await b.join({ projectId: "local-B", displayName: "Bob", invite: JSON.stringify(invite) });
  return {
    root, a, get b() { return b; }, aState, bState, bodies,
    offline(value: boolean) { offline = value; }, loseClaimAck() { loseClaimAck = true; }, loseCommandAck() { loseCommandAck = true; },
    async restartB(removeCredentials = false) { await b.close(); if (removeCredentials) await rm(join(root, "b", "team", "connections.json")); b = new TeamSyncClient(() => bState, join(root, "b"), async () => {}, { background: false, fetch: transport }); await b.initialize(); },
    async close() { await b.close(); await a.close(); await rm(root, { recursive: true, force: true }); },
  };
}
test("separate profiles share board/comments/results while local credentials and worker conversations stay private", async () => {
  const f = await fixture();
  try {
    assert.equal(f.bState.tasks[0].projectId, "local-B");
    assert.equal(f.bState.tasks[0].messages[0].role, "system");
    assert.doesNotMatch(JSON.stringify(f.bState.tasks[0]), /PRIVATE-TOOL-SECRET/);
    f.aState.tasks[0].title = "Shared task title";
    await f.a.capture(); await f.a.synchronize("local-A"); await f.b.synchronize("local-B");
    assert.equal(f.bState.tasks[0].title, "Shared task title");
    f.bState.storyComments!.push({ id: "comment-B", taskId: "team-story", text: "Ready for review", author: f.b.identity("local-B")!, createdAt: "2026-11-15T12:00:00Z", updatedAt: "2026-11-15T12:00:00Z" });
    await f.b.capture(); await f.b.synchronize("local-B"); await f.a.synchronize("local-A");
    assert.equal(f.aState.storyComments![0].text, "Ready for review");
    assert.equal(f.aState.storyComments![0].author.name, "Bob");
    assert.ok(f.a.status("local-A")!.unreadCount > 0);
    await f.a.read("local-A");
    assert.equal(f.a.status("local-A")!.unreadCount, 0);
    const outputDir = join(f.root, "a", "captures", "team-story"); await mkdir(outputDir, { recursive: true });
    const path = join(outputDir, "report.md"); await writeFile(path, "# Reviewed result\n\nShared, intentionally published.\n");
    f.aState.artifacts.push({ id: "report", taskId: "team-story", projectId: "local-A", name: "report.md", kind: "text", purpose: "report", path, source: "Codex", createdAt: "2026-11-15T12:00:00Z" });
    const result = await f.a.publish({ projectId: "local-A", taskId: "team-story", artifactId: "report" });
    await f.b.synchronize("local-B");
    const artifact = await f.b.download("local-B", result.id);
    assert.match(await readFile(artifact.path, "utf8"), /Reviewed result/);
    assert.notEqual(artifact.path, path);
    const saved = JSON.parse(await readFile(join(f.root, "b", "team", "connections.json"), "utf8"));
    assert.ok(saved.connections[0].credential.capability.length >= 32);
    assert.ok(!JSON.stringify(f.bState.team).includes(saved.connections[0].credential.capability));
    assert.doesNotMatch(f.bodies.join(""), /PRIVATE-TOOL-SECRET|PRIVATE\/Memtrace/);
  } finally { await f.close(); }
});
test("durable outbox survives offline restart and dropped ACKs without overwriting another field", async () => {
  const f = await fixture();
  try {
    f.offline(true); f.bState.tasks[0].title = "Offline edit";
    await f.b.capture(); await assert.rejects(f.b.synchronize("local-B"));
    assert.equal(f.b.status("local-B")!.pendingCount, 1);
    await f.restartB();
    f.aState.tasks[0].priority = "low"; await f.a.capture(); await f.a.synchronize("local-A");
    f.offline(false); f.loseCommandAck();
    await assert.rejects(f.b.synchronize("local-B"));
    await f.b.synchronize("local-B"); await f.a.synchronize("local-A");
    assert.equal(f.aState.tasks[0].title, "Offline edit");
    assert.equal(f.aState.tasks[0].priority, "low");
    assert.equal(f.b.status("local-B")!.pendingCount, 0);
  } finally { await f.close(); }
});
test("atomic claims recover a lost ACK and retain ownership while release is offline", async () => {
  const f = await fixture();
  try {
    f.loseClaimAck(); await assert.rejects(f.b.acquire("team-story", "local-B"), /confirmed online task claim/);
    await assert.rejects(f.a.acquire("team-story", "local-A"), /Bob already owns/);
    await f.b.acquire("team-story", "local-B");
    assert.equal(f.b.status("local-B")!.workspace.claims.length, 1);
    f.offline(true); await f.b.release("team-story", "local-B");
    await f.a.synchronize("local-A");
    assert.equal(f.a.status("local-A")!.workspace.claims.length, 1, "Transport disconnect does not grant a second worker permission");
    f.offline(false); await f.b.synchronize("local-B"); await f.a.synchronize("local-A");
    assert.equal(f.a.status("local-A")!.workspace.claims.length, 0);
    await f.a.acquire("team-story", "local-A"); await f.a.release("team-story", "local-A");
  } finally { await f.close(); }
});
test("a rejected edit restores the accepted value and does not block a later comment", async () => {
  const f = await fixture();
  try {
    await f.a.acquire("team-story", "local-A");
    f.bState.tasks = [];
    await f.b.capture();
    // A comment queued behind the rejected claimed-story deletion must still be delivered.
    f.bState.tasks = [{ ...f.aState.tasks[0], projectId: "local-B", run: { state: "idle" } }];
    f.bState.storyComments!.push({ id: "after-rejection", taskId: "team-story", text: "A later valid comment", author: f.b.identity("local-B")!, createdAt: "2026-11-15", updatedAt: "2026-11-15" });
    await f.b.capture(); await f.b.synchronize("local-B"); await f.a.synchronize("local-A");
    assert.ok(f.bState.tasks.some((task) => task.id === "team-story"));
    assert.ok(f.aState.storyComments!.some((comment) => comment.id === "after-rejection"));
    assert.equal(f.b.status("local-B")!.pendingCount, 0);
    assert.match(f.b.status("local-B")!.error!, /rejected/);
    await f.a.release("team-story", "local-A");
  } finally { await f.close(); }
});
test("a rejected deletion restores the original private conversation, runbook, reviews and planning history after restart", async () => {
  const f = await fixture();
  try {
    const task = f.bState.tasks[0];
    task.messages.push({ id: "private-followup", role: "user", text: "PRIVATE-FOLLOWUP", at: "2026-11-15T12:30:00Z" });
    task.checklist = [{ id: "runbook", text: "Original runbook step", done: true }];
    f.bState.reviewComments = [{ id: "review", taskId: task.id, text: "PRIVATE-REVIEW", reference: { kind: "file", taskId: task.id, name: "file.ts", quote: "Exact original selection", path: "C:/PRIVATE/repo/file.ts", lineStart: 10 }, status: "saved", createdAt: "2026-11-15", updatedAt: "2026-11-15" }];
    f.bState.planning.events.push({ id: "history", taskId: task.id, projectId: task.projectId, sequence: 1, at: "2026-11-15", kind: "created", after: { projectId: task.projectId, stage: "planned", cycleId: null, estimate: 5, archived: false } });
    await f.b.assertDeletionAllowed("story:delete", task.id);
    const token = await f.b.beginDeletion("story:delete", task.id);
    await f.a.acquire(task.id, "local-A"); // A claim arriving after the precheck must remain safe.
    f.bState.tasks = []; f.bState.reviewComments = []; f.bState.planning.events = f.bState.planning.events.filter((event) => event.taskId !== task.id);
    await f.b.capture(); await f.b.finishDeletion(token);
    await f.restartB();
    await f.b.synchronize("local-B");
    const restored = f.bState.tasks.find((item) => item.id === task.id)!;
    assert.ok(restored.messages.some((message) => message.text === "PRIVATE-FOLLOWUP"));
    assert.deepEqual(restored.checklist, task.checklist);
    assert.equal(f.bState.reviewComments![0].reference.path, "C:/PRIVATE/repo/file.ts");
    assert.ok(f.bState.planning.events.some((event) => event.id === "history"));
    assert.doesNotMatch(f.bodies.join(""), /PRIVATE-FOLLOWUP|PRIVATE-REVIEW|PRIVATE\/repo/);
    const privateProfile = JSON.parse(await readFile(join(f.root, "b", "team", "connections.json"), "utf8"));
    assert.equal(privateProfile.connections[0].deletions.length, 0);
    await f.a.release(task.id, "local-A");
  } finally { await f.close(); }
});
test("missing private credentials keep the configured team offline and fail worker starts closed", async () => {
  const f = await fixture();
  try {
    await f.restartB(true);
    assert.equal(f.b.status("local-B")!.connection, "offline");
    await assert.rejects(f.b.acquire("team-story", "local-B"), /credentials are missing/);
    await assert.rejects(f.b.assertDeletionAllowed("story:delete", "team-story"), /credentials/);
    await assert.rejects(f.b.create({ projectId: "local-B", displayName: "Bob" }), /already connected/);
  } finally { await f.close(); }
});
test("restart applies durable accepted planning before a stale workspace can re-publish it", async () => {
  const f = await fixture();
  try {
    const oldTitle = f.bState.tasks[0].title;
    f.bState.tasks[0].title = "Accepted durable title";
    await f.b.capture(); await f.b.synchronize("local-B");
    f.bState.tasks[0].title = oldTitle; // Simulate workspace.json lagging the private relay ACK.
    await f.restartB();
    assert.equal(f.bState.tasks[0].title, "Accepted durable title");
    assert.equal(f.b.status("local-B")!.pendingCount, 0);
    const deleted = f.bState.tasks[0];
    const oldBinding = structuredClone(f.bState.team);
    f.bState.tasks = []; await f.b.capture(); await f.b.synchronize("local-B");
    f.bState.tasks = [deleted]; f.bState.team = oldBinding; // Same crash window after a confirmed delete.
    await f.restartB();
    assert.equal(f.bState.tasks.length, 0);
    assert.equal(f.b.status("local-B")!.pendingCount, 0);
  } finally { await f.close(); }
});
test("sharing cannot leave an already-running or concurrently-starting worker outside team claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-share-race-"));
  const value = state("local-race", true);
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { reached = resolve; });
  const client = new TeamSyncClient(() => value, root, async () => {}, { background: false, fetch: async (input, init) => { if (String(input).endsWith("/v1/workspaces")) { reached(); await gate; } return fetch(input, init); } });
  try {
    await client.initialize();
    value.tasks[0].run.state = "running";
    await assert.rejects(client.create({ projectId: "local-race", displayName: "Alice" }), /Stop.*active workers/);
    value.tasks[0].run.state = "idle";
    const creating = client.create({ projectId: "local-race", displayName: "Alice" });
    await ready;
    await assert.rejects(client.acquire("team-story", "local-race"), /Wait.*Team connection/);
    release(); await creating;
  } finally { release(); await client.close(); await rm(root, { recursive: true, force: true }); }
});
