import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AppState, Epic, WorkItem } from "../../../src/shared";
import type { Person } from "../../../src/people";
import type {
  TrackedField,
  TrackerChoices,
  TrackerConnection,
  TrackerKeeper,
  TrackerPreview,
  TrackerScope,
  TrackerStatus,
  TrackerTeam,
} from "../../../src/tracker";
import { isActive } from "../../../src/domain";
import { backlogStatusId, workflowFor } from "../../../src/planning/workflow";
import { dayAt } from "../../../src/planning/dates";
import { cycleSnapshot, observePlanning } from "../../../src/planning/history";
import { newRunbook } from "../../../src/runbook";
import {
  LinearApi,
  NotThere,
  SignInEnded,
  TrackerRefused,
  TrackerUnavailable,
  type Page,
} from "./api";
import type { LinearAuth, TokenStore } from "./auth";
import {
  applyThere,
  goalOf,
  hasUnshippedWork,
  hereOf,
  inputOf,
  longestDescription,
  same,
  taskOf,
  sorted,
  thereOf,
  toThere,
  type Frame,
  type Here,
  type There,
} from "./fields";
import { emptyMemory, MemoryFile, type Memory } from "./memory";
import {
  agreeAsIs,
  agreed,
  asOld,
  baseFor,
  contested,
  goalsChosenAnew,
  mayFollowNow,
  mergeIssue,
  observe,
  onlyStuck,
  reunited,
  stuckNote,
  takenBack,
  unsaid,
  type History,
} from "./merge";
import {
  historyReaches,
  readComment,
  readCycle,
  readHistory,
  readIssue,
  readLabel,
  readPerson,
  readProject,
  readStatus,
  readTeam,
  type Comment,
  type Issue,
  type Label,
  type LinearProject,
} from "./read";

/** How often Linear is asked what changed while MemCode is open. */
const lookEveryMs = 30_000;
/** How long after a change here it is sent, so that a burst of edits goes together. */
const settleMs = 1_500;
/** How long a computer that takes over waits for the one before it to hear so. */
const handOverMs = 45_000;
/** Looked at again although it was seen: two changes can have the same moment. */
const overlapMs = 120_000;
/** Lists that seldom change, and what is gone there. */
const listsEveryMs = 2 * 60_000;
/** Cards and comments asked about at once; the rest have their turn at the next look. */
const standingPart = 500;
const compareEveryMs = 12 * 3_600_000;
const undoDays = 7;
/** How long a shared board may take to come up before the page says what is waited for. */
const boardMs = 60_000;
const longestComment = 20_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const openTypes: TrackerStatus["type"][] = ["backlog", "unstarted", "started"];

export interface LinearDeps {
  state: () => AppState;
  /** Saves the workspace and shows it. */
  changed: () => Promise<void>;
  /** How the board of a shared project stands in this run. */
  boardState?: (projectId: string) => string | undefined;
  dataDir: string;
  auth: LinearAuth;
  tokens: TokenStore;
  fetch?: typeof fetch;
  apiUrl?: string;
  clock?: () => number;
  /** Not started in tests: they say when to look. */
  timers?: boolean;
}

interface Live {
  memory: Memory;
  file: MemoryFile;
  labels: Map<string, Label>;
  projects: LinearProject[];
  listsAt: number;
  failures: number;
  notBefore: number;
  /** How an issue stood that is not as its card says, by task id. */
  stood: Map<string, string>;
  /** Issues and comments that were not there when last asked. */
  missing: Set<string>;
  standingFrom: number;
  /** Until then another computer may still be writing what Linear said. */
  handOver?: number;
  timer?: NodeJS.Timeout;
}

/** Keeps MemCode projects in step with Linear teams. */
export class LinearService {
  private live = new Map<string, Promise<Live>>();
  private turns = new Map<string, Promise<unknown>>();
  private interval?: NodeJS.Timeout;
  private stopped = false;
  /** Since when a project's shared board is waited for. */
  private waiting = new Map<string, number>();
  constructor(private deps: LinearDeps) {}

  private now() {
    return (this.deps.clock ?? Date.now)();
  }
  private at() {
    return new Date(this.now()).toISOString();
  }
  private all(): TrackerConnection[] {
    return (this.deps.state().trackers ??= []);
  }
  connection(id: string): TrackerConnection {
    const found = this.all().find((item) => item.id === id);
    if (!found) throw new Error("This project is not connected to Linear.");
    return found;
  }
  private api(id: string): LinearApi {
    return new LinearApi({
      authorization: (renew) => this.deps.auth.authorization(id, renew),
      fetch: this.deps.fetch,
      url: this.deps.apiUrl,
    });
  }
  private memoryOf(id: string): Promise<Live> {
    let live = this.live.get(id);
    if (!live) {
      const file = new MemoryFile(join(this.deps.dataDir, "trackers"), id);
      live = file.read().then((memory) => ({
        memory,
        file,
        labels: new Map(),
        projects: [],
        listsAt: 0,
        failures: 0,
        notBefore: 0,
        stood: new Map(),
        missing: new Set(),
        standingFrom: 0,
      }));
      this.live.set(id, live);
      // Read again the next time: a file that cannot be read now may be in a moment.
      live.catch(() => this.live.delete(id));
    }
    return live;
  }
  /** One thing at a time per connection: a look and a send never cross. */
  private inTurn<Result>(id: string, job: () => Promise<Result>): Promise<Result> {
    const turn = (this.turns.get(id) ?? Promise.resolve()).catch(() => {}).then(job);
    this.turns.set(
      id,
      turn.catch(() => {}),
    );
    return turn;
  }
  private async save(live: Live): Promise<void> {
    await this.deps.changed();
    await live.file.save(live.memory);
  }
  /** Everything here a look or a send can change. What is the same after it needs no saving. */
  private print(connection: TrackerConnection): string {
    const state = this.deps.state();
    const { lastCheckedAt: _when, ...rest } = connection;
    const tasks = this.tasksOf(connection);
    const here = new Set(tasks.map((task) => task.id));
    const ours = (item: { projectId: string }) => item.projectId === connection.projectId;
    return JSON.stringify([
      rest,
      state.trackerKeepers?.filter(ours),
      state.epics.filter(ours),
      state.cycles.filter(ours),
      tasks.map((task) => [
        task.id,
        hereOf(task, { state, connection } as Frame),
        task.tracker,
        task.assignee,
        task.startDate,
        task.stage,
        task.statusId,
        task.archivedAt,
        task.closedAs,
        task.updatedAt,
      ]),
      state.storyComments
        ?.filter((comment) => here.has(comment.taskId))
        .map((comment) => [
          comment.id,
          comment.text,
          comment.updatedAt,
          comment.deletedAt,
          comment.tracker,
        ]),
    ]);
  }
  /** What is remembered of a project while it is disconnected lies under this. */
  private placeOf = (connection: TrackerConnection) =>
    `${connection.projectId}\n${connection.workspace.id}`;

  // ── Connecting ──────────────────────────────────────────────────────────────

  async connect(projectId: string, key?: string): Promise<TrackerConnection> {
    const state = this.deps.state();
    const project = state.projects.find((item) => item.id === projectId);
    if (!project || project.example) throw new Error("Open a project of your own first.");
    const known = this.all().find((item) => item.projectId === projectId);
    const id = known?.id ?? randomUUID();
    const tokens = key
      ? { kind: "key" as const, access: key.trim() }
      : await this.deps.auth.signIn();
    const before = await this.deps.tokens.read(id).catch(() => undefined);
    await this.deps.tokens.write(id, tokens);
    try {
      const data = await this.api(id).call("Viewer");
      const viewer = readPerson(data.viewer);
      const workspace = data.organization;
      if (!viewer || typeof workspace?.id !== "string")
        throw new TrackerRefused("Linear did not say who signed in.");
      if (known && known.workspace.id !== workspace.id && known.importedAt)
        throw new Error(
          `This project is in step with ${known.workspace.name}. You signed in to ${workspace.name}. Disconnect first to change workspaces.`,
        );
      const connection: TrackerConnection = {
        ...(known ?? {}),
        id,
        projectId,
        provider: "linear",
        workspace: {
          id: workspace.id,
          name: String(workspace.name ?? "Linear").slice(0, 200),
          urlKey: String(workspace.urlKey ?? "").slice(0, 100),
        },
        viewer,
        connectedAt: this.at(),
      };
      delete connection.problem;
      if (known) Object.assign(known, connection, { problem: undefined });
      else this.all().push(connection);
      const live = await this.memoryOf(id);
      live.failures = 0;
      live.notBefore = 0;
      if (!known) live.memory = (await live.file.wake(this.placeOf(connection))) ?? live.memory;
      await this.deps.changed();
      return this.connection(id);
    } catch (error) {
      if (before) await this.deps.tokens.write(id, before);
      else await this.deps.tokens.clear(id);
      if (key && error instanceof SignInEnded)
        throw new Error("Linear did not accept this API key.");
      throw error;
    }
  }
  cancelConnecting(): void {
    this.deps.auth.cancel();
  }

  /** Answers whether Linear was told: a sign-in it did not hear about lasts there until it runs out. */
  async disconnect(id: string): Promise<{ told: boolean }> {
    return this.inTurn(id, async () => {
      const connection = this.connection(id);
      const state = this.deps.state();
      state.trackers = this.all().filter((item) => item !== connection);
      state.trackerKeepers = state.trackerKeepers?.filter((item) => item.connection !== id);
      // Cards stay, and know which issue they were: connecting again makes no doubles.
      for (const task of state.tasks)
        if (task.projectId === connection.projectId && task.tracker)
          task.tracker = {
            ...task.tracker,
            standing: "unlinked",
            // A card that was unlinked before stays that: connecting again is not about it.
            note:
              task.tracker.standing === "unlinked" ? task.tracker.note : disconnected,
            kept: undefined,
          };
      await this.deps.changed();
      const live = await this.memoryOf(id).catch(() => undefined);
      clearTimeout(live?.timer);
      this.live.delete(id);
      await live?.file.settled();
      if (live && !this.hasProject(connection)) {
        await live.file.forget();
        await live.file.forgetResting(this.placeOf(connection));
      } else if (live && connection.choices && !live.memory.rested) {
        const { teamId, direction, goals } = connection.choices;
        await live.file.rest(
          { ...live.memory, rested: { at: this.at(), teamId, direction, goals } },
          this.placeOf(connection),
        );
      } else await live?.file.forget();
      return { told: await this.deps.auth.revoke(id) };
    });
  }

  // ── Who keeps a shared project in step ──────────────────────────────────────

