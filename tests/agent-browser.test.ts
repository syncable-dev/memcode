import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../src/seed";
import { browserURL } from "../src/browser";
import { BrowserPool } from "../runtime/browser/pool";
import { AgentBrowserManager } from "../runtime/browser/manager";
import { pixelSize } from "./support/browser-image";

test("shared browser addresses permit HTTPS while keeping privileged URLs and remote plaintext out", () => {
  assert.equal(browserURL("google.com").href, "https://google.com/");
  assert.equal(browserURL("localhost:3000").href, "http://localhost:3000/");
  for (const value of [
    "http://example.com",
    "file:///C:/Windows/win.ini",
    "javascript:alert(1)",
    "https://user:secret@example.com",
    "https://tauri.localhost",
  ])
    assert.throws(() => browserURL(value));
});

test(
  "concurrent worker contexts reuse one browser and isolate their storage",
  { timeout: 60000 },
  async () => {
    const pool = new BrowserPool();
    try {
      const [first, second] = await Promise.all([
        pool.context({ width: 800, height: 600 }),
        pool.context({ width: 800, height: 600 }),
      ]);
      assert.equal(first.browser(), second.browser());
      assert.notEqual(first, second);
      assert.equal(first.browser()?.contexts().length, 2);
    } finally {
      await pool.close();
    }
  },
);

test(
  "worker and card share real tabs, controls, frames and captures while another card stays isolated",
  { timeout: 60000 },
  async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<html><head><title>Worker browser fixture</title></head><body>
      <label>Name <input aria-label="Name" id="name"></label><button id="remember">Remember</button>
      <select aria-label="Launch window"><option value="early">Early</option><option value="late">Late</option></select><output id="result"></output><script>result.textContent=localStorage.getItem('name')||'Nothing stored';
      remember.onclick=()=>{localStorage.setItem('name',document.querySelector('#name').value);result.textContent=localStorage.getItem('name')};</script></body></html>`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const state = initialState(),
      root = await mkdtemp(join(tmpdir(), "memcode-browser-test-"));
    const manager = new AgentBrowserManager(
      () => state,
      root,
      async () => {},
      2,
    );
    const [first, second, third] = state.tasks;
    manager.attach(first.id, "codex", root);
    try {
      const opened = await manager.execute(
        first.id,
        { action: "open", url },
        "worker",
      );
      assert.equal(opened.state.tabs[0].title, "Worker browser fixture");
      let observed = await manager.execute(
        first.id,
        { action: "observe", screenshot: true },
        "worker",
      );
      assert.match(observed.snapshot!.text, /m1: input Name/);
      assert.equal(
        Buffer.from(observed.image!.data, "base64")
          .subarray(0, 8)
          .toString("hex"),
        "89504e470d0a1a0a",
      );
      const oldRevision = observed.snapshot!.revision;
      await manager.execute(
        first.id,
        {
          action: "act",
          input: {
            action: "type",
            ref: "m1",
            text: "Alice",
            revision: oldRevision,
          },
        },
        "worker",
      );
      await assert.rejects(
        manager.execute(
          first.id,
          {
            action: "act",
            input: { action: "click", ref: "m2", revision: oldRevision },
          },
          "worker",
        ),
        /page changed/,
      );
      observed = await manager.execute(
        first.id,
        { action: "observe" },
        "worker",
      );
      await manager.execute(
        first.id,
        {
          action: "act",
          input: {
            action: "click",
            ref: "m2",
            revision: observed.snapshot!.revision,
          },
        },
        "worker",
      );
      observed = await manager.execute(first.id, { action: "observe" }, "user");
      assert.match(observed.snapshot!.text, /Alice/);
      await assert.rejects(
        manager.execute(
          first.id,
          { action: "act", input: { action: "select", ref: "m3" } },
          "worker",
        ),
        /Use choose/,
      );
      await manager.execute(
        first.id,
        {
          action: "act",
          input: {
            action: "choose",
            ref: "m3",
            value: "late",
            revision: observed.snapshot!.revision,
          },
        },
        "worker",
      );
      observed = await manager.execute(
        first.id,
        { action: "observe" },
        "worker",
      );
      assert.match(observed.snapshot!.text, /Late.*\[selected\]/);
      const frame = await manager.execute(first.id, { action: "frame" });
      assert.equal(frame.image?.mimeType, "image/jpeg");
      await manager.execute(first.id, {
        action: "resize",
        width: 800,
        height: 600,
        deviceScaleFactor: 2,
      });
      const retina = await manager.execute(first.id, { action: "frame" });
      assert.deepEqual(pixelSize(retina.image!), { width: 1600, height: 1200 });
      const logical = await manager.execute(first.id, {
        action: "observe",
        screenshot: true,
      });
      assert.equal(
        Buffer.from(logical.image!.data, "base64").readUInt32BE(16),
        800,
      );
      const another = await manager.execute(
        first.id,
        { action: "open", url },
        "worker",
      );
      const otherTabId = another.state.tabs.find((tab) => tab.active)!.id;
      const firstTab = await manager.execute(
        first.id,
        { action: "observe", tabId: opened.state.tabs[0].id },
        "worker",
      );
      assert.equal(
        firstTab.state.tabs.find((tab) => tab.active)!.id,
        opened.state.tabs[0].id,
      );
      await assert.rejects(
        manager.execute(
          first.id,
          {
            action: "act",
            input: {
              action: "click",
              tabId: otherTabId,
              ref: "m2",
              revision: firstTab.snapshot!.revision,
            },
          },
          "worker",
        ),
        /page changed/,
      );
      const blank = await manager.execute(first.id, { action: "new-tab" });
      assert.equal(
        blank.state.tabs.find((tab) => tab.active)!.url,
        "about:blank",
      );
      assert.equal(
        (await manager.execute(first.id, { action: "frame" })).image,
        undefined,
      );
      await manager.execute(first.id, {
        action: "act",
        input: {
          action: "close",
          tabId: blank.state.tabs.find((tab) => tab.active)!.id,
        },
      });
      await manager.execute(second.id, { action: "open", url });
      const isolated = await manager.execute(second.id, { action: "observe" });
      assert.match(isolated.snapshot!.text, /Nothing stored/);
      await assert.rejects(
        manager.execute(second.id, {
          action: "act",
          input: { action: "select", tabId: opened.state.tabs[0].id },
        }),
        /this work item/,
      );
      await assert.rejects(
        manager.execute(third.id, { action: "open", url }),
        /all in use/,
      );
      await manager.execute(first.id, { action: "control", value: "user" });
      const hovered = await manager.execute(first.id, {
        action: "act",
        input: { action: "hover", x: 100, y: 16 },
      });
      assert.equal(hovered.state.cursor, "text");
      await assert.rejects(
        manager.execute(
          first.id,
          { action: "act", input: { action: "reload" } },
          "worker",
        ),
        /user has browser control/,
      );
      const captured = await manager.execute(first.id, { action: "capture" });
      const artifact = state.artifacts.find(
        (artifact) => artifact.id === captured.artifactId,
      )!;
      assert.equal(artifact.taskId, first.id);
      assert.equal(
        (await readFile(artifact.path)).subarray(0, 8).toString("hex"),
        "89504e470d0a1a0a",
      );
      manager.detach(first.id);
      assert.equal(
        (await manager.execute(first.id, { action: "state" })).state
          .workerConnected,
        false,
      );
    } finally {
      await manager.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
