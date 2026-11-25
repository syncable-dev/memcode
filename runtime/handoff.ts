import { homedir } from "node:os";
import { z } from "zod";
import {
  harnessNames,
  type AppState,
  type Epic,
  type FleetConflict,
  type Harness,
  type Settings,
  type WorkItem,
} from "../src/shared";
import { isActive } from "../src/domain";
import { isOnBranch } from "../src/goal-work";
import type { WorkerChanges } from "../src/changes";
import type { HandoffText } from "../src/handoff";
import { appVersion } from "../src/version";
import { publicReport, reportExcerpt } from "./worker-report";

type Register = (
  method: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
type ReceiptSources = Pick<
  AppState,
  "tasks" | "epics" | "fleetConflicts" | "projects"
>;
type ReadChanges = (task: WorkItem) => Promise<WorkerChanges>;

export interface StoryReceipt {
  identifier: string;
  title: string;
  harness: Harness;
  files: number;
  additions: number;
  deletions: number;
  paths: string[];
  /** The worker's own final report, with local paths made repo-relative. */
  report?: string;
  brief?: string;
}
export interface DecisionReceipt {
  kind: "human" | "coordination";
  summary: string;
  resolution?: string;
  winner?: string;
}
/** What a fleet did on one epic, measured from worker checkpoints and Fleet records. */
export interface EpicReceipt {
  identifier: string;
  title: string;
  /** The epic's reason for existing; absent for the default project epic. */
  summary?: string;
  generic: boolean;
  /** The goal has other tasks, shipped before this or still to do. */
  partial?: boolean;
  branch?: string;
  stories: StoryReceipt[];
  decisions: DecisionReceipt[];
  openConflicts: number;
  activeStories: number;
}
/** Present only when the person chose to name the orchestrator. */
export interface HandoffCredit {
  orchestratedBy?: string;
}

const commitSubjectLimit = 72;
const listedFiles = 6;
const defaultEpicSource = "project-work";
const testPlan =
  "## Test plan\n\n- [ ] I verified these changes. Test results above are the agents' own reports.";

export const handoffAttributionSchema = z.enum(["ask", "include", "omit"]);

export function registerHandoff(
  register: Register,
  state: () => AppState,
  changed: () => Promise<void>,
) {
  register(
    "settings:handoff-attribution",
    z.object({ attribution: handoffAttributionSchema }).strict(),
    async ({ attribution }) => {
      state().settings.handoffAttribution = attribution;
      await changed();
    },
  );
}

/** The MemCode line stays visible and checked until the person leaves it out. */
export function handoffCredit(settings: Settings): HandoffCredit {
  return settings.handoffAttribution === "omit"
    ? {}
    : { orchestratedBy: `MemCode ${appVersion}` };
}

export async function collectEpicReceipt(
  sources: ReceiptSources,
  epicId: string,
  readChanges: ReadChanges,
): Promise<EpicReceipt> {
  const epic = sources.epics.find((item) => item.id === epicId);
  if (!epic) throw Error("Goal not found.");
  const stories = sources.tasks.filter((task) => isOnBranch(task, epic));
  const conflicts = sources.fleetConflicts.filter((item) =>
    belongsToEpic(item, epic),
  );
  const projectPath = sources.projects.find(
    (item) => item.id === epic.projectId,
  )?.path;
  const generic = epic.sourceKey === defaultEpicSource;
  return {
    identifier: epic.identifier,
    title: epic.title,
    ...(!generic && epic.description?.trim()
      ? { summary: epic.description.trim() }
      : {}),
    generic,
    ...(sources.tasks.some(
      (task) =>
        task.epicId === epicId && !task.archivedAt && !isOnBranch(task, epic),
    )
      ? { partial: true }
      : {}),
    branch: epic.branch,
    stories: await recordedStories(stories, readChanges, projectPath),
    decisions: conflicts
      .filter((item) => item.status === "resolved")
      .map((item) => decisionReceipt(item, sources.tasks)),
    openConflicts: conflicts.filter((item) => item.status === "open").length,
    activeStories: stories.filter(isActive).length,
  };
}

function belongsToEpic(conflict: FleetConflict, epic: Epic): boolean {
  if (conflict.epicId) return conflict.epicId === epic.id;
  return (
    conflict.projectId === epic.projectId &&
    !!epic.branch &&
    conflict.branch === epic.branch
  );
}

async function recordedStories(
  stories: WorkItem[],
  readChanges: ReadChanges,
  projectPath?: string | null,
): Promise<StoryReceipt[]> {
  const measured = await Promise.all(
    stories.map(async (task) => ({ task, changes: await readChanges(task) })),
  );
  return measured
    .filter(({ changes }) => changes.files > 0)
    .map(({ task, changes }) => storyReceipt(task, changes, projectPath));
}

function storyReceipt(
  task: WorkItem,
  changes: WorkerChanges,
  projectPath?: string | null,
): StoryReceipt {
  const report = latestReport(task, projectPath);
  const brief = task.description?.trim();
  return {
    identifier: task.identifier,
    title: task.title,
    harness: task.harness,
    files: changes.files,
    additions: changes.additions,
    deletions: changes.deletions,
    paths: [
      ...new Set(
        changes.checkpoints.flatMap((item) => item.files.map((f) => f.path)),
      ),
    ],
    ...(report ? { report } : {}),
    ...(brief ? { brief } : {}),
  };
}

function latestReport(
  task: WorkItem,
  projectPath?: string | null,
): string | undefined {
  const text = task.messages
    ?.filter((message) => message.role === "assistant")
    .at(-1)
    ?.text.trim();
  if (!text) return undefined;
  return publicReport(text, {
    repositories: [task.run.workspace ?? "", projectPath ?? ""],
    home: homedir(),
  });
}

/** Conflicts recorded before resolutionKind existed were resolved by a person. */
function decisionReceipt(
  conflict: FleetConflict,
  tasks: WorkItem[],
): DecisionReceipt {
  if (conflict.resolutionKind === "coordination")
    return { kind: "coordination", summary: conflict.summary };
  const winner = tasks.find(
    (task) => task.id === conflict.winnerTaskId,
  )?.identifier;
  return {
    kind: "human",
    summary: conflict.summary,
    ...(conflict.resolution ? { resolution: conflict.resolution } : {}),
    ...(winner ? { winner } : {}),
  };
}

export function composeEpicHandoff(
  receipt: EpicReceipt,
  credit: HandoffCredit,
): HandoffText {
  return {
    title: pullRequestTitle(receipt),
    pullRequest: pullRequestText(receipt, credit),
    commitMessage: commitMessageText(receipt, credit),
  };
}

function pullRequestTitle(receipt: EpicReceipt): string {
  const [first, ...rest] = receipt.stories;
  if (!first || (!receipt.generic && !receipt.partial))
    return singleLine(receipt.title);
  if (!rest.length) return singleLine(first.title);
  return `${singleLine(first.title)} and ${counted(rest.length, "more change", "more changes")}`;
}

/** Reviewer first: what and why, each change, decisions, how to verify; provenance last. */
function pullRequestText(receipt: EpicReceipt, credit: HandoffCredit) {
  return (
    [
      summarySection(receipt),
      changesSection(receipt.stories),
      ...decisionsSection(receipt),
      testPlan,
      receiptDetails(receipt, credit),
    ].join("\n\n") + "\n"
  );
}

function summarySection(receipt: EpicReceipt): string {
  const delivered = receipt.stories.length
    ? receipt.stories
        .map((story) => `- ${singleLine(story.title)} (${story.identifier})`)
        .join("\n")
    : "- No task has recorded changes yet.";
  return [
    "## Summary",
    ...(receipt.summary ? [receipt.summary] : []),
    delivered,
  ].join("\n\n");
}

function changesSection(stories: StoryReceipt[]): string {
  return ["## Changes", ...stories.map(storyChange)].join("\n\n");
}

function storyChange(story: StoryReceipt): string {
  const heading = `### ${story.identifier} · ${singleLine(story.title)}\n_${harnessNames[story.harness]} · ${counted(story.files, "file", "files")} · +${story.additions} −${story.deletions}_`;
  const explanation = story.report
    ? reportExcerpt(story.report)
    : (story.brief ?? "The agent left no report for this task.");
  return [heading, explanation, ...fileLine(story.paths)].join("\n\n");
}

function fileLine(paths: string[]): string[] {
  if (!paths.length) return [];
  const shown = paths
    .slice(0, listedFiles)
    .map((path) => `\`${path}\``)
    .join(", ");
  const hidden = paths.length - listedFiles;
  return [`Files: ${shown}${hidden > 0 ? ` and ${hidden} more` : ""}`];
}

function decisionsSection(receipt: EpicReceipt): string[] {
  const lines = receipt.decisions
    .filter((decision) => decision.kind === "human")
    .map(reviewerDecisionLine);
  if (receipt.openConflicts) lines.push(openConflictLine(receipt.openConflicts));
  return lines.length
    ? [["## Decisions for reviewers", lines.join("\n")].join("\n\n")]
    : [];
}

function reviewerDecisionLine(decision: DecisionReceipt): string {
  const outcome = withoutFinalPeriod(
    decision.resolution ?? "Resolved by a person",
  );
  const winner = decision.winner ? ` (${decision.winner})` : "";
  return `- **${outcome}**${winner}. The agents disagreed: ${withoutFinalPeriod(decision.summary)}`;
}

function receiptDetails(receipt: EpicReceipt, credit: HandoffCredit): string {
  const agents = new Set(receipt.stories.map((story) => story.harness)).size;
  const summary = [
    "Fleet receipt",
    counted(receipt.stories.length, "task", "tasks"),
    counted(agents, "agent", "agents"),
    ...(receipt.branch ? [receipt.branch] : []),
  ].join(" · ");
  return [
    `<details>\n<summary>${summary}</summary>`,
    storyTable(receipt.stories),
    coordinationLines(receipt).join("\n"),
    ...(credit.orchestratedBy
      ? [`_Coordinated by ${credit.orchestratedBy} through Memtrace Fleet._`]
      : []),
    "</details>",
  ].join("\n\n");
}

function storyTable(stories: StoryReceipt[]): string {
  if (!stories.length)
    return "No task in this goal has recorded worker changes yet.";
  const rows = stories.map(
    (story) =>
      `| **${story.identifier}** ${tableCell(story.title)} | ${harnessNames[story.harness]} | ${story.files} | +${story.additions} −${story.deletions} |`,
  );
  return [
    "| Task | Agent | Files | Lines |",
    "| --- | --- | ---: | ---: |",
    ...rows,
  ].join("\n");
}

function coordinationLines(receipt: EpicReceipt): string[] {
  const lines = receipt.decisions.map(coordinationLine);
  return lines.length ? lines : ["- No overlaps were recorded."];
}

function coordinationLine(decision: DecisionReceipt): string {
  const summary = withoutFinalPeriod(decision.summary);
  if (decision.kind === "coordination")
    return `- **Handled by coordination:** ${summary}`;
  const outcome = withoutFinalPeriod(decision.resolution ?? "see Decisions");
  const winner = decision.winner ? ` (${decision.winner})` : "";
  return `- **Decided by a person:** ${outcome}${winner}. Conflict: ${summary}`;
}

function openConflictLine(count: number): string {
  return count === 1
    ? "- **Still open:** 1 Fleet conflict. Resolve it in Decisions before merging."
    : `- **Still open:** ${count} Fleet conflicts. Resolve them in Decisions before merging.`;
}

function commitMessageText(receipt: EpicReceipt, credit: HandoffCredit) {
  const paragraphs = [
    commitSubject(pullRequestTitle(receipt)),
    storyList(receipt.stories),
    ...commitCounts(receipt),
  ];
  if (credit.orchestratedBy)
    paragraphs.push(`Orchestrated-by: ${credit.orchestratedBy}`);
  return paragraphs.join("\n\n") + "\n";
}

function commitSubject(title: string): string {
  const subject = singleLine(title);
  if (subject.length <= commitSubjectLimit) return subject;
  return subject.slice(0, commitSubjectLimit - 1).trimEnd() + "…";
}

function storyList(stories: StoryReceipt[]): string {
  if (!stories.length) return "No task has recorded changes yet.";
  return stories
    .map(
      (story) =>
        `- ${story.identifier} ${singleLine(story.title)} (${harnessNames[story.harness]})`,
    )
    .join("\n");
}

function commitCounts(receipt: EpicReceipt): string[] {
  const humanDecisions = receipt.decisions.filter(
    (decision) => decision.kind === "human",
  ).length;
  const lines = [
    ...(humanDecisions ? [`Decisions by a person: ${humanDecisions}.`] : []),
    ...(receipt.openConflicts
      ? [`Open Fleet conflicts: ${receipt.openConflicts}.`]
      : []),
  ];
  return lines.length ? [lines.join("\n")] : [];
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function tableCell(text: string): string {
  return singleLine(text).replaceAll("|", "\\|");
}

function withoutFinalPeriod(text: string): string {
  return singleLine(text).replace(/\.+$/, "");
}
