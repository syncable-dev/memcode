// Native renderer fixture QA. No model, worker process or user profile is used.
// Run: node --import tsx scripts/approval-gallery-ui.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, copyFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { createServer } from "node:net";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../src/seed.ts";
import { nativeBinary, nativeEnv } from "./tauri-env.mjs";
import { verifyWorkerSessionUI } from "./worker-session-ui.mjs";

await access(nativeBinary());
const profile = await mkdtemp(join(tmpdir(), "memcode-approval-gallery-"));
const galleryOnly = process.argv.includes("--gallery-only");
const verifyDockCss = process.argv.includes("--verify-dock-css");
const out = resolve("../tmp/memcode-approval-gallery-qa");
await mkdir(out, { recursive: true });
const examples = join(profile, "examples");
await mkdir(examples);
const state = initialState();
state.projects[0].name = "Renderer fixture QA";
state.onboarding = { version: 1, step: "welcome", dismissed: true };
const fixtureTask = state.tasks[0];
fixtureTask.title = "Renderer fixture · approval layout";
fixtureTask.harness = "codex";
fixtureTask.assignment = "manual";
fixtureTask.permissionMode = "review";
fixtureTask.messages.push({
  id: "qa-notice",
  role: "system",
  text: "Native renderer fixture. No agent is running and no displayed command will execute.",
  at: new Date().toISOString(),
});
const imagePath = join(examples, "memcode-logo.png"),
  notesPath = join(examples, "mission-notes.md"),
  codePath = join(examples, "starship.css"),
  pdfPath = join(examples, "launch-overview.pdf");
await copyFile(resolve("src-tauri/icons/icon.png"), imagePath);
await writeFile(
  notesPath,
  "# Mission launch notes\n\nA readable preview from a real Markdown file.\n\n- Review the launch window\n- Check the orbital path\n",
);
await writeFile(
  codePath,
  ".starship {\n  color: mintcream;\n  transform: translateY(-12px);\n  animation: orbit 12s linear infinite;\n}\n",
);
// A complete single-page PDF with correct object offsets, not an image fallback.
const pdfStream =
  "0.94 0.97 0.94 rg 0 0 400 300 re f\n0.06 0.16 0.11 rg 24 185 352 90 re f\n0.92 0.98 0.94 rg BT /F1 24 Tf 44 235 Td (Launch overview) Tj ET\n0.18 0.32 0.24 rg BT /F1 12 Tf 28 145 Td (Native PDF first-page thumbnail fixture.) Tj ET\n";
const pdfObjects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${Buffer.byteLength(pdfStream)} >>\nstream\n${pdfStream}endstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [i, object] of pdfObjects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
  .slice(1)
  .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
  .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(pdfPath, pdf);
state.artifacts = [
  { id: "qa-image", name: "memcode-logo.png", kind: "image", path: imagePath },
  { id: "qa-notes", name: "mission-notes.md", kind: "text", path: notesPath },
  { id: "qa-code", name: "starship.css", kind: "text", path: codePath },
  { id: "qa-pdf", name: "launch-overview.pdf", kind: "text", path: pdfPath },
].map((artifact) => ({
  ...artifact,
  projectId: "example",
  taskId: fixtureTask.id,
  source: "QA fixture",
  createdAt: new Date().toISOString(),
}));
await writeFile(join(profile, "workspace.json"), JSON.stringify(state));

const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
assert.notEqual(port, 9329, "The user's main inspector is forbidden");
await new Promise((done) => listener.close(done));
const child = spawn(nativeBinary(), [], {
  cwd: resolve("."),
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: nativeEnv({
    MEMCODE_DATA_DIR: profile,
    MEMCODE_SERVICE_PATH: resolve("dist-runtime/service.cjs"),
    MEMCODE_APP_PATH: resolve("."),
    MEMCODE_NATIVE_TEST_PROFILE: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  }),
});
let diagnostics = "",
  browser,
  page,
  report,
  startupError;
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-10000);
  });
