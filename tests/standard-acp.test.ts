import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { standardACPCatalog, selectStandardACPModel, standardModelMeasurement } from "../runtime/agents/acp-models";
import {
  probeStandardCatalog,
  readonlyACPTransport,
  standardTransport,
  startStandardSession,
} from "../runtime/agents/standard-acp";
import { discoverHarnesses, invalidateHarnessCache } from "../runtime/catalog";
import type { AgentEvent } from "../runtime/agents/types";
import { workerToolProfile } from "../runtime/worker-profile";
import { mkdir } from "node:fs/promises";

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

test("standardACPCatalog preserves multi-group labels without breaking ungrouped options", () => {
  const session = {
    sessionId: "s",
    configOptions: [{
      id: "model",
      category: "model",
      currentValue: "auto",
      options: [
        { value: "auto", name: "Auto" },
        { name: "DeepSeek", options: [{ value: "ds-chat", name: "DeepSeek Chat" }] },
        { group: "OpenCode Go", options: [{ value: "glm-5", name: "GLM-5" }] },
      ],
    }],
  };
  assert.deepEqual(standardACPCatalog(session), [
    { id: "auto", label: "Auto", source: "acp", isDefault: true },
    { id: "ds-chat", label: "DeepSeek Chat", group: "DeepSeek", source: "acp", isDefault: false },
    { id: "glm-5", label: "GLM-5", group: "OpenCode Go", source: "acp", isDefault: false },
  ]);
});

