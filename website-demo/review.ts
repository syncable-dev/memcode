import {
  activeCodeReviewFindings, codeReviewPhases,
  type CodeReviewAPI, type CodeReviewFindingDisposition, type StoryReviewRun,
} from '../src/code-review';
import type { WorkerChanges } from '../src/changes';
import type { WorkItem } from '../src/shared';

export const menuSourcePath = 'src/navigation/closeMenu.ts';
const unchanged = [
  'export function closeMenu(event: KeyboardEvent, menu: HTMLElement, button: HTMLButtonElement) {',
  '  if (event.key !== "Escape") return;',
  '  menu.hidden = true;',
];
const addition = '  if (event.target === menu) button.focus();';
export const menuSource = new TextEncoder().encode([...unchanged, addition, '}'].join('\n')).buffer;

const explanation = 'Escape on the last navigation link hides the menu while focus is still on that link. The event target is the link, so the menu-only condition skips button.focus().';
const recommendation = 'Return focus to the menu button after hiding the menu, regardless of which link received Escape.';

export function menuChanges(task: WorkItem): WorkerChanges {
  const file = {
    path: menuSourcePath, status: 'modified' as const, additions: 1, deletions: 0, binary: false,
    hunks: [{ oldStart: 1, newStart: 1, lines: [
      ...unchanged.map((text, i) => ({ kind: 'context' as const, oldLine: i + 1, newLine: i + 1, text })),
      { kind: 'add' as const, newLine: 4, text: addition },
      { kind: 'context' as const, oldLine: 4, newLine: 5, text: '}' },
    ] }],
  };
  return {
    taskId: task.id, additions: 1, deletions: 0, files: 1,
    checkpoints: [{
      id: 'menu-focus-change', runId: 'menu-focus-worker', taskId: task.id,
      agentId: 'example-worker', harness: task.harness, branch: task.run.branch ?? 'epic/documentation',
      at: task.updatedAt, startedAt: task.createdAt, basis: 'scoped-baseline', files: [file],
    }],
  };
}

function menuReview(task: WorkItem): StoryReviewRun {
  const time = new Date().toISOString();
  return {
    version: 1, id: crypto.randomUUID(), taskId: task.id, implementationRunIds: ['menu-focus-worker'],
    createdAt: time, updatedAt: time, completedAt: time, state: 'completed', outcome: 'changes-requested',
    note: 'Example review of the mobile navigation change. Findings, measurements and checks are illustrative.',
    phases: codeReviewPhases.map(({ id }) => ({ id, state: 'complete' })),
    snapshot: {
      id: 'menu-focus-v1', patchHash: 'example-menu-focus-patch', journalRevision: 'example-menu-change',
      branch: task.run.branch ?? 'epic/documentation', commit: null, sourceRevision: null, graphRevision: null,
      files: [{ path: menuSourcePath, attribution: 'reservation' }], additions: 1, deletions: 0,
    },
    engine: { version: 'website example' }, coverage: { complete: true, limitations: [] },
    findings: [{
      id: 'escape-focus', evidenceHash: 'example-menu-only-focus-guard', title: 'Escape can leave focus on a hidden link',
      severity: 'high', category: 'correctness', path: menuSourcePath, line: 4, checkpointId: 'menu-focus-change',
      locationScope: 'story-change', evidence: addition.trim(), explanation, recommendation,
    }],
    metrics: [{
      symbol: 'closeMenu', path: menuSourcePath, line: 1, source: 'ast',
      cognitive: 2, cyclomatic: 3, nesting: 1, maintainabilityIndex: 78,
      before: { cognitive: 1, cyclomatic: 2, nesting: 1, maintainabilityIndex: 84 },
      comparison: { status: 'matched' },
    }],
    qualityComparison: { filesMeasured: 1, filesUnavailable: 0, omittedFiles: 0, omittedFunctions: 0, notes: [] },
    impact: { symbols: 1, files: 1, processes: 1, complete: true, note: 'Mobile documentation navigation' },
    checks: [{ name: 'Escape closes the navigation menu', state: 'passed', detail: 'Example check covers visibility. It does not assert where keyboard focus lands.' }],
    messages: [{
      id: crypto.randomUUID(), role: 'assistant', at: time,
      text: 'The menu closes on Escape. Returning focus only when the menu itself received the key still leaves a keyboard user stranded on the last link.',
    }],
    reviewer: { harness: task.harness, model: 'Example reviewer', state: 'idle' },
  };
}

