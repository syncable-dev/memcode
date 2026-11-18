// Synthetic renderer fixture only. No user project, provider login or relay is used.
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".memcode", "verification", "team-onboarding");
await mkdir(output, { recursive: true });
// Exercise the real diagnostic whitelist/redaction before crossing the mocked
// renderer boundary. Raw fixture credentials/source never enter window.memcode.
await build({
  entryPoints: [join(root, "runtime/local-analysis.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(output, "diagnostics-fixture.cjs"),
});
const { localAnalysisDiagnostics } = createRequire(import.meta.url)(
  join(output, "diagnostics-fixture.cjs"),
);
const diagnosticReports = {};
for (const variant of [
  "blocked",
  "aligned",
  "mismatch",
  "unstable",
  "unknown",
  "replaying",
]) {
  const project = {
    id: "personal",
    name: "Personal Observatory",
    description: "Synthetic diagnostics",
    path: "C:/Synthetic/observatory",
    branch: "main",
    analysis: "error",
    repoId: "fixture",
    analysisNote: "Source index could not be qualified",
    createdAt: "2026-11-16",
  };
  const rawPrivate = {
    api_key: "SYNTHETIC_RAW_AUTH_SECRET",
    source_code: "SOURCE_CODE_MUST_NOT_LEAVE_ENGINE",
  };
  diagnosticReports[variant] = await localAnalysisDiagnostics(
    project,
    {
      call: async (_project, name) => {
        if (
          variant === "unknown" &&
          ["list_watched_paths", "list_jobs"].includes(name)
        )
          throw Error(
            "Authorization: Bearer SYNTHETIC_RAW_AUTH_SECRET; api_key=SYNTHETIC_RAW_AUTH_SECRET",
          );
        if (name === "list_indexed_repositories")
          return {
            repositories: [
              {
                repo_id: "fixture",
                repo_path: project.path,
                branch: "main",
                index_state: "stale",
                ...rawPrivate,
              },
            ],
          };
        if (name === "list_watched_paths")
          return {
            watches:
              variant === "aligned"
                ? [
                    {
                      path: project.path,
                      repo_id: "fixture",
                      branch: "main",
                      origin: "memcode",
                      ...rawPrivate,
                    },
                  ]
                : [],
          };
        if (name === "list_jobs")
          return {
            jobs:
              variant === "aligned"
                ? []
                : [
                    {
                      id: "synthetic-peer-job",
                      repo_id: "fixture",
                      status: "running",
                      stage: "parse",
                      message: "Parsing source files",
                      progress: { completed: 2, total: 8, unit: "files" },
                      runtime_context: {
                        requested_path: project.path,
                        store_path:
                          "C:/Synthetic/observatory/.memcode/memtrace/.memdb",
                        ...rawPrivate,
                      },
                      ...rawPrivate,
                    },
                  ],
          };
        if (name === "get_query_revision")
          return {
            repo_id: "fixture",
            ready: ["aligned", "mismatch", "unstable"].includes(variant),
            worktree: project.path,
            status: variant === "aligned" ? "complete" : "partial",
            publication: { status: "published" },
            _meta: {
              graph_revision: { publication_unchanged_during_call: true },
            },
            source_unchanged_during_observation: true,
            requested_source_matches: true,
            requested_revision_matches: true,
            branch: variant === "mismatch" ? "epic/different" : "main",
            source_revision: "synthetic-source-revision",
            mismatched_files: variant === "aligned" ? 0 : 2,
            reason:
              variant === "replaying"
                ? "branch_publication_incomplete"
                : variant === "blocked" || variant === "unknown"
                  ? "source_index_not_qualified"
                  : undefined,
            ...(variant === "unstable"
              ? {
                  retry_query_group: true,
                  _meta: {
                    graph_revision: {
                      token: "synthetic-publication",
                      publication_unchanged_during_call: false,
                    },
                  },
                }
              : {}),
            ...rawPrivate,
          };
        throw Error("Unexpected diagnostic operation " + name);
      },
      scopeFor: () => ({
        mode: "project",
        dataDirectory: "C:/Synthetic/observatory/.memcode/memtrace/.memdb",
      }),
      bindingStillCurrent: () => () => true,
      certificateDiagnosticsFor: () => [
        "full owned source could not qualify its independently verified input certificate",
      ],
    },
    { timeoutMs: 1000 },
  );
}
await build({
  stdin: {
    loader: "tsx",
    resolveDir: root,
    sourcefile: "team-onboarding-fixture.tsx",
    contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TeamOnboarding} from './src/components/TeamOnboarding';
import {LocalProjectSetup} from './src/components/LocalProjectSetup';
import {InsightsPage} from './src/components/InsightsPage';
import {Improve} from './src/components/Improve';
import {initialState} from './src/seed';
import './src/styles.css';import './src/styles-team.css';import './src/styles-collaboration.css';
import './src/styles-intelligence.css';
const mode=new URLSearchParams(location.search).get('mode')??'owner';
const repository={url:'https://github.com/synthetic-fixture/observatory.git',identity:'github.com/synthetic-fixture/observatory',provider:'github',name:'observatory'};
const personal={id:'personal',name:'Personal Observatory',description:'Synthetic fixture',path:'C:/Synthetic/observatory',branch:'main',analysis:'ready',createdAt:'2026-11-15',example:false};
const shared={...personal,id:'shared',name:'Shared Observatory',path:null,analysis:'idle'};
if(mode==='diagnostics'){personal.analysis='error';personal.analysisNote='Source index could not be qualified';shared.path='C:/Synthetic/second-observatory';shared.analysis='ready';}
const member={id:'synthetic-owner',name:'Robin Example',email:'owner@example.invalid',role:'owner',status:'active',devices:[{id:'fixture-pc',name:'Synthetic PC'}],joinedAt:'2026-11-15'};
const team={id:'synthetic-team',name:'Observatory Team',role:'owner',identity:'memtrace',members:[member],projects:[],createdAt:'2026-11-15',revision:1,connection:'online'};
let directory={configured:true,identityAvailable:true,teams:mode==='owner'?[]:[{...team,role:'member',projects:[{workspaceId:'synthetic-room',name:shared.name,repository,localProjectId:'shared',createdAt:'2026-11-15'}]}]};
let source=initialState();source.projects=[personal];source.tasks=[{...source.tasks[0],id:'personal-story',projectId:'personal',example:false,title:'Personal story stays intact'}];source.epics=[{...source.epics[0],projectId:'personal'}];source.team=[];
if(mode!=='owner'){source.projects.push(shared);source.tasks.push({...source.tasks[0],id:'shared-story',projectId:'shared',title:'Existing shared story from the team'});}
window.calls=[];window.sharedState=source;window.clipboard='';window.progress=null;window.providerSignedIn=false;
window.diagnosticReports=${JSON.stringify(diagnosticReports)};window.diagnosticVariant='blocked';window.holdDiagnostics=false;
Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text)=>{window.clipboard=text;window.calls.push(['clipboard',text]);}},configurable:true});
const inspection=(path)=>({path,repositoryRoot:path,branch:'epic/observatory',revision:'abcdef0123456789',dirty:true,repository,remotes:[{name:'origin',repository}]});
let update=()=>{};const publish=()=>{source={...source,projects:[...source.projects]};window.sharedState=source;update(source);};
let auth={state:'idle',message:'Not started'};
window.memcode={
 teamsList:async()=>structuredClone(directory),
 inspectProjectRepository:async(id)=>{window.calls.push(['inspect',id]);return inspection(source.projects.find(p=>p.id===id).path)},
 createTeamWorkspace:async(input)=>{window.calls.push(['create-team',input]);const created={...team,name:input.name};directory.teams.push(created);return structuredClone(created)},
 shareTeamProject:async(input)=>{window.calls.push(['share',input]);directory.teams[0].projects.push({workspaceId:'synthetic-room',name:personal.name,localProjectId:'personal',repository:input.repository,createdAt:'2026-11-15'});return {projectId:'personal'}},
 inviteTeamMember:async(input)=>{window.calls.push(['invite',input]);return {url:'https://relay.example.invalid/#synthetic-invitation-only',expiresAt:'2026-11-22'}},
 previewTeamInvitation:async(input)=>{window.calls.push(['preview',input]);return {teamName:'Observatory Team',projectName:shared.name,repository,invitedEmail:'teammate@example.invalid',expiresAt:'2026-11-22',identity:'memtrace'}},
 acceptTeamInvitation:async(input)=>{window.calls.push(['accept',input]);if(!source.projects.some(p=>p.id==='shared')){source.projects.push(shared);source.tasks.push({...source.tasks[0],id:'shared-story',projectId:'shared',title:'Existing shared story from the team'});}directory.teams=[{...team,role:'member',projects:[{workspaceId:'synthetic-room',name:shared.name,repository,localProjectId:'shared',createdAt:'2026-11-15'}]}];publish();return {team:directory.teams[0],project:{projectId:'shared'}}},
 selectProject:async(id)=>{window.calls.push(['select-project',id]);window.selectProject(id)},
 openTeamProject:async()=>({projectId:'shared'}),
 findProjectCheckouts:async()=>mode==='reuse'?[inspection('C:/Synthetic/existing-observatory')]:[],
 selectFolder:async()=>{window.calls.push(['folder-picker']);return mode==='wrong'?'C:/Synthetic/unrelated-repo':'C:/Synthetic/projects'},
 bindProjectFolder:async(id,path)=>{window.calls.push(['bind',id,path]);if(mode==='wrong')throw Error('This folder belongs to a different repository. Choose the project’s existing checkout, or clone its repository.');const value=source.projects.find(p=>p.id===id);Object.assign(value,{path,branch:'epic/observatory',analysis:'ready'});publish();return {...value}},
 repositoryAccess:async(repo)=>{window.calls.push(['access',repo.identity]);return {repository:repo,state:window.providerSignedIn?'ready':'needs-sign-in',method:window.providerSignedIn?'github-cli':'git',accountLabel:window.providerSignedIn?'synthetic-teammate':undefined,message:window.providerSignedIn?'Repository read access is ready as synthetic-teammate.':'Git access needs an account with repository access.'}},
 githubRepositorySignIn:async(action)=>{window.calls.push(['github',action]);if(action==='start')auth={state:'waiting',message:'Use the official browser sign-in.',verificationUrl:'https://github.com/login/device',userCode:'TEST-1234'};if(action==='cancel')auth={state:'cancelled',message:'Sign-in cancelled'};return window.providerSignedIn?{state:'signed-in',message:'GitHub connected'}:auth},
 cloneProjectRepository:async(input)=>{window.calls.push(['clone',input]);window.progress={phase:'cloning',message:'Receiving repository files…'};return await new Promise((resolve,reject)=>{window.finishClone=()=>{const value=source.projects.find(p=>p.id===input.projectId);Object.assign(value,{path:input.parent+'/'+input.name,analysis:'ready'});window.progress={phase:'ready',message:'Local repository ready.'};publish();resolve({...value})};window.rejectClone=reject;})},
 repositorySetupStatus:async()=>{window.calls.push(['setup-status',window.progress?.phase]);return window.progress},
 cancelRepositorySetup:async(id)=>{window.calls.push(['cancel-clone',id]);window.progress={phase:'cancelled',message:'Clone cancelled. Its partial folder was preserved.'};window.rejectClone?.(Error('Repository setup was cancelled. The partial folder is preserved.'));},
 analyzeProject:async(id)=>{window.calls.push(['analyze',id]);source.projects.find(p=>p.id===id).analysis='ready';publish()},
 startWorker:async()=>{window.calls.push(['UNEXPECTED-WORKER-START'])},
 teamStatus:async()=>null,
 localAnalysisDiagnostics:async(id)=>{window.calls.push(['diagnostics',id]);const value=structuredClone(window.diagnosticReports[window.diagnosticVariant]);const project=source.projects.find(p=>p.id===id);value.project={...value.project,name:project.name,path:project.path,branch:project.branch};if(window.holdDiagnostics)return await new Promise(resolve=>{window.releaseDiagnostics=()=>resolve(value)});if(value.sourcePublication==='verified' && project.analysis==='error' && project.analysisNote==='owned source changed after verification; refusing publication') window.setLocalAnalysis('ready','Verified on this checkout.');return value;},
};
function Fixture(){const[state,setState]=useState(source),[selected,setSelected]=useState(mode==='owner'||mode==='diagnostics'?'personal':'shared');update=setState;window.selectProject=setSelected;const project=state.projects.find(p=>p.id===selected);window.setLocalAnalysis=(analysis,note)=>{Object.assign(project,{analysis,analysisNote:note});publish();};window.changeLocalPath=(path)=>{project.path=path;publish();};return <main style={{maxWidth:1170,padding:30,margin:'0 auto'}}><div style={{fontSize:10,color:'#87968c',marginBottom:20,letterSpacing:1}}>SYNTHETIC ONBOARDING FIXTURE · NO LIVE ACCOUNTS</div>{mode==='diagnostics'?<LocalProjectSetup project={project} repository={repository} notify={text=>window.calls.push(['notify',text])} onWorkers={()=>window.calls.push(['workers-page'])}/>:<TeamOnboarding state={state} project={project} notify={text=>window.calls.push(['notify',text])} open={()=>{}} openArtifact={()=>{}} onWorkers={()=>window.calls.push(['workers-page'])}/>}<aside data-testid="current-project" style={{fontSize:11,color:'#7e9183',padding:'20px 0',borderTop:'1px solid #dfe7dd'}}>Current project: {project.name}<div>{state.tasks.filter(t=>t.projectId===selected).map(t=><p key={t.id}>{t.title}</p>)}</div></aside></main>};
function QualityFixture() {
  const [view, setView] = useState('team');
  const [branch, setBranch] = useState('main');
  const project = {...personal, branch, repoId:'fixture'};
  const state = {...source, projects:[project], qualitySnapshots:JSON.parse(sessionStorage.getItem('quality-history') || '[]')};
  const notify = text => window.calls.push(['notify', text]);
  window.changeBranch = setBranch;
  window.diagnosticVariant = 'aligned';
  window.memcode.refreshIntelligence = async (projectId, refreshIndex) => {
    window.calls.push(['report', projectId, branch, refreshIndex]);
    await new Promise((resolve, reject) => {
      window.resolveReport = resolve;
      window.rejectReport = () => reject(Error('Fixture report timed out.'));
    });
    const result = {
      id:crypto.randomUUID(), projectId, repoId:'fixture', branch, basis:'memtrace-ast-distribution-v1', status:'current',
      capturedAt:new Date().toISOString(),measurementVersion:'fixture',
      source:{revision:'fixture-source', commit:'abcdef',dirty:false,indexReady:true,files:17,mismatchedFiles:0},
      graph:{revision:'fixture-graph',stable:true,indexedAt:new Date().toISOString(),scope:'project',dataDirectory:null},
      metrics:{nodes:123,edges:321,symbols:branch==='main'?37:49,files:17,communities:3,processes:4,measuredFunctions:23,
        estimatedFunctions:0,distribution:{simple:20,moderate:2,high:1,critical:0},deadCodeCandidates:0,importCycles:0},
      hotspots:[],deadCode:[],tools:[],limitations:[]
    };
    // Deliberately delay the bridge broadcast. Components still get the actual IPC reply.
    const history = JSON.parse(sessionStorage.getItem('quality-history') || '[]');
    sessionStorage.setItem('quality-history', JSON.stringify([...history, result]));
    return result;
  };
  const props = {state, project, notify, open:()=>{}, onAnalyze:async()=>{window.calls.push(['unexpected-reindex'])}};
  return <main>
    <nav>{['team','insights','improve'].map(item=><button key={item} onClick={()=>setView(item)}>{item}</button>)}</nav>
    {view==='team' && <LocalProjectSetup project={project} repository={repository} notify={notify} onWorkers={()=>{}} onInsights={()=>setView('insights')}/>}
    {view==='insights' && <InsightsPage {...props}/>}
    {view==='improve' && <Improve key={branch} {...props}/>}
  </main>;
}
createRoot(document.getElementById('root')).render(mode==='quality'?<React.StrictMode><QualityFixture/></React.StrictMode>:<Fixture/>);
`,
  },
  absWorkingDir: root,
  bundle: true,
  outdir: output,
  entryNames: "fixture",
  format: "esm",
  jsx: "automatic",
  loader: { ".woff2": "file", ".woff": "file" },
});
await writeFile(
  join(output, "index.html"),
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
);
const server = createServer(async (request, response) => {
  try {
    const name =
      basename(new URL(request.url, "http://localhost").pathname) ||
      "index.html";
    response.setHeader(
      "content-type",
      name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    response.end(await readFile(join(output, name)));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
const flows = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1240, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await expect(
    page.getByRole("button", { name: "Create a team", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: join(output, "01-team-welcome.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create a team", exact: true })
    .click();
  await page.getByLabel("Team name", { exact: true }).fill("Synthetic Studio");
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Share with Synthetic Studio",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(repositoryIdentity(), { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: join(output, "02-share-existing-project.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Share with Synthetic Studio", exact: true })
    .click();
  await page.getByLabel(/Email address/).fill("teammate@example.invalid");
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Copy invitation", exact: true })
    .click();
  expect(await page.evaluate(() => window.clipboard)).toBe(
    "https://relay.example.invalid/#synthetic-invitation-only",
  );
  expect(
    await page.evaluate(
      () => window.calls.find((call) => call[0] === "invite")[1].email,
    ),
  ).toBe("teammate@example.invalid");
  flows.push(
    "create named team",
    "share existing project and source metadata",
    "email-scoped invitation and copy",
  );

  await page.goto(url);
  await page
    .getByRole("button", { name: "Join with invitation", exact: true })
    .click();
  await page
    .getByLabel("Invitation link", { exact: true })
    .fill("https://relay.example.invalid/#synthetic-invitation-only");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Join Observatory Team", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: join(output, "03-invitation-preview.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Accept and open", exact: true })
    .click();
  await expect(page.getByTestId("current-project")).toContainText(
    "Shared Observatory",
  );
  await expect(page.getByTestId("current-project")).toContainText(
    "Existing shared story from the team",
  );
  expect(
    await page.evaluate(
      () => window.sharedState.projects.find((p) => p.id === "personal").path,
    ),
  ).toBe("C:/Synthetic/observatory");
  expect(
    await page.evaluate(() =>
      window.calls.some((call) => call[0] === "folder-picker"),
    ),
  ).toBe(false);
  flows.push(
    "invitation preview before acceptance",
    "open shared status quo without creating an empty project",
    "preserve personal project",
  );

  await page.goto(url + "/?mode=reuse");
  await page
    .getByRole("button", { name: "Work on this computer", exact: true })
    .click();
  await expect(
    page.getByText("epic/observatory · local changes preserved", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: join(output, "04-reuse-dirty-checkout.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Use this folder", exact: true })
    .click();
  await expect(
    page.getByText("Local changes preserved", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => window.calls.filter((call) => call[0] === "bind").length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      window.calls.some(
        (call) =>
          call[0] === "folder-picker" || call[0] === "UNEXPECTED-WORKER-START",
      ),
    ),
  ).toBe(false);
  flows.push(
    "explicit reuse of dirty checkout",
    "no worker auto-approval or automatic execution",
  );

  await page.goto(url + "/?mode=wrong");
  await page
    .getByRole("button", { name: "Work on this computer", exact: true })
    .click();
  await page.getByRole("button", { name: /Use an existing checkout/ }).click();
  await expect(page.getByRole("alert")).toContainText("different repository");
  expect(
    await page.evaluate(
      () => window.sharedState.projects.find((p) => p.id === "shared").path,
    ),
  ).toBe(null);
  flows.push("wrong repository remains unbound with an actionable error");

  await page.goto(url + "/?mode=clone");
  await page
    .getByRole("button", { name: "Work on this computer", exact: true })
    .click();
  await page.getByRole("button", { name: /Clone the repository/ }).click();
  expect(
    await page.evaluate(() =>
      window.calls.some((call) => call[0] === "github"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Check access", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.calls.some((call) => call[0] === "github"),
    ),
  ).toBe(false);
  await page
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await expect(page.getByText("TEST-1234", { exact: true })).toBeVisible();
  await page.screenshot({
    path: join(output, "05-explicit-github-approval.png"),
    fullPage: true,
  });
  await page.evaluate(() => {
    window.providerSignedIn = true;
  });
  await expect(
    page.getByText("Repository access confirmed", { exact: true }),
  ).toBeVisible({ timeout: 7000 });
  await page
    .getByRole("button", { name: "Choose clone destination", exact: true })
    .click();
  await page
    .getByLabel("New folder name", { exact: true })
    .fill("observatory-local");
  await page
    .getByRole("button", { name: "Clone and connect", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Receiving repository files",
    { timeout: 5000 },
  );
  await page.screenshot({
    path: join(output, "06-clone-progress.png"),
    fullPage: true,
  });
  // Hide and remount the actual LocalProjectSetup component while its original
  // clone request stays pending in the runtime fixture. Do not reload the page.
  await page
    .getByRole("button", { name: "Work on this computer", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Connect local code" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.progress = {
      phase: "checking",
      message: "Checking repository access…",
    };
  });
  await page
    .getByRole("button", { name: "Work on this computer", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Checking repository access",
  );
  await expect(
    page.getByRole("button", { name: "Clone and connect", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => window.calls.filter((call) => call[0] === "clone").length,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    window.progress = {
      phase: "cloning",
      message: "Receiving repository files…",
    };
  });
  await expect(page.getByRole("status")).toContainText(
    "Receiving repository files",
  );
  await page.screenshot({
    path: join(output, "08-restored-background-clone.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("cancelled");
  expect(
    await page.evaluate(
      () => window.sharedState.projects.find((p) => p.id === "shared").path,
    ),
  ).toBe(null);
  expect(
    await page.evaluate(() =>
      window.calls.some((call) => call[0] === "UNEXPECTED-WORKER-START"),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () => window.calls.filter((call) => call[0] === "clone").length,
    ),
  ).toBe(1);
  await page.waitForTimeout(100);
  const stoppedPollCount = await page.evaluate(
    () => window.calls.filter((call) => call[0] === "setup-status").length,
  );
  await page.waitForTimeout(900);
  expect(
    await page.evaluate(
      () => window.calls.filter((call) => call[0] === "setup-status").length,
    ),
  ).toBe(stoppedPollCount);
  flows.push(
    "Git credentials checked before explicit GitHub connection",
    "device approval and access retry",
    "chosen clone destination",
    "visible progress and cancellation",
    "background clone survives unmount/remount with restored checking and cloning progress",
    "recovered clone cannot start a duplicate and cancels the original request",
    "terminal cancellation stops status polling",
  );
  await page.getByRole("button", { name: "Check access", exact: true }).click();
  await page
    .getByRole("button", { name: "Choose clone destination", exact: true })
    .click();
  await page
    .getByLabel("New folder name", { exact: true })
    .fill("completed-in-background");
  await page
    .getByRole("button", { name: "Clone and connect", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.calls.filter((call) => call[0] === "clone").length,
      ),
    )
    .toBe(2);
  await page
    .getByRole("button", { name: "Work on this computer", exact: true })
    .click();
  await page.evaluate(() => window.finishClone());
  await page.getByRole("button", { name: "Local setup", exact: true }).click();
  await expect(
    page.getByText("Local code connected", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => window.sharedState.projects.find((p) => p.id === "shared").path,
    ),
  ).toBe("C:/Synthetic/projects/completed-in-background");
  expect(
    await page.evaluate(
      () => window.calls.filter((call) => call[0] === "clone").length,
    ),
  ).toBe(2);
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(0);
  flows.push(
    "clone completed while panel is hidden reopens as the connected checkout",
  );
  await page.goto(url + "/?mode=clone");
  await page.evaluate(() => {
    window.progress = {
      phase: "failed",
      message: "Repository setup failed. Its partial folder is preserved.",
    };
  });
  await page
    .getByRole("button", { name: "Work on this computer", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "partial folder is preserved",
  );
  expect(
    await page.evaluate(
      () => window.calls.filter((call) => call[0] === "clone").length,
    ),
  ).toBe(0);
  flows.push(
    "failed background setup remains visible on return without retrying automatically",
  );
  await page.goto(url + "/?mode=diagnostics");
  const diagnosticPanel = page.getByRole("region", {
    name: "Local engine diagnostics",
  });
  await expect(diagnosticPanel).toHaveCount(0);
  await page
    .getByRole("button", { name: "Check local engine", exact: true })
    .click();
  await expect(
    diagnosticPanel.getByText("Not yet verified", { exact: true }),
  ).toBeVisible();
  await expect(
    diagnosticPanel.getByText("Not observed", { exact: true }),
  ).toBeVisible();
  await expect(
    diagnosticPanel.getByText("running", { exact: true }),
  ).toBeVisible();
  await expect(diagnosticPanel).toContainText("source index not qualified");
  await page
    .getByRole("button", { name: "Copy diagnostics", exact: true })
    .click();
  const copiedDiagnostics = await page.evaluate(() => window.clipboard);
  const copiedMetadata = JSON.parse(copiedDiagnostics);
  expect(copiedMetadata.project.path).toBe("C:/Synthetic/observatory");
  expect(copiedMetadata.indexRevision.source_revision).toBe(
    "synthetic-source-revision",
  );
  expect(copiedMetadata.jobs[0].id).toBe("synthetic-peer-job");
  expect(copiedDiagnostics).not.toContain("SYNTHETIC_RAW_AUTH_SECRET");
  expect(copiedDiagnostics).not.toContain("SOURCE_CODE_MUST_NOT_LEAVE_ENGINE");
  expect(copiedDiagnostics).not.toContain('"api_key"');
  await page.screenshot({
    path: join(output, "09-local-engine-blocked-diagnostics.png"),
    fullPage: true,
  });
  await page.evaluate(() =>
    window.setLocalAnalysis(
      "indexing",
      "Following Memtrace job synthetic-peer-job · parse · 2/8 files · Parsing source files",
    ),
  );
  await expect(page.locator(".repo-analysis")).toContainText(
    "synthetic-peer-job · parse · 2/8 files",
  );
  await page.evaluate(() => {
    window.setLocalAnalysis("error", "Source index could not be qualified");
    window.diagnosticVariant = "aligned";
  });
  await page
    .getByRole("button", { name: "Check local engine", exact: true })
    .click();
  await expect(
    diagnosticPanel.getByText("Aligned", { exact: true }),
  ).toBeVisible();
  await expect(
    diagnosticPanel.getByText("Observed on this checkout", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.diagnosticVariant = "mismatch";
  });
  await page
    .getByRole("button", { name: "Check local engine", exact: true })
    .click();
  await expect(
    diagnosticPanel.getByText("Branch mismatch", { exact: true }),
  ).toBeVisible();
  await expect(
    diagnosticPanel.getByText("Aligned", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.diagnosticVariant = "unstable";
  });
  await page
    .getByRole("button", { name: "Check local engine", exact: true })
    .click();
  await expect(
    diagnosticPanel.getByText("Not yet verified", { exact: true }),
  ).toBeVisible();
  await expect(
    diagnosticPanel.getByText("Aligned", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.diagnosticVariant = "unknown";
  });
  await page
    .getByRole("button", { name: "Check local engine", exact: true })
    .click();
  await expect(
    diagnosticPanel.getByText("Unknown", { exact: true }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Copy diagnostics", exact: true })
    .click();
  expect(await page.evaluate(() => window.clipboard)).not.toContain(
    "SYNTHETIC_RAW_AUTH_SECRET",
  );
  await page.evaluate(() =>
    window.changeLocalPath("C:/Synthetic/moved-observatory"),
  );
  await expect(diagnosticPanel).toHaveCount(0);
  await page.evaluate(() => {
    window.holdDiagnostics = true;
    window.diagnosticVariant = "blocked";
  });
  await page
    .getByRole("button", { name: "Check local engine", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseDiagnostics))
    .toBe("function");
  await page.evaluate(() => window.selectProject("shared"));
  await page.evaluate(() => {
    window.holdDiagnostics = false;
    window.releaseDiagnostics();
  });
  await page.waitForTimeout(50);
  await expect(diagnosticPanel).toHaveCount(0);
  await page
    .getByRole("button", { name: "Check local engine", exact: true })
    .click();
  await expect(diagnosticPanel).toBeVisible();
  expect(
    await page.evaluate(
      () => window.calls.filter((call) => call[0] === "diagnostics").at(-1)[1],
    ),
  ).toBe("shared");
  expect(
    await page.evaluate(() =>
      window.calls.some(
        (call) =>
          call[0] === "clone" ||
          call[0] === "analyze" ||
          call[0] === "UNEXPECTED-WORKER-START",
      ),
    ),
  ).toBe(false);
  await page.screenshot({
    path: join(output, "10-local-engine-unknown-diagnostics.png"),
    fullPage: true,
  });
  flows.push(
    "local engine diagnostics render blocked revision, missing watch and matching jobs",
    "Copy diagnostics uses the real backend whitelist/redaction with synthetic raw credentials and source excluded",
    "peer indexing progress remains visible in the analysis status",
    "branch-mismatched revisions are never labelled Aligned",
    "watch/job failures remain Unknown rather than absent",
    "diagnostics clear after local path changes and stale responses cannot cross projects",
  );
  await page.goto(url + "/?mode=diagnostics");
  await page.evaluate(() => {
    window.diagnosticVariant = "replaying";
    window.setLocalAnalysis(
      "error",
      "owned source changed after verification; refusing publication",
    );
  });
  await expect(
    page.getByText("Not yet verified", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry analysis" }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.diagnosticVariant = "aligned";
  });
  await expect(
    page.getByText("Code context is ready", { exact: true }),
  ).toBeVisible({ timeout: 12_000 });
  expect(
    await page.evaluate(
      () => window.calls.filter((call) => call[0] === "analyze").length,
    ),
  ).toBe(0);
  flows.push(
    "a later certified replay automatically clears a saved refusal without submitting an index",
  );
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto(url + "/?mode=reuse");
  await page
    .getByRole("button", { name: "Work on this computer", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: join(output, "07-compact-onboarding.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1240, height: 1000 });
  await page.goto(url + "/?mode=quality");
  await page
    .getByRole("button", { name: "Check local engine", exact: true })
    .click();
  await expect(page.getByText("Aligned", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Open Insights", exact: true })
    .click();
  const reportRequests = () =>
    page.evaluate(() => window.calls.filter(([op]) => op === "report"));
  await expect(
    page.getByRole("heading", { name: "Loading your code report…" }),
  ).toBeVisible();
  await expect
    .poll(reportRequests)
    .toEqual([["report", "personal", "main", false]]);
  await page.getByRole("button", { name: "improve", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recording checkpoint…" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "insights", exact: true }).click();
  await page.evaluate(() => window.rejectReport());
  await expect(
    page.getByText("Fixture report timed out.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(output, "11-insights-retry.png") });
  await page.getByRole("button", { name: "Retry report" }).click();
  await expect.poll(reportRequests).toHaveLength(2);
  await page.evaluate(() => window.resolveReport());
  await expect(
    page.getByText(
      "37 source symbols connected by 321 structural relationships.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "improve", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Better code/ }),
  ).toBeVisible();
  await page.screenshot({
    path: join(output, "12-improve-first-checkpoint.png"),
  });
  await page.evaluate(() => window.changeBranch("epic/parallel"));
  await page
    .getByRole("button", { name: "Capture the first checkpoint" })
    .click();
  await expect(
    page.getByRole("button", { name: "Recording checkpoint…" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "insights", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Loading your code report…" }),
  ).toBeVisible();
  await expect(page.getByText(/37 source symbols/)).toHaveCount(0);
  await expect.poll(reportRequests).toHaveLength(3);
  await page.getByRole("button", { name: "improve", exact: true }).click();
  await page.evaluate(() => window.rejectReport());
  await expect(page.getByRole("alert")).toContainText(
    "Fixture report timed out.",
  );
  await page
    .getByRole("button", { name: "Capture the first checkpoint" })
    .click();
  await expect.poll(reportRequests).toHaveLength(4);
  await page.evaluate(() => window.resolveReport());
  await expect(
    page.getByRole("heading", { name: /Better code/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "insights", exact: true }).click();
  await expect(
    page.getByText(
      "49 source symbols connected by 321 structural relationships.",
    ),
  ).toBeVisible();
  expect(await reportRequests()).toEqual([
    ["report", "personal", "main", false],
    ["report", "personal", "main", false],
    ["report", "personal", "epic/parallel", false],
    ["report", "personal", "epic/parallel", false],
  ]);
  expect(
    await page.evaluate(() =>
      window.calls.some(
        ([op]) => op === "analyze" || op === "unexpected-reindex",
      ),
    ),
  ).toBe(false);
  await page.reload();
  await page
    .getByRole("button", { name: "Open Insights", exact: true })
    .click();
  await expect(
    page.getByText(
      "37 source symbols connected by 321 structural relationships.",
    ),
  ).toBeVisible();
  expect(await reportRequests()).toEqual([]);
  flows.push(
    "Team verified graph opens Insights, shares one read with Improve, recovers from a report failure without reindexing",
    "Improve recovers and renders its first checkpoint on a separate branch, then Insights consumes it without a second read",
    "reopening the app selects the persisted checkpoint for the current branch",
  );
  expect(errors).toEqual([]);
  const evidence = {
    passed: true,
    synthetic: true,
    flows,
    screenshotDirectory: output,
    consoleErrors: errors,
  };
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
function repositoryIdentity() {
  return "github.com/synthetic-fixture/observatory";
}
