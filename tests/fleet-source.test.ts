import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  realpath,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import { git, within } from "../runtime/local";
import { rereadFleetSource } from "../runtime/fleet-source";
import type { WorkItem } from "../src/shared";

/** A checkout with one shared file and a task planned on it; re-reading needs no engine. */
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "memcode-fleet-source-")),
  );
  await git(root, ["init", "--initial-branch=main"]);
  await writeFile(
    join(root, "shared.ts"),
    "export const contract = 'first plan';\n",
  );
  const state = initialState(),
    project = {
      ...state.projects[0],
      id: "source",
      path: root,
      repoId: "source",
      analysis: "ready" as const,
      example: false,
    };
  const tasks = [
    {
      ...state.tasks[0],
      id: "reader",
      projectId: project.id,
      example: false,
      scope: ["shared.ts"],
      evidence: undefined,
      messages: [],
      run: { state: "running", branch: "main", workspace: root },
    } as WorkItem,
  ];
  return { root, project, tasks, release: () => rm(root, { recursive: true, force: true }) };
}

test("a planned folder is re-read as its tracked and newly created files", async () => {
  const f = await fixture();
  try {
    const task = { ...f.tasks[0], scope: ["parts/"] };
    await mkdir(join(f.root, "parts"));
    await writeFile(join(f.root, "parts", "before.ts"), "export const before = 1;\n");
    await git(f.root, ["add", "parts"]);
    await writeFile(join(f.root, "parts", "after.ts"), "export const after = 2;\n");
    const reread = await rereadFleetSource(f.project, task);
    assert.deepEqual(reread.files.map((file) => file.file).sort(), [
      "parts/after.ts",
      "parts/before.ts",
    ]);
    assert.equal(reread.truncated, false);
  } finally {
    await f.release();
  }
});

test("a re-read can be narrowed to the files two workers actually share", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "other.ts"), "export const other = 1;\n");
    const task = { ...f.tasks[0], scope: ["shared.ts", "other.ts"] };
    const reread = await rereadFleetSource(f.project, task, ["other.ts"]);
    assert.deepEqual(reread.files.map((file) => file.file), ["other.ts"]);
    assert.match(reread.files[0].text!, /other = 1/);
  } finally {
    await f.release();
  }
});

test("directory rereads preserve literal paths and report bounded coverage", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "[parts]"));
    await mkdir(join(f.root, "parts"));
    await writeFile(
      join(f.root, "parts", "unrelated.ts"),
      "Never read the glob match",
    );
    for (let i = 0; i < 23; i++)
      await writeFile(
        join(f.root, "[parts]", `helper ${i}.ts`),
        "export const value = 1;\n",
      );
    const result = await rereadFleetSource(f.project, {
      ...f.tasks[0],
      scope: ["[parts]/"],
      evidence: undefined,
    });
    assert.equal(result.files.length, 20);
    assert.equal(result.truncated, true);
    assert.ok(result.files.every((file) => file.file.startsWith("[parts]/")));
  } finally {
    await f.release();
  }
});

test("Fleet rereads a selected project alias but still rejects a source link outside its canonical root", async () => {
  const f = await fixture(),
    outside = await realpath(
      await mkdtemp(join(tmpdir(), "memcode-fleet-outside-")),
    ),
    alias = join(f.root, "selected-alias");
  try {
    await symlink(
      f.root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await rereadFleetSource(
      { ...f.project, path: alias },
      f.tasks[0],
    );
    assert.equal(result.files[0].file, "shared.ts");
    assert.match(result.files[0].text!, /first plan/);
    const measured = await rereadFleetSource(
      { ...f.project, path: alias },
      { ...f.tasks[0], scope: [join(f.root, "shared.ts")] },
    );
    assert.equal(
      measured.files[0].file,
      "shared.ts",
      "Canonical engine anchors stay inside the selected alias",
    );
    await writeFile(join(outside, "private.ts"), "Never share outside source");
    await symlink(
      outside,
      join(f.root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      rereadFleetSource(
        { ...f.project, path: alias },
        { ...f.tasks[0], scope: ["escape/"] },
      ),
      /resolves outside/,
    );
    await assert.rejects(
      rereadFleetSource(
        { ...f.project, path: alias },
        { ...f.tasks[0], scope: ["escape/private.ts"] },
      ),
      /resolves outside/,
    );
    await assert.rejects(
      rereadFleetSource(
        { ...f.project, path: alias },
        { ...f.tasks[0], scope: ["../outside.ts"] },
      ),
      /outside/,
    );
  } finally {
    await f.release();
    assert.ok(within(await realpath(tmpdir()), outside));
    await rm(outside, { recursive: true, force: true });
  }
});