  private keeperOf(connection: TrackerConnection): TrackerKeeper | undefined {
    return this.deps.state().trackerKeepers?.find(
      (item) =>
        item.projectId === connection.projectId && item.provider === connection.provider,
    );
  }
  private isKeeper(connection: TrackerConnection): boolean {
    const keeper = this.keeperOf(connection);
    return !keeper || keeper.connection === connection.id;
  }
  private becomeKeeper(connection: TrackerConnection): void {
    const state = this.deps.state();
    const now = this.keeperOf(connection);
    if (now?.connection === connection.id && now.team === (connection.team?.name ?? "")) return;
    state.trackerKeepers = [
      ...(state.trackerKeepers ?? []).filter(
        (item) =>
          item.projectId !== connection.projectId || item.provider !== connection.provider,
      ),
      {
        projectId: connection.projectId,
        provider: connection.provider,
        connection: connection.id,
        by: connection.viewer.name,
        workspace: connection.workspace.name,
        team: connection.team?.name ?? "",
        since: this.at(),
      },
    ];
  }
  /** This computer does it from now on. The one that did it hears so through the board. */
  async takeOver(id: string): Promise<void> {
    const connection = this.connection(id);
    if (this.isKeeper(connection)) return;
    this.assertBoard(connection);
    const live = await this.memoryOf(id);
    live.memory.since = this.keeperOf(connection)?.since;
    this.becomeKeeper(connection);
    // Until the other has heard, and what it has already written has arrived here.
    live.notBefore = live.handOver = this.now() + handOverMs;
    await this.save(live);
  }
  /**
   * On a shared project the board says who keeps it in step. Until it is here as it is now,
   * somebody else may do so already, and the same words would be written twice.
   */
  private boardIsHere(connection: TrackerConnection): boolean {
    const state = this.deps.state();
    const { projectId } = connection;
    if (!state.sharedProjectLinks?.some((link) => link.projectId === projectId)) return true;
    const board = this.deps.boardState
      ? this.deps.boardState(projectId)
      : state.sharedBoards?.find((item) => item.projectId === projectId)?.state;
    // Two boards that stay two, or one that is gone for this person, have no one else in them.
    return ["synced", "sending", "apart", "gone"].includes(board ?? "");
  }
  private assertBoard(connection: TrackerConnection): void {
    if (!this.boardIsHere(connection)) throw new Error(boardMissing);
  }
  /** Says what is waited for, once it takes longer than a board takes to come up. */
  private waitForBoard(connection: TrackerConnection): void {
    const since = this.waiting.get(connection.id) ?? this.now();
    this.waiting.set(connection.id, since);
    if (this.now() - since < boardMs || connection.problem === boardMissing) return;
    connection.problem = boardMissing;
    void this.deps.changed().catch(() => {});
  }
  /** Another computer does it now: what was on its way from here is its to send. */
  private rest(connection: TrackerConnection): void {
    let rested = false;
    for (const task of this.tasksOf(connection))
      if (task.tracker?.standing && task.tracker.standing !== "synced") {
        task.tracker = { ...task.tracker, standing: undefined, note: undefined, kept: undefined };
        rested = true;
      }
    if (connection.problem) {
      delete connection.problem;
      rested = true;
    }
    if (rested) void this.deps.changed().catch(() => {});
  }

  async pause(id: string, paused: boolean): Promise<void> {
    this.connection(id).paused = paused || undefined;
    await this.deps.changed();
    if (!paused) await this.sync(id);
  }

  // ── Choosing what to bring in ───────────────────────────────────────────────

  async teams(id: string): Promise<TrackerTeam[]> {
    this.connection(id);
    const nodes = await this.api(id).all<unknown>("Teams", {}, (data) => data.teams);
    return nodes.flatMap((item) => readTeam(item) ?? []);
  }

  async preview(id: string, teamId: string): Promise<TrackerPreview> {
    const connection = this.connection(id);
    const team = (await this.teams(id)).find((item) => item.id === teamId);
    if (!team) throw new Error("This team is not there any more.");
    const statuses = await this.readStatuses(id, teamId);
    const count = async (scope: TrackerScope) =>
      (
        await this.api(id).all<{ id: string }>(
          "IssueIds",
          { filter: scopeFilter(teamId, scope) },
          (data) => data.issues,
        )
      ).length;
    const [open, cycle, everything] = [
      await count("open"),
      team.cyclesEnabled ? await count("cycle") : 0,
      await count("all"),
    ];
    const projects = await this.readProjects(id, teamId);
    return {
      team,
      statuses,
      counts: { open, cycle, all: everything },
      goals: {
        projects: projects.filter((item) => !item.gone).length,
        milestones: projects.flatMap((item) => item.milestones).filter((item) => !item.gone)
          .length,
        parents: 0,
      },
      suggested: suggest(this.deps.state(), connection.projectId, teamId, statuses),
    };
  }

  private async readStatuses(id: string, teamId: string): Promise<TrackerStatus[]> {
    const data = await this.api(id).call("Statuses", { team: teamId });
    const nodes: unknown[] = data.workflowStates?.nodes ?? [];
    return nodes
      .flatMap((item) => readStatus(item) ?? [])
      .sort((a, b) => a.position - b.position);
  }
  private async readProjects(id: string, teamId: string): Promise<LinearProject[]> {
    const nodes = await this.api(id).all<unknown>(
      "Projects",
      { team: teamId },
      (data) => data.team?.projects,
    );
    return nodes.flatMap((item) => readProject(item) ?? []);
  }

  /** What the rest of the work needs to understand Linear's answers. */
  private async loadLists(connection: TrackerConnection, live: Live): Promise<void> {
    const { id } = connection;
    const teamId = connection.choices!.teamId;
    const [statuses, people, projects, teams, cycles] = [
      await this.readStatuses(id, teamId),
      await this.api(id).all<unknown>(
        "People",
        { team: teamId },
        (data) => data.team?.members as Page<unknown> | undefined,
      ),
      await this.readProjects(id, teamId),
      await this.teams(id),
      await this.api(id).all<unknown>("Cycles", { team: teamId }, (data) => data.cycles),
    ];
    connection.statuses = statuses;
    connection.people = people.flatMap((item) => readPerson(item) ?? []);
    connection.team = teams.find((item) => item.id === teamId) ?? connection.team;
    await this.loadLabels(connection, live);
    live.projects = projects;
    this.applyCycles(
      connection,
      cycles.flatMap((item) => readCycle(item) ?? []),
    );
    this.applyGoalNames(connection, live);
    live.listsAt = this.now();
  }

  private async loadLabels(connection: TrackerConnection, live: Live): Promise<void> {
    const labels = await this.api(connection.id).all<unknown>(
      "Labels",
      { team: connection.choices!.teamId },
      (data) => data.issueLabels,
    );
    live.labels = new Map(
      labels.flatMap((item) => {
        const label = readLabel(item);
        return label ? [[label.id, label]] : [];
      }),
    );
    this.renameLabels(connection, live);
  }
  /** A label renamed there is the same label: no card has changed, and none may bring the old one back. */
  private renameLabels(connection: TrackerConnection, live: Live): void {
    const names = (live.memory.labels ??= {});
    const renamed = new Map<string, string>();
    for (const label of live.labels.values()) {
      const was = names[label.id];
      if (was && was !== label.name) renamed.set(was, label.name);
      names[label.id] = label.name;
    }
    if (!renamed.size) return;
    const now = (list: string[]) => list.map((name) => renamed.get(name) ?? name);
    for (const task of this.tasksOf(connection)) {
      const base = live.memory.items[task.id];
      if (!base || !Array.isArray(base.there.labels)) continue;
      if (!base.there.labels.some((name) => renamed.has(name))) continue;
      task.labels = now(task.labels ?? []);
      base.there.labels = sorted(now(base.there.labels));
      if (Array.isArray(base.here.labels)) base.here.labels = sorted(now(base.here.labels));
    }
  }

  private frame(connection: TrackerConnection, live: Live): Frame {
    return {
      state: this.deps.state(),
      connection,
      statuses: new Map((connection.statuses ?? []).map((item) => [item.id, item])),
      labels: live.labels,
      people: new Map((connection.people ?? []).map((item) => [item.id, item])),
    };
  }

  // ── Bringing work in ────────────────────────────────────────────────────────

  async import(
    id: string,
    choices: TrackerChoices,
    onProgress?: (done: number) => void,
  ): Promise<{ tasks: number; goals: number; comments: number }> {
    return this.inTurn(id, async () => {
      const connection = this.connection(id);
      const live = await this.memoryOf(id);
      this.assertBoard(connection);
      this.assertKeeper(connection);
      const handOver = (live.handOver ?? 0) - this.now();
      if (handOver > 0 && this.deps.timers !== false)
        await new Promise((resolve) => setTimeout(resolve, handOver));
      const formerly = live.memory.rested ?? connection.choices;
      connection.choices = checked(choices, this.deps.state(), connection.projectId);
      delete connection.problem;
      const woken = this.wake(connection, live);
      this.noticeDeleted(connection, live);
      delete live.memory.undone;
      delete live.memory.leftGoals;
      await this.loadLists(connection, live);
      const startedAt = this.at();
      this.chosenAnew(connection, live, formerly, startedAt);
      const before = counts(this.deps.state(), connection.projectId);
      const issues = (
        await this.api(id).all<unknown>(
          "Issues",
          { filter: scopeFilter(choices.teamId, choices.scope) },
          (data) => data.issues,
        )
      ).flatMap((item) => {
        const issue = readIssue(item);
        // What a person took out of the project stays out.
        return issue && !issue.gone && !live.memory.left.includes(issue.id) ? [issue] : [];
      });
      // Oldest first, so that numbers here follow the order they were written there.
      issues.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
      const parents = choices.goals === "parents" ? parentGoals(issues) : new Set<string>();
      for (const issue of issues)
        if (parents.has(issue.id)) this.goalFromParent(connection, live, issue);
      const tasks = issues.filter((issue) => !parents.has(issue.id));
      for (const [index, issue] of tasks.entries()) {
        const known = taskOf(this.frame(connection, live), issue.id);
        const history = await this.whenChanged(connection, live, issue);
        if (known && live.memory.items[known.id])
          this.takeIssue(connection, live, issue, history);
        else this.bringIn(connection, live, issue, history);
        if (index % 25 === 0) onProgress?.(index);
      }
      this.linkParents(connection, live, tasks);
      observePlanning(this.deps.state(), startedAt);
      if (!live.memory.issuesUntil) {
        live.memory.issuesUntil = later(...issues.map((issue) => issue.updatedAt)) ?? startedAt;
        // A change made while this was reading is found by the next look.
        if (live.memory.issuesUntil > startedAt) live.memory.issuesUntil = startedAt;
      }
      // What changed since the last look, and is not among these, is found by the next one.
      const comments = await this.importComments(connection, live, tasks);
      live.memory.commentsUntil ??= startedAt;
      // Cards that were in step before may not be in what was brought in now.
      if (woken) delete live.memory.comparedAt;
      else live.memory.comparedAt = startedAt;
      delete live.memory.since;
      connection.importedAt ??= startedAt;
      this.becomeKeeper(connection);
      connection.undoUntil = new Date(this.now() + undoDays * 86_400_000).toISOString();
      connection.lastCheckedAt = this.at();
      await this.save(live);
      if (woken) await live.file.forgetResting(this.placeOf(connection));
      const after = counts(this.deps.state(), connection.projectId);
      return {
        tasks: after.tasks - before.tasks,
        goals: after.goals - before.goals,
        comments,
      };
    });
  }

