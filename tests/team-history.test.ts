import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { initialState } from "../src/seed";
import type { AppState, Cycle, Project, WorkItem } from "../src/shared";
import type { TeamSnapshot } from "../src/team";
import type { TaskEvent, TaskObservation } from "../src/planning/types";
import { defaultView } from "../src/planning/types";
import { cycleSeries, deliverySeries } from "../src/planning/analytics";
import { observePlanning } from "../src/planning/history";
import { TeamSyncClient } from "../runtime/team/client";
import { startTeamRelay } from "../runtime/team/relay";
import type { TeamIdentityChallenge } from "../runtime/team-identity";
import { teamSnapshotSchema, teamSyncReplySchema, teamEvent } from "../runtime/team/protocol";
import { projectPlanningHistory, applyPlanningHistory, advancePlanningHistory, planningMetadata, planningHistorySeed, planningSeedSchema, planningValueHash, type TeamPlanningHistory, type TeamPlanningSeed } from "../runtime/team/history";
import { projectSharedState } from "../runtime/team/projection";
import { emptyTeamLocalIds, localTeamId } from "../runtime/team/identity";
import { applyTaskPatch } from "../runtime/task-planning";
import { backlogStatusId, defaultWorkflow, isBacklogStatus, taskStatus, workflowFor } from "../src/planning/workflow";

const START = "2026-11-01T09:00:00.000Z";
const date = (minute: number) => new Date(Date.parse(START) + minute * 60_000).toISOString();
const createSeedDigest=(seed:TeamPlanningSeed)=>createHash("sha256").update(JSON.stringify(planningSeedSchema.parse(seed))).digest("hex");

/** Synthetic planning at the size of our real dogfood board; never load a user's profile. */
function board(projectId = "dogfood-owner"): AppState {
  const value = initialState(), template = value.tasks[0];
  const project: Project = { id: projectId, name: "History fixture", description: "PRIVATE PROJECT DESCRIPTION", path: "C:/PRIVATE/source", branch: "main", analysis: "ready", createdAt: START };
  value.projects = [project]; value.activeProjectId = projectId;
  value.tasks = Array.from({ length: 76 }, (_, i): WorkItem => ({
    ...template, id: `story-${String(i + 1).padStart(3, "0")}`, identifier: `MC-${String(i + 1).padStart(3, "0")}`,
    projectId, title: `Fixture story ${i + 1}`, description: "A deliberately shared brief.", example: false,
    stage: i < 41 ? "done" : i < 70 ? "planned" : "review", epicId: `epic-${i % 10}`,
    cycleId: i < 30 ? "cycle-complete" : "cycle-active", parentId: null, scope: ["src/work.ts"],
    estimate: [1, 2, 3, 5, 8][i % 5], startDate: "2026-11-01", dueDate: "2026-11-16",
    labels: [], createdAt: date(i), updatedAt: date(300 + i),
    checklist: [{ id: `check-${i}`, text: "Verify the shared outcome", done: false }],
    messages: [{ id: `private-message-${i}`, role: "tool", text: "PRIVATE TOOL OUTPUT", at: START }],
    run: { state: "idle", workspace: "C:/PRIVATE/source", sessionId: "PRIVATE SESSION" },
  }));
  value.epics = Array.from({ length: 10 }, (_, i) => ({ id: `epic-${i}`, identifier: `EP-${i + 1}`, projectId, title: `Fixture epic ${i + 1}`, description: "Shared outcome", phase: "now", color: "mint", order: i, branch: `epic/fixture-${i}` }));
  const makeCycle = (id: string, count: number, completed: boolean): Cycle => {
    const tasks = value.tasks.filter((task) => task.cycleId === id), sum = (items: WorkItem[]) => items.reduce((total, task) => total + (task.estimate ?? 0), 0);
    const snapshots = Array.from({ length: count }, (_, i) => {
      const done = Math.min(i, completed ? 30 : 11), review = completed ? 0 : 6;
      return { at: date(400 + i * 20), sequence: i + 1, total: tasks.length, completed: done, planned: tasks.length - done - review, working: 0, review, points: sum(tasks), completedPoints: sum(tasks.slice(0, done)), unestimated: 0 };
    });
    return { id, projectId, name: completed ? "Foundation" : "Reliability", goal: "A shared cycle goal", startDate: "2026-11-01", endDate: "2026-11-16", timeZone: "Europe/Copenhagen", state: completed ? "completed" : "active", capacity: 200, calendar: "weekdays", createdAt: date(1), startedAt: date(2), ...(completed ? { completedAt: date(1200) } : {}), baseline: snapshots[0], snapshots };
  };
  value.cycles = [makeCycle("cycle-complete", 34, true), makeCycle("cycle-active", 36, false)];
  value.workflowStates = (["planned", "working", "review", "done"] as const).map((stage, i) => ({ id: `workflow-${stage}`, projectId, name: `Custom ${stage}`, stage, color: "mint", order: i, wipLimit: stage === "working" ? 4 : null }));
  value.customFields = [{ id: "field-risk", projectId, name: "Risk", type: "select", options: ["Low", "High"] }];
  value.savedViews = [{ ...structuredClone(defaultView), id: "view-focus", projectId, name: "Epic focus", filters: { ...defaultView.filters, epicId: "epic-0", cycleId: "cycle-active" } }];
  for (const task of value.tasks) { task.statusId = `workflow-${task.stage}`; task.customFields = { "field-risk": "Low" }; }
  value.tasks[1].relatedIds = [value.tasks[0].id];
  value.tasks[2].duplicateOf = value.tasks[0].id;
  const events: TaskEvent[] = [], observations: Record<string, TaskObservation> = {};
  const event = (task: WorkItem, stage: WorkItem["stage"], kind: TaskEvent["kind"]) => {
    const before = observations[task.id], after: TaskObservation = { projectId, stage, cycleId: task.cycleId ?? null, estimate: task.estimate ?? null, archived: false };
    const sequence = events.length + 1;
    events.push({ id: `event-${sequence}`, sequence, taskId: task.id, projectId, at: date(100 + sequence), kind, ...(before ? { before } : {}), after });
    observations[task.id] = after;
  };
  value.tasks.forEach((task) => event(task, "planned", "created"));
  value.tasks.slice(0, 36).forEach((task) => { event(task, "working", "changed"); event(task, "planned", "changed"); });
  value.tasks.filter((task) => task.stage !== "planned").forEach((task) => event(task, task.stage, "changed"));
  assert.equal(events.length, 195);
  value.planning = { startedAt: START, events, observations };
  value.storyComments = Array.from({ length: 4 }, (_, i) => ({ id: `comment-${i}`, taskId: value.tasks[i].id, text: `Shared discussion ${i}`, author: { id: "owner", name: "Alice", source: "local" }, createdAt: date(20 + i), updatedAt: date(30 + i) }));
  value.reviewComments = []; value.artifacts = []; value.team = [];
  value.settings.memtracePath = "C:/PRIVATE/engine.exe";
  return value;
}

