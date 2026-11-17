import test from "node:test";
import assert from "node:assert/strict";
import { AppUpdater, updatePercent, type AppUpdateAPI } from "../src/updates";
import {
  AppUpdateGate,
  registerAppUpdates,
  appReleaseHistory,
} from "../runtime/app-updates";
import { initialState } from "../src/seed";
import { WorkerManager } from "../runtime/workers";
import type { Harness, Project, WorkItem } from "../src/shared";
import type { MemtraceEngine } from "../runtime/memtrace";

const release = {
  version: "0.4.0-beta.2",
  notes: "## Improvements\n\n- A real release",
  publishedAt: "2026-11-16T00:00:00Z",
};
const api = (patch: Partial<AppUpdateAPI> = {}): AppUpdateAPI => ({
  context: async () => ({ activeWorkers: 0, activeTerminals: 0 }),
  history: async () => [],
  info: async () => ({ currentVersion: "0.4.0-beta.1", development: false }),
  check: async () => release,
  download: async () => {},
  install: async () => {},
  ...patch,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("automatic downloads prepare a verified update in the background and never restart active work", async () => {
  let downloads = 0,
    installs = 0;
  const updater = new AppUpdater(
    api({
      context: async () => ({ activeWorkers: 3, activeTerminals: 1 }),
      download: async (_, progress) => {
        downloads++;
        progress({ phase: "verifying", downloaded: 100, total: 100 });
      },
      install: async () => {
        installs++;
      },
    }),
  );
  updater.setAutomaticDownloads(true);
  await updater.start();
  assert.equal(downloads, 1);
  assert.equal(updater.getSnapshot().phase, "ready");
  assert.equal(installs, 0);
  await updater.poll();
  updater.setAutomaticDownloads(true);
  assert.equal(downloads, 1);
  assert.equal(await updater.requestRestart(), false);
  assert.deepEqual(updater.getSnapshot().restartReview, {
    activeWorkers: 3,
    activeTerminals: 1,
  });
  assert.equal(installs, 0);
});

test("automatic download opt-out retains manual control and a failure waits for an explicit retry", async () => {
  let downloads = 0;
  const updater = new AppUpdater(
    api({
      download: async () => {
        downloads++;
        throw Error("offline");
      },
    }),
  );
  updater.setAutomaticDownloads(false);
  await updater.start();
  assert.equal(downloads, 0);
  updater.setAutomaticDownloads(true);
  await tick();
  assert.equal(downloads, 1);
  assert.equal(updater.getSnapshot().phase, "error");
  updater.setAutomaticDownloads(true);
  await updater.poll();
  assert.equal(downloads, 1);
  await updater.download();
  assert.equal(downloads, 2);
});

test("network failures never report up to date or retain a stale install announcement", async () => {
  let fail = false;
  const updater = new AppUpdater(
    api({
      check: async () => {
        if (fail) throw Error("The update service is unreachable");
        return release;
      },
    }),
  );
  await updater.check();
  assert.equal(updater.getSnapshot().phase, "available");
  fail = true;
  await updater.check();
  assert.equal(updater.getSnapshot().phase, "error");
  assert.equal(updater.getSnapshot().release, undefined);
  assert.match(updater.getSnapshot().error!, /unreachable/);
});

test("published release history uses only the official endpoint and never passes source or download capabilities into Settings", async () => {
  const result = await appReleaseHistory((async (url, options) => {
    assert.equal(url, "https://www.memtrace.io/api/memcode/releases");
    assert.equal(
      options?.headers &&
        (options.headers as Record<string, string>).authorization,
      undefined,
    );
    return Response.json({
      product: "MemCode",
      channel: "beta",
      source: { privateToken: "neverdisplay" },
      releases: [
        {
          ...release,
          title: "First beta",
          publishedAt: "2026-11-16T00:00:00Z",
          assets: [{ secret: "discard" }],
          extra: "discard",
        },
      ],
    });
  }) as typeof fetch);
  assert.deepEqual(Object.keys(result[0]).sort(), [
    "notes",
    "publishedAt",
    "title",
    "version",
  ]);
  await assert.rejects(
    appReleaseHistory(
      (async () =>
        new Response("Unavailable", { status: 503 })) as typeof fetch,
    ),
    /unavailable/,
  );
  await assert.rejects(
    appReleaseHistory((async () =>
      Response.json({
        product: "MemCode",
        channel: "beta",
        releases: [{ version: "unpublished" }],
      })) as typeof fetch),
  );
});

test("no update is a successful check; development builds never query or install releases", async () => {
  const current = new AppUpdater(api({ check: async () => null }));
  await current.check();
  assert.equal(current.getSnapshot().phase, "current");
  assert.ok(current.getSnapshot().checkedAt);
  let checks = 0,
    installs = 0;
  const development = new AppUpdater(
    api({
      info: async () => ({ currentVersion: "0.4.0-beta.1", development: true }),
      check: async () => {
        checks++;
        return release;
      },
      install: async () => {
        installs++;
      },
    }),
  );
  await development.check();
  await development.install();
  assert.equal(checks, 0);
  assert.equal(installs, 0);
  assert.equal(development.getSnapshot().phase, "idle");
});

test("rapid clicks do not duplicate downloads or restarts, and a verified download waits for an explicit restart", async () => {
  let resolveCheck!: (value: typeof release) => void,
    finishDownload!: () => void,
    finishInstall!: () => void,
    checks = 0,
    downloads = 0,
    installs = 0;
  const updater = new AppUpdater(
    api({
      check: () => {
        checks++;
        return new Promise((resolve) => (resolveCheck = resolve));
      },
      download: async (version, progress) => {
        downloads++;
        assert.equal(version, release.version);
        progress({ phase: "downloading", downloaded: 50, total: 100 });
        await new Promise<void>((resolve) => (finishDownload = resolve));
        progress({ phase: "verifying", downloaded: 100, total: 100 });
      },
      install: async (version, progress) => {
        installs++;
        assert.equal(version, release.version);
        await new Promise<void>((resolve) => (finishInstall = resolve));
        progress({ phase: "installing", downloaded: 100, total: 100 });
      },
    }),
  );
  const first = updater.check();
  await tick();
  await updater.check();
  assert.equal(checks, 1);
  resolveCheck(release);
  await first;
  await updater.install();
  assert.equal(
    installs,
    0,
    "an available update cannot restart before a verified download",
  );
  const download = updater.download();
  await tick();
  await updater.download();
  assert.equal(downloads, 1);
  assert.equal(updatePercent(updater.getSnapshot().progress), 50);
  finishDownload();
  await download;
  assert.equal(updater.getSnapshot().phase, "ready");
  assert.equal(
    installs,
    0,
    "download completion must never automatically install",
  );
  await updater.check();
  assert.equal(
    checks,
    1,
    "a recheck must not discard a prepared signed download",
  );
  const install = updater.install();
  await tick();
  await updater.install();
  assert.equal(installs, 1);
  finishInstall();
  await install;
  assert.equal(updater.getSnapshot().phase, "installing");
  assert.equal(updater.getSnapshot().info?.currentVersion, "0.4.0-beta.1");
  await updater.install();
  await updater.check();
  assert.equal(installs, 1);
  assert.equal(checks, 1);
});

test("signature/install errors remain visible and do not mark the release installed", async () => {
  const updater = new AppUpdater(
    api({
      install: async () => {
        throw Error("Signature verification failed");
      },
    }),
  );
  await updater.check();
  await updater.download();
  await updater.install();
  assert.equal(updater.getSnapshot().phase, "error");
  assert.match(updater.getSnapshot().error!, /Signature/);
  assert.equal(updater.getSnapshot().info?.currentVersion, "0.4.0-beta.1");
  assert.equal(
    updatePercent({ phase: "downloading", downloaded: 1, total: 0 }),
    undefined,
  );
});

test("startup checks once without downloading or restarting, and a renderer reload retains native restart readiness", async () => {
  let checks = 0,
    downloads = 0,
    installs = 0;
  const updater = new AppUpdater(
    api({
      check: async () => {
        checks++;
        return release;
      },
      download: async () => {
        downloads++;
      },
      install: async () => {
        installs++;
      },
    }),
  );
  await updater.start();
  await updater.start();
  assert.equal(checks, 1);
  assert.equal(downloads, 0);
  assert.equal(installs, 0);
  assert.equal(updater.getSnapshot().phase, "available");
  const reloaded = new AppUpdater(
    api({
      info: async () => ({
        currentVersion: "0.4.0-beta.1",
        development: false,
        readyRelease: release,
      }),
      check: async () => {
        throw Error("Do not discard the staged update");
      },
    }),
  );
  await reloaded.start();
  assert.equal(reloaded.getSnapshot().phase, "ready");
  assert.equal(reloaded.getSnapshot().release?.version, release.version);
});

test("passive focus and long-running checks are throttled and leave ready downloads untouched", async () => {
  let now = 1000,
    checks = 0;
  const updater = new AppUpdater(
    api({
      check: async () => {
        checks++;
        return release;
      },
    }),
    () => now,
  );
  await updater.start();
  for (let i = 0; i < 4; i++) {
    now += 1000;
    await updater.poll();
  }
  assert.equal(checks, 1);
  now += 15 * 60_000;
  await updater.poll();
  assert.equal(checks, 2, "an app kept open must discover later releases");
  await updater.download();
  now += 15 * 60_000;
  await updater.poll();
  assert.equal(
    checks,
    2,
    "background checks must not discard a verified download",
  );
  assert.equal(updater.getSnapshot().phase, "ready");
});

test("a prior installation error stays visible without permanently stopping automatic discovery", async () => {
  let now = 1000,
    checks = 0;
  const updater = new AppUpdater(
    api({
      info: async () => ({
        currentVersion: "0.4.0-beta.1",
        development: false,
        previousError: "Installer could not open",
      }),
      check: async () => {
        checks++;
        if (checks === 1) throw Error("Temporarily offline");
        return release;
      },
    }),
    () => now,
  );
  await updater.start();
  assert.equal(
    checks,
    1,
    "a previous error must not prevent discovering a newer release on startup",
  );
  await updater.check();
  assert.equal(updater.getSnapshot().info?.previousError, undefined);
  now += 15 * 60000;
  await updater.poll();
  assert.equal(
    checks,
    3,
    "a recovered install error must not permanently disable update checks",
  );
});

test("opening Settings discovers a newly published release even inside the background throttle", async () => {
  let checks = 0;
  const updater = new AppUpdater(
    api({ check: async () => (++checks === 1 ? null : release) }),
  );
  await updater.start();
  assert.equal(updater.getSnapshot().phase, "current");
  await updater.openSettings();
  assert.equal(checks, 2);
  assert.equal(updater.getSnapshot().release?.version, release.version);
});

test("an installation failure keeps a verified native download ready for retry without downloading again", async () => {
  let downloads = 0,
    saved = false;
  const updater = new AppUpdater(
    api({
      info: async () => ({
        currentVersion: "0.4.0-beta.1",
        development: false,
        readyRelease: saved ? release : null,
      }),
      download: async () => {
        downloads++;
        saved = true;
      },
      install: async () => {
        throw Error("Installer could not start");
      },
    }),
  );
  await updater.check();
  await updater.download();
  await updater.requestRestart();
  assert.equal(updater.getSnapshot().phase, "ready");
  assert.match(updater.getSnapshot().error!, /could not start/);
  await updater.openSettings();
  await updater.download();
  assert.equal(downloads, 1);
});

test("one explicit restart click updates an idle workspace without another confirmation", async () => {
  let installs = 0;
  const updater = new AppUpdater(
    api({
      install: async () => {
        installs++;
      },
    }),
  );
  await updater.check();
  await updater.download();
  assert.equal(await updater.requestRestart(), true);
  assert.equal(installs, 1);
  assert.equal(updater.getSnapshot().phase, "installing");
  assert.equal(updater.getSnapshot().restartReview, undefined);
});

test("restart only requests review for running workers or terminal session loss", async () => {
  for (const context of [
    { activeWorkers: 1, activeTerminals: 0 },
    { activeWorkers: 0, activeTerminals: 2 },
  ]) {
    let installs = 0;
    const updater = new AppUpdater(
      api({
        context: async () => context,
        install: async () => {
          installs++;
        },
      }),
    );
    await updater.check();
    await updater.download();
    assert.equal(await updater.requestRestart(), false);
    assert.equal(installs, 0, "a header click must not close active sessions");
    assert.equal(updater.getSnapshot().phase, "ready");
    assert.deepEqual(updater.getSnapshot().restartReview, context);
    updater.dismissRestartReview();
    assert.equal(updater.getSnapshot().restartReview, undefined);
  }
});

test("a running worker can finish while an update downloads and cannot be interrupted by restart", async () => {
  let running = true,
    installs = 0;
  const updater = new AppUpdater(
    api({
      download: async () => {},
      install: async () => {
        if (running)
          throw Error(
            "Finish or stop the running worker before updating MemCode.",
          );
        installs++;
      },
    }),
  );
  await updater.check();
  await updater.download();
  assert.equal(updater.getSnapshot().phase, "ready");
  await updater.install();
  assert.equal(updater.getSnapshot().phase, "ready");
  assert.match(updater.getSnapshot().error!, /running worker/);
  assert.equal(installs, 0);
  running = false;
  await updater.install();
  assert.equal(installs, 1);
});

test("failed download verification never enables restart", async () => {
  let installs = 0;
  const updater = new AppUpdater(
    api({
      download: async () => {
        throw Error("Signature verification failed");
      },
      install: async () => {
        installs++;
      },
    }),
  );
  await updater.check();
  await updater.download();
  await updater.install();
  assert.equal(updater.getSnapshot().phase, "error");
  assert.match(updater.getSnapshot().error!, /Signature/);
  assert.equal(installs, 0);
});

test("final update reservation rechecks workers that started during download and never stops them", () => {
  const state = initialState(),
    task: WorkItem = {
      ...state.tasks[0],
      example: false,
      run: { state: "idle" },
    };
  state.tasks = [task];
  const gate = new AppUpdateGate(() => state);
  gate.preflight();
  task.run = { state: "running" };
  assert.throws(() => gate.reserve(), /running worker/);
  assert.equal(gate.preparing, false);
  assert.equal(task.run.state, "running");
  for (const stateName of ["preparing", "stopping"] as const) {
    task.run = { state: stateName };
    assert.throws(() => gate.reserve(), /running worker/);
  }
});

test("failed final persistence releases the update gate before new work is allowed", async () => {
  const state = initialState();
  state.tasks = [];
  const gate = new AppUpdateGate(() => state),
    handlers = new Map<string, (input?: unknown) => unknown>();
  let resumes = 0;
  registerAppUpdates(
    (name, _schema, handler) => handlers.set(name, handler),
    gate,
    async () => {
      assert.equal(gate.preparing, true);
      throw Error("Disk is full");
    },
    () => {
      resumes++;
    },
  );
  await assert.rejects(
    Promise.resolve(handlers.get("app:update-prepare")!()),
    /Disk is full/,
  );
  assert.equal(gate.preparing, false);
  assert.equal(resumes, 1);
  assert.doesNotThrow(() => gate.assertMayStart());
});

for (const harness of ["claude", "codex", "cursor"] as Harness[]) {
  test(`${harness}: an update reservation blocks direct starts and preserves queued follow-ups until release`, async () => {
    const state = initialState(),
      task: WorkItem = {
        ...state.tasks[0],
        id: "update-story",
        projectId: "update-project",
        example: false,
        harness,
        assignment: "auto",
        stage: "planned",
        run: { state: "idle" },
        messages: [
          {
            id: "followup",
            role: "user",
            text: "Continue this task",
            at: "2026-11-16",
          },
        ],
      };
    const project: Project = {
      id: task.projectId,
      name: "Update fixture",
      path: process.cwd(),
      branch: "main",
      description: "No model runs",
      analysis: "ready",
      repoId: "fixture",
      createdAt: "2026-11-16",
    };
    state.tasks = [task];
    state.projects = [project];
    state.epics = [];
    state.fleetConflicts = [];
    const gate = new AppUpdateGate(() => state);
    let reachedStart = 0,
      engineCalls = 0;
    const manager = new WorkerManager(
      () => state,
      async () => {},
      {
        call: async () => {
          engineCalls++;
          return {};
        },
      } as unknown as MemtraceEngine,
      process.cwd(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        gate.assertMayStart();
        reachedStart++;
        throw Error("Fixture reached the start boundary");
      },
      () => !gate.preparing,
    );
    try {
      gate.reserve();
      await assert.rejects(
        manager.start(task, project),
        /preparing an app update/,
      );
      manager.enqueue(task, "followup");
      manager.dispatchQueued();
      await tick();
      const followupState = () => task.messages[0].followupState;
      assert.equal(followupState(), "queued");
      assert.equal(reachedStart, 0);
      assert.equal(engineCalls, 0);
      gate.release();
      manager.dispatchQueued();
      for (
        let attempt = 0;
        attempt < 100 && followupState() !== "paused";
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(reachedStart, 1);
      assert.equal(followupState(), "paused");
      assert.equal(engineCalls, 0);
    } finally {
      await manager.close();
    }
  });
}
