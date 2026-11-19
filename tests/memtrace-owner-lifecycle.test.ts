import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { MemtraceEngine } from "../runtime/memtrace";
import { git } from "../runtime/local";
import type { Project } from "../src/shared";

test("a first CLI connection boots its private owner when discovery succeeds before the graph is attached", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memcode-late-owner-"));
  const source = join(directory, "source"),
    owner = join(directory, "owner"),
    calls = join(directory, "calls.jsonl");
  const executable = join(directory, "mcp-fixture.mjs");
  await mkdir(source);
  await git(source, ["init", "--initial-branch=main"]);
  await writeFile(
    executable,
    `import {createInterface} from 'node:readline';
import {existsSync,appendFileSync} from 'node:fs';
const fixture=${JSON.stringify({ source, owner, calls })};
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);if(message.id===undefined)return;let result={};
 if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-late-owner',version:'fixture'}};
 if(message.method==='tools/call'){
  const {name}=message.params;appendFileSync(fixture.calls,JSON.stringify({name})+'\\n');
  if(name==='get_repository_stats'&&!existsSync(fixture.owner))result={isError:true,content:[{type:'text',text:'repository summary revision probe failed: no workspace owner is attached yet'}]};
  else result={content:[{type:'text',text:JSON.stringify(name==='list_indexed_repositories'?[{repo_id:'selected',path:fixture.source}]:{repo_in_store:true})}]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
});`,
  );
  const project = {
    id: "late-owner",
    name: "Selected project",
    path: source,
    branch: "main",
    description: "",
    analysis: "idle",
    createdAt: new Date().toISOString(),
  } as Project;
  const engine = new MemtraceEngine(() => executable),
    internal = engine as any;
  let bootstraps = 0;
  internal.owners.ready = async (
    scope: any,
    _command: any,
    _environment: any,
    probe: () => Promise<void>,
  ) => {
    bootstraps++;
    assert.equal(scope.directory, await realpath(source));
    await writeFile(owner, "tracked-owner");
    await probe();
  };
  internal.owners.close = async () => {};
  try {
    await engine.connect(project);
    assert.equal(bootstraps, 1);
    assert.equal(engine.scopeFor(project.id)?.mode, "project");
    assert.equal(
      project.analysis,
      "idle",
      "owner attachment must not invent graph readiness",
    );
    const records = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((record) => record.name),
      [
        "list_indexed_repositories",
        "get_repository_stats",
        "list_indexed_repositories",
        "get_repository_stats",
      ],
    );
    assert.ok(records.every((record) => record.name !== "index_directory"));
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

for (const publishDuringDiscovery of [false, true])
  test(`a cold standalone graph keeps its existing store and history when the binding is ${publishDuringDiscovery ? "published during discovery" : "already present"}`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "memcode-standalone-owner-"),
    );
    const source = join(await realpath(directory), "source"),
      profile = join(directory, "profile"),
      owner = join(directory, "owner"),
      executable = join(directory, "mcp-fixture.mjs"),
      graph = join(source, ".memdb"),
      journal = join(graph, "episodes.journal"),
      scopeFile = join(graph, ".memtrace-store-scope.json");
    await mkdir(source);
    await git(source, ["init", "--initial-branch=main"]);
    await mkdir(graph);
    await writeFile(journal, "existing immutable history\n");
    const savedScope = JSON.stringify({
      version: 1,
      scope_source: { kind: "folder" },
      members: [{ path: source, repo_id: "selected" }],
    });
    if (!publishDuringDiscovery) await writeFile(scopeFile, savedScope);
    await writeFile(
      executable,
      `import {createInterface} from 'node:readline';
import {existsSync,writeFileSync} from 'node:fs';
const fixture=${JSON.stringify({ source, owner, scopeFile, savedScope })};
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);if(message.id===undefined)return;let result={};
 if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-standalone-owner',version:'fixture'}};
 if(message.method==='tools/call'){
  const {name}=message.params;
  if(name==='list_indexed_repositories'&&!existsSync(fixture.scopeFile))writeFileSync(fixture.scopeFile,fixture.savedScope);
  if(name==='get_repository_stats'&&!existsSync(fixture.owner))result={isError:true,content:[{type:'text',text:'repository summary revision probe failed: no workspace owner is attached yet'}]};
  else result={content:[{type:'text',text:JSON.stringify(name==='list_indexed_repositories'?[{repo_id:'selected',path:fixture.source}]:{repo_in_store:true})}]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
});`,
    );
    const project = {
      id: "cold-standalone",
      name: "Existing folder",
      path: source,
      branch: "main",
      description: "",
      analysis: "idle",
      createdAt: new Date().toISOString(),
    } as Project;
    const engine = new MemtraceEngine(() => executable, {
      managedGraphRoot: profile,
    });
    const internal = engine as any;
    let bootstraps = 0;
    internal.owners.ready = async (
      scope: any,
      _command: any,
      environment: any,
      probe: () => Promise<void>,
    ) => {
      bootstraps++;
      assert.equal(scope.dataDirectory, graph);
      assert.equal(scope.jobDirectory, join(source, ".memtrace"));
      assert.equal(scope.directory, dirname(scope.workspaceFile));
      assert.ok(scope.directory.startsWith(await realpath(profile)));
      assert.equal(environment.MEMTRACE_MCP_ATTACH_ONLY, "1");
      assert.notEqual(
        environment.MEMTRACE_NO_REPLAY,
        "1",
        "primary history remains enabled",
      );
      await writeFile(owner, "tracked existing store");
      await probe();
    };
    internal.owners.close = async () => {};
    try {
      await engine.connect(project);
      assert.equal(bootstraps, 1);
      assert.equal(engine.scopeFor(project.id)?.dataDirectory, graph);
      assert.equal(
        await readFile(journal, "utf8"),
        "existing immutable history\n",
      );
      assert.equal(await readFile(scopeFile, "utf8"), savedScope);
      assert.equal(
        project.analysis,
        "idle",
        "owner attachment is not source verification",
      );
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });

