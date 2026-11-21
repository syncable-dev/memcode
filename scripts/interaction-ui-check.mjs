// Explicitly run with --execute only after the current native build is ready.
// Reuses the labelled onboarding QA window; never launches or touches the demo.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const samePath = (a, b) =>
  resolve(a).toLowerCase() === resolve(b).toLowerCase();
const active = (task) =>
  ["preparing", "running", "stopping"].includes(task?.run.state);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const click = (locator) => locator.evaluate((element) => element.click());

export async function assertNodeVersionCommand(details, nodePath, shells) {
  let command = details.split(/\r?\n/)[0].trim();
  for (let i = 0; i < 2; i++)
    command = command.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  const unquote = (token) => (/^["']/.test(token) ? token.slice(1, -1) : token);
  const wrapper =
    /^("[^"\r\n]+"|'[^'\r\n]+'|[^\s]+)\s+(?:(?:-NoLogo|-NoProfile|-NonInteractive)\s+)*-Command\s+(.+)$/i.exec(
      command,
    );
  if (wrapper) {
    const shell = unquote(wrapper[1]);
    assert.ok(
      isAbsolute(shell),
      "PowerShell wrapper must be an installed absolute path",
    );
    const resolvedShell = await realpath(shell);
    assert.ok(
      shells.some((allowed) => samePath(allowed, resolvedShell)),
      "Only a known installed PowerShell wrapper is allowed",
    );
    command = wrapper[2].trim();
    if (command.startsWith('"') && command.endsWith('"'))
      command = command.slice(1, -1).trim();
  }
  const invocation =
    /^&?\s*("[^"\r\n]+"|'[^'\r\n]+'|[^\s"']+)\s+--version$/i.exec(command);
  assert.ok(
    invocation,
    "Only one installed Node executable with --version is allowed: " + command,
  );
  const program = unquote(invocation[1]);
  assert.ok(
    isAbsolute(program),
    "Node must be the exact installed absolute path",
  );
  assert.ok(
    samePath(await realpath(program), nodePath),
    "Only the known installed Node executable is allowed",
  );
}

export async function onboardingContext() {
  const input = resolve("../tmp/memcode-onboarding/results.json");
  const report = JSON.parse(await readFile(input, "utf8"));
  assert.equal(
    report.result,
    "passed",
    "Run onboarding-smoke successfully first",
  );
  assert.ok(
    Number.isInteger(report.port) && report.port > 1024 && report.port < 65536,
  );
  assert.notEqual(report.port, 9329, "The user's main inspector is forbidden");
  const profile = await realpath(report.profile),
    root = await realpath(report.root);
  assert.ok(/^memcode-onboarding-[a-zA-Z0-9]+$/.test(basename(profile)));
  assert.ok(
    samePath(dirname(profile), await realpath(tmpdir())),
    "Only a direct onboarding QA temp profile is allowed",
  );
  assert.ok(
    samePath(root, join(profile, "MemCode Studio")),
    "Only the labelled onboarding Git fixture is allowed",
  );
  assert.ok(report.projectId);
  const shells = (
    await Promise.all(
      [
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        join(
          process.env.ProgramFiles ?? "C:\\Program Files",
          "PowerShell",
          "7",
          "pwsh.exe",
        ),
      ].map((path) => realpath(path).catch(() => null)),
    )
  ).filter(Boolean);
  return {
    ...report,
    profile,
    root,
    nodePath: await realpath(process.execPath),
    shells,
    out: resolve("../tmp/memcode-interaction-ui"),
  };
}

export async function verifyInteraction(page, context) {
  assert.notEqual(context.port, 9329);
  assert.ok(
    /^memcode-onboarding-[a-zA-Z0-9]+$/.test(basename(context.profile)),
  );
  assert.ok(samePath(context.root, join(context.profile, "MemCode Studio")));
  assert.ok(samePath(dirname(context.profile), await realpath(tmpdir())));
  await mkdir(context.out, { recursive: true });
  const report = {
    profile: context.profile,
    root: context.root,
    port: context.port,
    projectId: context.projectId,
    startedAt: new Date().toISOString(),
    result: "running",
    checks: [],
  };
  const call = (method, ...args) =>
    page.evaluate(({ method, args }) => window.memcode[method](...args), {
      method,
      args,
    });
  const load = async () => (await call("load")).state;
  const snap = (name) =>
    page.screenshot({
      path: join(context.out, name + ".png"),
      animations: "disabled",
    });
  const closeStory = async () => {
    const close = page.getByRole("button", {
      name: "Close work item",
      exact: true,
    });
    if (await close.count()) await click(close);
  };
  const openStory = async (story) => {
    await closeStory();
    await click(
      page.getByRole("button", { name: "Conversations", exact: true }),
    );
    const entry = page
      .locator(".conversation-card, .conversation-title")
      .filter({ hasText: story.title })
      .first();
    await expect(entry).toBeVisible();
    await click(entry);
    await expect(page.locator(".work-detail")).toContainText(story.title);
  };
  const confirmDelete = async (kind, screenshot) => {
    const modal = page.getByRole("dialog", {
      name: `Delete this ${kind}?`,
      exact: true,
    });
    await expect(modal).toBeVisible();
    if (screenshot) await snap(screenshot);
    await click(
      modal.getByRole("button", { name: `Delete ${kind}`, exact: true }),
    );
    await expect(modal).toHaveCount(0);
  };
  let interactive;
  try {
    await page.waitForFunction(() => !!window.memcode);
    const loaded = await call("load");
    assert.ok(
      samePath(loaded.runtime.dataPath, context.profile),
      "Inspector must belong to the QA profile before any mutation",
    );
    const project = loaded.state.projects.find(
      (item) => item.id === context.projectId,
    );
    assert.ok(
      project &&
        !project.example &&
        project.path &&
        samePath(project.path, context.root),
    );
    assert.ok(
      loaded.state.workerConnections?.codex,
      "QA Codex must have been explicitly approved in onboarding",
    );
    assert.ok(
      !loaded.state.tasks.some(active),
      "QA must have no other active workers",
    );
    assert.ok(
      loaded.state.projects.some((item) => item.example),
      "Keep example data intact",
    );
    await page.evaluate(() => {
      for (const method of [
        "respondToWorker",
        "deleteStory",
        "deleteEpic",
        "deleteCycle",
      ])
        if (typeof window.memcode[method] !== "function")
          throw Error("The new native UI build is not loaded: " + method);
    });
    await call("selectProject", project.id);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await closeStory();
    const beforeReadme = await readFile(join(context.root, "README.md"));
    const beforeIndex = await readFile(join(context.root, "index.ts"));
    report.sourceBefore = {
      readme: hash(beforeReadme),
      index: hash(beforeIndex),
    };
    const tag = Date.now().toString(36);
    if (!context.deletionsOnly) {
      const nodeCommand = `& '${context.nodePath.replaceAll("'", "''")}' --version`;
      const description = [
        "This is one bounded native interaction QA turn. Do not edit, create or delete any source files. Do not use browsers, servers, search, or source exploration.",
        "FIRST call the native request_user_input tool exactly once. Ask one single-choice question: Which color should the demo use? The options must be Green and Blue. Wait for the human answer. Do not infer it or skip the native tool.",
        `SECOND call native exec_command exactly once with sandbox_permissions=require_escalated and cmd EXACTLY ${JSON.stringify(nodeCommand)}. Include a short justification asking to check the installed Node version. Wait for the human approval. No other commands, compound commands, writes or retries.`,
        "THIRD report the selected color and observed Node version, ending with QA_COMPLETE_GREEN if Green was selected. Do not run more tools. Do not perform any edits, even if the normal work-item checklist mentions implementation.",
      ].join("\n\n");
      interactive = await call("createTask", {
        projectId: project.id,
        title: "QA · native questions and approvals · " + tag,
        description,
        priority: "medium",
        harness: "codex",
        assignment: "manual",
        kind: "test",
      });
      report.interactionStoryId = interactive.id;
      await call("updateTask", interactive.id, { modelOverride: "gpt-6-luna" });
      await openStory(interactive);
      const start = page
        .locator(".work-detail")
        .getByRole("button", { name: "Start worker", exact: true });
      await expect(start).toBeEnabled({ timeout: 30000 });
      await click(start);
      const pendingFor = (state, kind) =>
        (state.workerInputs ?? []).filter(
          (request) =>
            request.taskId === interactive.id &&
            request.status === "pending" &&
            (!kind || request.kind === kind),
        );
      let question;
      await expect
        .poll(
          async () => {
            const state = await load();
            const task = state.tasks.find((item) => item.id === interactive.id);
            if (
              ["failed", "blocked", "stopped", "finished"].includes(
                task.run.state,
              )
            )
              throw Error(
                "Worker ended before its native question: " +
                  task.run.state +
                  ": " +
                  (task.run.error ?? task.messages.at(-1)?.text),
              );
            question = pendingFor(state, "question")[0];
            return !!question;
          },
          { timeout: 120000, intervals: [250] },
        )
        .toBeTruthy();
      assert.equal(question.harness, "codex");
      assert.equal(question.questions.length, 1);
      assert.deepEqual(
        question.questions[0].options
          .map((option) => option.label.replace(/\s*\(Recommended\)$/i, ""))
          .sort(),
        ["Blue", "Green"],
      );
      const initialTask = (await load()).tasks.find(
        (task) => task.id === interactive.id,
      );
      const sessionId = initialTask.run.sessionId,
        startedAt = initialTask.run.startedAt;
      assert.ok(sessionId);
      const questionPanel = page.locator(
        `[data-worker-input-id="${question.id}"]`,
      );
      await expect(questionPanel).toBeVisible();
      await expect(
        questionPanel.getByRole("button", { name: "Send answer", exact: true }),
      ).toBeDisabled();
      await questionPanel
        .getByRole("radio", { name: /^Green(?:\s|$)/ })
        .check();
      await snap("question-selected");
      await click(
        questionPanel.getByRole("button", { name: "Send answer", exact: true }),
      );
      let approval;
      await expect
        .poll(
          async () => {
            const state = await load();
            approval = pendingFor(state, "approval")[0];
            const task = state.tasks.find((task) => task.id === interactive.id);
            if (
              ["failed", "blocked", "stopped", "finished"].includes(
                task.run.state,
              )
            )
              throw Error(
                "Worker ended before approval: " +
                  task.run.state +
                  ": " +
                  (task.run.error ?? task.messages.at(-1)?.text),
              );
            return !!approval;
          },
          { timeout: 60000, intervals: [250] },
        )
        .toBeTruthy();
      assert.equal(
        approval.runId,
        question.runId,
        "The question and approval must belong to the same run",
      );
      assert.equal(approval.toolName, "commandExecution");
      await assertNodeVersionCommand(
        approval.details,
        context.nodePath,
        context.shells,
      );
      const beforeAllow = (await load()).tasks.find(
        (task) => task.id === interactive.id,
      );
      assert.equal(beforeAllow.run.sessionId, sessionId);
      assert.equal(beforeAllow.run.startedAt, startedAt);
      assert.ok(
        !beforeAllow.messages.some(
          (message) =>
            message.role === "tool" &&
            /^v\d+\.\d+\.\d+\s*$/m.test(message.text),
        ),
        "Node must not have completed before its approval",
      );
      const approvalPanel = page.locator(
        `[data-worker-input-id="${approval.id}"]`,
      );
      await expect(approvalPanel).toBeVisible();
      await approvalPanel.locator("details").evaluate((element) => {
        element.open = true;
      });
      await expect(approvalPanel.locator("pre")).toContainText("--version");
      await snap("approval-details");
      await click(
        approvalPanel.getByRole("button", { name: "Allow once", exact: true }),
      );
      let finished;
      await expect
        .poll(
          async () => {
            const state = await load();
            finished = state.tasks.find((task) => task.id === interactive.id);
            assert.equal(
              pendingFor(state).filter((request) => request.id !== approval.id)
                .length,
              0,
              "This one-turn test must not ask for further permissions",
            );
            if (["failed", "blocked", "stopped"].includes(finished.run.state))
              throw Error(finished.run.error ?? finished.run.state);
            return finished.run.state;
          },
          { timeout: 60000, intervals: [250] },
        )
        .toBe("finished");
      assert.equal(finished.run.exitCode, 0);
      assert.equal(finished.run.sessionId, sessionId);
      assert.equal(finished.run.startedAt, startedAt);
      assert.match(
        finished.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.text)
          .join("\n"),
        /QA_COMPLETE_GREEN/,
      );
      const finalInputs = (await load()).workerInputs.filter(
        (request) => request.taskId === interactive.id,
      );
      assert.equal(
        finalInputs.filter(
          (request) =>
            request.kind === "question" && request.status === "answered",
        ).length,
        1,
      );
      assert.equal(
        finalInputs.filter(
          (request) =>
            request.kind === "approval" && request.status === "answered",
        ).length,
        1,
      );
      report.interaction = {
        sessionId,
        runId: question.runId,
        questionId: question.id,
        approvalId: approval.id,
        selected: "Green",
        command: nodeCommand,
        exitCode: finished.run.exitCode,
      };
      await snap("interaction-complete");
      report.checks.push(
        "Actual Codex native question and approval answered in the card UI; same session resumed and exited zero",
      );
      assert.equal(
        hash(await readFile(join(context.root, "README.md"))),
        report.sourceBefore.readme,
      );
      assert.equal(
        hash(await readFile(join(context.root, "index.ts"))),
        report.sourceBefore.index,
      );
      if (context.interactionOnly) {
        report.result = "passed";
        return report;
      }
    }

    await closeStory();
    const epic = await call("createEpic", {
      projectId: project.id,
      title: "QA · delete epic · " + tag,
      description: "Metadata-only deletion fixture",
      phase: "now",
    });
    const today = new Date().toISOString().slice(0, 10),
      nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const cycle = await call("createCycle", {
      projectId: project.id,
      name: "QA · delete cycle · " + tag,
      goal: "Return stories to backlog on deletion",
      startDate: today,
      endDate: nextWeek,
      timeZone: "Europe/Copenhagen",
      capacity: 3,
      calendar: "weekdays",
    });
    const leaf = await call("createTask", {
      projectId: project.id,
      title: "QA · delete leaf story · " + tag,
      description: "This fixture is never assigned a running worker.",
      priority: "low",
      harness: "codex",
      assignment: "manual",
      epicId: epic.id,
      cycleId: cycle.id,
    });
    const comment = await call(
      "addStoryComment",
      leaf.id,
      "A separate discussion note to remove with this fixture.",
    );
    const note = await call("saveReviewComment", {
      taskId: leaf.id,
      text: "A saved local review note",
      reference: {
        kind: "conversation",
        taskId: leaf.id,
        name: leaf.title,
        quote: "This fixture is never assigned a running worker.",
      },
    });
    report.deletionFixtures = {
      epicId: epic.id,
      cycleId: cycle.id,
      storyId: leaf.id,
      commentId: comment.id,
      reviewId: note.id,
    };
    await click(page.getByRole("button", { name: /^Roadmap(?:\s+\d+)?$/ }));
    const epicCard = page.locator(".epic-card").filter({ hasText: epic.title });
    await click(
      epicCard.getByRole("button", { name: "Delete goal", exact: true }),
    );
    await confirmDelete("epic", "delete-epic");
    let state = await load(),
      remaining = state.tasks.find((task) => task.id === leaf.id);
    assert.ok(!state.epics.some((item) => item.id === epic.id));
    assert.equal(
      state.epics.find((item) => item.id === remaining.epicId)?.title,
      "Project work",
    );
    assert.equal(remaining.cycleId, cycle.id);
    report.checks.push("Epic Delete UI preserves its stories in Project work");
    await click(page.getByRole("button", { name: /^Cycles(?:\s+\d+)?$/ }));
    await click(
      page.locator(".cycle-rail-item").filter({ hasText: cycle.name }),
    );
    await click(
      page.getByRole("button", { name: "Delete cycle", exact: true }),
    );
    await confirmDelete("cycle", "delete-cycle");
    state = await load();
    remaining = state.tasks.find((task) => task.id === leaf.id);
    assert.ok(!state.cycles.some((item) => item.id === cycle.id));
    assert.equal(remaining.cycleId, null);
    assert.equal(remaining.run.state, "idle");
    report.checks.push("Cycle Delete UI preserves its stories in the backlog");
    await openStory(leaf);
    await click(
      page
        .locator(".work-detail")
        .getByRole("button", { name: "Delete task", exact: true }),
    );
    let deletionModal = page.getByRole("dialog", {
      name: "Delete this story?",
      exact: true,
    });
    await click(
      deletionModal.getByRole("button", { name: "Keep task", exact: true }),
    );
    assert.ok((await load()).tasks.some((task) => task.id === leaf.id));
    await click(
      page
        .locator(".work-detail")
        .getByRole("button", { name: "Delete task", exact: true }),
    );
    await confirmDelete("story", "delete-story");
    state = await load();
    assert.ok(!state.tasks.some((task) => task.id === leaf.id));
    assert.ok(!state.storyComments.some((item) => item.taskId === leaf.id));
    assert.ok(!state.reviewComments.some((item) => item.taskId === leaf.id));
    assert.ok(!state.planning.events.some((item) => item.taskId === leaf.id));
    assert.equal(state.planning.observations[leaf.id], undefined);
    assert.ok(state.projects.some((item) => item.example));
    assert.equal(
      hash(await readFile(join(context.root, "README.md"))),
      report.sourceBefore.readme,
    );
    assert.equal(
      hash(await readFile(join(context.root, "index.ts"))),
      report.sourceBefore.index,
    );
    report.checks.push(
      "Leaf Delete UI removes discussion, review and planning metadata; Keep cancels; source files remain byte-identical",
    );
    await click(page.getByRole("button", { name: "Workspace", exact: true }));
    await snap("deletions-complete");
    report.result = "passed";
  } catch (error) {
    report.result = "failed";
    report.error = error.stack ?? String(error);
    await snap("failure").catch(() => {});
    if (interactive) {
      const task = (await load().catch(() => ({ tasks: [] }))).tasks.find(
        (task) => task.id === interactive.id,
      );
      if (active(task))
        await call("stopWorker", interactive.id).catch(() => {});
    }
  } finally {
    report.completedAt = new Date().toISOString();
    await writeFile(
      join(context.out, "results.json"),
      JSON.stringify(report, null, 2),
    );
    await writeFile(
      join(
        context.out,
        "attempt-" + report.startedAt.replace(/[:.]/g, "-") + ".json",
      ),
      JSON.stringify(report, null, 2),
    );
  }
  return report;
}

async function run() {
  const context = await onboardingContext();
  context.deletionsOnly = process.argv.includes("--deletions-only");
  context.interactionOnly = process.argv.includes("--interaction-only");
  const browser = await chromium.connectOverCDP(
    "http://127.0.0.1:" + context.port,
    { timeout: 10000 },
  );
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().includes("tauri.localhost"));
  assert.ok(page, "The separate onboarding QA window must already be open");
  const report = await verifyInteraction(page, context);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.result === "passed" ? 0 : 1);
}
if (
  process.argv[1] &&
  samePath(fileURLToPath(import.meta.url), process.argv[1])
) {
  if (!process.argv.includes("--execute"))
    console.log(
      "Prepared. Run with --execute only after the new native build and onboarding QA are ready.",
    );
  else await run();
}
