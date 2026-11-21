import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

export async function verifyPlanning(page, call, out) {
  const loaded = await call("workspace:load");
  const project = loaded.state.projects.find(
    (project) => project.id === loaded.state.activeProjectId,
  );
  const cycleInput = {
    projectId: project.id,
    name: "Native smoke cycle",
    goal: "Verify local planning",
    startDate: "2026-11-14",
    endDate: "2026-11-27",
    timeZone: "Europe/Copenhagen",
    capacity: 13,
    calendar: "weekdays",
  };
  const cycle = await call("cycle:create", cycleInput);
  const next = await call("cycle:create", {
    ...cycleInput,
    name: "Native carryover target",
    startDate: "2026-11-30",
    endDate: "2026-12-11",
  });
  const input = {
    projectId: project.id,
    title: "Native smoke parent",
    description: "Keep the child and planning evidence together.",
    harness: "codex",
    assignment: "auto",
    priority: "medium",
    cycleId: cycle.id,
    estimate: 5,
    labels: ["native-smoke"],
    startDate: "2026-11-14",
    dueDate: "2026-11-20",
  };
  const parent = await call("task:create", input);
  const child = await call("task:create", {
    ...input,
    title: "Native smoke child",
    parentId: parent.id,
    estimate: 3,
  });
  const carry = await call("task:create", {
    ...input,
    title: "Native smoke unfinished",
    estimate: null,
  });
  await call("cycle:start", cycle.id);
  await assert.rejects(
    call("task:update", { id: parent.id, patch: { stage: "done" } }),
    /Complete the subtasks/,
  );
  await call("task:bulk-update", {
    ids: [parent.id, child.id],
    patch: { stage: "done" },
  });
  await page.locator("nav button").filter({ hasText: "Cycles" }).click();
  await expect(
    page.getByRole("heading", { name: "Native smoke cycle", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: join(out, "native-cycles.png"),
    animations: "disabled",
  });
  await call("cycle:complete", { id: cycle.id, targetCycleId: next.id });
  let state = (await call("workspace:load")).state;
  const closing = state.cycles
    .find((item) => item.id === cycle.id)
    .snapshots.at(-1);
  assert.deepEqual(
    [
      closing.total,
      closing.completed,
      closing.points,
      closing.completedPoints,
      closing.unestimated,
    ],
    [3, 2, 8, 8, 1],
  );
  assert.equal(
    state.tasks.find((task) => task.id === carry.id).cycleId,
    next.id,
  );
  await call("task:update", { id: parent.id, patch: { stage: "review" } });
  await call("task:update", {
    id: child.id,
    patch: { stage: "review", statusId: `${project.id}:review`, estimate: 8 },
  });
  state = (await call("workspace:load")).state;
  assert.deepEqual(
    state.cycles.find((item) => item.id === cycle.id).snapshots.at(-1),
    closing,
  );
  const saved = await call("view:save", {
    projectId: project.id,
    name: "Native smoke saved view",
    mode: "list",
    groupBy: "cycle",
    sortBy: "due",
    filters: {
      query: "",
      priority: "all",
      epicId: "all",
      cycleId: "all",
      label: "native-smoke",
      kind: "all",
      harness: "all",
      archived: false,
    },
  });
  assert.ok(
    (await call("workspace:load")).state.savedViews.some(
      (view) => view.id === saved.id,
    ),
  );
  await call("view:delete", saved.id);

  await call("task:update", { id: carry.id, patch: { dependsOn: [child.id] } });
  await page.getByRole("button", { name: /Native carryover target/ }).click();
  const carryRow = page
    .locator(".cycle-story-table tr")
    .filter({ hasText: carry.title });
  const outsideStory = carryRow.getByRole("button", {
    name: new RegExp(child.identifier),
  });
  await expect(outsideStory).toContainText(child.title);
  await expect(outsideStory).toContainText("Outside this cycle");
  await outsideStory.click();
  await expect(page.locator("#detail-title")).toHaveText(child.title);
  await page.getByRole("button", { name: "Close work item" }).click();
  await page.locator("nav button").filter({ hasText: "Workspace" }).click();
  await expect(page.locator(".work-board")).toBeVisible();
  const carryCard = page.getByRole("button", {
    name: `${carry.identifier}: ${carry.title}`,
    exact: true,
  });
  await carryCard.click();
  const blockers = page.getByRole("region", { name: "Worker prerequisites" });
  const dependency = blockers.getByRole("button", {
    name: new RegExp(child.identifier),
  });
  await expect(dependency).toContainText(child.title);
  await expect(dependency).toContainText("Ready for acceptance");
  await expect(
    page.getByRole("button", { name: "Start worker", exact: true }),
  ).toBeDisabled();
  await dependency.click();
  await expect(page.locator("#detail-title")).toHaveText(child.title);
  await page.getByRole("button", { name: "Close work item" }).click();
  await carryCard.click();
  await blockers.getByRole("button", { name: "Edit prerequisites" }).click();
  const editor = page.getByRole("group", { name: "Edit task prerequisites" });
  await expect(editor).toBeFocused();
  await editor
    .getByRole("button", { name: "Remove prerequisite", exact: true })
    .click();
  await expect(blockers).toHaveCount(0);
  await page.getByRole("button", { name: "Close work item" }).click();
  const heading = page.locator(".work-card h4").first();
  assert.equal(
    await heading.evaluate((element) => getComputedStyle(element).fontSize),
    "14px",
  );
  assert.equal(
    await page
      .locator(".card-description")
      .first()
      .evaluate((element) => getComputedStyle(element).webkitLineClamp),
    "2",
  );
  await expect(page.locator(".work-card").first()).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    const board = document.querySelector(".work-board");
    await Promise.all(
      (board?.getAnimations({ subtree: true }) ?? [])
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const lane = page.locator(".column-cards").first();
  const before = await page.evaluate(() => ({
    view: document.querySelector(".workspace-scroll").scrollTop,
    heading: document.querySelector(".column-heading").getBoundingClientRect()
      .top,
    done: [...document.querySelectorAll(".column-cards")].at(-1).scrollTop,
  }));
  await lane.hover();
  await page.mouse.wheel(0, 650);
  await expect
    .poll(() => lane.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const after = await page.evaluate(() => ({
    view: document.querySelector(".workspace-scroll").scrollTop,
    heading: document.querySelector(".column-heading").getBoundingClientRect()
      .top,
    done: [...document.querySelectorAll(".column-cards")].at(-1).scrollTop,
  }));
  assert.deepEqual(after, before);
  await lane.evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({
    path: join(out, "native-workspace.png"),
    animations: "disabled",
  });

  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(page.locator(".planning-row").first()).toBeVisible();
  await page.screenshot({
    path: join(out, "native-list.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Calendar view", exact: true })
    .click();
  await expect(page.locator(".calendar-day")).toHaveCount(42);
  await page.screenshot({
    path: join(out, "native-calendar.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Timeline view", exact: true })
    .click();
  await expect(page.locator(".timeline-row")).toHaveCount(3);
  await page.screenshot({
    path: join(out, "native-timeline.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await page
    .getByRole("checkbox", { name: `Select ${parent.identifier}`, exact: true })
    .check();
  await page
    .getByRole("combobox", { name: "Bulk action", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Priority: high", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await call("workspace:load")).state.tasks.find(
          (task) => task.id === parent.id,
        ).priority,
    )
    .toBe("high");
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await page
    .getByRole("textbox", { name: "View name", exact: true })
    .fill("Native UI saved view");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save view", exact: true })
    .click();
  await expect(
    page
      .locator(".workspace-saved-views")
      .getByRole("button", { name: "Native UI saved view", exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 1180, height: 820 });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const board = document
          .querySelector(".work-board")
          .getBoundingClientRect();
        const workspace = document
          .querySelector(".workspace-scroll")
          .getBoundingClientRect();
        return [...document.querySelectorAll(".column-cards")].every(
          (element) => {
            const bounds = element.getBoundingClientRect();
            return (
              bounds.height > 0 &&
              bounds.top >= Math.max(board.top, workspace.top) - 1 &&
              bounds.bottom <=
                Math.min(board.bottom, workspace.bottom, innerHeight) + 1
            );
          },
        );
      }),
    )
    .toBe(true);
  const compactBefore = await page.evaluate(() => ({
    workspace: document.querySelector(".workspace-scroll").scrollTop,
    pageTop: document.scrollingElement.scrollTop,
    pageLeft: document.scrollingElement.scrollLeft,
    headings: [...document.querySelectorAll(".column-heading")].map(
      (element) => element.getBoundingClientRect().top,
    ),
    lanes: [...document.querySelectorAll(".column-cards")].map((element) => ({
      top: element.scrollTop,
      height: element.clientHeight,
      extent: element.scrollHeight,
    })),
    horizontalOverflow: document.scrollingElement.scrollWidth > innerWidth + 1,
  }));
  assert.equal(
    compactBefore.horizontalOverflow,
    false,
    "Compact workspace must not overflow the page horizontally",
  );
  const overflowing = compactBefore.lanes.findIndex(
    (item) => item.extent > item.height + 1,
  );
  assert.ok(
    overflowing >= 0,
    "The populated compact fixture must exercise lane overflow",
  );
  const compactLane = page.locator(".column-cards").nth(overflowing);
  await compactLane.hover();
  await page.mouse.wheel(0, compactBefore.lanes[overflowing].extent + 1000);
  await expect
    .poll(() =>
      compactLane.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
  const last = compactLane.locator(".work-card").last();
  const lastBounds = await last.boundingBox(),
    laneBounds = await compactLane.boundingBox();
  assert.ok(
    lastBounds &&
      laneBounds &&
      lastBounds.y >= laneBounds.y - 1 &&
      lastBounds.y + lastBounds.height <= laneBounds.y + laneBounds.height + 1,
    "Last card must be fully reachable inside its lane",
  );
  await page.mouse.wheel(0, 650);
  const compactAfter = await page.evaluate(() => ({
    workspace: document.querySelector(".workspace-scroll").scrollTop,
    pageTop: document.scrollingElement.scrollTop,
    pageLeft: document.scrollingElement.scrollLeft,
    headings: [...document.querySelectorAll(".column-heading")].map(
      (element) => element.getBoundingClientRect().top,
    ),
    lanes: [...document.querySelectorAll(".column-cards")].map(
      (element) => element.scrollTop,
    ),
    horizontalOverflow: document.scrollingElement.scrollWidth > innerWidth + 1,
  }));
  assert.deepEqual(
    {
      workspace: compactAfter.workspace,
      pageTop: compactAfter.pageTop,
      pageLeft: compactAfter.pageLeft,
      headings: compactAfter.headings,
    },
    {
      workspace: compactBefore.workspace,
      pageTop: compactBefore.pageTop,
      pageLeft: compactBefore.pageLeft,
      headings: compactBefore.headings,
    },
    "Lane scrolling must preserve page position and lane headings",
  );
  compactAfter.lanes.forEach((top, index) => {
    if (index !== overflowing)
      assert.equal(
        top,
        compactBefore.lanes[index].top,
        "Scrolling one lane must preserve other lanes",
      );
  });
  assert.equal(compactAfter.horizontalOverflow, false);
  await writeFile(
    join(out, "native-compact-lanes.json"),
    JSON.stringify(
      {
        viewport: { width: 1180, height: 820 },
        lane: overflowing,
        laneHeight: compactBefore.lanes[overflowing].height,
        lastCardReachable: true,
        independentScrolling: true,
        pageStayedStill: true,
        horizontalPageOverflow: false,
        before: compactBefore,
        after: compactAfter,
      },
      null,
      2,
    ),
  );
  await page.screenshot({
    path: join(out, "native-workspace-compact.png"),
    animations: "disabled",
  });
  await compactLane.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.setViewportSize({ width: 1512, height: 1000 });

  await page.locator("nav button").filter({ hasText: "Conversations" }).click();
  await page
    .getByRole("button", { name: "Conversation table", exact: true })
    .click();
  await expect(page.locator(".conversation-table")).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search conversations" })
    .fill(parent.identifier);
  await expect(page.locator(".conversation-table tbody tr")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search conversations" }).fill("");
  const tableViewport = page.locator(".conversation-table-wrap");
  await expect
    .poll(() =>
      tableViewport.evaluate(
        (element) =>
          element.clientHeight > 0 && element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  await tableViewport.hover();
  const conversationHeader = await page
    .locator(".conversation-table th")
    .first()
    .boundingBox();
  const workspaceScroll = await page
    .locator(".workspace-scroll")
    .evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() =>
      page
        .locator(".conversation-table-wrap")
        .evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(0);
  assert.equal(
    await page
      .locator(".workspace-scroll")
      .evaluate((element) => element.scrollTop),
    workspaceScroll,
  );
  assert.equal(
    (await page.locator(".conversation-table th").first().boundingBox()).y,
    conversationHeader.y,
  );
  await page
    .locator(".conversation-table-wrap")
    .evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({
    path: join(out, "native-conversations-table.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Conversation cards", exact: true })
    .click();
  await expect(page.locator(".conversation-card").first()).toBeVisible();
  await page.locator("nav button").filter({ hasText: "Insights" }).click();
  await expect(
    page.getByRole("tab", { name: "Code intelligence", exact: true }),
  ).toHaveCSS("display", "flex");
  await page
    .getByRole("tab", { name: "Code intelligence", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Delivery", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Delivery", exact: true }).click();
  await page.screenshot({
    path: join(out, "native-delivery-insights.png"),
    animations: "disabled",
  });
  await page.locator("nav button").filter({ hasText: "Improve" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Better code, with evidence.",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: join(out, "native-improve.png"),
    animations: "disabled",
  });
  assert.ok(
    (await call("workspace:load")).state.tasks.every(
      (task) => !["preparing", "running"].includes(task.run.state),
    ),
  );
  console.log(
    "Native planning: cycles, carryover, frozen history, bulk validation, saved views, card styles, independent lanes and insights passed.",
  );
}
