import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeProjectRepository } from "../runtime/project-repository";

const PROJECT = { name: "Shop", description: "Sell things." };

/** An empty project folder, and a Git setting that refuses every commit until lifted. */
async function folderWhoseFirstCommitFails(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "memcode-setup-fails-"));
  const folder = join(root, "shop");
  const hooks = join(root, "hooks");
  await mkdir(folder);
  await mkdir(hooks);
  await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const config = join(root, "gitconfig");
  await writeFile(config, `[core]\n\thooksPath = ${hooks}\n`);
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  const lift = () => {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before;
  };
  t.after(async () => {
    lift();
    await rm(root, { recursive: true, force: true });
  });
  return { folder, lift };
}

test("when a project's Git setup fails partway, the folder is left as it was", { skip: process.platform === "win32" }, async (t) => {
  const { folder } = await folderWhoseFirstCommitFails(t);

  await assert.rejects(initializeProjectRepository(folder, PROJECT));

  assert.deepEqual(await readdir(folder), []);
});

test("a project whose setup failed can be set up again in the same folder", { skip: process.platform === "win32" }, async (t) => {
  const { folder, lift } = await folderWhoseFirstCommitFails(t);
  await assert.rejects(initializeProjectRepository(folder, PROJECT));
  lift();

  await initializeProjectRepository(folder, PROJECT);

  assert.deepEqual((await readdir(folder)).sort(), [".git", ".gitignore", "README.md"]);
});
