import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime/app";
import { maxWorkerSlots, workerSlotChoices } from "../src/worker-slots";

async function settingsRuntime() {
  const root = await mkdtemp(join(tmpdir(), "memcode-worker-slots-"));
  const runtime = await createRuntime(
    join(root, "profile"),
    root,
    {
      async call<T>(method: string) {
        if (method === "beta_store_read")
          return { configured: false, credentials: null } as T;
        return undefined as T;
      },
    },
    () => {},
  );
  runtime.store.state.settings.memtracePath = process.execPath;
  return {
    settings: () => runtime.store.state.settings,
    save: (maxWorkers: number) =>
      runtime.request("settings:save", {
        ...runtime.store.state.settings,
        maxWorkers,
      }),
    async close() {
      await runtime.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

test("a fleet of fifty workers at once can be allowed in Settings, and no more than that", async () => {
  const runtime = await settingsRuntime();
  try {
    await runtime.save(50);
    assert.equal(runtime.settings().maxWorkers, 50);
    await assert.rejects(runtime.save(51));
    assert.equal(runtime.settings().maxWorkers, 50);
    assert.equal(maxWorkerSlots, 50);
  } finally {
    await runtime.close();
  }
});

test("every worker-slot choice Settings offers can be saved, up to the limit", async () => {
  const runtime = await settingsRuntime();
  try {
    for (const choice of workerSlotChoices) {
      await runtime.save(choice);
      assert.equal(runtime.settings().maxWorkers, choice);
    }
    assert.equal(workerSlotChoices.at(-1), maxWorkerSlots);
    assert.deepEqual(
      workerSlotChoices,
      [...workerSlotChoices].sort((a, b) => a - b),
    );
  } finally {
    await runtime.close();
  }
});