  private assertKeeper(connection: TrackerConnection): void {
    if (!this.isKeeper(connection))
      throw new Error(
        `${this.keeperOf(connection)!.by} keeps this project in step with Linear already.`,
      );
  }
  /** It was in step before it was disconnected: what was agreed on then counts again. */
  private wake(connection: TrackerConnection, live: Live): boolean {
    const { rested } = live.memory;
    if (!rested) return false;
    if (rested.teamId !== connection.choices!.teamId) {
      live.memory = emptyMemory();
      return false;
    }
    delete live.memory.rested;
    const frame = this.frame(connection, live);
    const tasks = this.tasksOf(connection);
    // Connecting again brings back what was deleted here. An unlinked card stays unlinked.
    const here = new Set(tasks.flatMap((task) => [task.id, task.tracker?.id ?? task.id]));
    live.memory.left = live.memory.left.filter((id) => here.has(id));
    for (const id of Object.keys(live.memory.items))
      if (!here.has(id)) delete live.memory.items[id];
    for (const task of tasks) {
      const base = live.memory.items[task.id];
      if (!base || !task.tracker) continue;
      // Nobody was looking when it was changed here: at the earliest, after that.
      asOld(task, base, frame, rested.at);
      if (task.tracker.note === disconnected) this.stand(task, "synced");
    }
    return true;
  }
  /** What is chosen now is for what comes: nothing that was made before it is sent. */
  private chosenAnew(
    connection: TrackerConnection,
    live: Live,
    was: { direction: string; goals: string; createIssues?: boolean } | undefined,
    at: string,
  ): void {
    const { choices } = connection;
    if (!choices) return;
    const frame = this.frame(connection, live);
    const sends = choices.direction === "both";
    const creates = sends && choices.createIssues;
    if (was?.direction === "in" && sends) {
      for (const task of this.tasksOf(connection)) {
        const base = live.memory.items[task.id];
        if (base) agreeAsIs(task, base, frame);
      }
      for (const comment of this.deps.state().storyComments ?? []) {
        const known = live.memory.comments[comment.id];
        if (known && comment.deletedAt) delete live.memory.comments[comment.id];
        else if (known) known.here = comment.text;
      }
      for (const { task, url } of this.unlinkedPullRequests(connection, live))
        (live.memory.linked[task.id] ??= []).push(url);
    }
    if (was && was.goals !== choices.goals)
      for (const task of this.tasksOf(connection)) {
        const base = live.memory.items[task.id];
        if (base) goalsChosenAnew(task, base);
      }
    const sent = connection.importedAt && was?.direction === "both";
    connection.sendsSince = sends ? (sent ? (connection.sendsSince ?? connection.importedAt) : at) : undefined;
    const made = sent && was?.createIssues;
    connection.createsSince = creates ? (made ? (connection.createsSince ?? connection.importedAt) : at) : undefined;
  }

  /** The cards an undone import would take out, and how many it would leave. */
  private undoable(
    connection: TrackerConnection,
    live: Live,
  ): { gone: Set<string>; kept: number } {
    const frame = this.frame(connection, live);
    const state = this.deps.state();
    const touched = (task: WorkItem) => {
      const base = live.memory.items[task.id];
      return (
        // Made here, or here before: it was not brought in.
        !base?.brought ||
        base.mine ||
        isActive(task) ||
        !!task.run.startedAt ||
        !same(hereOf(task, frame), base.here) ||
        base.made !== besides(task) ||
        state.artifacts?.some((artifact) => artifact.taskId === task.id) ||
        state.storyComments?.some(
          (comment) =>
            comment.taskId === task.id && !comment.deletedAt && comment.author.source !== "linear",
        )
      );
    };
    const ours = state.tasks.filter((task) => task.projectId === connection.projectId);
    const brought = ours.filter((task) => live.memory.items[task.id]);
    const gone = new Set(brought.filter((task) => !touched(task)).map((task) => task.id));
    // What stays may build on a card: then that stays too.
    for (let more = true; more; ) {
      more = false;
      for (const task of ours)
        if (!gone.has(task.id))
          for (const id of [
            task.parentId,
            task.duplicateOf,
            ...(task.dependsOn ?? []),
            ...(task.relatedIds ?? []),
          ])
            if (id && gone.delete(id)) more = true;
    }
    return { gone, kept: brought.length - gone.size };
  }
  async undoPreview(id: string): Promise<{ removed: number; kept: number }> {
    const connection = this.connection(id);
    const { gone, kept } = this.undoable(connection, await this.memoryOf(id));
    return { removed: gone.size, kept };
  }

  /** Takes back what an import brought and nobody has touched since. Linear is not told. */
  async undoImport(id: string): Promise<{ removed: number; kept: number }> {
    return this.inTurn(id, async () => {
      const connection = this.connection(id);
      if (!connection.undoUntil || connection.undoUntil < this.at())
        throw new Error("An import can be taken back for seven days.");
      this.assertBoard(connection);
      this.assertKeeper(connection);
      const live = await this.memoryOf(id);
      const state = this.deps.state();
      const { gone, kept } = this.undoable(connection, live);
      state.tasks = state.tasks.filter((task) => !gone.has(task.id));
      state.storyComments = state.storyComments?.filter((comment) => !gone.has(comment.taskId));
      for (const task of state.tasks) {
        if (task.parentId && gone.has(task.parentId)) task.parentId = null;
        if (task.dependsOn) task.dependsOn = task.dependsOn.filter((item) => !gone.has(item));
      }
      const used = (key: "epicId" | "cycleId", value: string) =>
        state.tasks.some((task) => task[key] === value);
      state.epics = state.epics.filter(
        (epic) =>
          epic.projectId !== connection.projectId || !epic.tracker || used("epicId", epic.id),
      );
      // Taken out with the rest, and not by a person.
      for (const epicId of Object.keys(live.memory.goals))
        if (!state.epics.some((epic) => epic.id === epicId)) delete live.memory.goals[epicId];
      state.cycles = state.cycles.filter(
        (cycle) =>
          cycle.projectId !== connection.projectId || !cycle.tracker || used("cycleId", cycle.id),
      );
      for (const taskId of gone) {
        (live.memory.undone ??= []).push(live.memory.items[taskId].issue);
        delete live.memory.items[taskId];
      }
      if (!kept) {
        delete connection.importedAt;
        delete connection.choices;
        state.trackerKeepers = state.trackerKeepers?.filter((item) => item.connection !== id);
        live.memory = emptyMemory();
      }
      delete connection.undoUntil;
      await this.save(live);
      return { removed: gone.size, kept };
    });
  }

