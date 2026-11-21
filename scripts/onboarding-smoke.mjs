// Native QA with a separate profile. Never attaches to the user's main inspector.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { initialState } from "../src/seed.ts";
import { nativeBinary, nativeEnv } from "./tauri-env.mjs";

const profile = await mkdtemp(join(tmpdir(), "memcode-onboarding-")),
  root = join(profile, "MemCode Studio"),
  out = resolve("../tmp/memcode-onboarding");
await mkdir(root, { recursive: true });
await mkdir(out, { recursive: true });
await writeFile(
  join(root, "README.md"),
  "# MemCode Studio\n\nDraft opening for the first project.\n",
);
await writeFile(
  join(root, "index.ts"),
  "export const projectName = 'MemCode Studio';\n",
);
execFileSync("git", ["init", "--initial-branch=main", root]);
execFileSync("git", ["-C", root, "add", "README.md", "index.ts"]);
execFileSync("git", [
  "-C",
  root,
  "-c",
  "user.name=MemCode QA",
  "-c",
  "user.email=qa@localhost",
  "commit",
  "-m",
  "Seed labelled onboarding fixture",
]);
const state = initialState(),
  original = JSON.parse(
    await readFile(join(process.env.APPDATA, "MemCode/workspace.json"), "utf8"),
  );
state.settings = original.settings;
state.workerConnections = {};
state.onboarding = { version: 1, step: "welcome", dismissed: true };
await writeFile(join(profile, "workspace.json"), JSON.stringify(state));
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const stdout = openSync(join(profile, "stdout.log"), "a"),
  stderr = openSync(join(profile, "stderr.log"), "a");
