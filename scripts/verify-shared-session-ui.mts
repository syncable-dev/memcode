// Native desktop acceptance with explicitly labelled transport/UI fixtures.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../src/seed.ts";
import { initializeCodeReviewWorkflow } from "../src/code-review-workflow.ts";
import { TeamSyncClient } from "../runtime/team/client.ts";
import { nativeBinary, nativeEnv } from "./tauri-env.mjs";

assert.equal(
  process.platform,
  "win32",
  "This desktop driver uses WebView2 CDP. On macOS, inspect the built WKWebView app with native UI automation instead.",
);

const root = await mkdtemp(join(tmpdir(), "memcode-shared-session-ui-")),
  now = new Date().toISOString();
const hostState = initialState(),
  peerState = initialState();
const base = hostState.tasks[0];
const task: any = {
  ...base,
  id: "shared-ui-story",
  projectId: "host",
  identifier: "QA-SHARED",
  title: "Shared-session UI acceptance — fixture data",
  harness: "claude",
  assignment: "manual",
  example: false,
  run: { state: "idle" },
  stage: "review",
  epicId: null,
  cycleId: null,
  messages: [
    {
      id: "brief",
      role: "user",
      text: "This is labelled UI test data.",
      at: now,
    },
    {
      id: "worker-answer",
      role: "assistant",
      text: "The shared worker conversation is visible on both devices.",
      at: now,
    },
  ],
};
for (const [state, id] of [
  [hostState, "host"],
  [peerState, "peer"],
] as const) {
  Object.assign(state, {
    projects: [
      {
        id,
        name: "Shared session acceptance",
        description: "Explicit UI fixture",
        path: null,
        branch: "main",
        analysis: "idle",
        createdAt: now,
      },
    ],
    tasks: id === "host" ? [task] : [],
    epics: [],
    cycles: [],
    artifacts: [],
    team: [],
    activeProjectId: id,
    onboarding: { dismissed: true, step: "complete" },
    onboardingPreferences: { showForNewProjects: false },
  });
  initializeCodeReviewWorkflow(state, id);
}
task.statusId = hostState.reviewWorkflows.host.codeReviewStatusId;
const hostDir = join(root, "host"),
  peerDir = join(root, "peer");
await mkdir(hostDir);
await mkdir(peerDir);
const host = new TeamSyncClient(
    () => hostState,
    hostDir,
    async () => {},
    {
      background: false,
      onSessionCommand: async (item, c) => {
        if (c.kind !== "followup") return;
        const prior = item.messages.find((m) => m.id === c.id);
        if (prior) {
          prior.text = c.text;
          return;
        }
        item.messages.push({
          id: c.id,
          sourceCommandId: c.id,
          role: "user",
          text: c.text,
          at: c.createdAt,
          actor: c.author,
          followupState: "queued",
        });
      },
    },
  ),
  peer = new TeamSyncClient(
    () => peerState,
    peerDir,
    async () => {},
    { background: false },
  );
