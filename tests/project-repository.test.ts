import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  mkdir,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  ensureLocalRuntimeIgnored,
  ensureProjectRepository,
} from "../runtime/project-repository";
import { git } from "../runtime/local";
import type { Project } from "../src/shared";
const project = (path: string): Project => ({
  id: "fixture",
  name: "First project",
  description: "A useful website",
  path,
  branch: "main",
  analysis: "idle",
  createdAt: new Date().toISOString(),
});

test("an empty selected project receives a clean Git baseline and can enter an epic", async () => {
  const path = await mkdtemp(join(tmpdir(), "memcode-empty-project-")),
    item = project(path);
  await ensureProjectRepository(item);
  assert.match(
    await readFile(join(path, "README.md"), "utf8"),
    /A useful website/,
  );
  assert.equal(await git(path, ["status", "--porcelain"]), "");
  assert.ok(await git(path, ["rev-parse", "HEAD"]));
  await git(path, ["switch", "-c", "epic/first"]);
  assert.equal(await git(path, ["branch", "--show-current"]), "epic/first");
});
test("nonempty folders and nested repository selections are preserved rather than adopted", async () => {
  const path = await mkdtemp(join(tmpdir(), "memcode-existing-project-"));
  await writeFile(join(path, "notes.txt"), "Existing user file");
  await assert.rejects(
    ensureProjectRepository(project(path)),
    /not a Git repository/,
  );
  assert.deepEqual(await readdir(path), ["notes.txt"]);
  await git(path, ["init", "--initial-branch=main"]);
  await ensureProjectRepository(project(path));
  assert.equal(
    await readFile(join(path, "notes.txt"), "utf8"),
    "Existing user file",
  );
  assert.match(await git(path, ["status", "--porcelain"]), /notes.txt/);
  const nested = join(path, "nested");
  await mkdir(nested);
  await assert.rejects(
    ensureProjectRepository(project(nested)),
    /repository root/,
  );
  assert.deepEqual(await readdir(nested), []);
});

async function existingRepository() {
  const directory = await mkdtemp(
    join(tmpdir(), "memcode-ignore-preparation-"),
  );
  const path = join(directory, "repo");
  await mkdir(path);
  await git(path, ["init", "--initial-branch=main"]);
  await writeFile(join(path, "source.ts"), "export const ready = true;\n");
  await git(path, ["add", "--", "source.ts"]);
  await git(path, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Existing project",
  ]);
  const gitPath = await git(path, ["rev-parse", "--git-path", "info/exclude"]);
  return {
    directory,
    path,
    exclude: isAbsolute(gitPath) ? gitPath : resolve(path, gitPath),
  };
}

