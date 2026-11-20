import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { startCodexSession } from "../runtime/agents/codex";
import type { AgentEvent, AgentSessionOptions } from "../runtime/agents/types";
import type {
  WorkerInputPrompt,
  WorkerInputResponse,
} from "../src/worker-input";

const fixture = `
import { createInterface } from 'node:readline';
const rl=createInterface({input:process.stdin});
const send=p=>process.stdout.write(JSON.stringify(p)+'\\n');
const notify=(method,params)=>send({method,params});
let index=0,initialized=false,threadSettings,turnSettings; const replies=[];
const requests=JSON.parse(process.env.REQUESTS||'[]');
const notifications=JSON.parse(process.env.NOTIFICATIONS||'[]');
function next(){
 if(index<requests.length){const r=requests[index++]; send({id:r.id,method:r.method,params:{threadId:'thread-native',turnId:'turn-native',...r.params}});}
 else if(process.env.WAIT!=='yes'){
  notify('item/agentMessage/delta',{threadId:'thread-native',itemId:'final',delta:'Done'});
  notify('item/completed',{threadId:'thread-native',item:{type:'agentMessage',id:'final',text:'Done'}});
  notify('item/completed',{threadId:'thread-native',item:{type:'agentMessage',id:'evidence',text:JSON.stringify({replies,args:process.argv.slice(2),threadSettings,turnSettings})}});
  notify('turn/completed',{threadId:'thread-native',turn:{id:'turn-native',status:process.env.FAIL==='yes'?'failed':'completed',error:process.env.FAIL==='yes'?{message:'Native failure'}:null}});
 }
}
rl.on('line',line=>{const p=JSON.parse(line);
 if(p.method==='initialize'){
  if(process.env.INIT_FAIL==='yes'){send({id:p.id,error:{code:-32603,message:'Initialization rejected'}});return;}
  if(p.params.capabilities.requiredHumanApproval!==true)process.exit(11);
  send({id:p.id,result:{userAgent:'fixture'}});
 }else if(p.method==='initialized')initialized=true;
 else if(p.method==='account/read')send({id:p.id,result:{account:{type:'chatgpt',id:'fixture'}}});
 else if(p.method==='model/list')send({id:p.id,result:{data:process.env.NO_CATALOG==='yes'?[]:[{model:'chosen-model',isDefault:true}]}});
 else if(p.method==='thread/start'||p.method==='thread/resume'){
  if(process.env.RESUME && (p.method!=='thread/resume'||p.params.threadId!==process.env.RESUME)){send({id:p.id,error:{message:'Expected the original thread to resume'}});return;}
  if(process.env.RESUME_ERROR){send({id:p.id,error:{message:'Unknown thread '+p.params.threadId}});return;}
  threadSettings=p.params;
  if(process.env.MODEL_DENIED==='yes'){send({id:p.id,error:{code:-32603,message:'The requested model is not supported when using Codex with a ChatGPT account.',data:{code:'model_not_found'}}});return;}
  const full=process.env.MODE==='full-access';
  if(!initialized||p.params.approvalPolicy!==(full?'never':'on-request')||p.params.sandbox!==(full?'danger-full-access':'workspace-write')||p.params.approvalsReviewer!==(process.env.MODE==='auto'?'auto_review':'user')||(p.method==='thread/start'&&p.params.allowProviderModelFallback!==false)||p.params.model!==(process.env.NO_CATALOG==='yes'?undefined:'chosen-model'))process.exit(12);
  send({id:p.id,result:{thread:{id:process.env.WRONG_RESUME?'unrelated-thread':'thread-native'},...(process.env.NO_MODEL_METADATA==='yes'?{}:{model:'resolved-model',reasoningEffort:'medium'}),approvalPolicy:p.params.approvalPolicy,approvalsReviewer:process.env.DOWNGRADE==='yes'?'user':p.params.approvalsReviewer,sandbox:{type:full?'dangerFullAccess':'workspaceWrite'}}});
 }else if(p.method==='turn/start'){
  turnSettings=p.params;
  if(p.params.effort!==(process.env.NO_CATALOG==='yes'?undefined:'high')||p.params.input[0].text!=='The exact prompt')process.exit(13);
  send({id:p.id,result:{turn:{id:'turn-native',status:'inProgress'}}});
  for(const event of notifications)notify(event.method,event.params);
  notify('item/started',{threadId:'thread-native',item:{id:'tool-1',type:'commandExecution',command:'npm test'}});
  notify('item/completed',{threadId:'thread-native',item:{id:'tool-1',type:'commandExecution',command:'npm test',status:'completed',exitCode:0}});
  notify('turn/plan/updated',{threadId:'thread-native',plan:[{step:'Check the code',status:'inProgress'}]});
  if(process.env.MALFORMED==='yes')process.stdout.write('{bad json\\n'); else next();
 }else if(p.method==='turn/interrupt')send({id:p.id,result:{}});
 else if(p.id!==undefined){replies.push(p);next();}
});
`;

