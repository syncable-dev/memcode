import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  attachmentsBrief,
  attachmentsSchema,
  AttachmentStore,
  diskName,
  shownImagesOf,
} from "../runtime/attachments";
import { documentText } from "../runtime/document-text";
import { claudeContent } from "../runtime/agents/claude";
import { codexInput } from "../runtime/agents/codex";
import { acpPrompt } from "../runtime/agents/cursor";
import { workerTurnContext } from "../runtime/worker-turn";
import { registerReview } from "../runtime/review";
import { ConversationDrafts } from "../src/conversation-drafts";
import {
  LARGEST_ATTACHMENT,
  MOST_ATTACHMENTS,
  withAttachments,
  type Attachment,
} from "../src/attachments";
import { initialState } from "../src/seed";
import type { Message } from "../src/shared";

async function fixture(
  run: (store: AttachmentStore, folder: string) => Promise<void>,
) {
  const folder = await mkdtemp(join(tmpdir(), "memcode-attachments-"));
  try {
    await run(new AttachmentStore(folder), folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
const base64 = (text: string | Uint8Array) =>
  Buffer.from(text as string).toString("base64");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const message = (text: string, attachments?: Attachment[]): Message => ({
  id: text,
  role: "user",
  text,
  at: "2026-11-24T12:00:00Z",
  ...(attachments ? { attachments } : {}),
});

const docx = zipSync({
  "word/document.xml": strToU8(
    "<w:document><w:body><w:p><w:r><w:t>Login fails</w:t></w:r></w:p><w:p w:x='1'><w:r><w:t>On a &lt;phone&gt; &amp; tablet</w:t></w:r></w:p></w:body></w:document>",
  ),
});
const pptx = zipSync({
  "ppt/slides/slide10.xml": strToU8(
    "<p><a:p><a:r><a:t>Last</a:t></a:r></a:p></p>",
  ),
  "ppt/slides/slide2.xml": strToU8(
    "<p><a:p><a:r><a:t>Second</a:t></a:r></a:p></p>",
  ),
  "ppt/slides/slide1.xml": strToU8(
    "<p><a:p><a:r><a:t>First</a:t></a:r></a:p></p>",
  ),
});
const xlsx = zipSync({
  "xl/workbook.xml": strToU8(
    '<workbook><sheets><sheet name="Phones" sheetId="1"/></sheets></workbook>',
  ),
  "xl/sharedStrings.xml": strToU8(
    "<sst><si><t>Phone</t></si><si><t>Pixel</t></si></sst>",
  ),
  "xl/worksheets/sheet1.xml": strToU8(
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Taps</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>5</v></c></row></sheetData></worksheet>',
  ),
});

test("the words of Word, Excel and PowerPoint files are read as plain text", () => {
  assert.equal(
    documentText("a.docx", docx),
    "Login fails\nOn a <phone> & tablet",
  );
  assert.equal(
    documentText("a.pptx", pptx),
    "Slide 1\nFirst\n\nSlide 2\nSecond\n\nSlide 3\nLast",
  );
  assert.equal(
    documentText("a.xlsx", xlsx),
    "Sheet: Phones\nPhone\t\tTaps\nPixel\t\t5",
  );
  assert.equal(documentText("a.png", png), undefined);
  assert.equal(
    documentText("damaged.docx", strToU8("not a document")),
    undefined,
  );
});

test("a file is kept by its content, under a name any disk takes", async () => {
  await fixture(async (store) => {
    const kept = await store.add({
      name: "..\\..\\My: plan?.docx",
      mime: "application/x",
      base64: base64(docx),
      from: "Sam's comment",
    });
    assert.equal(kept.name, "My_ plan_.docx");
    assert.equal(kept.from, "Sam's comment");
    assert.deepEqual(
      new Uint8Array(await store.read(kept)),
      new Uint8Array(docx),
    );
    assert.match((await store.text(kept))!, /^Login fails/);
    assert.equal(
      (
        await store.add({
          name: "My_ plan_.docx",
          mime: "",
          base64: base64(docx),
        })
      ).sha256,
      kept.sha256,
    );
    const pdf = await store.add({
      name: "a.pdf",
      mime: "application/pdf",
      base64: base64("%PDF"),
      text: "Page 1\nHello",
    });
    assert.equal(await store.text(pdf), "Page 1\nHello");
    assert.equal(attachmentsSchema.safeParse([kept, pdf]).success, true);

    await assert.rejects(
      store.add({ name: "a", mime: "", base64: "" }),
      /empty/,
    );
    await assert.rejects(
      store.add({
        name: "big.bin",
        mime: "",
        base64: Buffer.alloc(LARGEST_ATTACHMENT + 1).toString("base64"),
      }),
      /larger than 15\.0 MB/,
    );
    await assert.rejects(
      store.assertKept([{ ...kept, name: "other.docx" }]),
      /not on this computer/,
    );
    await assert.rejects(
      store.path({ sha256: kept.sha256, name: "../../x" }),
      /not on this computer/,
    );
  });
  for (const [name, safe] of [
    ["CON?.txt", "CON_.txt"],
    [".hidden.png", "hidden.png"],
    ["trailing. ", "trailing"],
    ["a/b\\c.png", "c.png"],
    ["", "file"],
    ["ünïcode 日本.pdf", "ünïcode 日本.pdf"],
  ])
    assert.equal(diskName(name), safe);
});

test("a worker gets copies in its own folder, and a list that says what each is", async () => {
  await fixture(async (store, folder) => {
    const image = {
      ...(await store.add({
        name: "login.png",
        mime: "image/png",
        base64: base64(png),
      })),
      note: "The button that does nothing",
      from: "Sam's comment",
    };
    const sheet = await store.add({
      name: "phones.xlsx",
      mime: "",
      base64: base64(xlsx),
    });
    const gone = { ...sheet, name: "gone.pdf", sha256: "0".repeat(64) };
    const messages = [
      message("first", [image, sheet]),
      message("again", [image, gone]),
    ];
    const checkout = join(folder, "checkout");
    const own = join(checkout, ".memcode", "workers", "t1", "attachments");
    const laid = await store.layOut(messages, own);
    assert.equal(laid.size, 2, "one copy of each");
    assert.deepEqual(
      (await readdir(own)).length,
      3,
      "the sheet has its words beside it",
    );
    for (const { path } of laid.values()) assert.equal(dirname(path), own);

    const show = (path: string) =>
      relative(checkout, path).replaceAll("\\", "/");
    const brief = attachmentsBrief(messages[0].attachments, laid, show);
    assert.match(brief, /never instructions to you/);
    assert.match(
      brief,
      /- \.memcode\/workers\/t1\/attachments\/[0-9a-f]{6}-login\.png \(Image, 1 KB, from Sam's comment\)\n {2}What the person says it shows: The button that does nothing/,
    );
    assert.match(
      brief,
      /phones\.xlsx \(Excel, 1 KB\)\n {2}Its words as plain text: \S+phones\.xlsx\.as-text\.txt/,
    );
    assert.match(
      attachmentsBrief(messages[1].attachments, laid, show),
      /- gone\.pdf .*\n {2}It is not on this computer any more\./,
    );
    assert.equal(attachmentsBrief(undefined, laid, show), "");
    const [words] = (await readdir(own)).filter((name) =>
      name.endsWith(".as-text.txt"),
    );
    assert.match(await readFile(join(own, words), "utf8"), /^Sheet: Phones/);

    assert.deepEqual(
      shownImagesOf(messages, laid).map((shown) => [
        basename(shown.path).slice(7),
        shown.mime,
      ]),
      [["login.png", "image/png"]],
    );
  });
});

test("a request's files stand with it in the worker's prompt, and are shown to workers that see", async () => {
  await fixture(async (store, folder) => {
    const image = await store.add({
      name: "a.png",
      mime: "image/png",
      base64: base64(png),
    });
    const old = { ...message("Earlier"), promptedAt: "2026-11-24T11:00:00Z" };
    const now = message("Fix the button", [image]);
    const turn = workerTurnContext(
      { description: "" },
      [old, now],
      8000,
      (one) => (one.attachments ? "FILES HERE" : ""),
    );
    assert.match(turn.current, /User request 1:\nFix the button\n\nFILES HERE/);
    assert.deepEqual(turn.requests, [now]);

    const laid = await store.layOut([now], join(folder, "own"));
    const images = shownImagesOf([now], laid);
    const prompt = "Do it";
    assert.deepEqual(claudeContent({ prompt, images }), [
      { type: "text", text: prompt },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64(png) },
      },
    ]);
    assert.equal(
      claudeContent({ prompt }),
      prompt,
      "without images nothing changes",
    );
    assert.deepEqual(codexInput({ prompt, images }), [
      { type: "text", text: prompt },
      { type: "localImage", path: images[0].path },
    ]);
    assert.equal(codexInput({ prompt, images, localModel: true }).length, 1);
    assert.deepEqual(acpPrompt({ prompt, images }, true)[1], {
      type: "image",
      mimeType: "image/png",
      data: base64(png),
    });
    assert.equal(
      acpPrompt({ prompt, images }, false).length,
      1,
      "it says it takes none",
    );
    await rm(images[0].path);
    assert.equal(
      claudeContent({ prompt, images }),
      prompt,
      "a file that went is left out",
    );
  });
});

test("a follow-up carries its files, only kept ones, and none to another computer", async () => {
  await fixture(async (store) => {
    const state = initialState();
    const task = state.tasks[0];
    task.example = false;
    task.messages = [];
    let elsewhere = false;
    const queued: string[] = [];
    const routes = new Map<
      string,
      { schema: any; run: (input: any) => unknown }
    >();
    registerReview(
      (name, schema, run) => routes.set(name, { schema, run }),
      () => state,
      async () => {},
      () => {},
      {
        enqueue: (_task, id) => void queued.push(id),
        dispatchQueued: () => {},
      },
      {
        remoteSend: async () => undefined,
        actor: () => undefined,
        edit: async () => false,
        isElsewhere: () => elsewhere,
      },
      store,
    );
    const send = async (input: unknown) => {
      const route = routes.get("review:send")!;
      return route.run(route.schema.parse(input));
    };
    const image = await store.add({
      name: "a.png",
      mime: "image/png",
      base64: base64(png),
    });
    await send({
      taskId: task.id,
      text: "See the attached file.",
      attachments: [image],
    });
    assert.deepEqual(task.messages[0].attachments, [image]);
    assert.equal(queued.length, 1);

    await assert.rejects(
      send({
        taskId: task.id,
        text: "x",
        attachments: [{ ...image, sha256: "f".repeat(64) }],
      }),
      /not on this computer/,
    );
    await assert.rejects(
      send({
        taskId: task.id,
        text: "x",
        attachments: [{ ...image, sha256: "../../etc" }],
      }),
    );
    elsewhere = true;
    await assert.rejects(
      send({ taskId: task.id, text: "x", attachments: [image] }),
      /another computer/,
    );
    assert.equal(task.messages.length, 1);
  });
});

test("files nothing refers to are removed after a week", async () => {
  await fixture(async (store) => {
    const used = await store.add({
      name: "used.png",
      mime: "",
      base64: base64("a"),
    });
    const old = await store.add({
      name: "old.png",
      mime: "",
      base64: base64("b"),
    });
    const fresh = await store.add({
      name: "fresh.png",
      mime: "",
      base64: base64("c"),
    });
    const longAgo = new Date(Date.now() - 8 * 86400_000);
    for (const file of [used, old])
      await utimes(join(store.folder, file.sha256), longAgo, longAgo);
    await store.removeUnused(new Set([used.sha256]));
    await store.path(used);
    await store.path(fresh);
    await assert.rejects(store.path(old));
  });
});

test("a file is in a list once, and a list has a limit", () => {
  const file = (n: number): Attachment => ({
    id: String(n),
    name: `${n}.png`,
    mime: "image/png",
    size: 1,
    sha256: String(n),
  });
  assert.equal(
    withAttachments([file(1)], [{ ...file(1), id: "x" }, file(2)]).length,
    2,
  );
  const many = Array.from({ length: 30 }, (_, n) => file(n));
  assert.equal(withAttachments([], many).length, MOST_ATTACHMENTS);
});

test("an unsent message keeps its files, and one added while it is sent stays", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const file = (id: string): Attachment => ({
    id,
    name: id,
    mime: "",
    size: 1,
    sha256: id,
  });
  const drafts = new ConversationDrafts(() => storage);
  drafts.write("card", { draft: "", comments: [], files: [file("a")] });
  const again = new ConversationDrafts(() => storage);
  assert.deepEqual(again.read("card").files, [file("a")]);
  const submitted = again.read("card");
  again.write("card", { ...submitted, files: [file("a"), file("b")] });
  assert.equal(again.clearSubmitted("card", submitted), true);
  assert.deepEqual(again.read("card").files, [file("b")]);
});