test("custom dshProfile forwards across transport, readonly review, and session spawn while copilot ignores it", async () => {
  assert.deepEqual(standardTransport("dsh", { dshProfile: "custom-acp" }).args, ["--profile", "custom-acp"]);
  assert.deepEqual(
    standardTransport("copilot", { effort: "high", dshProfile: "custom-acp" }).args,
    ["--acp", "--stdio", "--effort", "high"],
  );
  const cwd = await mkdtemp(join(tmpdir(), "memcode-dsh-profile-"));
  try {
    const ro = await readonlyACPTransport("dsh", cwd, "custom-acp");
    assert.equal(ro.args[0], "--profile");
    assert.equal(ro.args[1], "custom-acp");

    const script = join(cwd, "fixture.mjs"), trace = join(cwd, "trace.jsonl");
    await writeFile(script, fixture);
    const session = startStandardSession("dsh", {
      command: { command: process.execPath, prefix: [script] },
      cwd,
      env: { ...process.env, TRACE: trace },
      model: "tested-model",
      effort: "low",
      dshProfile: "custom-acp",
      permissionMode: "review",
      briefPath: "",
      toolArgs: [],
      prompt: "Hi",
      onEvent: () => {},
      requestInput: async () => ({ optionId: "allow" }),
    });
    assert.equal((await session.completion).exitCode, 0);
    const log = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const idx = log[0].argv.indexOf("--profile");
    assert.ok(idx >= 0);
    assert.equal(log[0].argv[idx + 1], "custom-acp");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("probeStandardCatalog strictStdout rejects non-JSON stdout noise", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memcode-strict-stdout-"));
  try {
    const script = join(cwd, "noisy-acp.mjs");
    await writeFile(script, `
import { createInterface } from 'node:readline';
process.stdout.write('[noisy-plugin] initialized\\n');
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('close',()=>process.exit(0)).on('line', line => {
  const x = JSON.parse(line);
  if (x.method === 'initialize') return send({jsonrpc:'2.0',id:x.id,result:{agentCapabilities:{}}});
  if (x.method === 'session/new') return send({jsonrpc:'2.0',id:x.id,result:{sessionId:'s1',configOptions:[{id:'model',category:'model',currentValue:'m1',options:[{value:'m1',name:'Model 1'}]}]}});
  if (x.method === 'session/close') return send({jsonrpc:'2.0',id:x.id,result:{}});
});
`);
    const cmd = { command: process.execPath, prefix: [script] };
    const relaxed = await probeStandardCatalog("dsh", cmd, "acp", { strictStdout: false });
    assert.equal(relaxed[0]?.id, "m1");
    await assert.rejects(
      probeStandardCatalog("dsh", cmd, "acp", { strictStdout: true }),
      /unreadable ACP message/i,
    );

    const emptyScript = join(cwd, "empty-acp.mjs");
    await writeFile(emptyScript, `
import { createInterface } from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('close',()=>process.exit(0)).on('line', line => {
  const x = JSON.parse(line);
  if (x.method === 'initialize') return send({jsonrpc:'2.0',id:x.id,result:{agentCapabilities:{}}});
  if (x.method === 'session/new') return send({jsonrpc:'2.0',id:x.id,result:{sessionId:'s1',configOptions:[]}});
  if (x.method === 'session/close') return send({jsonrpc:'2.0',id:x.id,result:{}});
});
`);
    await assert.rejects(
      probeStandardCatalog("dsh", { command: process.execPath, prefix: [emptyScript] }, "acp", { strictStdout: true }),
      /empty model catalog/i,
    );

    // A JSON log line is still stdout pollution, not an ACP message.
    const loggingScript = join(cwd, "json-log-acp.mjs");
    await writeFile(loggingScript, `
import { createInterface } from 'node:readline';
process.stdout.write(JSON.stringify({ message: 'starting' }) + '\\n');
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('close',()=>process.exit(0)).on('line', line => {
  const x = JSON.parse(line);
  if (x.method === 'initialize') return send({jsonrpc:'2.0',id:x.id,result:{agentCapabilities:{}}});
  if (x.method === 'session/new') return send({jsonrpc:'2.0',id:x.id,result:{sessionId:'s1',configOptions:[{id:'model',category:'model',currentValue:'m1',options:[{value:'m1',name:'Model 1'}]}]}});
  if (x.method === 'session/close') return send({jsonrpc:'2.0',id:x.id,result:{}});
});
`);
    const logging = { command: process.execPath, prefix: [loggingScript] };
    assert.equal((await probeStandardCatalog("dsh", logging, "acp"))[0]?.id, "m1");
    await assert.rejects(
      probeStandardCatalog("dsh", logging, "acp", { strictStdout: true }),
      /not an ACP message/i,
    );

    // An unusable profile name rejects, so a caller's .catch() always applies.
    const invalid = probeStandardCatalog("dsh", cmd, "acp copy");
    await assert.rejects(invalid, /Invalid DeepSeek Harness profile/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("discoverHarnesses tracks active dshProfile in cache and supports invalidateHarnessCache", async () => {
  const dshHome = await mkdtemp(join(tmpdir(), "memcode-dsh-cache-"));
  const prevDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    for (const name of ["custom-acp", "work"]) {
      const dir = join(dshHome, "profiles", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-acp-app"] } } }));
    }
    invalidateHarnessCache("dsh");
    const [first] = await discoverHarnesses(false, "dsh", { dshProfile: "custom-acp" });
    assert.equal(first.activeProfile, "custom-acp");
    assert.deepEqual(first.profiles?.slice().sort(), ["custom-acp", "work"]);

    const [switched] = await discoverHarnesses(false, "dsh", { dshProfile: "work" });
    assert.equal(switched.activeProfile, "work");

    const extraDir = join(dshHome, "profiles", "extra");
    await mkdir(extraDir, { recursive: true });
    await writeFile(join(extraDir, "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-acp-app"] } } }));
    invalidateHarnessCache("dsh");
    const [refreshed] = await discoverHarnesses(false, "dsh", { dshProfile: "work" });
    assert.ok(refreshed.profiles?.includes("extra"));

    // Non-ACP configured profile must not launch the binary for a catalog probe
    const webDir = join(dshHome, "profiles", "web-only");
    await mkdir(webDir, { recursive: true });
    await writeFile(join(webDir, "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app"] } } }));
    const binDir = join(dshHome, "bin");
    const dshBin = join(binDir, "node_modules", "@deepseek-ai", "dsh", "lib");
    await mkdir(dshBin, { recursive: true });
    const spawnMarker = join(dshHome, "spawned.txt");
    await writeFile(
      join(dshBin, "bin.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(spawnMarker)}, "ran"); process.exit(1);\n`,
    );
    const prevPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      invalidateHarnessCache("dsh");
      const [webResult] = await discoverHarnesses(true, "dsh", { dshProfile: "web-only" });
      assert.equal(webResult.activeProfile, "web-only");
      assert.deepEqual(webResult.models, []);
      await assert.rejects(() => readFile(spawnMarker, "utf8"));
    } finally {
      process.env.PATH = prevPath;
    }
  } finally {
    invalidateHarnessCache("dsh");
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    await rm(dshHome, { recursive: true, force: true });
  }
});
