import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startClaudeSession } from "../runtime/agents/claude";
import { childEnv } from "../runtime/commands";
import type { AgentEvent, AgentSessionOptions } from "../runtime/agents/types";
import type {
  WorkerInputPrompt,
  WorkerInputResponse,
} from "../src/worker-input";

// Wire shapes match Anthropic's SDK query.py and official user-input examples.
const fixture = String.raw`
import { createInterface } from 'node:readline';
import { appendFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const scenario=process.env.SCENARIO;
await writeFile('argv.json',JSON.stringify(process.argv.slice(2)));
const send=value=>console.log(JSON.stringify(value));
const request=(id,name,input)=>send({type:'control_request',request_id:id,request:{subtype:'can_use_tool',tool_name:name,input,tool_use_id:'tool-'+id}});
const bash={command:"printf 'original input'",timeout:2000};
const questions=[{question:'Which stack?',header:'Stack',options:[{label:'Rust',description:'Native'},{label:'TypeScript',description:'Web'}],multiSelect:false},{question:'Which platforms?',header:'Platform',options:[{label:'Linux'},{label:'Windows'}],multiSelect:true}];
const finish=(error=false)=>{send({type:'result',subtype:error?'error_during_execution':'success',is_error:error,result:error?'Provider reported a terminal failure.':'Same session complete.'});if(scenario==='hang'){setInterval(()=>{},1000);}};
for await(const line of createInterface({input:process.stdin})){
 const frame=JSON.parse(line);
 await appendFile('received.jsonl',JSON.stringify(frame)+'\n');
 if(frame.type==='control_request'){
  if(frame.request.subtype==='interrupt')process.exit(0);
  assert.equal(frame.request.subtype,'initialize');
  if(scenario==='init-fail'){send({type:'control_response',response:{subtype:'error',request_id:frame.request_id,error:'Fixture initialization rejected.'}});continue;}
  send({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{models:[{value:'fixture-model'}]}}});continue;
 }
 if(frame.type==='user'){
  assert.equal(frame.message.role,'user');assert.equal(frame.message.content,'A prompt with $(literal) and "quotes".');
  send({type:'system',subtype:'init',session_id:'same-claude-session',permissionMode:scenario==='mode-downgrade'?'default':process.argv[process.argv.indexOf('--permission-mode')+1]});
  if(scenario==='mode-downgrade')continue;
  process.stderr.write('A live diagnostic before completion.\n');
  if(scenario==='early')process.exit(0);
  if(scenario==='measurements'){
   send({type:'assistant',message:{id:'native-response',model:'claude-sonnet-5-5',usage:{input_tokens:1,output_tokens:9999},content:[{type:'text',text:'Completed the fixture.'}]}});
   send({type:'result',subtype:'success',is_error:false,result:'Completed the fixture.',usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:40},modelUsage:{'claude-sonnet-5-5':{inputTokens:10,outputTokens:20,cacheReadInputTokens:30,cacheCreationInputTokens:40}}});continue;
  }
  if(scenario==='hang'){finish();continue;}
  if(scenario==='cancel'){
   request('cancel-me','Bash',bash);
   setTimeout(()=>{send({type:'control_cancel_request',request_id:'cancel-me'});request('after-cancel','Write',{file_path:'denied.txt',content:'no'});},70);
   continue;
  }
  if(scenario==='unsupported'){send({type:'control_request',request_id:'unsupported',request:{subtype:'unknown_capability'}});continue;}
  send({type:'assistant',message:{content:[{type:'tool_use',id:'bash-tool',name:'Bash',input:bash}]}});
  request('approval','Bash',bash);continue;
 }
 assert.equal(frame.type,'control_response');
 const r=frame.response;
 if(r.request_id==='unsupported'){assert.equal(r.subtype,'error');finish();continue;}
 assert.equal(r.subtype,'success');
 if(r.request_id==='approval'){
  assert.deepEqual(r.response,{behavior:'allow',updatedInput:bash});
  send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'bash-tool',is_error:true,content:[{type:'text',text:'A recoverable tool failure.'}]}]}});
  request('questions','AskUserQuestion',{questions,metadata:{source:'original'}});continue;
 }
 if(r.request_id==='questions'){
  assert.equal(r.response.behavior,'allow');assert.deepEqual(r.response.updatedInput.questions,questions);
  assert.deepEqual(r.response.updatedInput.answers,{'Which stack?':'TypeScript','Which platforms?':['Linux','Windows']});
  assert.deepEqual(r.response.updatedInput.metadata,{source:'original'});
  request('free-text','AskUserQuestion',{questions:[{question:'What should we call it?',options:[{label:'One'},{label:'Two'}],multiSelect:false}]});continue;
 }
 if(r.request_id==='free-text'){
  assert.equal(r.response.updatedInput.answers['What should we call it?'],'A custom name');
  send({type:'assistant',message:{content:[{type:'text',text:'The proposed plan is to keep execution local.'}]}});
  request('plan','ExitPlanMode',{allowedPrompts:[]});continue;
 }
 if(r.request_id==='plan'){
  assert.deepEqual(r.response,{behavior:'allow',updatedInput:{allowedPrompts:[]}});
  send({type:'assistant',message:{content:[{type:'text',text:'Same session complete.'}]}});finish();continue;
 }
 if(r.request_id==='after-cancel'){
  assert.equal(r.response.behavior,'deny');
  setTimeout(()=>{finish(true);process.exitCode=0;},80);continue;
 }
 throw Error('Unexpected or stale response: '+r.request_id);
}
`;

