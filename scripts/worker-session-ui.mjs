import { expect } from "@playwright/test";

// Exercise host updates through the same renderer subscription as a live worker.
// The native bridge still provides workspace loading; worker calls are isolated.
export async function verifyWorkerSessionUI(page, taskId, title) {
  const fixture = await page.addInitScript(({ taskId }) => {
    let api, base, mode = "idle";
    const listeners = new Set();
    const start = new Date(Date.now() - 92000).toISOString();
    const at = new Date(Date.now() - 8000).toISOString();
    const transform = (state) => {
      base = state;
      const copy = structuredClone(state);
      const task = copy.tasks.find((item) => item.id === taskId);
      copy.onboarding = { version: 1, step: "welcome", dismissed: true };
      copy.workerInputs = [];
      task.example = false;
      task.stage = "planned";
      task.assignment = "manual";
      task.harness = "cursor";
      task.dependsOn = [];
      task.route = {
        harness: "cursor", model: "grok-local-fixture", mode: "manual",
        effort: "medium", tier: "balanced", inputs: {}, reasons: [],
      };
      task.run = { state: "idle" };
      copy.workerConnections = {
        cursor: { harness: "cursor", approvedAt: start, runtimePath: "/test/cursor", auth: "local", scopeVersion: 1 },
      };
      if (mode.startsWith("remote")) {
        const claim = { storyId: taskId, memberId: "teammate", deviceId: "mac", epoch: 2, attemptId: "attempt", acquiredAt: start };
        const activity = { ...claim, harness: "codex", requestedModel: "requested-fixture", phase: "starting", startedAt: start, updatedAt: at };
        if (mode === "remote-live" || mode === "remote-offline") {
          activity.phase = "testing";
          activity.actualModel = "confirmed-fixture";
          activity.recent = [{ phase: "starting", at: start }, { phase: "testing", at }];
        }
        copy.team = [{
          projectId: task.projectId, memberId: "teammate", deviceId: "windows",
          connection: mode === "remote-offline" ? "offline" : "online",
          workerActivity: mode === "remote-legacy" ? [] : [activity], pendingCount: 0,
          workspace: { workspaceId: "test-team", name: "Team test", head: 1,
            members: [{ id: "teammate", name: "Alex", devices: [{ id: "mac", name: "Studio Mac" }] }],
            stories: [], epics: [], cycles: [], comments: [], claims: [claim], results: [], activity: [], readCursors: [],
          },
        }];
      } else {
        copy.team = [];
        task.run = { state: mode, startedAt: start, activity: { phase: "working", label: "Coordinating with the goal’s other tasks", at } };
        if (mode === "running") task.run.activity = {
          phase: "tool", label: "Reading source", toolId: "test-read", at,
          lastTool: { label: "Running checks", durationMs: 13250, failed: false },
        };
        if (mode === "failed") task.run.error = "Provider process exited before opening a session.";
      }
      return copy;
    };
    window.__workerUiPhase = (next) => {
      mode = next;
      for (const listener of listeners) listener(transform(base));
    };
    Object.defineProperty(window, "memcode", {
      configurable: true,
      get: () => api,
      set(value) {
        const load = value.load.bind(value);
        const subscribe = value.onState.bind(value);
        value.load = async () => {
          const result = await load();
          const runtime = { ...result.runtime, harnesses: [{id: "cursor", available: true, path: "/test/cursor", models: []}] };
          return { ...result, runtime, state: transform(result.state) };
        };
        value.onState = (listener) => {
          listeners.add(listener);
          const off = subscribe((state) => listener(transform(state)));
          return () => { listeners.delete(listener); off(); };
        };
        value.startWorker = () => new Promise((_resolve, reject) => {
          window.__rejectWorkerStart = () => reject(new Error("Could not reserve the fixture story."));
        });
        value.stopWorker = async () => window.__workerUiPhase("stopping");
        api = value;
      },
    });
  }, { taskId });
  await page.reload();
  await page.getByText(title, { exact: true }).first().click();
  const phase = (next) => page.evaluate((value) => window.__workerUiPhase(value), next);
  const startup = page.getByRole("group", { name: "Worker startup" });
  const inspector = page.locator(".work-inspector");
  const tabs = page.locator(".detail-tabs");
  await inspector.getByRole("button", { name: "Start worker", exact: true }).click();
  await expect(startup).toContainText("Requesting worker");
  await page.evaluate(() => window.__rejectWorkerStart());
  await expect(page.getByRole("alert")).toContainText("Could not reserve the fixture story.");
  await phase("preparing");
  await expect(startup).toContainText("Coordinating with the goal’s other tasks");
  await expect(startup).toContainText(/\d+s on this step · 1m \d+s total/);
  await tabs.getByRole("button", { name: "Runbook", exact: true }).click();
  await expect(inspector.getByRole("group", { name: "Worker startup" })).toBeVisible();
  await inspector.getByRole("button", { name: "Stop worker", exact: true }).click();
  await expect(inspector.getByRole("button", { name: "Stopping worker…" })).toBeDisabled();
  await phase("stopped");
  await expect(inspector.locator(".assigned-worker")).toContainText("Worker stopped");
  await phase("failed");
  await tabs.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Provider process exited");
  await phase("running");
  const live = page.getByRole("group", { name: "Worker activity" });
  await expect(live.getByRole("status")).toHaveText("Reading source");
  await expect(live.getByTitle("Running checks")).toHaveText("Last tool finished in 13s");
  await phase("remote-legacy");
  const remote = page.getByRole("region", { name: "Worker on another device" });
  await expect(remote).toContainText("Alex · Studio Mac");
  await expect(remote).toContainText("Waiting for a worker update");
  await expect(inspector).not.toContainText("grok-local-fixture");
  await expect(inspector.locator(".start-worker, .stop-worker, .routing-card")).toHaveCount(0);
  await expect(page.locator(".composer-box")).toHaveCount(0);
  await phase("remote-start");
  await expect(remote).toContainText("Codex");
  await expect(remote).toContainText("Requested model");
  await expect(remote).toContainText("requested-fixture");
  await phase("remote-live");
  await expect(remote).toContainText("Confirmed model");
  await expect(remote).toContainText("confirmed-fixture");
  await expect(remote.locator("time").first()).toBeVisible();
  await expect(page.locator(".remote-conversation-note")).toContainText("Running checks");
  await remote.getByText("Recent activity", { exact: true }).click();
  await expect(remote.locator("ol li")).toHaveCount(2);
  await page.getByRole("button", { name: "Open team comments" }).click();
  for (const tab of ["Browser", "Terminal", "Queue"]) {
    await tabs.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.getByText("Open the " + tab.toLowerCase() + " on Studio Mac.", { exact: true })).toBeVisible();
  }
  await phase("remote-offline");
  await expect(remote).toContainText("Last synced");
  await expect(remote).toContainText("Team Sync is offline");
  await phase("idle");
  await expect(remote).toHaveCount(0);
  await expect(inspector.locator(".start-worker")).toBeEnabled();
  await fixture.dispose();
}
