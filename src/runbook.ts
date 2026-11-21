import { z } from "zod";
import type { ChecklistItem } from "./shared";

const maximumSteps = 100;
const maximumStepLength = 1000;

/** What every task made without a plan starts with, until someone writes its real steps. */
const standardSteps = [
  "Understand the relevant source and requirements",
  "Implement a focused change",
  "Review the result and checks",
];

/** What a worker may do to its task's runbook: tick steps it finished, add ones it found. */
export const runbookUpdateSchema = z
  .object({
    done: z
      .array(z.number().int())
      .max(maximumSteps)
      .optional()
      .describe("Numbers of the steps you have just finished, as numbered in the runbook."),
    add: z
      .array(z.string().trim().min(1).max(maximumStepLength * 2))
      .max(20)
      .optional()
      .describe("Steps the work needs that the runbook doesn't list yet."),
  })
  .strict();
export type RunbookUpdate = z.infer<typeof runbookUpdateSchema>;

const stepText = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, maximumStepLength);
const sameStep = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A new task's runbook: the planned steps, or the standard three when nobody planned it. */
export function newRunbook(steps: string[] | undefined, id: () => string): ChecklistItem[] {
  const planned = (steps ?? []).map(stepText).filter(Boolean).slice(0, maximumSteps);
  return (planned.length ? planned : standardSteps).map((text) => ({ id: id(), text, done: false }));
}

/**
 * Applies a worker's update. Steps are numbered from 1, as the worker reads them. A worker can
 * tick and add, never untick or remove; nothing to change returns the same runbook.
 */
export function updateRunbook(
  runbook: ChecklistItem[],
  update: RunbookUpdate,
  id: () => string,
): ChecklistItem[] {
  const finished = new Set(update.done ?? []);
  for (const number of finished)
    if (number < 1 || number > runbook.length)
      throw new Error(
        `Step ${number} isn't in this runbook, which has ${runbook.length} steps.`,
      );
  const added = (update.add ?? [])
    .map(stepText)
    .filter((text, at, all) => text && all.findIndex((other) => sameStep(other, text)) === at)
    .filter((text) => !runbook.some((step) => sameStep(step.text, text)));
  if (runbook.length + added.length > maximumSteps)
    throw new Error(`A runbook holds at most ${maximumSteps} steps.`);
  const ticks = runbook.some((step, index) => finished.has(index + 1) && !step.done);
  if (!ticks && !added.length) return runbook;
  return [
    ...runbook.map((step, index) =>
      finished.has(index + 1) && !step.done ? { ...step, done: true } : step,
    ),
    ...added.map((text) => ({ id: id(), text, done: false })),
  ];
}

/** The runbook as a worker reads it: numbered steps, then how far along it is. */
export function runbookText(runbook: ChecklistItem[]): string {
  if (!runbook.length) return "This task has no runbook yet.";
  const done = runbook.filter((step) => step.done).length;
  return [
    ...runbook.map((step, index) => `${index + 1}. [${step.done ? "x" : " "}] ${step.text}`),
    `${done} of ${runbook.length} steps done.`,
  ].join("\n");
}

/** The runbook section of a worker's brief; `canTick` is whether it has the runbook tool. */
export function runbookBrief(runbook: ChecklistItem[], canTick: boolean): string {
  if (!runbook.length) return "";
  const steps = runbook
    .map((step, index) => `${index + 1}. [${step.done ? "x" : " "}] ${step.text}`)
    .join("\n");
  const reporting = canTick
    ? "Work through the steps that are still open. As soon as you finish one, call memcode-context runbook with done=[its number], so the person sees it ticked while you work. Add a step with add=[...] only when the work needs one that isn't listed. A tick is your progress report, not verification: never tick a step you haven't done."
    : "Work through the steps that are still open, and say in your final report which ones you finished.";
  return `Runbook (the person follows your progress on these steps):\n${steps}\n${reporting}`;
}
