import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  realpath,
  readFile,
  rm,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveMcpWorkspace,
  standaloneMcpWorkspace,
  projectMcpWorkspace,
  normalizeMcpEnvironment,
} from "../runtime/memtrace-workspace.ts";

test("MCP uses an existing Folder Group for an immediate normal repository, preserving the project path", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "memcode-workspace-owner-")),
    project = join(workspace, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await writeFile(join(workspace, ".memtrace-workspace"), "");
  const original = project;
  assert.deepEqual(await resolveMcpWorkspace(project), {
    directory: await realpath(workspace),
    workspace: await realpath(workspace),
  });
  assert.equal(project, original);
});

test("unmarked parents and nested repositories retain their own scope", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "memcode-workspace-scope-")),
    project = join(workspace, "project"),
    nested = join(workspace, "nested", "repo");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(nested, ".git"), { recursive: true });
  assert.deepEqual(await resolveMcpWorkspace(project), {
    directory: await realpath(project),
  });
  await writeFile(join(workspace, ".memtrace-workspace"), "");
  assert.deepEqual(await resolveMcpWorkspace(nested), {
    directory: await realpath(nested),
  });
});

test("a .git file and a non-repository folder do not inherit a parent group", async () => {
  const workspace = await mkdtemp(
      join(tmpdir(), "memcode-workspace-membership-"),
    ),
    worktree = join(workspace, "worktree"),
    folder = join(workspace, "folder");
  await mkdir(worktree);
  await mkdir(folder);
  await writeFile(join(workspace, ".memtrace-workspace"), "");
  await writeFile(join(worktree, ".git"), "gitdir: somewhere-else");
  assert.deepEqual(await resolveMcpWorkspace(worktree), {
    directory: await realpath(worktree),
  });
  assert.deepEqual(await resolveMcpWorkspace(folder), {
    directory: await realpath(folder),
  });
});

test("an explicitly marked project is its own discovery owner", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "memcode-workspace-self-")),
    project = join(workspace, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await writeFile(join(workspace, ".memtrace-workspace"), "");
  await writeFile(join(project, ".memtrace-workspace"), "");
  assert.deepEqual(await resolveMcpWorkspace(project), {
    directory: await realpath(project),
    workspace: await realpath(project),
  });
});

test("fallback manifest admits one exact project and preserves an existing edited manifest", async () => {
  const project = await mkdtemp(join(tmpdir(), "memcode-private-scope-"));
  const scope = await projectMcpWorkspace(project);
  const text = await readFile(scope.workspaceFile, "utf8");
  assert.equal(
    text,
    `version = 1\nname = "MemCode project"\nmembers = [${JSON.stringify((await realpath(project)).replaceAll("\\", "/"))}]\n`,
  );
  assert.ok(scope.dataDirectory.startsWith(await realpath(project)));
  assert.deepEqual(await projectMcpWorkspace(project), scope);
  await writeFile(scope.workspaceFile, 'version = 1\nmembers = ["other"]\n');
  await assert.rejects(projectMcpWorkspace(project), /manifest has changed/);
  assert.equal(
    await readFile(scope.workspaceFile, "utf8"),
    'version = 1\nmembers = ["other"]\n',
  );
});

test("the MCP SDK receives a single uppercase PATH with the prepared child path preserved", () => {
  const source = {
    Path: "prepared-git;prepared-node",
    APPDATA: "fixture-data",
    MODEL_SETTING: "retained",
  };
  const result = normalizeMcpEnvironment(source);
  assert.equal(result.PATH, source.Path);
  assert.equal(result.Path, undefined);
  assert.equal(result.MODEL_SETTING, "retained");
  assert.equal(result.APPDATA, "fixture-data");
  assert.equal(source.Path, "prepared-git;prepared-node");
  assert.deepEqual(
    Object.keys(
      normalizeMcpEnvironment({ PATH: "prepared", Path: "duplicate" }),
    ).filter((key) => key.toLowerCase() === "path"),
    ["PATH"],
  );
});