test("app shutdown disconnects MCP clients before stopping owners so no attached session can take the graph over", async () => {
  const engine = new MemtraceEngine(() => "fixture"),
    internal = engine as any,
    events: string[] = [];
  internal.connecting.add({
    close: async () => {
      events.push("connecting closed");
    },
  });
  internal.clients.set("attached", {
    client: {
      close: async () => {
        events.push("attached closed");
      },
    },
    projectPath: "fixture",
  });
  internal.owners.close = async () => {
    assert.deepEqual(events, ["connecting closed", "attached closed"]);
    events.push("owner stopped");
  };
  await engine.close();
  assert.equal(events.at(-1), "owner stopped");
});

test("overlapping epic retirements share the drain and cannot clear its guard before the owned owner exits", async () => {
  const engine = new MemtraceEngine(() => "fixture"),
    internal = engine as any;
  const project = {
    id: "owned-a",
    analysisCheckout: "owned-worktree-v1",
    path: "fixture",
    branch: "epic/a",
  } as Project;
  let finish!: () => void,
    began!: () => void,
    stops = 0,
    closed = false;
  const flush = new Promise<void>((resolve) => (finish = resolve)),
    started = new Promise<void>((resolve) => (began = resolve));
  internal.scopes.set(project.id, {
    dataDirectory: "owned-store",
    mode: "project",
  });
  internal.clients.set(project.id, {
    projectPath: project.path,
    client: { close: async () => {} },
  });
  internal.owners.release = async () => {
    stops++;
    began();
    await flush;
  };
  const first = engine.releaseEpic(project);
  await started;
  const second = engine.releaseEpic(project);
  void second.then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(stops, 1);
  assert.equal(internal.bindingGenerations.get(project.id), 1);
  await assert.rejects(engine.connect(project), /retiring/);
  let reconnected = 0;
  internal.connect = async () => {
    reconnected++;
  };
  const nextReview = engine.activateEpic(project);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    reconnected,
    0,
    "A new review cannot open a second owner while the previous store is draining",
  );
  finish();
  await Promise.all([first, second, nextReview]);
  assert.equal(
    reconnected,
    1,
    "An explicitly started review reconnects after the previous owner has released its store",
  );
  assert.equal(internal.retiring.has(project.id), false);
  await engine.close();
});