function personal(): AppState {
  const value = board("personal-project");
  value.tasks = value.tasks.slice(0, 1);
  value.epics = []; value.cycles = []; value.storyComments = [];
  value.planning.events = value.planning.events.filter((event) => event.taskId === value.tasks[0].id);
  value.planning.observations = { [value.tasks[0].id]: value.planning.observations[value.tasks[0].id] };
  return value;
}

async function fixture(options: { oldServer?: boolean; loseHistoryAck?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memcode-team-history-"));
  const verifyIdentity = async (proof: string, challenge: TeamIdentityChallenge) => {
    const identity = JSON.parse(proof);
    assert.equal(identity.nonce, challenge.nonce); assert.equal(identity.audience, challenge.audience);
    return { issuer: "memtrace" as const, subject: identity.subject, name: identity.subject.toUpperCase(), email: `${identity.subject}@example.test` };
  };
  let relay = await startTeamRelay({ dataDir: join(root, "relay"), port: 0, verifyIdentity });
  const aState = JSON.parse(JSON.stringify(board())) as AppState, bState = personal(), bodies: string[] = [], requests: string[] = [];
  let lost = false, offline = false, bOffline = false, historyAvailable = !options.oldServer;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (offline) throw Error("Fixture offline");
    if (typeof init?.body === "string" && !url.pathname.includes("auth") && !url.pathname.includes("/teams")) bodies.push(init.body);
    if (!historyAvailable && url.pathname === "/v1/planning-history") return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Old fixture service" } }), { status: 404, headers: { "content-type": "application/json" } });
    const response = await fetch(input, init);
    if (!historyAvailable && url.pathname === "/v1/service") {
      const value = await response.json() as Record<string, unknown>;
      delete value.planningHistory;
      return new Response(JSON.stringify(value), { status: response.status, headers: { "content-type": "application/json" } });
    }
    if (options.loseHistoryAck && !lost && url.pathname === "/v1/planning-history" && init?.method === "POST" && response.ok) { lost = true; throw Error("Fixture dropped accepted history ACK"); }
    return response;
  };
  const clientOptions = (subject: string) => ({ background: false, fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => subject === "bob" && bOffline ? Promise.reject(Error("Fixture Mac offline")) : transport(input, init), identityProof: async (challenge: TeamIdentityChallenge) => JSON.stringify({ ...challenge, subject }) });
  // Match runtime/app.ts: persistence first captures Team changes, then the
  // store observes planning. A no-op callback misses bootstrap echo bugs.
  const changed = (state: AppState,client:()=>TeamSyncClient) => async () => { await client().capture(); observePlanning(state, "2026-11-17T12:00:00.000Z"); };
  let a:TeamSyncClient,b:TeamSyncClient;
  a = new TeamSyncClient(() => aState, join(root, "a"), changed(aState,()=>a), clientOptions("alice"));
  b = new TeamSyncClient(() => bState, join(root, "b"), changed(bState,()=>b), clientOptions("bob"));
  await a.initialize(); await b.initialize();
  await mkdir(join(root, "a", "team"), { recursive: true });
  await writeFile(join(root, "a", "team", "service.private.json"), JSON.stringify({ endpoint: relay.url, bootstrapSecret: relay.adminCapability }));
  const team = await a.createTeamWorkspace({ name: "History roundtrip" });
  return { root, aState, bState, bodies, requests, team,
    get a() { return a; }, get b() { return b; }, get relay() { return relay; },
    offline(value: boolean) { offline = value; },
    offlineB(value: boolean) { bOffline = value; },
    historyAvailable(value: boolean) { historyAvailable = value; },
    async share() { return a.shareProject({ teamId: team.id, projectId: "dogfood-owner" }); },
    async join(workspaceId: string) {
      const invitation = await a.inviteTeamMember({ teamId: team.id, projectWorkspaceId: workspaceId });
      return b.acceptTeamInvitation({ invite: invitation.url });
    },
    async restart(beforeOpen?: () => Promise<void>) {
      await b.close(); await a.close();
      const port = Number(new URL(relay.url).port);
      await relay.close();
      await beforeOpen?.();
      relay = await startTeamRelay({ dataDir: join(root, "relay"), port, verifyIdentity });
      a = new TeamSyncClient(() => aState, join(root, "a"), changed(aState,()=>a), clientOptions("alice"));
      b = new TeamSyncClient(() => bState, join(root, "b"), changed(bState,()=>b), clientOptions("bob"));
      await a.initialize(); await b.initialize();
    },
    async close() { await b.close(); await a.close(); await relay.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("Backlog and intentional Planned outside a cycle roundtrip across two private project IDs and a relay restart", async () => {
  const f = await fixture();
  try {
    const ownerId = "dogfood-owner";
    const states = defaultWorkflow(ownerId).filter((state) => !isBacklogStatus(state.id));
    f.aState.workflowStates = states;
    f.aState.tasks.forEach((task) => { task.statusId = states.find((state) => state.stage === task.stage)!.id; });
    const original = f.aState.tasks.find((task) => task.identifier === "MC-042")!;
    original.cycleId = null;
    observePlanning(f.aState, date(6500));
    const originalDate = original.updatedAt;
    const shared = await f.share(), accepted = await f.join(shared.workspace.workspaceId);
    const memberId = accepted.project!.projectId;
    const remote = () => f.bState.tasks.find((task) => task.projectId === memberId && task.identifier === original.identifier)!;
    const lane = (state: AppState, task: WorkItem) => taskStatus(task, workflowFor(state, task.projectId)).name;
    const fromMember = async () => { await f.b.capture(); await f.b.synchronize(memberId); await f.a.synchronize(ownerId); };
    const fromOwner = async () => { await f.a.capture(); await f.a.synchronize(ownerId); await f.b.synchronize(memberId); };
    assert.equal(lane(f.bState, remote()), "Backlog");
    assert.equal(remote().updatedAt, originalDate);
    applyTaskPatch(f.bState, remote(), { statusId: memberId + ":planned", cycleId: null });
    await fromMember();
    assert.equal(lane(f.aState, original), "Planned");
    assert.equal(original.cycleId, null);
    applyTaskPatch(f.aState, original, { cycleId: "cycle-active" });
    await fromOwner();
    assert.equal(lane(f.bState, remote()), "Planned");
    assert.ok(remote().cycleId);
    applyTaskPatch(f.bState, remote(), { statusId: backlogStatusId(memberId) });
    await fromMember();
    await f.restart();
    await f.a.synchronize(ownerId); await f.b.synchronize(memberId);
    assert.equal(lane(f.aState, original), "Backlog");
    assert.equal(lane(f.bState, remote()), "Backlog");
    assert.equal(original.cycleId, null);
    assert.equal(remote().cycleId, null);
    assert.equal(f.aState.cycles.find((cycle) => cycle.id === "cycle-complete")!.snapshots.length, 34);
  } finally { await f.close(); }
});

test("history projection keeps original planning chronology and excludes execution, source and credentials", () => {
  const state = board(), seed = projectPlanningHistory(state, "dogfood-owner");
  assert.equal(seed.events.length, 195);
  assert.equal(seed.stories.length, 76);
  assert.equal(seed.cycles.reduce((sum, cycle) => sum + cycle.snapshots.length, 0), 70);
  assert.equal(seed.comments.length, 4);
  assert.equal(seed.startedAt, START);
  assert.doesNotMatch(JSON.stringify(seed), /PRIVATE|projectId|sessionId|messages|memtracePath|workspace|permission/);
});

test("native capture-before-save lifecycle does not echo bootstrap metadata or reset original story timestamps",async()=>{
  const f=await fixture();
  try{
    const original=projectPlanningHistory(f.aState,"dogfood-owner"),shared=await f.share();
    assert.deepEqual(projectPlanningHistory(f.aState,"dogfood-owner"),original);
    assert.equal(f.requests.filter((request)=>request==="POST /v1/planning-history/metadata").length,0,"Zod key normalization and missing optional fields are not edits");
    const saved=JSON.parse(await readFile(join(f.root,"a","team","connections.json"),"utf8")),connection=saved.connections.find((item:{projectId:string})=>item.projectId==="dogfood-owner");
    const post=async(path:string,body:unknown)=>{
      const response=await fetch(f.relay.url+path,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${connection.credential.capability}`},body:JSON.stringify(body)});
      return {status:response.status,body:await response.json()};
    };
    const noOp=await post("/v1/planning-history/metadata",{workspaceId:shared.workspace.workspaceId,opId:"noop-key-reordered",stories:planningMetadata(original).stories.map((story)=>Object.fromEntries(Object.entries(story).reverse())),planning:original.planning});
    assert.equal(noOp.status,200);
    assert.equal(planningValueHash(planningHistorySeed(noOp.body.history)),planningValueHash(original),"The relay also defends identical metadata from older clients");
    await f.a.synchronize("dogfood-owner");
    assert.deepEqual(projectPlanningHistory(f.aState,"dogfood-owner"),original);
  }finally{await f.close();}
});

async function legacyTimestampDamage(f:Awaited<ReturnType<typeof fixture>>,workspaceId:string){
  await f.a.synchronize("dogfood-owner");
  const saved=JSON.parse(await readFile(join(f.root,"a","team","connections.json"),"utf8")),connection=saved.connections.find((item:{projectId:string})=>item.projectId==="dogfood-owner");
  const metadata=planningMetadata(projectPlanningHistory(f.aState,"dogfood-owner"));
  const at=new Date().toISOString(),opId="legacy-metadata-noop",actor={memberId:connection.credential.memberId,deviceId:connection.credential.deviceId};
  const event=teamEvent(connection.snapshot,actor,opId,at,[],"Story runbooks and planning updated","planning.updated");
  await f.restart(async()=>{
    // Synthetic pre-fix journal only. Never touch a user's workspace or journal.
    const record={kind:"planning_metadata",dedup:`planning/${actor.memberId}/${actor.deviceId}/${opId}`,commandHash:planningValueHash({metadata}),event,metadata};
    await appendFile(join(f.root,"relay","workspaces",workspaceId+".jsonl"),JSON.stringify(record)+"\n");
  });
  await f.a.synchronize("dogfood-owner");
  return connection.credential;
}

test("owner timestamp recovery is narrow, durable and hash-bound to a no-op-only import journal",async()=>{
  const f=await fixture();
  try{
    const original=projectPlanningHistory(f.aState,"dogfood-owner"),shared=await f.share(),workspaceId=shared.workspace.workspaceId;
    await f.join(workspaceId);
    const credential=await legacyTimestampDamage(f,workspaceId);
    const get=async()=>{
      const response=await fetch(f.relay.url+`/v1/planning-history?workspaceId=${workspaceId}`,{headers:{authorization:`Bearer ${credential.capability}`}});
      assert.equal(response.status,200);return await response.json() as TeamPlanningHistory;
    };
    const broken=await get();
    assert.equal(new Set(broken.stories.map((story)=>story.updatedAt)).size,1,"Legacy records retain their original replay interpretation until corrected explicitly");
    assert.equal(broken.import?.hash,createSeedDigest(original));
    const body={workspaceId,opId:"restore-original-timestamps",expectedHead:broken.through,expectedImportHash:broken.import!.hash,expectedHistoryHash:planningValueHash(planningHistorySeed(broken))};
    const post=async(input:unknown,capability=credential.capability)=>{
      const response=await fetch(f.relay.url+"/v1/planning-history/repair-timestamps",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${capability}`},body:JSON.stringify(input)});
      return {status:response.status,body:await response.json()};
    };
    const recipient=JSON.parse(await readFile(join(f.root,"b","team","connections.json"),"utf8")).connections[0].credential;
    assert.equal((await post(body,recipient.capability)).status,403);
    assert.equal((await post({...body,expectedHead:broken.through-1})).status,409);
    assert.equal((await post({...body,expectedImportHash:"0".repeat(64)})).status,409);
    assert.equal((await post({...body,expectedHistoryHash:"0".repeat(64)})).status,409);
    const repaired=await post(body);
    assert.equal(repaired.status,200);assert.equal(repaired.body.corrected,76);
    assert.equal(planningValueHash(planningHistorySeed(repaired.body.history)),planningValueHash(original));
    assert.equal(repaired.body.history.import.hash,broken.import!.hash,"The original immutable import receipt is preserved");
    const replay=await post(body);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.body.corrected,76);
    assert.equal((await post({...body,expectedHead:body.expectedHead+1})).body.error.code,"OP_ID_REUSE");
    await f.restart();
    const afterRestart=await get();assert.equal(planningValueHash(planningHistorySeed(afterRestart)),planningValueHash(original));
    const replayAfterRestart=await post(body);assert.equal(replayAfterRestart.body.replayed,true);assert.equal(replayAfterRestart.body.corrected,76);
  }finally{await f.close();}
});

