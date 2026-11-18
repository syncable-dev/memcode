// Synthetic renderer fixture. Real App/guide/worker consent UI and onboarding
// route validation; no accounts, source files, worker processes or relay access.
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  output = join(root, ".memcode/verification/project-onboarding");
await mkdir(output, { recursive: true });
await build({
  plugins: [
    {
      name: "unused-vite-url-assets",
      setup(build) {
        build.onResolve({ filter: /\?url$/ }, (args) => ({
          path: args.path,
          namespace: "fixture-unused-url",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture-unused-url" }, () => ({
          contents: 'export default "/unused-artifact-worker.mjs";',
          loader: "js",
        }));
      },
    },
  ],
  stdin: {
    loader: "tsx",
    resolveDir: root,
    sourcefile: "project-onboarding-fixture.tsx",
    contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {App} from './src/App';import {initialState} from './src/seed';
import {beginProjectGuide,activateProjectGuide} from './src/onboarding';
import {initializeCodeReviewWorkflow} from './src/code-review-workflow';
import {registerOnboarding} from './runtime/onboarding';
import '@fontsource-variable/inter';import './src/styles.css';
const at='2026-11-16T10:00:00.000Z';let saved=localStorage.getItem('project-guide-fixture');
const state=saved?JSON.parse(saved):initialState();
if(!saved){
const template=structuredClone(state.tasks[0]);
const local=(id,name,path)=>({id,name,path,description:'A thoughtful, accessible documentation experience.',branch:'main',analysis:'ready',createdAt:at});
state.projects.push(local('fresh','Lumen','/synthetic/lumen'),local('existing','Existing project','/synthetic/existing'),local('joined','Shared observatory',null));
state.tasks.push({...template,id:'user-story',identifier:'MC-101',projectId:'existing',title:'Existing user-authored work',example:false,run:{state:'idle'}},{...template,id:'shared-story',identifier:'MC-201',projectId:'joined',title:'Imported teammate story',example:false,run:{state:'idle'}});
state.activeProjectId='fresh';state.epics=[];state.cycles=[];state.workerConnections={};
initializeCodeReviewWorkflow(state,'fresh');
state.team=[{projectId:'joined',teamId:'fixture-team',memberId:'fixture-member',deviceId:'fixture-device',connection:'online',pendingCount:0,unreadCount:0,workspace:{workspaceId:'fixture-workspace',name:'Shared observatory',head:1,members:[],stories:[],epics:[],cycles:[],comments:[],claims:[],results:[],activity:[]}}];
beginProjectGuide(state,state.projects.find(p=>p.id==='fresh'));
}
const listeners=new Set(),calls=[];window.fixtureCalls=calls;
const runtime={appVersion:'Synthetic onboarding fixture',memtraceAvailable:true,dataPath:'Synthetic fixture · no local access',harnesses:['codex','claude','cursor'].map(id=>({id,name:{codex:'Codex',claude:'Claude Code',cursor:'Cursor'}[id],available:true,path:'/synthetic/'+id,models:[]}))};
const emit=async()=>{localStorage.setItem('project-guide-fixture',JSON.stringify(state));for(const fn of listeners)fn(structuredClone(state));};
const routes=new Map();registerOnboarding((name,schema,handle)=>routes.set(name,{schema,handle}),()=>state,emit);
let claudeSignedIn=false,cursorAgentInstalled=false;
const status=()=>runtime.harnesses.map(h=>({
  harness:h.id,installed:h.id!=='cursor'||cursorAgentInstalled,
  connected:!!state.workerConnections[h.id]&&(h.id!=='claude'||claudeSignedIn),
  runtimePath:h.path,auth:h.id==='claude'&&!claudeSignedIn?'not-authenticated':'authenticated',
  desktopAppPath:h.id==='cursor'?'/synthetic/Cursor.app':undefined,
  note:'Synthetic connection fixture; no installed tool is accessed.',
  loginCommand:h.id==='claude'?'claude auth login':'agent login'
}));
const beta={state:'connected',accessMode:'beta',detail:'Synthetic fixture; no real account.',loginPending:false,account:{id:'synthetic-account',name:'Example account'}};
const methods={
load:async()=>({state:structuredClone(state),runtime}),onState:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},onRuntimeHealth:()=>()=>{},onBetaStatus:()=>()=>{},betaStatus:async()=>beta,resumeBeta:async()=>beta,
accountStatus:async()=>({status:'connected',label:'Example connection',detail:'Synthetic fixture only.',loginPending:false}),
updateOnboarding:async input=>{const route=routes.get('onboarding:update');return route.handle(route.schema.parse(input));},
selectProject:async id=>{state.activeProjectId=id;activateProjectGuide(state,id);await emit();},
selectFolder:async()=>'/synthetic/selected-folder',
createProject:async input=>{calls.push('create-project');const project={id:crypto.randomUUID(),name:input.name,description:input.description,path:'/synthetic/'+input.name.toLowerCase().replaceAll(' ','-'),branch:'main',analysis:'ready',createdAt:at};state.projects.push(project);state.activeProjectId=project.id;beginProjectGuide(state,project);await emit();return project;},
analyzeProject:async id=>{calls.push('analyze-fixture');state.projects.find(p=>p.id===id).analysis='ready';await emit();},
workerConnectionStatus:async()=>status(),connectWorker:async(harness,approved)=>{if(approved!==true)throw Error('Explicit approval required');calls.push('approve-worker');state.workerConnections[harness]={harness,approvedAt:at,runtimePath:'/synthetic/'+harness,auth:'authenticated',scopeVersion:1};await emit();return status().find(s=>s.harness===harness)},
refreshWorkerCatalog:async()=>runtime,openWorkerTerminal:async()=>{calls.push('open-worker-terminal')},
setWorkerPermissionDefault:async()=>{},speechStatus:async()=>({state:'unavailable',detail:'Synthetic fixture; no microphone.'}),
teamsList:async()=>({teams:[],configured:false,canCreate:false,identityAvailable:false}),
windowAction:async()=>{},createEpic:async input=>{calls.push('create-epic');const epic={...input,id:crypto.randomUUID(),identifier:'EP-01',order:0,color:'mint'};state.epics.push(epic);await emit();return epic;},
saveSettings:async()=>runtime,
createTask:async input=>{const story={...structuredClone(state.tasks[0]),...input,id:'guided-story',identifier:'MC-102',stage:'planned',statusId:'fresh:planned',messages:[],runbook:[],run:{state:'idle'},example:false};state.tasks.push(story);await emit();return story;},
};
window.memcode=new Proxy(methods,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>null});
window.fixture={snapshot:()=>structuredClone(state),select:methods.selectProject,signInClaude:()=>{claudeSignedIn=true},installCursorAgent:()=>{cursorAgentInstalled=true}};
createRoot(document.getElementById('root')).render(<><App/><div style={{position:'fixed',bottom:3,left:220,fontSize:9,color:'#7c8f80',zIndex:200,pointerEvents:'none'}}>Synthetic onboarding fixture · no real accounts or workers</div></>);
`,
  },
  absWorkingDir: root,
  bundle: true,
  outdir: output,
  entryNames: "fixture",
  format: "esm",
  jsx: "automatic",
  define: { "import.meta.env.DEV": "false" },
  loader: { ".woff2": "file", ".woff": "file" },
});
await writeFile(
  join(output, "index.html"),
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const file =
      path.startsWith("/adapters/") || path.startsWith("/guide/")
        ? join(root, "public", path)
        : join(output, basename(path) || "index.html");
    const mime = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
    };
    res.setHeader("content-type", mime[extname(file)] ?? "text/html");
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}`,
  checks = [],
  errors = [];
let browser, page;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.MEMCODE_BROWSER_EXECUTABLE
      ? { executablePath: process.env.MEMCODE_BROWSER_EXECUTABLE }
      : process.platform === "win32"
        ? { channel: "msedge" }
        : {}),
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(url);
  const snapshot = () => page.evaluate(() => window.fixture.snapshot());
  const counts = async (id) => {
    const s = await snapshot();
    return {
      stories: s.tasks.filter((t) => t.projectId === id).length,
      epics: s.epics.filter((e) => e.projectId === id).length,
      cycles: s.cycles.filter((c) => c.projectId === id).length,
    };
  };
  await expect(
    page.getByRole("dialog", { name: "Set up Lumen." }),
  ).toBeVisible();
  assert.deepEqual(await counts("fresh"), { stories: 0, epics: 0, cycles: 0 });
  await page.screenshot({ path: join(output, "project-welcome.png") });
  checks.push("New project starts with its own guide and no starter work");
  await page
    .getByRole("button", { name: "Connect code context", exact: true })
    .click();
  const guide = page.getByRole("complementary", {
    name: "Getting started guide",
  });
  await expect(guide).toContainText("Code context connected");
  await guide
    .getByRole("button", { name: "Choose a worker", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Connect Codex", exact: true })
    .click();
  const consent = page.getByRole("dialog", { name: "Connect Codex." });
  await expect(consent).toBeVisible();
  await expect(
    consent.getByRole("button", { name: "Approve & connect" }),
  ).toBeDisabled();
  assert.equal(
    await page.evaluate(() => window.fixtureCalls.includes("approve-worker")),
    false,
  );
  await page.screenshot({ path: join(output, "worker-approval.png") });
  await consent.getByRole("checkbox").check();
  await consent.getByRole("button", { name: "Approve & connect" }).click();
  await expect(guide).toContainText("What would you like to build?");
  checks.push("Worker connection still requires the real explicit approval UI");
  await guide
    .getByRole("button", { name: "Finish setup · add work later", exact: true })
    .click();
  await expect(guide).toHaveCount(0);
  assert.deepEqual(await counts("fresh"), { stories: 0, epics: 0, cycles: 0 });
  checks.push("Setup can complete without creating an epic, story or cycle");
  await page.getByRole("button", { name: "Workers", exact: true }).click();
  const cursor = page.locator('[data-harness="cursor"]');
  await expect(cursor).toContainText("Desktop app installed");
  await expect(
    cursor.getByRole("button", { name: "Install Cursor Agent CLI" }),
  ).toBeVisible();
  await page.evaluate(() => window.fixture.installCursorAgent());
  await page
    .getByRole("button", { name: "Refresh worker connections" })
    .click();
  await expect(
    cursor.getByRole("button", { name: "Connect Cursor" }),
  ).toBeVisible();
  checks.push(
    "Cursor's desktop app and its separate agent CLI are shown distinctly",
  );

  await page
    .getByRole("button", { name: "Connect Claude Code", exact: true })
    .click();
  const claude = page.getByRole("dialog", { name: "Connect Claude Code." });
  await expect(claude).toContainText("claude auth login");
  await expect(
    claude.getByRole("button", { name: "Approve & connect" }),
  ).toHaveCount(0);
  if (process.platform === "darwin") {
    await claude.getByRole("button", { name: "Open Terminal" }).click();
    assert.equal(
      await page.evaluate(() =>
        window.fixtureCalls.includes("open-worker-terminal"),
      ),
      true,
    );
  }
  await claude.getByRole("button", { name: "Check sign-in" }).click();
  await expect(claude.getByRole("alert")).toContainText(
    "You’re still signed out",
  );
  assert.equal((await snapshot()).workerConnections.claude, undefined);
  await page.evaluate(() => window.fixture.signInClaude());
  await claude.getByRole("button", { name: "Check sign-in" }).click();
  await expect(
    claude.getByRole("button", { name: "Approve & connect" }),
  ).toBeDisabled();
  await expect(claude.getByRole("checkbox")).toBeFocused();
  await claude.getByRole("checkbox").check();
  await claude.getByRole("button", { name: "Approve & connect" }).click();
  await expect(claude).toHaveCount(0);
  await expect(page.locator('[data-harness="claude"]')).toContainText(
    "Connected",
  );
  checks.push(
    "Claude sign-in can be rechecked in place and still requires approval",
  );

  await page.getByRole("button", { name: "Docs", exact: true }).click();
  const flow = page.getByRole("navigation", {
    name: "From project to code review",
  });
  await expect(flow.getByRole("listitem")).toHaveCount(5);
  const dismissNotice = page.getByRole("button", { name: "Dismiss notification" });
  if (await dismissNotice.isVisible()) await dismissNotice.click();
  await page.screenshot({ path: join(output, "quick-start-flow.png") });
  await page.setViewportSize({ width: 760, height: 860 });
  assert.equal(
    await flow.evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  await flow.getByRole("button", { name: /Code review/ }).click();
  await expect(page.locator(".docs-article > h2")).toHaveText("Code review");
  await page
    .getByRole("button", { name: "Your first project", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const watchTour = page.getByRole("button", { name: "Watch product tour" });
  const tour = page.getByRole("dialog", { name: "MemCode product tour" });
  const beforeTour = await snapshot();
  await watchTour.click();
  await expect(tour).toBeVisible();
  await tour
    .getByRole("button", { name: "Show review a change preview" })
    .click();
  await expect(
    tour.getByRole("heading", { name: "Decide what’s ready to ship." }),
  ).toBeVisible();
  await tour.getByRole("button", { name: "Back to Docs" }).click();
  await expect(tour).toHaveCount(0);
  await expect(watchTour).toBeFocused();
  assert.deepEqual(await snapshot(), beforeTour);
  await watchTour.click();
  await tour.getByRole("button", { name: "Open guided setup" }).click();
  await expect(
    page.getByRole("dialog", { name: "Set up Lumen." }),
  ).toBeVisible();
  checks.push(
    "Docs replays the welcome and review slides without editing progress; guided setup returns to the selected project",
  );
  await page
    .getByRole("checkbox", {
      name: "Don’t open this guide automatically for new projects.",
    })
    .check();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await page.locator('[data-guide="project-picker"]').click();
  await page
    .getByRole("button", { name: "Add a project", exact: true })
    .click();
  const create = page.getByRole("dialog", {
    name: "A place for what comes next.",
  });
  await expect(create).toBeVisible();
  await create
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("Nova");
  await create
    .getByRole("textbox", { name: "Project purpose", exact: true })
    .fill("A small, accessible notes application.");
  await create.getByRole("button", { name: /Something new/ }).click();
  await create.locator(".folder-select").click();
  await create
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("Nova");
  await create
    .getByRole("textbox", { name: "Project purpose", exact: true })
    .fill("A small, accessible notes application.");
  await page.screenshot({ path: join(output, "new-project-dialog.png") });
  await create
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(create).toHaveCount(0);
  let current = await snapshot();
  const nova = current.projects.find((p) => p.name === "Nova");
  assert.ok(nova);
  assert.equal(current.projectOnboarding[nova.id].dismissed, true);
  assert.deepEqual(await counts(nova.id), { stories: 0, epics: 0, cycles: 0 });
  checks.push(
    "Explicit future-project preference suppresses automatic guide and creates no work",
  );
  await page.getByRole("button", { name: "Docs", exact: true }).click();
  await page
    .getByRole("button", { name: "Guide me through", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Set up Nova." }),
  ).toBeVisible();
  await page.screenshot({ path: join(output, "reopened-project.png") });
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Set up Nova." })).toHaveCount(
    0,
  );
  current = await snapshot();
  assert.equal(current.onboardingPreferences.showForNewProjects, false);
  assert.equal(current.projectOnboarding[nova.id].dismissed, true);
  checks.push(
    "Manual reopen works; skip/progress/future preference survive a renderer restart",
  );
  await page.evaluate(() => window.fixture.select("existing"));
  await expect(page.getByRole("dialog", { name: /Set up/ })).toHaveCount(0);
  assert.equal((await counts("existing")).stories, 1);
  await page.evaluate(() => window.fixture.select("joined"));
  await expect(page.getByRole("dialog", { name: /Set up/ })).toHaveCount(0);
  assert.equal((await counts("joined")).stories, 1);
  await page.getByRole("button", { name: "Docs", exact: true }).click();
  await page
    .getByRole("button", { name: "Guide me through", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Set up Shared observatory." }),
  ).toContainText("Your team’s current board is already here.");
  await page.screenshot({ path: join(output, "joined-project.png") });
  checks.push(
    "Existing and imported boards remain intact without surprise onboarding; joined setup is local and optional",
  );
  await page.setViewportSize({ width: 760, height: 860 });
  await page.screenshot({ path: join(output, "narrow-project.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  checks.push(
    "Reduced-motion/narrow layout renders without page errors or horizontal overflow",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => {
    await window.fixture.select("fresh");
    await window.memcode.updateOnboarding({
      projectId: "fresh",
      restart: true,
      step: "story",
    });
  });
  await guide
    .getByRole("button", { name: "Write a story", exact: true })
    .click();
  const storyDialog = page.getByRole("dialog", {
    name: "Give the next idea a place.",
  });
  await storyDialog
    .getByLabel("Work item title")
    .fill("Explain the first saved change");
  await storyDialog.getByRole("button", { name: "Create work item" }).click();
  const storyTour = page.getByRole("region", {
    name: "Story guide",
    exact: true,
  });
  await expect(storyTour).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Story tabs" });
  await tabs.getByRole("button", { name: "Code review" }).click();
  await expect(storyTour).toContainText("finding");
  await storyTour
    .getByRole("button", { name: "Skip tour", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close work item", exact: true })
    .click();
  await expect(guide).toContainText("Review what changed.");
  await guide
    .getByRole("button", { name: "Show Code review on my story" })
    .click();
  await expect(
    tabs.getByRole("button", { name: "Code review" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(storyTour).toHaveCount(0);
  await page
    .getByRole("button", { name: "Close work item", exact: true })
    .click();
  await guide
    .getByRole("button", { name: "Open the illustrated guide" })
    .click();
  const article = page.locator(".docs-article");
  await expect(
    article.getByRole("heading", { name: /code review/i }).first(),
  ).toBeVisible();
  await expect(guide).toHaveCount(0);
  const finalState = await snapshot();
  const story = finalState.tasks.find((task) => task.id === "guided-story");
  assert.equal(story.statusId, "fresh:planned");
  assert.equal(story.run.state, "idle");
  assert.equal(finalState.projectOnboarding.fresh.step, "code-review");
  assert.deepEqual(errors, []);
  checks.push(
    "Creating the first story opens its tab tour; the final guide links to that story’s review and the illustrated Docs without moving or starting work",
  );
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        fixture:
          "Synthetic renderer only; real App, onboarding route and worker approval UI",
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      checks: checks.length,
      errors: errors.length,
      output,
    }),
  );
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify({ error: String(error), errors, checks }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
