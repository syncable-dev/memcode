import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime/app.ts";
import { repoRelativePath } from "../runtime/context/source.ts";
import type { Project, WorkItem } from "../src/shared.ts";

const project = { id: "p1", path: "/repo/acme-shop", repoId: "acme-shop" } as Project;

test("Memtrace's file paths become paths inside the repository", () => {
  assert.equal(repoRelativePath(project, "acme-shop/src/cart.js"), "src/cart.js", "repo-prefixed");
  assert.equal(repoRelativePath(project, "/repo/acme-shop/src/cart.js"), "src/cart.js", "absolute");
  assert.equal(repoRelativePath(project, "src/cart.js"), "src/cart.js", "already relative");
  assert.equal(repoRelativePath(project, "./README.md"), "README.md");
});

test("a planned task is created with the files it will change as its scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memcode-task-scope-"));
  const runtime = await createRuntime(dir, dir, { call: async () => { throw Error("Unexpected native call"); } }, () => {});
  try {
    const projectId = runtime.store.state.projects[0].id;
    const created = (await runtime.request("task:create", {
      projectId,
      title: "Document discount codes",
      description: "Add a README section.",
      priority: "medium",
      harness: "codex",
      scope: ["README.md"],
    })) as WorkItem;
    assert.deepEqual(created.scope, ["README.md"]);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
