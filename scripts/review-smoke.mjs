import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { initialState } from "../src/seed.ts";
import { WorkerChangeJournal } from "../runtime/changes.ts";
import { git } from "../runtime/local.ts";
import { nativeEnv, nativeBinary } from "./tauri-env.mjs";
import { connectWorkerPages } from "./worker-pages.mjs";

const fixtureDirectory = resolve(
  process.env.MEMCODE_REVIEW_FIXTURE_DIR ?? "tmp/verification-fixtures",
);
const requiredFixtures = [
  "codex-mission-planner.xlsx",
  "claude-creative-brief.docx",
  "cursor-field-notes.pptx",
  "review-guide.pdf",
  "review-tone.wav",
];
for (const name of requiredFixtures)
  await access(join(fixtureDirectory, name)).catch(() => {
    throw Error(
      `Missing ${name}. Prepare your own viewer fixtures in tmp/verification-fixtures or set MEMCODE_REVIEW_FIXTURE_DIR; see docs/review-and-previews.md.`,
    );
  });

const profile = await mkdtemp(join(tmpdir(), "memcode-review-smoke-")),
  root = join(profile, "project"),
  state = initialState(),
  taskId = "review-qa",
  projectId = "review-studio";
await mkdir(root, { recursive: true });
await git(root, ["init", "--initial-branch=main"]);
const web = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    '<title>Card link preview</title><h1>The card browser opened</h1><input aria-label="Keep my input">',
  );
});
await new Promise((done) => web.listen(0, "127.0.0.1", done));
const webURL = `http://127.0.0.1:${web.address().port}/`;
const unavailable = createServer();
await new Promise((done) => unavailable.listen(0, "127.0.0.1", done));
const deadURL = `http://127.0.0.1:${unavailable.address().port}/`;
await new Promise((done) => unavailable.close(done));
const project = {
  ...state.projects[0],
  id: projectId,
  name: "Review Studio",
  path: root,
  example: false,
  analysis: "idle",
  branch: "main",
};
const task = {
  ...state.tasks[0],
  id: taskId,
  projectId,
  title: "Review files, documents and media",
  description: "Local viewer fixtures. No coding worker runs in this check.",
  example: false,
  stage: "review",
  harness: "codex",
  assignment: "manual",
  scope: ["sample.ts"],
  run: { state: "finished", workspace: root, branch: "main" },
  messages: [
    {
      id: "intro",
      role: "assistant",
      at: new Date().toISOString(),
      text: `Open [the project notes](notes.md) or [the source file](sample.ts:2). Saved documents, media and reports are in Artifacts. Open [the live preview](${webURL}) or [the stopped preview](${deadURL}).`,
    },
  ],
};
state.projects = [project];
state.tasks = [task];
state.epics = [];
state.artifacts = [];
state.activeProjectId = projectId;
await writeFile(
  join(root, "sample.ts"),
  "export const heading = 'Draft';\nexport const revision = 1;\n",
);
const journal = new WorkerChangeJournal();
await journal.begin(project, task);
await writeFile(
  join(root, "sample.ts"),
  "export const heading = 'Review in context';\nexport const revision = 2;\n",
);
await journal.release(project, task);
await writeFile(
  join(root, "notes.md"),
  "# Project notes\n\nSelect this paragraph to leave precise feedback.\n\n[Read the source](sample.ts:2)\n\n| Surface | Action |\n| --- | --- |\n| Document | Quote and comment |\n",
);
const outputs = join(root, ".memcode", "workers", taskId, "artifacts");
await mkdir(outputs, { recursive: true });
for (const name of requiredFixtures)
  await copyFile(join(fixtureDirectory, name), join(outputs, name));