  private bringIn(
    connection: TrackerConnection,
    live: Live,
    issue: Issue,
    history?: History,
  ): WorkItem {
    const state = this.deps.state();
    const frame = this.frame(connection, live);
    const known = taskOf(frame, issue.id) ?? this.madeHere(connection, live, issue);
    if (known) {
      // It was here before: connected again, brought in by another computer, or made
      // from here with an answer that got lost.
      if (live.memory.items[known.id]) return known;
      const since = known.tracker ? this.agreedSince(connection, live) : issue.createdAt;
      this.track(known, issue, frame);
      const there = thereOf(issue, frame);
      if (there.goal && !goalOf(frame, there.goal)) this.goalFor(connection, live, there.goal);
      const base = reunited(known, issue, frame, history, since);
      live.memory.items[known.id] = base;
      mergeIssue(known, issue, base, frame, this.at());
      this.stand(known, observe(known, base, frame, this.at()).differs ? "sending" : "synced");
      return known;
    }
    const at = this.at();
    const free = uuid.test(issue.id) && !state.tasks.some((task) => task.id === issue.id);
    const task: WorkItem = {
      id: free ? issue.id : randomUUID(),
      identifier: nextIdentifier(state, connection.projectId),
      projectId: connection.projectId,
      title: issue.title,
      description: "",
      stage: "planned",
      priority: "none",
      category: "Work",
      harness: state.settings.defaultHarness,
      assignment: "auto",
      kind: kindOf(issue, live.labels),
      epicId: null,
      checklist: newRunbook(undefined, randomUUID),
      messages: [{ id: randomUUID(), role: "user", text: issue.title, at }],
      run: { state: "idle" },
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
    this.track(task, issue, frame);
    state.tasks.push(task);
    const there = thereOf(issue, frame);
    if (there.goal && !goalOf(frame, there.goal)) this.goalFor(connection, live, there.goal);
    const notes: string[] = [];
    for (const field of Object.keys(there) as TrackedField[]) {
      if (field === "title" || field === "parent") continue;
      const result = applyThere(task, field, there[field], frame, at);
      if ("refused" in result) notes.push(result.refused);
    }
    task.createdAt = issue.createdAt;
    task.updatedAt = issue.updatedAt;
    live.memory.items[task.id] = {
      ...baseFor(task, issue, frame),
      brought: true,
      made: besides(task),
    };
    this.stand(task, notes[0] ? "attention" : "synced", notes[0]);
    return task;
  }
  /** When the cards here were known to be as Linear had them, where nothing more is remembered. */
  private agreedSince = (connection: TrackerConnection, live: Live) =>
    live.memory.since ?? connection.importedAt;

  /** The task here an issue was made of, when Linear's answer never came. */
  private madeHere(
    connection: TrackerConnection,
    live: Live,
    issue: Issue,
  ): WorkItem | undefined {
    return this.tasksOf(connection).find(
      (task) =>
        !task.tracker && (task.id === issue.id || live.memory.making?.[task.id] === issue.id),
    );
  }
  private track(task: WorkItem, issue: Issue, frame: Frame): void {
    task.tracker = {
      ...(task.tracker?.id === issue.id ? task.tracker : {}),
      provider: "linear",
      id: issue.id,
      key: issue.key,
      url: issue.url,
      kind: "issue",
      status: frame.statuses.get(issue.statusId)?.name,
      standing: task.tracker?.standing ?? "synced",
    };
  }
  private stand(
    task: WorkItem,
    standing: NonNullable<WorkItem["tracker"]>["standing"],
    note?: string,
  ): void {
    if (!task.tracker) return;
    task.tracker.standing = standing;
    if (note) task.tracker.note = note;
    else delete task.tracker.note;
  }

  private linkParents(connection: TrackerConnection, live: Live, issues: Issue[]): void {
    const frame = this.frame(connection, live);
    for (const issue of issues) {
      const task = taskOf(frame, issue.id);
      const base = task && live.memory.items[task.id];
      if (!task || !base || !base.there.parent) continue;
      const result = applyThere(task, "parent", base.there.parent, frame, task.updatedAt);
      task.updatedAt = issue.updatedAt;
      if ("done" in result) base.here.parent = task.parentId ?? null;
    }
  }

  /** The goal a milestone or project is, made when its first issue comes in. */
  private goalFor(connection: TrackerConnection, live: Live, ref: string): Epic | undefined {
    if (live.memory.leftGoals?.includes(ref)) return undefined;
    const [kind, id] = ref.split(":");
    const project =
      kind === "project"
        ? live.projects.find((item) => item.id === id)
        : live.projects.find((item) => item.milestones.some((one) => one.id === id));
    if (!project) return undefined;
    const milestone = project.milestones.find((item) => item.id === id);
    const title = milestone ? milestone.name : project.name;
    const shown = milestone ? `${milestone.name} · ${project.name}` : project.name;
    return this.addGoal(connection, live, {
      id: id!,
      kind: kind as "milestone" | "project",
      url: project.url,
      title,
      shown,
      description: (milestone?.description || project.description).slice(0, longestDescription),
      phase:
        project.status === "started" ? "now" : project.status === "planned" ? "next" : "later",
      within: milestone ? project.id : undefined,
    });
  }
  private goalFromParent(connection: TrackerConnection, live: Live, issue: Issue): void {
    const status = connection.statuses?.find((item) => item.id === issue.statusId);
    this.addGoal(connection, live, {
      id: issue.id,
      kind: "parent",
      url: issue.url,
      key: issue.key,
      title: issue.title,
      shown: issue.title,
      description: issue.description.slice(0, longestDescription),
      phase:
        status?.type === "started" ? "now" : status?.type === "unstarted" ? "next" : "later",
    });
  }
  private addGoal(
    connection: TrackerConnection,
    live: Live,
    goal: {
      id: string;
      kind: "milestone" | "project" | "parent";
      url?: string;
      key?: string;
      title: string;
      shown: string;
      description: string;
      phase: Epic["phase"];
      within?: string;
    },
  ): Epic {
    const state = this.deps.state();
    const known = state.epics.find(
      (epic) =>
        epic.projectId === connection.projectId &&
        // Made by a MemCode whose word about what it is has not come here.
        (epic.tracker?.id === goal.id || (!epic.tracker && epic.id === goal.id)),
    );
    const number =
      state.epics.filter((epic) => epic.projectId === connection.projectId).length + 1;
    const free = uuid.test(goal.id) && !state.epics.some((epic) => epic.id === goal.id);
    const epic: Epic = known ?? {
      id: free ? goal.id : randomUUID(),
      projectId: connection.projectId,
      identifier: `EP-${String(number).padStart(2, "0")}`,
      title: goal.shown,
      description: goal.description,
      phase: goal.phase,
      color: (["mint", "cyan", "lavender", "amber"] as const)[number % 4],
      order: number,
    };
    epic.tracker = {
      provider: "linear",
      id: goal.id,
      kind: goal.kind,
      ...(goal.key ? { key: goal.key } : {}),
      ...(goal.url ? { url: goal.url } : {}),
      ...(goal.within ? { within: goal.within } : {}),
    };
    if (!known) state.epics.push(epic);
    live.memory.goals[epic.id] ??= {
      title: goal.title,
      description: goal.description,
      shown: goal.shown,
      ref: `${goal.kind}:${goal.id}`,
    };
    return epic;
  }
  /** A goal that was renamed there is renamed here, unless it has a name of its own here. */
  private applyGoalNames(connection: TrackerConnection, live: Live): void {
    const state = this.deps.state();
    for (const epic of state.epics) {
      const remembered = live.memory.goals[epic.id];
      if (epic.projectId !== connection.projectId || !epic.tracker || !remembered) continue;
      const project = live.projects.find(
        (item) => item.id === epic.tracker!.id || item.id === epic.tracker!.within,
      );
      const milestone = project?.milestones.find((item) => item.id === epic.tracker!.id);
      if (!project || (epic.tracker.kind === "milestone" && !milestone)) continue;
      const shown = milestone ? `${milestone.name} · ${project.name}` : project.name;
      const description = (milestone?.description || project.description).slice(
        0,
        longestDescription,
      );
      if (epic.title === remembered.shown) epic.title = shown;
      if (epic.description === remembered.description) epic.description = description;
      live.memory.goals[epic.id] = {
        ...remembered,
        title: milestone?.name ?? project.name,
        shown,
        description,
      };
    }
  }

  private applyCycles(
    connection: TrackerConnection,
    cycles: ReturnType<typeof readCycle>[],
  ): void {
    const state = this.deps.state();
    const zone = connection.team?.timeZone || "UTC";
    const at = this.at();
    for (const cycle of cycles) {
      if (!cycle || cycle.gone) continue;
      const stage = cycle.completedAt ? "completed" : cycle.isActive ? "active" : "planned";
      const known = state.cycles.find(
        (item) =>
          item.projectId === connection.projectId &&
          (item.tracker?.id === cycle.id || (!item.tracker && item.id === cycle.id)),
      );
      if (known) known.tracker ??= { provider: "linear", id: cycle.id, kind: "cycle" };
      // A past cycle nobody has seen here is history of another place.
      if (!known && stage === "completed") continue;
      const fields = {
        name: cycle.name,
        goal: cycle.description.slice(0, 2000),
        startDate: dayIn(cycle.startsAt, zone),
        // Linear ends a cycle at the midnight after its last day.
        endDate: dayIn(new Date(Date.parse(cycle.endsAt) - 1).toISOString(), zone),
        timeZone: zone,
      };
      const free = !state.cycles.some((item) => item.id === cycle.id);
      const item =
        known ??
        ({
          id: free ? cycle.id : randomUUID(),
          projectId: connection.projectId,
          state: "planned",
          capacity: null,
          calendar: "weekdays",
          createdAt: at,
          snapshots: [],
          tracker: { provider: "linear", id: cycle.id, kind: "cycle" },
          ...fields,
        } as AppState["cycles"][number]);
      if (!known) state.cycles.push(item);
      Object.assign(item, fields);
      if (item.state === "planned" && stage !== "planned") {
        item.state = "active";
        item.startedAt = cycle.startsAt;
        item.baseline = cycleSnapshot(state, item.id, at);
      }
      if (item.state === "active" && stage === "completed") {
        item.snapshots.push(cycleSnapshot(state, item.id, at));
        item.state = "completed";
        item.completedAt = cycle.completedAt!;
      }
    }
  }

  private async importComments(
    connection: TrackerConnection,
    live: Live,
    issues: Issue[],
  ): Promise<number> {
    let count = 0;
    for (let from = 0; from < issues.length; from += 50) {
      const nodes = await this.api(connection.id).all<unknown>(
        "Comments",
        { filter: { issue: { id: { in: issues.slice(from, from + 50).map((item) => item.id) } } } },
        (data) => data.comments,
      );
      const comments = nodes.flatMap((item) => readComment(item) ?? []);
      count += this.takeComments(connection, live, comments);
    }
    return count;
  }

  /** Comments from Linear on the cards here. Answers how many were new. */
  private takeComments(
    connection: TrackerConnection,
    live: Live,
    comments: Comment[],
  ): number {
    const state = this.deps.state();
    const frame = this.frame(connection, live);
    const list = (state.storyComments ??= []);
    let added = 0;
    // A comment before its replies.
    for (const comment of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const task = taskOf(frame, comment.issueId);
      if (!task) continue;
      const known = list.find(
        (item) =>
          item.taskId === task.id && (item.id === comment.id || item.tracker?.id === comment.id),
      );
      const text = comment.body.slice(0, longestComment);
      if (known) {
        const agreedOn = live.memory.comments[known.id];
        known.tracker ??= { provider: "linear", id: comment.id, kind: "comment" };
        if (comment.gone) {
          known.deletedAt ??= comment.updatedAt;
          continue;
        }
        if (agreedOn && agreedOn.there === comment.body) continue;
        // Written there after it was written here.
        if (!agreedOn || known.text === agreedOn.here) {
          if (agreedOn || known.author.source === "linear") known.text = text;
          known.updatedAt = comment.updatedAt;
        }
        live.memory.comments[known.id] = { here: known.text, there: comment.body };
        continue;
      }
      if (comment.gone || !text.trim()) continue;
      const root = comment.parentId
        ? list.find(
            (item) => item.tracker?.id === comment.parentId || item.id === comment.parentId,
          )
        : undefined;
      const id = list.some((item) => item.id === comment.id) ? randomUUID() : comment.id;
      list.push({
        id,
        taskId: task.id,
        text,
        author: { ...personOf(comment.author), source: "linear" },
        ...(root ? { parentId: root.parentId ?? root.id } : {}),
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        tracker: { provider: "linear", id: comment.id, kind: "comment" },
      });
      live.memory.comments[id] = { here: text, there: comment.body };
      added++;
    }
    return added;
  }

  // ── Staying in step ─────────────────────────────────────────────────────────

  start(): void {
    if (this.deps.timers === false || this.interval) return;
    this.interval = setInterval(() => void this.lookAtAll(), lookEveryMs);
    this.interval.unref?.();
    void this.lookAtAll();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.interval);
    for (const live of this.live.values()) clearTimeout((await live).timer);
    await Promise.allSettled(this.turns.values());
    for (const live of this.live.values()) await (await live).file.settled();
  }
  private hasProject = (connection: TrackerConnection) =>
    this.deps.state().projects.some((item) => item.id === connection.projectId);
  /** A project was deleted: its sign-in and what was remembered about it go too. */
  private forgetDeleted(): void {
    for (const connection of this.all())
      if (!this.hasProject(connection)) void this.disconnect(connection.id).catch(() => {});
    const state = this.deps.state();
    const isHere = (keeper: TrackerKeeper) =>
      state.projects.some((item) => item.id === keeper.projectId);
    if (state.trackerKeepers && !state.trackerKeepers.every(isHere))
      state.trackerKeepers = state.trackerKeepers.filter(isHere);
  }
  private async lookAtAll(): Promise<void> {
    this.forgetDeleted();
    for (const connection of this.all())
      try {
        if (!this.isKeeper(connection)) this.rest(connection);
        else if (this.isLive(connection)) {
          this.waiting.delete(connection.id);
          const live = await this.memoryOf(connection.id);
          if (live.notBefore <= this.now()) await this.sync(connection.id);
        } else if (this.isOn(connection)) this.waitForBoard(connection);
      } catch {
        // The connection says why, and the next look tries again.
      }
  }
  private isOn = (connection: TrackerConnection) =>
    !this.stopped &&
    !!connection.importedAt &&
    !!connection.choices &&
    !connection.paused &&
    this.hasProject(connection) &&
    this.isKeeper(connection);
  private isLive = (connection: TrackerConnection) =>
    this.isOn(connection) && this.boardIsHere(connection);

