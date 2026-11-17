// Real welcome/guide components in an isolated renderer fixture. No provider,
// account, terminal, graph or native OS trust claim is made by this UI check.
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".memcode/verification/install-welcome");
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  bundle: true,
  outdir: output,
  entryNames: "fixture",
  format: "esm",
  jsx: "automatic",
  define: { "import.meta.env.DEV": "false" },
  loader: { ".woff2": "file", ".woff": "file" },
  plugins: [
    {
      name: "unused-url-assets",
      setup(build) {
        build.onResolve({ filter: /\?url$/ }, (args) => ({
          path: args.path,
          namespace: "unused-url",
        }));
        build.onLoad({ filter: /.*/, namespace: "unused-url" }, () => ({
          contents: 'export default "/unused-worker.mjs";',
          loader: "js",
        }));
      },
    },
  ],
  stdin: {
    loader: "tsx",
    resolveDir: root,
    sourcefile: "install-welcome-fixture.tsx",
    contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Onboarding} from './src/components/Onboarding';import {initialState} from './src/seed';
import '@fontsource-variable/inter';import './src/styles.css';
const calls=[];window.fixtureCalls=calls;
function Fixture(){
 const [state,setState]=useState(()=>{const state=initialState();state.onboarding=JSON.parse(localStorage.getItem('welcome-fixture')||'null')||{version:1,step:'welcome',dismissed:false};return state;});
 const update=patch=>{calls.push(patch);setState(previous=>{const next={...previous,onboarding:{...previous.onboarding,...patch}};if(patch.showForNewProjects!==undefined)next.onboardingPreferences={showForNewProjects:patch.showForNewProjects};localStorage.setItem('welcome-fixture',JSON.stringify(next.onboarding));return next;});};
 window.fixture={snapshot:()=>structuredClone(state)};
 return <><div className="welcome-fixture-background"><div className="welcome-fixture-window">MemCode <span>Your local workspace</span></div><div className="welcome-fixture-blank"><strong>Your next chapter starts here.</strong><span>A clear space for your projects and workers.</span></div></div>
 <Onboarding progress={state.onboarding} state={state} project={state.projects[0]} epics={[]} connected={false} hidden={false} onUpdate={update} onAction={action=>calls.push({action})} onDocs={()=>calls.push({docs:true})} notify={()=>{}}/>
 <button id="fixture-reopen" onClick={()=>update({version:1,step:'welcome',dismissed:false})}>Reopen introduction fixture</button>
 <div className="welcome-fixture-label">Actual MemCode welcome component · UI fixture · no accounts or workers</div></>;
}createRoot(document.getElementById('root')).render(<Fixture/>);
`,
  },
});
await writeFile(
  join(output, "index.html"),
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>.welcome-fixture-window{height:38px;padding:11px 25px;border-bottom:1px solid #dbe5dc;font-size:12px;color:#55715d;display:flex;justify-content:space-between}.welcome-fixture-blank{display:grid;place-content:center;height:90vh;gap:14px;color:#a3b2a7}.welcome-fixture-blank strong{font-size:35px;font-weight:450;letter-spacing:-1px}.welcome-fixture-blank span{text-align:center;font-size:13px}.welcome-fixture-label{position:fixed;bottom:9px;left:15px;color:#6d8776;font-size:8px;z-index:200;pointer-events:none}#fixture-reopen{position:fixed;bottom:10px;right:20px;font-size:10px}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const file =
      path.startsWith("/guide/") || path.startsWith("/adapters/")
        ? join(root, "public", path)
        : join(output, basename(path) || "index.html");
    res.setHeader(
      "content-type",
      {
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      }[extname(file)] ?? "text/html",
    );
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
if (process.argv.includes("--preview")) {
  console.log(
    JSON.stringify({
      preview: url,
      fixture:
        "Actual welcome component; isolated synthetic profile; no accounts or workers",
      stop: "Ctrl+C",
    }),
  );
  await new Promise((done) => process.once("SIGINT", done));
  await new Promise((done) => server.close(done));
  process.exit(0);
}
let browser, page;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    Object.defineProperty(navigator, "userAgentData", {
      value: { platform: "macOS" },
      configurable: true,
    });
  });
  await page.clock.install();
  await page.goto(url);
  const dialog = page.getByRole("dialog", {
    name: "Make your first idea real.",
  });
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Build what comes next." }),
  ).toBeVisible();
  await expect(dialog).toContainText("⌘+K");
  await expect
    .poll(() =>
      page
        .locator(".install-welcome-screen-images img")
        .evaluateAll((images) =>
          images.every((image) => image.complete && image.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await page.screenshot({
    path: join(output, "welcome-desktop.png"),
    animations: "disabled",
  });
  console.log(
    JSON.stringify({
      phase: "preview-ready",
      screenshot: join(output, "welcome-desktop.png"),
    }),
  );
  assert.equal(
    await dialog.evaluate((e) => e.scrollWidth > e.clientWidth),
    false,
  );
  checks.push(
    "Actual welcome renders before project/provider setup, with loaded local product screenshots and macOS shortcut label",
  );
  await page.clock.fastForward(7500);
  await expect(page.locator(".install-welcome")).toHaveAttribute(
    "data-preview",
    "1",
  );
  await page
    .getByRole("button", { name: "Pause product preview", exact: true })
    .click();
  await page.clock.fastForward(15000);
  await expect(page.locator(".install-welcome")).toHaveAttribute(
    "data-preview",
    "1",
  );
  await page
    .getByRole("button", { name: "Show stay close to the work preview" })
    .click();
  await expect(page.locator(".install-welcome")).toHaveAttribute(
    "data-preview",
    "2",
  );
  checks.push(
    "Product slideshow advances, pauses and allows direct selection without starting work",
  );
  await page
    .getByRole("button", { name: "Show stay close to the work preview" })
    .press("ArrowRight");
  await expect(page.locator(".install-welcome")).toHaveAttribute(
    "data-preview",
    "3",
  );
  const reviewSlide = page.getByRole("button", { name: "Show review a change preview" });
  await expect(reviewSlide).toBeFocused();
  await expect(dialog.getByRole("heading", { name: "Decide what’s ready to ship." })).toBeVisible();
  await page.screenshot({ path: join(output, "welcome-review.png"), animations: "disabled" });
  await reviewSlide.press("ArrowRight");
  await expect(page.locator(".install-welcome")).toHaveAttribute(
    "data-preview",
    "0",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(
    page.getByRole("button", { name: /^(Pause|Play) product preview$/ }),
  ).toHaveCount(0);
  await page.clock.fastForward(30000);
  await expect(page.locator(".install-welcome")).toHaveAttribute(
    "data-preview",
    "0",
  );
  assert.equal(
    await page
      .locator(".install-welcome-screen-images img")
      .first()
      .evaluate((e) => getComputedStyle(e).transitionDuration),
    "0s",
  );
  checks.push(
    "Keyboard slide selection works and reduced-motion disables autoplay and transitions",
  );
  await page
    .getByRole("button", { name: "Let’s get started", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  assert.ok(
    (await page.evaluate(() => window.fixtureCalls)).some(
      (call) => call.step === "project",
    ),
  );
  checks.push(
    "Continue uses the existing project guide; no provider/account connection is performed",
  );
  await page.locator("#fixture-reopen").click();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await page.reload();
  await expect(page.locator(".install-welcome")).toHaveCount(0);
  await page.locator("#fixture-reopen").click();
  await expect(dialog).toBeVisible();
  checks.push(
    "Skip persists in this isolated profile and explicit reopen remains available",
  );
  await page.setViewportSize({ width: 1080, height: 740 });
  await page.screenshot({
    path: join(output, "welcome-minimum-desktop.png"),
    animations: "disabled",
  });
  assert.equal(
    await dialog.evaluate((e) => e.scrollWidth > e.clientWidth),
    false,
  );
  await page.setViewportSize({ width: 620, height: 860 });
  await page.screenshot({
    path: join(output, "welcome-narrow.png"),
    animations: "disabled",
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  checks.push(
    "Minimum desktop and narrow fallback have no horizontal overflow",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        status: "passed",
        fixture:
          "Actual welcome/Onboarding components; synthetic profile persistence only; no native installation/Gatekeeper claim",
        checks,
        errors,
        url,
      },
      null,
      2,
    ) + "\n",
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
    JSON.stringify({ error: String(error), checks, errors }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