const child = spawn(nativeBinary(), [], {
  cwd: resolve("."),
  detached: true,
  windowsHide: true,
  stdio: ["ignore", stdout, stderr],
  env: nativeEnv({
    MEMCODE_DATA_DIR: profile,
    MEMCODE_APP_PATH: resolve("."),
    MEMCODE_SERVICE_PATH: resolve("dist-runtime/service.cjs"),
    MEMCODE_OPEN_PROJECT: root,
    MEMCODE_NATIVE_TEST_PROFILE: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
  }),
});
closeSync(stdout);
closeSync(stderr);
const report = { profile, root, port, result: "running", checks: [] };
console.log(JSON.stringify({ profile, root, port }));
let browser, main, storyId;
const click = (locator) => locator.evaluate((element) => element.click());
async function snap(name) {
  await main.screenshot({
    path: join(out, name + ".png"),
    animations: "disabled",
  });
}
try {
  for (let i = 0; i < 120; i++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, {
        timeout: 1000,
      });
      break;
    } catch {
      if (child.exitCode !== null) throw Error("Own QA window exited");
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  assert.ok(browser, "QA inspector unavailable");
  await expect
    .poll(() => {
      main = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().includes("tauri.localhost"));
      return !!main;
    })
    .toBeTruthy();
  await main.waitForFunction(() => !!window.memcode);
  await main.emulateMedia({ reducedMotion: "reduce" });
  const call = (method, ...args) =>
      main.evaluate(({ method, args }) => window.memcode[method](...args), {
        method,
        args,
      }),
    load = async () => (await call("load")).state;
  let project;
  await expect
    .poll(
      async () => {
        project = (await load()).projects.find(
          (project) =>
            project.path?.replaceAll("\\", "/") === root.replaceAll("\\", "/"),
        );
        return !!project;
      },
      { timeout: 30000 },
    )
    .toBeTruthy();
  await call("selectProject", project.id);
  await expect
    .poll(
      async () => {
        project = (await load()).projects.find((p) => p.id === project.id);
        return project.analysis;
      },
      { timeout: 90000, intervals: [500] },
    )
    .toBe("ready");
  assert.ok(
    (await load()).projects.some((project) => project.example),
    "Example project retained",
  );
  await click(main.getByRole("button", { name: "Docs", exact: true }));
  await expect(
    main.getByRole("region", { name: "MemCode user guide" }),
  ).toBeVisible();
  await snap("docs");
  await click(
    main.getByRole("button", { name: "Guide me through", exact: true }),
  );
  await expect(
    main.getByRole("dialog", { name: "Make your first idea real." }),
  ).toBeVisible();
  await snap("welcome");
  await click(
    main.getByRole("button", { name: "Let’s get started", exact: true }),
  );
  const guide = main.getByRole("complementary", {
    name: "Getting started guide",
  });
  await expect(guide).toContainText("Give your idea a home.");
  await click(
    guide.getByRole("button", {
      name: "Create or open a project",
      exact: true,
    }),
  );
  const projectDialog = main.getByRole("dialog", {
    name: "A place for what comes next.",
  });
  await expect(
    projectDialog.getByRole("textbox", { name: "Project name", exact: true }),
  ).toBeVisible();
  await expect(
    projectDialog.getByRole("textbox", {
      name: "Project purpose",
      exact: true,
    }),
  ).toBeVisible();
  await snap("project");
  await click(
    projectDialog.getByRole("button", { name: "Close dialog", exact: true }),
  );
  await click(
    guide.getByRole("button", { name: "Use " + project.name, exact: true }),
  );
  await click(
    guide.getByRole("button", { name: "Choose a worker", exact: true }),
  );
  const codex = main.locator('.worker-connection-card[data-harness="codex"]');
  await expect(
    codex.getByRole("button", { name: "Connect Codex", exact: true }),
  ).toBeEnabled({ timeout: 45000 });
  assert.equal(Object.keys((await load()).workerConnections ?? {}).length, 0);
  await snap("workers-before");
  await click(
    codex.getByRole("button", { name: "Connect Codex", exact: true }),
  );
  const consent = main.getByRole("dialog", { name: "Connect Codex." }),
    checkbox = consent.getByRole("checkbox");
  await expect(checkbox).not.toBeChecked();
  await expect(
    consent.getByRole("button", { name: "Approve & connect", exact: true }),
  ).toBeDisabled();
  await snap("worker-approval");
  await checkbox.check();
  await click(
    consent.getByRole("button", { name: "Approve & connect", exact: true }),
  );
  await expect(consent).toHaveCount(0, { timeout: 30000 });
  await expect
    .poll(async () => !!(await load()).workerConnections?.codex)
    .toBeTruthy();
  assert.equal(
    (await load()).tasks.some((task) => task.run.startedAt),
    false,
    "Connection cannot start a coding worker",
  );
  report.checks.push("Explicit unchecked worker approval without a coding run");
  await expect(guide).toContainText("Name the outcome.", { timeout: 20000 });
  await click(
    guide.getByRole("button", { name: "Write your first epic", exact: true }),
  );
  const epicDialog = main.getByRole("dialog", {
    name: "Give the bigger idea a direction.",
  });
  await epicDialog
    .getByRole("textbox", { name: "Epic name", exact: true })
    .fill("Launch the first useful version");
  await epicDialog
    .getByRole("textbox", { name: "Epic description", exact: true })
    .fill(
      "A clear local workspace for a small team to turn ideas into working software.",
    );
  await snap("epic");
  await click(
    epicDialog.getByRole("button", { name: "Create epic", exact: true }),
  );
  await expect(guide).toContainText("Make one small, clear request.");
  await snap("roadmap");
  await click(
    guide.getByRole("button", { name: "Write your first story", exact: true }),
  );
  const storyDialog = main.getByRole("dialog", {
      name: "Give the next idea a place.",
    }),
    brief =
      "Add a welcoming project introduction.\nExplain the purpose in two clear sentences and keep setup local.";
  await expect(
    storyDialog.getByRole("textbox", { name: "Work item title", exact: true }),
  ).toBeVisible();
  await storyDialog
    .getByRole("textbox", { name: "Work item brief", exact: true })
    .fill(brief);
  await expect(storyDialog.locator("#task-title-help")).toContainText(
    "Add a welcoming project introduction.",
  );
  await expect(
    storyDialog.getByRole("button", { name: "Create work item", exact: true }),
  ).toBeEnabled();
  await expect(
    storyDialog.getByRole("button", { name: "Create work item", exact: true }),
  ).toBeInViewport();
  await expect(
    storyDialog.getByLabel("New task cycle", { exact: true }),
  ).toBeHidden();
  await snap("story");
  await storyDialog
    .getByRole("button", { name: "Create work item", exact: true })
    .click();
  await expect(guide).toContainText("Your first story is ready.");
  let current = await load();
  const story = current.tasks.find(
    (task) => task.projectId === project.id && task.description === brief,
  );
  assert.ok(story);
  storyId = story.id;
  assert.equal(story.title, "Add a welcoming project introduction.");
  assert.ok(story.epicId);
  assert.equal(story.cycleId == null, true);
  assert.equal(story.run.state, "idle");
  await click(guide.getByRole("button", { name: "Finish guide", exact: true }));
  await expect(guide).toHaveCount(0);
  assert.ok((await load()).onboarding.completedAt);
  report.checks.push(
    "Docs-to-guide project, explicit worker, epic and brief-only story; no cycle or worker start",
  );
  if (!(await main.locator(".detail-overlay").count())) {
    await click(
      main.getByRole("button", { name: "Conversations", exact: true }),
    );
    await click(
      main.getByRole("button").filter({ hasText: story.title }).first(),
    );
  }
  await click(
    main.getByRole("dialog").getByRole("button", { name: /^Comments/ }),
  );
  const before = (await load()).tasks.find((task) => task.id === story.id)
    .messages.length;
  await main
    .getByRole("textbox", { name: "Task comment", exact: true })
    .fill("**Decision:** Keep the first version local and simple.");
  await click(main.getByRole("button", { name: "Post comment", exact: true }));
  await expect(
    main.locator(".story-comment .message-markdown strong"),
  ).toHaveText("Decision:");
  current = await load();
  const comment = current.storyComments.find(
    (comment) => comment.taskId === story.id,
  );
  await click(
    main
      .locator(`[data-story-comment-id="${comment.id}"]`)
      .getByRole("button", { name: "Reply", exact: true }),
  );
  await main
    .getByRole("textbox", { name: "Task comment", exact: true })
    .fill("Agreed. We can introduce cycles once the first story is working.");
  await click(main.getByRole("button", { name: "Post reply", exact: true }));
  await click(
    main
      .locator(`[data-story-comment-id="${comment.id}"]`)
      .getByRole("button", { name: "Edit task comment", exact: true }),
  );
  await main
    .getByRole("textbox", { name: "Edit task comment text", exact: true })
    .fill("**Decision:** Keep the first version local, clear and simple.");
  await click(
    main
      .locator(`[data-story-comment-id="${comment.id}"]`)
      .getByRole("button", { name: "Save", exact: true }),
  );
  await expect(
    main.locator(`[data-story-comment-id="${comment.id}"]`),
  ).toContainText("local, clear and simple");
  await snap("comments");
  current = await load();
  const reply = current.storyComments.find(
    (note) => note.parentId === comment.id,
  );
  await click(
    main
      .locator(`[data-story-comment-id="${reply.id}"]`)
      .getByRole("button", { name: "Delete task comment", exact: true }),
  );
  await expect(
    main.locator(`[data-story-comment-id="${reply.id}"]`),
  ).toContainText("Comment deleted.");
  assert.equal(
    (await load()).tasks.find((task) => task.id === story.id).messages.length,
    before,
  );
  report.checks.push(
    "Separate Markdown discussion with reply, owned edit and tombstone deletion; no worker prompt",
  );
  const blocker = await call("createTask", {
    projectId: project.id,
    epicId: story.epicId,
    title: "Queue prerequisite — deliberately unfinished",
    description:
      "Native QA holds queued messages without launching a coding model.",
    harness: "codex",
    assignment: "manual",
    priority: "low",
    kind: "test",
  });
  await call("updateTask", story.id, { dependsOn: [blocker.id] });
  await click(
    main
      .getByRole("dialog")
      .getByRole("button", { name: "Conversation", exact: true }),
  );
  await main
    .getByRole("textbox", { name: "Message to worker", exact: true })
    .fill("Queued first request for the introduction.");
  await click(
    main.getByRole("button", { name: "Send follow-up", exact: true }),
  );
  await expect
    .poll(
      async () =>
        !!(await load()).tasks
          .find((task) => task.id === story.id)
          .messages.find((message) => message.followupState === "queued"),
    )
    .toBeTruthy();
  current = await load();
  const queued = current.tasks
    .find((task) => task.id === story.id)
    .messages.find((message) => message.followupState === "queued");
  await click(main.getByRole("dialog").getByRole("button", { name: /^Queue/ }));
  const item = main.locator(`[data-queue-id="${queued.id}"]`);
  await click(
    item.getByRole("button", { name: "Edit queued follow-up 1", exact: true }),
  );
  await main
    .getByRole("textbox", { name: "Edit follow-up text", exact: true })
    .fill("Queued edited request for a clearer introduction.");
  await click(item.getByRole("button", { name: "Save changes", exact: true }));
  await expect(item).toContainText("Queued edited request");
  const note = await call("saveReviewComment", {
    taskId: story.id,
    reference: {
      taskId: story.id,
      kind: "file",
      name: "README.md",
      path: join(root, "README.md"),
      quote: "Draft opening for the first project.",
      selectionType: "lines",
      lineStart: 3,
      lineEnd: 3,
    },
    text: "Make the first sentence welcoming.",
  });
  await call(
    "sendFollowup",
    story.id,
    "Please address this selected source note.",
    [note.id],
  );
  await expect(main.locator(".followup-queue-item")).toHaveCount(2);
  await snap("queue");
  current = await load();
  const annotated = current.tasks
      .find((task) => task.id === story.id)
      .messages.find((message) => message.commentIds?.includes(note.id)),
    annotatedItem = main.locator(`[data-queue-id="${annotated.id}"]`);
  await click(
    annotatedItem.getByRole("button", {
      name: "Edit queued follow-up 2",
      exact: true,
    }),
  );
  await main
    .getByRole("textbox", { name: "Edit attached review note 1", exact: true })
    .fill("Make the selected first sentence welcoming and concise.");
  await click(
    annotatedItem.getByRole("button", { name: "Save changes", exact: true }),
  );
  await expect(annotatedItem).toContainText("welcoming and concise");
  await snap("queue-review");
  await click(
    item.getByRole("button", {
      name: "Cancel queued follow-up 1",
      exact: true,
    }),
  );
  await expect(item).toHaveCount(0);
  await click(
    annotatedItem.getByRole("button", {
      name: "Cancel queued follow-up 1",
      exact: true,
    }),
  );
  await expect(main.locator(".followup-queue-item")).toHaveCount(0);
  current = await load();
  const final = current.tasks.find((task) => task.id === story.id);
  assert.equal(final.run.state, "idle");
  assert.equal(final.run.startedAt, undefined);
  assert.equal(
    final.messages.find((message) => message.id === queued.id).followupState,
    "cancelled",
  );
  report.checks.push(
    "Visible queue, text and attached-note edit, cancellation, prerequisite hold; zero coding runs",
  );
  await click(
    main.getByRole("button", { name: "Close work item", exact: true }),
  );
  await click(main.getByRole("button", { name: "Workspace", exact: true }));
  await snap("workspace");
  assert.ok(current.projects.some((project) => project.example));
  report.result = "passed";
  report.completedAt = new Date().toISOString();
  report.projectId = project.id;
  report.storyId = storyId;
  report.epicId = story.epicId;
  await writeFile(join(out, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
} catch (error) {
  report.result = "failed";
  report.completedAt = new Date().toISOString();
  report.error = error.stack ?? String(error);
  await writeFile(join(out, "results.json"), JSON.stringify(report, null, 2));
  if (main) {
    await main.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    await main
      .evaluate(() => window.memcode.windowAction("close"))
      .catch(() => {});
  }
  console.error(report.error);
  process.exit(1);
}