test("timestamp recovery refuses a genuine post-import planning edit instead of replacing later work",async()=>{
  const f=await fixture();
  try{
    const shared=await f.share(),workspaceId=shared.workspace.workspaceId,credential=await legacyTimestampDamage(f,workspaceId);
    f.aState.tasks[0].checklist[0].text="A genuine edit made after the import";
    await f.a.synchronize("dogfood-owner");
    const history=await (await fetch(f.relay.url+`/v1/planning-history?workspaceId=${workspaceId}`,{headers:{authorization:`Bearer ${credential.capability}`}})).json() as TeamPlanningHistory;
    const response=await fetch(f.relay.url+"/v1/planning-history/repair-timestamps",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${credential.capability}`},body:JSON.stringify({workspaceId,opId:"refuse-late-repair",expectedHead:history.through,expectedImportHash:history.import!.hash,expectedHistoryHash:planningValueHash(planningHistorySeed(history))})});
    assert.equal(response.status,409);assert.equal((await response.json()).error.code,"HISTORY_RECOVERY");
    assert.equal(f.aState.tasks[0].checklist[0].text,"A genuine edit made after the import");
  }finally{await f.close();}
});

test("joining a member does not invent cycle progress even when the last captured counts differ from the current board", () => {
  const state = board(), projection = projectSharedState(state, "dogfood-owner");
  const before: TeamSnapshot = { ...projection, workspaceId: "join-room", name: "History fixture", head: 10, comments: [], members: [], claims: [], results: [], activity: [], readCursors: [] };
  const history: TeamPlanningHistory = { ...projectPlanningHistory(state, "dogfood-owner"), version: 1, workspaceId: "join-room", through: 10 };
  history.cycles.find((cycle) => cycle.id === "cycle-active")!.snapshots.at(-1)!.completed = 5;
  const original = structuredClone(history);
  const member = { id: "new-member", name: "Mac", role: "editor" as const, devices: [{ id: "new-device", name: "Mac" }], joinedAt: "2026-11-17T12:00:00.000Z" };
  const after: TeamSnapshot = { ...before, head: 11, members: [member] };
  advancePlanningHistory(history, before, after, { id: "join-event", sequence: 11, opId: "join-op", memberId: member.id, deviceId: "new-device", at: member.joinedAt, changes: [{ collection: "members", id: member.id, value: member }] });
  assert.deepEqual(history.cycles, original.cycles, "Joining changes membership, not the historical evidence of progress");
  assert.deepEqual(history.events, original.events);
  assert.equal(history.through, 11, "The history cursor still catches up with the membership event");
});

test("applying portable history remaps all story/cycle identities without altering unrelated personal history", () => {
  const source = board(), target = structuredClone(source);
  target.projects[0].id = "joined-project";
  const binding = { credential: { workspaceId: "history-room" }, localIds: emptyTeamLocalIds() };
  for (const task of target.tasks) { task.projectId = "joined-project"; task.id = localTeamId(binding, "story", task.id); task.cycleId = localTeamId(binding, "cycle", task.cycleId!); }
  for (const cycle of target.cycles) { cycle.projectId = "joined-project"; cycle.id = localTeamId(binding, "cycle", cycle.id); cycle.snapshots = []; delete cycle.baseline; }
  for (const comment of target.storyComments!) { comment.id = localTeamId(binding, "comment", comment.id); comment.taskId = localTeamId(binding, "story", comment.taskId); }
  target.planning = { startedAt: date(9000), observations: {}, events: [] };
  const foreign: TaskEvent = { id: "personal-history", sequence: 1, taskId: "unrelated-story", projectId: "personal-project", at: START, kind: "created", after: { projectId: "personal-project", stage: "planned", cycleId: null, estimate: 1, archived: false } };
  target.planning.events.push(foreign);
  const history = { version: 1 as const, workspaceId: "history-room", through: 0, ...projectPlanningHistory(source, "dogfood-owner") };
  applyPlanningHistory(target, "joined-project", history, binding);
  assert.ok(target.planning.events.includes(foreign));
  const imported = target.planning.events.filter((event) => event.projectId === "joined-project");
  assert.equal(imported.length, 195);
  assert.ok(imported.every((event) => event.taskId.startsWith("team_") && event.after.projectId === "joined-project"));
  assert.ok(imported.every((event) => !event.after.cycleId || event.after.cycleId.startsWith("team_")));
  assert.deepEqual(imported.map((event) => event.at), source.planning.events.map((event) => event.at));
  assert.deepEqual(target.cycles[0].snapshots, source.cycles[0].snapshots);
  assert.equal(target.tasks[0].createdAt, source.tasks[0].createdAt);
  assert.equal(target.storyComments![0].createdAt, source.storyComments![0].createdAt);
  applyPlanningHistory(target, "joined-project", history, binding);
  assert.equal(target.planning.events.filter((event) => event.projectId === "joined-project").length, 195, "Reapplying a received history cannot duplicate progress");
});

test("real-sized shared dogfood preserves charts, original dates and comments on another profile and after restart", async () => {
  const f = await fixture();
  try {
    const ownerHistory = projectPlanningHistory(f.aState, "dogfood-owner"), privateTask = structuredClone(f.bState.tasks[0]);
    const shared = await f.share();
    const accepted = await f.join(shared.workspace.workspaceId), projectId = accepted.project!.projectId;
    const remoteTasks = f.bState.tasks.filter((task) => task.projectId === projectId), remoteCycles = f.bState.cycles.filter((cycle) => cycle.projectId === projectId);
    assert.equal(remoteTasks.length, 76); assert.equal(f.bState.epics.filter((epic) => epic.projectId === projectId).length, 10);
    assert.equal(remoteCycles.length, 2); assert.equal(remoteCycles.reduce((n, cycle) => n + cycle.snapshots.length, 0), 70);
    const workflows = f.bState.workflowStates.filter((workflow) => workflow.projectId === projectId), fields = f.bState.customFields.filter((field) => field.projectId === projectId), views = f.bState.savedViews.filter((view) => view.projectId === projectId);
    assert.equal(workflows.length, 4); assert.equal(fields.length, 1); assert.equal(views.length, 1);
    assert.ok(remoteTasks.every((task) => workflows.some((workflow) => workflow.id === task.statusId)), "Each story's custom workflow resolves on this computer");
    assert.equal(remoteTasks.find((task) => task.identifier === "MC-002")!.relatedIds![0], remoteTasks.find((task) => task.identifier === "MC-001")!.id);
    assert.equal(remoteTasks.find((task) => task.identifier === "MC-003")!.duplicateOf, remoteTasks.find((task) => task.identifier === "MC-001")!.id);
    assert.equal(remoteTasks[0].customFields?.[fields[0].id], "Low");
    assert.ok(f.bState.epics.some((epic) => epic.projectId === projectId && epic.id === views[0].filters.epicId));
    assert.ok(remoteCycles.some((cycle) => cycle.id === views[0].filters.cycleId));
    assert.equal(f.bState.planning.events.filter((event) => event.projectId === projectId).length, 195);
    assert.deepEqual(f.bState.tasks.find((task) => task.projectId === "personal-project"), privateTask);
    assert.deepEqual(remoteTasks.map((task) => task.createdAt).sort(), f.aState.tasks.map((task) => task.createdAt).sort());
    assert.deepEqual(remoteTasks.map((task) => task.updatedAt).sort(), f.aState.tasks.map((task) => task.updatedAt).sort());
    assert.deepEqual(remoteTasks[0].checklist, f.aState.tasks.find((task) => task.identifier === remoteTasks[0].identifier)!.checklist);
    for (const original of f.aState.cycles) {
      const received = remoteCycles.find((cycle) => cycle.name === original.name)!;
      assert.deepEqual(received.baseline, original.baseline); assert.equal(received.startedAt, original.startedAt); assert.equal(received.completedAt, original.completedAt);
      assert.deepEqual(cycleSeries(received, "points", date(5000)), cycleSeries(original, "points", date(5000)));
    }
    assert.deepEqual(deliverySeries(f.bState, projectId, 28, date(5000), "UTC"), deliverySeries(f.aState, "dogfood-owner", 28, date(5000), "UTC"));
    const remoteIds = new Set(remoteTasks.map((task) => task.id));
    assert.deepEqual(f.bState.storyComments!.filter((comment) => remoteIds.has(comment.taskId)).map((comment) => comment.createdAt).sort(), f.aState.storyComments!.map((comment) => comment.createdAt).sort());
    assert.doesNotMatch(JSON.stringify(f.bState.team), /PRIVATE/);
    assert.doesNotMatch(f.bodies.join(""), /PRIVATE TOOL OUTPUT|C:\/PRIVATE/);
    assert.doesNotThrow(() => teamSnapshotSchema.parse(f.a.status("dogfood-owner")!.workspace), "Old strict v1 clients can still parse unchanged board snapshots");
    const ownerProfile = JSON.parse(await readFile(join(f.root, "a", "team", "connections.json"), "utf8"));
    const legacySync = await fetch(`${f.relay.url}/v1/sync?workspaceId=${shared.workspace.workspaceId}&after=0&waitMs=0`, { headers: { authorization: `Bearer ${ownerProfile.connections[0].credential.capability}` } });
    assert.equal(legacySync.status, 200);
    const legacyReply: unknown = await legacySync.json();
    assert.doesNotThrow(() => teamSyncReplySchema.parse(legacyReply), "Legacy strict sync remains readable through the history import wake event");
    await f.restart(); await f.a.synchronize("dogfood-owner"); await f.b.synchronize(projectId);
    assert.equal(f.bState.cycles.filter((cycle) => cycle.projectId === projectId).reduce((n, cycle) => n + cycle.snapshots.length, 0), 70);
    assert.equal(f.bState.planning.events.filter((event) => event.projectId === projectId).length, 195);
    assert.deepEqual(projectPlanningHistory(f.aState, "dogfood-owner"), ownerHistory, "Sharing and restart do not rewrite the owner's original history");
  } finally { await f.close(); }
});

test("actual invitation join and local observers preserve an imported capture whose final counts differ from current scope", async () => {
  const f = await fixture();
  try {
    const last = f.aState.cycles.find((cycle) => cycle.name === "Reliability")!.snapshots.at(-1)!;
    last.completed = 5; last.planned = 35; last.completedPoints = 19;
    const original = projectPlanningHistory(f.aState, "dogfood-owner"), shared = await f.share();
    assert.deepEqual(projectPlanningHistory(f.aState, "dogfood-owner"), original);
    const accepted = await f.join(shared.workspace.workspaceId), projectId = accepted.project!.projectId;
    await f.a.synchronize("dogfood-owner"); await f.b.synchronize(projectId);
    for (const originalCycle of f.aState.cycles) {
      const received = f.bState.cycles.find((cycle) => cycle.projectId === projectId && cycle.name === originalCycle.name)!;
      assert.deepEqual(received.snapshots, original.cycles.find((cycle) => cycle.id === originalCycle.id)!.snapshots);
    }
    assert.equal(f.bState.cycles.filter((cycle) => cycle.projectId === projectId).reduce((n, cycle) => n + cycle.snapshots.length, 0), 70);
    assert.equal(f.bState.planning.events.filter((event) => event.projectId === projectId).length, 195);
    assert.deepEqual(projectPlanningHistory(f.aState, "dogfood-owner"), original, "Inviting or observing on either computer must not reconcile historical evidence into invented join-time progress");
  } finally { await f.close(); }
});

test("new planning progress is derived once at the relay and converges across devices, including archive changes", async () => {
  const f = await fixture();
  try {
    const shared = await f.share(), accepted = await f.join(shared.workspace.workspaceId), projectId = accepted.project!.projectId;
    const remote = f.bState.tasks.find((task) => task.projectId === projectId && task.identifier === "MC-042")!;
    const original = f.aState.tasks.find((task) => task.identifier === "MC-042")!;
    const worker = original.run, conversation = original.messages;
    remote.checklist[0].done = true;
    remote.relatedIds = [f.bState.tasks.find((task) => task.projectId === projectId && task.identifier === "MC-043")!.id];
    const field = f.bState.customFields.find((field) => field.projectId === projectId)!;
    field.name = "Delivery risk";
    remote.customFields![field.id] = "High";
    const view = f.bState.savedViews.find((view) => view.projectId === projectId)!;
    view.name = "Team focus, revised";
    await f.b.capture(); await f.b.synchronize(projectId); await f.a.synchronize("dogfood-owner");
    assert.equal(original.checklist[0].done, true);
    assert.deepEqual(original.relatedIds, [f.aState.tasks.find((task) => task.identifier === "MC-043")!.id]);
    const originalField = f.aState.customFields.find((field) => field.projectId === "dogfood-owner")!;
    assert.equal(originalField.name, "Delivery risk"); assert.equal(original.customFields![originalField.id], "High");
    assert.equal(f.aState.savedViews.find((view) => view.projectId === "dogfood-owner")!.name, "Team focus, revised");
    assert.equal(f.aState.planning.events.filter((event) => event.projectId === "dogfood-owner").length, 195, "Runbook and saved-view edits do not invent delivery transitions");
    for (const stage of ["working", "review", "done"] as const) {
      remote.stage = stage;
      await f.b.capture(); await f.b.synchronize(projectId); await f.a.synchronize("dogfood-owner");
      assert.equal(original.stage, stage);
    }
    assert.equal(original.run, worker); assert.equal(original.messages, conversation);
    const historyA = f.aState.planning.events.filter((event) => event.projectId === "dogfood-owner");
    const historyB = f.bState.planning.events.filter((event) => event.projectId === projectId);
    assert.equal(historyA.length, 198); assert.equal(historyB.length, 198);
    assert.deepEqual(historyB.map(({ at, kind, before, after }) => ({ at, kind, before: before && { ...before, projectId: undefined, cycleId: undefined }, after: { ...after, projectId: undefined, cycleId: undefined } })), historyA.map(({ at, kind, before, after }) => ({ at, kind, before: before && { ...before, projectId: undefined, cycleId: undefined }, after: { ...after, projectId: undefined, cycleId: undefined } })));
    assert.equal(f.bState.cycles.find((cycle) => cycle.projectId === projectId && cycle.name === "Foundation")!.snapshots.length, 34, "A completed cycle is not rewritten by a different cycle's work");
    assert.deepEqual(f.bState.cycles.find((cycle) => cycle.projectId === projectId && cycle.name === "Reliability")!.snapshots, f.aState.cycles.find((cycle) => cycle.name === "Reliability")!.snapshots);
    const before = structuredClone(f.aState.planning.events);
    const postsBeforeCapture = f.requests.filter((request) => request === "POST /v1/planning-history/metadata").length;
    await f.a.synchronize("dogfood-owner"); await f.b.synchronize(projectId); await f.a.capture(); await f.b.capture();
    assert.deepEqual(f.aState.planning.events, before, "Reading unchanged state or capturing it does not manufacture progress");
    await f.a.synchronize("dogfood-owner"); await f.b.synchronize(projectId);
    assert.equal(f.requests.filter((request) => request === "POST /v1/planning-history/metadata").length, postsBeforeCapture, "Pulled planning is not echoed back as a local edit");
    remote.archivedAt = date(6000);
    await f.b.capture(); await f.b.synchronize(projectId); await f.a.synchronize("dogfood-owner");
    assert.equal(original.archivedAt, date(6000));
    assert.equal(f.aState.planning.events.filter((event) => event.projectId === "dogfood-owner").length, 199);
    assert.equal(f.aState.planning.events.filter((event) => event.projectId === "dogfood-owner").at(-1)!.after.archived, true);
    await f.restart(); await f.b.synchronize(projectId); await f.a.synchronize("dogfood-owner");
    assert.equal(f.bState.tasks.find((task) => task.projectId === projectId && task.identifier === "MC-042")!.archivedAt, date(6000));
    assert.equal(f.aState.planning.events.filter((event) => event.projectId === "dogfood-owner").length, 199);
  } finally { await f.close(); }
});

test("a lost accepted history import acknowledgement retries from durable state without duplicating history", async () => {
  const f = await fixture({ loseHistoryAck: true });
  try {
    await f.share().catch((error) => assert.match(String(error), /dropped accepted history ACK/));
    assert.ok(f.a.status("dogfood-owner"), "The linked board survives a dropped import acknowledgement");
    await f.restart(); await f.a.synchronize("dogfood-owner");
    const shared = f.a.status("dogfood-owner")!, accepted = await f.join(shared.workspace.workspaceId), projectId = accepted.project!.projectId;
    assert.equal(f.bState.planning.events.filter((event) => event.projectId === projectId).length, 195);
    assert.equal(f.bState.cycles.filter((cycle) => cycle.projectId === projectId).reduce((total, cycle) => total + cycle.snapshots.length, 0), 70);
    assert.ok(f.requests.filter((request) => request === "POST /v1/planning-history").length >= 2, "Import was retried after acknowledgement loss");
    const profile = JSON.parse(await readFile(join(f.root, "a", "team", "connections.json"), "utf8"));
    assert.ok(!profile.connections[0].pendingHistoryImport, "Successful retry retires the durable import intent");
  } finally { await f.close(); }
});

test("a service without history support still shares v1 planning and preserves local history for a future upgrade", async () => {
  const f = await fixture({ oldServer: true });
  try {
    const original = projectPlanningHistory(f.aState, "dogfood-owner");
    const shared = await f.share(), accepted = await f.join(shared.workspace.workspaceId);
    assert.equal(f.bState.tasks.filter((task) => task.projectId === accepted.project!.projectId).length, 76);
    assert.doesNotThrow(() => teamSnapshotSchema.parse(f.a.status("dogfood-owner")!.workspace));
    assert.deepEqual(projectPlanningHistory(f.aState, "dogfood-owner"), original, "Compatibility fallback must not erase the owner's historical planning");
    assert.ok(!f.requests.some((request) => request === "POST /v1/planning-history"), "Never send an unsupported import to an older relay");
    const profile = JSON.parse(await readFile(join(f.root, "a", "team", "connections.json"), "utf8"));
    assert.ok(profile.connections[0].pendingHistoryImport, "Original history remains durably queued until the service supports importing it");
  } finally { await f.close(); }
});

test("an upgraded legacy rich owner preserves local planning until explicitly importing the authoritative baseline", async () => {
  const f = await fixture({ oldServer: true });
  try {
    const original = projectPlanningHistory(f.aState, "dogfood-owner"), shared = await f.share();
    f.historyAvailable(true);
    await f.restart(async () => {
      const path = join(f.root, "a", "team", "connections.json"), profile = JSON.parse(await readFile(path, "utf8"));
      for (const connection of profile.connections) {
        for (const key of ["history", "pendingHistoryImport", "historyOutbox", "planningBaseline", "rejectedHistory", "retainedPlanningEvents"]) delete connection[key];
      }
      await writeFile(path, JSON.stringify(profile));
    });
    await f.a.synchronize("dogfood-owner");
    assert.deepEqual(projectPlanningHistory(f.aState, "dogfood-owner"), original, "A sparse relay baseline cannot replace rich private historical planning during upgrade");
    assert.equal(f.a.status("dogfood-owner")!.planningHistory?.state, "pending");
    assert.match(f.a.status("dogfood-owner")!.planningHistory?.detail ?? "", /original|import|histor/i);
    await f.a.importPlanningHistory("dogfood-owner");
    assert.equal(f.a.status("dogfood-owner")!.planningHistory?.state, "synced");
    const accepted = await f.join(shared.workspace.workspaceId), projectId = accepted.project!.projectId;
    assert.equal(f.bState.tasks.filter((task) => task.projectId === projectId).length, 76);
    assert.equal(f.bState.planning.events.filter((event) => event.projectId === projectId).length, 195);
    assert.equal(f.bState.cycles.filter((cycle) => cycle.projectId === projectId).reduce((n, cycle) => n + cycle.snapshots.length, 0), 70);
    assert.deepEqual(projectPlanningHistory(f.aState, "dogfood-owner"), original);
  } finally { await f.close(); }
});

test("explicit refresh discovers a history service upgrade without restarting either app", async () => {
  const f = await fixture({ oldServer: true });
  try {
    const original = projectPlanningHistory(f.aState, "dogfood-owner"), shared = await f.share();
    const accepted = await f.join(shared.workspace.workspaceId), projectId = accepted.project!.projectId;
    assert.equal(f.a.status("dogfood-owner")!.planningHistory?.state, "unsupported");
    assert.equal(f.b.status(projectId)!.planningHistory?.state, "unsupported");
    f.historyAvailable(true);
    await f.a.synchronize("dogfood-owner");
    await f.b.synchronize(projectId);
    assert.equal(f.a.status("dogfood-owner")!.planningHistory?.state, "synced");
    assert.equal(f.b.status(projectId)!.planningHistory?.state, "synced");
    assert.deepEqual(projectPlanningHistory(f.aState, "dogfood-owner"), original);
    assert.equal(f.bState.planning.events.filter((event) => event.projectId === projectId).length, 195);
    assert.equal(f.bState.cycles.filter((cycle) => cycle.projectId === projectId).reduce((n, cycle) => n + cycle.snapshots.length, 0), 70);
  } finally { await f.close(); }
});

test("an offline stale runbook cannot overwrite an accepted edit; the rejected draft survives and unrelated changes continue", async () => {
  const f = await fixture();
  try {
    const shared = await f.share(), accepted = await f.join(shared.workspace.workspaceId), projectId = accepted.project!.projectId;
    const remote = (identifier: string) => f.bState.tasks.find((task) => task.projectId === projectId && task.identifier === identifier)!;
    const owner = (identifier: string) => f.aState.tasks.find((task) => task.identifier === identifier)!;
    f.offlineB(true);
    remote("MC-042").checklist[0].text = "Mac draft that must be preserved";
    await f.b.capture();
    remote("MC-043").checklist[0].text = "Independent Mac verification";
    await f.b.capture();
    await assert.rejects(f.b.synchronize(projectId), /offline/);
    owner("MC-042").checklist[0].text = "Windows accepted verification";
    await f.a.capture(); await f.a.synchronize("dogfood-owner");
    f.offlineB(false);
    await f.b.synchronize(projectId); await f.a.synchronize("dogfood-owner");
    assert.equal(owner("MC-042").checklist[0].text, "Windows accepted verification");
    assert.equal(remote("MC-042").checklist[0].text, "Windows accepted verification");
    assert.equal(owner("MC-043").checklist[0].text, "Independent Mac verification");
    assert.equal(f.b.status(projectId)!.planningHistory?.state, "error");
    assert.match(f.b.status(projectId)!.planningHistory?.detail ?? "", /reject|chang|conflict|review/i);
    const saved = JSON.parse(await readFile(join(f.root, "b", "team", "connections.json"), "utf8"));
    const connection = saved.connections.find((connection: { projectId: string }) => connection.projectId === projectId);
    assert.match(JSON.stringify(connection.rejectedHistory), /Mac draft that must be preserved/);
    assert.equal(connection.historyOutbox.length, 0, "One rejected edit cannot block later independent edits");
    await f.restart();
    const restored = JSON.parse(await readFile(join(f.root, "b", "team", "connections.json"), "utf8"));
    assert.match(JSON.stringify(restored.connections.find((connection: { projectId: string }) => connection.projectId === projectId).rejectedHistory), /Mac draft that must be preserved/);
  } finally { await f.close(); }
});

test("history import enforces owner access, scope, stable operation contents and durable replay", async () => {
  const f = await fixture({ oldServer: true });
  try {
    const shared = await f.share(); await f.join(shared.workspace.workspaceId);
    const credentials = async (profile: string) => JSON.parse(await readFile(join(f.root, profile, "team", "connections.json"), "utf8")).connections[0].credential as { capability: string };
    const owner = await credentials("a"), editor = await credentials("b");
    const get = async () => {
      const response = await fetch(`${f.relay.url}/v1/planning-history?workspaceId=${shared.workspace.workspaceId}`, { headers: { authorization: `Bearer ${owner.capability}` } });
      assert.equal(response.status, 200); return response.json() as Promise<TeamPlanningHistory>;
    };
    const history = projectPlanningHistory(f.aState, "dogfood-owner"), request = { workspaceId: shared.workspace.workspaceId, opId: "fixture-history-import", expectedHead: (await get()).through, history };
    const send = async (capability: string, body: unknown) => fetch(f.relay.url + "/v1/planning-history", { method: "POST", headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await send(editor.capability, request)).status, 403);
    assert.equal((await send(owner.capability, { ...request, history: { ...history, stories: history.stories.slice(1) } })).status, 409, "Never attach another board's partial history");
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    for (const [name, forge] of [
      ["project", (seed: typeof history) => { seed.startedAt = future; }],
      ["story", (seed: typeof history) => { seed.stories[0].updatedAt = future; }],
      ["cycle snapshot", (seed: typeof history) => { seed.cycles[0].snapshots[0].at = future; }],
      ["transition", (seed: typeof history) => { seed.events[0].at = future; }],
      ["comment", (seed: typeof history) => { seed.comments[0].createdAt = future; }],
    ] as const) {
      const forged = structuredClone(history); forge(forged);
      const rejected = await send(owner.capability, { ...request, history: forged });
      assert.equal(rejected.status, 409, `An import cannot forge a future ${name} timestamp`);
      assert.equal((await rejected.json()).error.code, "HISTORY_SOURCE");
    }
    const first = await send(owner.capability, request);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).replayed, false);
    const replay = await send(owner.capability, request);
    assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true);
    assert.equal((await send(owner.capability, { ...request, history: { ...history, startedAt: date(9999) } })).status, 409, "An operation ID cannot be reused for different history");
    await f.restart();
    const durable = await send(owner.capability, request);
    assert.equal(durable.status, 200); assert.equal((await durable.json()).replayed, true);
    const legacyEdit = await fetch(f.relay.url + "/v1/commands", { method: "POST", headers: { authorization: `Bearer ${editor.capability}`, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: shared.workspace.workspaceId, opId: "legacy-story-edit", command: { type: "story.patch", storyId: "story-076", patch: { stage: "planned" } } }) });
    assert.equal(legacyEdit.status, 200);
    const afterLegacyEdit = await get();
    assert.equal(afterLegacyEdit.events.length, 196, "An older client writing only the strict v1 protocol still contributes canonical history");
    assert.equal(afterLegacyEdit.events.at(-1)!.after.stage, "planned");
    assert.deepEqual(afterLegacyEdit.events.slice(0, 195).map((event) => event.at), history.events.map((event) => event.at));
  } finally { await f.close(); }
});
