// Actual Tauri UI/IPC persistence check. Findings, measurements and checks are
// explicitly synthetic fixtures; this does not run a detector or coding model.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../src/seed.ts";
import { initializeCodeReviewWorkflow } from "../src/code-review-workflow.ts";
import { checkSourceBinding } from "../runtime/verification.ts";
import { git } from "../runtime/local.ts";
import { nativeEnv } from "./tauri-env.mjs";

assert.equal(
  process.platform,
  "win32",
  "This native UI check uses Windows WebView2; use the portable presentation check on other platforms.",
);

const digest = (value) => createHash("sha256").update(value).digest("hex");
function normalInvariants(state) {
  return (
    state && {
      planning: state.planning,
      settings: state.settings,
      workerConnections: state.workerConnections,
      projectIds: state.projects.map((item) => item.id).sort(),
      taskIds: state.tasks.map((item) => item.id).sort(),
      epicIds: state.epics.map((item) => item.id).sort(),
      cycleIds: state.cycles.map((item) => item.id).sort(),
    }
  );
}
function changedPaths(before, after, path = "") {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    if (
      Array.isArray(before) &&
      Array.isArray(after) &&
      before.length === after.length
    )
      return before.flatMap((item, index) =>
        changedPaths(item, after[index], `${path}[${index}]`),
      );
    if (!Array.isArray(before) && !Array.isArray(after))
      return [
        ...new Set([...Object.keys(before), ...Object.keys(after)]),
      ].flatMap((key) =>
        changedPaths(before[key], after[key], path ? `${path}.${key}` : key),
      );
  }
  return [path];
}
const profile = await mkdtemp(join(tmpdir(), "memcode-decision-qa-"));
const out = resolve(
  "tmp/code-review-decisions-native-evidence",
  String(Date.now()),
);
const binary = resolve("src-tauri/target/debug/memcode.exe");
const source = join(profile, "source"),
  taskId = "synthetic-decision-qa",
  projectId = "synthetic-review";
const normalWorkspace = join(
  process.env.APPDATA ?? "",
  "MemCode",
  "workspace.json",
);
const normalBeforeBytes = await readFile(normalWorkspace).catch(() => null);
const normalBefore = normalBeforeBytes ? digest(normalBeforeBytes) : null;
const normalBeforeState = normalBeforeBytes
  ? JSON.parse(normalBeforeBytes)
  : null;
assert.notEqual(
  resolve(profile).toLowerCase(),
  resolve(normalWorkspace, "..").toLowerCase(),
);
await mkdir(out, { recursive: true });
await mkdir(source);
await git(source, ["init", "--initial-branch=main"]);
const code = "export function double(value: number) { return value * 2; }\n";
await writeFile(join(source, "sample.ts"), code);
await git(source, ["add", "sample.ts"]);
await git(source, [
  "-c",
  "user.name=QA fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "-m",
  "Synthetic native review fixture",
]);
const binding = await checkSourceBinding(source);
assert.match(binding ?? "", /^[a-f0-9]{64}$/);
const at = new Date().toISOString(),
  state = initialState(),
  runId = randomUUID();
