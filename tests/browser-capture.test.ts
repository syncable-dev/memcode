import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCapture } from "../runtime/browser/capture.ts";
import { AgentBrowserManager } from "../runtime/browser/manager.ts";
import { initialState } from "../src/seed.ts";
import type { BrowserImage } from "../src/browser.ts";
import type { Page } from "playwright-core";

test("a missing native capture callback falls back without waiting indefinitely", async () => {
  const start = Date.now();
  let fallbacks = 0;
  const image = await browserCapture(
    () => new Promise(() => {}),
    async () => {
      fallbacks++;
      return "actual-compositor-result";
    },
    { native: 5, compositor: 5 },
  );
  assert.equal(image, "actual-compositor-result");
  assert.equal(fallbacks, 1);
  assert.ok(Date.now() - start < 500);
});

test("both stalled capture methods produce a bounded honest failure", async () => {
  const start = Date.now();
  await assert.rejects(
    browserCapture(
      () => new Promise(() => {}),
      () => new Promise(() => {}),
      { native: 5, compositor: 5 },
    ),
    /No screenshot was produced/,
  );
  assert.ok(Date.now() - start < 500);
});

test("a successful native image does not invoke another capture path", async () => {
  let fallback = false;
  assert.equal(
    await browserCapture(
      async () => "native-result",
      async () => {
        fallback = true;
        return "fallback";
      },
    ),
    "native-result",
  );
  assert.equal(fallback, false);
});

test(
  "screenshot failure preserves a real DOM observation, releases actions, and recovers",
  { timeout: 30000 },
  async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<title>Capture recovery</title><button onclick=\"this.textContent='Updated'\">Continue</button>",
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const state = initialState(),
      task = state.tasks[0];
    const manager = new AgentBrowserManager(
      () => state,
      await mkdtemp(join(tmpdir(), "memcode-capture-test-")),
      async () => {},
    );
    const rendering = (manager as any).rendering,
      original = rendering.capture.bind(rendering);
    try {
      await manager.execute(task.id, {
        action: "open",
        url: `http://127.0.0.1:${address.port}`,
      });
      rendering.capture = async () => {
        throw Error("Native fixture callback never supplied an image");
      };
      const observed = await manager.execute(task.id, {
        action: "observe",
        screenshot: true,
      });
      assert.match(observed.snapshot!.text, /Continue/);
      assert.equal(observed.image, undefined);
      assert.match(observed.state.error ?? "", /^Screenshot unavailable:/);
      await manager.execute(task.id, {
        action: "act",
        input: { action: "click", ref: "m1" },
      });
      const updated = await manager.execute(task.id, { action: "observe" });
      assert.match(updated.snapshot!.text, /Updated/);
      rendering.capture = original;
      const recovered = await manager.execute(task.id, {
        action: "observe",
        screenshot: true,
      });
      assert.ok(recovered.image?.data);
      assert.equal(recovered.state.error, undefined);
    } finally {
      await manager.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);

const bandHeight = 1000;
const bands = ["red", "green", "blue"] as const;
const stripedPage = `<body style="margin:0">${bands
  .map(
    (color) =>
      `<div style="height:${bandHeight}px;background:${color === "green" ? "lime" : color}"></div>`,
  )
  .join("")}</body>`;

function selectedPage(manager: AgentBrowserManager, taskId: string): Page {
  const session = (manager as any).sessions.get(taskId);
  return session.pages.get(session.selected);
}

/** Decodes a frame in the browser and names the colour at its top and bottom edge. */
function frameEdgeColors(page: Page, image: BrowserImage) {
  return page.evaluate(async ({ mimeType, data }) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: mimeType }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    // Inline callback: tsx renames named functions with a helper the page lacks.
    return [4, bitmap.height - 4].map((y) => {
      const [red, green, blue] = context.getImageData(10, y, 1, 1).data;
      if (red > 200 && green < 60 && blue < 60) return "red";
      if (green > 200 && red < 60 && blue < 60) return "green";
      if (blue > 200 && red < 60 && green < 60) return "blue";
      return "none";
    });
  }, image);
}

test(
  "a frame after the user scrolls shows the part of the page now on screen",
  { timeout: 30000 },
  async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(stripedPage);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const state = initialState(),
      task = state.tasks[0];
    const manager = new AgentBrowserManager(
      () => state,
      await mkdtemp(join(tmpdir(), "memcode-scroll-frame-test-")),
      async () => {},
    );
    try {
      await manager.execute(task.id, {
        action: "open",
        url: `http://127.0.0.1:${address.port}`,
      });
      await manager.execute(task.id, {
        action: "act",
        input: { action: "scroll", x: 100, y: 100, deltaY: 1200 },
      });
      const page = selectedPage(manager, task.id);
      await page.waitForFunction(() => scrollY === 1200);
      const frame = await manager.execute(task.id, { action: "frame" });
      assert.deepEqual(await frameEdgeColors(page, frame.image!), [
        "green",
        "green",
      ]);
    } finally {
      await manager.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