const exited = new Promise((done) => {
  child.once("exit", done);
  child.once("error", (error) => {
    startupError = error;
    diagnostics += String(error);
    done(null);
  });
});
const command = `node -e "const fs=require('node:fs'); const css=fs.readFileSync('app/globals.css','utf8'); ${Array.from({ length: 12 }, (_, i) => `console.log('section-${i}', css.slice(${i * 40},${i * 40 + 160}));`).join(" ")} console.log('END-OF-EXACT-REQUEST');"`;

async function rpc(method, input = null) {
  return page.evaluate(
    ({ method, input }) =>
      window.__TAURI_INTERNALS__.invoke("rpc", { method, input }),
    { method, input },
  );
}
async function fixture(kind) {
  await page.evaluate((kind) => window.__qaShow(kind), kind);
}
async function geometry(label) {
  const result = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
      };
    };
    return {
      panel: rect(".worker-input-panel"),
      body: rect(".worker-input-body"),
      footer: rect(".worker-input-panel > footer"),
      input: rect('textarea[aria-label="Message to worker"]'),
      composer: rect(".composer-box"),
      history: rect(".conversation-scroll"),
      column: rect(".detail-content"),
      inspector: rect(".work-inspector"),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  assert.ok(
    result.panel.x >= result.column.x - 1,
    label + ": panel stays in conversation",
  );
  assert.ok(
    result.panel.right <= result.inspector.x + 1,
    label + ": panel does not span inspector",
  );
  assert.ok(
    result.panel.bottom <= result.composer.y + 1,
    label + ": request sits above message input",
  );
  assert.ok(
    result.footer.bottom <= result.viewport.height,
    label + ": action footer stays onscreen",
  );
  assert.ok(
    result.input.bottom <= result.viewport.height,
    label + ": message input stays onscreen",
  );
  assert.ok(
    result.history.height >= 60,
    label + ": conversation retains useful height",
  );
  return result;
}

