import { initialState } from '../src/seed';
import { harnessNames } from '../src/shared';
import type { AppState, CreateTask, WorkItem, MemCodeAPI, RuntimeInfo, Harness } from '../src/shared';

const at = '2026-11-16T10:00:00.000Z';
export const demoEvent = (event: string, data: Record<string, unknown> = {}) => parent.postMessage({ type: 'memcode-demo:event', event, ...data }, location.origin);
const listeners = new Set<(state: AppState) => void>();
const terminalListeners = new Set<(value: any) => void>();
export const state = initialState();
const project = { ...state.projects[0], id: 'example', name: 'Lumen', description: 'Build a thoughtful documentation experience. Keep the plan, worker conversations and review together.', path: '/example/lumen', branch: 'epic/documentation', analysis: 'ready' as const, example: false };
const harnesses: Harness[] = ['codex', 'claude', 'cursor'];
export const runtime: RuntimeInfo = { appVersion: 'Website example', memtraceAvailable: true, dataPath: 'In-memory website example', harnesses: harnesses.map((id) => ({ id, name: harnessNames[id], available: true, path: `/example/${id}`, models: [{ id: 'configured-model', label: 'Your configured model', tier: 'balanced' } as any] })) };
Object.assign(state, { projects: [project], activeProjectId: project.id, tasks: state.tasks.slice(0, 6), epics: [], artifacts: [], onboarding: { version: 1, step: 'ready', dismissed: true }, workerConnections: Object.fromEntries(harnesses.map((id) => [id, { harness: id, approvedAt: at, runtimePath: `/example/${id}`, auth: 'authenticated', scopeVersion: 1 }])), storyComments: [], reviewComments: [] });
const titles = ['Create a fast documentation search', 'Make navigation work beautifully on mobile', 'Build the documentation landing page', 'Add a readable dark theme', 'Review keyboard navigation', 'Write the getting-started guide'];
state.tasks.forEach((task, index) => {
  task.identifier = `MC-${String(index + 1).padStart(3, '0')}`; task.id = `demo-${index + 1}`; task.title = titles[index];
  task.description = ['Help readers find the right page quickly. Keep keyboard navigation clear, handle empty results, and add a focused check.', 'Make the table of contents feel natural on a small screen, with a clear open and close action.', 'Build a welcoming first page with clear next steps, a quiet visual hierarchy and an interactive example.', 'Use the project’s existing design tokens to add a calm, readable dark theme.', 'Check focus order, visible states and keyboard shortcuts before marking the work done.', 'Explain the first useful step. Include a small working example and a concise checklist.'][index];
  task.example = false; task.stage = ['planned', 'planned', 'working', 'working', 'review', 'done'][index] as any;
  task.run = { state: index === 2 || index === 3 ? 'running' : index >= 4 ? 'finished' : 'idle', branch: project.branch, ...(index > 1 ? { startedAt: at } : {}) }; task.assignment = 'auto'; task.estimate = [3, 3, 5, 3, 2, 2][index];
  task.checklist = ['Read the relevant project context', 'Build a focused change', 'Review the output and checks'].map((text, i) => ({ id: `${task.id}-${i}`, text, done: task.stage === 'done' || i < (index > 1 ? 2 : 0) }));
  task.messages = [{ id: `${task.id}-brief`, role: 'user', text: task.description, at }, { id: `${task.id}-context`, role: 'tool', text: 'MemCode context · Example source scope\nMatched the page component, navigation styles and existing accessibility checks. All measurements in this walkthrough are illustrative.', at }, { id: `${task.id}-reply`, role: 'assistant', text: 'I’ve kept the change focused on the documentation experience.\n\n### What I’m building\n- A clearer page hierarchy and responsive navigation.\n- Keyboard-friendly interactions using the existing components.\n- A small check for the behavior we changed.\n\nThe **Browser** shows the example app. **Artifacts** keeps the saved report and design output; **Changes** shows the code for review. The **Terminal** shows a simulated dev server.\n\nThis is an interactive example, not a live worker run.', at }];
  qualify(task);
  addArtifacts(task);
});
const snap = (at: string, done: number) => ({ at, sequence: done + 1, total: 6, completed: done, planned: 2, working: 2, review: 1, points: 18, completedPoints: done * 3, unestimated: 0 });
state.cycles = [{ id: 'demo-cycle', projectId: project.id, name: 'Cycle 1 — A welcoming first release', goal: 'Make documentation easy to discover, read and use.', startDate: '2026-11-09', endDate: '2026-11-20', timeZone: 'UTC', state: 'active', capacity: 20, calendar: 'weekdays', createdAt: at, startedAt: '2026-11-09T10:00:00Z', baseline: snap('2026-11-09T10:00:00Z', 0), snapshots: [snap('2026-11-09T10:00:00Z', 0), snap('2026-11-12T10:00:00Z', 1), snap(at, 2)] }];
for (const task of state.tasks) task.cycleId = 'demo-cycle';
state.qualitySnapshots = [{
  id: 'example-quality', projectId: project.id, repoId: 'lumen-example', branch: project.branch,
  capturedAt: at, basis: 'memtrace-ast-distribution-v1', status: 'current', measurementVersion: 'example',
  source: { commit: 'example', revision: 'example-source', dirty: false, indexReady: true, files: 32, mismatchedFiles: 0 },
  graph: { revision: 'example-graph', stable: true, indexedAt: at, dataDirectory: null, scope: 'project' },
  metrics: { nodes: 268, edges: 1090, symbols: 268, files: 32, communities: 6, processes: 12, measuredFunctions: 91, estimatedFunctions: 0, distribution: { simple: 72, moderate: 16, high: 3, critical: 0 }, deadCodeCandidates: 1, importCycles: 0 },
  hotspots: [{ id: 'example-hotspot', key: 'search', name: 'DocumentationSearch', file: 'src/components/Search.tsx', line: 25, kind: 'function', signal: 'complexity', cognitive: 18, cyclomatic: 7, nesting: 3, metricSource: 'ast', reason: 'Illustrative example: simplify search filtering before expanding the feature.' }],
  deadCode: [], limitations: ['All values in this website walkthrough are synthetic examples. No repository was analyzed and no live tests ran.'], tools: ['Example data'],
}];

