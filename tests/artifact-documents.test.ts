import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initialState } from "../src/seed";
import { PreviewManager } from "../runtime/preview";
import type { NativeHost } from "../runtime/host";
import { inspectOfficeZip } from "../artifact-viewer/zip-limits";

test("document preview switches keep their asset capabilities valid and the latest native view wins", async () => {
  const data = await realpath(
      await mkdtemp(join(tmpdir(), "memcode-document-preview-")),
    ),
    state = initialState(),
    task = state.tasks[0];
  const root = join(data, "captures", task.id);
  await mkdir(root, { recursive: true });
  for (const [id, name] of [
    ["one", "report.md"],
    ["two", "notes.md"],
  ]) {
    const path = join(root, name);
    await writeFile(path, "# " + id + "\n");
    state.artifacts.push({
      id,
      name,
      path,
      kind: "text",
      taskId: task.id,
      projectId: task.projectId,
      source: "fixture",
      createdAt: new Date().toISOString(),
    });
  }
  const shown: string[] = [];
  const host = {
    call: async (method: string, input: any) => {
      if (method === "preview_show") {
        await new Promise((r) => setTimeout(r, 15));
        shown.push(input.url);
      }
      return undefined;
    },
  } as NativeHost;
  const previews = new PreviewManager(
    host,
    () => state,
    data,
    async () => {},
    () => {},
    resolve("."),
  );
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  try {
    await previews.show({ taskId: task.id, artifactId: "one", bounds });
    const first = shown.at(-1)!;
    const older = previews.show({
      taskId: task.id,
      artifactId: "one",
      bounds: { ...bounds, width: 810 },
    });
    const newer = previews.show({ taskId: task.id, artifactId: "two", bounds });
    await Promise.all([older, newer]);
    const second = shown.at(-1)!;
    assert.notEqual(first, second);
    assert.equal(
      (await fetch(new URL("__meta", second)).then((r) => r.json())).name,
      "notes.md",
    );
    assert.equal(
      (await fetch(new URL("__meta", first)).then((r) => r.json())).name,
      "report.md",
    );
    const source = await fetch(new URL("__document", first));
    assert.equal(await source.text(), "# one\n");
    assert.match(
      source.headers.get("content-security-policy")!,
      /connect-src 'self'/,
    );
    assert.equal((await fetch(new URL("/__document", second))).status, 400);
    assert.equal(
      (await fetch(new URL("__asset/notes.md", second))).status,
      400,
    );
  } finally {
    await previews.close();
  }
});
test("a file that belongs to no task is shown in the isolated viewer and cannot be commented on", async () => {
  const folder = await mkdtemp(join(tmpdir(), "memcode-file-preview-"));
  const path = join(folder, "Plan.pdf");
  await writeFile(path, "%PDF-1.7 hello");
  await writeFile(join(folder, "secret.txt"), "not asked for");
  const shown: string[] = [];
  const events: unknown[] = [];
  const previews = new PreviewManager(
    {
      call: async (method: string, input: any) => {
        if (method === "preview_show") shown.push(input.url);
        return undefined;
      },
    } as NativeHost,
    initialState,
    folder,
    async () => {},
    (...event) => void events.push(event),
    resolve("."),
  );
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const file = { path, name: "Plan.pdf", revision: "ab", bounds };
  try {
    await previews.showFile(file);
    await previews.showFile({ ...file, bounds: { ...bounds, width: 700 } });
    assert.equal(shown.length, 2);
    assert.equal(shown[0], shown[1], "moving it does not load it again");
    const meta = await fetch(new URL("__meta", shown[0])).then((r) => r.json());
    assert.deepEqual(
      [meta.format, meta.name, meta.readOnly],
      ["pdf", "Plan.pdf", true],
    );
    const document = await fetch(new URL("__document", shown[0]));
    assert.equal(await document.text(), "%PDF-1.7 hello");
    assert.equal((await fetch(new URL("__asset/secret.txt", shown[0]))).status, 400);
    const review = await fetch(new URL("__review", shown[0]), {
      method: "POST",
      headers: { origin: new URL(shown[0]).origin },
      body: JSON.stringify({ action: "link", href: "https://evil.test" }),
    });
    assert.equal(review.status, 400);
    assert.ok(
      events.every((event) => (event as string[])[0] !== "review:event"),
      "no comment or link reaches the app",
    );
    await assert.rejects(
      previews.showFile({ ...file, name: "page.html" }),
      /does not show this kind of file/,
    );
  } finally {
    await previews.close();
    await rm(folder, { recursive: true, force: true });
  }
});
test("Office previews reject oversized or encrypted archive metadata before inflating it", () => {
  const bytes = new ArrayBuffer(68),
    v = new DataView(bytes);
  v.setUint32(0, 0x02014b50, true);
  v.setUint32(46, 0x06054b50, true);
  v.setUint16(56, 1, true);
  v.setUint32(62, 0, true);
  v.setUint32(24, 200 * 1024 * 1024, true);
  assert.throws(() => inspectOfficeZip(bytes), /memory limit/);
  v.setUint32(24, 10, true);
  v.setUint16(8, 1, true);
  assert.throws(() => inspectOfficeZip(bytes), /encrypted/);
});
