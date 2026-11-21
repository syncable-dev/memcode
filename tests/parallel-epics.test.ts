import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { git } from "../runtime/local";
import { EpicWorkspace } from "../runtime/epic-workspace";
import { epicAnalysisProject } from "../runtime/epic-checkout";
import { assertEpicDependencies, assertPrerequisitesComplete } from "../runtime/epic-dependencies";
import { WorkerChangeJournal } from "../runtime/changes";
import { initialState } from "../src/seed";
import { MemtraceEngine } from "../runtime/memtrace";
import type { Epic, WorkItem } from "../src/shared";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memcode-parallel-epics-"));
  const { mkdir } = await import("node:fs/promises");
  const root = join(directory, "project"),
    data = join(directory, "profile");
  await mkdir(root);
  await mkdir(data);
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(join(root, "source.ts"), "export const n=0;\n");
  await git(root, ["add", "source.ts"]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  const state = initialState();
  const project = {
    id: "project",
    name: "Project",
    description: "",
    path: root,
    branch: "main",
    repoId: "canonical",
    analysis: "ready" as const,
    createdAt: new Date().toISOString(),
  };
  state.projects = [project];
  state.tasks = [];
  state.epics = ["a", "b"].map((id, index): Epic => ({
    id,
    projectId: project.id,
    identifier: "EP-" + id,
    title: id,
    description: "",
    phase: "now",
    color: "mint",
    order: index,
  }));
  const story = (id: string, epicId: string): WorkItem => ({
    id,
    identifier: "MC-" + id,
    projectId: project.id,
    epicId,
    title: id,
    description: "",
    stage: "working",
    priority: "medium",
    category: "Work",
    harness: "codex",
    checklist: [],
    messages: [],
    createdAt: project.createdAt,
    updatedAt: project.createdAt,
    run: { state: "preparing" },
  });
  const a = story("a1", "a"),
    b = story("b1", "b");
  state.tasks = [a, b];
  return {
    directory,
    root,
    data,
    state,
    project,
    a,
    b,
    story,
    workspaces: new EpicWorkspace(() => state, data),
  };
}

test("only explicit prerequisites block a story, regardless of cycle or epic", async () => {
  const f = await fixture();
  f.b.cycleId = "current";
  assertPrerequisitesComplete(f.state, f.b);
  f.a.title = "Cover routing fallbacks";
  f.b.dependsOn = [f.a.id];
  assert.throws(() => assertPrerequisitesComplete(f.state, f.b), /MC-a1 · Cover routing fallbacks \(In progress\)/);
  f.a.stage = "done";
  assertPrerequisitesComplete(f.state, f.b);
  f.a.projectId = "different-project";
  assert.throws(() => assertPrerequisitesComplete(f.state, f.b), /no longer available/);
});

test("legacy epic rejection explains engine support and preserves the active checkout", async () => {
  const f = await fixture();
  f.a.run.state = "running";
  const before = await git(f.root, ["branch", "--show-current"]);
  await assert.rejects(f.workspaces.activate(f.b, f.project), /connected Memtrace engine does not support parallel goal checkouts/);
  assert.equal(await git(f.root, ["branch", "--show-current"]), before);
  assert.equal(f.a.run.state, "running");
});

test("missing capability evidence cannot silently select the single-epic compatibility path", async () => {
  const f = await fixture();
  const engine = new MemtraceEngine(() => "protocol-fixture", { checkoutCapabilities: async () => null });
  for (const response of [{}, { error: "Engine is starting" }, { protocol_version: 1, checkout_modes: [] }]) {
    engine.call = async () => response;
    await assert.rejects(engine.ownedWorktreeSupport(f.project), /did not provide valid checkout capabilities/);
  }
  engine.call = async () => ({ protocol_version: 1, owned_worktree_v1: true, checkout_modes: ["owned-worktree-v1"] });
  assert.equal(await engine.ownedWorktreeSupport(f.project), true);
  engine.call = async () => { throw Error("Unknown tool get_checkout_capabilities"); };
  assert.equal(await engine.ownedWorktreeSupport(f.project), false, "a positively identified older engine retains explicit compatibility");
});

