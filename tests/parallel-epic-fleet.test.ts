import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import type { HarnessRuntime, Project, WorkItem } from "../src/shared";
import type { MemtraceEngine } from "../runtime/memtrace";
import { FleetCoordinator } from "../runtime/fleet";
import { touchedIdentities } from "../runtime/coordination";
import { rereadFleetSource } from "../runtime/fleet-source";
import { WorkerManager } from "../runtime/workers";
import { git } from "../runtime/local";
import { approveFixtureWorker } from "./fixtures/worker-consent";

function story(
  project: Project,
  id: string,
  epic: string,
  workspace: string,
): WorkItem {
  return {
    id,
    identifier: `MC-${id}`,
    projectId: project.id,
    epicId: epic,
    title: id,
    description: "Fixture",
    priority: "medium",
    category: "Work",
    harness: "codex",
    assignment: "manual",
    stage: "working",
    checklist: [],
    messages: [],
    scope: [],
    createdAt: project.createdAt,
    updatedAt: project.createdAt,
    run: { state: "running", branch: `epic/${epic}`, workspace },
    evidence: {
      state: "partial",
      symbols: [
        {
          name: "shared",
          file: join(workspace, "shared.ts"),
          line: 1,
          nodeId: `private-graph-${id}`,
        },
      ],
      incomplete: true,
      note: "Fixture evidence",
      measuredAt: project.createdAt,
    },
  };
}
async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "memcode-epic-fleet-"));
  const original = join(root, "original"),
    a = join(root, "a"),
    b = join(root, "b");
  for (const path of [original, a, b]) {
    await mkdir(path);
    await writeFile(
      join(path, "shared.ts"),
      `export const source = ${JSON.stringify(path === original ? "original" : path === a ? "epic A" : "epic B")};\n`,
    );
  }
  const project: Project = {
    id: "canonical-project",
    name: "Canonical",
    description: "",
    path: original,
    branch: "main",
    repoId: "canonical-repo",
    analysis: "ready",
    createdAt: new Date().toISOString(),
  };
  return { root, original, a, b, project };
}

