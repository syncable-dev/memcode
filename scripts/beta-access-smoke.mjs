import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  output = join(root, ".memcode/verification/beta-access");
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  bundle: true,
  outdir: output,
  entryNames: "fixture",
  format: "esm",
  jsx: "automatic",
  loader: { ".woff2": "file", ".woff": "file" },
  stdin: {
    loader: "tsx",
    resolveDir: root,
    sourcefile: "beta-access-fixture.tsx",
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{BetaAccess}from'./src/components/BetaAccess';import{NewProjectDialog}from'./src/components/Dialogs';import{Onboarding}from'./src/components/Onboarding';import{initialState}from'./src/seed';import'./src/styles.css';import'@fontsource-variable/inter';
const mode=new URLSearchParams(location.search).get('mode');window.calls=[];window.submitCount=0;let listeners=new Set();let status={state:'disconnected',accessMode:'installed-cli',loginPending:false,detail:'Approve access with your Memtrace account. MemCode prepares the local engine for you.'};const emit=()=>{for(const listener of listeners)listener({...status})};
window.memcode={betaStatus:async()=>status,onBetaStatus:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},connectBeta:async()=>{window.calls.push('connect');status={...status,state:'connecting',loginPending:true,canCancel:true,detail:'Approve noncommercial beta access in your Memtrace browser session.'};emit();return await new Promise(resolve=>{window.approve=()=>{status={state:'connected',accessMode:'beta',loginPending:false,account:{id:'fixture-user',name:'Alex Example'},detail:'Unlimited local Memtrace engine usage for the noncommercial beta. Model accounts and credits remain separate.'};emit();resolve(status)};window.cancelPending=()=>{status={state:'disconnected',accessMode:'installed-cli',loginPending:false,detail:'Sign-in cancelled. Connect when ready.'};emit();resolve(status)}})},cancelBeta:async()=>{window.calls.push('cancel');window.cancelPending?.();return status},refreshBeta:async()=>{window.calls.push('refresh');return status},signOutBeta:async()=>{window.calls.push('sign-out');status={state:'disconnected',accessMode:'beta',loginPending:false,detail:'Connect your Memtrace account for noncommercial beta access.'};emit();return status},useExistingMemtraceCLI:async()=>{window.calls.push('use-cli');status={state:'disconnected',accessMode:'installed-cli',loginPending:false,detail:'Your existing CLI setup is selected.'};emit();return status},selectFolder:async()=>'/fixture/local-project',createProject:async input=>{window.calls.push(['project',input]);},speechStatus:async()=>({state:'unavailable',detail:'Fixture'}),accountStatus:async()=>({status:'signed-out',detail:'Existing CLI account',loginPending:false})};
const notify=message=>window.lastNotice=message;const state=initialState();
window.finishApproval=()=>{status={...status,connectionPhase:'finishing',canCancel:false,detail:'Saving your approved beta connection securely.'};emit()};
const guide=mode==='onboarding'||mode==='onboarding-beta';
createRoot(document.getElementById('root')).render(mode==='project'?<NewProjectDialog needsEngine notify={notify} onClose={()=>{}} onCreated={()=>window.created=true}/>:guide?<Onboarding needsEngine notify={notify} progress={{step:mode==='onboarding'?'welcome':'memtrace',dismissed:false}} state={state} project={{...state.projects[0],path:'/fixture/local-project'}} epics={[]} connected={false} hidden={false} onUpdate={()=>{}} onAction={()=>{}} onDocs={()=>{}}/>:<main style={{maxWidth:620,margin:'40px auto'}}><form onSubmit={event=>{event.preventDefault();window.submitCount++}}><BetaAccess compact={mode==='compact'} existingCLI notify={notify}/></form></main>);
`,
  },
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
          : name.endsWith(".woff2")
            ? "font/woff2"
            : "text/html",
    );
    response.end(await readFile(join(output, name)));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1080, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = "http://127.0.0.1:" + server.address().port;
  await page.goto(url);
  await expect(
    page.getByRole("button", { name: "Connect Memtrace beta", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.calls)).toEqual([]);
  await page.screenshot({ path: join(output, "connect-account.png") });
  await page
    .getByRole("button", { name: "Connect Memtrace beta", exact: true })
    .click();
  await expect(
    page.getByText("Waiting for browser approval…", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect Memtrace beta", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.calls)).toEqual([
    "connect",
    "cancel",
  ]);
  await page
    .getByRole("button", { name: "Connect Memtrace beta", exact: true })
    .click();
  await page.evaluate(() => window.finishApproval());
  await expect(page.getByText("Finishing sign-in…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeHidden();
  await page.evaluate(() => window.approve());
  await expect(page.getByText("Alex Example", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", { name: "Sign out of Memtrace beta", exact: true })
    .click();
  expect(await page.evaluate(() => window.calls.includes("sign-out"))).toBe(
    false,
  );
  await page
    .getByRole("button", { name: "Keep connection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sign out of Memtrace beta", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect Memtrace beta", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.calls.includes("use-cli"))).toBe(
    false,
  );
  await page.getByText("Existing Memtrace CLI setup", { exact: true }).click();
  await page
    .getByRole("button", { name: "Use existing CLI setup", exact: true })
    .click();
  await expect(
    page.getByText(/its account, plan and usage limits/),
  ).toBeVisible();
  expect(await page.evaluate(() => window.calls.includes("use-cli"))).toBe(
    false,
  );
  await page
    .getByRole("button", { name: "Use existing CLI", exact: true })
    .click();
  expect(await page.evaluate(() => window.calls.includes("use-cli"))).toBe(
    true,
  );
  expect(await page.evaluate(() => window.submitCount)).toBe(0);
  await page.goto(url + "?mode=project");
  await expect(
    page.getByRole("button", { name: "Connect Memtrace beta", exact: true }),
  ).toBeVisible();
  await page.locator(".folder-select").click();
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.created)).toBe(true);
  expect(
    await page.evaluate(() =>
      window.calls.map((call) => (Array.isArray(call) ? call[0] : call)),
    ),
  ).toEqual(["project"]);
  await page.screenshot({
    path: join(output, "first-project.png"),
    fullPage: true,
  });
  await page.goto(url + "?mode=onboarding");
  await expect(page.getByRole("button", { name: "Let’s get started" })).toBeVisible();
  expect(await page.evaluate(() => window.calls)).toEqual([]);
  await page.goto(url + "?mode=onboarding-beta");
  await expect(
    page.getByRole("button", { name: "Connect Memtrace beta", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.calls)).toEqual([]);
  await page.screenshot({
    path: join(output, "first-run.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.goto(url + "?mode=compact");
  await page
    .getByRole("button", { name: "Memtrace account", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Connect Memtrace beta", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Connect Memtrace beta", exact: true }),
  ).toBeHidden();
  expect(errors).toEqual([]);
  console.log(
    "Beta UI: explicit connect/cancel, account approval, refresh, reviewed logout, sticky beta billing, explicit CLI switch, first project, first-run and account popover passed; no worker or automatic sign-in.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
