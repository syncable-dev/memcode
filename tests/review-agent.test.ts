import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { initialState } from "../src/seed";
import type { Harness, WorkItem } from "../src/shared";
import type { StoryReviewRun } from "../src/code-review";
import {
  createReadonlyReviewAgent,
  readReviewFile,
  stopReviewProcess,
} from "../runtime/review-agent";

const fixtureScript = `
import fs from 'node:fs';import readline from 'node:readline';
const [harness,scenario,recordPath]=process.argv.slice(2,5);const record={args:process.argv.slice(5),requests:[],replies:[],prompted:false};
const save=()=>fs.writeFileSync(recordPath,JSON.stringify(record));const send=p=>console.log(JSON.stringify(p));save();
if(harness==='claude'){
 let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{record.prompted=true;record.contextRead=fs.readFileSync('review-context.json','utf8').includes('snapshot');save();send({type:'system',subtype:'init',model:'actual-claude',permissionMode:'dontAsk',tools:scenario==='writable'?['Read','Bash']:['Read','Glob','Grep'],mcp_servers:[]});if(scenario==='writable')return;send({type:'assistant',message:{model:'actual-claude',content:[{type:'tool_use',id:'read-1',name:'Read',input:{file_path:process.cwd()+'/review-context.json'}}]}});send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-1',is_error:false,content:'snapshot'}]}});send({type:'assistant',message:{model:'actual-claude',content:[{type:'text',text:'Read the immutable snapshot. No writes.'}]}});send({type:'result',subtype:'success',is_error:false,result:'Read the immutable snapshot. No writes.'});});
}else{
 const lines=readline.createInterface({input:process.stdin});let pendingId;let testStep=0;
 const probes=[['fs/read_text_file',{path:process.cwd()+'/review-context.json'}],['fs/write_text_file',{path:process.cwd()+'/mutation.txt',content:'bad'}],['terminal/create',{command:'node',args:['-e','require(\"fs\").writeFileSync(\"mutation.txt\",\"bad\")']}],['session/request_permission',{options:[{optionId:'allow',kind:'allow_once'}]}]];
 const probe=()=>{if(testStep<probes.length){const[method,params]=probes[testStep++];send({id:'probe-'+testStep,method,params});return;}send({method:'session/update',params:{sessionId:'cursor-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Read-only context confirmed.'}}}});send({id:pendingId,result:{stopReason:'end_turn'}});};
 lines.on('line',line=>{const p=JSON.parse(line);if(!p.method){record.replies.push(p);save();if(harness==='cursor')probe();else if(p.id==='evidence-probe'){send({id:'write-probe',method:'item/fileChange/requestApproval',params:{reason:'write probe'}});}else if(p.id==='write-probe'){send({method:'item/completed',params:{threadId:'codex-thread',item:{type:'agentMessage',id:'answer',text:'Read-only context confirmed.'}}});send({method:'turn/completed',params:{threadId:'codex-thread',turn:{status:'completed'}}});}return;}
 record.requests.push(p);save();
 if(p.method==='initialize')send({id:p.id,result:harness==='cursor'?{authMethods:[]}:{}});
 if(p.method==='config/read')send({id:p.id,result:{config:{mcp_servers:{}}}});
 if(p.method==='thread/start')send({id:p.id,result:{thread:{id:'codex-thread'},model:'actual-codex',approvalPolicy:'never',sandbox:{type:scenario==='writable'?'workspaceWrite':'readOnly'}}});
 if(p.method==='mcpServerStatus/list')send({id:p.id,result:{data:scenario==='mcp'?[{name:'mutator',tools:{write:{}}}]:[],nextCursor:null}});
 if(p.method==='turn/start'){record.prompted=true;record.contextRead=fs.readFileSync('review-context.json','utf8').includes('snapshot');save();send({id:p.id,result:{turn:{id:'turn'}}});send({id:'evidence-probe',method:'item/tool/call',params:{tool:'read_review_evidence',arguments:{}}});}
 if(p.method==='session/new'){record.permissions=JSON.parse(fs.readFileSync('.cursor/cli.json','utf8'));save();send({id:p.id,result:{sessionId:'cursor-session',modes:{currentModeId:'agent',availableModes:scenario==='writable'?[{id:'agent'}]:[{id:'agent'},{id:'ask'}]},models:{currentModelId:'actual-cursor'}}});}
 if(p.method==='session/set_mode'){send({method:'session/update',params:{sessionId:'cursor-session',update:{sessionUpdate:'current_mode_update',currentModeId:'ask'}}});send({id:p.id,result:{}});}
 if(p.method==='session/prompt'){record.prompted=true;pendingId=p.id;save();probe();}
 });
}
setInterval(()=>{},1000);
`;