async function runFixture(
  env: Record<string, string> = {},
  respond: (
    prompt: WorkerInputPrompt,
    signal?: AbortSignal,
  ) => Promise<WorkerInputResponse> = async () => ({ cancelled: true }),
) {
  const dir = await mkdtemp(join(tmpdir(), "memcode-codex-protocol-"));
  const script = join(dir, "server.mjs");
  await writeFile(script, fixture);
  const events: AgentEvent[] = [],
    prompts: WorkerInputPrompt[] = [];
  const options: AgentSessionOptions = {
    command: { command: process.execPath, prefix: [script], identity: env.COMMAND_IDENTITY },
    cwd: dir,
    env: { ...process.env, ...env },
    model: env.REQUESTED ?? "chosen-model",
    automaticModelTier: env.AUTO_TIER === "yes" ? "balanced" : undefined,
    effort: "high",
    resumeSessionId: env.RESUME,
    prompt: "The exact prompt",
    briefPath: "brief.md",
    toolArgs: [
      "-c",
      "mcp_servers.memcode_context={enabled=true,required=true}",
      "-c",
      "approval_policy=never",
      "--config=approvals_reviewer=guardian_subagent",
      "-c",
      "sandbox_mode=danger-full-access",
    ],
    permissionMode: env.MODE as AgentSessionOptions["permissionMode"],
    onEvent: (event) => events.push(event),
    requestInput: async (prompt, signal) => {
      prompts.push(prompt);
      return respond(prompt, signal);
    },
  };
  const session = startCodexSession(options);
  const close = once(session.child, "close");
  return {
    session,
    events,
    prompts,
    async cleanup() {
      session.stop();
      await close;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const evidence = (events: AgentEvent[]) => {
  const item = events.find(
    (event) => event.type === "message" && event.messageId === "evidence",
  );
  assert.ok(item?.type === "message");
  return JSON.parse(item.text);
};

test("Codex resumes the exact native thread for a follow-up", async () => {
  const f = await runFixture({
    RESUME: "thread-native",
    NOTIFICATIONS: JSON.stringify([{method: "thread/tokenUsage/updated", params: {
      threadId: "thread-native", turnId: "turn-native", tokenUsage: { total: { inputTokens: 8000, outputTokens: 4000 } },
    }}]),
  });
  try {
    assert.equal((await f.session.completion).exitCode, 0);
    assert.equal(evidence(f.events).threadSettings.threadId, "thread-native");
    assert.equal(evidence(f.events).turnSettings.threadId, "thread-native");
    assert.equal(f.events.some(event => event.type === "measurement" && event.usage), false);
  } finally { await f.cleanup(); }
});

test("a rejected or mismatched Codex resume never prompts a new thread or exposes its private ID", async () => {
  for (const failure of [{ RESUME_ERROR: "yes" }, { WRONG_RESUME: "yes" }] as Record<string, string>[]) {
    const f = await runFixture({ RESUME: "thread-native", ...failure });
    try {
      const result = await f.session.completion;
      assert.equal(result.exitCode, 1);
      assert.doesNotMatch(result.error || "", /thread-native/);
      assert.equal(f.events.some(e => e.type === "prompted"), false);
    } finally { await f.cleanup(); }
  }
});

test("Codex refuses an unavailable pinned model before the brief is sent", async () => {
  const fixture = await runFixture({ REQUESTED:"old-model" });
  try {
    assert.match((await fixture.session.completion).error ?? "", /cannot confirm access/);
    assert.equal(fixture.events.some(e => e.type === "prompted"), false);
  } finally { await fixture.cleanup(); }
});

test("Codex remembers a provider model rejection for the same account and runtime", async () => {
  const identity = "model-rejection-fixture";
  const first = await runFixture({ COMMAND_IDENTITY: identity, MODEL_DENIED: "yes" });
  try {
    assert.match((await first.session.completion).error ?? "", /not supported/);
    assert.equal(first.events.some(event => event.type === "prompted"), false);
  } finally { await first.cleanup(); }
  const second = await runFixture({ COMMAND_IDENTITY: identity });
  try {
    assert.match((await second.session.completion).error ?? "", /rejected every/);
    assert.equal(second.events.some(event => event.type === "prompted"), false);
  } finally { await second.cleanup(); }
  const other = await runFixture({ COMMAND_IDENTITY: "other-fixture" });
  try {
    assert.equal((await other.session.completion).exitCode, 0);
  } finally { await other.cleanup(); }
});

test("Codex with no advertised models sends an automatic turn without a model or effort override", async () => {
  const fixture = await runFixture({ REQUESTED:"old-model", AUTO_TIER:"yes", NO_CATALOG:"yes" });
  try {
    assert.equal((await fixture.session.completion).exitCode, 0);
    assert.equal(evidence(fixture.events).threadSettings.model, undefined);
    assert.equal(evidence(fixture.events).turnSettings.effort, undefined);
  } finally { await fixture.cleanup(); }
});

test("Codex native turn preserves model, policy, effort, MCP config and finishes before server exit", async () => {
  const f = await runFixture();
  try {
    assert.equal((await f.session.completion).exitCode, 0);
    const result = evidence(f.events);
    assert.equal(
      f.events.filter((event) => event.type === "prompted").length,
      1,
    );
    assert.ok(
      f.events.findIndex((event) => event.type === "prompted") >
        f.events.findIndex((event) => event.type === "session"),
    );
    assert.ok(
      result.args.includes("features.default_mode_request_user_input=true"),
    );
    assert.ok(
      result.args.includes(
        "mcp_servers.memcode_context={enabled=true,required=true}",
      ),
    );
    assert.ok(
      f.events.some(
        (event) =>
          event.type === "session" && event.sessionId === "thread-native",
      ),
    );
    assert.ok(
      f.events.some(
        (event) => event.type === "activity" && event.toolId === "tool-1" &&
          event.label === "Running a command" && !event.toolResult,
      ),
    );
    assert.ok(f.events.some((event) => event.type === "activity" && event.toolId === "tool-1" && event.toolResult === "completed"));
    assert.ok(
      f.events.some(
        (event) =>
          event.type === "message" && event.text.includes("Check the code"),
      ),
    );
    assert.equal(
      f.events.filter(
        (event) => event.type === "message" && event.messageId === "final",
      ).length,
      1,
    );
    assert.equal(
      f.prompts.length,
      0,
      "native plan notification must not invent an approval",
    );
  } finally {
    await f.cleanup();
  }
});

for (const mode of ["review", "auto", "full-access"] as const)
  test(`Codex uses explicit ${mode} settings and keeps inherited arguments from overriding them`, async () => {
    const f = await runFixture({ MODE: mode });
    try {
      assert.equal((await f.session.completion).exitCode, 0);
      const result = evidence(f.events);
      assert.equal(
        result.threadSettings.approvalPolicy,
        mode === "full-access" ? "never" : "on-request",
      );
      assert.equal(
        result.threadSettings.sandbox,
        mode === "full-access" ? "danger-full-access" : "workspace-write",
      );
      assert.equal(
        result.threadSettings.approvalsReviewer,
        mode === "auto" ? "auto_review" : "user",
      );
      assert.equal(
        result.turnSettings.approvalsReviewer,
        result.threadSettings.approvalsReviewer,
      );
      assert.ok(
        !result.args.some((arg: string) =>
          /^(approval_policy|sandbox_mode)=|^--config=approvals_reviewer=/.test(
            arg,
          ),
        ),
      );
    } finally {
      await f.cleanup();
    }
  });

test("Codex refuses a silent downgrade of the selected automatic reviewer before prompting the model", async () => {
  const f = await runFixture({ MODE: "auto", DOWNGRADE: "yes" });
  try {
    const result = await f.session.completion;
    assert.match(result.error ?? "", /did not activate the selected auto/);
    assert.equal(
      f.events.some((event) => event.type === "prompted"),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("Codex setup failure never marks queued context as sent to the model", async () => {
  const f = await runFixture({ INIT_FAIL: "yes" });
  try {
    const result = await f.session.completion;
    assert.equal(result.exitCode, 1);
    assert.match(result.error || "", /Initialization rejected/);
    assert.equal(
      f.events.filter((event) => event.type === "prompted").length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("Codex reports resolved/rerouted models and whole-thread usage snapshots without counting the last response or foreign turns", async () => {
  const total = {
    inputTokens: 250,
    outputTokens: 78,
    cachedInputTokens: 200,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 20,
    totalTokens: 328,
  };
  const usage = (values: Record<string, number>) => ({
    total: values,
    last: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 0 },
  });
  const notifications = [
    {
      method: "item/started",
      params: {
        threadId: "thread-native",
        turnId: "foreign-turn",
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          model: "foreign-child",
        },
      },
    },
    {
      method: "model/rerouted",
      params: {
        threadId: "foreign",
        turnId: "turn-native",
        fromModel: "wrong",
        toModel: "foreign-model",
      },
    },
    {
      method: "model/rerouted",
      params: {
        threadId: "thread-native",
        turnId: "foreign-turn",
        fromModel: "wrong",
        toModel: "foreign-turn-model",
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-native",
        turnId: "foreign-turn",
        tokenUsage: usage({ ...total, inputTokens: 999999 }),
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        tokenUsage: usage({
          ...total,
          inputTokens: 100,
          cachedInputTokens: 70,
          totalTokens: 178,
        }),
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        tokenUsage: usage({
          ...total,
          inputTokens: 100,
          cachedInputTokens: 70,
          totalTokens: 178,
        }),
      },
    },
    {
      method: "model/rerouted",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        fromModel: "resolved-model",
        toModel: "reported-rerouted-model",
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        tokenUsage: usage(total),
      },
    },
  ];
  const f = await runFixture({ NOTIFICATIONS: JSON.stringify(notifications) });
  try {
    assert.equal((await f.session.completion).exitCode, 0);
    const measurements = f.events.filter(
      (event) => event.type === "measurement",
    );
    const models = measurements.filter((event) => !!event.model);
    assert.deepEqual(
      models.map((event) => event.model),
      [
        { id: "resolved-model", source: "codex-thread", effort: "medium" },
        {
          id: "reported-rerouted-model",
          source: "codex-rerouted",
        },
      ],
    );
    assert.deepEqual(models.at(-1)?.models, [
      "resolved-model",
      "reported-rerouted-model",
    ]);
    const usages = measurements.filter((event) => !!event.usage);
    assert.equal(usages.length, 3);
    assert.deepEqual(usages.at(-1)?.usage, {
      inputTokens: 250,
      outputTokens: 78,
      cachedInputTokens: 200,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 20,
      totalTokens: 328,
      scope: "attempt",
      source: "codex-thread-total",
    });
    assert.equal(JSON.stringify(measurements).includes("foreign-model"), false);
    assert.equal(
      JSON.stringify(measurements).includes("foreign-turn-model"),
      false,
    );
    assert.equal(JSON.stringify(measurements).includes("999999"), false);
    const nativeAudits = f.events
      .filter((event) => event.type === "raw")
      .map((event) => event.event);
    assert.equal(nativeAudits.length, 3);
    assert.deepEqual(nativeAudits.at(-1), {
      type: "native-token-usage",
      harness: "codex",
      ...total,
    });
    assert.equal(JSON.stringify(nativeAudits).includes("threadId"), false);
    assert.equal(JSON.stringify(nativeAudits).includes("turnId"), false);
  } finally {
    await f.cleanup();
  }
});

test("Codex does not invent missing model/counter fields or accept another turn's completion", async () => {
  const notifications = [
    {
      method: "turn/completed",
      params: {
        threadId: "thread-native",
        turn: {
          id: "foreign-turn",
          status: "failed",
          error: { message: "wrong turn" },
        },
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-native",
        tokenUsage: { total: { inputTokens: 999 } },
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        tokenUsage: {
          total: {
            inputTokens: -1,
            outputTokens: 55,
            cachedInputTokens: "42",
            cacheWriteInputTokens: 1.5,
            reasoningOutputTokens: 1e12,
          },
        },
      },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        tokenUsage: { total: { inputTokens: -1, outputTokens: "45" } },
      },
    },
  ];
  const f = await runFixture({
    NO_MODEL_METADATA: "yes",
    NOTIFICATIONS: JSON.stringify(notifications),
  });
  try {
    assert.equal((await f.session.completion).exitCode, 0);
    const measurements = f.events.filter(
      (event) => event.type === "measurement",
    );
    assert.equal(
      measurements.some((event) => !!event.model),
      false,
    );
    assert.deepEqual(
      measurements.map((event) => event.usage),
      [
        {
          inputTokens: null,
          outputTokens: 55,
          cachedInputTokens: null,
          cacheCreationInputTokens: null,
          reasoningOutputTokens: null,
          totalTokens: null,
          scope: "attempt",
          source: "codex-thread-total",
        },
      ],
    );
  } finally {
    await f.cleanup();
  }
});

test("Codex marks thread counters as main-loop coverage when native collaboration frames reveal child work", async () => {
  const counter = {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-native",
      turnId: "turn-native",
      tokenUsage: {
        total: {
          inputTokens: 75,
          outputTokens: 25,
          cachedInputTokens: 10,
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 5,
          totalTokens: 100,
        },
      },
    },
  };
  const collaboration = {
    method: "item/started",
    params: {
      threadId: "thread-native",
      turnId: "turn-native",
      item: {
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        model: "unconfirmed-requested-child-model",
      },
    },
  };
  const child = {
    method: "item/completed",
    params: {
      threadId: "thread-native",
      turnId: "turn-native",
      item: { type: "subAgentActivity", kind: "spawn", model: "gpt-6-luna" },
    },
  };
  for (const notifications of [
    [collaboration, child, counter],
    [counter, collaboration, child],
  ]) {
    const f = await runFixture({
      NOTIFICATIONS: JSON.stringify(notifications),
    });
    try {
      assert.equal((await f.session.completion).exitCode, 0);
      const measurements = f.events.filter(
        (event) => event.type === "measurement",
      );
      const lastUsage = measurements
        .filter((event) => event.usage)
        .at(-1)?.usage;
      assert.deepEqual(lastUsage, {
        inputTokens: 75,
        outputTokens: 25,
        cachedInputTokens: 10,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 5,
        totalTokens: 100,
        scope: "main_loop",
        source: "codex-thread-total",
      });
      assert.equal(
        measurements.filter((event) => event.model).at(-1)?.model?.id,
        "resolved-model",
      );
      assert.deepEqual(
        measurements.filter((event) => event.models).at(-1)?.models,
        ["resolved-model", "gpt-6-luna"],
      );
      assert.equal(
        JSON.stringify(measurements).includes(
          "unconfirmed-requested-child-model",
        ),
        false,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("Codex command/file approvals return exact native decisions and string/numeric request IDs", async () => {
  const amendment = {
    acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] },
  };
  const requests = [
    {
      id: "command-request",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "npm test",
        availableDecisions: ["accept", amendment, "decline"],
      },
    },
    {
      id: 91,
      method: "item/fileChange/requestApproval",
      params: { reason: "Write generated files" },
    },
    {
      id: 92,
      method: "item/commandExecution/requestApproval",
      params: { command: "unknown choice" },
    },
  ];
  let count = 0;
  const f = await runFixture(
    { REQUESTS: JSON.stringify(requests) },
    async () => ({
      optionId: ["decision:1", "decision:2", "not-a-decision"][count++],
    }),
  );
  try {
    assert.equal((await f.session.completion).exitCode, 0);
    assert.deepEqual(evidence(f.events).replies, [
      { id: "command-request", result: { decision: amendment } },
      { id: 91, result: { decision: "decline" } },
      { id: 92, result: { decision: "cancel" } },
    ]);
    assert.equal(f.prompts[0].kind, "approval");
    assert.equal(f.prompts[0].options?.[1].kind, "other");
  } finally {
    await f.cleanup();
  }
});

test("Codex structured questions retain native answers, free text, multiple values and secret masking", async () => {
  const requests = [
    {
      id: "question-native",
      method: "item/tool/requestUserInput",
      params: {
        isBlocking: true,
        itemId: "question",
        questions: [
          {
            id: "color",
            header: "Color",
            question: "Choose color",
            options: [{ label: "Green", description: "Default" }],
          },
          {
            id: "custom",
            header: "Custom",
            question: "Describe it",
            isOther: true,
            multiple: true,
            options: [
              { label: "Small", description: "Compact" },
              { label: "Large", description: "Roomy" },
            ],
          },
          {
            id: "secret",
            header: "Secret",
            question: "Passphrase",
            isSecret: true,
          },
        ],
      },
    },
  ];
  const f = await runFixture(
    { REQUESTS: JSON.stringify(requests) },
    async () => ({
      answers: {
        color: "answer:0",
        custom: ["answer:1", "Custom wording"],
        secret: "fixture-not-a-real-secret",
      },
    }),
  );
  try {
    assert.equal((await f.session.completion).exitCode, 0);
    assert.deepEqual(evidence(f.events).replies[0], {
      id: "question-native",
      result: {
        answers: {
          color: { answers: ["Green"] },
          custom: { answers: ["Large", "Custom wording"] },
          secret: { answers: ["fixture-not-a-real-secret"] },
        },
      },
    });
    assert.equal(f.prompts[0].questions?.[2].secret, true);
    assert.equal(f.prompts[0].questions?.[1].multiple, true);
    assert.equal(f.prompts[0].questions?.[0].allowText, false);
  } finally {
    await f.cleanup();
  }
});

test("Codex MCP forms and extra permission scopes require explicit human input; unknown methods fail closed", async () => {
  const requests = [
    {
      id: "form",
      method: "mcpServer/elicitation/request",
      params: {
        mode: "form",
        message: "Choose",
        requestedSchema: {
          type: "object",
          required: ["count"],
          properties: {
            count: { type: "integer" },
            active: { type: "boolean" },
          },
        },
      },
    },
    {
      id: "permission",
      method: "item/permissions/requestApproval",
      params: { permissions: { network: { enabled: true } } },
    },
    {
      id: "unsupported",
      method: "item/tool/call",
      params: { tool: "arbitrary" },
    },
  ];
  const f = await runFixture(
    { REQUESTS: JSON.stringify(requests) },
    async (prompt) =>
      prompt.kind === "question"
        ? { answers: { count: "3", active: "field:0" } }
        : { optionId: "deny" },
  );
  try {
    assert.equal((await f.session.completion).exitCode, 0);
    const replies = evidence(f.events).replies;
    assert.deepEqual(replies[0].result, {
      action: "accept",
      content: { count: 3, active: true },
    });
    assert.deepEqual(replies[1].result, { permissions: {}, scope: "turn" });
    assert.equal(replies[2].error.code, -32601);
    assert.equal(f.prompts.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("Codex stop aborts pending human input and ends the native session without approving", async () => {
  let ready!: () => void,
    aborted = false;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const f = await runFixture(
    {
      WAIT: "yes",
      REQUESTS: JSON.stringify([
        { id: 9, method: "item/fileChange/requestApproval", params: {} },
      ]),
    },
    async (_prompt, signal) => {
      ready();
      return await new Promise((resolve) =>
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve({ cancelled: true });
          },
          { once: true },
        ),
      );
    },
  );
  try {
    await waiting;
    f.session.stop();
    assert.equal((await f.session.completion).exitCode, 130);
    assert.equal(aborted, true);
  } finally {
    await f.cleanup();
  }
});

test("Codex native failures and malformed transport never count as successful coding turns", async () => {
  for (const env of [{ FAIL: "yes" }, { MALFORMED: "yes" }] as Record<
    string,
    string
  >[]) {
    const f = await runFixture(env);
    try {
      const result = await f.session.completion;
      assert.equal(result.exitCode, 1);
      assert.match(result.error || "", /Native failure|invalid protocol/);
    } finally {
      await f.cleanup();
    }
  }
});