  /** The workspace changed: what is linked is compared, and sent shortly after. */
  noticed(): void {
    if (this.stopped) return;
    this.forgetDeleted();
    for (const connection of this.all()) {
      if (!this.isLive(connection)) continue;
      const look = this.memoryOf(connection.id).then((live) => {
        if (!this.isLive(connection)) return;
        const { found, marked } = this.differs(connection, live);
        // When it was changed is kept at once: it decides which value is newer.
        if (marked) void live.file.save(live.memory).catch(() => {});
        if (!found || live.timer || this.deps.timers === false) return;
        const wait = Math.max(settleMs, live.notBefore - this.now());
        live.timer = setTimeout(() => {
          live.timer = undefined;
          // What is sent rests on the issue as it is, so a whole look can wait for its turn.
          void this.sync(connection.id, "send").catch(() => {});
        }, wait);
        live.timer.unref?.();
      });
      // The next look finds what this one could not.
      look.catch(() => {});
    }
  }
  /** Whether there is something here Linear has not heard. Marks the cards it is on. */
  private differs(
    connection: TrackerConnection,
    live: Live,
  ): { found: boolean; marked: boolean } {
    const frame = this.frame(connection, live);
    const at = this.at();
    let found = false,
      marked = false;
    for (const task of this.tasksOf(connection)) {
      const base = live.memory.items[task.id];
      if (!base || !task.tracker) {
        if (this.becomesIssue(connection, live, task)) found = true;
        continue;
      }
      const seen = observe(task, base, frame, at);
      marked ||= seen.marked;
      if (task.tracker.standing === "unlinked") continue;
      if (connection.choices?.direction !== "in") {
        if (seen.differs && task.tracker.standing === "synced") task.tracker.standing = "sending";
        // One that waits or is refused is asked again only when it has changed.
        if (seen.marked || task.tracker.standing === "sending") found = true;
      }
      if (mayFollowNow(task, base) || takenBack(task, base, frame)) found = true;
    }
    return {
      found:
        found ||
        this.unsentComments(connection, live).length > 0 ||
        this.unlinkedPullRequests(connection, live).length > 0,
      marked,
    };
  }
  private tasksOf(connection: TrackerConnection): WorkItem[] {
    return this.deps
      .state()
      .tasks.filter((task) => task.projectId === connection.projectId && !task.example);
  }

  /** A person wants to see it now: goals, cycles, people and labels too. */
  async look(id: string): Promise<void> {
    const connection = this.connection(id);
    if (this.isKeeper(connection)) this.assertBoard(connection);
    (await this.memoryOf(connection.id)).listsAt = 0;
    await this.sync(id);
    await this.deps.changed();
  }

  /** One look at Linear and one send, or only the send. Safe to call at any time. */
  sync(id: string, only?: "send"): Promise<void> {
    return this.inTurn(id, async () => {
      const connection = this.connection(id);
      if (!this.isLive(connection)) return;
      const live = await this.memoryOf(id);
      const before = this.print(connection);
      if (!this.keeperOf(connection)) this.becomeKeeper(connection);
      this.noticeDeleted(connection, live);
      try {
        // A send needs the lists once; only a look keeps them fresh.
        const lists = only === "send" ? !live.listsAt : this.now() - live.listsAt > listsEveryMs;
        if (lists) await this.loadLists(connection, live);
        if (only !== "send") {
          await this.take(connection, live);
          if (lists) await this.takeUntold(connection, live);
        }
        await this.send(connection, live);
        if (
          only !== "send" &&
          (!live.memory.comparedAt ||
            this.now() - Date.parse(live.memory.comparedAt) > compareEveryMs ||
            this.unremembered(connection, live).length)
        )
          await this.compare(connection, live);
        // A send may have had nothing to say, and then proves nothing.
        if (only !== "send") {
          delete connection.problem;
          live.failures = 0;
          live.notBefore = 0;
          connection.lastCheckedAt = this.at();
        }
      } catch (error) {
        this.failed(connection, live, error as Error);
        if (!(error instanceof TrackerUnavailable) && !(error instanceof SignInEnded)) throw error;
      } finally {
        if (this.print(connection) !== before) await this.deps.changed();
        await live.file.save(live.memory);
      }
    });
  }
  /** A card or goal deleted here is not brought in again. Nothing there is changed. */
  private noticeDeleted(connection: TrackerConnection, live: Live): void {
    for (const [epicId, goal] of Object.entries(live.memory.goals))
      if (!this.deps.state().epics.some((epic) => epic.id === epicId)) {
        delete live.memory.goals[epicId];
        if (goal.ref) (live.memory.leftGoals ??= []).push(goal.ref);
      }
    const here = new Set(this.tasksOf(connection).map((task) => task.id));
    for (const [taskId, base] of Object.entries(live.memory.items))
      if (!here.has(taskId)) {
        delete live.memory.items[taskId];
        if (!live.memory.left.includes(base.issue)) live.memory.left.push(base.issue);
      }
  }
  private failed(connection: TrackerConnection, live: Live, error: Error): void {
    connection.problem = error.message;
    live.failures++;
    const wait =
      (error instanceof TrackerUnavailable && error.retryAfterMs) ||
      (error instanceof SignInEnded
        ? 24 * 3_600_000
        : Math.min(lookEveryMs * 2 ** (live.failures - 1), 300_000));
    live.notBefore = this.now() + wait;
  }

  /** What changed in Linear since the last look. */
  private async take(connection: TrackerConnection, live: Live): Promise<void> {
    const teamId = connection.choices!.teamId;
    const since = (until: string | undefined) =>
      new Date(Date.parse(until ?? connection.importedAt!) - overlapMs).toISOString();
    const found = await this.api(connection.id).all<unknown>(
      "Issues",
      {
        filter: {
          team: { id: { eq: teamId } },
          // An issue that is deleted or archived keeps the time it was last updated.
          or: [
            { updatedAt: { gt: since(live.memory.issuesUntil) } },
            { archivedAt: { gt: since(live.memory.issuesUntil) } },
          ],
        },
      },
      (data) => data.issues,
    );
    const issues = found
      .flatMap((item) => readIssue(item) ?? [])
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    if (issues.some((issue) => this.isUnknown(connection, live, issue)))
      await this.loadLists(connection, live);
    for (const issue of issues)
      this.takeIssue(connection, live, issue, await this.whenChanged(connection, live, issue));
    if (issues.length) this.linkParents(connection, live, issues);
    live.memory.issuesUntil = later(
      live.memory.issuesUntil,
      ...issues.map((issue) => issue.updatedAt),
    );
    const words = await this.api(connection.id).all<unknown>(
      "Comments",
      {
        filter: {
          issue: { team: { id: { eq: teamId } } },
          updatedAt: { gt: since(live.memory.commentsUntil) },
        },
      },
      (data) => data.comments,
    );
    const comments = words.flatMap((item) => readComment(item) ?? []);
    this.takeComments(connection, live, comments);
    live.memory.commentsUntil = later(
      live.memory.commentsUntil,
      ...comments.map((comment) => comment.updatedAt),
    );
  }
  /**
   * What Linear tells nobody about: an issue that is put back or moved to another team, or
   * that can no longer be seen, and a comment that is deleted. So they are asked about by name.
   */
  private async takeUntold(connection: TrackerConnection, live: Live): Promise<void> {
    const teamId = connection.choices!.teamId;
    const talked = new Set(
      (this.deps.state().storyComments ?? [])
        .filter((comment) => !comment.deletedAt && live.memory.comments[comment.id])
        .map((comment) => comment.taskId),
    );
    const all = this.tasksOf(connection).filter(
      (task) =>
        task.tracker &&
        (away.has(task.tracker.note ?? "")
          ? !live.memory.left.includes(task.tracker.id)
          : // What is done or put away here has nothing to hear, but for what was said on it.
            live.memory.items[task.id] &&
            !task.archivedAt &&
            (task.stage !== "done" || talked.has(task.id))),
    );
    const from = live.standingFrom < all.length ? live.standingFrom : 0;
    const part = all.slice(from, from + standingPart);
    live.standingFrom = from + part.length;
    if (!part.length) return;
    const nodes = await this.api(connection.id).all<any>(
      "Standing",
      { filter: { id: { in: part.map((task) => task.tracker!.id) } } },
      (data) => data.issues,
    );
    const there = new Map<string, string>();
    for (const node of nodes)
      if (typeof node?.id === "string")
        there.set(
          node.id,
          node.trashed || node.archivedAt ? "gone" : node.team?.id === teamId ? "ours" : "moved",
        );
    const changed = new Map<WorkItem, string>();
    for (const task of part) {
      const now = there.get(task.tracker!.id) ?? "missing";
      const said = away.get(task.tracker!.note ?? "") ?? "ours";
      // Once is no proof: an answer can be short.
      if (now === "missing" && said !== "missing" && !live.missing.has(task.id)) {
        live.missing.add(task.id);
        continue;
      }
      live.missing.delete(task.id);
      // Read again once when the card says otherwise, and once when it is as ever after that.
      const before = live.stood.get(task.id);
      if (now === said ? before && said === "ours" : before !== now) changed.set(task, now);
      else if (now === said) live.stood.delete(task.id);
    }
    await this.readAgain(connection, live, [...changed.keys()]);
    // Only now: what could not be read is read at the next look.
    for (const [task, now] of changed)
      if (now === "ours" && !away.has(task.tracker!.note ?? "")) live.stood.delete(task.id);
      else live.stood.set(task.id, now);
    const known = part.filter((task) => there.get(task.tracker!.id) === "ours");
    await this.takeDeletedComments(connection, live, new Set(known.map((task) => task.id)));
  }

