import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startCursorSession,
  cursorModelValue,
  cursorSessionModel,
  selectCursorModel,
} from "../runtime/agents/cursor.ts";
import { cursorCatalog, rankedCursorModel } from "../src/cursor-models.ts";
import type { AgentEvent } from "../runtime/agents/types.ts";
import type { PermissionMode } from "../src/permissions";
import type {
  WorkerInputPrompt,
  WorkerInputResponse,
} from "../src/worker-input.ts";

// A real bidirectional child process, not a mocked transport. It deliberately
// stays alive after session/prompt returns, as an ACP server normally does.
const fixtureSource = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const trace = value => appendFileSync(process.env.TRACE, JSON.stringify(value)+'\\n');
trace({argv:process.argv.slice(2),configDir:process.env.CURSOR_CONFIG_DIR});
const send = value => { trace({out:value}); process.stdout.write(JSON.stringify(value)+'\\n'); };
const answer = (id,result) => send({jsonrpc:'2.0',id,result});
const pending = new Map();
const rpc = (id,method,params) => new Promise(resolve => { pending.set(id,resolve); send({jsonrpc:'2.0',id,method,params}); });
const update = update => send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session-fixture',update}});
let selected='old-model', effort='low';
const configOptions=()=>[
 {id:'model-choice',name:'Model',category:'model',type:'select',currentValue:selected,options:[{value:'old-model',name:'Old'},{value:'routed-model',name:'Routed'}]},
 {id:'thought',name:'Effort',category:'thought_level',type:'select',currentValue:effort,options:[{value:'low',name:'Low'},{value:'high',name:'High'}]}
];
const input=createInterface({input:process.stdin});
input.on('close',()=>process.exit(0));
input.on('line',async line=>{
 const message=JSON.parse(line); trace({in:message});
 if(!message.method){const resolve=pending.get(message.id);pending.delete(message.id);resolve?.(message);return;}
 const p=message.params??{};
 if(message.method==='initialize')return answer(message.id,{protocolVersion:1,agentCapabilities:{loadSession:process.env.CASE!=='resume-unsupported',...(process.env.CASE==='resume-fast'?{sessionCapabilities:{resume:{}}}:{})},authMethods:[{id:'cursor_login'}]});
 if(message.method==='authenticate')return answer(message.id,{});
 if(message.method==='session/load'||message.method==='session/resume'){
  if(typeof p.cwd!=='string'||!Array.isArray(p.mcpServers))throw Error('Missing resume context');
  if(process.env.CASE==='resume-missing')return send({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'Cannot find '+p.sessionId}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'history from an earlier turn'}});
  return answer(message.id,{...(process.env.CASE==='resume-wrong'?{sessionId:'other-session'}:{}),configOptions:configOptions(),modes:{currentModeId:'agent'}});
 }
 if(message.method==='session/new')return answer(message.id,{sessionId:'session-fixture',configOptions:configOptions(),models:{currentModelId:selected},modes:{currentModeId:'agent',availableModes:[{id:'agent'}]}});
 if(message.method==='session/set_config_option'){if(p.configId==='model-choice')selected=p.value;if(p.configId==='thought')effort=p.value;return answer(message.id,{configOptions:configOptions()});}
 if(message.method==='session/cancel')return;
 if(message.method!=='session/prompt')return send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unknown fixture method'}});
 if(process.env.CASE.startsWith('resume'))return answer(message.id,{stopReason:'end_turn'});
 if(process.env.CASE==='early'){process.stderr.write('Native fixture stopped unexpectedly');process.exit(2);}
 update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'I will '}});
 update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'check the project.'}});
 update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'Run the preview server',kind:'execute',status:'pending'});
 await rpc(0,'session/request_permission',{sessionId:'session-fixture',toolCall:{toolCallId:'tool-1',title:'Run the preview server',kind:'execute',rawInput:{command:'npm run dev'}},options:[{optionId:'once-exact',name:'Allow once',kind:'allow_once'},{optionId:'deny-exact',name:'Reject',kind:'reject_once'}]});
 if(process.env.CASE==='cancel'){await new Promise(()=>{});return;}
 await rpc('native-question:17','cursor/ask_question',{toolCallId:'tool-q',title:'Choose the design',questions:[{id:'palette',prompt:'Which palette?',options:[{id:'forest',label:'Forest'},{id:'paper',label:'Paper'}]},{id:'features',prompt:'Which features?',allowMultiple:true,options:[{id:'a',label:'A'},{id:'b',label:'B'}]}]});
 await rpc('native-plan:18','cursor/create_plan',{toolCallId:'tool-plan',name:'Build the preview',overview:'One focused implementation',plan:'1. Build the page\\n2. Verify the preview'});
 await rpc('wrong-session','session/request_permission',{sessionId:'different-session',toolCall:{title:'Wrong session'},options:[{optionId:'bad',name:'Bad'}]});
 await rpc('unexpected-file-write','fs/write_text_file',{path:'/must-not-write',content:'no'});
 update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'failed',content:[{type:'content',content:{type:'text',text:'The native tool was denied.'}}]});
 update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Here is the alternative.'}});
 answer(message.id,{stopReason:'end_turn'});
});
setInterval(()=>{},1000);
`;

test("Cursor CLI aliases resolve only to advertised ACP model and effort variants", () => {
  const choices = [
    { name: "composer-2.5", value: "composer-2.5[fast=true]" },
    {
      name: "grok-4.7",
      value: "grok-4.7[context=256k,reasoning_effort=high,fast=true]",
    },
  ];
  assert.equal(cursorModelValue("composer-2.5", choices), choices[0].value);
  assert.equal(cursorModelValue("grok-4.7-high", choices), choices[1].value);
  assert.equal(
    cursorModelValue("grok-4.7-high-fast", choices),
    choices[1].value,
  );
  assert.equal(cursorModelValue("grok-4.7-xhigh", choices), undefined);
  assert.equal(cursorModelValue("different-model", choices), undefined);
});

test("Cursor reports its acknowledged model selection and leaves Auto identity unknown", () => {
  assert.equal(cursorSessionModel([{category:"model",currentValue:"default[fast=true]"}]), undefined);
  assert.equal(cursorSessionModel([{category:"model",currentValue:"Auto"}]), undefined);
  assert.deepEqual(cursorSessionModel([{category:"model",currentValue:"grok-4.7[reasoning_effort=high,fast=true]"}]), {
    type:"measurement",model:{id:"grok-4.7",source:"cursor-session",effort:"high"},models:["grok-4.7"],
  });
  assert.equal(cursorSessionModel([], undefined), undefined);
  assert.equal(cursorSessionModel([], "composer-2.5")?.model?.id, "composer-2.5");
});

test("Cursor reselects an advertised model at the measured tier when the automatic variant disappears", async () => {
  const grok = "grok-4.7[reasoning_effort=high,fast=true]";
  const opus = "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]";
  const model = {
    id: "model-choice", category: "model", currentValue: grok,
    options: [{name:"Grok 4.7",value:grok},{name:"Opus 5",value:opus},{name:"Other",value:"other"}],
  };
  const session = { sessionId: "test", configOptions: [model] };
  assert.deepEqual(cursorCatalog(session).map(({ id, tier }) => [id, tier]), [
    [grok,"balanced"],[opus,"frontier"],["other",undefined],
  ]);
  const selected = await selectCursorModel(session, "grok-4.7-xhigh", async (method, params) => {
    assert.equal(method, "session/set_config_option");
    assert.deepEqual(params, {sessionId:"test",configId:"model-choice",value:opus});
    return {configOptions:[{...model,currentValue:opus}]};
  }, "frontier");
  assert.match(selected.alternative ?? "", /Opus 5/);
  assert.equal(cursorSessionModel(selected.config)?.model?.id, "claude-opus-5");
  assert.equal(cursorSessionModel(selected.config)?.model?.effort, "high");
  await assert.rejects(selectCursorModel(session, "grok-4.7-xhigh", async () => assert.fail("Pinned models cannot be replaced")), /does not offer/);
  await assert.rejects(selectCursorModel(session, opus, async () => ({configOptions:[model]})), /did not confirm/);
  assert.equal(rankedCursorModel(session, "extreme"), undefined);
});

test("legacy ACP choices and saved CLI aliases resolve to the actual selection", async () => {
  const grok = "grok-4.7[reasoning_effort=high,fast=true]";
  const session = {sessionId:"older",models:{currentModelId:"other",availableModels:[{modelId:grok,name:"Grok"}]}};
  const selected = await selectCursorModel(session, "grok-4.7-high", async (method, params) => {
    assert.equal(method, "session/set_model");
    assert.deepEqual(params, {sessionId:"older", modelId:grok});
    return {};
  });
  assert.equal(selected.legacyModel, grok);
});

async function fixture(kind = "normal") {
  const root = await mkdtemp(join(tmpdir(), "memcode-cursor-acp-"));
  const program = join(root, "fixture.mjs"),
    trace = join(root, "trace.jsonl"),
    config = join(root, "context.json");
  await writeFile(program, fixtureSource);
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: {
        "memcode-context": {
          command: "node",
          args: ["context-bridge.mjs"],
          env: { CONTEXT_SECRET: "fixture-only-secret" },
        },
      },
    }),
  );
  const events: AgentEvent[] = [];
  const start = (
    requestInput: (
      prompt: WorkerInputPrompt,
      signal?: AbortSignal,
    ) => Promise<WorkerInputResponse>,
    permissionMode?: PermissionMode,
    resumeSessionId?: string,
  ) =>
    startCursorSession({
      command: { command: process.execPath, prefix: [program] },
      cwd: root,
      env: {
        ...process.env,
        TRACE: trace,
        CASE: kind,
        CURSOR_CONFIG_DIR: join(root, "profile"),
      },
      model: "routed-model",
      effort: "high",
      prompt: "Implement the actual story brief.",
      briefPath: ".memcode/brief.md",
      contextConfig: config,
      toolArgs: [
        "--plugin-dir",
        "owned-plugin",
        "--approve-mcps",
        "--force",
        "--yolo",
        "--auto-review",
        "--sandbox=enabled",
        "--print",
        "--output-format",
        "stream-json",
      ],
      onEvent: (event) => events.push(event),
      requestInput,
      permissionMode,
      resumeSessionId,
    });
  return {
    root,
    events,
    start,
    trace: async () =>
      (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

test(
  "Cursor ACP routes exact permission/question/plan replies, model, MCP context and logical completion",
  { timeout: 10000 },
  async () => {
    const f = await fixture(),
      prompts: WorkerInputPrompt[] = [];
    const session = f.start(async (prompt) => {
      prompts.push(prompt);
      if (prompt.kind === "approval") return { optionId: "once-exact" };
      if (prompt.kind === "question")
        return { answers: { palette: "forest", features: ["a", "b"] } };
      return { optionId: "accept" };
    });
    assert.ok(session.child);
    assert.deepEqual(await session.completion, { exitCode: 0 });
    assert.ok(f.events.some((event) => event.type === "activity" && event.toolId === "tool-1" && event.toolResult === "failed"));
    const log = await f.trace(),
      requests = log.filter((row) => row.in?.method).map((row) => row.in);
    const response = (id: string | number) =>
      log.find((row) => row.in?.id === id && !row.in?.method)?.in;
    assert.deepEqual(response(0).result, {
      outcome: { outcome: "selected", optionId: "once-exact" },
    });
    assert.deepEqual(response("native-question:17").result, {
      outcome: {
        outcome: "answered",
        answers: [
          { questionId: "palette", selectedOptionIds: ["forest"] },
          { questionId: "features", selectedOptionIds: ["a", "b"] },
        ],
      },
    });
    assert.deepEqual(response("native-plan:18").result, {
      outcome: { outcome: "accepted" },
    });
    assert.equal(response("wrong-session").error.code, -32602);
    assert.equal(response("unexpected-file-write").error.code, -32601);
    assert.equal(prompts.length, 3);
    assert.ok(prompts[0].details?.includes("npm run dev"));
    assert.equal(prompts[1].questions?.[1].multiple, true);
    assert.equal(prompts[1].questions?.[0].allowText, false);
    const servers = requests.find((request) => request.method === "session/new")
      .params.mcpServers;
    assert.deepEqual(servers[0], {
      name: "memcode-context",
      command: "node",
      args: ["context-bridge.mjs"],
      env: [{ name: "CONTEXT_SECRET", value: "fixture-only-secret" }],
    });
    assert.ok(
      requests.some(
        (request) =>
          request.method === "session/set_config_option" &&
          request.params.configId === "model-choice" &&
          request.params.value === "routed-model",
      ),
    );
    assert.ok(
      requests.some(
        (request) =>
          request.params.configId === "thought" &&
          request.params.value === "high",
      ),
    );
    assert.equal(
      requests.find((request) => request.method === "session/prompt").params
        .prompt[0].text,
      "Implement the actual story brief.",
    );
    const argv = log[0].argv;
    assert.ok(argv.includes("--plugin-dir"));
    assert.ok(argv.includes("acp"));
    for (const bypass of [
      "--force",
      "--yolo",
      "--auto-review",
      "--print",
      "stream-json",
    ])
      assert.ok(!argv.includes(bypass));
    assert.equal(log[0].configDir, join(f.root, "profile"));
    const messages = f.events.filter(
      (event): event is Extract<AgentEvent, { type: "message" }> =>
        event.type === "message" && event.role === "assistant",
    );
    assert.equal(messages.length, 3);
    assert.equal(messages[0].messageId, messages[1].messageId);
    assert.notEqual(messages[1].messageId, messages[2].messageId);
    assert.equal(messages[0].delta, true);
    assert.ok(
      f.events.some(
        (event) =>
          event.type === "error" &&
          event.fatal === false &&
          event.message.includes("denied"),
      ),
    );
    assert.ok(
      f.events.some(
        (event) =>
          event.type === "session" && event.sessionId === "session-fixture",
      ),
    );
    assert.equal(
      f.events.filter((event) => event.type === "prompted").length,
      1,
    );
    assert.ok(!JSON.stringify(f.events).includes("fixture-only-secret"));
  },
);

test("Cursor rejects unsupported ACP Smart auto before starting a process", async () => {
  const f = await fixture();
  assert.throws(
    () => f.start(async () => ({ cancelled: true }), "auto"),
    /ACP transport does not support Smart auto/,
  );
});

test("Cursor Full access is explicit, preserves native questions and cannot inherit conflicting modes", async () => {
  const f = await fixture(),
    prompts: WorkerInputPrompt[] = [];
  const session = f.start(async (prompt) => {
    prompts.push(prompt);
    if (prompt.kind === "approval") return { optionId: "once-exact" };
    if (prompt.kind === "question")
      return { answers: { palette: "forest", features: ["a", "b"] } };
    return { optionId: "accept" };
  }, "full-access");
  assert.equal((await session.completion).exitCode, 0);
  const argv = (await f.trace())[0].argv as string[];
  assert.equal(argv.filter((arg) => arg === "--force").length, 1);
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "disabled");
  assert.ok(!argv.includes("--auto-review"));
  assert.ok(!argv.includes("--yolo"));
  assert.ok(!argv.includes("--sandbox=enabled"));
  assert.equal(
    prompts.filter((prompt) => prompt.kind === "question").length,
    1,
  );
  assert.equal(prompts.filter((prompt) => prompt.kind === "plan").length, 1);
});

test(
  "stopping Cursor cancels the exact pending native request and ignores late UI answers",
  { timeout: 10000 },
  async () => {
    const f = await fixture("cancel");
    let ready!: () => void,
      answer!: (response: WorkerInputResponse) => void,
      signal: AbortSignal | undefined;
    const waiting = new Promise<void>((done) => {
      ready = done;
    });
    const session = f.start((_prompt, pendingSignal) => {
      signal = pendingSignal;
      ready();
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    await waiting;
    await session.stop();
    assert.deepEqual(await session.completion, { exitCode: null });
    assert.equal(signal?.aborted, true);
    answer({ optionId: "once-exact" });
    await new Promise((done) => setTimeout(done, 10));
    const responses = (await f.trace())
      .filter((row) => row.in?.id === 0 && !row.in?.method)
      .map((row) => row.in);
    assert.deepEqual(responses, [
      { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "cancelled" } } },
    ]);
  },
);

test(
  "invented option IDs cannot grant Cursor permission or answer its questions",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    const session = f.start(async (prompt) =>
      prompt.kind === "plan"
        ? { optionId: "reject" }
        : prompt.kind === "question"
          ? { answers: { palette: "invented", features: ["a"] } }
          : { optionId: "unprovided-allow" },
    );
    assert.deepEqual(await session.completion, { exitCode: 0 });
    const log = await f.trace();
    for (const id of [0, "native-question:17"])
      assert.deepEqual(
        log.find((row) => row.in?.id === id && !row.in?.method).in.result,
        { outcome: { outcome: "cancelled" } },
      );
    assert.equal(
      log.find((row) => row.in?.id === "native-plan:18" && !row.in?.method).in
        .result.outcome.outcome,
      "rejected",
    );
  },
);

test(
  "premature Cursor process exit is an error, not a completed implementation",
  { timeout: 10000 },
  async () => {
    const f = await fixture("early"),
      session = f.start(async () => ({ cancelled: true }));
    const result = await session.completion;
    assert.equal(result.exitCode, 2);
    assert.match(result.error ?? "", /Native fixture stopped unexpectedly/);
  },
);

for (const scenario of ["resume", "resume-fast", "resume-unsupported", "resume-missing", "resume-wrong"]) {
  test(`Cursor ${scenario} keeps a follow-up on its original conversation`, async () => {
    const run = await fixture(scenario);
    try {
      const session = run.start(async () => ({ cancelled: true }), "review", "session-fixture");
      const result = await session.completion;
      const sent = (await run.trace()).map((line) => line.in).filter(Boolean);
      assert.ok(!sent.some((p) => p.method === "session/new"));
      assert.equal(sent.find((p) => p.method === (scenario === "resume-fast" ? "session/resume" : "session/load"))?.params.sessionId,
        scenario === "resume-unsupported" ? undefined : "session-fixture");
      assert.equal(sent.find((p) => p.method === "session/prompt")?.params.sessionId,
        ["resume", "resume-fast"].includes(scenario) ? "session-fixture" : undefined);
      assert.ok(!run.events.some((e) => e.type === "message" && e.text.includes("history from an earlier turn")));
      if (["resume", "resume-fast"].includes(scenario)) assert.equal(result.exitCode, 0);
      else {
        assert.match(result.error ?? "", /previous Cursor|original Cursor/i);
        assert.ok(!result.error!.includes("session-fixture"));
      }
    } finally { await rm(run.root, { recursive: true, force: true }); }
  });
}