async function fixture(harness: Harness, scenario = "safe") {
  const root = await mkdtemp(join(tmpdir(), "memcode-readonly-review-"));
  const script = join(root, "provider.mjs"),
    record = join(root, "record.json"),
    profile = join(root, "profile");
  await writeFile(script, fixtureScript);
  const state = initialState();
  state.settings.workerPermissionDefaults = {
    codex: "full-access",
    claude: "full-access",
    cursor: "full-access",
  };
  state.workerConnections = {
    [harness]: {
      harness,
      scopeVersion: 1,
      approvedAt: new Date().toISOString(),
      runtimePath: process.execPath,
      runtimeIdentity: script,
      auth: "authenticated",
    },
  };
  const task = {
    id: "t",
    harness,
    modelOverride: "requested-model",
    run: { state: "finished" },
  } as WorkItem;
  const review = {
    id: "review",
    taskId: "t",
    snapshot: { id: "snapshot", files: [] },
    findings: [],
    metrics: [],
    messages: [],
    coverage: { complete: false, limitations: [] },
  } as unknown as StoryReviewRun;
  const agent = createReadonlyReviewAgent(profile, () => state, {
    timeoutMs: 10000,
    commandFor: async () => ({
      command: process.execPath,
      prefix: [script, harness, scenario, record],
      identity: script,
    }),
  });
  return {
    root,
    profile,
    state,
    agent,
    task,
    review,
    record: async () => JSON.parse(await readFile(record, "utf8")),
    close: () => rm(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}

test("Codex review requires a native readOnly handshake and denies file-change approval", async () => {
  const f = await fixture("codex");
  try {
    const result = await f.agent.ask({
      task: f.task,
      review: f.review,
      question: "Explain",
    });
    assert.equal(result.model, "actual-codex");
    const record = await f.record();
    assert.equal(record.contextRead, true);
    assert.equal(
      record.requests.find((p: any) => p.method === "thread/start").params
        .sandbox,
      "read-only",
    );
    assert.equal(
      record.replies.find((p: any) => p.id === "write-probe").result.decision,
      "decline",
    );
    assert.equal(
      (await readdir(join(f.profile, "code-reviews", "agent-context"))).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("writable or externally connected Codex is rejected before any review prompt", async () => {
  for (const scenario of ["writable", "mcp"]) {
    const f = await fixture("codex", scenario);
    try {
      await assert.rejects(
        f.agent.ask({ task: f.task, review: f.review, question: "Explain" }),
        /read-only|empty external/,
      );
      assert.equal((await f.record()).prompted, false);
    } finally {
      await f.close();
    }
  }
});

test("Cursor verifies acknowledged Ask mode, allows confined reads and rejects write, terminal and permission requests", async () => {
  const f = await fixture("cursor");
  try {
    const result = await f.agent.ask({
      task: f.task,
      review: f.review,
      question: "Explain",
    });
    assert.equal(result.model, "actual-cursor");
    const record = await f.record();
    assert.equal(
      record.requests.find((p: any) => p.method === "session/set_mode").params
        .modeId,
      "ask",
    );
    assert.match(record.replies[0].result.content, /snapshot/);
    assert.equal(record.replies[1].error.code, -32601);
    assert.equal(record.replies[2].error.code, -32601);
    assert.equal(record.replies[3].result.outcome.outcome, "cancelled");
    assert.deepEqual(record.args.slice(0, 4), [
      "--mode",
      "ask",
      "--sandbox",
      "enabled",
    ]);
    assert.deepEqual(record.permissions.permissions.deny, [
      "Shell(*)",
      "Write(**)",
      "Mcp(*:*)",
      "WebFetch(*)",
    ]);
  } finally {
    await f.close();
  }
});

test("Cursor lacking read-only Ask capability is explicit unavailable before prompting", async () => {
  const f = await fixture("cursor", "writable");
  try {
    await assert.rejects(
      f.agent.ask({ task: f.task, review: f.review, question: "Explain" }),
      /does not advertise/,
    );
    assert.equal((await f.record()).prompted, false);
  } finally {
    await f.close();
  }
});

test("Claude read-only tools and strict empty MCP override writable worker defaults", async () => {
  const f = await fixture("claude");
  try {
    const result = await f.agent.ask({
      task: f.task,
      review: f.review,
      question: "Explain",
    });
    assert.equal(result.model, "actual-claude");
    const record = await f.record();
    const value = (name: string) => record.args[record.args.indexOf(name) + 1];
    assert.equal(value("--tools"), "Read,Glob,Grep");
    assert.equal(value("--permission-mode"), "dontAsk");
    assert.ok(record.args.includes("--restricted"));
    assert.ok(record.args.includes("--strict-mcp-config"));
    assert.equal(value("--setting-sources"), "");
    assert.equal(value("--mcp-config"), '{"mcpServers":{}}');
  } finally {
    await f.close();
  }
});

test("Claude rejects a writable acknowledged tool catalog", async () => {
  const f = await fixture("claude", "writable");
  try {
    await assert.rejects(
      f.agent.ask({ task: f.task, review: f.review, question: "Explain" }),
      /read-only tool catalog/,
    );
  } finally {
    await f.close();
  }
});

test("review context file reads reject paths outside the capsule", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-read-review-"));
  try {
    const capsule = join(root, "capsule");
    await mkdir(capsule);
    await writeFile(join(capsule, "context.json"), "safe");
    await writeFile(join(root, "other.txt"), "not shared");
    assert.equal(await readReviewFile(capsule, "context.json"), "safe");
    await assert.rejects(
      readReviewFile(capsule, "../other.txt"),
      /bounded evidence/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review cleanup terminates the exact Node launcher and its long-running grandchild", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-review-tree-"));
  const pidPath = join(root, "grandchild.json");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process');const fs=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],JSON.stringify({pid:p.pid}));setInterval(()=>{},1000);`,
      pidPath,
    ],
    {
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: "pipe",
    },
  ) as ChildProcessWithoutNullStreams;
  try {
    const deadline = Date.now() + 5000;
    let descendant = 0;
    while (Date.now() < deadline) {
      try {
        descendant = JSON.parse(await readFile(pidPath, "utf8")).pid;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(descendant > 0);
    await stopReviewProcess(child);
    let alive = true;
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(descendant, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      alive,
      false,
      "review grandchild must not outlive its capsule cleanup",
    );
  } finally {
    await stopReviewProcess(child);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