  private async takeDeletedComments(
    connection: TrackerConnection,
    live: Live,
    of: Set<string>,
  ): Promise<void> {
    const comments = (this.deps.state().storyComments ?? [])
      .filter(
        (comment) =>
          of.has(comment.taskId) &&
          !comment.deletedAt &&
          live.memory.comments[comment.id] &&
          live.memory.comments[comment.id].there !== refusedComment,
      )
      .slice(-standingPart);
    if (!comments.length) return;
    const there = (comment: (typeof comments)[number]) => comment.tracker?.id ?? comment.id;
    const nodes = await this.api(connection.id).all<any>(
      "CommentsThere",
      { filter: { id: { in: comments.map(there) } } },
      (data) => data.comments,
    );
    const found = new Set(nodes.map((node) => node?.id));
    for (const comment of comments) {
      if (found.has(there(comment))) live.missing.delete(comment.id);
      else if (!live.missing.has(comment.id)) live.missing.add(comment.id);
      else {
        live.missing.delete(comment.id);
        comment.deletedAt = this.at();
      }
    }
  }
  /** It names a status, label, person, cycle or goal MemCode has not heard of. */
  private isUnknown(connection: TrackerConnection, live: Live, issue: Issue): boolean {
    const frame = this.frame(connection, live);
    const ref = thereOf(issue, frame).goal;
    return (
      !frame.statuses.has(issue.statusId) ||
      issue.labelIds.some((id) => !live.labels.has(id)) ||
      (!!issue.assignee && !frame.people.has(issue.assignee.id)) ||
      (!!issue.cycleId &&
        !this.deps
          .state()
          .cycles.some(
            (cycle) =>
              cycle.projectId === connection.projectId && cycle.tracker?.id === issue.cycleId,
          )) ||
      (!!ref &&
        !ref.startsWith("parent:") &&
        !live.memory.leftGoals?.includes(ref) &&
        !goalOf(frame, ref) &&
        !live.projects.some(
          (project) =>
            ref === "project:" + project.id ||
            project.milestones.some((item) => ref === "milestone:" + item.id),
        ))
    );
  }

  /** Asked only where both sides changed the same field, so that the newer one is known. */
  private async whenChanged(
    connection: TrackerConnection,
    live: Live,
    issue: Issue,
  ): Promise<History> {
    const frame = this.frame(connection, live);
    const task = taskOf(frame, issue.id) ?? this.madeHere(connection, live, issue);
    if (!task || issue.gone) return { at: {} };
    const base = live.memory.items[task.id];
    if (base ? !contested(task, issue, base, frame) : !this.apart(connection, live, task, issue))
      return { at: {} };
    try {
      const data = await this.api(connection.id).call("History", { id: issue.id });
      const nodes = data.issue?.history?.nodes;
      return { at: readHistory(nodes), reaches: historyReaches(nodes) };
    } catch (error) {
      // One issue whose history cannot be read must not stop the others.
      if (!(error instanceof TrackerRefused)) throw error;
      return { at: {} };
    }
  }
  /** Nothing is remembered of it, and Linear may have changed what differs. */
  private apart(
    connection: TrackerConnection,
    live: Live,
    task: WorkItem,
    issue: Issue,
  ): boolean {
    const since = task.tracker ? this.agreedSince(connection, live) : issue.createdAt;
    if (!since || issue.updatedAt <= since) return false;
    const frame = this.frame(connection, live);
    return !same(reunited(task, issue, frame, undefined, since), baseFor(task, issue, frame));
  }

  private takeIssue(
    connection: TrackerConnection,
    live: Live,
    issue: Issue,
    history: History = { at: {} },
  ): void {
    const frame = this.frame(connection, live);
    const task = taskOf(frame, issue.id);
    const base = task && live.memory.items[task.id];
    // Put back there. What was changed here meanwhile is still to be sent.
    if (task?.tracker?.note === deletedThere && task.archivedAt && !task.closedAs && !issue.gone)
      task.archivedAt = null;
    if (!task || !base) {
      if (live.memory.left.includes(issue.id) || live.memory.undone?.includes(issue.id)) return;
      if (task && !base) this.bringIn(connection, live, issue, history);
      else if (this.inScope(connection, issue)) {
        if (
          connection.choices!.goals === "parents" &&
          this.deps
            .state()
            .epics.some(
              (epic) => epic.projectId === connection.projectId && epic.tracker?.id === issue.id,
            )
        )
          return;
        this.bringIn(connection, live, issue, history);
      }
      return;
    }
    if (issue.gone) return this.takeGone(task, issue, frame);
    const there = thereOf(issue, frame);
    if (there.goal && !goalOf(frame, there.goal)) this.goalFor(connection, live, there.goal);
    if (issue.assignee && !frame.people.has(issue.assignee.id)) {
      // Someone outside the team: known by name, so the card can show them.
      connection.people = [...(connection.people ?? []), issue.assignee];
      frame.people.set(issue.assignee.id, issue.assignee);
    }
    observe(task, base, frame, this.at());
    const merge = mergeIssue(task, issue, base, frame, this.at(), history.at);
    this.track(task, issue, frame);
    const refused = Object.values(merge.refused)[0];
    // What Linear refused already is not on its way.
    const open = (Object.keys(merge.push) as TrackedField[]).some(
      (field) => base.stuck?.[field]?.asked !== JSON.stringify(merge.push[field]),
    );
    this.stand(
      task,
      refused
        ? "attention"
        : merge.waits
          ? "waiting"
          : open
            ? "sending"
            : stuckNote(base)
              ? "attention"
              : "synced",
      refused ?? merge.waits ?? (open ? undefined : stuckNote(base)),
    );
  }

  private takeGone(task: WorkItem, issue: Issue, frame: Frame): void {
    this.track(task, issue, frame);
    const status = frame.statuses.get(issue.statusId);
    // Linear archives what was finished long ago. That is no news.
    if (status && !openTypes.includes(status.type)) return this.stand(task, "synced");
    if (hasUnshippedWork(task) || isActive(task))
      return this.stand(
        task,
        "attention",
        "Deleted in Linear. It has changes here that are not shipped.",
      );
    task.archivedAt ??= issue.updatedAt;
    this.stand(task, "unlinked", deletedThere);
  }

  private inScope(connection: TrackerConnection, issue: Issue): boolean {
    const { scope, teamId } = connection.choices!;
    const status = connection.statuses?.find((item) => item.id === issue.statusId);
    if (issue.gone || issue.teamId !== teamId || !status || status.type === "triage") return false;
    if (scope === "all") return true;
    if (!openTypes.includes(status.type)) return false;
    if (scope === "open") return true;
    return this.deps
      .state()
      .cycles.some(
        (cycle) =>
          cycle.projectId === connection.projectId &&
          cycle.tracker?.id === issue.cycleId &&
          cycle.state === "active",
      );
  }

  // ── Sending ─────────────────────────────────────────────────────────────────

  private async send(connection: TrackerConnection, live: Live): Promise<void> {
    for (const task of this.tasksOf(connection)) {
      if (!task.tracker) {
        if (this.becomesIssue(connection, live, task)) await this.createIssue(connection, live, task);
        continue;
      }
      const base = live.memory.items[task.id];
      if (!base || task.tracker.standing === "unlinked") continue;
      const frame = this.frame(connection, live);
      const { differs } = observe(task, base, frame, this.at());
      const speaks = connection.choices!.direction === "both";
      if (
        (speaks &&
          ((differs && !onlyStuck(task, base, frame)) || task.tracker.standing === "sending")) ||
        mayFollowNow(task, base) ||
        takenBack(task, base, frame)
      )
        await this.sendTask(connection, live, task);
    }
    for (const comment of this.unsentComments(connection, live))
      await this.sendComment(connection, live, comment);
    for (const { task, url } of this.unlinkedPullRequests(connection, live))
      await this.linkPullRequest(connection, live, task, url);
  }

  /** The issue is read again first: what is sent rests on how it is now. */
  private async sendTask(
    connection: TrackerConnection,
    live: Live,
    task: WorkItem,
  ): Promise<void> {
    const base = live.memory.items[task.id];
    let issue: Issue | null;
    try {
      issue = readIssue((await this.api(connection.id).call("Issue", { id: task.tracker!.id })).issue);
    } catch (error) {
      if (!(error instanceof NotThere)) throw error;
      issue = null;
    }
    if (!issue) return this.stand(task, "unlinked", notThere);
    if (issue.teamId !== connection.choices!.teamId) return this.stand(task, "attention", movedAway);
    if (issue.gone) return this.takeGone(task, issue, this.frame(connection, live));
    const history = await this.whenChanged(connection, live, issue);
    const frame = this.frame(connection, live);
    const merge = mergeIssue(task, issue, base, frame, this.at(), history.at);
    this.track(task, issue, frame);
    if (!Object.keys(merge.push).length) {
      delete base.stuck;
      const refused = Object.values(merge.refused)[0];
      this.stand(
        task,
        refused ? "attention" : merge.waits ? "waiting" : "synced",
        refused ?? merge.waits,
      );
      return;
    }
    const asked = (field: TrackedField) => JSON.stringify(merge.push[field]);
    const fields = Object.keys(merge.push) as TrackedField[];
    const stuck = (base.stuck ??= {});
    for (const field of Object.keys(stuck) as TrackedField[])
      if (!fields.includes(field) || stuck[field]?.asked !== asked(field)) delete stuck[field];
    const sent = hereOf(task, frame);
    const tell = async (some: TrackedField[]) => {
      const push = Object.fromEntries(
        some.map((field) => [field, merge.push[field]]),
      ) as Partial<There>;
      const labelIds = push.labels
        ? await this.labelIds(connection, live, push.labels, issue.labelIds)
        : undefined;
      const data = await this.api(connection.id).call("UpdateIssue", {
        id: issue.id,
        input: inputOf(push, frame, labelIds),
      });
      const now = readIssue(data.issueUpdate?.issue);
      if (!data.issueUpdate?.success || !now)
        throw new TrackerRefused("Linear did not take the change.");
      agreed(task, push, now, sent, base, this.frame(connection, live));
      this.track(task, now, frame);
    };
    const open = fields.filter((field) => !stuck[field]);
    try {
      if (open.length) await tell(open);
    } catch (error) {
      if (!(error instanceof TrackerRefused)) throw error;
      // One value Linear does not take must not hold back the others.
      for (const field of open)
        try {
          if (open.length === 1) throw error;
          await tell([field]);
        } catch (alone) {
          if (!(alone instanceof TrackerRefused)) throw alone;
          // Asked once. Asked again when it is something else, or when the person says so.
          stuck[field] = {
            here: JSON.stringify(sent[field]),
            asked: asked(field),
            note: `Linear refused this: ${alone.message}`,
          };
        }
    }
    const refused = stuckNote(base) ?? Object.values(merge.refused)[0];
    this.stand(
      task,
      refused ? "attention" : merge.waits ? "waiting" : "synced",
      refused ?? merge.waits,
    );
  }

