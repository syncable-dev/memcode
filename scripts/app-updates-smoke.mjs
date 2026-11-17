// Actual Settings components with a labelled native-API fixture. Native signing
// and persistence across process exit are checked independently by Rust tests.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".memcode/verification/app-updates");
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
    sourcefile: "app-updates-fixture.tsx",
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{AppUpdates}from'./src/components/AppUpdates';import{DictationSettings}from'./src/components/DictationSettings';import{AppUpdater}from'./src/updates';import'./src/styles.css';import'@fontsource-variable/inter';
const mode=new URLSearchParams(location.search).get('mode');window.calls=[];window.workers=mode==='workers'?2:0;
const release={version:'0.4.0-beta.13',notes:'## Smoother updates\\n\\nVerified downloads survive a restart.\\n\\n'+('Release detail. '.repeat(80)),publishedAt:'2026-11-17T12:00:00Z'};
const settings={speech:{mode:'managed',modelPath:'/private/cache/model.bin',executable:'/private/cache/server',language:'auto'}};
window.memcode={speechStatus:async()=>({state:'available',mode:'managed',settings:settings.speech,message:'Local dictation is configured.',managedInstallAvailable:true})};
const updater=new AppUpdater({info:async()=>({currentVersion:'0.4.0-beta.12',development:false,readyRelease:['ready','save-error','workers'].includes(mode)?release:null}),context:async()=>({activeWorkers:window.workers,activeTerminals:0}),history:async()=>[],check:async()=>{window.calls.push('check');if(mode==='offline')throw Error('Update service unreachable');return mode==='current'?null:release;},download:async(version,progress)=>{window.calls.push('download');progress({phase:'downloading',downloaded:50,total:100});await new Promise(resolve=>window.finishDownload=resolve);progress({phase:'ready',downloaded:100,total:100});},install:async()=>{window.calls.push('install');}});
createRoot(document.getElementById('root')).render(<main style={{maxWidth:740,margin:'25px auto',padding:30,border:'1px solid #dce5d9',borderRadius:18,background:'#fbfdfb'}}><div className="kicker">MEMCODE / ISOLATED SETTINGS TEST</div><h1 style={{fontSize:25}}>Make the workspace yours.</h1><AppUpdates currentVersion="0.4.0-beta.12" updater={updater} beforeRestart={async()=>{window.calls.push('save-settings');if(mode==='save-error')throw Error('Settings could not be saved');}}/><DictationSettings settings={settings} change={()=>{throw Error('Readiness must not require changing setup')}}/></main>);
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
await new Promise((done) => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1050, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await expect(
    page.getByText("Downloading update · 50%", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.calls), [
    "check",
    "download",
  ]);
  await page.evaluate(() => window.finishDownload());
  const restart = page.getByRole("button", {
    name: "Install and restart",
    exact: true,
  });
  await expect(restart).toBeVisible();
  assert.ok(
    (await restart.boundingBox()).y <
      (await page.locator(".app-update-notes").boundingBox()).y,
    "Restart must appear above release notes",
  );
  await expect(page.getByText("Ready to dictate", { exact: true })).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("button", {
      name: /Set up local dictation|Start local dictation/,
    }),
  ).toHaveCount(0);
  await page.screenshot({
    path: join(output, "ready-and-dictation.png"),
    fullPage: true,
  });
  await restart.click();
  await expect(
    page.getByText("Installing and restarting MemCode…", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.calls), [
    "check",
    "download",
    "save-settings",
    "install",
  ]);
  await page.goto(url + "?mode=ready");
  await expect(restart).toBeVisible();
  assert.deepEqual(
    await page.evaluate(() => window.calls),
    [],
    "Recovered verified downloads must not check or download again",
  );
  await page.goto(url + "?mode=save-error");
  await restart.click();
  await expect(page.getByRole("alert")).toContainText(
    "Settings could not be saved",
  );
  assert.deepEqual(await page.evaluate(() => window.calls), ["save-settings"]);
  await page.goto(url + "?mode=workers");
  await restart.click();
  await expect(page.getByText(/2 workers are still running/)).toBeVisible();
  await expect(restart.last()).toBeDisabled();
  assert.equal(
    await page.evaluate(() => window.calls.includes("install")),
    false,
  );
  await page.goto(url + "?mode=offline");
  await expect(page.getByRole("alert")).toContainText("unreachable");
  await expect(
    page.getByText("You’re up to date.", { exact: true }),
  ).toHaveCount(0);
  await page.goto(url + "?mode=current");
  await expect(
    page.getByText("You’re up to date.", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      scenarios: 8,
      output,
      nativeInstallPerformed: false,
      fixtureNativeApi: true,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