async function waitFor(check: () => boolean, label: string) {
  const until = Date.now() + 5000;
  while (!check() && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), label);
}
async function setup(
  scenario: string,
  requestInput: AgentSessionOptions["requestInput"],
  permissionMode?: AgentSessionOptions["permissionMode"],
) {
  const directory = await mkdtemp(join(tmpdir(), "memcode-claude-protocol-"));
  const script = join(directory, "fixture.mjs");
  await writeFile(script, fixture);
  const events: AgentEvent[] = [];
  const session = startClaudeSession({
    command: { command: process.execPath, prefix: [script] },
    cwd: directory,
    env: { ...childEnv(), SCENARIO: scenario },
    model: "fixture-model",
    effort: "high",
    prompt: 'A prompt with $(literal) and "quotes".',
    briefPath: ".memcode/brief.md",
    contextConfig: join(directory, "context-mcp.json"),
    toolArgs: [
      "--max-turns",
      "3",
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-skip-permissions",
      "--permission-prompts=none",
    ],
    permissionMode,
    onEvent: (event) => events.push(event),
    requestInput,
  });
  return {
    directory,
    events,
    session,
    async cleanup() {
      session.stop();
      await session.completion;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Claude approvals, questions and plan review return exact control responses to the same running process", async () => {
  const pending: Array<{
    prompt: WorkerInputPrompt;
    respond: (response: WorkerInputResponse) => void;
  }> = [];
  const run = await setup(
    "interactive",
    (prompt) => new Promise((respond) => pending.push({ prompt, respond })),
  );
  try {
    assert.ok(
      run.session.child.pid,
      "adapter returns its spawned child synchronously",
    );
    let completed = false;
    void run.session.completion.then(() => {
      completed = true;
    });
    await waitFor(
      () => pending.length === 1,
      "approval is displayed before execution continues",
    );
    assert.equal(completed, false);
    assert.equal(pending[0].prompt.kind, "approval");
    assert.match(pending[0].prompt.details!, /original input/);
    assert.deepEqual(
      pending[0].prompt.options!.map((option) => option.id),
      ["allow-once", "deny"],
    );
    assert.ok(
      run.events.some(
        (event) =>
          event.type === "message" && event.text.includes("live diagnostic"),
      ),
      "stderr is visible while awaiting approval",
    );
    pending[0].respond({ optionId: "allow-once" });
    await waitFor(
      () => pending.length === 2,
      "questions arrive on the same session",
    );
    assert.equal(pending[1].prompt.kind, "question");
    assert.equal(pending[1].prompt.questions![0].allowText, true);
    assert.equal(pending[1].prompt.questions![1].multiple, true);
    pending[1].respond({
      answers: {
        "question-0": "option-1",
        "question-1": ["option-0", "option-1"],
      },
    });
    await waitFor(() => pending.length === 3, "free text question arrives");
    pending[2].respond({ answers: { "question-0": "A custom name" } });
    await waitFor(() => pending.length === 4, "plan review arrives");
    assert.equal(pending[3].prompt.kind, "plan");
    assert.match(pending[3].prompt.details!, /keep execution local/);
    pending[3].respond({ optionId: "allow-once" });
    assert.deepEqual(await run.session.completion, { exitCode: 0 });
    assert.ok(run.events.some((event) => event.type === "activity" && event.toolId === "bash-tool" && event.toolResult === "failed"));
    assert.equal(
      run.events.filter((event) => event.type === "prompted").length,
      1,
    );
    assert.ok(
      run.events.some(
        (event) =>
          event.type === "session" && event.sessionId === "same-claude-session",
      ),
    );
    assert.ok(
      run.events.some(
        (event) =>
          event.type === "error" &&
          event.fatal === false &&
          /recoverable/.test(event.message),
      ),
    );
    assert.equal(
      run.events.filter(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.text === "Same session complete.",
      ).length,
      1,
      "terminal result does not duplicate assistant output",
    );
    const argv = JSON.parse(
      await readFile(join(run.directory, "argv.json"), "utf8"),
    ) as string[];
    assert.equal(argv[argv.indexOf("--input-format") + 1], "stream-json");
    assert.equal(argv[argv.indexOf("--permission-prompt-tool") + 1], "stdio");
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.match(
      argv[argv.indexOf("--tools") + 1],
      /AskUserQuestion,EnterPlanMode,ExitPlanMode/,
    );
    assert.equal(
      argv[argv.indexOf("--mcp-config") + 1],
      join(run.directory, "context-mcp.json"),
    );
    assert.equal(argv[argv.indexOf("--model") + 1], "fixture-model");
    assert.equal(argv[argv.indexOf("--effort") + 1], "high");
    assert.ok(!argv.some((arg) => /dangerously|bypass|yolo/.test(arg)));
    assert.ok(!argv.includes('A prompt with $(literal) and "quotes".'));
  } finally {
    await run.cleanup();
  }
});

for (const mode of ["review", "auto", "full-access"] as const)
  test(`Claude native ${mode} never inherits an overriding bypass and preserves its interactive channel`, async () => {
    const prompts: WorkerInputPrompt[] = [];
    const run = await setup(
      "hang",
      async (prompt) => {
        prompts.push(prompt);
        return { cancelled: true };
      },
      mode,
    );
    try {
      assert.equal((await run.session.completion).exitCode, 0);
      const argv = JSON.parse(
        await readFile(join(run.directory, "argv.json"), "utf8"),
      ) as string[];
      assert.equal(
        argv[argv.indexOf("--permission-mode") + 1],
        mode === "auto"
          ? "auto"
          : mode === "full-access"
            ? "bypassPermissions"
            : "acceptEdits",
      );
      assert.equal(argv.filter((arg) => arg === "--permission-mode").length, 1);
      assert.ok(!argv.includes("--dangerously-skip-permissions"));
      assert.ok(!argv.includes("--permission-prompts=none"));
      assert.equal(argv[argv.indexOf("--permission-prompt-tool") + 1], "stdio");
    } finally {
      await run.cleanup();
    }
  });

test("Claude fails visibly when the native session falls back from Auto to Manual", async () => {
  const run = await setup(
    "mode-downgrade",
    async () => ({ cancelled: true }),
    "auto",
  );
  try {
    const result = await run.session.completion;
    assert.match(
      result.error ?? "",
      /did not activate the selected auto.*reported default/,
    );
  } finally {
    await run.cleanup();
  }
});

test("Claude initialization failure never marks the brief as prompted", async () => {
  const run = await setup("init-fail", async () => {
    throw Error("No input is possible before initialization");
  });
  try {
    assert.match(
      (await run.session.completion).error!,
      /Fixture initialization rejected/,
    );
    assert.equal(
      run.events.filter((event) => event.type === "prompted").length,
      0,
    );
    const received = (
      await readFile(join(run.directory, "received.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(!received.some((frame) => frame.type === "user"));
  } finally {
    await run.cleanup();
  }
});

test("native cancellation aborts visible input and suppresses stale answers; error results fail even with process exit zero", async () => {
  const pending: Array<{
    signal?: AbortSignal;
    respond: (response: WorkerInputResponse) => void;
  }> = [];
  const run = await setup(
    "cancel",
    (_prompt, signal) =>
      new Promise((respond) => pending.push({ signal, respond })),
  );
  try {
    await waitFor(
      () => pending.length === 2,
      "replacement request arrives after native cancellation",
    );
    assert.equal(pending[0].signal?.aborted, true);
    pending[0].respond({ optionId: "allow-once" });
    pending[1].respond({ optionId: "deny" });
    assert.deepEqual(await run.session.completion, {
      exitCode: 1,
      error: "Provider reported a terminal failure.",
    });
    const received = (
      await readFile(join(run.directory, "received.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      !received.some((frame) => frame.response?.request_id === "cancel-me"),
    );
    assert.equal(
      received.find((frame) => frame.response?.request_id === "after-cancel")
        .response.response.behavior,
      "deny",
    );
  } finally {
    await run.cleanup();
  }
});

test("a logical result completes and cleans up a CLI that keeps stdin/process open", async () => {
  const run = await setup("hang", async () => {
    throw Error("Unexpected input request");
  });
  try {
    assert.deepEqual(await run.session.completion, { exitCode: 0 });
    assert.ok(
      run.session.child.exitCode !== null ||
        run.session.child.signalCode !== null,
      "completion waits for owned process termination",
    );
  } finally {
    await run.cleanup();
  }
});

test("Claude adapter forwards actual response identity and final cumulative usage from its real native protocol boundary", async () => {
  const run = await setup("measurements", async () => {
    throw Error("Unexpected input request");
  });
  try {
    assert.deepEqual(await run.session.completion, { exitCode: 0 });
    const measurements = run.events.filter(
      (event) => event.type === "measurement",
    );
    assert.equal(measurements.at(-1)?.model?.id, "claude-sonnet-5-5");
    assert.deepEqual(measurements.at(-1)?.usage, {
      inputTokens: 80,
      outputTokens: 20,
      cachedInputTokens: 30,
      cacheCreationInputTokens: 40,
      scope: "attempt",
      source: "claude-model-total",
      totalTokens: 100,
    });
    assert.equal(
      measurements.at(-1)?.usage?.outputTokens === 9999,
      false,
      "partial assistant placeholders are not final usage",
    );
  } finally {
    await run.cleanup();
  }
});

test("stopping Claude aborts a pending approval and confirms process termination", async () => {
  let signal: AbortSignal | undefined;
  const run = await setup("interactive", async (_prompt, inputSignal) => {
    signal = inputSignal;
    return new Promise<WorkerInputResponse>(() => {});
  });
  try {
    await waitFor(() => !!signal, "approval is pending");
    run.session.stop();
    await run.session.completion;
    assert.equal(signal!.aborted, true);
    assert.ok(
      run.session.child.exitCode !== null ||
        run.session.child.signalCode !== null,
    );
  } finally {
    await run.cleanup();
  }
});

test("unsupported controls fail closed and an early successful process exit is not a completed agent result", async () => {
  const run = await setup("unsupported", async () => {
    throw Error("Unknown controls must not grant permission");
  });
  try {
    assert.deepEqual(await run.session.completion, { exitCode: 0 });
  } finally {
    await run.cleanup();
  }
  const early = await setup("early", async () => ({ optionId: "allow-once" }));
  try {
    assert.match(
      (await early.session.completion).error!,
      /before returning a result/,
    );
  } finally {
    await early.cleanup();
  }
});
