import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../runtime/app";
import { findCommand, git, LocalStore, within } from "../runtime/local";
import type { Project } from "../src/shared";

test("new, existing-folder and launch-intent project creation add no starter work and preserve existing user work", async () => {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "memcode-project-creation-")),
    ),
    profile = join(root, "profile"),
    parent = join(root, "projects"),
    opened = join(root, "opened"),
    launchFolder = join(root, "launched");
  await mkdir(parent);
  await mkdir(opened);
  await mkdir(launchFolder);
  await writeFile(join(opened, "README.md"), "# Existing synthetic source\n");
  const calls: string[] = [];
  let selectedFolder = parent;
  const runtime = await createRuntime(
    profile,
    root,
    {
      call: async (method) => {
        calls.push(method);
        if (method === "beta_store_read")
          return { configured: false, credentials: null } as any;
        if (method === "select_folder") return selectedFolder as any;
        if (method === "preview_hide") return null as any;
        throw Error("Unexpected native action: " + method);
      },
    },
    () => {},
    { discoverHarnesses: async () => [] },
  );
  const originalPath = process.env.PATH;
  try {
    runtime.store.state.settings.memtracePath = join(
      root,
      "not-installed",
      "memtrace.exe",
    );
    const previousTasks = structuredClone(runtime.store.state.tasks),
      previousEpics = structuredClone(runtime.store.state.epics),
      previousCycles = structuredClone(runtime.store.state.cycles);
    await runtime.request("project:select-folder");
    if (process.platform === "win32") {
      const command = await findCommand("git");
      assert.ok(command, "This project creation test requires Git");
      // The first 6,999 characters fill the runtime's child PATH budget.
      const padding = Array.from({ length: 35 }, (_, index) =>
        join(root, `unused-path-${index}`).padEnd(199, "x"),
      );
      process.env.PATH = [...padding, dirname(command.command)].join(delimiter);
    }
    const fresh = (await runtime.request("project:create", {
      mode: "new",
      parent,
      name: "Synthetic Observatory",
      description: "A user-authored purpose, not an automatic task.",
    })) as Project;
    assert.equal(await git(fresh.path!, ["branch", "--show-current"]), "main");
    const retryPath = join(parent, "retry-brief");
    await mkdir(retryPath);
    const retried = (await runtime.request("project:create", {
      mode: "new",
      parent,
      name: "Retry brief",
      description: "Reuse an empty folder from an earlier attempt.",
    })) as Project;
    assert.equal(retried.path, retryPath);
    assert.equal(await git(retryPath, ["rev-list", "--count", "HEAD"]), "1");
    const occupied = join(parent, "occupied");
    await mkdir(occupied);
    await writeFile(join(occupied, "README.md"), "# Keep this file\n");
    await assert.rejects(
      runtime.request("project:create", {
        mode: "new",
        parent,
        name: "Occupied",
        description: "",
      }),
      /folder with that name already exists/i,
    );
    assert.equal(await readFile(join(occupied, "README.md"), "utf8"), "# Keep this file\n");
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    selectedFolder = opened;
    await runtime.request("project:select-folder");
    const existing = (await runtime.request("project:create", {
      mode: "existing",
      parent: opened,
      name: "Existing source",
      description: "Preserve the existing files.",
    })) as Project;
    const launch = await runtime.openProject(
      launchFolder,
      "Launch intent source",
    );
    for (const project of [fresh, retried, existing, launch]) {
      await runtime.request("project:analyze", project.id);
      assert.equal(
        runtime.store.state.tasks.filter(
          (task) => task.projectId === project.id,
        ).length,
        0,
      );
      assert.equal(
        runtime.store.state.epics.filter(
          (epic) => epic.projectId === project.id,
        ).length,
        0,
      );
      assert.equal(
        runtime.store.state.cycles.filter(
          (cycle) => cycle.projectId === project.id,
        ).length,
        0,
      );
      assert.equal(
        runtime.store.state.projectOnboarding?.[project.id].step,
        "context",
      );
      assert.equal(
        runtime.store.state.projectOnboarding?.[project.id].dismissed,
        false,
      );
    }
    assert.deepEqual(runtime.store.state.tasks, previousTasks);
    assert.deepEqual(runtime.store.state.epics, previousEpics);
    assert.deepEqual(runtime.store.state.cycles, previousCycles);
    await runtime.request("onboarding:update", {
      projectId: fresh.id,
      step: "worker",
      dismissed: true,
    });
    await runtime.request("project:select", launch.id);
    assert.equal(runtime.store.state.onboarding?.projectId, launch.id);
    assert.equal(runtime.store.state.onboarding?.step, "context");
    await runtime.request("project:select", fresh.id);
    assert.equal(runtime.store.state.onboarding?.step, "worker");
    assert.equal(runtime.store.state.onboarding?.dismissed, true);
    const reopened = await runtime.openProject(fresh.path!);
    assert.equal(reopened.id, fresh.id);
    assert.equal(runtime.store.state.onboarding?.dismissed, true);
    const disk = new LocalStore(profile);
    await disk.load();
    assert.equal(disk.state.projectOnboarding?.[fresh.id].step, "worker");
    assert.equal(disk.state.projectOnboarding?.[fresh.id].dismissed, true);
    assert.equal(disk.state.projectOnboarding?.[launch.id].step, "context");
    assert.equal(
      await readFile(join(opened, "README.md"), "utf8"),
      "# Existing synthetic source\n",
    );
    assert.equal(
      calls.some((method) =>
        /open_|terminal|process|beta_store_write/.test(method),
      ),
      false,
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await runtime.close();
    assert.ok(
      within(await realpath(tmpdir()), root) &&
        basename(root).startsWith("memcode-project-creation-"),
    );
    await rm(root, { recursive: true, force: true });
  }
});
