import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.MEMCODE_DEMO_URL ?? 'http://127.0.0.1:5207/assets/memcode/demo/index.html';
const output = '.memcode/verification/website-demo';
const desktop = { width: 1512, height: 1000 };
const title = 'Keep focus in the mobile menu';
const brief = 'Return focus to the menu button when a reader closes the navigation with Escape.';
const question = 'Where does focus go when I press Escape?';
const checks = [];
const errors = [];
const externalRequests = [];
await mkdir(output, { recursive: true });
const executablePath = process.env.MEMCODE_BROWSER_EXECUTABLE;
const browser = await chromium.launch({
  executablePath,
  channel: process.platform === 'win32' && !executablePath ? 'msedge' : undefined,
  headless: true,
});

function observe(page) {
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(base).origin)
      externalRequests.push(request.url());
  });
}

// The public site sends commands from a same-origin parent, not from inside
// the renderer. Model that boundary without coupling this test to marketing copy.
async function embeddedTour(options) {
  const page = await browser.newPage(options);
  observe(page);
  const host = new URL('__memcode-guide-smoke__', base).href;
  const embeddedUrl = new URL(base);
  embeddedUrl.searchParams.set('embed', '1');
  await page.route(host, route => route.fulfill({
    contentType: 'text/html',
    body: '<meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0}iframe{display:block;border:0;width:100vw;height:100vh}</style><iframe title="MemCode example" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>',
  }));
  await page.exposeFunction('recordGuideError', step => errors.push('Guide failed to open ' + step));
  await page.goto(host);
  await page.evaluate(url => {
    const iframe = document.querySelector('iframe');
    window.addEventListener('message', event => {
      if (event.source !== iframe.contentWindow || event.origin !== location.origin) return;
      if (event.data?.type !== 'memcode-demo:event') return;
      if (event.data.event === 'ready') iframe.dataset.ready = 'true';
      if (event.data.event === 'guide-error') window.recordGuideError(event.data.step);
    });
    iframe.src = url;
  }, embeddedUrl.href);
  await expect(page.locator('iframe')).toHaveAttribute('data-ready', 'true');
  const frame = page.frameLocator('iframe');
  const guide = step => page.locator('iframe').evaluate((iframe, step) => {
    iframe.contentWindow.postMessage({ type: 'memcode-demo:guide', step }, location.origin);
  }, step);
  return { page, frame, guide };
}

async function checkReview(frame) {
  const review = frame.locator('.code-review-workspace');
  await expect(review).toBeVisible();
  const finding = review.getByRole('checkbox', { name: /^Select finding:/ }).first();
  await expect(finding).toBeVisible();
  await expect(review.locator('.code-review-finding-title').first()).toHaveAttribute('aria-expanded', 'true');
  const comparison = review.locator('.review-comparison-grid').first();
  for (const metric of ['Maintainability', 'Cognitive complexity', 'Cyclomatic complexity', 'Nesting depth']) {
    const values = comparison.getByRole('group', { name: metric }).locator('.review-pair-values');
    await expect(values.locator('span')).toHaveText(/^\d/);
    await expect(values.locator('b')).toHaveText(/^\d/);
  }
  await expect(review.locator('.review-comparison-caption')).toContainText(/[1-9]\d* compared/);
}

