import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../src/seed";
import { AgentBrowserManager } from "../runtime/browser/manager";
import { WebKitEngine } from "../runtime/browser/webkit-engine";
import { ChromiumNativeHost } from "./support/chromium-native-host";

async function serve(html: string) {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function workerCard(html: string) {
  const site = await serve(html);
  const host = new ChromiumNativeHost();
  const state = initialState(),
    task = state.tasks[0],
    root = await mkdtemp(join(tmpdir(), "memcode-webkit-worker-"));
  const manager = new AgentBrowserManager(
    () => state,
    root,
    async () => {},
    16,
    host,
    new WebKitEngine(host),
  );
  manager.attach(task.id, "codex", root);
  const act = async (input: Record<string, unknown>) => {
    const { snapshot } = await manager.execute(task.id, { action: "observe" }, "worker");
    return manager.execute(
      task.id,
      { action: "act", input: { ...input, revision: snapshot!.revision } as any },
      "worker",
    );
  };
  const observe = async () =>
    (await manager.execute(task.id, { action: "observe" }, "worker")).snapshot!.text;
  const done = async () => {
    await manager.close();
    await host.close();
    await site.close();
  };
  await manager.execute(task.id, { action: "open", url: site.url }, "worker");
  return { manager, host, state, task, act, observe, done };
}

const form = `<html><head><title>Worker browser fixture</title></head><body>
<label>Name <input aria-label="Name" id="name"></label><button id="remember">Remember</button>
<select aria-label="Launch window"><option value="early">Early</option><option value="late">Late</option></select>
<output id="result"></output><input type="file" aria-label="Upload">
<script>result.textContent=localStorage.getItem('name')||'Nothing stored';
remember.onclick=()=>{localStorage.setItem('name',document.querySelector('#name').value);result.textContent=localStorage.getItem('name')};</script>
</body></html>`;

test(
  "a worker types, clicks and chooses in the Mac's native page like anywhere else",
  { timeout: 60000 },
  async () => {
    const card = await workerCard(form);
    try {
      const first = await card.observe();
      assert.match(first, /m1: input Name/);
      assert.match(first, /textbox "Name"/);
      assert.match(first, /Nothing stored/);
      await card.act({ action: "type", ref: "m1", text: "Alice" });
      await card.act({ action: "click", ref: "m2" });
      assert.match(await card.observe(), /Alice/);
      await card.act({ action: "choose", ref: "m3", value: "late" });
      assert.match(await card.observe(), /Late.*\[selected\]/);
      await card.act({ action: "type", ref: "m1", text: "Bob" });
      await card.act({ action: "press", key: "Backspace" });
      await card.act({ action: "click", ref: "m2" });
      assert.match(await card.observe(), /textbox "Name": Bo\b/);
      const captured = await card.manager.execute(
        card.task.id,
        { action: "act", input: { action: "capture" } },
        "worker",
      );
      const artifact = card.state.artifacts.find((item) => item.id === captured.artifactId)!;
      assert.equal(
        (await readFile(artifact.path)).subarray(0, 8).toString("hex"),
        "89504e470d0a1a0a",
      );
    } finally {
      await card.done();
    }
  },
);

test(
  "on the Mac a worker never clicks open a native menu or file picker",
  { timeout: 60000 },
  async () => {
    const card = await workerCard(form);
    try {
      await assert.rejects(card.act({ action: "click", ref: "m3" }), /choose/);
      await assert.rejects(card.act({ action: "click", ref: "m4" }), /file/i);
      assert.equal(card.host.inputs.length, 0);
    } finally {
      await card.done();
    }
  },
);

test(
  "a worker scrolls and hovers the native page and sees the cursor there",
  { timeout: 60000 },
  async () => {
    const card = await workerCard(
      `<title>Long</title><input aria-label="Search" style="position:absolute;top:20px;left:20px;width:200px">
      <div style="height:4000px"></div><p id="where"></p>
      <script>addEventListener('scroll',()=>where.textContent='At '+scrollY)</script>`,
    );
    try {
      await card.act({ action: "scroll", x: 400, y: 300, deltaY: 600 });
      assert.match(await card.observe(), /At 600/);
      await card.act({ action: "scroll", x: 400, y: 300, deltaY: -600 });
      const hovered = await card.act({ action: "hover", x: 60, y: 30 });
      assert.equal(hovered.state.cursor, "text");
      assert.deepEqual(
        { x: hovered.state.pointer?.x, y: hovered.state.pointer?.y },
        { x: 60, y: 30 },
      );
    } finally {
      await card.done();
    }
  },
);

test(
  "the Mac observation includes the page's accessibility tree",
  { timeout: 60000 },
  async () => {
    const card = await workerCard(
      `<title>Tree</title><main><h1>Welcome</h1><nav><a href="/docs">Docs</a></nav>
      <label><input type="checkbox" checked> Subscribe</label>
      <ul><li>First point</li><li>Second point</li></ul>
      <p hidden>Secret</p><div style="display:none">Gone</div><p aria-hidden="true">Ignored</p>
      <img alt="Logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main>`,
    );
    try {
      const text = await card.observe();
      const tree = text.slice(text.indexOf("Accessibility:"));
      assert.match(tree, /- heading "Welcome" \[level=1\]/);
      assert.match(tree, /- link "Docs"/);
      assert.match(tree, /- checkbox "Subscribe" \[checked\]/);
      assert.match(tree, /- listitem: First point/);
      assert.match(tree, /- img "Logo"/);
      assert.doesNotMatch(tree, /Secret|Gone|Ignored/);
    } finally {
      await card.done();
    }
  },
);
