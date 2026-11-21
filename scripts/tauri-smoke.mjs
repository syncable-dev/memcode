import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { nativeBinary, nativeEnv } from "./tauri-env.mjs";
import { verifyPlanning } from "./planning-smoke.mjs";

const profile = await mkdtemp(join(tmpdir(), "memcode-tauri-smoke-"));
const out = resolve("../tmp/memcode-review");
await mkdir(out, { recursive: true });
const port = Number(process.env.MEMCODE_NATIVE_DEBUG_PORT ?? 9328);
const environment = nativeEnv({
  MEMCODE_DATA_DIR: profile,
  MEMCODE_SERVICE_PATH: resolve("dist-runtime/service.cjs"),
  MEMCODE_APP_PATH: resolve("."),
  MEMCODE_NATIVE_TEST_PROFILE: "1",
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
});
if (process.env.MEMCODE_TEST_BUNDLED_RUNTIME === "1") {
  delete environment.MEMCODE_SERVICE_PATH;
  delete environment.MEMCODE_NODE_PATH;
  delete environment.MEMCODE_APP_PATH;
  for (const key of Object.keys(environment))
    if (key.toLowerCase() === "path") {
      const kept = environment[key]
        .split(process.platform === "win32" ? ";" : ":")
        .filter(
          (part) =>
            !/nodejs|node-v\d|(?:^|[\\/])node(?:[\\/]|$)|scoop[\\/]shims/i.test(
              part,
            ),
        );
      environment[key] = kept.join(process.platform === "win32" ? ";" : ":");
    }
}
const child = spawn(nativeBinary(), [], {
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let diagnostics = "",
  browser,
  page,
  report;
child.stderr.on("data", (chunk) => {
  diagnostics = (diagnostics + chunk.toString()).slice(-12000);
});
child.stdout.on("data", (chunk) => {
  diagnostics = (diagnostics + chunk.toString()).slice(-12000);
});
const exited = new Promise((resolve) => child.once("exit", resolve));
async function call(method, input = null) {
  return page.evaluate(
    ({ method, input }) =>
      window.__TAURI_INTERNALS__.invoke("rpc", { method, input }),
    { method, input },
  );
}
try {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null)
      throw new Error(`Native app exited: ${diagnostics}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(
    ready,
    `Native WebView2 did not open its test inspector. ${diagnostics}`,
  );
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page =
    browser
      .contexts()[0]
      .pages()
      .find((page) => page.url().includes("tauri.localhost")) ??
    browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__, {
    timeout: 15000,
  });
  const result = await call("workspace:load");
  if (
    process.env.MEMCODE_TEST_BUNDLED_RUNTIME === "1" &&
    process.platform === "win32"
  ) {
    const children = JSON.parse(
      execFileSync(
        join(
          process.env.SystemRoot ?? "C:/Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' | Select-Object -ExpandProperty ExecutablePath) | ConvertTo-Json -Compress`,
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    );
    const expected = resolve(
      nativeBinary(),
      "..",
      "desktop-runtime/node.exe",
    ).toLowerCase();
    assert.ok(
      (Array.isArray(children) ? children : [children]).some(
        (path) =>
          typeof path === "string" && resolve(path).toLowerCase() === expected,
      ),
      "Packaged app must run its bundled Node, without Node on PATH or MEMCODE_NODE_PATH",
    );
  }
  const expectedVersion = JSON.parse(
    await readFile(resolve("package.json"), "utf8"),
  ).version;
  assert.equal(result.runtime.appVersion, expectedVersion);
  const updates = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("app_update_info"),
  );
  assert.equal(updates.currentVersion, expectedVersion);
  assert.equal(updates.development, true);
  const updateContext = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("app_update_context"),
  );
  assert.equal(updateContext.activeWorkers, 0);
  assert.equal(updateContext.activeTerminals, 0);
  await assert.rejects(
    page.evaluate(() => window.__TAURI_INTERNALS__.invoke("app_update_check")),
    /Development builds update through Git/,
  );
  assert.ok(Array.isArray(result.state.projects));
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
  if (
    !result.state.onboarding ||
    (result.state.onboarding.step === "welcome" &&
      !result.state.onboarding.dismissed)
  ) {
    const skip = page.getByRole("button", {
      name: "Skip for now",
      exact: true,
    });
    await expect(skip).toBeVisible();
    await skip.click();
  }
  await page.evaluate(() => {
    window.__nativeSmokeEvents = { states: 0, previews: 0 };
    window.__nativeSmokeUnsubscribe = window.memcode.onState(() => {
      window.__nativeSmokeEvents.states += 1;
    });
    window.memcode.onPreview(() => {
      window.__nativeSmokeEvents.previews += 1;
    });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.screenshot({
    path: join(out, "tauri-native-main.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Docs", exact: true }).click();
  await page.getByRole("button", { name: "Watch product tour" }).click();
  const productTour = page.getByRole("dialog", {
    name: "MemCode product tour",
  });
  await productTour
    .getByRole("button", { name: "Show review a change preview" })
    .click();
  await expect
    .poll(() =>
      productTour.locator("img.is-active").evaluate((img) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await productTour.getByRole("button", { name: "Back to Docs" }).click();
  await page
    .getByRole("navigation", { name: "Guide topics" })
    .getByRole("button", { name: "Code review", exact: true })
    .click();
  const figure = page.getByRole("figure", { name: "Example task review" });
  await figure.getByRole("button", { name: "Before & after" }).click();
  await expect
    .poll(() => figure.getByRole("img").evaluate((img) => img.naturalWidth))
    .toBeGreaterThan(0);
  await page.screenshot({
    path: join(out, "tauri-review-docs.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: /^Settings/ }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Updates", exact: true })
    .click();
  await expect(page.getByText("Development build", { exact: true })).toBeVisible();
  await page.screenshot({ path: join(out, "tauri-native-settings.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  if (process.env.MEMCODE_SMOKE_SCOPE !== "packaging")
    await verifyPlanning(page, call, out);
  const artifact = result.state.artifacts.find(
    (artifact) => artifact.kind === "html",
  );
  assert.ok(artifact, "Example HTML artifact should exist");
  const task = result.state.tasks.find((task) => task.id === artifact.taskId);
  await call("task:update", { id: task.id, patch: { title: task.title } });
  await expect
    .poll(() => page.evaluate(() => window.__nativeSmokeEvents.states))
    .toBeGreaterThan(0);
  const stateEvents = await page.evaluate(() => {
    window.__nativeSmokeUnsubscribe();
    return window.__nativeSmokeEvents.states;
  });
  await call("task:update", { id: task.id, patch: { title: task.title } });
  assert.equal(
    await page.evaluate(() => window.__nativeSmokeEvents.states),
    stateEvents,
    "Unsubscribed state listeners must stay detached",
  );
  const bounds = { x: 400, y: 320, width: 620, height: 400 };
  await call("preview:show", {
    taskId: artifact.taskId,
    artifactId: artifact.id,
    bounds,
  });
  await expect
    .poll(
      () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .filter(
            (p) =>
              p !== page &&
              p.url().startsWith("http://127.0.0.1:") &&
              !p.url().includes(`:${port}`),
          ).length,
      { timeout: 15000 },
    )
    .toBeGreaterThan(0);
  const guest = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find(
      (p) =>
        p !== page &&
        p.url().startsWith("http://127.0.0.1:") &&
        !p.url().includes(`:${port}`),
    );
  await guest.waitForLoadState("domcontentloaded");
  await expect
    .poll(() => page.evaluate(() => window.__nativeSmokeEvents.previews))
    .toBeGreaterThan(0);
  assert.equal(await guest.evaluate(() => typeof window.memcode), "undefined");
  assert.equal(await guest.evaluate(() => typeof require), "undefined");
  const denied = await guest.evaluate(async () => {
    if (!window.__TAURI_INTERNALS__) return "not exposed";
    try {
      await window.__TAURI_INTERNALS__.invoke("rpc", {
        method: "workspace:load",
        input: null,
      });
      return "unexpected access";
    } catch (error) {
      return String(error);
    }
  });
  assert.notEqual(denied, "unexpected access");
  await guest.screenshot({
    path: join(out, "tauri-isolated-preview.png"),
    timeout: 10000,
  });
  // Creating a preview converts the native window into a multi-webview window.
  // Window actions must keep working after that transition.
  await call("window:action", "maximize");
  await call("window:action", "maximize");
  await call("preview:action", "capture");
  const captured = await call("workspace:load");
  const image = captured.state.artifacts
    .filter((item) => item.kind === "image")
    .at(-1);
  assert.ok(image, "Visible preview capture should create an image artifact");
  await call("preview:hide");
  const before = guest.url();
  await guest.evaluate(() => {
    location.href = "https://example.com/";
  });
  await page.waitForTimeout(300);
  assert.equal(guest.url(), before, "Guest remote navigation must be denied");
  report = {
    result: "passed",
    scope:
      process.env.MEMCODE_SMOKE_SCOPE === "packaging"
        ? "packaged runtime, bridge, local artifacts and isolation"
        : "full native smoke including planning",
    shell: "Tauri + system WebView2",
    profile,
    projects: result.state.projects.length,
    runtimes: result.runtime.harnesses.map((h) => ({
      name: h.name,
      available: h.available,
      models: h.models.length,
    })),
    guestRpc: denied,
    stateAndPreviewSubscriptions: "passed",
    previewCapture: image.path,
    screenshots: out,
  };
} catch (error) {
  console.error(diagnostics);
  console.error(error);
  throw error;
} finally {
  let closeError;
  if (page && !page.isClosed())
    await call("window:action", "close").catch((error) => {
      closeError = error;
    });
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25000).unref()),
  ]);
  // Exit disconnects CDP; never send Browser.close to a system WebView process.
  if (!stopped) {
    child.kill();
    throw new Error(
      `Native smoke app did not shut down gracefully. ${closeError ?? diagnostics}`,
    );
  }
  await assert.rejects(access(join(profile, "runtime.lock")), {
    code: "ENOENT",
  });
}
console.log(JSON.stringify({ ...report, gracefulShutdown: "passed" }, null, 2));
process.exit(0);
