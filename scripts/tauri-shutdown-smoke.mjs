// Real native close/IPC acceptance with a disposable protocol child/profile.
// No account, source project, graph, or user's running MemCode is accessed.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";
import { nativeEnv } from "./tauri-env.mjs";

if (process.platform !== "win32")
  throw Error(
    "This native window-visibility smoke uses Windows WebView2; run the Rust shutdown tests on other platforms.",
  );
const profile = await mkdtemp(join(tmpdir(), "memcode-shutdown-smoke-"));
const service = join(profile, "shutdown-fixture.cjs");
const receipt = join(profile, "receipt.json");
await writeFile(
  service,
  `
const fs=require('node:fs'),path=require('node:path');
const dataDir=process.argv[process.argv.indexOf('--data-dir')+1];
const receipt=path.join(dataDir,'receipt.json');
let shutdownRequests=0,closing=false;
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.kind!=='request')return;
 if(m.method==='runtime:shutdown'){
  shutdownRequests++;closing=true;fs.writeFileSync(receipt,JSON.stringify({shutdownRequests,completed:false}));
  setTimeout(()=>{fs.writeFileSync(receipt,JSON.stringify({shutdownRequests,completed:true}));send({kind:'response',id:m.id,result:null});setTimeout(()=>process.exit(0),10);},21200);
 }else if(m.method==='qa:close'){
  send({kind:'host_request',id:'close-'+m.id,method:'window_action',input:{action:'close'}});
  send({kind:'response',id:m.id,result:null});
 }else if(m.method==='qa:ping')send({kind:'response',id:m.id,result:{closing,shutdownRequests}});
 else send({kind:'response',id:m.id,error:'Isolated shutdown protocol fixture; no project data.'});
});
`,
);
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const child = spawn(
  process.env.MEMCODE_NATIVE_BINARY ??
    resolve("src-tauri/target/debug/memcode.exe"),
  [],
  {
    env: nativeEnv({
      MEMCODE_DATA_DIR: profile,
      MEMCODE_SERVICE_PATH: service,
      MEMCODE_APP_PATH: resolve("."),
      MEMCODE_NATIVE_TEST_PROFILE: "1",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    }),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let diagnostics = "",
  browser;
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-12000);
  });
const exited = new Promise((done) => child.once("exit", (code) => done(code)));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const visibleWindows = () =>
  JSON.parse(
    execFileSync(
      join(
        process.env.SystemRoot ?? "C:/Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
Add-Type 'using System;using System.Text;using System.Runtime.InteropServices;public class MemCodeShutdownVisibility{public delegate bool Visit(IntPtr h,IntPtr p);[DllImport("user32.dll")]public static extern bool EnumWindows(Visit visit,IntPtr p);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder title,int max);}';
$found=[System.Collections.Generic.List[string]]::new();
[MemCodeShutdownVisibility]::EnumWindows({param($h,$p) [uint32]$owner=0;[void][MemCodeShutdownVisibility]::GetWindowThreadProcessId($h,[ref]$owner);if($owner -eq ${child.pid} -and [MemCodeShutdownVisibility]::IsWindowVisible($h)){$title=[System.Text.StringBuilder]::new(512);[void][MemCodeShutdownVisibility]::GetWindowText($h,$title,512);$found.Add($title.ToString())};return $true},[IntPtr]::Zero)|Out-Null;
ConvertTo-Json -InputObject @($found) -Compress
`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    ).trim(),
  );
try {
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      assert.equal(child.exitCode, null, diagnostics);
      assert.ok(Date.now() < deadline, diagnostics);
      await pause(200);
    }
  }
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const call = (method) =>
    page.evaluate(
      (method) => window.__TAURI_INTERNALS__.invoke("rpc", { method }),
      method,
    );
  assert.equal((await call("qa:ping")).shutdownRequests, 0);
  assert.ok(
    visibleWindows().some((title) => title.startsWith("MemCode")),
    "The isolated main window initially appears",
  );
  const started = Date.now();
  await call("qa:close");
  await pause(150);
  assert.deepEqual(
    visibleWindows().filter((title) => title.startsWith("MemCode")),
    [],
    "The real window hides promptly while cleanup drains",
  );
  assert.equal(child.exitCode, null, "Hiding must not kill the runtime");
  await call("qa:close");
  assert.deepEqual(await call("qa:ping"), {
    closing: true,
    shutdownRequests: 1,
  });
  await pause(Math.max(0, 20200 - (Date.now() - started)));
  assert.equal(
    child.exitCode,
    null,
    "The former 20-second host deadline must not kill the real native app",
  );
  assert.deepEqual(await call("qa:ping"), {
    closing: true,
    shutdownRequests: 1,
  });
  const code = await Promise.race([
    exited,
    pause(12000).then(() => {
      throw Error("Native shutdown did not finish");
    }),
  ]);
  assert.equal(code, 0, diagnostics);
  assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), {
    shutdownRequests: 1,
    completed: true,
  });
  const report = {
    passed: true,
    nativeWindowHiddenWhileDraining: true,
    repeatedCloseSingleFlight: true,
    bridgeResponsivePast20Seconds: true,
    gracefulExitCode: code,
    shutdownMs: Date.now() - started,
    normalProfilesTouched: false,
    profile,
  };
  await writeFile(
    join(profile, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (child.exitCode === null) {
    execFileSync(
      join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, timeout: 10000 },
    );
  }
  // The native process owns this WebView; never send Browser.close to it.
}