function qualify(task: WorkItem) {
  task.evidence = { state: 'measured', symbols: [{ name: 'DocumentationPage', file: 'src/pages/documentation.tsx', line: 12, cognitive: 8, cyclomatic: 5, nesting: 2, metricSource: 'ast' }], affected: 12, affectedFiles: 3, affectedProcesses: 2, incomplete: false, note: 'Illustrative example measurements. No repository is connected to this website.', measuredAt: at };
  task.route = { policyVersion: 'memcode-envelope-v2', tier: 'balanced', harness: task.harness, model: 'Configured balanced model', effort: 'medium', mode: 'automatic', status: 'measured', plannedAt: at, reasons: ['Example: a bounded change with moderate measured complexity.', 'Example source scope spans three files and two entry-point neighborhoods.', 'Your installed harness supplies the model and account.'], inputs: { cognitive: 8, cyclomatic: 5, nesting: 2, affected: 12, processes: 2, moduleRoots: 1, incomplete: false } };
}
function addArtifacts(task: WorkItem) {
  for (const [suffix, name, kind] of [['page', 'documentation-preview.html', 'html'], ['report', 'implementation-report.md', 'text'], ['design', 'lumen-design.svg', 'image']] as const) state.artifacts.push({ id: `${task.id}-${suffix}`, name, kind, purpose: suffix === 'report' ? 'report' : 'deliverable', path: `/example/${name}`, taskId: task.id, projectId: project.id, createdAt: at, source: runtime.harnesses.find((r) => r.id === task.harness)!.name });
}
const publish = () => { for (const listener of listeners) listener(structuredClone(state)); };
const encoded = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const taskFor = (id: string) => { const task = state.tasks.find((item) => item.id === id); if (!task) throw Error('Choose an example story.'); return task; };
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="640"><rect width="1000" height="640" fill="#0b2118"/><circle cx="760" cy="310" r="230" fill="#164532"/><circle cx="760" cy="310" r="170" fill="none" stroke="#78ccab" stroke-width="2"/><path d="M580 310h360M760 130v360" stroke="#78ccab"/><text x="72" y="145" fill="#9bd8bb" font-family="sans-serif" font-size="16" letter-spacing="5">LUMEN / DOCUMENTATION</text><text x="72" y="285" fill="#f2f8f1" font-family="sans-serif" font-size="68">A little clarity.</text><text x="72" y="365" fill="#b7ddc5" font-family="sans-serif" font-size="68">A better start.</text><text x="72" y="540" fill="#9ab5a5" font-family="sans-serif" font-size="18">Illustrative design output · MemCode website example</text></svg>`;
export const designImage = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
export const report = '# A welcoming first release\n\nThe documentation page now gives readers one clear next step.\n\n## What changed\n\n- A responsive introduction and navigation.\n- Accessible buttons with visible focus states.\n- A concise search empty state.\n\n## Review checklist\n\n- [x] Page hierarchy reviewed\n- [x] Example checks displayed\n- [ ] Human review before marking done\n\n> This is a saved example report. No real repository, test or worker ran on this website.\n\n```tsx\nexport function Welcome() {\n  return <h1>A little clarity. A better start.</h1>;\n}\n```';
let sequence = 1, terminalClosed = false;
const session = { id: 'ee40c9a3-5bc9-4310-920c-f9a2335e6dca', taskId: 'demo-3', label: 'Documentation dev server', command: ['npm', 'run', 'dev'], cwd: '/example/lumen', origin: 'worker', startedAt: at, status: 'running', seq: 1 };
const terminalText = '\x1b[1;32mLumen documentation\x1b[0m\r\n\r\n  VITE · example development server\r\n  Local: http://localhost:3000/\r\n\r\n  \x1b[32m✓\x1b[0m Page rendered\r\n  \x1b[32m✓\x1b[0m Navigation check passed (example)\r\n\r\nThis terminal is simulated. Try typing help.\r\n\x1b[36mexample>\x1b[0m ';
let input = '';
const noop = async () => undefined;
export function installDemo() {
  // Production components keep drafts/preferences locally. In this website
  // example they use volatile storage too, so Reset clears everything typed.
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>();
    Object.defineProperty(window, name, { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } });
  }
  const methods: Record<string, any> = {
    load: async () => ({ state: structuredClone(state), runtime }),
    onState: (listener: (state: AppState) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    accountStatus: async () => ({ status: 'unknown', label: 'Interactive website example', detail: 'No account is signed in to this demo.', loginPending: false }),
    betaStatus: async () => ({ state: 'unavailable', accessMode: 'installed-cli', detail: 'Website example only. Download MemCode to connect your own account.', loginPending: false }),
    resumeBeta: async () => methods.betaStatus(),
    refreshBeta: async () => methods.betaStatus(),
    teamsList: async () => ({ teams: [], configured: false, canCreate: false, identityAvailable: false }),
    workerConnectionStatus: async () => harnesses.map((harness) => ({ harness, installed: true, connected: true, runtimePath: `/example/${harness}`, auth: 'authenticated', note: 'Example connection. No installed tool is accessed.', loginCommand: '' })),
    updateOnboarding: async (patch: any) => { Object.assign(state.onboarding!, patch); publish(); return state.onboarding; },
    updateTask: async (id: string, patch: any) => { const task = taskFor(id); Object.assign(task, patch, { updatedAt: new Date().toISOString() }); publish(); if (patch.stage) { demoEvent('story-moved', { storyId: task.identifier, stage: patch.stage }); } },
    createTask: async (input: CreateTask) => { const task = { ...structuredClone(state.tasks[0]), ...input, id: crypto.randomUUID(), identifier: `MC-${String(state.tasks.length + 1).padStart(3, '0')}`, title: input.title || input.description.split(/[\n.!?]/)[0].slice(0, 90), stage: 'planned', run: { state: 'idle' }, example: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [{ id: crypto.randomUUID(), role: 'user', text: input.description, at }], checklist: ['Explore the source context', 'Implement a focused change', 'Review the result'].map((text) => ({ id: crypto.randomUUID(), text, done: false })) } as WorkItem; qualify(task); state.tasks.unshift(task); addArtifacts(task); publish(); demoEvent('story-created', { storyId: task.identifier }); return task; },
    qualifyTask: async (id: string) => { qualify(taskFor(id)); publish(); },
    analyzeProject: async () => { demoEvent('context-explained'); },
    refreshIntelligence: async () => state.qualitySnapshots[0],
    queryIntelligence: async (_projectId: string, section: string) => ({ section, title: `Example ${section}`, summary: 'Illustrative project context. MemCode retrieves real evidence from your local Memtrace graph after you connect a project.', items: [{ id: 'example-context', title: 'Documentation workspace', description: 'The example connects navigation, search, styles and their verification targets.', badge: 'Example' }], notes: ['Synthetic example data. No source files are read by this website.'], capturedAt: at, graphRevision: 'example-graph' }),
    startWorker: async (id: string) => { const task = taskFor(id); task.stage = 'working'; task.run = { state: 'running', startedAt: new Date().toISOString(), branch: project.branch }; publish(); setTimeout(() => { task.run = { state: 'finished', finishedAt: new Date().toISOString(), branch: project.branch }; task.stage = 'review'; task.messages.push({ id: crypto.randomUUID(), role: 'assistant', at: new Date().toISOString(), text: 'The example change is ready for review. Open **Changes**, **Artifacts**, **Browser** or **Terminal** to explore the result.\n\nThis is a scripted walkthrough; no real worker or test ran.' }); publish(); demoEvent('worker-finished'); }, 3000); },
    stopWorker: async (id: string) => { taskFor(id).run.state = 'stopped'; publish(); },
    sendFollowup: async (id: string, text: string) => { const task = taskFor(id); const messageId = crypto.randomUUID(); task.messages.push({ id: messageId, role: 'user', text, at: new Date().toISOString(), followupState: 'queued', queuedAt: new Date().toISOString() }); publish(); setTimeout(() => { const message = task.messages.find((m) => m.id === messageId); if (!message || message.followupState !== 'queued') return; message.followupState = 'included'; task.messages.push({ id: crypto.randomUUID(), role: 'assistant', at: new Date().toISOString(), text: 'Your follow-up is attached to this story. In MemCode, the worker picks up queued follow-ups automatically when ready. This website reply is an example.' }); publish(); }, 2000); return { messageId }; },
    cancelQueuedFollowup: async (id: string, messageId: string) => { const message = taskFor(id).messages.find((m) => m.id === messageId); if (message) message.followupState = 'cancelled'; publish(); },
    updateQueuedFollowup: async (id: string, messageId: string, text: string) => { const message = taskFor(id).messages.find((m) => m.id === messageId); if (message) message.text = text; publish(); },
    addMessage: async (id: string, text: string) => { taskFor(id).messages.push({ id: crypto.randomUUID(), role: 'user', text, at: new Date().toISOString() }); publish(); },
    storyCommentIdentity: async () => ({ id: 'example-reader', name: 'You', source: 'local' }),
    readArtifact: async (id: string) => id.endsWith('-design') ? designImage : report,
    readArtifactThumbnail: async (id: string) => id.endsWith('-design') ? ({ kind: 'image', format: 'image', dataUrl: designImage }) : ({ kind: 'document', format: 'markdown', title: 'A welcoming first release', lines: ['A clear documentation experience.', 'Responsive navigation and keyboard controls.', 'Example checks, ready for human review.'] }),
    workerChanges: async (id: string) => ({ taskId: id, additions: 5, deletions: 1, files: 1, checkpoints: [{ id: 'example-change', runId: 'example-run', taskId: id, agentId: 'example-worker', harness: taskFor(id).harness, branch: project.branch, startedAt: at, at, basis: 'scoped-baseline', files: [{ path: 'src/pages/documentation.tsx', status: 'modified', additions: 5, deletions: 1, binary: false, hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: 'delete', text: 'export const title = "Documentation";', oldLine: 1 }, ...['export function DocumentationPage() {', '  return <main className="documentation">', '    <h1>A little clarity. A better start.</h1>', '  </main>;', '}'].map((text, i) => ({ kind: 'add', text, newLine: i + 1 }))] }] }] }] }),
    onTerminal: (listener: (value: any) => void) => { terminalListeners.add(listener); return () => terminalListeners.delete(listener); },
    terminal: async (taskId: string, request: any) => { if (request.action === 'close') terminalClosed = true; if (request.action === 'start') terminalClosed = false; const result = { sessions: terminalClosed ? [] : [{ ...session, taskId }], shells: [{ id: 'example', name: 'Example shell', command: 'example', args: [] }], session: { ...session, taskId }, chunks: [] as any[] };
      if (request.action === 'observe' && !request.after) result.chunks = [{ seq: 1, data: encoded(terminalText) }];
      if (request.action === 'write') { const data = request.data ?? ''; let output = data; for (const char of data) { if (char === '\r' || char === '\n') { output = '\r\n' + (input.trim() === 'help' ? 'Try help, npm run dev, or npm test. No command is executed.\r\n' : input.trim() === 'npm test' ? '\x1b[32m✓ 3 example checks passed\x1b[0m\r\n' : input.trim() ? 'Website simulation: no local process was started.\r\n' : '') + '\x1b[36mexample>\x1b[0m '; input = ''; } else if (char === '\x7f') input = input.slice(0, -1); else input += char; } for (const listener of terminalListeners) listener({ taskId, sessionId: session.id, seq: ++sequence, data: encoded(output) }); } return result; },
    selectProject: async () => {}, saveSettings: async () => runtime, onRuntimeHealth: () => () => {},
    hidePreview: noop, previewAction: noop, windowAction: noop,
  };
  window.memcode = new Proxy(methods, { get: (target, key: string) => key in target ? target[key] : key.startsWith('on') ? () => () => {} : async () => { demoEvent('explanation', { feature: key }); throw Error('This website example keeps local actions disabled. Download MemCode to connect a project and worker.'); } }) as MemCodeAPI;
}
