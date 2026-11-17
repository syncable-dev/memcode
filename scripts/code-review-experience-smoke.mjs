// Presentation fixture: real React components; simulated review API. No provider or source edits.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd(),
  out = resolve(root, "tmp/code-review-experience-evidence");
await mkdir(out, { recursive: true });
const now = new Date().toISOString();
const task = {
  id: "review-fixture",
  projectId: "fixture",
  identifier: "MC-UI",
  title: "Review the invitation flow",
  stage: "review",
  harness: "claude",
  run: { state: "finished" },
  checklist: [],
  messages: [],
};
const matched = {
  status: "matched",
  beforeSourceHash: "a".repeat(64),
  afterSourceHash: "b".repeat(64),
  metricsVersion: 1,
  qualityMetricsVersion: 1,
};
const sample = {
  version: 1,
  id: "sample-review",
  taskId: task.id,
  implementationRunIds: [],
  createdAt: now,
  updatedAt: now,
  completedAt: now,
  state: "completed",
  outcome: "changes-requested",
  phases: ["capture", "review", "quality", "impact", "verification"].map(
    (id) => ({ id, state: "complete" }),
  ),
  snapshot: {
    id: "sample-snapshot",
    patchHash: "sample-patch",
    journalRevision: "fixture",
    branch: "epic/invitations",
    commit: "fixture",
    sourceRevision: "fixture",
    graphRevision: "fixture",
    files: [{ path: "src/invitations.ts", attribution: "reservation" }],
    additions: 35,
    deletions: 22,
  },
  engine: { version: "Presentation fixture · not live" },
  coverage: { complete: true, limitations: [] },
  findingDispositions: [],
  findings: [
    {
      id: "f1",
      evidenceHash: "f1-hash",
      title: "Preserve the invitation during sign-in",
      explanation:
        "An expired sign-in clears the invitation before the connection succeeds.",
      severity: "high",
      category: "correctness",
      path: "src/invitations.ts",
      line: 48,
      evidenceData: {
        observation:
          "The invitation is cleared before the connection succeeds.",
      },
    },
    {
      id: "f2",
      evidenceHash: "f2-hash",
      title: "Separate validation from connection",
      explanation:
        "Keep validation independent from the authentication transition.",
      severity: "medium",
      category: "maintainability",
      path: "src/invitations.ts",
      line: 80,
    },
  ],
  metrics: [
    {
      symbol: "removedHelper",
      path: "src/invitations.ts",
      source: "ast",
      cognitive: null,
      cyclomatic: null,
      nesting: null,
      maintainabilityIndex: null,
      before: {
        line: 10,
        cognitive: 5,
        cyclomatic: 3,
        nesting: 2,
        maintainabilityIndex: 65,
      },
      comparison: {
        status: "removed",
        reason: "The declaration was removed in the captured change.",
      },
    },
    {
      symbol: "acceptInvitation",
      path: "src/invitations.ts",
      line: 35,
      cognitive: 4,
      cyclomatic: 3,
      nesting: 1,
      maintainabilityIndex: 84,
      source: "ast",
      before: {
        cognitive: 18,
        cyclomatic: 9,
        nesting: 3,
        maintainabilityIndex: 62,
      },
      comparison: matched,
    },
    {
      symbol: "validateDestination",
      path: "src/invitations.ts",
      line: 85,
      cognitive: 0,
      cyclomatic: 1,
      nesting: 0,
      maintainabilityIndex: 90,
      source: "ast",
      before: {
        cognitive: 0,
        cyclomatic: 1,
        nesting: 0,
        maintainabilityIndex: 90,
      },
      comparison: matched,
    },
    {
      symbol: "newBoundary",
      path: "src/invitations.ts",
      line: 100,
      cognitive: 1,
      cyclomatic: 2,
      nesting: 1,
      maintainabilityIndex: 80,
      source: "ast",
      comparison: {
        status: "added",
        reason: "This declaration was added in the captured change.",
      },
    },
  ],
  impact: { symbols: 12, files: 5, processes: 2, complete: true },
  checks: [
    {
      name: "Invitation lifecycle",
      state: "passed",
      detail: "7 checks passed",
    },
  ],
  messages: [],
};
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {CodeReview} from ${JSON.stringify(resolve(root, "src/components/CodeReview.tsx"))};import ${JSON.stringify(resolve(root, "src/styles.css"))};
const sample=${JSON.stringify(sample)},baseTask=${JSON.stringify(task)},app=createRoot(document.getElementById('root'));let task=baseTask,run=JSON.parse(localStorage.getItem('review')||'null')||structuredClone(sample),canStart=true;window.fixtureEvents=[];
const save=()=>{run.updatedAt=new Date().toISOString();localStorage.setItem('review',JSON.stringify(run));return structuredClone(run)};
const decision=(id,status,reason,explanation)=>{const finding=run.findings.find(f=>f.id===id);run.findingDispositions.push({id:crypto.randomUUID(),findingId:id,status,reason,explanation,at:new Date().toISOString(),actor:{id:'fixture-user',name:'Sample reviewer',source:'local'},snapshotId:run.snapshot.id,patchHash:run.snapshot.patchHash,evidenceHash:finding.evidenceHash});const active=run.findings.filter(f=>run.findingDispositions.findLast(d=>d.findingId===f.id)?.status!=='dismissed');run.outcome=active.length||run.checks.some(c=>c.state==='failed')?'changes-requested':run.coverage.complete?'ready':'incomplete';window.fixtureEvents.push({status,id});return save()};
window.memcode={getCodeReview:async id=>structuredClone(id===task.id?run:sample),startCodeReview:async()=>save(),cancelCodeReview:async()=>{},dismissCodeReviewFinding:async(t,r,id,reason,text)=>{if(window.fixtureDefer){const original=structuredClone(run);await new Promise(done=>window.fixtureResolve=done);window.fixtureDefer=false;return original}return decision(id,'dismissed',reason,text)},reopenCodeReviewFinding:async(t,r,id)=>decision(id,'reopened'),sendCodeReviewMessage:async()=>save(),requestCodeReviewFixes:async(t,r,ids)=>window.fixtureEvents.push({fixes:ids}),acceptCodeReview:async()=>window.fixtureEvents.push({accept:true})};
const render=()=>app.render(<><div className='fixture-label'>ISOLATED UI VERIFICATION · SAMPLE MEASUREMENTS · NOT A LIVE REVIEW</div><div className='fixture-card'><header><span>MemCode / MC-UI</span><h2>Review the invitation flow</h2><nav>Changes <b>Code review</b> Artifacts</nav></header><CodeReview task={{...task,codeReview:{runId:run.id,updatedAt:run.updatedAt}}} canStartReview={canStart} notify={()=>{}} onOpenSource={(path,line)=>window.fixtureEvents.push({path,line})} onOpenChanges={()=>window.fixtureEvents.push({changes:true})}/></div></>);
window.fixtureScenario=name=>{task=name==='another-card'?{...baseTask,id:'another-card'}:baseTask;run=structuredClone(sample);run.id='sample-'+name;run.taskId=task.id;canStart=name!=='acceptance';if(name==='another-card'){run.snapshot.id='second-card-snapshot';run.findings=[];run.outcome='ready'}if(name==='failed')run.checks=[{name:'Invitation lifecycle',state:'failed',detail:'One real check is represented as failed in this fixture.'}];if(name==='partial'){run.coverage.complete=false;run.coverage.limitations=['An affected consumer could not be measured.'];run.outcome='incomplete'}save();render()};render();`;
await build({
  stdin: { contents: entry, resolveDir: root, loader: "tsx" },
  outfile: resolve(out, "fixture.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  loader: { ".woff2": "dataurl" },
  logLevel: "silent",
});
await writeFile(
  resolve(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{padding:24px;background:#edf3ee}.fixture-label{font:9px Consolas;color:#8c7761;text-align:center;margin-bottom:16px;letter-spacing:1px}.fixture-card{height:calc(100vh - 70px);display:flex;flex-direction:column;background:white;border:1px solid #d8e4d9;border-radius:14px;overflow:hidden}.fixture-card>header{padding:18px 30px;border-bottom:1px solid #e2eadd}.fixture-card>header>span{font-size:10px;color:#849a87}.fixture-card h2{font-size:24px;font-weight:500;letter-spacing:-.8px;margin:15px 0}.fixture-card nav{display:flex;gap:25px;font-size:11px;color:#849c8b}.fixture-card nav b{font-weight:500;color:#356b54}.code-review-workspace{min-height:0}</style><div id="root"></div><script type="module" src="/fixture.js"></script>`,
);
const server = createServer(async (req, res) => {
  try {
    const file =
      req.url === "/fixture.js"
        ? "fixture.js"
        : req.url === "/fixture.css"
          ? "fixture.css"
          : "index.html";
    res.setHeader(
      "Content-Type",
      file.endsWith("js")
        ? "text/javascript"
        : file.endsWith("css")
          ? "text/css"
          : "text/html",
    );
    res.end(await readFile(resolve(out, file)));
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const executablePath =
  process.env.MEMCODE_BROWSER_EXECUTABLE ??
  (process.platform === "win32"
    ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
    : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
const result = { fixture: true, assertions: [], passed: false };
try {
  const page = await browser.newPage({
    viewport: { width: 1460, height: 1040 },
  });
  const scenario = (name) =>
    page.evaluate(async (name) => {
      window.fixtureScenario(name);
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
    }, name);
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page
    .getByRole("heading", { name: "A few things to resolve.", exact: true })
    .waitFor();
  await page
    .getByText("Before & after", { exact: true })
    .scrollIntoViewIfNeeded();
  assert.match(
    await page.locator(".review-comparison-caption").innerText(),
    /2 compared · 3 current/,
  );
  assert.match(
    await page.locator(".review-comparison-grid").first().innerText(),
    /11/,
  ); // (62+90)/2=76 to (84+90)/2=87
  await page.locator(".code-review-scroll").evaluate((el) => {
    const panel = el
      .querySelector(".review-quality-comparison")
      .closest(".code-review-panel");
    el.scrollTop = panel.offsetTop - el.offsetTop - 15;
  });
  await page.screenshot({ path: resolve(out, "quality-comparison.png") });
  result.assertions.push(
    "Paired native means, directions and separate new functions are visible",
  );
  await page.locator(".review-function-details > summary").click();
  await page
    .locator(".review-function-list summary")
    .filter({ hasText: "newBoundary" })
    .click();
  await page
    .getByText("This declaration was added in the captured change.", {
      exact: true,
    })
    .first()
    .waitFor();
  result.assertions.push(
    "Function detail exposes a new declaration without inventing its baseline",
  );
  await page
    .locator(".review-function-list summary")
    .filter({ hasText: "removedHelper" })
    .click();
  await page
    .getByRole("button", { name: "View captured changes", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() =>
      window.fixtureEvents.some((event) => event.changes === true),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() => window.fixtureEvents.some((event) => event.path)),
    false,
  );
  result.assertions.push(
    "A removed function exposes baseline measurements and captured changes without opening a missing current declaration",
  );
  await page
    .getByRole("checkbox", { name: /Select finding: Preserve/ })
    .check();
  await page
    .getByRole("button", { name: /Preserve the invitation during sign-in/ })
    .click();
  await page
    .getByRole("button", { name: "Dismiss with reason", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Save dismissal", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByLabel("Your explanation", { exact: true })
    .fill(
      "The invitation is retained by the caller; verified against the captured flow.",
    );
  await page
    .getByRole("button", { name: "Save dismissal", exact: true })
    .click();
  await page.locator(".review-dismissed-findings").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Request fixes", exact: true })
      .count(),
    0,
  );
  await page.locator(".review-dismissed-finding > summary").click();
  await page
    .getByText(
      "The invitation is retained by the caller; verified against the captured flow.",
      { exact: true },
    )
    .waitFor();
  await page.locator(".review-finding-decision.saved").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(out, "saved-dismissal.png") });
  result.assertions.push(
    "Dismissal requires explanation, preserves evidence and clears fix selection",
  );
  await page.reload();
  await page.locator(".review-dismissed-findings > summary").click();
  await page.locator(".review-dismissed-finding > summary").click();
  await page.getByText("Sample reviewer", { exact: false }).first().waitFor();
  await page
    .getByRole("button", { name: "Reopen finding", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: /Select finding: Preserve/ })
    .waitFor();
  assert.equal(
    await page
      .getByRole("checkbox", { name: /Select finding: Preserve/ })
      .isChecked(),
    false,
  );
  result.assertions.push(
    "Saved decision survives reload; reopening restores active finding without selecting it",
  );
  const dismissAll = async () => {
    for (const name of [
      "Preserve the invitation during sign-in",
      "Separate validation from connection",
    ]) {
      const title = page.getByRole("button", { name: new RegExp(name) });
      if ((await title.getAttribute("aria-expanded")) !== "true")
        await title.click();
      await page
        .getByRole("button", { name: "Dismiss with reason", exact: true })
        .click();
      await page
        .getByLabel("Your explanation", { exact: true })
        .fill("Explicit review decision for this captured evidence.");
      await page
        .getByRole("button", { name: "Save dismissal", exact: true })
        .click();
    }
  };
  await scenario("failed");
  await dismissAll();
  await page.getByText("A recorded check failed", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Ready for acceptance", exact: true })
      .count(),
    0,
  );
  result.assertions.push(
    "All findings dismissed does not hide failed checks or expose Ready for acceptance",
  );
  await scenario("acceptance");
  await page
    .getByRole("button", { name: /Preserve the invitation during sign-in/ })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Dismiss with reason", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Review again", exact: true })
      .isDisabled(),
    true,
  );
  result.assertions.push(
    "Acceptance keeps results readable but new review and decision mutations disabled",
  );
  for (const width of [1100, 620]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const composer = await page.locator(".code-review-composer").boundingBox();
    assert.ok(composer && composer.y + composer.height <= 851);
    await page.screenshot({ path: resolve(out, `review-${width}.png`) });
  }
  assert.deepEqual(failures, []);
  result.assertions.push(
    "Compact and narrow layouts keep the reviewer composer visible without horizontal overflow",
  );
  await page.setViewportSize({ width: 1460, height: 1040 });
  await page.evaluate(async () => {
    window.fixtureScenario("delayed");
    window.fixtureDefer = true;
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    );
  });
  const delayedFinding = page.getByRole("button", {
    name: /Preserve the invitation during sign-in/,
  });
  if ((await delayedFinding.getAttribute("aria-expanded")) !== "true")
    await delayedFinding.click();
  await page
    .getByRole("button", { name: "Dismiss with reason", exact: true })
    .click();
  await page
    .getByLabel("Your explanation", { exact: true })
    .fill("Delayed save while switching to another card.");
  await page
    .getByRole("button", { name: "Save dismissal", exact: true })
    .click();
  await page.waitForFunction(() => typeof window.fixtureResolve === "function");
  await scenario("another-card");
  await page
    .getByRole("heading", { name: "Ready for your final look.", exact: true })
    .waitFor();
  await page.evaluate(() => window.fixtureResolve());
  await page.waitForFunction(() => !window.fixtureDefer);
  assert.match(
    await page.locator(".code-review-evidence-line").innerText(),
    /second-card-/,
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: /Select finding: Preserve/ })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Review again", exact: true })
      .isDisabled(),
    false,
  );
  result.assertions.push(
    "A delayed dismissal cannot paint the previous review into a different card or leave it busy",
  );
  result.passed = true;
} catch (error) {
  result.error = error.message;
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await writeFile(
    resolve(out, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...result, directory: out }, null, 2));
}