async function guidedDesktop() {
  const { page, frame, guide } = await embeddedTour({ viewport: desktop });
  const story = { name: new RegExp(': ' + title + '$') };
  await guide('create');
  const titleField = frame.getByRole('textbox', { name: 'Work item title', exact: true });
  await expect(titleField).toHaveValue(/^.{1,20}$/u);
  await expect(titleField).toHaveValue(title);
  await expect(frame.getByRole('textbox', { name: 'Work item brief', exact: true })).toHaveValue(brief);
  checks.push('Create types the title and brief in the real story dialog');
  await guide('board');
  const planned = frame.getByLabel('Planned lane', { exact: true });
  const working = frame.getByLabel('In progress lane', { exact: true });
  await expect(titleField).toBeHidden();
  await expect(planned.getByRole('button', story)).toBeInViewport({ ratio: 0.85 });
  const movingCard = frame.locator('.tour-moving-card');
  await expect(movingCard).toBeInViewport({ ratio: 0.85 });
  const firstPosition = await movingCard.boundingBox();
  await expect.poll(async () => (await movingCard.boundingBox())?.x ?? firstPosition.x)
    .toBeGreaterThan(firstPosition.x + 8);
  await expect(working.getByRole('button', story)).toBeInViewport({ ratio: 0.85 });
  await expect(planned.getByRole('button', story)).toHaveCount(0);
  checks.push('The story visibly travels between Planned and In progress with the card in view');
  await page.screenshot({ path: output + '/guided-board.png' });
  await guide('story');
  const detail = frame.locator('.work-detail');
  await expect(detail.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await guide('conversation');
  const composer = detail.getByRole('textbox', { name: 'Message to worker' });
  await expect(composer).toHaveValue(/^.{1,30}$/u);
  await expect(detail.locator('.message-block.user .message-body').filter({ hasText: question })).toBeVisible();
  await expect(detail.locator('.message-block.assistant .message-body').filter({ hasText: 'Escape closes the menu.' })).toBeVisible();
  checks.push('The conversation visibly types, sends, and receives the example answer');
  await page.screenshot({ path: output + '/guided-conversation.png' });
  await guide('review');
  await checkReview(frame);
  await expect(frame.getByRole('button', { name: 'See in changes' })).toBeInViewport();
  await page.screenshot({ path: output + '/guided-review.png' });
  checks.push('The real Code review panel shows a finding and four before-and-after measures');
  await frame.getByRole('button', { name: 'src/navigation/closeMenu.ts:4', exact: true }).click();
  const sourceLine = frame.locator('.source-line.active[data-code-line="4"] code');
  await expect(sourceLine).toContainText('button.focus()');
  checks.push('The review finding opens its highlighted source line');

  await guide('create');
  await expect(titleField).toHaveValue(/^.{1,20}$/u);
  await guide('board');
  await expect(planned.getByRole('button', story)).toBeVisible();
  await guide('review');
  await checkReview(frame);
  await expect(titleField).toBeHidden();
  await guide('board');
  await expect(planned.getByRole('button', story)).toBeVisible();
  await expect(working.getByRole('button', story)).toHaveCount(1);
  await expect(planned.getByRole('button', story)).toHaveCount(0);
  checks.push('Changing steps during animation and replaying the board keeps one copy of the story');

  await guide('create');
  await expect(titleField).toHaveValue(/^.{1,20}$/u);
  await titleField.click();
  const manualTitle = 'Keyboard navigation check';
  await titleField.fill(manualTitle);
  await expect(titleField).toHaveValue(manualTitle);
  await titleField.press('End');
  await titleField.press('!');
  await expect(titleField).toHaveValue(manualTitle + '!');
  await frame.getByRole('textbox', { name: 'Work item brief' }).fill('A visitor can finish the form.');
  await frame.getByRole('button', { name: 'Create work item', exact: true }).click();
  await expect(frame.getByRole('button', { name: /: Keyboard navigation check!$/ })).toBeVisible();
  checks.push('A visitor can take over an animating form with mouse and keyboard and submit their own story');

  for (const [step, selector] of [
    ['artifacts', '.artifact-row, .demo-report'],
    ['browser', '.demo-worker-browser'],
    ['terminal', '.xterm-screen'],
    ['cycle', '.cycles-view'],
    ['insights', '.insights-page'],
  ]) {
    await guide(step);
    await expect(frame.locator(selector).first()).toBeVisible();
  }
  checks.push('Artifacts, Browser, Terminal, Cycles and Insights each open their own product view');
  await page.close();
}

async function reducedMotionAndNavigation() {
  const { page, frame, guide } = await embeddedTour({
    viewport: { width: 390, height: 844 }, reducedMotion: 'reduce',
  });
  await guide('create');
  await expect(frame.getByRole('textbox', { name: 'Work item brief' })).toHaveValue(brief, { timeout: 1000 });
  await guide('board');
  await expect(frame.getByLabel('In progress lane', { exact: true }).getByRole('button', { name: new RegExp(title) })).toBeInViewport({ ratio: 0.85, timeout: 1000 });
  // Switch away before a conversation has time to finish and repeat the same
  // command, as visitors can do via the numbered navigation and replay button.
  await guide('conversation');
  await guide('create');
  await guide('review');
  await guide('review');
  await checkReview(frame);
  await expect(frame.getByRole('textbox', { name: 'Work item title' })).toBeHidden();
  await page.screenshot({ path: output + '/guided-mobile.png' });
  checks.push('Direct and rapid navigation settles on the requested review at a narrow viewport with reduced motion');
  await page.close();
}

async function manualWorkspace() {
  const page = await browser.newPage({ viewport: desktop });
  observe(page);
  await page.goto(base);
  await page.getByRole('button', { name: 'MC-003: Build the documentation landing page', exact: true }).click();
  const tab = name => page.locator('.detail-tabs').getByRole('button', { name: new RegExp('^' + name) });
  await tab('Browser').click();
  await page.getByRole('button', { name: 'Guides', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make something worth sharing.' })).toBeVisible();
  checks.push('Production story opens; sample browser navigation changes content');
  await page.screenshot({ path: output + '/browser.png' });
  await tab('Artifacts').click();
  await page.locator('.artifact-row').filter({ hasText: 'implementation-report.md' }).click();
  await expect(page.getByRole('heading', { name: 'A welcoming first release', exact: true })).toBeVisible();
  checks.push('Saved Markdown report renders directly inside its card');
  await page.screenshot({ path: output + '/report.png' });
  await tab('Changes').click();
  await expect(page.getByText('src/pages/documentation.tsx', { exact: true }).first()).toBeVisible();
  checks.push('Production syntax-highlighted change view renders');
  await tab('Terminal').click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await page.locator('.xterm-helper-textarea').pressSequentially('help');
  await page.locator('.xterm-helper-textarea').press('Enter');
  checks.push('Production xterm mounts and the simulated shell accepts input');
  await page.screenshot({ path: output + '/terminal.png' });
  await page.getByRole('button', { name: 'Close work item', exact: true }).click();
  await page.getByRole('button', { name: 'New work item', exact: true }).first().click();
  await page.getByRole('textbox', { name: 'Work item title', exact: true }).fill('Make the welcome page clearer');
  await page.getByRole('textbox', { name: 'Work item brief', exact: true }).fill('Add one clear example and a visible next step. Keep it accessible.');
  await page.getByRole('button', { name: 'Create work item', exact: true }).click();
  await expect(page.getByRole('button', { name: /: Make the welcome page clearer$/ })).toBeVisible();
  checks.push('Production new-story dialog creates an in-memory story');
  const close = page.getByRole('button', { name: 'Close work item', exact: true });
  if (await close.isVisible()) await close.click();
  const first = page.getByRole('button', { name: 'MC-001: Create a fast documentation search', exact: true });
  const lane = page.getByLabel('In progress lane', { exact: true });
  await first.dragTo(lane);
  await expect(lane.getByRole('button', { name: 'MC-001: Create a fast documentation search', exact: true })).toBeVisible();
  await first.click();
  await expect(page.locator('.work-detail h1, .work-detail h2').filter({ hasText: 'Create a fast documentation search' })).toBeVisible();
  checks.push('Manual dragging changes the lane and the moved story opens');
  await page.close();
}

try {
  await guidedDesktop();
  await reducedMotionAndNavigation();
  await manualWorkspace();
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  const result = { checks, errors, externalRequests, note: 'Real MemCode UI with in-memory website example data.' };
  await writeFile(output + '/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
