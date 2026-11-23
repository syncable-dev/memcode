import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { findDesktopApp } from "../runtime/commands";
import { inspectDshDesktopCli, installDshDesktopCli } from "../runtime/dsh-desktop";

async function placeBundledNode(target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  try {
    await link(process.execPath, target);
  } catch {
    await copyFile(process.execPath, target);
  }
}

async function createDesktopFixture(
  t: test.TestContext,
  options: { mac?: boolean; managerScript: string },
): Promise<{ root: string; desktopAppPath: string; launcherPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "memcode-dsh-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const mac = options.mac ?? process.platform === "darwin";
  const desktopAppPath = mac
    ? join(root, "Applications", "DeepSeek Harness.app")
    : join(root, "DeepSeek Harness", "DeepSeek Harness.exe");
  const resourcesDir = mac
    ? join(desktopAppPath, "Contents", "Resources")
    : join(dirname(desktopAppPath), "resources");

  if (mac) {
    await mkdir(join(desktopAppPath, "Contents"), { recursive: true });
    await writeFile(join(desktopAppPath, "Contents", "Info.plist"), "<plist/>");
  } else {
    await mkdir(dirname(desktopAppPath), { recursive: true });
    await writeFile(desktopAppPath, "stub-exe");
    await mkdir(resourcesDir, { recursive: true });
    await writeFile(join(resourcesDir, "app.asar"), "stub-asar");
  }

  const nodeBinName = process.platform === "win32" ? "node.exe" : "node";
  await placeBundledNode(
    join(resourcesDir, "runtime", "primary-runtime", "dependencies", "node", "bin", nodeBinName),
  );
  await mkdir(join(resourcesDir, "runtime", "cli", "bin"), { recursive: true });
  await writeFile(join(resourcesDir, "runtime", "cli", "command-manager.js"), options.managerScript);

  const launcherPath = join(
    resourcesDir,
    "runtime",
    "cli",
    "bin",
    mac && process.platform !== "win32" ? "dsh" : "dsh.cmd",
  );
  await writeFile(launcherPath, "echo dsh\n");

  return { root, desktopAppPath, launcherPath };
}

test("findDesktopApp detects DeepSeek Harness on Windows and macOS", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memcode-dsh-app-find-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const winExe = join(root, "win", "Programs", "DeepSeek Harness", "DeepSeek Harness.exe");
  await mkdir(join(dirname(winExe), "resources"), { recursive: true });
  await writeFile(winExe, "exe");
  assert.equal(
    await findDesktopApp("dsh", { platform: "win32", windowsCandidates: [winExe] }),
    null,
  );
  await writeFile(join(dirname(winExe), "resources", "app.asar"), "asar");
  assert.equal(
    await findDesktopApp("dsh", { platform: "win32", windowsCandidates: [winExe] }),
    winExe,
  );

  const appsDir = join(root, "mac", "Applications");
  const macApp = join(appsDir, "DeepSeek Harness.app");
  await mkdir(join(macApp, "Contents"), { recursive: true });
  await writeFile(join(macApp, "Contents", "Info.plist"), "<plist/>");
  assert.equal(
    await findDesktopApp("dsh", { platform: "darwin", applicationDirectories: [appsDir] }),
    macApp,
  );
});