await host.initialize();
await peer.initialize();
await host.create({ projectId: "host", displayName: "Alice" });
await peer.join({
  projectId: "peer",
  displayName: "Bob",
  invite: JSON.stringify(await host.invite("host")),
});
await host.acquire(task.id, "host");
task.run = {
  state: "running",
  startedAt: now,
  measurements: { modelId: "claude-opus-ui-fixture" },
  activity: { phase: "testing", label: "Running checks", at: now },
};
await host.synchronize("host");
await peer.synchronize("peer");
const review: any = {
  version: 1,
  id: "ui-review",
  taskId: task.id,
  implementationRunIds: ["ui-fixture"],
  createdAt: now,
  updatedAt: now,
  state: "completed",
  outcome: "incomplete",
  phases: [],
  snapshot: {
    id: "ui-snapshot",
    patchHash: "fixture",
    journalRevision: "fixture",
    branch: "main",
    commit: null,
    sourceRevision: "fixture",
    graphRevision: "fixture",
    files: [],
    additions: 3,
    deletions: 2,
  },
  engine: { version: "UI fixture" },
  coverage: {
    complete: false,
    limitations: ["Explicitly labelled UI test data"],
  },
  findings: [],
  metrics: [
    {
      symbol: "VisibleFunction",
      path: "src/ui-fixture.ts",
      line: 1,
      cognitive: 23,
      cyclomatic: 11,
      nesting: 3,
      maintainabilityIndex: 0,
      source: "ast",
      before: {
        source: "ast",
        cognitive: 45,
        cyclomatic: 24,
        nesting: 5,
        maintainabilityIndex: 0,
      },
      comparison: { status: "matched" },
    },
  ],
  impact: { symbols: 4, files: 2, processes: 1, complete: true },
  checks: [{ name: "UI fixture check", state: "unavailable" }],
  messages: [],
};
host.reviewSaved(review);
await host.synchronize("host");
await peer.synchronize("peer");
await peer.close();
await writeFile(join(peerDir, "workspace.json"), JSON.stringify(peerState));
const listener = createServer();
await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
const port = (listener.address() as any).port;
await new Promise<void>((done) => listener.close(() => done()));
const child = spawn(nativeBinary(), [], {
  env: nativeEnv({
    MEMCODE_DATA_DIR: peerDir,
    MEMCODE_APP_PATH: resolve("."),
    MEMCODE_SERVICE_PATH: resolve("dist-runtime/service.cjs"),
    MEMCODE_NATIVE_TEST_PROFILE: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
  }),
  windowsHide: true,
  stdio: ["ignore", "ignore", "pipe"],
});
let diagnostic = "";
child.stderr.on("data", (c) => (diagnostic = (diagnostic + c).slice(-3000)));
let browser: any, page: any;
const ticker = setInterval(() => {
  void host.synchronize("host").catch(() => {});
}, 500);
const result: any = {
  root,
  platform: process.platform,
  fixture: true,
  passed: false,
};
try {
  for (let i = 0; i < 80; i++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, {
        timeout: 600,
      });
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  assert.ok(browser, diagnostic);
  for (let i = 0; i < 80; i++) {
    page = browser
      .contexts()
      .flatMap((c: any) => c.pages())
      .find((p: any) => p.url().includes("tauri.localhost"));
    if (page) break;
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.ok(page, diagnostic);
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
  const skip = page.getByRole("button", { name: "Skip for now", exact: true });
  if (await skip.count()) await skip.click();
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await page
    .getByRole("button")
    .filter({ hasText: task.title })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Conversation", exact: true })
    .click();
  await expect(dialog).toContainText(
    "The shared worker conversation is visible on both devices.",
  );
  await expect(
    dialog.getByRole("region", { name: "Worker on another device" }),
  ).toContainText("Claude Code");
  await expect(dialog).toContainText("claude-opus-ui-fixture");
  await page
    .getByRole("textbox", { name: "Message to worker" })
    .fill("Native UI follow-up from Bob");
  await dialog
    .getByRole("button", { name: "Queue follow-up", exact: true })
    .click();
  await expect
    .poll(() =>
      hostState.tasks[0].messages.some(
        (m) => m.text === "Native UI follow-up from Bob",
      ),
    )
    .toBe(true);
  await dialog
    .getByRole("button", { name: /^Queue/ })
    .first()
    .click();
  await expect(
    dialog.getByRole("region", { name: "Follow-up queue" }),
  ).toContainText("Bob");
  await dialog.getByRole("button", { name: "Edit queued follow-up 1" }).click();
  await dialog
    .getByRole("textbox", { name: "Edit follow-up text" })
    .fill("Edited native follow-up");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect
    .poll(() =>
      hostState.tasks[0].messages.some(
        (m) => m.text === "Edited native follow-up",
      ),
    )
    .toBe(true);
  await dialog
    .getByRole("button", { name: "Cancel queued follow-up 1" })
    .click();
  await expect(dialog).toContainText("The queue is clear.");
  await dialog
    .getByRole("button", { name: /^Code review/ })
    .first()
    .click();
  await expect(dialog).toContainText("23");
  await expect(dialog).toContainText("VisibleFunction");
  await expect(dialog.getByRole("table")).toContainText("11");
  await page.screenshot({ path: join(root, "shared-review.png") });
  result.passed = true;
  result.checks = [
    "actual native shared transcript/model",
    "remote follow-up from composer",
    "author attribution",
    "queue edit and cancel",
    "review per-function numbers including zero",
  ];
} catch (error) {
  result.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  clearInterval(ticker);
  if (page)
    await page
      .evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("window_action", { action: "close" }),
      )
      .catch(() => {});
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  await host.close();
  await writeFile(join(root, "receipt.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
