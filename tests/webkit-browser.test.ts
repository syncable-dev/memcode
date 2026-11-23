import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../src/seed";
import { AgentBrowserManager } from "../runtime/browser/manager";
import { browserEngineFor } from "../runtime/browser/engine-choice";
import { WebKitEngine } from "../runtime/browser/webkit-engine";
import { FakeWebKitHost } from "./support/fake-webkit-host";

const first = "https://example.com/";
const second = "https://example.org/next";

async function webkitCard() {
  const host = new FakeWebKitHost();
  const state = initialState();
  const manager = new AgentBrowserManager(
    () => state,
    await mkdtemp(join(tmpdir(), "memcode-webkit-")),
    async () => {},
    16,
    host,
    new WebKitEngine(host),
  );
  return { host, state, manager, task: state.tasks[0] };
}

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean) {
  let value = await read();
  for (let attempt = 0; attempt < 60 && !ok(value); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

test("macOS 14 and later draw card browsers natively; older Macs keep the frames", () => {
  const host = new FakeWebKitHost();
  assert.ok(browserEngineFor(host, "darwin", "23.0.0") instanceof WebKitEngine);
  assert.ok(browserEngineFor(host, "darwin", "27.2.0") instanceof WebKitEngine);
  assert.equal(browserEngineFor(host, "darwin", "22.6.0").native, false);
  assert.equal(browserEngineFor(undefined, "darwin", "27.2.0").native, false);
  assert.equal(browserEngineFor(host, "win32", "10.0.26100").native, true);
  assert.ok(!(browserEngineFor(host, "win32", "10.0.26100") instanceof WebKitEngine));
});

test("each card's native tab gets its own lasting WebKit storage", async () => {
  const { host, state, manager, task } = await webkitCard();
  host.titles.set(first, "Example Domain");
  try {
    const opened = await manager.execute(task.id, { action: "open", url: first });
    assert.equal(opened.state.nativeSurface, true);
    assert.equal(opened.state.tabs[0].url, first);
    assert.equal(opened.state.tabs[0].title, "Example Domain");
    await manager.execute(state.tasks[1].id, { action: "open", url: first });
    const profiles = [...host.surfaces.values()].map((surface) => surface.profile);
    assert.match(profiles[0]!, /^worker-[0-9a-f]{64}$/);
    assert.notEqual(profiles[0], profiles[1]);
    await manager.execute(task.id, { action: "new-tab" });
    assert.equal(
      [...host.surfaces.values()].filter((surface) => surface.owner === task.id)[1].profile,
      profiles[0],
    );
  } finally {
    await manager.close();
  }
});

test("the address bar, back, forward and reload drive the native page", async () => {
  const { host, manager, task } = await webkitCard();
  try {
    const opened = await manager.execute(task.id, { action: "open", url: first });
    const tabId = opened.state.tabs[0].id;
    await manager.execute(task.id, { action: "open", url: second, tabId });
    const back = await manager.execute(task.id, { action: "act", input: { action: "back" } });
    assert.equal(back.state.tabs[0].url, first);
    const forward = await manager.execute(task.id, {
      action: "act",
      input: { action: "forward" },
    });
    assert.equal(forward.state.tabs[0].url, second);
    const surface = [...host.surfaces.values()][0];
    const loads = surface.loads;
    await manager.execute(task.id, { action: "act", input: { action: "reload" } });
    assert.equal(surface.loads, loads + 1);
  } finally {
    await manager.close();
  }
});

test("where the human goes inside the native page shows up in the card", async () => {
  const { host, manager, task } = await webkitCard();
  try {
    await manager.execute(task.id, { action: "open", url: first });
    host.follow([...host.surfaces.keys()][0], second);
    const followed = await eventually(
      () => manager.execute(task.id, { action: "state" }),
      (reply) => reply.state.tabs[0].url === second,
    );
    assert.equal(followed.state.tabs[0].url, second);
    assert.ok(followed.state.activity.some((event) => event.text === "Navigated to " + second));
  } finally {
    await manager.close();
  }
});

test("a window the page opens becomes another tab of the same card", async () => {
  const { host, manager, task } = await webkitCard();
  try {
    await manager.execute(task.id, { action: "open", url: first });
    host.popup([...host.surfaces.keys()][0], second);
    const opened = await eventually(
      () => manager.execute(task.id, { action: "state" }),
      (reply) => reply.state.tabs.length === 2,
    );
    assert.equal(opened.state.tabs.length, 2);
    assert.equal(opened.state.tabs.find((tab) => tab.active)?.url, second);
  } finally {
    await manager.close();
  }
});

test("the native surface sits over the card and hides with it", async () => {
  const { host, manager, task } = await webkitCard();
  try {
    const opened = await manager.execute(task.id, { action: "open", url: first });
    const bounds = { x: 320, y: 140, width: 900, height: 640 };
    const placed = await manager.execute(task.id, {
      action: "surface",
      tabId: opened.state.tabs[0].id,
      visible: true,
      bounds,
    });
    const surface = [...host.surfaces.values()][0];
    assert.equal(surface.visible, true);
    assert.deepEqual(surface.bounds, bounds);
    assert.deepEqual(placed.state.viewport, { width: 900, height: 640 });
    await manager.execute(task.id, { action: "surface", visible: false });
    assert.equal(surface.visible, false);
    assert.equal(host.calls.at(-1)?.method, "browser_hide_all");
  } finally {
    await manager.close();
  }
});

test("closing a tab or the app releases the native surfaces", async () => {
  const { host, manager, task } = await webkitCard();
  try {
    await manager.execute(task.id, { action: "open", url: first });
    const blank = await manager.execute(task.id, { action: "new-tab" });
    assert.equal(host.surfaces.size, 2);
    await manager.execute(task.id, {
      action: "act",
      input: { action: "close", tabId: blank.state.tabs.find((tab) => tab.active)!.id },
    });
    assert.equal(host.surfaces.size, 1);
    const left = await manager.execute(task.id, { action: "state" });
    assert.equal(left.state.tabs.length, 1);
  } finally {
    await manager.close();
  }
  assert.equal(host.surfaces.size, 0);
});