for (const primaryFolder of [false, true])
  test(`cold ${primaryFolder ? "primary-folder source" : "owned-epic"} discovery attaches before owner bootstrap and never replays history`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "memcode-managed-epic-")),
      source = join(directory, "source"),
      executable = join(directory, "mcp-fixture.mjs"),
      owner = join(directory, "owner"),
      calls = join(directory, "calls.jsonl");
    await mkdir(source);
    await git(source, ["init", "--initial-branch=main"]);
    // Synthetic stdio protocol: models the native choice to own a cold store
    // unless --attach-only is set. It never starts a native database or uses auth.
    await writeFile(
      executable,
      `import {createInterface} from 'node:readline';
import {existsSync,appendFileSync,writeFileSync} from 'node:fs';
const fixture=${JSON.stringify({ source, owner, calls })};
const attachOnly=process.argv.includes('--attach-only')&&process.env.MEMTRACE_MCP_ATTACH_ONLY==='1';
appendFileSync(fixture.calls,JSON.stringify({event:'mcp',args:process.argv.slice(2),attachOnly})+'\\n');
if(!attachOnly&&!existsSync(fixture.owner))writeFileSync(fixture.owner,'untracked-direct-owner');
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line); if(message.id===undefined)return; let result={};
 if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-owned-epic',version:'fixture'}};
 if(message.method==='tools/call') {
  const {name}=message.params;appendFileSync(fixture.calls,JSON.stringify({event:'tool',name})+'\\n');
  if(name==='list_indexed_repositories'&&!existsSync(fixture.owner))result={isError:true,content:[{type:'text',text:'no workspace owner is attached yet'}]};
  else if(name==='unwatch_directory')result={isError:true,content:[{type:'text',text:'synthetic unwatch failure'}]};
  else {const value=name==='list_indexed_repositories'?[{repo_id:'owned-repo',path:fixture.source}]:{repo_in_store:true};result={content:[{type:'text',text:JSON.stringify(value)}]};}
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
});`,
    );
    const project: Project = {
      id: "owned-a",
      name: "Owned A",
      description: "",
      path: source,
      branch: "main",
      analysis: "idle",
      analysisCheckout: primaryFolder ? undefined : "owned-worktree-v1",
      analysisCurrentSource: true,
      createdAt: new Date().toISOString(),
    };
    const engine = new MemtraceEngine(() => executable);
    let bootstraps = 0,
      released = 0,
      closed = false;
    const internal = engine as any;
    internal.owners.ready = async (
      scope: any,
      _command: any,
      environment: any,
      probe: () => Promise<void>,
    ) => {
      bootstraps++;
      assert.equal(environment.MEMTRACE_MCP_ATTACH_ONLY, "1");
      assert.equal(environment.MEMTRACE_SKIP_EMBED, "1");
      assert.equal(environment.MEMTRACE_NO_REPLAY, "1");
      assert.equal(
        scope.directory.replaceAll("\\", "/").toLowerCase(),
        (await realpath(source)).replaceAll("\\", "/").toLowerCase(),
      );
      await writeFile(owner, "tracked-headless-owner");
      await probe();
    };
    internal.owners.release = async () => {
      released++;
    };
    try {
      await engine.connect(project);
      assert.equal(bootstraps, 1);
      assert.equal(await readFile(owner, "utf8"), "tracked-headless-owner");
      const connection = internal.clients.get(project.id),
        transport = connection.transport;
      connection.client.onclose = () => {
        closed = true;
      };
      internal.watches.set(project.id, {
        origin: "memcode",
        path: source,
        state: "watching",
        branch: "main",
        repoId: "owned-repo",
        verifiedAt: new Date().toISOString(),
      });
      await engine.releaseEpic(project);
      assert.equal(closed, true);
      assert.equal(transport.pid, null);
      assert.equal(released, 1);
      assert.equal(engine.scopeFor(project.id), null);
      const log = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(
        log
          .filter((row) => row.event === "mcp")
          .every((row) => row.attachOnly && row.args.includes("--attach-only")),
      );
      assert.ok(log.some((row) => row.name === "unwatch_directory"));
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });
