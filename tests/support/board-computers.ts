import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../../src/seed";
import type { AppState, WorkItem } from "../../src/shared";
import type { SharedBoardStatus } from "../../src/sharing";
import { boardOf } from "../../runtime/sharing/board/board";
import { BoardSync } from "../../runtime/sharing/board/sync";
import type { BoardsApi } from "../../runtime/sharing/memsync/boards-api";
import type { GrpcStream } from "../../runtime/sharing/memsync/grpc";
import { SharingUnavailable } from "../../runtime/sharing/problems";
import type { StandInPerson } from "./memsync-stand-in";
import { signedInTo, type SharingWorld } from "./projects-api-scenarios";

const at = "2026-11-21T12:00:00.000Z";

export async function until(
  isTrue: () => boolean,
  what: string | (() => string),
) {
  const deadline = Date.now() + 8000;
  while (!isTrue()) {
    if (Date.now() > deadline)
      assert.fail(
        `still waiting for ${typeof what === "string" ? what : what()}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const task = (
  projectId: string,
  id: string,
  changes: Partial<WorkItem> = {},
): WorkItem => ({
  id,
  identifier: `MC-${id.replace(/\D/g, "").padStart(3, "0") || "001"}`,
  projectId,
  title: `Task ${id}`,
  description: "",
  stage: "planned",
  statusId: `${projectId}:planned`,
  priority: "medium",
  category: "Work",
  kind: "feature",
  harness: "claude",
  assignment: "auto",
  epicId: null,
  checklist: [],
  messages: [
    { id: `private-${id}`, role: "tool", text: "PRIVATE TOOL OUTPUT", at },
  ],
  run: { state: "idle", workspace: "/private/checkout" },
  createdAt: at,
  updatedAt: at,
  ...changes,
});

/** Puts a small board with one of everything on a computer's project. */
export function giveWork(state: AppState, projectId: string): void {
  state.epics.push({
    id: "goal-1",
    projectId,
    identifier: "EP-01",
    title: "Customers can export reports",
    description: "As CSV and as PDF.",
    phase: "now",
    color: "mint",
    order: 0,
    branch: "epic/ep-01-reports",
    baseBranch: "dev",
  });
  state.cycles.push({
    id: "cycle-1",
    projectId,
    name: "Week 47",
    goal: "Ship the export",
    startDate: "2026-11-16",
    endDate: "2026-11-22",
    timeZone: "Europe/Copenhagen",
    state: "active",
    capacity: 20,
    calendar: "weekdays",
    createdAt: at,
    startedAt: at,
    snapshots: [],
  });
  state.tasks.push(
    task(projectId, "task-1", {
      title: "Export as CSV",
      description: "Line one.\nLine two.",
      stage: "working",
      statusId: `${projectId}:working`,
      priority: "high",
      epicId: "goal-1",
      cycleId: "cycle-1",
      estimate: 3,
      labels: ["urgent"],
      scope: ["src/export"],
      checklist: [
        { id: "step-1", text: "Read the code", done: true },
        { id: "step-2", text: "Write it", done: false },
      ],
      customFields: { "field-1": "blue" },
    }),
    task(projectId, "task-2", { title: "Export as PDF", epicId: "goal-1" }),
  );
  (state.storyComments ??= []).push({
    id: "comment-1",
    taskId: "task-1",
    text: "Looks right to me.",
    author: { id: "local-owner", name: "You", source: "local" },
    createdAt: at,
    updatedAt: at,
  });
  state.workflowStates.push(
    {
      id: `${projectId}:planned`,
      projectId,
      name: "Planned",
      stage: "planned",
      color: "#98a59d",
      order: 1,
    },
    {
      id: `${projectId}:working`,
      projectId,
      name: "In progress",
      stage: "working",
      color: "#18c8b5",
      order: 2,
    },
  );
  state.customFields.push({
    id: "field-1",
    projectId,
    name: "Colour",
    type: "select",
    options: ["blue", "green"],
  });
  state.savedViews.push({
    id: "view-1",
    projectId,
    name: "Urgent first",
    mode: "board",
    groupBy: "status",
    sortBy: "priority",
    filters: { labels: ["urgent"] } as never,
  });
}

export interface ComputerOptions {
  /** A folder to keep board sync in, when the test wants to look at it or reuse it. */
  folder?: string;
  people?: StandInPerson[];
}

/**
 * One computer running MemCode: a workspace in memory, the workspace file,
 * and board sync for one local project, signed in as one person.
 */
export async function computer(
  world: SharingWorld,
  person: StandInPerson,
  name: string,
  options: ComputerOptions = {},
) {
  const folder =
    options.folder ?? (await mkdtemp(join(tmpdir(), `memcode-${name}-`)));
  const projectId = `${name}-project`;
  const signedIn = signedInTo(world, person);
  const streams = new Set<GrpcStream>();
  let state: AppState = initialState();
  state.projects.push({
    id: projectId,
    name,
    description: "",
    path: `/work/${name}`,
    branch: "main",
    analysis: "idle",
    createdAt: at,
  });
  state.activeProjectId = projectId;
  state.storyComments = [];
  let file = JSON.stringify(state);
  let writes: Promise<unknown> = Promise.resolve();
  let sync: BoardSync | undefined;
  let sharedProjectId = "";
  const unreachable = () =>
    new SharingUnavailable("The sharing service cannot be reached.");

  const self = {
    name,
    projectId,
    folder,
    get state() {
      return state;
    },
    get sync() {
      return sync!;
    },
    isOffline: false,
    /** The service takes calls and never answers them, as on a network that drops everything. */
    isSilent: false,
    /** How many of the next saves of the workspace fail, as on a full disk. */
    failingSaves: 0,
    /** Run after the workspace file was written and before board sync hears of it. */
    afterNextSave: undefined as (() => void) | undefined,
    saves: 0,
    shown: 0,
    appends: [] as number[],
    appendBytes: [] as number[],
    reads: [] as number[],
    watches: [] as number[],
    /** What the workspace file holds. */
    file: (): AppState => JSON.parse(file),
    board: () => boardOf(state, projectId),
    status: (): SharedBoardStatus => sync!.status(),

    /** Saves the workspace as the runtime does: as it is now, written in turn. */
    save(first?: () => Promise<void>): Promise<void> {
      const snapshot = JSON.stringify(state);
      const pending = writes
        .catch(() => {})
        .then(async () => {
          await first?.();
          if (self.failingSaves > 0) {
            self.failingSaves--;
            throw new Error("No space left on device");
          }
          file = snapshot;
          self.saves++;
          const then = self.afterNextSave;
          self.afterNextSave = undefined;
          then?.();
        });
      writes = pending;
      return pending;
    },
    /** A change made in the app: the workspace changes, is saved, and sync looks at it. */
    async edit(change: (state: AppState) => void): Promise<void> {
      change(state);
      await self.save();
      await sync?.capture();
    },
    /** A change made while board sync is not running, as when signed out. */
    async editUnseen(change: (state: AppState) => void): Promise<void> {
      change(state);
      await self.save();
    },
    /** Connects the project to a shared one and starts sync. */
    connect(shared: string): void {
      sharedProjectId = shared;
      (state.sharedProjectLinks ??= []).push({
        projectId,
        sharedProjectId: shared,
        sharedProjectName: "Shared",
        accountId: person.accountId,
        service: world.address.href,
        connectedAt: at,
      });
      file = JSON.stringify(state);
      self.start();
    },
    start(): void {
      const boards: BoardsApi = {
        async append(project, updates) {
          if (self.isOffline) throw unreachable();
          self.appends.push(updates.length);
          self.appendBytes.push(
            updates.reduce((sum, update) => sum + update.payload.length, 0),
          );
          return signedIn.boards.append(project, updates);
        },
        async readAfter(project, sequence) {
          if (self.isSilent) return new Promise<never>(() => {});
          if (self.isOffline) throw unreachable();
          self.reads.push(sequence);
          return signedIn.boards.readAfter(project, sequence);
        },
        watchAfter(project, sequence, onUpdate) {
          if (self.isOffline)
            return { finished: Promise.reject(unreachable()), cancel() {} };
          self.watches.push(sequence);
          const stream = signedIn.boards.watchAfter(
            project,
            sequence,
            onUpdate,
          );
          streams.add(stream);
          return stream;
        },
      };
      sync = new BoardSync({
        projectId,
        sharedProjectId,
        folder: join(folder, "board"),
        state: () => state,
        boards,
        saveWorkspace: (first) => self.save(first),
        shown: () => void self.shown++,
        people: async () =>
          new Map(
            (options.people ?? [person]).map((one) => [
              one.accountId,
              one.name,
            ]),
          ),
        waitBeforeRetry: () => 15,
      });
      sync.start();
    },
    goOffline(): void {
      self.isOffline = true;
      for (const stream of streams) stream.cancel();
      streams.clear();
    },
    comeBack(): void {
      self.isOffline = false;
    },
    /** MemCode is quit: sync ends, and what is in memory is gone. */
    async quit(): Promise<void> {
      await sync?.stop();
      sync = undefined;
      streams.clear();
    },
    /** MemCode is started again: the workspace is what the file holds. */
    reopen(): void {
      state = JSON.parse(file);
      self.start();
    },
    async synced(): Promise<void> {
      await until(
        () => sync!.status().state === "synced",
        () => `${name} to be in sync: ${JSON.stringify(sync!.status())}`,
      );
    },
    async close(): Promise<void> {
      await self.quit();
      signedIn.close();
      if (!options.folder) await rm(folder, { recursive: true, force: true });
    },
  };
  return self;
}
export type Computer = Awaited<ReturnType<typeof computer>>;

/** Waits until two computers are in sync and show the same board. */
export async function agree(left: Computer, right: Computer): Promise<void> {
  const same = () => {
    try {
      assert.deepEqual(left.board(), right.board());
      return true;
    } catch {
      return false;
    }
  };
  await until(
    () =>
      left.status().state === "synced" &&
      right.status().state === "synced" &&
      same(),
    () =>
      `${left.name} and ${right.name} to agree: ${JSON.stringify([left.status(), right.status()])}`,
  );
  // Nothing is still on its way to a workspace file.
  await left.sync.capture();
  await right.sync.capture();
  assert.deepEqual(left.board(), right.board());
}

export const newId = () => randomUUID();
