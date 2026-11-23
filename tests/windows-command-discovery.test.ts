import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, sep } from "node:path";
import { commandIdentity, findCommand } from "../runtime/commands";

// Byte-for-byte shape of the launcher written by the official DSH installer,
// including CRLF and the real relative depths from resources/runtime/cli/bin.
const officialShim = [
  "@echo off",
  "setlocal DisableDelayedExpansion",
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
  "exit /b %errorlevel%",
  "",
].join("\r\n");

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "memcode-win-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const install = join(root, "install");
  const bin = join(install, "resources", "runtime", "cli", "bin");
  await mkdir(bin, { recursive: true });
  const exe = join(install, "DeepSeek Harness.exe");
  const asar = join(install, "resources", "app.asar");
  await writeFile(exe, "fixture-only");
  await writeFile(asar, "fixture-only");
  const script = join(
    install,
    "resources",
    "app.asar",
    "dsh",
    "node_modules",
    "@deepseek-ai",
    "dsh-desktop-host",
    "lib",
    "cli.js",
  );
  const before = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  });
  return { root, install, bin, exe, asar, script };
}

test(
  "the real dsh.cmd layout is normalized for argument-array spawn",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.bin, "dsh.cmd"), officialShim);

    const command = await findCommand("dsh");
    assert.ok(command, "the .cmd launcher must be discovered");
    assert.equal(command.command, f.exe);
    assert.deepEqual(command.prefix, ["--expose-internals", f.script]);
    assert.equal(command.env?.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(commandIdentity(command), f.script);
  },
);

test(
  "a real dsh.exe in the same directory still wins over the dsh.cmd launcher",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.bin, "dsh.cmd"), officialShim);
    const exe = join(f.bin, "dsh.exe");
    await writeFile(exe, "fixture-only");

    const command = await findCommand("dsh");
    assert.equal(command?.command, exe);
    assert.deepEqual(command?.prefix, []);
  },
);

test(
  "an unrelated .cmd is never handed to a shell:false spawn",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.bin, "dsh.cmd"), "@echo off\r\nfixture-only\r\n");

    assert.equal(await findCommand("dsh"), null);
  },
);

test(
  "a rem line containing --expose-internals cannot spoof the launcher",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.bin, "dsh.cmd"),
      `@echo off\r\nrem "C:\\evil.exe" --expose-internals "a.js"\r\n${officialShim}`,
    );

    const command = await findCommand("dsh");
    assert.equal(command?.command, f.exe);
    assert.deepEqual(command?.prefix, ["--expose-internals", f.script]);
  },
);

test(
  "an executable with a different name cannot borrow the DSH launcher identity",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.install, "Other.exe"), "fixture-only");
    await writeFile(
      join(f.bin, "dsh.cmd"),
      officialShim.replace("DeepSeek Harness.exe", "Other.exe"),
    );

    assert.equal(await findCommand("dsh"), null);
  },
);

test(
  "an entry outside the installation's app.asar is rejected",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.bin, "dsh.cmd"),
      officialShim.replace(
        "app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js",
        "other\\cli.js",
      ),
    );

    assert.equal(await findCommand("dsh"), null);
  },
);

test(
  "a shim from an incomplete installation without app.asar is ignored",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.bin, "dsh.cmd"), officialShim);
    await rm(f.asar);

    assert.equal(await findCommand("dsh"), null);
  },
);

test(
  "an echo mentioning the flag cannot shadow the real launcher line",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.bin, "dsh.cmd"),
      `@echo off\r\necho "%~dp0..\\..\\..\\..\\Other.exe" --expose-internals "x.js" %*\r\n${officialShim}`,
    );

    const command = await findCommand("dsh");
    assert.equal(command?.command, f.exe);
    assert.deepEqual(command?.prefix, ["--expose-internals", f.script]);
  },
);

test(
  "a leftover shim whose executable is gone is ignored",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.bin, "dsh.cmd"), officialShim);
    await rm(f.exe);

    assert.equal(await findCommand("dsh"), null);
  },
);

test(
  "an npm-style cmd shim cannot displace the node_modules fallback",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.bin, "dsh.cmd"),
      '"%~dp0\\node.exe" --expose-internals "%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
    );
    const fallback = join(
      f.bin,
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
      "bin.js",
    );
    await mkdir(join(f.bin, "node_modules", "@deepseek-ai", "dsh", "lib"), {
      recursive: true,
    });
    await writeFile(fallback, "");

    const command = await findCommand("dsh");
    assert.equal(command?.command, process.execPath);
    assert.deepEqual(command?.prefix, [fallback]);
  },
);

test(
  "between PATH directories the first entry wins, even when it only has a .cmd",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.bin, "dsh.cmd"), officialShim);
    const other = join(f.root, "other");
    await mkdir(other, { recursive: true });
    const otherExe = join(other, "dsh.exe");
    await writeFile(otherExe, "fixture-only");

    process.env.PATH = `${f.bin};${other}`;
    assert.equal((await findCommand("dsh"))?.command, f.exe);

    process.env.PATH = `${other};${f.bin}`;
    assert.equal((await findCommand("dsh"))?.command, otherExe);
  },
);

async function withoutLauncherInPath(t: test.TestContext) {
  const f = await fixture(t);
  const elsewhere = join(f.root, "empty-path");
  await mkdir(elsewhere, { recursive: true });
  process.env.PATH = elsewhere;
  return f;
}

test(
  "a saved app.asar identity rediscovers the harness without the launcher directory in PATH",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await withoutLauncherInPath(t);
    assert.equal(
      await findCommand("dsh"),
      null,
      "the installer's launcher directory must be absent",
    );

    const command = await findCommand("dsh", f.script);
    assert.ok(command, "the saved identity must rediscover the installation");
    assert.equal(command.command, f.exe);
    assert.deepEqual(command.prefix, ["--expose-internals", f.script]);
    assert.equal(commandIdentity(command), f.script);
    assert.equal(command.env?.ELECTRON_RUN_AS_NODE, "1");
  },
);

test(
  "a saved archive identity is only reconstructed from a still matching installation",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await withoutLauncherInPath(t);
    assert.equal(
      await findCommand("codex", f.script),
      null,
      "another harness must not inherit the dsh archive identity",
    );

    await rm(f.exe);
    assert.equal(await findCommand("dsh", f.script), null);
    await writeFile(f.exe, "fixture-only");

    await rm(f.asar);
    assert.equal(await findCommand("dsh", f.script), null);
  },
);

test(
  "a configured executable path keeps its direct-command behavior",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await withoutLauncherInPath(t);
    assert.equal((await findCommand("dsh", f.exe))?.command, f.exe);
  },
);

test(
  "a saved archive identity cannot traverse into another installation",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await withoutLauncherInPath(t);
    const other = join(f.root, "other");
    const otherScript = join(
      other,
      "resources",
      "app.asar",
      "dsh",
      "cli.js",
    );
    await mkdir(join(other, "resources"), { recursive: true });
    await writeFile(join(other, "DeepSeek Harness.exe"), "fixture-only");
    await writeFile(join(other, "resources", "app.asar"), "fixture-only");

    const from = dirname(f.script);
    const forged = from + sep + relative(from, otherScript);
    assert.equal(normalize(forged), otherScript);
    assert.equal(await findCommand("dsh", forged), null);
  },
);
