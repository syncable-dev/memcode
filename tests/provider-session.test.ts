import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, WorkItem } from "../src/shared";
import {
  previousProviderSession,
  resumableProviderSession,
} from "../runtime/provider-session";
import { restartSafeState } from "../src/domain";
import { initialState } from "../src/seed";

test("native conversation binding survives a restart and is scoped to provider, epic, branch and physical checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-native-binding-"));
  try {
    const other = join(root, "other");
    await mkdir(other);
    for (const harness of ["codex", "claude", "cursor"] as Harness[]) {
      const task = {
        id: "binding",
        harness,
        epicId: "epic-a",
        messages: [],
        route: { harness },
        run: {
          state: "finished",
          sessionId: "native-id",
          workspace: root,
          branch: "epic/a",
          measurements: { modelSource: `${harness}-thread` },
        },
      } as unknown as WorkItem;
      const previous = previousProviderSession(task)!;
      task.run.sessionBinding = {
        harness,
        workspace: root,
        branch: "epic/a",
        epicId: "epic-a",
      };
      assert.equal(
        await resumableProviderSession(previous, task, root),
        "native-id",
      );
      assert.equal(
        await resumableProviderSession(previous, task, other),
        undefined,
      );
      assert.equal(
        await resumableProviderSession(
          previous,
          { ...task, harness: harness === "codex" ? "claude" : "codex" },
          root,
        ),
        undefined,
      );
      assert.equal(
        await resumableProviderSession(
          previous,
          { ...task, epicId: "epic-b" },
          root,
        ),
        undefined,
      );
      assert.equal(
        await resumableProviderSession(
          previous,
          { ...task, run: { ...task.run, branch: "epic/b" } },
          root,
        ),
        undefined,
      );
      const state = initialState();
      state.tasks = [task];
      const restored = restartSafeState(JSON.parse(JSON.stringify(state)))
        .tasks[0];
      assert.deepEqual(previousProviderSession(restored), previous);
      assert.equal(
        await resumableProviderSession(
          previousProviderSession(restored),
          restored,
          root,
        ),
        "native-id",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy run without an actual route cannot be invented as a resumable provider session", () => {
  assert.equal(
    previousProviderSession({
      run: { sessionId: "ambiguous", workspace: "somewhere", branch: "main" },
    } as WorkItem),
    undefined,
  );
});