await copyFile(join(root, "notes.md"), join(outputs, "review-notes.md"));
await writeFile(
  join(outputs, "review-page.html"),
  '<!doctype html><html><head><title>Element review fixture</title><style>body{margin:0;background:#f7faf3;color:#163b28;font:20px system-ui;padding:70px}#review-card{background:white;border:1px solid #cee2c8;border-radius:14px;padding:35px;max-width:600px}h1{font-size:32px}input{font:inherit;padding:10px}</style></head><body><div id="review-card"><h1>Review the actual element</h1><p>Precise selection, clear feedback.</p></div><p><input aria-label="Editable copy" value="Draft wording for review"></p></body></html>',
);
for (const name of [
  "review-guide.pdf",
  "review-tone.wav",
  "review-clip.webm",
  "review-notes.md",
  "review-page.html",
  "codex-mission-planner.xlsx",
  "claude-creative-brief.docx",
  "cursor-field-notes.pptx",
])
  state.artifacts.push({
    id: name,
    name,
    path: join(outputs, name),
    taskId,
    projectId,
    kind: name.endsWith(".html") ? "html" : "text",
    source: "Local viewer test fixture",
    createdAt: new Date().toISOString(),
  });
await writeFile(join(profile, "workspace.json"), JSON.stringify(state));
const port = 9334,
  child = spawn(nativeBinary(), [], {
    env: nativeEnv({
      MEMCODE_DATA_DIR: profile,
      MEMCODE_APP_PATH: resolve("."),
      MEMCODE_SERVICE_PATH: resolve("dist-runtime/service.cjs"),
      MEMCODE_NATIVE_TEST_PROFILE: "1",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    }),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
let diagnostics = "",
  browser,
  main;
child.stderr.on(
  "data",
  (data) => (diagnostics = (diagnostics + data).slice(-10000)),
);
const exited = new Promise((done) => child.once("exit", done));
const call = (method, ...args) =>
  main.evaluate(({ method, args }) => window.memcode[method](...args), {
    method,
    args,
  });
const click = (locator) => locator.evaluate((element) => element.click());
const report = {
  profile,
  result: "running",
  checks: [],
  fixtures: "Local fixtures; Office files copied from real worker outputs",
};
const evidence = resolve("../tmp/memcode-review/review-interactions");
await mkdir(evidence, { recursive: true });
async function guest() {
  let view;
  await expect
    .poll(
      () => {
        view = browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => /\/p\/[^/]+\/index.html/.test(p.url()));
        return view?.url();
      },
      { timeout: 15000 },
    )
    .toBeTruthy();
  await expect(view.locator(".viewer-selection")).toBeVisible({
    timeout: 15000,
  });
  return view;
}
async function artifact(name) {
  await click(
    main.getByRole("dialog").getByRole("button", { name: /^Artifacts/ }),
  );
  if (
    await main
      .getByRole("button", { name: "All artifacts", exact: true })
      .count()
  )
    await click(
      main.getByRole("button", { name: "All artifacts", exact: true }),
    );
  await click(
    main
      .getByRole("dialog")
      .getByRole("button")
      .filter({ hasText: name })
      .first(),
  );
  if (name.endsWith(".html")) {
    let page;
    await expect
      .poll(() => {
        page = browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().includes("/p/") && p.url().endsWith("/" + name));
        return !!page;
      })
      .toBeTruthy();
    await expect(page.locator(".viewer-selection")).toBeVisible({
      timeout: 15000,
    });
    return page;
  }
  return guest();
}
async function select(view, selector, needle) {
  const quote = await view
    .locator(selector)
    .first()
    .evaluate((element, needle) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const index = node.textContent.indexOf(needle);
        if (index >= 0) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return selection.toString();
        }
      }
      throw Error("Selection text not found: " + needle);
    }, needle);
  assert.equal(quote, needle);
  await expect(
    view.getByRole("button", { name: "Comment on selection", exact: true }),
  ).toBeEnabled();
  await click(
    view.getByRole("button", { name: "Copy selection", exact: true }),
  );
  await expect(view.locator(".viewer-selection>span")).toHaveText("Copied");
}
async function comment(view, expected, kind, extra = {}) {
  const before = (await call("load")).state.tasks.find(
    (task) => task.id === taskId,
  ).messages.length;
  if (!(await main.getByRole("region", { name: "New annotation" }).count()))
    await click(
      view.getByRole("button", { name: "Comment on selection", exact: true }),
    );
  await expect(
    main.getByRole("region", { name: "New annotation" }),
  ).toContainText(expected, { timeout: 5000 });
  const text = "Viewer QA: please clarify the selected " + kind + ".";
  await main
    .getByRole("textbox", { name: "Review comment", exact: true })
    .fill(text);
  await click(main.getByRole("button", { name: "Save comment", exact: true }));
  await expect(
    main.getByRole("region", { name: "New annotation" }),
  ).toHaveCount(0);
  const { state } = await call("load"),
    note = state.reviewComments.at(-1),
    reference = note.reference;
  assert.equal(
    state.tasks.find((task) => task.id === taskId).messages.length,
    before,
    "Saving must not add a conversation message",
  );
  assert.equal(note.status, "saved");
  assert.ok(reference);
  assert.equal(reference.quote, expected);
  for (const [key, value] of Object.entries(extra))
    assert.equal(reference[key], value);
  await expect(
    view.locator(`[data-comment-id="${note.id}"] .annotation-rect`).first(),
  ).toBeVisible({ timeout: 10000 });
  await click(view.locator(`[data-comment-id="${note.id}"] .annotation-pin`));
  await expect(
    main.getByRole("region", { name: "Saved review comments" }),
  ).toContainText(text);
  await click(
    main.getByRole("button", { name: "Close comments", exact: true }),
  );
  await view.evaluate(() => {
    window.__reviewReloadMarker = "before";
  });
  await call("previewAction", "reload");
  await expect
    .poll(() =>
      view.evaluate(() => window.__reviewReloadMarker).catch(() => "loading"),
    )
    .toBeUndefined();
  await expect(
    view.locator(`[data-comment-id="${note.id}"] .annotation-rect`).first(),
  ).toBeVisible({ timeout: 15000 });
  report.checks.push({
    kind,
    quote: expected,
    annotationId: note.id,
    savedWithoutSending: true,
    persistentHighlight: true,
    ...extra,
  });
}
try {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      if (child.exitCode !== null) throw Error(diagnostics);
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  assert.ok(browser);
  await expect
    .poll(() => {
      main = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("tauri.localhost"));
      return !!main;
    })
    .toBeTruthy();
  await main.waitForFunction(() => !!window.memcode);
  // Encode an actual WebM using the system browser's media encoder, without adding a product dependency.
  const encoded = await main.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const context = canvas.getContext("2d"),
      stream = canvas.captureStream(20),
      mime = ["video/webm;codecs=vp8", "video/webm"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
    const recorder = new MediaRecorder(stream, { mimeType: mime }),
      parts = [];
    recorder.ondataavailable = (e) => parts.push(e.data);
    const complete = new Promise(
      (done) =>
        (recorder.onstop = async () => {
          const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
          let raw = "";
          for (let offset = 0; offset < bytes.length; offset += 8192)
            raw += String.fromCharCode(
              ...bytes.subarray(offset, offset + 8192),
            );
          done(btoa(raw));
        }),
    );
    const start = performance.now(),
      draw = () => {
        const time = (performance.now() - start) / 1000;
        context.fillStyle = "#0b2419";
        context.fillRect(0, 0, 960, 540);
        context.fillStyle = "#71e0b6";
        context.font = "16px sans-serif";
        context.fillText("MEMCODE / MEDIA REVIEW", 70, 80);
        context.fillStyle = "#f1f8ef";
        context.font = "54px sans-serif";
        context.fillText("Every frame, in context.", 70, 210);
        context.fillStyle = "#8ab39d";
        context.font = "22px sans-serif";
        context.fillText("Local playback. Precise follow-ups.", 70, 263);
        context.fillStyle = "#57d8af";
        context.fillRect(70, 355, Math.min(820, (time / 2) * 820), 6);
        context.font = "17px monospace";
        context.fillText(time.toFixed(1) + " s", 70, 410);
      };
    draw();
    recorder.start();
    const interval = setInterval(draw, 40);
    await new Promise((done) => setTimeout(done, 2200));
    clearInterval(interval);
    recorder.stop();
    stream.getTracks().forEach((track) => track.stop());
    return complete;
  });
  await writeFile(
    join(outputs, "review-clip.webm"),
    Buffer.from(encoded, "base64"),
  );
  await click(main.getByRole("button", { name: "Conversations", exact: true }));
  await click(main.getByRole("button").filter({ hasText: task.title }).first());
  await click(
    main.getByRole("link", { name: "the project notes", exact: true }),
  );
  let view = await guest();
  await expect(view.locator(".markdown-document h1")).toHaveText(
    "Project notes",
  );
  await select(
    view,
    ".markdown-document",
    "Select this paragraph to leave precise feedback.",
  );
  await comment(
    view,
    "Select this paragraph to leave precise feedback.",
    "project markdown",
    { kind: "file" },
  );
  await click(view.getByRole("link", { name: "Read the source", exact: true }));
  view = await guest();
  await expect(view.locator(".source-line.active")).toHaveAttribute(
    "data-code-line",
    "2",
  );
  await click(
    view.getByRole("button", { name: "Comment on line 2", exact: true }),
  );
  await comment(view, "export const revision = 2;", "source file", {
    lineStart: 2,
    lineEnd: 2,
  });
  view = await artifact("review-notes.md");
  await select(
    view,
    ".markdown-document",
    "Select this paragraph to leave precise feedback.",
  );
  await comment(
    view,
    "Select this paragraph to leave precise feedback.",
    "markdown artifact",
    { kind: "artifact", artifactId: "review-notes.md" },
  );
  view = await artifact("claude-creative-brief.docx");
  await expect(view.locator(".docx-wrapper")).toContainText(
    "Atelier creative brief",
    { timeout: 15000 },
  );
  await select(view, ".docx-wrapper", "Atelier creative brief");
  await view.screenshot({ path: join(evidence, "word-selection.png") });
  await comment(view, "Atelier creative brief", "Word", { page: 1 });
  view = await artifact("codex-mission-planner.xlsx");
  await expect(view.locator(".sheet-grid")).toContainText(
    "ORBIT MISSION PLANNER",
    { timeout: 15000 },
  );
  await click(view.getByRole("tab", { name: "Destinations", exact: true }));
  await expect(view.locator(".sheet-grid")).toContainText("Mars");
  await view
    .locator(".sheet-grid tbody tr")
    .nth(1)
    .locator("td")
    .first()
    .dispatchEvent("mousedown", { button: 0, buttons: 1 });
  await expect(view.locator(".sheet-formula strong")).toHaveText("A2");
  await view
    .locator(".sheet-grid tbody tr")
    .nth(2)
    .locator("td")
    .nth(1)
    .dispatchEvent("mouseover", { buttons: 1 });
  await expect(view.locator(".sheet-formula strong")).toHaveText("A2:B3");
  const quote = await view
    .locator(".viewer-selection>span")
    .getAttribute("title");
  await view.screenshot({ path: join(evidence, "sheet-selection.png") });
  await comment(view, quote, "Excel", {
    sheet: "Destinations",
    cells: "A2:B3",
  });
  view = await artifact("review-guide.pdf");
  await expect(view.locator(".pdf-page .textLayer")).toContainText(
    "Select this sentence",
    { timeout: 20000 },
  );
  await select(
    view,
    ".textLayer",
    "Select this sentence to ask for clearer wording.",
  );
  await view.screenshot({ path: join(evidence, "pdf-selection.png") });
  await comment(
    view,
    "Select this sentence to ask for clearer wording.",
    "PDF",
    { page: 1 },
  );
  await click(view.getByRole("button", { name: "Next page", exact: true }));
  await expect(view.locator(".textLayer")).toContainText(
    "Review changes before accepting",
  );
  await click(view.getByRole("button", { name: "Zoom in", exact: true }));
  await expect(
    view.getByRole("button", { name: "Fit PDF width", exact: true }),
  ).toHaveText("125%");
  report.checks.push({ kind: "PDF navigation and zoom", page: 2 });
  view = await artifact("review-clip.webm");
  await expect
    .poll(() => view.locator("video").evaluate((video) => video.readyState))
    .toBeGreaterThan(0);
  await view.locator("video").evaluate(async (video) => {
    await video.play();
    await new Promise((done, reject) => {
      video.addEventListener("ended", done, { once: true });
      setTimeout(() => reject(Error("Video did not play")), 10000);
    });
    video.currentTime = 0.6;
    await new Promise((done) =>
      video.addEventListener("seeked", done, { once: true }),
    );
    video.pause();
  });
  assert.ok((await view.locator("video").evaluate((v) => v.currentTime)) > 0.4);
  await view.screenshot({ path: join(evidence, "video-playback.png") });
  report.checks.push({ kind: "video playback and seek" });
  await click(
    view.getByRole("button", { name: "Comment at current time", exact: true }),
  );
  await comment(view, "review-clip.webm at 0.6 seconds", "video timestamp", {
    selectionType: "time",
    time: 0.6,
  });
  view = await artifact("review-tone.wav");
  await expect
    .poll(() => view.locator("audio").evaluate((audio) => audio.duration))
    .toBeGreaterThan(1);
  await view.locator("audio").evaluate(async (audio) => {
    await audio.play();
    audio.pause();
    audio.currentTime = 0.5;
  });
  report.checks.push({ kind: "audio playback" });
  await click(
    main
      .getByRole("dialog")
      .getByRole("button", { name: "Changes", exact: true }),
  );
  await expect(main.locator(".change-line.add")).toHaveCount(2);
  await click(
    main.getByRole("button", { name: "Select changed line 1", exact: true }),
  );
  await expect(
    main.getByRole("button", { name: "Comment", exact: true }),
  ).toBeEnabled();
  await click(
    main.getByRole("button", { name: "Copy selection", exact: true }),
  );
  await expect(main.locator(".selection-actions svg.lucide-check")).toHaveCount(
    1,
  );
  await click(main.getByRole("button", { name: "Comment", exact: true }));
  await main
    .getByRole("textbox", { name: "Review comment", exact: true })
    .fill("Viewer QA: keep this heading concise.");
  await click(main.getByRole("button", { name: "Save comment", exact: true }));
  const diffNote = (await call("load")).state.reviewComments.at(-1),
    diff = diffNote.reference;
  assert.equal(diff.kind, "changes");
  assert.equal(diff.side, "after");
  assert.equal(diff.lineStart, 1);
  assert.ok(diff.checkpointId);
  report.checks.push({ kind: "diff comment", checkpoint: diff.checkpointId });
  await click(
    main
      .getByRole("dialog")
      .getByRole("button", { name: "Terminal", exact: true }),
  );
  const listed = await call("terminal", taskId, { action: "list" });
  const session = (
    await call("terminal", taskId, {
      action: "start",
      shellId: listed.shells[0].id,
      label: "Review QA terminal",
    })
  ).session;
  await call("terminal", taskId, {
    action: "write",
    sessionId: session.id,
    data: "Write-Output 'Terminal review target.'",
    submit: true,
  });
  await expect(main.locator(".xterm-rows")).toContainText(
    "Terminal review target.",
    { timeout: 15000 },
  );
  const row = main
    .locator(".xterm-rows>div")
    .filter({ hasText: /^Terminal review target\.\s*$/ })
    .first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  await main.mouse.dblclick(box.x + 28, box.y + box.height / 2);
  await expect(
    main.getByRole("button", { name: "Comment", exact: true }),
  ).toBeEnabled();
  await click(main.getByRole("button", { name: "Comment", exact: true }));
  await main
    .getByRole("textbox", { name: "Review comment", exact: true })
    .fill("Viewer QA: explain the selected terminal output.");
  await click(main.getByRole("button", { name: "Save comment", exact: true }));
  const terminalNote = (await call("load")).state.reviewComments.at(-1),
    terminal = terminalNote.reference;
  assert.equal(terminal.kind, "terminal");
  assert.equal(terminal.sessionId, session.id);
  await call("terminal", taskId, { action: "close", sessionId: session.id });
  report.checks.push({
    kind: "terminal selection comment",
    quote: terminal.quote,
  });
  assert.equal(await view.evaluate(() => !!window.memcode), false);
  view = await artifact("review-page.html");
  const elementQuote = (await view.locator("#review-card").innerText()).trim();
  await click(
    view.getByRole("button", { name: "Select element or area", exact: true }),
  );
  await view
    .locator("#review-card")
    .dispatchEvent("mousedown", { button: 0, clientX: 120, clientY: 120 });
  await view
    .locator("#review-card")
    .dispatchEvent("mouseup", { button: 0, clientX: 120, clientY: 120 });
  await comment(view, elementQuote, "HTML element", {
    selectionType: "element",
    selector: "#review-card",
  });
  await click(
    view.getByRole("button", { name: "Select element or area", exact: true }),
  );
  await view
    .locator("#review-card")
    .dispatchEvent("mousedown", { button: 0, clientX: 140, clientY: 140 });
  await view
    .locator("#review-card")
    .dispatchEvent("mouseup", { button: 0, clientX: 260, clientY: 200 });
  const areaQuote = await main
    .locator(".review-reference blockquote")
    .textContent();
  await comment(view, areaQuote, "HTML area", {
    selectionType: "area",
    selector: "#review-card",
  });
  await view
    .getByRole("textbox", { name: "Editable copy" })
    .evaluate((input) => {
      input.focus();
      input.setSelectionRange(0, 5);
      input.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }),
      );
    });
  await comment(view, "Draft", "text field position", {
    selectionType: "text",
    startOffset: 0,
    endOffset: 5,
  });
  await view.screenshot({ path: join(evidence, "saved-html-annotations.png") });
  const beforeSharing = (await call("load")).state,
    annotation = beforeSharing.reviewComments[0],
    beforeMessages = beforeSharing.tasks[0].messages.length;
  await call(
    "shareReviewComments",
    taskId,
    [annotation.id],
    "Please address the selected comment.",
  );
  const afterSharing = (await call("load")).state;
  assert.equal(afterSharing.tasks[0].messages.length, beforeMessages + 1);
  assert.equal(
    afterSharing.reviewComments.find((c) => c.id === annotation.id).status,
    "shared",
  );
  assert.ok(afterSharing.reviewComments.some((c) => c.status === "saved"));
  assert.equal(afterSharing.tasks[0].run.state, "finished");
  report.checks.push({
    kind: "explicit follow-up sends only selected annotations; saving and sharing never start a worker",
  });
  await click(
    main
      .getByRole("dialog")
      .getByRole("button", { name: "Conversation", exact: true }),
  );
  await click(
    main.getByRole("link", { name: "the live preview", exact: true }),
  );
  await expect(main.locator(".detail-tabs button.active")).toHaveText(
    "Browser",
  );
  let page;
  const workers = await connectWorkerPages(profile);
  await expect
    .poll(
      () => {
        page = workers
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url() === webURL);
        return !!page;
      },
      { timeout: 15000 },
    )
    .toBeTruthy();
  await expect(page.getByRole("heading")).toHaveText("The card browser opened");
  await page
    .getByRole("textbox", { name: "Keep my input" })
    .fill("User retained state");
  await click(
    main
      .getByRole("dialog")
      .getByRole("button", { name: "Conversation", exact: true }),
  );
  await click(
    main.getByRole("link", { name: "the live preview", exact: true }),
  );
  await expect(main.locator(".detail-tabs button.active")).toHaveText(
    "Browser",
  );
  await expect(
    page.getByRole("textbox", { name: "Keep my input" }),
  ).toHaveValue("User retained state");
  await expect
    .poll(
      async () =>
        (await call("browser", taskId, { action: "state" })).state.tabs.length,
    )
    .toBe(1);
  await click(
    main
      .getByRole("dialog")
      .getByRole("button", { name: "Conversation", exact: true }),
  );
  await click(
    main.getByRole("link", { name: "the stopped preview", exact: true }),
  );
  await expect(main.locator(".detail-tabs button.active")).toHaveText(
    "Browser",
  );
  await expect(main.locator(".worker-browser .browser-error")).toContainText(
    "This server is not running",
    { timeout: 15000 },
  );
  report.checks.push({
    kind: "web links open this card browser, preserve existing tab state and show stopped-server errors",
  });
  report.result = "passed";
  await main.screenshot({ path: join(evidence, "review-conversation.png") });
} catch (error) {
  report.result = "failed";
  report.error = String(error);
  console.error(diagnostics);
  throw error;
} finally {
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify(report, null, 2),
  );
  if (main && !main.isClosed())
    await call("windowAction", "close").catch(() => {});
  const closed = await Promise.race([
    exited.then(() => true),
    new Promise((done) => setTimeout(() => done(false), 20000).unref()),
  ]);
  if (!closed) child.kill();
  await new Promise((done) => web.close(done));
}
console.log(JSON.stringify(report, null, 2));
process.exit(0);