  /**
   * A label here that is not there yet is made there. One on the issue that MemCode does not
   * know, such as one made a moment ago, stays on it.
   */
  private async labelIds(
    connection: TrackerConnection,
    live: Live,
    names: string[],
    on: string[] = [],
  ): Promise<string[]> {
    const ids: string[] = on.filter((id) => !live.labels.has(id));
    const named = (name: string) =>
      [...live.labels.values()].find(
        (label) => !label.isGroup && label.name.toLowerCase() === name.toLowerCase(),
      );
    for (const name of names) {
      const known = named(name);
      if (known) {
        ids.push(known.id);
        continue;
      }
      const data = await this.api(connection.id)
        .call("CreateLabel", { input: { name, teamId: connection.choices!.teamId } })
        .catch(async (error) => {
          if (!(error instanceof TrackerRefused)) throw error;
          // It is there: made by someone else, or from here with an answer that got lost.
          await this.loadLabels(connection, live);
          const there = named(name);
          if (!there) throw error;
          return { issueLabelCreate: { issueLabel: there } };
        });
      const made = readLabel(data.issueLabelCreate?.issueLabel);
      if (!made) throw new TrackerRefused(`The label ${name} could not be made.`);
      live.labels.set(made.id, made);
      ids.push(made.id);
    }
    return ids;
  }

  private becomesIssue(connection: TrackerConnection, live: Live, task: WorkItem): boolean {
    const { choices } = connection;
    return (
      !!choices?.createIssues &&
      choices.direction === "both" &&
      !task.tracker &&
      !task.keepHere &&
      !task.archivedAt &&
      !live.memory.left.includes(task.id) &&
      task.createdAt > (connection.createsSince ?? connection.importedAt!)
    );
  }

  private async createIssue(
    connection: TrackerConnection,
    live: Live,
    task: WorkItem,
  ): Promise<void> {
    const frame = this.frame(connection, live);
    const here = hereOf(task, frame);
    const nothing = emptyThere();
    const values: Partial<There> = {};
    for (const field of Object.keys(here) as TrackedField[]) {
      const said = toThere(field, here[field], frame, nothing, task);
      if (said !== undefined && !same(said, nothing[field])) values[field] = said as never;
    }
    // The same id each time it is tried: an answer that got lost makes no second issue.
    const id = uuid.test(task.id) ? task.id : (live.memory.making ??= {})[task.id] ?? randomUUID();
    if (id !== task.id) (live.memory.making ??= {})[task.id] = id;
    let issue: Issue | null = null;
    const make = async (some: Partial<There>) => {
      const labelIds = some.labels
        ? await this.labelIds(connection, live, some.labels)
        : undefined;
      const data = await this.api(connection.id).call("CreateIssue", {
        input: {
          id,
          teamId: connection.choices!.teamId,
          ...inputOf(some, frame, labelIds),
          title: task.title,
        },
      });
      return readIssue(data.issueCreate?.issue);
    };
    let without: TrackedField[] = [];
    try {
      issue = await make(values);
    } catch (error) {
      if (!(error instanceof TrackerRefused)) throw error;
      issue = await this.api(connection.id)
        .call("Issue", { id })
        .then((data) => readIssue(data.issue))
        .catch((problem) => {
          if (problem instanceof TrackerRefused) return null;
          throw problem;
        });
      const bare = (Object.keys(values) as TrackedField[]).filter(
        (field) => field !== "title" && field !== "description",
      );
      if (!issue && bare.length)
        try {
          // Made with its words alone; the rest is asked for value by value.
          const { title, description } = values;
          issue = await make({ title, ...(description ? { description } : {}) });
          without = bare;
        } catch (alone) {
          if (!(alone instanceof TrackerRefused)) throw alone;
        }
      if (!issue) {
        // It stays a task here; the card says why.
        live.memory.left.push(task.id);
        task.tracker = undefined;
        connection.problem = `${task.identifier} could not be made an issue: ${error.message}`;
        return;
      }
    }
    if (!issue) throw new TrackerUnavailable("Linear is having trouble right now.");
    this.track(task, issue, frame);
    this.stand(task, "synced");
    const now = this.frame(connection, live);
    const base = { ...baseFor(task, issue, now), here };
    unsaid(base, without, this.at());
    live.memory.items[task.id] = base;
    if (live.memory.making) delete live.memory.making[task.id];
    if (without.length) await this.sendTask(connection, live, task);
  }

  private unsentComments(connection: TrackerConnection, live: Live) {
    if (connection.choices?.direction !== "both") return [];
    const tasks = new Map(this.tasksOf(connection).map((task) => [task.id, task]));
    return (this.deps.state().storyComments ?? []).filter((comment) => {
      const task = tasks.get(comment.taskId);
      if (!task?.tracker || !live.memory.items[task.id] || task.tracker.standing === "unlinked")
        return false;
      const known = live.memory.comments[comment.id];
      if (comment.author.source === "linear") return false;
      if (known?.there === refusedComment) return false;
      if (comment.deletedAt) return !!known;
      if (!known)
        return (
          comment.createdAt > (connection.sendsSince ?? connection.importedAt!) &&
          !!comment.text.trim()
        );
      return known.here !== comment.text;
    });
  }
  private async sendComment(
    connection: TrackerConnection,
    live: Live,
    comment: NonNullable<AppState["storyComments"]>[number],
  ): Promise<void> {
    const api = this.api(connection.id);
    const task = this.deps.state().tasks.find((item) => item.id === comment.taskId)!;
    const known = live.memory.comments[comment.id];
    try {
      if (comment.deletedAt) {
        if (comment.tracker) await api.call("DeleteComment", { id: comment.tracker.id });
        delete live.memory.comments[comment.id];
        return;
      }
      const body = this.worded(connection, comment);
      if (known && comment.tracker) {
        const data = await api.call("UpdateComment", { id: comment.tracker.id, input: { body } });
        const now = readComment(data.commentUpdate?.comment);
        live.memory.comments[comment.id] = { here: comment.text, there: now?.body ?? body };
        return;
      }
      const root = (this.deps.state().storyComments ?? []).find(
        (item) => item.id === comment.parentId,
      );
      const id = uuid.test(comment.id) ? comment.id : randomUUID();
      const data = await api
        .call("CreateComment", {
          input: {
            id,
            issueId: task.tracker!.id,
            body,
            ...(root?.tracker ? { parentId: root.tracker.id } : {}),
          },
        })
        .catch(async (error) => {
          // Sent before, and the answer got lost.
          if (!(error instanceof TrackerRefused) || !/exist|unique|duplicate/i.test(error.message))
            throw error;
          return { commentCreate: { comment: null } };
        });
      const now = readComment(data.commentCreate?.comment);
      comment.tracker = { provider: "linear", id: now?.id ?? id, kind: "comment" };
      live.memory.comments[comment.id] = { here: comment.text, there: now?.body ?? body };
    } catch (error) {
      if (error instanceof NotThere && comment.deletedAt) {
        delete live.memory.comments[comment.id];
        return;
      }
      if (!(error instanceof TrackerRefused)) throw error;
      live.memory.comments[comment.id] = { here: comment.text, there: refusedComment };
      this.stand(task, "attention", `Linear refused a comment: ${error.message}`);
    }
  }
  /** MemCode writes as whoever signed in. Someone else's words say whose they are. */
  private worded(
    connection: TrackerConnection,
    comment: NonNullable<AppState["storyComments"]>[number],
  ): string {
    const own =
      comment.author.source === "local" || comment.author.name === connection.viewer.name;
    return own ? comment.text : `**${comment.author.name}**, in MemCode:\n\n${comment.text}`;
  }

  private unlinkedPullRequests(connection: TrackerConnection, live: Live) {
    if (connection.choices?.direction !== "both") return [];
    const state = this.deps.state();
    return (state.pullRequests ?? []).flatMap((record) => {
      const url = record.url;
      if (!url || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) return [];
      const goal = state.epics.find((item) => item.id === record.epicId);
      if (goal?.projectId !== connection.projectId) return [];
      return this.tasksOf(connection)
        .filter(
          (task) =>
            // By branch: a task that shipped may have been moved to another goal since.
            task.run.branch === record.branch &&
            task.tracker &&
            task.tracker.standing !== "unlinked" &&
            live.memory.items[task.id] &&
            !live.memory.linked[task.id]?.includes(url),
        )
        .map((task) => ({ task, url }));
    });
  }
  private async linkPullRequest(
    connection: TrackerConnection,
    live: Live,
    task: WorkItem,
    url: string,
  ): Promise<void> {
    const api = this.api(connection.id);
    const issue = task.tracker!.id;
    try {
      await api.call("LinkPullRequest", { issue, url }).catch((error) => {
        // Linear knows the repository only where its GitHub app is installed.
        if (!(error instanceof TrackerRefused)) throw error;
        return api.call("LinkUrl", {
          issue,
          url,
          title: `Pull request #${url.slice(url.lastIndexOf("/") + 1)}`,
        });
      });
    } catch (error) {
      if (!(error instanceof TrackerRefused)) throw error;
    }
    (live.memory.linked[task.id] ??= []).push(url);
  }

  // ── What is gone there, and what a person decides ───────────────────────────

  /** Linked cards whose agreement was lost, such as with the file that held it. */
  private unremembered(connection: TrackerConnection, live: Live): WorkItem[] {
    return this.tasksOf(connection).filter(
      (task) =>
        task.tracker &&
        task.tracker.standing !== "unlinked" &&
        !live.memory.items[task.id] &&
        !live.memory.left.includes(task.tracker.id),
    );
  }
  /** What was deleted or moved away leaves no change behind: the ids are compared. */
  private async compare(connection: TrackerConnection, live: Live): Promise<void> {
    await this.readAgain(connection, live, [
      ...this.tasksOf(connection).filter(
        (task) =>
          task.tracker && live.memory.items[task.id] && task.tracker.standing !== "unlinked",
      ),
      ...this.unremembered(connection, live),
    ]);
    live.memory.comparedAt = this.at();
  }