const task = {
  id: taskId,
  projectId,
  identifier: "MC-QA",
  title: "Synthetic review decision fixture",
  description:
    "Isolated QA only: seeded finding, metrics and checks. No detector or coding model ran.",
  stage: "review",
  statusId: `${projectId}:code-review`,
  priority: "medium",
  category: "QA fixture",
  harness: "codex",
  assignment: "manual",
  messages: [],
  checklist: [],
  createdAt: at,
  updatedAt: at,
  changesRevision: "fixture-1",
  run: {
    state: "finished",
    workspace: source,
    branch: "main",
    changeRunId: "fixture-pass",
  },
  codeReview: {
    runId,
    state: "completed",
    outcome: "changes-requested",
    updatedAt: at,
    findingCount: 1,
  },
};
state.projects = [
  {
    id: projectId,
    name: "Synthetic QA — no model run",
    description: task.description,
    path: source,
    branch: "main",
    analysis: "idle",
    createdAt: at,
  },
];
state.tasks = [task];
state.epics = [];
state.cycles = [];
state.artifacts = [];
state.workflowStates = [];
state.reviewWorkflows = {};
state.activeProjectId = projectId;
state.onboarding = {
  version: 1,
  step: "ready",
  dismissed: true,
  completedAt: at,
  projectId,
};
state.projectOnboarding = { [projectId]: state.onboarding };
state.onboardingPreferences = { showForNewProjects: false };
initializeCodeReviewWorkflow(state, projectId);
const review = {
  version: 1,
  id: runId,
  taskId,
  implementationRunIds: ["fixture-pass"],
  createdAt: at,
  updatedAt: at,
  completedAt: at,
  state: "completed",
  outcome: "changes-requested",
  phases: ["capture", "review", "quality", "impact", "verification"].map(
    (id) => ({
      id,
      state: "complete",
      note: "Synthetic fixture; not executed.",
    }),
  ),
  snapshot: {
    id: randomUUID(),
    patchHash: digest("synthetic patch"),
    journalRevision: "fixture-1",
    branch: "main",
    commit: await git(source, ["rev-parse", "HEAD"]),
    sourceRevision: binding,
    graphRevision: "synthetic-fixture",
    files: [
      {
        path: "sample.ts",
        beforeHash: digest(code),
        afterHash: digest(code),
        attribution: "reservation",
      },
    ],
    additions: 0,
    deletions: 0,
  },
  engine: { version: "Synthetic fixture — no engine run" },
  coverage: { complete: true, limitations: [] },
  findings: [
    {
      id: "synthetic-finding",
      title: "Synthetic validation concern",
      explanation:
        "Seeded only to verify dismissal persistence through the native UI.",
      severity: "medium",
      category: "correctness",
      path: "sample.ts",
      line: 1,
      provenance: "ast",
      evidenceData: { fixture: true, detectorExecuted: false },
    },
  ],
  metrics: [],
  impact: { symbols: 0, files: 0, processes: 0, complete: true },
  checks: [
    {
      name: "Synthetic check fixture — not executed",
      state: "passed",
      detail: "Seeded UI state only; no check executed.",
    },
  ],
  messages: [
    {
      id: randomUUID(),
      role: "system",
      at,
      text: "Synthetic QA review. Findings and checks are seeded fixtures, not engine or provider results.",
    },
  ],
};
const directory = join(profile, "code-reviews", digest(taskId));
await mkdir(directory, { recursive: true });
await writeFile(
  join(directory, runId + ".json"),
  JSON.stringify({
    run: review,
    sourceBinding: binding,
    changesRevision: "fixture-1",
    queued: false,
  }),
);
await writeFile(join(directory, "latest.json"), JSON.stringify({ runId }));
await writeFile(join(profile, "workspace.json"), JSON.stringify(state));
const report = {
  scope:
    "Actual Tauri UI/IPC; synthetic seeded review, no engine/provider/check execution",
  profile,
  source,
  result: "running",
  forcedCleanup: false,
  checks: [],
  screenshots: [],
  instances: [],
  normalWorkspaceBeforeHash: normalBefore,
  binarySha256: digest(await readFile(binary)),
  runtimeSha256: digest(await readFile(resolve("dist-runtime/service.cjs"))),
  rendererIndexSha256: digest(await readFile(resolve("dist/index.html"))),
};
let active;
async function launch() {
  const reserve = createServer();
  await new Promise((done) => reserve.listen(0, "127.0.0.1", done));
  const port = reserve.address().port;
  await new Promise((done) => reserve.close(done));
  const child = spawn(binary, [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: nativeEnv({
      MEMCODE_DATA_DIR: profile,
      MEMCODE_APP_PATH: resolve("."),
      MEMCODE_SERVICE_PATH: resolve("dist-runtime/service.cjs"),
      MEMCODE_NATIVE_TEST_PROFILE: "1",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    }),
  });
  let diagnostics = "";
  child.stderr.on("data", (data) => {
    diagnostics = (diagnostics + data).slice(-12000);
  });
  child.stdout.on("data", (data) => {
    diagnostics = (diagnostics + data).slice(-12000);
  });
  const exited = new Promise((done) =>
    child.once("exit", (code) => done(code)),
  );
  const instance = { pid: child.pid, debugPort: port, profile };
  report.instances.push(instance);
  active = { child, exited, page: undefined, instance };
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw Error(`Native fixture exited: ${diagnostics}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page =
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes("tauri.localhost")) ??
    browser.contexts()[0].pages()[0];
  active.page = page;
  await page.waitForFunction(() => !!window.memcode, { timeout: 20000 });
  assert.match(
    page.url(),
    /tauri\.localhost|127\.0\.0\.1:5197/,
    "Only the native main renderer is permitted",
  );
  report.rendererOrigin = page.url();
  report.rendererMode = page.url().includes(":5197")
    ? "Live development renderer in native Tauri window"
    : "Packaged production renderer";
  const loaded = await page.evaluate(() => window.memcode.load());
  assert.equal(
    resolve(loaded.runtime.dataPath).toLowerCase(),
    resolve(profile).toLowerCase(),
  );
  instance.confirmedRuntimeDataPath = loaded.runtime.dataPath;
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.getByText(task.title, { exact: true }).first().click();
  await writeFile(
    join(out, "opened-card-dom.txt"),
    await page.locator("body").innerText(),
  );
  await page.screenshot({ path: join(out, "opened-card.png") });
  await page
    .locator(".detail-tabs")
    .getByRole("button", { name: /^Code review/ })
    .click();
  await expect(
    page.getByRole("region", { name: "Task code review" }),
  ).toBeVisible();
  return page;
}
async function close() {
  if (!active) return;
  const owned = active;
  active = undefined;
  if (owned.page && !owned.page.isClosed())
    await owned.page
      .evaluate(() => window.memcode.windowAction("close"))
      .catch(() => {});
  const exit = await Promise.race([
    owned.exited,
    new Promise((done) => setTimeout(() => done("timeout"), 30000).unref()),
  ]);
  if (exit === "timeout") {
    owned.child.unref();
    throw Error("Isolated QA app did not exit naturally");
  }
  assert.equal(exit, 0);
  owned.instance.exitCode = exit;
  owned.instance.naturalExit = true;
  await assert.rejects(access(join(profile, "runtime.lock")), {
    code: "ENOENT",
  });
}
try {
  let page = await launch();
  await page
    .getByRole("button", { name: /Synthetic validation concern/ })
    .click();
  await page.getByRole("button", { name: "Dismiss with reason" }).click();
  const save = page.getByRole("button", {
    name: "Save dismissal",
    exact: true,
  });
  await expect(save).toBeDisabled();
  await page
    .getByLabel("Your explanation", { exact: true })
    .fill("The synthetic caller fixture already validates this value.");
  await save.click();
  const dismissed = await page.evaluate(
    (id) => window.memcode.getCodeReview(id),
    taskId,
  );
  assert.equal(dismissed.findingDispositions.length, 1);
  assert.equal(dismissed.findingDispositions[0].status, "dismissed");
  assert.equal(dismissed.outcome, "ready");
  await expect(page.locator(".review-dismissed-findings")).toBeVisible();
  await page.locator(".review-dismissed-finding > summary").click();
  await expect(
    page.getByText(
      "The synthetic caller fixture already validates this value.",
      { exact: true },
    ),
  ).toBeVisible();
  const image = join(out, "native-dismissed.png");
  await page.screenshot({ path: image });
  report.screenshots.push(image);
  report.checks.push(
    "Native generic IPC accepted the UI dismissal with a required saved reason",
  );
  await close();
  page = await launch();
  const restored = await page.evaluate(
    (id) => window.memcode.getCodeReview(id),
    taskId,
  );
  assert.deepEqual(restored.findingDispositions, dismissed.findingDispositions);
  assert.equal(restored.findings.length, 1);
  await page.locator(".review-dismissed-findings > summary").click();
  await page.locator(".review-dismissed-finding > summary").click();
  await page
    .getByRole("button", { name: "Reopen finding", exact: true })
    .click();
  const reopened = await page.evaluate(
    (id) => window.memcode.getCodeReview(id),
    taskId,
  );
  assert.equal(reopened.findingDispositions.length, 2);
  assert.equal(reopened.findingDispositions[1].status, "reopened");
  assert.equal(reopened.outcome, "changes-requested");
  assert.equal(reopened.findings.length, 1);
  const second = join(out, "native-reopened.png");
  await page.screenshot({ path: second });
  report.screenshots.push(second);
  report.checks.push(
    "Native restart preserved the saved decision and reopening restored the active finding",
  );
  await close();
  const disk = JSON.parse(
    await readFile(join(directory, runId + ".json"), "utf8"),
  );
  assert.equal(disk.run.findingDispositions.length, 2);
  assert.equal(disk.run.outcome, "changes-requested");
  assert.equal(await checkSourceBinding(source), binding);
  const normalAfterBytes = await readFile(normalWorkspace).catch(() => null);
  const normalAfterState = normalAfterBytes
    ? JSON.parse(normalAfterBytes)
    : null;
  report.normalWorkspaceAfterHash = normalAfterBytes
    ? digest(normalAfterBytes)
    : null;
  report.normalObservedChangedPaths = changedPaths(
    normalBeforeState,
    normalAfterState,
  );
  report.normalPlanningSettingsConnectionsAndIdsPreserved =
    JSON.stringify(normalInvariants(normalBeforeState)) ===
    JSON.stringify(normalInvariants(normalAfterState));
  report.normalProfileIsolation =
    "Both native runtimes confirmed the isolated QA data path. Test writes only that profile/source and its evidence directory.";
  if (report.normalObservedChangedPaths.length)
    report.externalWritesNote =
      "The normal app remained live; its background team sync/watch may save independently. Changed paths are observations, not proof of QA writes.";
  report.sourceUnchanged = true;
  report.gracefulShutdown = true;
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = String(error?.stack ?? error);
  throw error;
} finally {
  await close();
  await writeFile(
    join(out, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
