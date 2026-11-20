import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { initialState } from "../src/seed";
import { effectivePermissionMode } from "../src/permissions";
import { planRoute } from "../runtime/router";
import { applyTaskPatch } from "../runtime/task-planning";
import { createRuntime } from "../runtime/app";
import { within } from "../runtime/local";
import type { Evidence, HarnessRuntime } from "../src/shared";
import type { NativeHost } from "../runtime/host";

const catalog: HarnessRuntime[] = ["codex", "claude", "cursor"].map((id) => ({
  id: id as HarnessRuntime["id"],
  name: id,
  available: true,
  path: "fixture",
  models: (["fast", "balanced", "frontier", "extreme"] as const).map(
    (tier) => ({
      id: `${id}-${tier}`,
      label: tier,
      tier,
      source: "alias",
    }),
  ),
}));
const measured: Evidence = {
  state: "measured",
  symbols: [
    {
      name: "render",
      file: "src/components/View.tsx",
      line: 1,
      cognitive: 4,
      cyclomatic: 3,
      nesting: 2,
      metricSource: "ast",
    },
  ],
  affected: 2,
  affectedProcesses: 1,
  incomplete: false,
  note: "Measured test fixture only",
  measuredAt: "2026-11-15T00:00:00Z",
};

test("existing and new stories inherit each worker's default without materializing an override", () => {
  const state = initialState(),
    task = state.tasks[0];
  task.harness = "codex";
  delete task.permissionMode;
  assert.equal(effectivePermissionMode(task, state.settings), "review");
  state.settings.workerPermissionDefaults = {
    codex: "auto",
    claude: "full-access",
    cursor: "review",
  };
  assert.equal(effectivePermissionMode(task, state.settings), "auto");
  assert.equal(
    effectivePermissionMode(task, state.settings, "claude"),
    "full-access",
  );
  assert.equal(
    effectivePermissionMode(task, state.settings, "cursor"),
    "review",
  );
  assert.equal(task.permissionMode, undefined);
  state.settings.workerPermissionDefaults.codex = "full-access";
  assert.equal(effectivePermissionMode(task, state.settings), "full-access");
});

test("a story override wins until reset to inherit and never rewrites its active session", () => {
  const state = initialState(),
    task = state.tasks[0];
  task.harness = "codex";
  task.run = {
    state: "running",
    permissionMode: "review",
    sessionId: "existing-native-session",
  };
  state.settings.workerPermissionDefaults = { codex: "auto" };
  applyTaskPatch(state, task, { permissionMode: "full-access" });
  assert.equal(effectivePermissionMode(task, state.settings), "full-access");
  state.settings.workerPermissionDefaults.codex = "review";
  assert.equal(effectivePermissionMode(task, state.settings), "full-access");
  applyTaskPatch(state, task, { permissionMode: null });
  assert.equal(effectivePermissionMode(task, state.settings), "review");
  state.settings.workerPermissionDefaults.codex = "auto";
  assert.equal(effectivePermissionMode(task, state.settings), "auto");
  assert.equal(task.run.permissionMode, "review");
  assert.equal(task.run.sessionId, "existing-native-session");
});

test("automatic routing uses each candidate's default while explicit Smart auto excludes Cursor", () => {
  const state = initialState(),
    task = {
      ...state.tasks[0],
      assignment: "auto" as const,
      scope: ["src/components/View.tsx"],
      permissionMode: null,
    };
  state.settings.workerPermissionDefaults = {
    codex: "auto",
    claude: "review",
    cursor: "full-access",
  };
  const inherited = planRoute(task, measured, catalog, state.settings);
  assert.equal(inherited.harness, "cursor");
  assert.equal(
    effectivePermissionMode(task, state.settings, inherited.harness),
    "full-access",
  );
  const overridden = planRoute(
    { ...task, permissionMode: "auto" },
    measured,
    catalog,
    state.settings,
  );
  assert.equal(overridden.harness, "codex");
  assert.equal(
    effectivePermissionMode(
      { ...task, permissionMode: "auto" },
      state.settings,
      overridden.harness,
    ),
    "auto",
  );
});

test("worker defaults persist through native runtime routes without changing overrides, connections or active modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-defaults-test-"));
  const host: NativeHost = {
    async call<T>() {
      return undefined as T;
    },
  };
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    runtime = await createRuntime(root, root, host, () => {});
    const state = runtime.store.state,
      task = state.tasks[0];
    const staleSettingsDraft = structuredClone(state.settings);
    task.permissionMode = "review";
    task.run = {
      state: "running",
      permissionMode: "review",
      sessionId: "unchanged",
    };
    const connections = JSON.stringify(state.workerConnections);
    await runtime.request("worker:permission-default", {
      harness: "codex",
      mode: "auto",
    });
    await runtime.request("worker:permission-default", {
      harness: "cursor",
      mode: "full-access",
    });
    await runtime.request("worker:permission-default", {
      harness: "copilot",
      mode: "full-access",
    });
    await runtime.request("worker:permission-default", {
      harness: "dsh",
      mode: "review",
    });
    const expectedDefaults = {
      codex: "auto",
      cursor: "full-access",
      copilot: "full-access",
      dsh: "review",
    };
    assert.deepEqual(state.settings.workerPermissionDefaults, expectedDefaults);
    await runtime.request("settings:save", {
      ...staleSettingsDraft,
      workerPermissionDefaults: expectedDefaults,
      model: "explicit-test-model",
    });
    await runtime.request("settings:save", {
      ...staleSettingsDraft,
      model: "explicit-test-model",
    });
    assert.deepEqual(
      state.settings.workerPermissionDefaults,
      expectedDefaults,
      "A settings dialog opened before the defaults changed must not erase them",
    );
    assert.equal(state.settings.model, "explicit-test-model");
    assert.equal(task.permissionMode, "review");
    assert.equal(task.run.permissionMode, "review");
    assert.equal(task.run.sessionId, "unchanged");
    assert.equal(JSON.stringify(state.workerConnections), connections);
    for (const input of [
      { harness: "cursor", mode: "auto" },
      { harness: "copilot", mode: "auto" },
      { harness: "dsh", mode: "auto" },
      { harness: "codex", mode: "yolo" },
      { harness: "unknown", mode: "review" },
      { harness: "codex", mode: "full-access", grantPending: true },
    ])
      await assert.rejects(runtime.request("worker:permission-default", input));
    assert.deepEqual(state.settings.workerPermissionDefaults, expectedDefaults);
    await runtime.close();
    runtime = undefined;
    const saved = JSON.parse(
      await readFile(join(root, "workspace.json"), "utf8"),
    );
    assert.deepEqual(saved.settings.workerPermissionDefaults, expectedDefaults);
    runtime = await createRuntime(root, root, host, () => {});
    assert.deepEqual(
      runtime.store.state.settings.workerPermissionDefaults,
      expectedDefaults,
    );
    assert.equal(runtime.store.state.tasks[0].permissionMode, "review");
  } finally {
    await runtime?.close();
    assert.ok(
      within(tmpdir(), root) &&
        basename(root).startsWith("memcode-defaults-test-"),
    );
    await rm(root, { recursive: true, force: true });
  }
});
