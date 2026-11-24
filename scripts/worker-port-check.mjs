// What another program on this computer can reach while MemCode runs (Windows): started as
// people start it there is no debugging port at all, a worker's page brings one that reaches
// workers' pages alone, and the port is gone with the last page.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer, get } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { nativeBinary, nativeEnv } from "./tauri-env.mjs";
import { connectWorkerPages } from "./worker-pages.mjs";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const script = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
$tree = @([int]$env:ROOT_PROCESS); $grow = $true
while ($grow) {
  $next = @($all | Where-Object { $tree -contains $_.ParentProcessId -and $tree -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId })
  $grow = $next.Count -gt 0; $tree += $next
}
$listening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $tree -contains $_.OwningProcess })
$found = foreach ($id in $tree) {
  $p = $all | Where-Object { $_.ProcessId -eq $id }
  if ($p) { [pscustomobject]@{ id = $id; name = $p.Name; line = [string]$p.CommandLine; ports = @($listening | Where-Object { $_.OwningProcess -eq $id } | ForEach-Object { $_.LocalPort }) } }
}
ConvertTo-Json @($found) -Depth 4 -Compress`;
/** MemCode and everything under it, and what each listens on. */
const processes = (root) =>
  JSON.parse(
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { ...process.env, ROOT_PROCESS: String(root) },
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  );
/** The pages every debugging port under MemCode shows, by port. */
async function reachable(root) {
  const shown = {};
  for (const one of processes(root))
    for (const port of [one.ports].flat().filter(Boolean)) {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      })
        .then((reply) => reply.json())
        .catch(() => null);
      if (Array.isArray(pages)) shown[port] = pages.map((page) => page.url);
    }
  return shown;
}
async function start(extra = {}) {
  const profile = await mkdtemp(join(tmpdir(), "memcode-port-check-"));
  const child = spawn(nativeBinary(), [], {
    env: nativeEnv({
      MEMCODE_DATA_DIR: profile,
      MEMCODE_APP_PATH: resolve("."),
      MEMCODE_SERVICE_PATH: resolve("dist-runtime/service.cjs"),
      MEMCODE_NATIVE_TEST_PROFILE: "1",
      ...extra,
    }),
    windowsHide: true,
    stdio: "ignore",
  });
  return { profile, child };
}
/** What the port answers to a request for another host's name. */
const statusAs = (port, host) =>
  new Promise((done, failed) =>
    get(
      { host: "127.0.0.1", port, path: "/json/version", headers: { Host: host } },
      (reply) => {
        reply.resume();
        done(reply.statusCode);
      },
    ).on("error", failed),
  );
const started = (root) =>
  processes(root).some((one) => /--type=renderer/.test(one.line));
const ended = (child) =>
  child.exitCode === null
    ? new Promise((done) => child.once("exit", done))
    : Promise.resolve();

// As people start it.
{
  const { child } = await start();
  try {
    for (let attempt = 0; attempt < 60 && !started(child.pid); attempt++)
      await pause(500);
    await pause(3000);
    const running = processes(child.pid);
    assert.ok(
      running.some((one) => one.name === "msedgewebview2.exe"),
      "MemCode's window did not open",
    );
    assert.deepEqual(
      running.filter((one) => /remote-debugging/.test(one.line)),
      [],
      "a process has a debugging port",
    );
    assert.deepEqual(await reachable(child.pid), {});
    console.log("Started normally: no debugging port.");
  } finally {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    await ended(child);
  }
}

// With a port for the window alone, as tests ask for, so that the rest can be driven.
const reservation = createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const site = createServer((_, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<title>site</title><h1>A worker's page</h1>");
});
await new Promise((done) => site.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${site.address().port}`;
const { profile, child } = await start({
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
});
try {
  let browser;
  for (let attempt = 0; attempt < 150 && !browser; attempt++)
    browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${port}`)
      .catch(() => pause(200));
  let main;
  for (let attempt = 0; attempt < 100 && !main; attempt++) {
    main = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().includes("tauri.localhost"));
    if (!main) await pause(100);
  }
  await main.waitForFunction(() => !!window.memcode);
  await main.evaluate(() => window.memcode.load());
  await main.evaluate(() => window.memcode.selectProject("example"));
  const call = (request) =>
    main.evaluate(
      (request) => window.memcode.browser("example-03", request),
      request,
    );
  const ports = [];
  for (const round of [1, 2, 3]) {
    const opened = await call({ action: "open", url: `${url}/${round}` });
    assert.equal(opened.state.nativeSurface, true);
    const shown = await reachable(child.pid);
    assert.ok(
      shown[port].every((page) => !page.startsWith(url)),
      "the window's browser shows a worker's page",
    );
    delete shown[port];
    const [workerPort, ...more] = Object.keys(shown);
    assert.deepEqual(more, [], "one port for workers' pages");
    assert.ok(shown[workerPort]?.includes(`${url}/${round}`), JSON.stringify(shown));
    assert.ok(
      shown[workerPort].every((page) => !page.includes("tauri.localhost")),
      "the port for workers' pages shows MemCode's window",
    );
    // Asked for everything it has, not only for what it lists.
    const other = await connectWorkerPages(profile);
    const session = await other.newBrowserCDPSession();
    const { targetInfos } = await session.send("Target.getTargets");
    assert.ok(
      targetInfos.every((target) => !/tauri\.localhost|^ipc:/.test(target.url)),
      JSON.stringify(targetInfos.map((target) => target.url)),
    );
    // A web page cannot use the port, not even one that knows its address.
    const { webSocketDebuggerUrl } = await fetch(
      `http://127.0.0.1:${workerPort}/json/version`,
    ).then((reply) => reply.json());
    const page = other
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url() === `${url}/${round}`);
    const answer = await page.evaluate(
      (address) =>
        new Promise((done) => {
          const socket = new WebSocket(address);
          socket.onopen = () => done("connected");
          socket.onerror = () => done("refused");
        }),
      webSocketDebuggerUrl,
    );
    assert.equal(answer, "refused");
    const read = await page.evaluate(
      (port) =>
        fetch(`http://127.0.0.1:${port}/json/list`)
          .then((reply) => reply.text())
          .catch(() => "refused"),
      workerPort,
    );
    assert.equal(read, "refused");
    // Nor can one whose name was pointed at this computer.
    assert.notEqual(await statusAs(workerPort, "evil.test"), 200);
    await other.close();
    ports.push(workerPort);
    const { state } = await call({ action: "state" });
    const observed = await call({ action: "observe" });
    await call({
      action: "act",
      input: {
        action: "close",
        tabId: state.tabs.find((tab) => tab.active).id,
        revision: observed.snapshot?.revision,
      },
    });
    let left = 1;
    for (let attempt = 0; attempt < 40 && left; attempt++) {
      left = processes(child.pid).filter((one) =>
        one.line.includes("webview-workers"),
      ).length;
      if (left) await pause(500);
    }
    assert.equal(left, 0, "the browser of workers' pages is still there");
    assert.deepEqual(Object.keys(await reachable(child.pid)), [String(port)]);
    console.log(`Round ${round}: a port for workers' pages alone, gone with the last page.`);
  }
  assert.equal(
    processes(child.pid).filter((one) => one.line.includes("webview-workers"))
      .length,
    0,
  );
  console.log(JSON.stringify({ result: "passed", ports }));
  await main.evaluate(() => window.memcode.windowAction("close")).catch(() => {});
} finally {
  await Promise.race([ended(child), pause(20000)]);
  if (child.exitCode === null)
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  site.close();
}
process.exit(0);