  /** These as they are there now, also what is gone or elsewhere. */
  private async readAgain(
    connection: TrackerConnection,
    live: Live,
    linked: WorkItem[],
  ): Promise<void> {
    const frame = this.frame(connection, live);
    for (let from = 0; from < linked.length; from += 100) {
      const part = linked.slice(from, from + 100);
      const nodes = await this.api(connection.id).all<unknown>(
        "Issues",
        { filter: { id: { in: part.map((task) => task.tracker!.id) } } },
        (data) => data.issues,
      );
      const there = new Map(
        nodes.flatMap((item) => {
          const issue = readIssue(item);
          return issue ? [[issue.id, issue] as const] : [];
        }),
      );
      for (const task of part) {
        const issue = there.get(task.tracker!.id);
        if (!issue) this.stand(task, "unlinked", notThere);
        else if (issue.teamId !== connection.choices!.teamId)
          this.stand(task, "attention", movedAway);
        else if (issue.gone) this.takeGone(task, issue, frame);
        else
          this.takeIssue(
            connection,
            live,
            issue,
            await this.whenChanged(connection, live, issue),
          );
      }
    }
  }

  /** Puts back a value that gave way, or tries again what Linear refused. */
  async restore(taskId: string, field: TrackedField): Promise<void> {
    const { connection, task } = this.tracked(taskId);
    await this.inTurn(connection.id, async () => {
      const live = await this.memoryOf(connection.id);
      const frame = this.frame(connection, live);
      const kept = task.tracker!.kept?.find((item) => item.field === field);
      const base = live.memory.items[task.id];
      if (!kept || !base) throw new Error("There is nothing to put back.");
      if (kept.from === "there") {
        const result = applyThere(task, field, kept.value as never, frame, this.at());
        if (!("done" in result))
          throw new Error("waits" in result ? result.waits : result.refused);
      } else this.putHere(task, field, kept.value as never);
      task.tracker!.kept = task.tracker!.kept!.filter((item) => item !== kept);
      base.touched[field] = this.at();
      this.stand(task, "sending");
      await this.save(live);
    });
    await this.sync(connection.id);
  }
  private putHere(task: WorkItem, field: TrackedField, value: Here[TrackedField]): void {
    const people = this.connectionOf(task)?.people ?? [];
    switch (field) {
      case "labels":
        task.labels = value as string[];
        break;
      case "assignee":
        task.assignee = people.find((person) => person.id === value) ?? null;
        break;
      case "cycle":
        task.cycleId = value as string | null;
        break;
      case "goal":
        task.epicId = value as string | null;
        break;
      case "parent":
        task.parentId = value as string | null;
        break;
      case "status": {
        const lane = workflowFor(this.deps.state(), task.projectId).find((item) => item.id === value);
        if (lane) {
          task.stage = lane.stage;
          task.statusId = lane.id;
        }
        break;
      }
      default:
        Object.assign(task, { [field]: value });
    }
    task.updatedAt = this.at();
  }

  async retry(taskId: string): Promise<void> {
    const { connection, task } = this.tracked(taskId);
    const live = await this.memoryOf(connection.id);
    const base = live.memory.items[task.id];
    if (base) delete base.stuck;
    this.stand(task, "sending");
    await this.sync(connection.id);
  }

  /** The card and the issue go their own ways. Neither is deleted. */
  async unlink(taskId: string): Promise<void> {
    const { connection, task } = this.tracked(taskId);
    await this.inTurn(connection.id, async () => {
      const live = await this.memoryOf(connection.id);
      delete live.memory.items[task.id];
      live.memory.left = [...new Set([...live.memory.left, task.id, task.tracker!.id])];
      this.stand(task, "unlinked", "Unlinked. It no longer follows the issue in Linear.");
      await this.save(live);
    });
  }

  private connectionOf(task: WorkItem): TrackerConnection | undefined {
    return this.all().find((item) => item.projectId === task.projectId);
  }
  private tracked(taskId: string) {
    const task = this.deps.state().tasks.find((item) => item.id === taskId);
    const connection = task && this.connectionOf(task);
    if (!task?.tracker || !connection) throw new Error("This task is not linked to Linear.");
    return { task, connection };
  }
}

const disconnected = "Linear was disconnected.";
const boardMissing =
  "The shared board is not connected right now. Nothing goes to or from Linear until it is.";
const deletedThere = "Deleted in Linear.";
const notThere = "This issue is no longer there for you in Linear.";
const movedAway = "Moved to another team in Linear. It no longer follows.";
/** Why an issue is not followed now, and may be again. */
const away: ReadonlyMap<string, string> = new Map([
  [deletedThere, "gone"],
  [notThere, "missing"],
  [movedAway, "moved"],
]);
const refusedComment = "\u0000refused";

const personOf = (person: Person) => ({ id: person.id, name: person.name });
const later = (...times: (string | undefined)[]): string | undefined =>
  times.filter((time): time is string => !!time).sort().at(-1);

function dayIn(at: string, zone: string): string {
  try {
    return dayAt(at, zone);
  } catch {
    return at.slice(0, 10);
  }
}

/** What a card holds besides what Linear knows of it. */
const besides = (task: WorkItem): string =>
  JSON.stringify([
    task.checklist.map((step) => [step.text, step.done]),
    task.scope ?? [],
    task.dependsOn ?? [],
    task.relatedIds ?? [],
    task.duplicateOf ?? null,
    task.customFields ?? {},
    task.startDate ?? null,
    task.kind ?? null,
    task.category,
    task.harness,
    task.modelOverride ?? null,
    task.messages.length,
  ]);

function counts(state: AppState, projectId: string) {
  return {
    tasks: state.tasks.filter((task) => task.projectId === projectId).length,
    goals: state.epics.filter((epic) => epic.projectId === projectId).length,
  };
}

function nextIdentifier(state: AppState, projectId: string): string {
  const highest = state.tasks
    .filter((task) => task.projectId === projectId)
    .reduce((most, task) => Math.max(most, Number(task.identifier.split("-").at(-1)) || 0), 0);
  return `MC-${String(highest + 1).padStart(3, "0")}`;
}

/** Linear's type labels, where a team has them, say what kind of task it is. */
function kindOf(issue: Issue, labels: Map<string, Label>): WorkItem["kind"] {
  const names = issue.labelIds.map((id) => labels.get(id)?.name.toLowerCase() ?? "");
  if (names.some((name) => /^(bug|fix|defect)$/.test(name))) return "fix";
  if (names.some((name) => /^(refactor|improvement|chore|tech debt)$/.test(name))) return "refactor";
  if (names.some((name) => /^(research|spike|investigation)$/.test(name))) return "research";
  if (names.some((name) => /^(test|testing|qa)$/.test(name))) return "test";
  return "feature";
}

/** Issues that others are part of, and that are not part of one themselves. */
function parentGoals(issues: Issue[]): Set<string> {
  const present = new Set(issues.map((issue) => issue.id));
  const children = new Set(issues.flatMap((issue) => issue.parentId ?? []));
  return new Set(
    issues
      .filter(
        (issue) =>
          children.has(issue.id) && (!issue.parentId || !present.has(issue.parentId)),
      )
      .map((issue) => issue.id),
  );
}

export function scopeFilter(teamId: string, scope: TrackerScope): Record<string, unknown> {
  return {
    team: { id: { eq: teamId } },
    ...(scope === "all"
      ? { state: { type: { neq: "triage" } } }
      : { state: { type: { in: openTypes } } }),
    ...(scope === "cycle" ? { cycle: { isActive: { eq: true } } } : {}),
  };
}

/** Where each status shows here, and which one MemCode sends for its own steps. */
export function suggest(
  state: AppState,
  projectId: string,
  teamId: string,
  statuses: TrackerStatus[],
): TrackerChoices {
  const lanes = workflowFor(state, projectId);
  const lane = (id: string) => `${projectId}:${id}`;
  const exists = (id: string) => lanes.some((item) => item.id === id);
  const reviewing = (name: string) => /review|qa|test|verif|accept|merge/i.test(name);
  const shown: Record<string, string> = {};
  for (const status of statuses) {
    const named = lanes.find((item) => item.name.toLowerCase() === status.name.toLowerCase());
    const wanted =
      status.type === "backlog" || status.type === "triage"
        ? backlogStatusId(projectId)
        : status.type === "unstarted"
          ? lane("planned")
          : status.type === "started"
            ? reviewing(status.name)
              ? lane("review")
              : lane("working")
            : lane("done");
    const own =
      named && !named.id.endsWith(":code-review") && stageFits(named.stage, status) ? named.id : wanted;
    shown[status.id] = exists(own) ? own : wanted;
  }
  const of = (type: TrackerStatus["type"]) => statuses.filter((status) => status.type === type);
  const started = of("started");
  const send = {
    backlog: of("backlog")[0]?.id ?? of("unstarted")[0]?.id,
    planned: of("unstarted")[0]?.id ?? of("backlog")[0]?.id,
    working: (started.find((status) => !reviewing(status.name)) ?? started[0])?.id,
    review: (started.find((status) => reviewing(status.name)) ?? started[0])?.id,
    done: of("completed")[0]?.id,
    canceled: of("canceled")[0]?.id,
  };
  return {
    teamId,
    scope: "open",
    goals: "milestones",
    direction: "both",
    createIssues: true,
    lanes: shown,
    send: Object.fromEntries(
      Object.entries(send).filter(([, value]) => value),
    ) as TrackerChoices["send"],
  };
}
function stageFits(stage: string, status: TrackerStatus): boolean {
  return (
    (stage === "planned" && ["backlog", "unstarted"].includes(status.type)) ||
    ((stage === "working" || stage === "review") && status.type === "started") ||
    (stage === "done" && status.type === "completed")
  );
}

/** Choices as they may be: a lane that is not here any more is the suggested one. */
function checked(choices: TrackerChoices, state: AppState, projectId: string): TrackerChoices {
  const lanes = new Set(
    workflowFor(state, projectId)
      .map((lane) => lane.id)
      .filter((id) => !id.endsWith(":code-review")),
  );
  return {
    ...choices,
    lanes: Object.fromEntries(
      Object.entries(choices.lanes).filter(([, lane]) => lanes.has(lane)),
    ),
  };
}

function emptyThere(): There {
  return {
    title: "",
    description: "",
    status: "",
    priority: 0,
    estimate: null,
    labels: [],
    assignee: null,
    dueDate: null,
    cycle: null,
    goal: null,
    parent: null,
  };
}
