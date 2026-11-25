import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { nativeEnv, nativeBinary } from "./tauri-env.mjs";
import { connectWorkerPages } from "./worker-pages.mjs";

const profile = await mkdtemp(join(tmpdir(), "memcode-native-browser-"));
const reservation = createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    `<title>Native browser fixture</title><style>body{font:18px system-ui;padding:24px;color:#16392b}p{font-size:24px}input,button{font:inherit;padding:10px}.scroll{height:110px;overflow:auto;border:1px solid #abc}a{display:block;margin:16px 0}</style><h1>Native browser fixture</h1><p id="selection">Select native browser text.</p><input aria-label="Shared field" placeholder="Paste here"><button id="remember">Remember</button><select aria-label="Launch window"><option value="early">Early</option><option value="late">Late</option></select><output></output><div class="scroll">${Array.from({ length: 30 }, (_, i) => `<div>Nested scroll ${i}</div>`).join("")}</div><a href="/popup" target="_blank">Open another tab</a><script>remember.onclick=()=>{localStorage.setItem('value',document.querySelector('input').value);document.querySelector('output').textContent=document.querySelector('input').value}</script>${Array.from({ length: 30 }, (_, i) => `<p>Page scroll ${i}</p>`).join("")}`,
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}`;
const child = spawn(nativeBinary(), [], {
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
  main,
  report;
child.stderr.on(
  "data",
  (chunk) => (diagnostics = (diagnostics + chunk).slice(-12000)),
);
const exited = new Promise((done) => child.once("exit", done));
const call = (taskId, request) =>
  main.evaluate(
    ({ taskId, request }) => window.memcode.browser(taskId, request),
    { taskId, request },
  );
try {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      if (child.exitCode !== null) throw Error(diagnostics);
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  assert.ok(browser, "Native browser test did not start");
  for (let attempt = 0; attempt < 100; attempt++) {
    main = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes("tauri.localhost"));
    if (main) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(main, "Native main page did not load: " + diagnostics);
  await main.waitForFunction(() => !!window.memcode);
  // A fresh profile opens on the welcome. Close it, as tauri-smoke.mjs does.
  const loaded = await main.evaluate(() => window.memcode.load());
  const onboarding = (loaded?.state ?? loaded)?.onboarding;
  if (!onboarding || (onboarding.step === "welcome" && !onboarding.dismissed)) {
    const skip = main.getByRole("button", { name: "Skip for now", exact: true });
    await expect(skip).toBeVisible();
    await skip.click();
  }
  await main.evaluate(() => window.memcode.selectProject("example"));
  await main.getByRole("button", { name: "Workspace", exact: true }).click();
  await main
    .getByRole("button")
    .filter({ hasText: "Shape the worker workspace" })
    .first()
    .click();
  await main
    .locator(".detail-tabs")
    .getByRole("button", { name: "Browser", exact: true })
    .click();
  const [opened, ...parallel] = await Promise.all([
    call("example-03", { action: "open", url: url + "/one" }),
    call("example-04", { action: "open", url: url + "/parallel-four" }),
    call("example-05", { action: "open", url: url + "/parallel-five" }),
  ]);
  assert.ok(
    parallel.every(
      (reply) => reply.state.nativeSurface && reply.state.tabs.length === 1,
    ),
  );
  console.log("Three native work-item browsers opened concurrently.");
  await Promise.race([
    Promise.all([
      ...Array.from({ length: 12 }, () =>
        main.evaluate(() => window.memcode.load()),
      ),
      call("example-04", { action: "observe" }),
      call("example-05", { action: "observe" }),
      call("example-04", {
        action: "act",
        input: { action: "type", ref: "m1", text: "Parallel four" },
      }),
      call("example-05", {
        action: "act",
        input: { action: "type", ref: "m1", text: "Parallel five" },
      }),
    ]),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            Error(
              "Desktop RPC stalled during concurrent native browser operations",
            ),
          ),
        15000,
      ).unref(),
    ),
  ]);
  console.log("Desktop RPC stayed responsive during concurrent browser work.");
  assert.equal(opened.state.nativeSurface, true);
  await expect(main.locator(".native-browser-surface")).toBeVisible();
  assert.equal(await main.locator(".worker-browser-viewport img").count(), 0);
  const workers = await connectWorkerPages(profile);
  const urlsIn = (one) =>
    one
      .contexts()
      .flatMap((c) => c.pages())
      .map((p) => p.url());
  assert.ok(
    urlsIn(workers).every((page) => !/tauri\.localhost|127\.0\.0\.1:5197/.test(page)),
    "Workers' browser shows MemCode's window: " + urlsIn(workers).join(", "),
  );
  assert.ok(
    urlsIn(browser).every((page) => !page.startsWith(url)),
    "MemCode's browser shows a worker's page: " + urlsIn(browser).join(", "),
  );
  console.log("Workers' pages and MemCode's window are in separate browsers.");
  const guest = workers
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url() === url + "/one");
  assert.ok(guest);
  console.log("Native page and card surface connected.");
  await guest.locator("#selection").dblclick({ position: { x: 30, y: 12 } });
  assert.match(await guest.evaluate(() => getSelection().toString()), /Select/);
  await guest.keyboard.press("Control+C");
  await guest.getByRole("textbox").click();
  await guest.keyboard.press("Control+V");
  const pasted = await guest.getByRole("textbox").inputValue();
  assert.match(pasted, /Select/);
  console.log("Native double-click selection and clipboard passed.");
  await guest.getByRole("textbox").fill("Shared DOM state");
  const observed = await call("example-03", { action: "observe" });
  assert.match(observed.snapshot.text, /Shared DOM state/);
  await call("example-03", {
    action: "act",
    input: { action: "type", ref: "m1", text: "Agent changes the same field" },
  });
  assert.equal(
    await guest.getByRole("textbox").inputValue(),
    "Agent changes the same field",
  );
  await guest.getByRole("button", { name: "Remember", exact: true }).click();
  await guest.locator(".scroll").hover();
  await guest.mouse.wheel(0, 300);
  await guest.waitForFunction(
    () => document.querySelector(".scroll").scrollTop > 0,
  );
  await guest.locator("#selection").hover();
  await guest.mouse.wheel(0, 400);
  await guest.waitForFunction(() => scrollY > 0);
  console.log("Shared DOM, page scrolling and nested scrolling passed.");
  await guest.evaluate(() => scrollTo(0, 0));
  const earlyFrame = await call("example-03", {
    action: "observe",
    screenshot: true,
  });
  assert.equal(
    Buffer.from(earlyFrame.image.data, "base64").subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
  );
  const nativeImage = join(profile, "native-browser-before-popup.png");
  await writeFile(nativeImage, Buffer.from(earlyFrame.image.data, "base64"));
  console.log("Native screenshot captured: " + nativeImage);
  await guest.getByRole("link", { name: "Open another tab" }).click();
  await expect
    .poll(
      async () => {
        const reply = await call("example-03", { action: "state" });
        return (
          reply.state.tabs.length === 2 &&
          reply.state.tabs.some(
            (tab) => tab.active && tab.url.endsWith("/popup"),
          )
        );
      },
      { timeout: 10000 },
    )
    .toBe(true);
  // Independently inspect the committed WebView2 replacement target.
  const fresh = await connectWorkerPages(profile);
  const popup = fresh
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url() === url + "/popup");
  assert.ok(
    popup,
    "Live popup missing. Actual targets: " +
      JSON.stringify(
        workers
          .contexts()
          .flatMap((c) => c.pages())
          .map((p) => p.url()),
      ),
  );
  console.log("Native popup opened.");
  await expect
    .poll(async () => {
      const r = await call("example-03", { action: "state" });
      return (
        r.state.tabs.length === 2 &&
        r.state.tabs.some((tab) => tab.active && tab.url.endsWith("/popup"))
      );
    })
    .toBe(true);
  const state = (await call("example-03", { action: "state" })).state;
  assert.equal(state.tabs.find((t) => t.active).url, url + "/popup");
  await call("example-03", {
    action: "surface",
    tabId: state.tabs.find((t) => t.active).id,
    visible: true,
    bounds: { x: 329, y: 416, width: 883, height: 540 },
  });
  assert.equal(
    await popup.evaluate(() => localStorage.getItem("value")),
    "Agent changes the same field",
  );
  await call("example-04", { action: "open", url: url + "/other-card" });
  await call("example-04", { action: "observe" });
  await call("example-04", {
    action: "act",
    input: { action: "choose", ref: "m3", value: "late" },
  });
  const background = await call("example-04", {
    action: "observe",
    screenshot: true,
  });
  await writeFile(
    join(profile, "offscreen-browser.png"),
    Buffer.from(background.image.data, "base64"),
  );
  console.log("Offscreen native capture passed.");
  const isolated = workers
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url() === url + "/other-card");
  assert.equal(
    await isolated.evaluate(() => localStorage.getItem("value")),
    null,
  );
  assert.equal(
    await isolated
      .getByRole("combobox", { name: "Launch window" })
      .inputValue(),
    "late",
  );
  assert.equal(
    await guest.evaluate(() => typeof window.__TAURI_INTERNALS__),
    "undefined",
  );
  const captured = await call("example-03", { action: "capture" });
  assert.ok(captured.artifactId);
  const frame = await call("example-03", {
    action: "observe",
    screenshot: true,
  });
  assert.equal(frame.image.mimeType, "image/png");
  const png = Buffer.from(frame.image.data, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const image = join(profile, "native-browser.png");
  await writeFile(image, png);
  report = {
    result: "passed",
    profile,
    image,
    nativeTextSelection: true,
    clipboard: true,
    typing: true,
    nestedAndPageScrolling: true,
    sameDomBothDirections: true,
    popupTab: true,
    profileIsolation: true,
    hiddenNativeCapture: true,
    nativeSelectOption: true,
    concurrentNativeStartup: true,
    rpcDuringNativeWork: true,
    noAppBridge: true,
    separateBrowsers: true,
    bitmapPreview: false,
  };
} catch (error) {
  console.error("Native browser diagnostics:", diagnostics);
  console.error(
    "Native browser assertion failed:",
    error.stack ?? String(error),
  );
  throw error;
} finally {
  if (main && !main.isClosed())
    await main
      .evaluate(() => window.memcode.windowAction("close"))
      .catch(() => {});
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((done) => setTimeout(() => done(false), 25000).unref()),
  ]);
  if (!stopped) {
    child.kill();
    throw Error("Native browser test did not close gracefully: " + diagnostics);
  }
  // Exit disconnects CDP; the native test window has already closed normally.
  await new Promise((done) => server.close(() => done()));
}
console.log(JSON.stringify({ ...report, gracefulShutdown: true }, null, 2));
process.exit(0);
