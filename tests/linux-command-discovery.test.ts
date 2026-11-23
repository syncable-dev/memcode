import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCommand } from "../runtime/commands";

async function linuxPathFixture(t: test.TestContext, names: string[]) {
  const root = await mkdtemp(join(tmpdir(), "memcode-linux-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commands = new Map<string, string>();
  for (const name of names) {
    const path = join(root, name);
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    commands.set(name, path);
  }
  const beforePath = process.env.PATH;
  const beforePlatform = Object.getOwnPropertyDescriptor(process, "platform");
  process.env.PATH = root;
  // findCommand reads process.platform directly. Stub it so this regression is
  // observable on a Windows development machine as well as on Linux CI.
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
  t.after(() => {
    if (beforePlatform)
      Object.defineProperty(process, "platform", beforePlatform);
    if (beforePath === undefined) delete process.env.PATH;
    else process.env.PATH = beforePath;
  });
  return commands;
}

test("extensionless PATH executables are discovered on Linux", async (t) => {
  const commands = await linuxPathFixture(t, ["git", "gh", "dsh"]);
  for (const [name, path] of commands)
    assert.deepEqual(await findCommand(name), { command: path, prefix: [] });
});
