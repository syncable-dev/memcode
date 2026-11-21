// Isolated renderer fixture: no user profile, workers, relay or native window is touched.
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".memcode", "verification", "team-ui");
await mkdir(output, { recursive: true });
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TeamWorkspace } from './src/components/TeamWorkspace';
import { Docs } from './src/components/Docs';
import './src/styles.css';
import './src/styles-team.css';
const at='2026-11-15T12:00:00Z';
const project={id:'local-project',name:'Team preview lab',path:'C:/fixture/project',description:'',branch:'main',analysis:'idle',createdAt:at};
const task={id:'story',projectId:project.id,identifier:'MC-001',title:'Keep the shared plan current',stage:'working',run:{state:'idle'}};
const artifact={id:'report',taskId:'story',projectId:project.id,name:'implementation-report.md',path:'C:/private/artifacts/implementation-report.md',source:'claude',kind:'text',createdAt:at};
const result={id:'result',storyId:'story',name:'Design direction.pdf',mime:'application/pdf',size:24000,hash:'x',kind:'report',memberId:'bob',deviceId:'bob-pc',createdAt:at};
const team={projectId:project.id,connection:'online',memberId:'alice',deviceId:'alice-pc',pendingCount:0,unreadCount:2,workspace:{workspaceId:'lab',name:'Team preview lab',head:7,members:[{id:'alice',name:'Demo Alice',role:'owner',devices:[{id:'alice-pc',name:'Alice laptop'}],joinedAt:at},{id:'bob',name:'Demo Bob',role:'editor',devices:[{id:'bob-pc',name:'Bob desktop'}],joinedAt:at}],stories:[task],epics:[],cycles:[],comments:[],claims:[{storyId:'story',attemptId:'attempt',epoch:1,memberId:'bob',deviceId:'bob-pc',acquiredAt:at}],results:[result],activity:[{id:'event1',sequence:1,memberId:'bob',deviceId:'bob-pc',type:'story.put',entityId:'story',summary:'updated Keep the shared plan current',at},{id:'event2',sequence:2,memberId:'bob',deviceId:'bob-pc',type:'result.publish',entityId:'story',summary:'published Design direction.pdf',at}],readCursors:[]}};
window.calls=[];
let update;
window.memcode={
 teamStatus:async()=>{if(new URLSearchParams(location.search).has('old-runtime'))throw Error('Unknown RPC method team:status');return new URLSearchParams(location.search).has('setup') ? null : team},
 teamCreate:async(input)=>{window.calls.push(['create',input]);update(team);return team},
 teamJoin:async(input)=>{window.calls.push(['join',input]);update(team);return team},
 teamInvite:async()=>({endpoint:'http://127.0.0.1:8787',workspaceId:'lab',invitation:'fixture-invitation',expiresAt:at}),
 teamRead:async()=>{window.calls.push(['read']);const next={...team,unreadCount:0};update(next);return next},
 teamPublish:async(input)=>{window.calls.push(['publish',input]);return result},
 teamDownloadResult:async(...input)=>{window.calls.push(['download',...input]);return artifact},
 teamLeave:async()=>{window.calls.push(['leave']);update(null)},
 teamRelease:async(...input)=>{window.calls.push(['release',...input]);const next={...team,workspace:{...team.workspace,claims:[]}};update(next);return next},
};
function Fixture(){const query=new URLSearchParams(location.search);const [binding,setBinding]=useState(query.has('setup')||query.has('old-runtime')?null:team);update=setBinding;window.fixtureScenario=(mode)=>{const next=structuredClone(team);if(mode==='offline'){next.connection='offline';next.pendingCount=3;}else{next.workspace.claims[0].memberId='alice';next.workspace.claims[0].deviceId='alice-pc';task.run.state=mode==='running'?'running':'idle';}setBinding(next);};const state={tasks:[task],artifacts:[artifact,{...artifact,id:'probe',name:'explore-watch.mts',path:'C:/private/artifacts/explore-watch.mts'}],team:binding?[binding]:[]};return <main style={{maxWidth:1280,padding:'30px 36px',margin:'0 auto'}}><div className='page-heading'><div><div className='eyebrow'><span/>ISOLATED UI FIXTURE</div><h1>Better together. Still local.</h1><p>Keep the plan, the conversation and the results in sync.</p></div></div><TeamWorkspace state={state} project={project} notify={(text)=>window.calls.push(['notify',text])} open={(task)=>window.calls.push(['open',task.id])} openArtifact={(artifact)=>window.calls.push(['open-artifact',artifact.id])}/></main>}
createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('docs')?<main className='workspace-scroll' style={{padding:'30px 36px',maxWidth:1320,margin:'0 auto'}}><Docs initialArticle='team' onStartGuide={()=>window.calls.push(['guide'])} onGo={(destination)=>window.calls.push(['go',destination])}/></main>:<Fixture/>);
`;
await build({
  stdin: {
    contents: fixture,
    resolveDir: root,
    sourcefile: "team-ui-fixture.tsx",
    loader: "tsx",
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
  path.join(output, "index.html"),
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
);
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const filename = pathname === "/" ? "index.html" : path.basename(pathname);
  try {
    const bytes = await readFile(path.join(output, filename));
    res.setHeader(
      "Content-Type",
      filename.endsWith(".css")
        ? "text/css"
        : filename.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    );
    res.end(bytes);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1050 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url + "/?setup");
  await expect(
    page.getByRole("heading", { name: "Share this project" }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(output, "setup.png"),
    fullPage: true,
  });
  await page
    .getByPlaceholder("How teammates know you")
    .first()
    .fill("Demo Alice");
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("checkbox").check();
  await page.getByText("Advanced connection", { exact: true }).click();
  await page
    .getByPlaceholder("Detect local network address")
    .fill("192.168.1.10");
  await page
    .getByRole("button", { name: "Share project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Team preview lab", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Demo Bob", { exact: true }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Invite teammate" }).click();
  await expect(
    page.getByRole("textbox", { name: "Workspace invitation to copy" }),
  ).toHaveValue(/fixture-invitation/);
  await page.getByRole("button", { name: "Hide invitation" }).click();
  await page.getByRole("combobox", { name: "Result to publish" }).click();
  await expect(
    page.getByRole("option", { name: /implementation-report/ }),
  ).toBeVisible();
  await expect(page.getByRole("option", { name: /explore-watch/ })).toHaveCount(
    0,
  );
  await page.getByRole("option", { name: /implementation-report/ }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: /Design direction.pdf/ }).click();
  const calls = await page.evaluate(() => window.calls);
  expect(
    calls.some(
      (item) => item[0] === "create" && item[1].displayName === "Demo Alice",
    ),
  ).toBeTruthy();
  expect(
    calls.some(
      (item) =>
        item[0] === "create" &&
        item[1].shareOnLAN === true &&
        item[1].advertisedHost === "192.168.1.10",
    ),
  ).toBeTruthy();
  expect(
    calls.some(
      (item) => item[0] === "publish" && item[1].artifactId === "report",
    ),
  ).toBeTruthy();
  expect(
    calls.some((item) => item[0] === "open-artifact" && item[1] === "report"),
  ).toBeTruthy();
  expect(calls.filter((item) => item[0] === "read")).toHaveLength(0);
  await page.getByRole("button", { name: "Mark read" }).click();
  await expect(page.getByText("2 new", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: path.join(output, "connected.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 520, height: 960 });
  await page.screenshot({
    path: path.join(output, "narrow.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.evaluate(() => window.fixtureScenario("running"));
  await expect(
    page.getByRole("button", { name: "Release claim", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.fixtureScenario("own"));
  await expect(
    page.getByRole("button", { name: "Release claim", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Release claim", exact: true })
    .click();
  await expect(
    page.getByText("No task is claimed.", { exact: false }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.calls)).some(
      (item) => item[0] === "release" && item[2] === "story",
    ),
  ).toBeTruthy();
  await page.evaluate(() => window.fixtureScenario("offline"));
  await expect(page.getByText("Offline", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Invite teammate" }),
  ).toBeDisabled();
  await expect(
    page.getByText("New shared workers need an online task claim.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.goto(url + "/?old-runtime");
  await expect(page.getByRole("alert")).toContainText(
    "Team Sync needs the updated local runtime.",
  );
  await page.goto(url + "/?setup");
  await page
    .getByPlaceholder("How teammates know you")
    .first()
    .fill("Demo Alice");
  await page.getByText("Advanced connection", { exact: true }).click();
  await page
    .getByPlaceholder("Start on this computer")
    .fill("http://127.0.0.1:8787");
  await expect(
    page.getByRole("button", { name: "Share project", exact: true }),
  ).toBeDisabled();
  await page
    .getByPlaceholder("From the relay administrator")
    .fill("fixture-setup-secret");
  await page
    .getByRole("button", { name: "Share project", exact: true })
    .click();
  expect(
    (await page.evaluate(() => window.calls)).some(
      (item) =>
        item[0] === "create" &&
        item[1].bootstrapSecret === "fixture-setup-secret",
    ),
  ).toBeTruthy();
  await page.goto(url + "/?setup");
  await page.getByPlaceholder("How teammates know you").last().fill("Demo Bob");
  await page
    .getByPlaceholder("Paste the invitation from your teammate")
    .fill('{"fixture":"invitation"}');
  await page
    .getByRole("button", { name: "Join workspace", exact: true })
    .click();
  expect(
    (await page.evaluate(() => window.calls)).some(
      (item) => item[0] === "join" && item[1].displayName === "Demo Bob",
    ),
  ).toBeTruthy();
  await page.setViewportSize({ width: 1280, height: 1050 });
  await page.goto(url + "/?docs");
  await expect(
    page.getByRole("heading", { name: "Work with your team", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("figure", { name: "Work with your team — guide example" }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(output, "docs-team.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Open Team", exact: true }).click();
  expect(
    (await page.evaluate(() => window.calls)).some(
      (item) => item[0] === "go" && item[1] === "team",
    ),
  ).toBeTruthy();
  await page.setViewportSize({ width: 520, height: 960 });
  await page.screenshot({
    path: path.join(output, "docs-team-narrow.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      ok: true,
      tests: [
        "create",
        "LAN opt-in",
        "custom relay secret",
        "join",
        "invite",
        "publish primary only",
        "download/open result",
        "explicit mark read",
        "own claim release",
        "active claim release blocked",
        "offline",
        "old runtime",
        "responsive layout",
        "Team guide navigation and illustration",
      ],
      screenshots: output,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
