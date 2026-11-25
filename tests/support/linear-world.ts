import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../../src/seed";
import type { AppState, WorkItem } from "../../src/shared";
import type { TrackerChoices } from "../../src/tracker";
import { applyTaskPatch } from "../../runtime/task-planning";
import { LinearAuth, type LinearTokens, type TokenStore } from "../../runtime/trackers/linear/auth";
import { LinearService } from "../../runtime/trackers/linear/service";
import { FakeLinear, type FakeIssue } from "./fake-linear";

export function keptTokens() {
  const kept = new Map<string, LinearTokens>();
  const store: TokenStore = {
    read: async (id) => kept.get(id),
    write: async (id, tokens) => void kept.set(id, tokens),
    clear: async (id) => void kept.delete(id),
  };
  return { kept, store };
}

/** A MemCode with one project, and a Linear it can be connected to. */
export async function linearWorld(options: { projectId?: string; linear?: FakeLinear } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "memcode-linear-"));
  const linear = options.linear ?? new FakeLinear();
  const projectId = options.projectId ?? "p1";
  const box = { state: initialState() as AppState };
  const at = new Date(linear.clock).toISOString();
  Object.assign(box.state, {
    projects: [
      { id: projectId, name: "Web", description: "", path: "/work/web", branch: "main", analysis: "idle", createdAt: at },
    ],
    tasks: [],
    epics: [],
    cycles: [],
    storyComments: [],
    pullRequests: [],
    fleetConflicts: [],
    workflowStates: [],
    activeProjectId: projectId,
  });
  const { kept, store } = keptTokens();
  const opened: string[] = [];
  let saves = 0;
  /** What the workspace file holds, as after a crash. */
  let saved = JSON.stringify(box.state);
  const make = () =>
    new LinearService({
      state: () => box.state,
      changed: async () => {
        saves++;
        saved = JSON.stringify(box.state);
      },
      dataDir,
      auth: new LinearAuth({
        store,
        clientId: "client",
        openExternal: async (url) => void opened.push(url),
        fetch: linear.fetch,
        clock: () => linear.clock,
      }),
      tokens: store,
      fetch: linear.fetch,
      clock: () => linear.clock,
      timers: false,
    });
  const world = {
    linear,
    dataDir,
    projectId,
    kept,
    opened,
    service: make(),
    get state() {
      return box.state;
    },
    get saves() {
      return saves;
    },
    /** MemCode is closed and opened again, with what was saved. */
    async restart(keepUnsaved = false) {
      await world.service.stop();
      if (!keepUnsaved) box.state = JSON.parse(saved);
      world.service = make();
    },
    lane: (name: string) => `${projectId}:${name}`,
    get connection() {
      return box.state.trackers![0];
    },
    async connect(changes: Partial<TrackerChoices> = {}) {
      const connection = await world.service.connect(projectId, "key-good");
      const preview = await world.service.preview(connection.id, linear.team.id);
      return { connection, preview, choices: { ...preview.suggested, ...changes } };
    },
    /** Connected, and what is there brought in. */
    async imported(changes: Partial<TrackerChoices> = {}) {
      const { connection, choices } = await world.connect(changes);
      const result = await world.service.import(connection.id, choices);
      linear.calls.length = 0;
      return { connection, result, choices };
    },
    sync: () => world.service.sync(box.state.trackers![0].id),
    task: (issue: FakeIssue) =>
      box.state.tasks.find((task) => task.tracker?.id === issue.id) as WorkItem,
    /** A person edits the card here, as the app does it. */
    edit(task: WorkItem, patch: Parameters<typeof applyTaskPatch>[2]) {
      const live = box.state.tasks.find((item) => item.id === task.id)!;
      applyTaskPatch(box.state, live, patch, linear.tick());
      // The app saves every edit as it is made.
      saved = JSON.stringify(box.state);
    },
    newTask(changes: Partial<WorkItem> = {}): WorkItem {
      const at = linear.tick();
      const task = {
        id: crypto.randomUUID(),
        identifier: `MC-${String(box.state.tasks.length + 1).padStart(3, "0")}`,
        projectId,
        title: "A new task",
        description: "",
        stage: "planned",
        priority: "medium",
        category: "Work",
        kind: "feature",
        harness: "claude",
        checklist: [],
        messages: [],
        epicId: null,
        run: { state: "idle" },
        createdAt: at,
        updatedAt: at,
        ...changes,
      } as WorkItem;
      box.state.tasks.push(task);
      return task;
    },
    async end() {
      await world.service.stop();
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  return world;
}
export type LinearWorld = Awaited<ReturnType<typeof linearWorld>>;