try {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {}
    if (startupError) throw startupError;
    if (child.exitCode !== null)
      throw Error("QA native app exited: " + diagnostics);
    await new Promise((done) => setTimeout(done, 200));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page =
    browser
      .contexts()[0]
      .pages()
      .find((page) => page.url().includes("tauri.localhost")) ??
    browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => !!window.memcode, { timeout: 25000 });
  await rpc("project:select", "example");
  if (!galleryOnly) await verifyWorkerSessionUI(page, fixtureTask.id, fixtureTask.title);
  await page.addInitScript(
    ({ taskId, command }) => {
      let api,
        base,
        selected = "approval",
        answered = false;
      const listeners = new Set();
      window.__qaResponses = [];
      const requests = () => {
        const common = {
          id: "qa-" + selected,
          taskId,
          runId: "qa-renderer-run",
          harness: "codex",
          createdAt: new Date().toISOString(),
          status: "pending",
        };
        if (selected === "question")
          return {
            ...common,
            kind: "question",
            title: "Choose the next implementation steps",
            questions: Array.from({ length: 10 }, (_, i) => ({
              id: "q" + i,
              question: `Decision ${i + 1}: which option should the worker use?`,
              options: [
                {
                  id: "forest",
                  label: "Forest",
                  description: "Keep a calm, readable surface.",
                },
                {
                  id: "paper",
                  label: "Paper",
                  description: "Use the existing paper style.",
                },
              ],
            })),
          };
        if (selected === "plan")
          return {
            ...common,
            kind: "plan",
            title: "Review the implementation plan",
            description:
              "Renderer fixture only; this plan does not launch a worker.",
            details: Array.from(
              { length: 80 },
              (_, i) => `${i + 1}. Verify one focused change and its evidence.`,
            ).join("\n"),
            options: [
              { id: "approve-plan", label: "Approve plan", kind: "allow-once" },
              { id: "revise-plan", label: "Request changes", kind: "deny" },
            ],
          };
        return {
          ...common,
          kind: "approval",
          title: command,
          toolName: "execute",
          description:
            "Renderer fixture: review the complete action before allowing it.",
          details: command + "\nDirectory: QA fixture",
          options: [
            { id: "native-once", label: "Allow once", kind: "allow-once" },
            {
              id: "native-always",
              label: "Allow always",
              kind: "allow-session",
            },
            { id: "native-deny", label: "Reject", kind: "deny" },
          ],
        };
      };
      const transform = (state) => {
        base = state;
        const copy = structuredClone(state),
          task = copy.tasks.find((task) => task.id === taskId);
        task.run = {
          ...task.run,
          state: answered ? "idle" : "running",
          permissionMode: "review",
          sessionId: "qa-renderer-session",
          activity: {
            phase: "waiting_for_user",
            label: "Renderer fixture",
            at: new Date().toISOString(),
          },
        };
        copy.workerInputs = answered ? [] : [requests()];
        return copy;
      };
      window.__qaShow = (kind) => {
        selected = kind;
        answered = false;
        for (const listener of listeners) listener(transform(base));
      };
      Object.defineProperty(window, "memcode", {
        configurable: true,
        get: () => api,
        set(value) {
          const load = value.load.bind(value),
            subscribe = value.onState.bind(value),
            respond = value.respondToWorker.bind(value);
          window.__qaNativeLoad = load;
          value.load = async () => {
            const result = await load();
            return { ...result, state: transform(result.state) };
          };
          value.onState = (listener) => {
            listeners.add(listener);
            const off = subscribe((state) => listener(transform(state)));
            return () => {
              listeners.delete(listener);
              off();
            };
          };
          value.respondToWorker = async (task, id, response) => {
            if (!id.startsWith("qa-") || task !== taskId)
              return respond(task, id, response);
            window.__qaResponses.push({
              taskId: task,
              requestId: id,
              response,
            });
            answered = true;
            for (const listener of listeners) listener(transform(base));
          };
          api = value;
        },
      });
    },
    { taskId: fixtureTask.id, command },
  );
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 25000 });
  if (verifyDockCss)
    await page.addStyleTag({
      content:
        ".worker-input-panel { flex: 0 1 auto; min-height: min(150px, 100%); max-height: 100%; } .conversation-composer.has-worker-input { max-height: min(78%, 600px); } .has-worker-input .composer-box textarea { height: 43px; }",
    });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1512, height: 1000 });
  let wide, compact, plan;
  if (!galleryOnly) {
    await page.getByText(fixtureTask.title, { exact: true }).first().click();
    const panel = page.locator(".worker-input-panel");
    await expect(panel).toBeVisible();
    await expect(
      page.locator(".conversation-composer .worker-input-panel"),
    ).toHaveCount(1);
    assert.equal(await panel.locator(".button.primary").count(), 1);
    await expect(panel.locator(".button.primary")).toHaveText("Allow once");
    wide = await geometry("wide approval");
    await page.screenshot({
      path: join(out, "approval-wide.png"),
      animations: "disabled",
    });
    await panel.locator("summary").click();
    await expect(panel.locator("pre")).toContainText("END-OF-EXACT-REQUEST");
    await geometry("expanded approval");
    await page.screenshot({
      path: join(out, "approval-details.png"),
      animations: "disabled",
    });
    await page
      .getByRole("combobox", { name: "Worker permission mode", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Full access", exact: true })
      .click();
    await expect(page.locator(".worker-permissions > small")).toContainText(
      "Running: Review",
    );
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.__qaNativeLoad()).state.tasks.find(
              (task) => task.id === id,
            ).permissionMode,
          fixtureTask.id,
        ),
      )
      .toBe("full-access");
    await expect(page.locator(".worker-permissions > small")).toContainText(
      "next worker pass",
    );
    await panel
      .getByRole("button", { name: "Allow once", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.__qaResponses[0]), {
      taskId: fixtureTask.id,
      requestId: "qa-approval",
      response: { optionId: "native-once", answers: {} },
    });

    await fixture("question");
    await page.setViewportSize({ width: 1080, height: 740 });
    await expect(panel).toBeVisible();
    compact = await geometry("compact questions");
    assert.ok(
      compact.body.height >= 80,
      "Compact questions keep at least 80px of visible question content; observed " +
        compact.body.height,
    );
    assert.ok(
      await panel
        .locator(".worker-input-body")
        .evaluate((el) => el.scrollHeight > el.clientHeight),
      "Long questions scroll inside the request body",
    );
    await page.screenshot({
      path: join(out, "questions-compact.png"),
      animations: "disabled",
    });
    for (let i = 0; i < 10; i++)
      await panel.locator(`input[name="qa-questionq${i}"]`).first().check();
    await panel
      .getByRole("button", { name: "Send answer", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    assert.equal(
      Object.keys(
        await page.evaluate(() => window.__qaResponses.at(-1).response.answers),
      ).length,
      10,
    );
    await fixture("plan");
    await panel.locator("summary").click();
    plan = await geometry("compact plan");
    await page.screenshot({
      path: join(out, "plan-compact.png"),
      animations: "disabled",
    });
    await page
      .locator(".detail-tabs")
      .getByRole("button", { name: "Runbook", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    await page
      .getByRole("button", { name: "Waiting for your reply", exact: true })
      .click();
    await expect(panel).toBeVisible();
    await panel
      .getByRole("button", { name: "Dismiss request", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Back to workspace", exact: true })
      .click();
  }
  await page.setViewportSize({ width: 1512, height: 1000 });
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Artifacts/ })
    .click();
  await expect(page.locator(".artifact-library")).toBeVisible();
  const imageTile = page
    .locator(".artifact-tile")
    .filter({ hasText: "memcode-logo.png" });
  await expect(imageTile.locator("img")).toBeVisible({ timeout: 15000 });
  await expect
    .poll(() =>
      imageTile
        .locator("img")
        .evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  const notesTile = page
    .locator(".artifact-tile")
    .filter({ hasText: "mission-notes.md" });
  await expect(notesTile.locator(".artifact-tile-preview")).toContainText(
    "Mission launch notes",
    { timeout: 15000 },
  );
  const codeTile = page
    .locator(".artifact-tile")
    .filter({ hasText: "starship.css" });
  await expect(codeTile.locator(".artifact-tile-preview")).toContainText(
    "starship",
    { timeout: 15000 },
  );
  const pdfTile = page
    .locator(".artifact-tile")
    .filter({ hasText: "launch-overview.pdf" });
  await expect(pdfTile.locator("img")).toBeVisible({ timeout: 15000 });
  await expect
    .poll(() =>
      pdfTile
        .locator("img")
        .evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  await expect(pdfTile.locator(".artifact-thumbnail-page")).toHaveText(
    "Page 1",
  );
  const thumbnail = await page.evaluate(() =>
    window.memcode.readArtifactThumbnail("qa-image"),
  );
  assert.equal(thumbnail.kind, "image");
  await page.screenshot({
    path: join(out, "gallery-wide.png"),
    animations: "disabled",
  });
  report = {
    result: "passed",
    scope: galleryOnly
      ? "Native Tauri gallery only; approval checks not run"
      : verifyDockCss
        ? "Native Tauri renderer fixture with QA-only CSS injection; compiled fix not verified"
        : "Native Tauri renderer fixtures; no model or real worker permission granted",
    profile,
    port,
    binary: nativeBinary(),
    wide,
    compact,
    plan,
    permissionPersistence: galleryOnly
      ? "not run"
      : "actual isolated runtime metadata updated; active renderer fixture mode retained",
    requestResponses: await page.evaluate(() => window.__qaResponses),
    gallery: {
      image: "decoded actual PNG",
      markdown: "actual readable content",
      code: "actual CSS excerpt",
      pdf: "rasterized actual first page through native PDF.js worker",
    },
  };
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  await writeFile(
    join(out, "failure.json"),
    JSON.stringify(
      { error: String(error), stack: error.stack, diagnostics, profile, port },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (page && !page.isClosed())
    await rpc("window:action", "close").catch(() => {});
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((done) => setTimeout(() => done(false), 25000).unref()),
  ]);
  if (!stopped) {
    child.kill();
    throw Error("Native fixture did not shut down gracefully. " + diagnostics);
  }
  await assert.rejects(access(join(profile, "runtime.lock")), {
    code: "ENOENT",
  });
}
assert.ok(basename(profile).startsWith("memcode-approval-gallery-"));
await writeFile(
  join(
    out,
    galleryOnly
      ? "gallery-results.json"
      : verifyDockCss
        ? "dock-css-results.json"
        : "results.json",
  ),
  JSON.stringify({ ...report, gracefulShutdown: "passed" }, null, 2),
);
console.log(
  JSON.stringify({
    result: report.result,
    profile,
    port,
    out,
    gracefulShutdown: "passed",
  }),
);