test("managed project graphs open under the app profile without touching a legacy owner's store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memcode-managed-graph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "checkout");
  await mkdir(project);
  const legacy = await projectMcpWorkspace(project);
  await mkdir(legacy.dataDirectory);
  const owner = join(legacy.dataDirectory, "daemon-state.json");
  const existingOwner = JSON.stringify({
    pid: process.pid,
    installRoot: "/cli-install",
  });
  await writeFile(owner, existingOwner);
  const graphRoot = join(root, "profile", "memtrace-projects");

  const managed = await projectMcpWorkspace(project, {
    managedGraphRoot: graphRoot,
  });

  assert.equal(managed.directory, await realpath(project));
  assert.match(
    relative(await realpath(graphRoot), managed.dataDirectory)
      .split(sep)
      .join("/"),
    /^[a-f0-9]{32}\/\.memcode\/memtrace\/\.memdb$/,
  );
  assert.equal(await readFile(owner, "utf8"), existingOwner);
  assert.equal(
    await readFile(managed.workspaceFile, "utf8"),
    await readFile(legacy.workspaceFile, "utf8"),
  );
  assert.deepEqual(
    await projectMcpWorkspace(project, { managedGraphRoot: graphRoot }),
    managed,
  );
  const current = await projectMcpWorkspace(project, {
    managedGraphRoot: graphRoot,
    currentSourceOnly: true,
  });
  assert.notEqual(current.dataDirectory, managed.dataDirectory);
  assert.notEqual(current.dataDirectory, legacy.dataDirectory);
  assert.equal(await readFile(current.workspaceFile, "utf8"), await readFile(managed.workspaceFile, "utf8"));
  assert.equal(await readFile(owner, "utf8"), existingOwner);
  assert.deepEqual(await projectMcpWorkspace(project, {
    managedGraphRoot: graphRoot, currentSourceOnly: true,
  }), current);
});

test("standalone MemCode binds the original folder store from outside the linked workers' repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memcode-primary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(await realpath(root), "repo"),
    profile = join(root, "profile");
  await mkdir(join(project, ".git"), { recursive: true });
  const graph = join(project, ".memdb");
  await mkdir(graph);
  const scope = join(graph, ".memtrace-store-scope.json");
  const source = (path: string) =>
    JSON.stringify({
      version: 1,
      scope_source: { kind: "folder" },
      members: [{ path, repo_id: "repo" }],
    });
  await writeFile(scope, source(project));
  const binding = await standaloneMcpWorkspace(project, profile, {});
  assert.ok(binding);
  assert.equal(binding.dataDirectory, graph);
  assert.equal(binding.jobDirectory, join(project, ".memtrace"));
  assert.ok(binding.workspaceFile.startsWith((await realpath(profile)) + sep));
  assert.ok(
    (await readFile(binding.workspaceFile, "utf8")).includes(
      JSON.stringify(project.replaceAll("\\", "/")),
    ),
  );
  assert.equal(await readFile(scope, "utf8"), source(project));
  const publishedByMemCode = JSON.stringify({
    version: 1,
    scope_source: { kind: "manifest", manifest_path: binding.workspaceFile },
    members: [{ path: project, repo_id: "repo" }],
  });
  await writeFile(scope, publishedByMemCode);
  assert.deepEqual(await standaloneMcpWorkspace(project, profile, {}), binding);
  assert.equal(await readFile(scope, "utf8"), publishedByMemCode);
  assert.equal(
    await standaloneMcpWorkspace(project, profile, {
      MEMTRACE_MEMDB_ENDPOINT: "http://localhost:9000",
    }),
    null,
  );
  await writeFile(scope, source(join(root, "another-project")));
  await assert.rejects(
    standaloneMcpWorkspace(project, profile, {}),
    /different checkout/,
  );
  await writeFile(scope, source(project));
  await writeFile(binding.workspaceFile, 'members = ["unrelated"]');
  await assert.rejects(
    standaloneMcpWorkspace(project, profile, {}),
    /manifest has changed/,
  );
});

test("standalone workspace discovery leaves an unbound or operator-managed store alone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memcode-unbound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(await realpath(root), "repo"),
    profile = join(root, "profile");
  await mkdir(join(project, ".git"), { recursive: true });
  assert.equal(await standaloneMcpWorkspace(project, profile, {}), null);
  await mkdir(join(project, ".memdb"));
  await writeFile(
    join(project, ".memdb", ".memtrace-store-scope.json"),
    JSON.stringify({
      version: 1,
      scope_source: { kind: "manifest", manifest_path: join(root, "operator.toml") },
      members: [{ path: project }],
    }),
  );
  assert.equal(await standaloneMcpWorkspace(project, profile, {}), null);
  await mkdir(join(project, ".memtrace"));
  await writeFile(join(project, ".memtrace", "team.toml"), "[memdb]");
  assert.equal(await standaloneMcpWorkspace(project, profile, {}), null);
  await assert.rejects(readFile(profile), { code: "ENOENT" });
});

test("standalone binding refuses a redirected store before launching a client", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memcode-store-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "repo");
  await mkdir(join(project, ".git"), { recursive: true });
  await symlink(root, join(project, ".memdb"), "junction");
  await assert.rejects(
    standaloneMcpWorkspace(project, join(root, "profile"), {}),
    /redirected path/,
  );
});