export function demoReviews(taskFor: (id: string) => WorkItem, publish: () => void, accept: (task: WorkItem) => void) {
  const reviews = new Map<string, StoryReviewRun>();
  function save(run: StoryReviewRun) {
    run.updatedAt = new Date().toISOString();
    reviews.set(run.taskId, run);
    taskFor(run.taskId).codeReview = {
      runId: run.id, state: run.state, updatedAt: run.updatedAt,
      findingCount: activeCodeReviewFindings(run).length, outcome: run.outcome,
    };
    publish();
    return structuredClone(run);
  }
  function current(taskId: string, runId: string) {
    const run = reviews.get(taskId);
    if (run?.id !== runId) throw Error('Open the latest example review.');
    return run;
  }
  function decide(taskId: string, runId: string, findingId: string, decision: Pick<CodeReviewFindingDisposition, 'status' | 'reason' | 'explanation'>) {
    const run = current(taskId, runId);
    const finding = run.findings.find(({ id }) => id === findingId);
    if (!finding?.evidenceHash) throw Error('Select a finding from the example review.');
    if (decision.status === 'dismissed' && !decision.explanation?.trim()) throw Error('Explain why you are dismissing this finding.');
    (run.findingDispositions ??= []).push({
      ...decision, findingId, id: crypto.randomUUID(), at: new Date().toISOString(),
      actor: { id: 'example-reader', name: 'You', source: 'local' },
      snapshotId: run.snapshot.id, patchHash: run.snapshot.patchHash, evidenceHash: finding.evidenceHash,
    });
    run.outcome = activeCodeReviewFindings(run).length ? 'changes-requested' : 'ready';
    return save(run);
  }
  const api: CodeReviewAPI = {
    getCodeReview: async (id) => structuredClone(reviews.get(id) ?? null),
    startCodeReview: async (id) => save(menuReview(taskFor(id))),
    cancelCodeReview: async () => {}, // This recorded example is complete when it opens.
    dismissCodeReviewFinding: async (id, run, findingId, reason, explanation) => decide(id, run, findingId, { status: 'dismissed', reason, explanation }),
    reopenCodeReviewFinding: async (id, run, findingId) => decide(id, run, findingId, { status: 'reopened' }),
    sendCodeReviewMessage: async (id, runId, text) => {
      const run = current(id, runId);
      const at = new Date().toISOString();
      run.messages.push({ id: crypto.randomUUID(), role: 'user', at, text },
        { id: crypto.randomUUID(), role: 'assistant', at, text: `In this example, line 4 checks whether the menu itself received Escape. A link inside the menu can also receive that key. ${recommendation}` });
      return save(run);
    },
    requestCodeReviewFixes: async (id, runId, selectedIds, text) => {
      const run = current(id, runId);
      const selected = activeCodeReviewFindings(run).filter((item) => selectedIds.includes(item.id));
      if (!selected.length) throw Error('Select a finding to send back to the worker.');
      const at = new Date().toISOString();
      taskFor(id).messages.push({
        id: crypto.randomUUID(), role: 'user', at, followupState: 'queued', queuedAt: at,
        text: [`Review fixes for ${taskFor(id).identifier}`, ...selected.map((item) => `${item.path}:${item.line} — ${item.title}. ${item.recommendation}`), text].filter(Boolean).join('\n\n'),
      });
      run.state = 'stale';
      run.coverage.complete = false;
      run.note = 'The selected finding is queued in the story conversation.';
      save(run);
    },
    acceptCodeReview: async (id, runId) => {
      if (current(id, runId).outcome !== 'ready') throw Error('Resolve the active finding before accepting this change.');
      accept(taskFor(id));
      publish();
    },
  };
  return { api, ensure: (task: WorkItem) => { if (!reviews.has(task.id)) save(menuReview(task)); } };
}
