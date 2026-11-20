import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { standardACPCatalog, selectStandardACPModel, standardModelMeasurement } from "../runtime/agents/acp-models";
import { startStandardSession, readonlyACPTransport } from "../runtime/agents/standard-acp";
import type { AgentEvent } from "../runtime/agents/types";
import { workerToolProfile } from "../runtime/worker-profile";

test("ACP preserves exact provider IDs, requires selection acknowledgment, and never measures Auto as a model", async () => {
  const tuple = '["deepseek-official","deepseek-v4-flash"]';
  const session = { sessionId: "s", configOptions: [{ id: "route", category: "model", currentValue: "auto", options: [{ value: "auto", name: "Auto" }, { group: "Provider", options: [{ value: tuple, name: "DeepSeek V4 Flash" }] }] }] };
  assert.deepEqual(standardACPCatalog(session).map(model => model.id), ["auto", tuple]);
  await assert.rejects(selectStandardACPModel(session, "invented", async () => ({}), "DSH"), /does not offer/);
  await assert.rejects(selectStandardACPModel(session, tuple, async () => ({}), "DSH"), /did not confirm/);
  const selected = await selectStandardACPModel(session, tuple, async (method, params) => {
    assert.equal(method, "session/set_config_option");
    assert.equal(params.value, tuple);
    return { configOptions: [{ ...session.configOptions[0], currentValue: tuple }] };
  }, "DSH");
  assert.equal(standardModelMeasurement("dsh", selected.config)?.model?.id, "deepseek-v4-flash");
  assert.equal(standardModelMeasurement("copilot", [], "auto"), undefined);
});

const fixture = `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const trace = x => appendFileSync(process.env.TRACE, JSON.stringify(x)+'\\n');
trace({argv:process.argv.slice(2),permission:process.env.DSH_PERMISSION_MODE});
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
let model='default', waiting;
const config = () => [{id:'model',category:'model',currentValue:model,options:[{value:'default',name:'Default'},{value:'tested-model',name:'Tested'}]}];
createInterface({input:process.stdin}).on('close',()=>process.exit(0)).on('line', line => {
 const x=JSON.parse(line);trace(x);const p=x.params??{};
 const reply = result => send({jsonrpc:'2.0',id:x.id,result});
 if(!x.method){if(waiting){const id=waiting;waiting=undefined;send({jsonrpc:'2.0',id,result:{stopReason:'end_turn'}});}return;}
 if(x.method==='initialize')return reply({agentCapabilities:{sessionCapabilities:{resume:{},close:{}}}});
 if(x.method==='session/new'||x.method==='session/resume')return reply({sessionId:'persisted',configOptions:config()});
 if(x.method==='session/set_config_option'){model=p.value;return reply({configOptions:config()});}
 if(x.method==='session/close')return reply({});
 if(x.method==='session/prompt'){
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'persisted',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Working in the same conversation.'}}}});
  waiting=x.id;return send({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId:'persisted',toolCall:{title:'Run focused test',kind:'execute'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'},{optionId:'reject',kind:'reject_once',name:'Reject'}]}});
 }
});`;

for (const id of ["copilot", "dsh"] as const) test(`${id}: actual bidirectional process selects, resumes, approves and closes only its session`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memcode-acp-test-"));
  try {
    const script = join(cwd, "fixture.mjs"), trace = join(cwd, "trace.jsonl");
    await writeFile(script, fixture);
    const contextConfig = join(cwd, "context-mcp.json");
    const mcpServers = { "memcode-context": { type: "stdio", command: process.execPath, args: ["scoped-gateway.mjs", "private-session.json"] } };
    await writeFile(contextConfig, JSON.stringify({ mcpServers }));
    const profile = await workerToolProfile(id, contextConfig, cwd, "review");
    const events: AgentEvent[] = [];
    const session = startStandardSession(id, { command: { command: process.execPath, prefix: [script] }, cwd, env: { ...process.env, TRACE: trace, DSH_PERMISSION_MODE: "danger-full-access" }, model: "tested-model", effort: "high", permissionMode: "review", resumeSessionId: "persisted", briefPath: "", toolArgs: profile.args, contextConfig, prompt: "Continue", onEvent: event => events.push(event), requestInput: async prompt => { assert.equal(prompt.kind, "approval"); return { optionId: "allow" }; } });
    assert.equal((await session.completion).exitCode, 0);
    const log = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(log.some(row => row.method === "session/resume" && row.params.sessionId === "persisted"));
    assert.ok(log.some(row => row.id === "permission" && row.result?.outcome?.optionId === "allow"));
    assert.ok(events.some(event => event.type === "measurement" && event.model?.id === "tested-model"));
    assert.ok(events.some(event => event.type === "message" && /same conversation/.test(event.text)));
    if (id === "dsh") {
      assert.equal(log[0].permission, "workspace-write");
      assert.ok(log.some(row => row.method === "session/close"));
    }
    assert.ok(log[0].argv.includes(id === "copilot" ? "--acp" : "--profile"));
    const resumed = log.find(row => row.method === "session/resume");
    if (id === "copilot") {
      const flag = log[0].argv.indexOf("--additional-mcp-config");
      assert.ok(flag >= 0);
      const path = log[0].argv[flag + 1];
      assert.ok(path.startsWith("@"));
      assert.deepEqual(JSON.parse(await readFile(path.slice(1), "utf8")), {
        mcpServers: { "memcode-context": { ...mcpServers["memcode-context"], tools: ["*"] } },
      });
      assert.deepEqual(resumed.params.mcpServers, []);
      assert.deepEqual(JSON.parse(await readFile(contextConfig, "utf8")), { mcpServers });
    } else {
      assert.equal(resumed.params.mcpServers[0].name, "memcode-context");
      assert.equal(resumed.params.mcpServers[0].command, process.execPath);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("review transports expose no writable client tools or external MCP catalogs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memcode-review-acp-"));
  try {
    const copilot = await readonlyACPTransport("copilot", cwd);
    assert.ok(copilot.args.includes("--available-tools=view"));
    assert.ok(copilot.args.includes("--disable-builtin-mcps"));
    const dsh = await readonlyACPTransport("dsh", cwd);
    const patch = JSON.parse(await readFile(dsh.args.at(-1)!, "utf8"));
    assert.equal(patch[0].config.mode, "read-only");
    const plugin = await import(pathToFileURL(patch[1].insert[0].name).href);
    let created: Function | undefined;
    plugin.apply({ on: (name: string, handler: Function) => { assert.equal(name, "agent/created"); created = handler; } });
    let restriction: unknown;
    created!({ agent: { ctx: { tools: { restrict: (value: unknown) => { restriction = value; } } } } });
    assert.deepEqual(restriction, { allow: [] });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