test("parallel epics share Git storage, isolate files and graph IDs, and retain the user's checkout", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "source.ts"), "uncommitted original\n");
  await Promise.all([
    f.workspaces.activate(f.a, f.project, { ownedCheckout: true }),
    f.workspaces.activate(f.b, f.project, { ownedCheckout: true }),
  ]);
  assert.notEqual(f.a.run.workspace, f.b.run.workspace);
  assert.notEqual(f.a.run.workspace, f.root);
  const common = async (root: string) =>
    realpath(resolve(root, await git(root, ["rev-parse", "--git-common-dir"])));
  assert.equal(
    await common(f.a.run.workspace!),
    await common(f.b.run.workspace!),
  );
  assert.equal(await common(f.root), await common(f.a.run.workspace!));
  assert.equal(await git(f.root, ["branch", "--show-current"]), "main");
  const { readFile } = await import("node:fs/promises");
  assert.equal(
    await readFile(join(f.root, "source.ts"), "utf8"),
    "uncommitted original\n",
  );
  await writeFile(join(f.a.run.workspace!, "source.ts"), "only epic a\n");
  assert.equal(
    await readFile(join(f.b.run.workspace!, "source.ts"), "utf8"),
    "export const n=0;\n",
  );
  assert.notEqual(
    epicAnalysisProject(f.project, f.a).id,
    epicAnalysisProject(f.project, f.b).id,
  );
  assert.equal(f.project.repoId, "canonical");
  assert.equal(f.project.branch, "main");
  const peer = f.story("a2", "a");
  f.state.tasks.push(peer);
  await f.workspaces.activate(peer, f.project, { ownedCheckout: true });
  assert.equal(peer.run.workspace, f.a.run.workspace);
  assert.equal(peer.run.analysisProjectId, f.a.run.analysisProjectId);
});

test("restarting preserves dirty epic results and rejects an externally changed branch", async () => {
  const f = await fixture();
  await f.workspaces.activate(f.a, f.project, { ownedCheckout: true });
  const path = f.a.run.workspace!;
  await writeFile(join(path, "source.ts"), "preserve my edit\n");
  const restored = new EpicWorkspace(() => f.state, f.data);
  await restored.activate(f.a, f.project, { ownedCheckout: true });
  assert.equal(f.a.run.workspace, path);
  await git(path, ["switch", "-c", "foreign"]);
  await assert.rejects(
    restored.activate(f.a, f.project, { ownedCheckout: true }),
    /changed branch/,
  );
  const { readFile } = await import("node:fs/promises");
  assert.equal(
    await readFile(join(path, "source.ts"), "utf8"),
    "preserve my edit\n",
  );
});

test("an epic already open in the primary folder keeps its files but uses an independent current-source graph", async () => {
  const f = await fixture();
  f.state.epics[0].branch = "main";
  await f.workspaces.activate(f.a, f.project, { ownedCheckout: true });
  assert.equal(f.a.run.workspace, await realpath(f.root));
  const analysis = epicAnalysisProject(f.project, f.a);
  assert.notEqual(analysis.id, f.project.id);
  assert.equal(analysis.analysisCurrentSource, true);
  assert.equal(analysis.analysisCheckout, undefined, "A primary Git folder cannot pretend to be a linked worktree");
  assert.equal(analysis.repoId, undefined, "The primary history graph's certificate cannot be inherited");
  const peer = f.story("a2", "a");
  f.state.tasks.push(peer);
  await f.workspaces.activate(peer, f.project, { ownedCheckout: true });
  assert.equal(peer.run.analysisProjectId, f.a.run.analysisProjectId);
  assert.equal(f.project.repoId, "canonical");
  assert.equal(await git(f.root, ["branch", "--show-current"]), "main");
});

test("a Done prerequisite in another epic must actually be present before a dependent worker can start", async () => {
  const f = await fixture();
  await f.workspaces.activate(f.a, f.project, { ownedCheckout: true });
  await f.workspaces.activate(f.b, f.project, { ownedCheckout: true });
  f.a.scope = ["source.ts"];
  const journal = new WorkerChangeJournal();
  await journal.begin(f.project, f.a);
  await writeFile(join(f.a.run.workspace!, "source.ts"), "export const n=1;\n");
  await journal.release(f.project, f.a);
  f.a.stage = "done";
  f.a.run.state = "finished";
  f.b.dependsOn = [f.a.id];
  await assert.rejects(
    assertEpicDependencies(f.state, f.b, f.b.run.workspace!),
    /not present in this goal/,
  );
  await writeFile(join(f.b.run.workspace!, "source.ts"), "export const n=1;\n");
  await assertEpicDependencies(f.state, f.b, f.b.run.workspace!);
});

test("an existing external worktree is preserved and never silently adopted", async () => {
  const f = await fixture();
  const branch = "epic/external";
  f.state.epics[0].branch = branch;
  const external = join(f.directory, "external");
  await git(f.root, ["worktree", "add", "-b", branch, external]);
  await assert.rejects(
    f.workspaces.activate(f.a, f.project, { ownedCheckout: true }),
    /already open in another checkout/,
  );
  assert.equal(await git(external, ["branch", "--show-current"]), branch);
});
