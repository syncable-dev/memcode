import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initialState } from "../src/seed";
import type { AppState, WorkItem } from "../src/shared";
import { reviewWorkflowStates, isCodeReviewTask } from "../src/code-review-workflow";
import { initializePlanning, observePlanning } from "../src/planning/history";
import { applyTaskPatch } from "../runtime/task-planning";
import { TeamSyncClient } from "../runtime/team/client";
import { startTeamRelay } from "../runtime/team/relay";
import { planningHistorySchema, planningValueHash } from "../runtime/team/history";
import { workflowRolesSchema } from "../runtime/team/workflow-roles";
import type { TeamIdentityChallenge } from "../runtime/team-identity";
import { teamSyncReplySchema } from "../runtime/team/protocol";

const at = "2026-11-01T09:00:00.000Z";
function board(legacyReview = false): AppState {
  const state = initialState();
  state.projects = [{ id: "owner-project", name: "Workflow fixture", description: "", path: null, branch: "main", analysis: "idle", createdAt: at }];
  state.activeProjectId = "owner-project";
  state.tasks = [{ id: "story-one", identifier: "MC-001", projectId: "owner-project", title: "A shared fixture story", description: "Shared brief", stage: "planned", priority: "medium", category: "Work", harness: "codex", messages: [], checklist: [], createdAt: at, updatedAt: at, run: { state: "idle" } } satisfies WorkItem];
  state.epics = []; state.cycles = []; state.storyComments = []; state.reviewComments = []; state.team = [];
  state.workflowStates = reviewWorkflowStates("owner-project").filter((item) => item.id !== "owner-project:code-review");
  state.workflowStates.find((item) => item.stage === "review")!.name = "In review";
  if (legacyReview) {
    state.tasks[0].stage = "review";
    state.tasks[0].updatedAt = "2026-11-03T09:00:00.000Z";
    state.tasks.push(
      { ...structuredClone(state.tasks[0]), id: "story-unknown", identifier: "MC-002", statusId: "removed-status", updatedAt: "2026-11-04T09:00:00.000Z" },
      { ...structuredClone(state.tasks[0]), id: "story-valid", identifier: "MC-003", statusId: "owner-project:review", updatedAt: "2026-11-05T09:00:00.000Z" },
    );
  }
  initializePlanning(state, at);
  return state;
}
async function fixture(options: { oldRoles?: boolean; oldHistory?: boolean; legacyReview?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "memcode-workflow-roles-"));
  const verifyIdentity = async (proof: string, challenge: TeamIdentityChallenge) => {
    const value = JSON.parse(proof); assert.equal(value.nonce, challenge.nonce); assert.equal(value.audience, challenge.audience);
    return { issuer: "memtrace" as const, subject: value.subject, name: value.subject.toUpperCase(), email: `${value.subject}@example.test` };
  };
  let relay = await startTeamRelay({ dataDir: join(directory, "relay"), port: 0, verifyIdentity });
  const aState = board(options.legacyReview), bState = initialState(), requests: Array<{ path: string; method: string; body?: string }> = [];
  let rolesAvailable = !options.oldRoles, historyAvailable = !options.oldHistory, loseAck = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push({ path: url.pathname, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if ((!rolesAvailable && url.pathname === "/v1/workflow-roles") || (!historyAvailable && url.pathname === "/v1/planning-history")) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Older fixture service" } }), { status: 404 });
    const response = await fetch(input, init);
    if (loseAck && url.pathname === "/v1/workflow-roles" && init?.method === "POST" && response.ok) { loseAck = false; throw Error("Fixture lost workflow ACK"); }
    return response;
  };
  const opts = (subject: string) => ({ background: false, fetch: transport, identityProof: async (challenge: TeamIdentityChallenge) => JSON.stringify({ ...challenge, subject }) });
  let a: TeamSyncClient, b: TeamSyncClient;
  const changed = (state: AppState, client: () => TeamSyncClient) => async () => { await client().capture(); observePlanning(state); };
  a = new TeamSyncClient(() => aState, join(directory, "a"), changed(aState, () => a), opts("alice"));
  b = new TeamSyncClient(() => bState, join(directory, "b"), changed(bState, () => b), opts("bob"));
  await a.initialize(); await b.initialize();
  await mkdir(join(directory, "a", "team"), { recursive: true });
  await writeFile(join(directory, "a", "team", "service.private.json"), JSON.stringify({ endpoint: relay.url, bootstrapSecret: relay.adminCapability }));
  const team = await a.createTeamWorkspace({ name: "Workflow roles fixture" });
  const saved = async (side: "a" | "b") => JSON.parse(await readFile(join(directory, side, "team", "connections.json"), "utf8"));
  return { directory, aState, bState, requests, get a() { return a; }, get b() { return b; }, get relay() { return relay; },
    rolesAvailable(value: boolean) { rolesAvailable = value; }, historyAvailable(value: boolean) { historyAvailable = value; }, loseAck() { loseAck = true; }, saved,
    share() { return a.shareProject({ teamId: team.id, projectId: "owner-project" }); },
    async join(workspaceId: string) { const invite = await a.inviteTeamMember({ teamId: team.id, projectWorkspaceId: workspaceId }); return (await b.acceptTeamInvitation({ invite: invite.url })).project!; },
    async get(side: "a" | "b", path: string, body?: unknown) { const connection = (await saved(side)).connections[0]; return fetch(relay.url + path, { headers: { authorization: `Bearer ${connection.credential.capability}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) }); },
    async restart(beforeRelayStart?: () => Promise<void>) { await b.close(); await a.close(); const port = Number(new URL(relay.url).port); await relay.close(); await beforeRelayStart?.(); relay = await startTeamRelay({ dataDir: join(directory, "relay"), port, verifyIdentity }); a = new TeamSyncClient(() => aState, join(directory, "a"), changed(aState, () => a), opts("alice")); b = new TeamSyncClient(() => bState, join(directory, "b"), changed(bState, () => b), opts("bob")); await a.initialize(); await b.initialize(); },
    async close() { await b.close(); await a.close(); await relay.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("explicit workflow roles follow canonical identities across devices without changing original story dates", async () => {
  const f = await fixture();
  try {
    const shared = await f.share(), joined = await f.join(shared.workspace.workspaceId);
    const roles = f.aState.reviewWorkflows!["owner-project"], imported = f.bState.reviewWorkflows![joined.projectId];
    assert.ok(roles); assert.ok(imported);
    assert.notEqual(imported.codeReviewStatusId, roles.codeReviewStatusId);
    assert.equal(f.bState.workflowStates.find((item) => item.id === imported.codeReviewStatusId)?.name, "Code review");
    assert.equal(f.bState.workflowStates.filter((item) => item.projectId === joined.projectId).length, 5);
    const received = () => f.bState.tasks.find((item) => item.projectId === joined.projectId)!;
    assert.equal(received().createdAt, at); assert.equal(received().updatedAt, at);
    applyTaskPatch(f.aState, f.aState.tasks[0], { statusId: roles.codeReviewStatusId }, "2026-11-17T13:00:00.000Z");
    await f.a.capture(); await f.a.synchronize("owner-project"); await f.b.synchronize(joined.projectId);
    assert.equal(isCodeReviewTask(f.bState, received()), true);
    const requestCount = f.requests.filter((item) => item.method === "POST" && item.path === "/v1/workflow-roles").length;
    const times = [f.aState.tasks[0].updatedAt, received().updatedAt];
    await f.a.synchronize("owner-project"); await f.b.synchronize(joined.projectId);
    assert.equal(f.requests.filter((item) => item.method === "POST" && item.path === "/v1/workflow-roles").length, requestCount);
    assert.deepEqual([f.aState.tasks[0].updatedAt, received().updatedAt], times);
    const wire = (await f.saved("a")).connections[0], query = `?workspaceId=${wire.credential.workspaceId}`;
    planningHistorySchema.parse(await (await f.get("a", "/v1/planning-history" + query)).json());
    teamSyncReplySchema.parse(await (await f.get("a", "/v1/sync" + query + "&after=0&waitMs=0")).json());
    await f.restart(); await f.a.synchronize("owner-project"); await f.b.synchronize(joined.projectId);
    assert.deepEqual(f.bState.reviewWorkflows![joined.projectId], imported);
  } finally { await f.close(); }
});

test("first role bootstrap preserves legacy review dates through capture, a lost acknowledgement and relay restart", async () => {
  const f = await fixture({ oldRoles: true, legacyReview: true });
  try {
    const originals = new Map(f.aState.tasks.map((task) => [task.identifier, { createdAt: task.createdAt, updatedAt: task.updatedAt }]));
    const shared = await f.share(), joined = await f.join(shared.workspace.workspaceId);
    const originalHistory = planningHistorySchema.parse(await (await f.get("a", `/v1/planning-history?workspaceId=${shared.workspace.workspaceId}`)).json());
    assert.equal(f.aState.workflowStates.filter((item) => item.projectId === "owner-project").length, 4);
    f.rolesAvailable(true); f.loseAck();
    await assert.rejects(f.a.synchronize("owner-project"), /lost workflow ACK/);
    const pending = (await f.saved("a")).connections[0].workflowRoleOutbox[0];
    const workspaceId = shared.workspace.workspaceId;
    const acceptedHistory = planningHistorySchema.parse(await (await f.get("a", `/v1/planning-history?workspaceId=${workspaceId}`)).json());
    const accepted = workflowRolesSchema.parse(await (await f.get("a", `/v1/workflow-roles?workspaceId=${workspaceId}`)).json());
    assert.equal(accepted.revision, 1);
    assert.deepEqual(acceptedHistory.events, originalHistory.events, "Role bookkeeping must not invent story progress occurrences");
    assert.deepEqual(acceptedHistory.cycles, originalHistory.cycles);
    for (const task of f.aState.tasks) {
      const recorded = acceptedHistory.stories.find((item) => item.id === task.id)!;
      assert.equal(recorded.createdAt, originals.get(task.identifier)!.createdAt);
      assert.equal(recorded.updatedAt, originals.get(task.identifier)!.updatedAt);
      assert.equal(recorded.statusId, accepted.binding!.acceptanceStatusId);
    }
    await f.restart(); await f.a.synchronize("owner-project"); await f.b.synchronize(joined.projectId);
    for (const [state, projectId] of [[f.aState, "owner-project"], [f.bState, joined.projectId]] as const) {
      const roles = state.reviewWorkflows![projectId];
      assert.equal(state.workflowStates.filter((item) => item.projectId === projectId).length, 5);
      for (const task of state.tasks.filter((item) => item.projectId === projectId)) {
        assert.equal(task.createdAt, originals.get(task.identifier)!.createdAt);
        assert.equal(task.updatedAt, originals.get(task.identifier)!.updatedAt);
        assert.equal(task.statusId, roles.acceptanceStatusId);
        assert.equal(isCodeReviewTask(state, task), false);
      }
    }
    const replay = await f.get("a", "/v1/workflow-roles", { version: 1, workspaceId, ...pending });
    assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true);
    assert.equal((await f.saved("a")).connections[0].workflowRoleOutbox.length, 0);
    const task = f.aState.tasks[0];
    applyTaskPatch(f.aState, task, { statusId: f.aState.reviewWorkflows!["owner-project"].codeReviewStatusId }, "2026-11-17T13:00:00.000Z");
    await f.a.capture(); await f.a.synchronize("owner-project"); await f.b.synchronize(joined.projectId);
    const received = f.bState.tasks.find((item) => item.identifier === task.identifier && item.projectId === joined.projectId)!;
    assert.ok(Date.parse(received.updatedAt) > Date.parse(originals.get(task.identifier)!.updatedAt));
    assert.equal(isCodeReviewTask(f.bState, received), true);
  } finally { await f.close(); }
});

test("older workflow role journal entries retain their original replay semantics", async () => {
  const f = await fixture({ legacyReview: true });
  try {
    const shared = await f.share(), workspaceId = shared.workspace.workspaceId;
    await f.restart(async () => {
      // Model an entry written by the original role extension: no migration
      // marker, so replay must not add a new interpretation to that old event.
      const journal = join(f.directory, "relay", "workspaces", workspaceId + ".jsonl");
      const entries = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const roles = entries.filter((item) => item.kind === "workflow_roles");
      assert.equal(roles.length, 1); assert.equal(roles[0].assignLegacyReview, true);
      delete roles[0].assignLegacyReview;
      await writeFile(journal, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    });
    const history = planningHistorySchema.parse(await (await f.get("a", `/v1/planning-history?workspaceId=${workspaceId}`)).json());
    assert.equal(history.stories.find((item) => item.id === "story-one")!.statusId, undefined);
    assert.equal(history.stories.find((item) => item.id === "story-unknown")!.statusId, "removed-status");
    assert.equal(history.stories.find((item) => item.id === "story-one")!.updatedAt, "2026-11-03T09:00:00.000Z");
  } finally { await f.close(); }
});

test("role updates are authenticated, optimistic and durable across a lost acknowledgement", async () => {
  const f = await fixture();
  try {
    const shared = await f.share(); await f.join(shared.workspace.workspaceId);
    const connection = (await f.saved("a")).connections[0], workspaceId = connection.credential.workspaceId;
    const accepted = workflowRolesSchema.parse(await (await f.get("a", `/v1/workflow-roles?workspaceId=${workspaceId}`)).json());
    const update = { version: 1, workspaceId, opId: randomUUID(), expectedRevision: accepted.revision, expectedPlanningHash: accepted.planningHash, binding: accepted.binding };
    assert.equal((await f.get("b", "/v1/workflow-roles", update)).status, 403);
    assert.equal((await f.get("a", "/v1/workflow-roles", { ...update, expectedRevision: 0 })).status, 409);
    assert.equal((await f.get("a", "/v1/workflow-roles", { ...update, expectedPlanningHash: "0".repeat(64) })).status, 409);
    assert.equal((await f.get("a", "/v1/workflow-roles", { ...update, binding: { ...accepted.binding, codeReviewStatusId: "another-project-workflow" } })).status, 409);
    const roles = f.aState.reviewWorkflows!["owner-project"];
    f.aState.reviewWorkflows!["owner-project"] = { version: 1, codeReviewStatusId: roles.acceptanceStatusId, acceptanceStatusId: roles.codeReviewStatusId };
    await f.a.capture(); f.loseAck(); await assert.rejects(f.a.synchronize("owner-project"), /lost workflow ACK/);
    const pending = (await f.saved("a")).connections[0].workflowRoleOutbox[0];
    await f.restart(); await f.a.synchronize("owner-project");
    const final = workflowRolesSchema.parse(await (await f.get("a", `/v1/workflow-roles?workspaceId=${workspaceId}`)).json());
    assert.equal(final.revision, accepted.revision + 1);
    assert.equal((await f.saved("a")).connections[0].workflowRoleOutbox.length, 0);
    const replay = await f.get("a", "/v1/workflow-roles", { version: 1, workspaceId, ...pending });
    assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true);
    assert.equal((await f.get("a", "/v1/workflow-roles", { version: 1, workspaceId, ...pending, expectedRevision: 999 })).status, 409);
  } finally { await f.close(); }
});

test("older role services keep board sync working and recipients do not infer roles from names", async () => {
  const f = await fixture({ oldRoles: true });
  try {
    const shared = await f.share(), joined = await f.join(shared.workspace.workspaceId);
    assert.equal(f.bState.reviewWorkflows?.[joined.projectId], undefined);
    assert.equal(f.requests.some((item) => item.method === "POST" && item.path === "/v1/workflow-roles"), false);
    f.aState.tasks[0].title = "Board still works"; await f.a.capture(); await f.a.synchronize("owner-project"); await f.b.synchronize(joined.projectId);
    assert.equal(f.bState.tasks.find((item) => item.projectId === joined.projectId)!.title, "Board still works");
    f.rolesAvailable(true); await f.a.synchronize("owner-project"); await f.b.synchronize(joined.projectId);
    assert.ok(f.bState.reviewWorkflows?.[joined.projectId]);
  } finally { await f.close(); }
});

test("a concurrent workflow edit rejects stale role intent without overwriting the accepted workflow or dates", async () => {
  const f = await fixture();
  try {
    const shared = await f.share(), joined = await f.join(shared.workspace.workspaceId);
    const original = structuredClone(f.aState.reviewWorkflows!["owner-project"]);
    f.aState.reviewWorkflows!["owner-project"] = { version: 1, codeReviewStatusId: original.acceptanceStatusId, acceptanceStatusId: original.codeReviewStatusId };
    await f.a.capture();
    const recipientRole = f.bState.reviewWorkflows![joined.projectId];
    f.bState.workflowStates.find((item) => item.id === recipientRole.codeReviewStatusId)!.name = "Engineering review";
    await f.b.capture(); await f.b.synchronize(joined.projectId);
    await f.a.synchronize("owner-project");
    assert.deepEqual(f.aState.reviewWorkflows!["owner-project"], original);
    assert.equal(f.aState.workflowStates.find((item) => item.id === original.codeReviewStatusId)!.name, "Engineering review");
    assert.equal(f.aState.tasks[0].updatedAt, at);
    const saved = (await f.saved("a")).connections[0];
    assert.equal(saved.workflowRoleOutbox.length, 0);
    assert.equal(saved.rejectedWorkflowRoles.length, 1);
    assert.match(f.a.status("owner-project")!.error!, /workflow edit was rejected/);
  } finally { await f.close(); }
});

test("role publication waits for authoritative original planning history", async () => {
  const f = await fixture({ oldHistory: true });
  try {
    const shared = await f.share();
    assert.equal(f.requests.some((item) => item.method === "POST" && item.path === "/v1/workflow-roles"), false);
    const connection = (await f.saved("a")).connections[0];
    const response = await f.get("a", "/v1/workflow-roles", { version: 1, workspaceId: shared.workspace.workspaceId, opId: randomUUID(), expectedRevision: 0, expectedPlanningHash: planningValueHash({}), binding: { version: 1, codeReviewStatusId: "a", acceptanceStatusId: "b" } });
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "WORKFLOW_AUTHORITY");
    assert.ok(connection.pendingHistoryImport);
    f.historyAvailable(true); await f.a.synchronize("owner-project");
    assert.ok(f.aState.reviewWorkflows?.["owner-project"]);
    assert.equal((await f.saved("a")).connections[0].workflowRoles.revision, 1);
  } finally { await f.close(); }
});
