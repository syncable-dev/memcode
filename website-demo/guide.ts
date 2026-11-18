import { demoEvent, getTourStory, prepareTourConversation, setTourLane, submitTourQuestion, submitTourStory, tourBrief, tourQuestion, tourTitle } from './state';
import { animateMove, pause, reducedMotion, typeInto, until, writeField } from './walkthrough-motion';

const find = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector);
const titleField = () => find<HTMLInputElement>('input[aria-label="Work item title"]');
const briefField = () => find<HTMLTextAreaElement>('textarea[aria-label="Work item brief"]');
const card = (id: string) => '[data-work-item="' + CSS.escape(id) + '"]';
const storyTabs: Record<string, string> = {
  story: 'Runbook', runbook: 'Runbook', conversation: 'Conversation', review: 'Code review',
  artifacts: 'Artifacts', changes: 'Changes', browser: 'Browser', terminal: 'Terminal',
};
let guidedForm: HTMLFormElement | null = null;

async function closeOverlays(signal: AbortSignal) {
  find<HTMLButtonElement>('.modal-close')?.click();
  await until(() => !find('.modal-close'), signal);
  find<HTMLButtonElement>('[aria-label="Close work item"]')?.click();
  await until(() => !find('.work-detail'), signal);
}

async function navigate(label: string, signal: AbortSignal) {
  const button = await until(() => [...document.querySelectorAll<HTMLButtonElement>('.nav-item')]
    .find(item => item.querySelector('span')?.textContent === label), signal);
  if (!button.classList.contains('active')) button.click();
  await until(() => button.classList.contains('active'), signal);
}

async function fillStory(signal: AbortSignal) {
  (await until(() => find<HTMLButtonElement>('[data-guide="new-story"]'), signal)).click();
  const title = await until(titleField, signal);
  guidedForm = title.form;
  await typeInto(title, tourTitle, signal);
  await typeInto(await until(briefField, signal), tourBrief, signal);
}

async function submitGuidedForm(signal: AbortSignal) {
  const form = guidedForm;
  const title = titleField();
  const brief = briefField();
  if (!form?.isConnected || title?.form !== form || !brief) return;
  writeField(title, tourTitle);
  writeField(brief, tourBrief);
  submitTourStory(() => form.requestSubmit());
  await until(() => !form.isConnected, signal);
}

function revealBoardCard(element: HTMLElement) {
  element.classList.add('tour-story-card');
  const lane = element.closest<HTMLElement>('.column-cards')!;
  lane.scrollTop = 0;
  const board = lane.closest<HTMLElement>('.work-board')!;
  const bounds = board.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (rect.left < bounds.left) board.scrollLeft += rect.left - bounds.left;
  else if (rect.right > bounds.right) board.scrollLeft += rect.right - bounds.right;
}

async function inspectFinding(signal: AbortSignal) {
  const scroll = await until(() => find<HTMLElement>('.code-review-scroll'), signal);
  await until(() => scroll.querySelector('.code-review-summary'), signal);
  const finding = scroll.querySelector<HTMLButtonElement>('.code-review-finding-title');
  if (!finding) return;
  if (!reducedMotion()) await pause(700, signal);
  if (finding.getAttribute('aria-expanded') !== 'true') finding.click();
  const pane = getComputedStyle(scroll).overflowY === 'visible' ? scroll.parentElement! : scroll;
  const offset = finding.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  pane.scrollBy({ top: offset - 28, behavior: reducedMotion() ? 'instant' : 'smooth' });
}

async function moveStory(signal: AbortSignal) {
  const story = getTourStory();
  setTourLane(story.id, 'planned');
  const inLane = (label: string) => find<HTMLElement>('[aria-label="' + label + ' lane"] ' + card(story.id));
  const source = await until(() => inLane('Planned'), signal);
  revealBoardCard(source);
  if (!reducedMotion()) await pause(850, signal);
  const from = source.getBoundingClientRect();
  setTourLane(story.id, 'working');
  const destination = await until(() => inLane('In progress'), signal);
  revealBoardCard(destination);
  await animateMove(from, destination, signal);
}

async function showTab(step: string, signal: AbortSignal) {
  const story = getTourStory();
  const stage = step === 'review' ? 'review' : 'working';
  if (story.stage !== stage) setTourLane(story.id, stage);
  if (step === 'conversation') prepareTourConversation(story.id);
  const lane = stage === 'review' ? 'Code review' : 'In progress';
  const target = await until(() => find<HTMLElement>('[aria-label="' + lane + ' lane"] ' + card(story.id)), signal);
  target.click();
  const tab = await until(() => [...document.querySelectorAll<HTMLButtonElement>('.detail-tabs button')]
    .find(button => button.textContent?.trim().startsWith(storyTabs[step])), signal);
  tab.click();
  await until(() => tab.getAttribute('aria-current') === 'page', signal);
  if (step === 'review') return inspectFinding(signal);
  if (step !== 'conversation') return;
  const composer = await until(() => find<HTMLTextAreaElement>('[aria-label="Message to worker"]'), signal);
  await typeInto(composer, tourQuestion, signal);
  const sendButton = await until(() => find<HTMLButtonElement>('.send-button:enabled'), signal);
  submitTourQuestion(() => sendButton.click());
  await until(() => getTourStory().messages.some(message => message.role === 'assistant' && message.text.startsWith('Escape closes the menu.')), signal);
}

async function showStep(step: string, signal: AbortSignal) {
  document.documentElement.dataset.tourStep = step;
  find<HTMLButtonElement>('.toast [aria-label="Dismiss notification"]')?.click();
  if (step === 'board') await submitGuidedForm(signal);
  guidedForm = null;
  await closeOverlays(signal);
  const view = step === 'cycle' ? 'Cycles' : step === 'insights' ? 'Insights' : 'Workspace';
  await navigate(view, signal);
  if (view === 'Workspace' && step !== 'create') {
    const allWork = await until(() => find<HTMLButtonElement>('.workspace-saved-views button'), signal);
    allWork.click();
  }
  if (step === 'create') await fillStory(signal);
  else if (step === 'board') await moveStory(signal);
  else if (Object.hasOwn(storyTabs, step)) await showTab(step, signal);
}

export function installGuide() {
  let current: AbortController | undefined;
  const cancel = (event: Event) => {
    if (event.isTrusted) {
      current?.abort();
      guidedForm = null;
    }
  };
  document.addEventListener('pointerdown', cancel, true);
  document.addEventListener('keydown', cancel, true);
  const available = new Set(['create', 'board', 'project', 'cycle', 'insights', ...Object.keys(storyTabs)]);
  const ready = until(() => find('.nav-item'), new AbortController().signal);
  ready.then(() => demoEvent('ready')).catch(() => demoEvent('guide-error', { step: 'ready' }));
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'memcode-demo:guide') return;
    const step = event.data.step;
    if (step === 'ready') {
      void ready.then(() => demoEvent('ready')).catch(() => demoEvent('guide-error', { step }));
      return;
    }
    if (step === 'reset') { location.reload(); return; }
    if (!available.has(step)) return;
    current?.abort();
    const controller = new AbortController();
    current = controller;
    void showStep(step, controller.signal)
      .then(() => { if (!controller.signal.aborted) demoEvent('step-complete', { step }); })
      .catch(() => { if (!controller.signal.aborted) demoEvent('guide-error', { step }); });
  });
}