test("same-epic workers coordinate across graph IDs while independent epic leases remain separate", async () => {
  const f = await sourceFixture();
  for (const [path, branch] of [
    [f.a, "epic/a"],
    [f.b, "epic/b"],
  ]) {
    await git(path, ["init", "--initial-branch=" + branch]);
    await git(path, ["add", "shared.ts"]);
    await git(path, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
  }
  const state = initialState();
  state.projects = [f.project];
  state.fleetConflicts = [];
  const a1 = story(f.project, "a1", "a", f.a),
    a2 = story(f.project, "a2", "a", f.a),
    b = story(f.project, "b", "b", f.b);
  state.tasks = [a1, a2, b];
  const calls: Array<{ project: Project; name: string; args: any }> = [],
    leases = new Map<string, string[]>();
  const engine = {
    call: async (project: Project, name: string, args: any) => {
      calls.push({ project, name, args });
      if (name === "fleet_acquire_lease") {
        if (
          [...leases.values()].some((scope) =>
            scope.some((key) => args.scope.includes(key)),
          )
        )
          return { state: "requested" };
        const lease_id = `lease:${args.agent_id}`;
        leases.set(lease_id, args.scope);
        return { state: "granted", lease_id };
      }
      if (name === "fleet_renew_lease") {
        assert.ok(leases.has(args.lease_id));
        return { state: "granted" };
      }
      if (name === "fleet_release_lease") {
        leases.delete(args.lease_id);
        return { state: "released" };
      }
      if (name === "fleet_record_episode") return { conflict_class: "A" };
      return {};
    },
  } as unknown as MemtraceEngine;
  const fleet = new FleetCoordinator(
    () => state,
    engine,
    async () => {},
    () => {
      throw Error("Ordinary overlap must not become a human conflict");
    },
  );
  try {
    const expectedFile =
      "file::" +
      (process.platform === "win32"
        ? join(f.original, "shared.ts").toLowerCase()
        : join(f.original, "shared.ts")
      ).replaceAll("\\", "/");
    assert.ok(touchedIdentities(a1, f.project).includes(expectedFile));
    assert.ok(touchedIdentities(a2, f.project).includes(expectedFile));
    await fleet.before(f.project, a1);
    await fleet.before(f.project, a2);
    await fleet.before(f.project, b);
    assert.equal(
      leases.size,
      2,
      "Only the first same-epic owner and independent epic own reservations",
    );
    assert.ok(!leases.has("lease:memcode:a2"));
    const aScope = leases.get("lease:memcode:a1")!,
      bScope = leases.get("lease:memcode:b")!;
    assert.equal(
      aScope.some((key) => bScope.includes(key)),
      false,
    );
    assert.ok(aScope.some((key) => key.includes('branch::"epic/a"::file::')));
    for (const call of calls.filter((item) =>
      ["fleet_preflight", "fleet_publish_intent"].includes(item.name),
    )) {
      assert.equal(call.project, f.project);
      assert.equal(call.args.repo_id, "canonical-repo");
      assert.ok(["epic/a", "epic/b"].includes(call.args.branch));
      assert.ok(
        !call.args.touched.some((key: string) => key.startsWith("branch::")),
        "Published source identities retain normal branch semantics",
      );
    }
    await fleet.heartbeat(f.project, a1);
    assert.equal(state.fleetConflicts.length, 0);
  } finally {
    for (const task of state.tasks) await fleet.release(f.project, task);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a Class B source refresh reads the worker's execution checkout without changing canonical coordination", async () => {
  const f = await sourceFixture();
  try {
    const task = story(f.project, "a", "a", f.a);
    task.scope = ["shared.ts"];
    task.evidence = undefined;
    const result = await rereadFleetSource(f.project, task);
    assert.match(result.files[0].text!, /epic A/);
    assert.doesNotMatch(result.files[0].text!, /original/);
    assert.equal(f.project.path, f.original);
    assert.equal(f.project.branch, "main");
    assert.match(
      await readFile(join(f.original, "shared.ts"), "utf8"),
      /original/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("WorkerManager qualifies the private epic graph while Fleet retains the canonical project", async () => {
  const f = await sourceFixture();
  await git(f.original, ["init", "--initial-branch=main"]);
  await git(f.original, ["add", "shared.ts"]);
  await git(f.original, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  const state = initialState();
  state.projects = [f.project];
  state.tasks = [];
  state.fleetConflicts = [];
  state.settings.maxWorkers = 3;
  const task = story(f.project, "contract", "a", f.a);
  task.run = { state: "idle" };
  task.stage = "planned";
  task.evidence = undefined;
  state.tasks = [task];
  state.epics = [
    {
      id: "a",
      identifier: "EP-A",
      projectId: f.project.id,
      title: "A",
      description: "",
      phase: "now",
      color: "mint",
      order: 0,
    },
  ];
  approveFixtureWorker(state, "codex");
  const bound: Project[] = [],
    released: Project[] = [],
    canonical = structuredClone(f.project);
  const engine = {
    ownedWorktreeSupport: async () => true,
    analyze: async (project: Project) => {
      bound.push(project);
      return "private-epic-repo";
    },
    qualify: async (project: Project) => {
      bound.push(project);
      return {
        state: "partial",
        symbols: [],
        incomplete: true,
        note: "Fixture graph",
        measuredAt: new Date().toISOString(),
      };
    },
    releaseEpic: async (project: Project) => {
      released.push(project);
    },
    call: async () => ({}),
  } as unknown as MemtraceEngine;
  const runtimes: HarnessRuntime[] = [
    {
      id: "codex",
      name: "Fixture",
      available: true,
      path: process.execPath,
      models: [
        {
          id: "fixture-model",
          label: "Fixture model",
          source: "cache",
          tier: "balanced",
        },
      ],
    },
  ];
  const manager = new WorkerManager(
    () => state,
    async () => {},
    engine,
    join(f.root, "profile"),
    async () => ({ command: process.execPath, prefix: [] }),
    async () => runtimes,
  );
  let fleetProject: Project | undefined;
  Object.assign(manager, {
    fleet: {
      before: async (project: Project) => {
        fleetProject = project;
        throw Error("Fixture contract boundary");
      },
      release: async () => {},
    },
  });
  try {
    await assert.rejects(
      manager.start(task, f.project),
      /Fixture contract boundary/,
    );
    assert.equal(fleetProject, f.project);
    assert.equal(bound.length, 2);
    assert.equal(bound[0].id, bound[1].id);
    assert.notEqual(bound[1].id, f.project.id);
    assert.equal(bound[1].repoId, "private-epic-repo");
    assert.equal(resolve(bound[1].path!), resolve(task.run.workspace!));
    assert.deepEqual(f.project, canonical);
    assert.ok(released.some((project) => project.id === bound[1].id));
    assert.equal(task.run.analysisRepoId, "private-epic-repo");
  } finally {
    await manager.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a slow epic graph flush releases the global worker startup slot before it finishes", async () => {
  const f = await sourceFixture(),
    state = initialState();
  const task = story(f.project, "finished-a", "a", f.a);
  task.run.state = "finished";
  task.run.analysisProjectId = "owned-a";
  task.run.analysisRepoId = "private-a";
  state.projects = [f.project];
  state.tasks = [task];
  let entered!: () => void,
    finish!: () => void,
    completed = false;
  const began = new Promise<void>((resolve) => (entered = resolve)),
    flush = new Promise<void>((resolve) => (finish = resolve));
  const engine = {
    releaseEpic: async (project: Project) => {
      assert.equal(project.id, "owned-a");
      entered();
      await flush;
      completed = true;
    },
  } as unknown as MemtraceEngine;
  const manager = new WorkerManager(
    () => state,
    async () => {},
    engine,
    join(f.root, "profile"),
  );
  try {
    const retiring = manager.releaseIdleAnalysis(task, f.project);
    await began;
    // This is the exact startup queue acquired by start(). Another epic must
    // be able to enter it while A's durable native flush remains pending.
    const queue = (manager as any).startup;
    const unlock = await Promise.race([
      queue.enter(new AbortController().signal),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(Error("Epic A blocked another worker's startup slot")),
          500,
        ).unref(),
      ),
    ]);
    assert.equal(completed, false);
    unlock();
    finish();
    await retiring;
    assert.equal(completed, true);
  } finally {
    finish();
    await manager.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("idle graph retirement cannot run while an implementation or review in that epic is active", async () => {
  const f = await sourceFixture(),
    state = initialState();
  const task = story(f.project, "finished-a", "a", f.a),
    peer = story(f.project, "peer-a", "a", f.a);
  task.run.state = "finished";
  task.run.analysisProjectId = "owned-a";
  state.projects = [f.project];
  state.tasks = [task, peer];
  let retired = 0;
  const manager = new WorkerManager(
    () => state,
    async () => {},
    {
      releaseEpic: async () => {
        retired++;
      },
    } as unknown as MemtraceEngine,
    join(f.root, "profile"),
  );
  try {
    await manager.releaseIdleAnalysis(task, f.project);
    assert.equal(retired, 0);
    peer.run.state = "finished";
    for (const status of ["queued", "running"] as const) {
      peer.codeReview = {
        runId: "review",
        state: status,
        findingCount: 0,
        updatedAt: new Date().toISOString(),
      };
      await manager.releaseIdleAnalysis(task, f.project);
      assert.equal(retired, 0);
    }
    peer.codeReview = { ...peer.codeReview!, state: "completed" };
    await manager.releaseIdleAnalysis(task, f.project);
    assert.equal(retired, 1);
  } finally {
    await manager.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a junction alias becoming active during preparation is rejected before checkout activation", async () => {
  const f = await sourceFixture(),
    alias = join(f.root, "junction");
  await symlink(
    f.original,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const state = initialState(),
    personal = { ...f.project, id: "personal", name: "Personal", path: alias };
  state.projects = [f.project, personal];
  state.settings.maxWorkers = 3;
  state.fleetConflicts = [];
  const task = story(f.project, "new", "a", f.a),
    peer = story(personal, "peer", "a", f.a);
  task.run = { state: "idle" };
  task.stage = "planned";
  peer.run = { state: "idle" };
  state.tasks = [task, peer];
  approveFixtureWorker(state, "codex");
  let activated = 0;
  const manager = new WorkerManager(
    () => state,
    async () => {
      if (task.run.state === "preparing") peer.run.state = "running";
    },
    {} as MemtraceEngine,
    join(f.root, "profile"),
  );
  Object.assign(manager, {
    workspaces: {
      activate: async () => {
        activated++;
        throw Error("Activation must not happen");
      },
    },
  });
  try {
    await assert.rejects(
      manager.start(task, f.project),
      /already in use.*Personal/,
    );
    assert.equal(activated, 0);
    assert.equal(f.project.branch, "main");
  } finally {
    peer.run.state = "finished";
    await manager.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
