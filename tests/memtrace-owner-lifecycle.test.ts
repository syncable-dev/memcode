import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemtraceEngine } from "../runtime/memtrace";
import { git } from "../runtime/local";
import type { Project } from "../src/shared";

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

test("cold owned-epic discovery uses attach-only MCP before managed owner bootstrap, and an unwatch failure cannot strand its client", async () => {
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
    analysisCheckout: "owned-worktree-v1",
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
    assert.equal(
      scope.directory.replaceAll("\\", "/").toLowerCase(),
      source.replaceAll("\\", "/").toLowerCase(),
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