test("analysis follows the actual primary branch after restart without switching files or accepting a foreign epic branch", async () => {
  const f = await existingRepository();
  try {
    await git(f.path, ["switch", "-c", "epic/current"]);
    await writeFile(join(f.path, "source.ts"), "export const ready = false; // keep this edit\n");
    const item = { ...project(f.path), analysis: "ready" as const, repoId: "existing" };
    await ensureProjectRepository(item);
    assert.equal(item.branch, "epic/current");
    assert.equal(item.analysis, "idle");
    assert.equal(item.repoId, "existing");
    assert.match(await readFile(join(f.path, "source.ts"), "utf8"), /keep this edit/);
    await assert.rejects(ensureProjectRepository({ ...item, branch: "epic/foreign", analysisCurrentSource: true }), /epic checkout changed branch/);
    assert.equal(await git(f.path, ["branch", "--show-current"]), "epic/current");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("existing repository analysis preparation ignores runtime stores before they are created without adding a source ignore file", async () => {
  const f = await existingRepository();
  try {
    const head = await git(f.path, ["rev-parse", "HEAD"]);
    const userExclusions = "# Keep my local preferences\n/private-notes.txt";
    await writeFile(f.exclude, userExclusions);
    await ensureProjectRepository(project(f.path));
    await assert.rejects(readFile(join(f.path, ".gitignore")), {
      code: "ENOENT",
    });
    for (const directory of [
      ".memcode/memtrace/.memdb",
      ".memdb",
      ".memtrace",
    ]) {
      await mkdir(join(f.path, directory), { recursive: true });
      await writeFile(
        join(f.path, directory, "private-state.bin"),
        "Local graph and job data",
      );
    }
    const ignored = await git(f.path, [
      "check-ignore",
      "--",
      ".memcode/memtrace/.memdb/private-state.bin",
      ".memdb/private-state.bin",
      ".memtrace/private-state.bin",
    ]);
    assert.equal(ignored.split(/\r?\n/).length, 3);
    assert.equal(
      await git(f.path, ["status", "--porcelain", "--untracked-files=all"]),
      "",
    );
    assert.equal(await git(f.path, ["rev-parse", "HEAD"]), head);
    assert.equal(
      await readFile(join(f.path, "source.ts"), "utf8"),
      "export const ready = true;\n",
    );
    assert.ok(
      (await readFile(f.exclude, "utf8")).startsWith(userExclusions + "\n"),
    );
    await writeFile(
      join(f.path, "feature.ts"),
      "export const visible = true;\n",
    );
    assert.match(await git(f.path, ["status", "--porcelain"]), /feature\.ts/);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("runtime exclusions are idempotent under concurrent preparation and preserve dirty source and project gitignore", async () => {
  const f = await existingRepository();
  try {
    const ignore = "# Project policy\ndist/\n",
      source = "export const ready = false; // user edit\n";
    await writeFile(join(f.path, ".gitignore"), ignore);
    await writeFile(join(f.path, "source.ts"), source);
    const before = await git(f.path, ["status", "--porcelain"]);
    await Promise.all(
      Array.from({ length: 8 }, () => ensureLocalRuntimeIgnored(f.path)),
    );
    const once = await readFile(f.exclude, "utf8");
    await ensureProjectRepository(project(f.path));
    assert.equal(await readFile(f.exclude, "utf8"), once);
    for (const entry of ["/.memcode/", "/.memdb/", "/.memtrace/"])
      assert.equal(
        once.split(/\r?\n/).filter((line) => line === entry).length,
        1,
      );
    assert.equal(await readFile(join(f.path, ".gitignore"), "utf8"), ignore);
    assert.equal(await readFile(join(f.path, "source.ts"), "utf8"), source);
    assert.equal(await git(f.path, ["status", "--porcelain"]), before);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("linked Git worktrees use Git's common exclusion file and preserve the gitdir pointer", async () => {
  const f = await existingRepository();
  try {
    const linked = join(f.directory, "linked");
    await git(f.path, ["worktree", "add", "-b", "fixture-linked", linked]);
    const gitdir = await readFile(join(linked, ".git"), "utf8");
    await ensureProjectRepository(project(linked));
    await mkdir(join(linked, ".memcode", "memtrace"), { recursive: true });
    await writeFile(
      join(linked, ".memcode", "memtrace", "workspace.toml"),
      "Private local membership",
    );
    assert.equal(
      await git(linked, [
        "check-ignore",
        "--",
        ".memcode/memtrace/workspace.toml",
      ]),
      ".memcode/memtrace/workspace.toml",
    );
    assert.equal(await git(linked, ["status", "--porcelain"]), "");
    assert.equal(await readFile(join(linked, ".git"), "utf8"), gitdir);
    assert.match(await readFile(f.exclude, "utf8"), /\/\.memcode\//);
    await assert.rejects(readFile(join(linked, ".gitignore")), {
      code: "ENOENT",
    });
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("an explicitly selected filesystem alias identifies the same Git root without adopting nested folders or changing source", async () => {
  const f = await existingRepository();
  const alias = join(f.directory, "selected-alias");
  try {
    await symlink(
      f.path,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const item = project(alias);
    const before = await readFile(join(f.path, "source.ts"), "utf8");
    await ensureProjectRepository(item);
    assert.equal(item.path, alias, "Keep the user's selected project binding");
    assert.equal(await readFile(join(alias, "source.ts"), "utf8"), before);
    assert.equal(await realpath(alias), await realpath(f.path));
    const nested = join(alias, "nested");
    await mkdir(nested);
    await assert.rejects(
      ensureProjectRepository(project(nested)),
      /repository root/,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("installing exclusions never untracks or overwrites pre-existing tracked runtime-named files", async () => {
  const f = await existingRepository();
  try {
    await mkdir(join(f.path, ".memcode"));
    await writeFile(
      join(f.path, ".memcode", "tracked.txt"),
      "Existing tracked project content",
    );
    await git(f.path, ["add", "--", ".memcode/tracked.txt"]);
    await git(f.path, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "Existing tracked configuration",
    ]);
    const head = await git(f.path, ["rev-parse", "HEAD"]);
    await ensureLocalRuntimeIgnored(f.path);
    assert.equal(
      await git(f.path, ["ls-files", "--", ".memcode/tracked.txt"]),
      ".memcode/tracked.txt",
    );
    assert.equal(
      await readFile(join(f.path, ".memcode", "tracked.txt"), "utf8"),
      "Existing tracked project content",
    );
    assert.equal(await git(f.path, ["rev-parse", "HEAD"]), head);
    assert.equal(await git(f.path, ["status", "--porcelain"]), "");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