test("inspectDshDesktopCli scrubs sensitive env vars and validates command-manager JSON", async (t) => {
  const fingerprint = "a".repeat(64);
  const envDump = join(tmpdir(), `memcode-dsh-env-${Date.now()}.json`);
  t.after(() => rm(envDump, { force: true }));

  const { desktopAppPath, launcherPath } = await createDesktopFixture(t, {
    managerScript: `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(Object.keys(process.env)));
process.stdout.write(JSON.stringify({
  ok: true,
  state: {
    fingerprint: ${JSON.stringify(fingerprint)},
    managed: true,
    available: true,
    activeCommand: ${JSON.stringify("C:\\fake\\dsh.cmd")},
    launcher: ${JSON.stringify("C:\\fake\\dsh.cmd")}
  }
}) + "\\n");
`,
  });

  const savedEnv = {
    SECRET_API_KEY: process.env.SECRET_API_KEY,
    MY_TOKEN: process.env.MY_TOKEN,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
  };
  process.env.SECRET_API_KEY = "must-not-leak";
  process.env.MY_TOKEN = "must-not-leak";
  process.env.NODE_OPTIONS = "--inspect";
  try {
    const info = await inspectDshDesktopCli(desktopAppPath);
    assert.equal(info.canInstall, true);
    assert.equal(info.managed, true);
    assert.equal(info.available, true);
    assert.equal(info.activeCommand, "C:\\fake\\dsh.cmd");
    assert.ok(info.launcherPath);

    const seenKeys = JSON.parse(await readFile(envDump, "utf8")) as string[];
    assert.equal(seenKeys.includes("SECRET_API_KEY"), false);
    assert.equal(seenKeys.includes("MY_TOKEN"), false);
    assert.equal(seenKeys.includes("NODE_OPTIONS"), false);
    assert.ok(launcherPath);
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("inspectDshDesktopCli degrades cleanly on missing helper or invalid fingerprint", async (t) => {
  const missing = await inspectDshDesktopCli(join(tmpdir(), "nonexistent", "DeepSeek Harness.exe"));
  assert.equal(missing.canInstall, false);
  assert.ok(missing.reason);

  const badFp = await createDesktopFixture(t, {
    managerScript: `process.stdout.write(JSON.stringify({ ok: true, state: { fingerprint: "short", managed: false, available: false } }) + "\\n");`,
  });
  const info = await inspectDshDesktopCli(badFp.desktopAppPath);
  assert.equal(info.canInstall, false);
  assert.match(info.reason ?? "", /unexpected response/i);
});

test("installDshDesktopCli passes fresh fingerprint and handles macOS EACCES without osascript", async (t) => {
  const fp1 = "1".repeat(64);
  const fp2 = "2".repeat(64);
  const okFixture = await createDesktopFixture(t, {
    managerScript: `const [op, fp] = process.argv.slice(2);
if (op === "inspect") {
  process.stdout.write(JSON.stringify({ ok: true, state: { fingerprint: ${JSON.stringify(fp1)}, managed: false, available: false } }) + "\\n");
} else if (op === "install") {
  if (fp !== ${JSON.stringify(fp1)}) {
    process.stdout.write(JSON.stringify({ ok: false, code: "ESTALE", message: "bad fp" }) + "\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ok: true, state: { fingerprint: ${JSON.stringify(fp2)}, managed: true, available: true } }) + "\\n");
}
`,
  });

  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const prevPath = process.env[pathKey];
  try {
    const installed = await installDshDesktopCli(okFixture.desktopAppPath);
    assert.equal(installed.installed, true);
    assert.equal(installed.launcherPath, okFixture.launcherPath);
    if (process.platform === "win32") {
      const parts = (process.env[pathKey] ?? "").split(delimiter).map((p) => p.toLowerCase());
      assert.ok(parts.includes(dirname(okFixture.launcherPath).toLowerCase()));
    }
  } finally {
    if (prevPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = prevPath;
  }

  const macEaccesFixture = await createDesktopFixture(t, {
    mac: true,
    managerScript: `const [op] = process.argv.slice(2);
if (op === "inspect") {
  process.stdout.write(JSON.stringify({ ok: true, state: { fingerprint: ${JSON.stringify(fp1)}, managed: false, available: false } }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ ok: false, code: "EACCES", message: "Permission denied" }) + "\\n");
  process.exit(1);
}
`,
  });
  const macRes = await installDshDesktopCli(macEaccesFixture.desktopAppPath);
  assert.equal(macRes.installed, false);
  assert.equal(macRes.needsDesktopMenu, true);
  assert.match(macRes.message, /Manage dsh Command/);
});
