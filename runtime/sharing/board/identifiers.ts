/**
 * Two computers that are apart can both make MC-014: nobody numbers tasks for
 * them. The log decides which one keeps it. Every computer reads the log in
 * the same order, so every computer works out the same answer.
 */

/** The place in the log of a task that has not reached it. Such a task gives way to every task that has. */
export const NOT_IN_THE_LOG = Number.MAX_SAFE_INTEGER;

export interface NumberedTask {
  id: string;
  identifier: string;
  /** The number of the log entry that made the task. */
  arrived: number;
}

const numbered = /^(.*?)(\d+)$/;
const earlier = (left: NumberedTask, right: NumberedTask) =>
  left.arrived - right.arrived || (left.id < right.id ? -1 : 1);

/**
 * The tasks that must take a new identifier so that no two share one, with
 * what each becomes. Of the tasks that share one, the first to reach the log
 * keeps it. The others get the numbers after the highest in use.
 */
export function newIdentifiers(tasks: NumberedTask[]): Map<string, string> {
  const sharing = new Map<string, NumberedTask[]>();
  const highest = new Map<string, number>();
  for (const task of tasks) {
    const parts = numbered.exec(task.identifier);
    if (!parts) continue;
    const [, letters, digits] = parts;
    highest.set(letters, Math.max(highest.get(letters) ?? 0, Number(digits)));
    sharing.set(task.identifier, [
      ...(sharing.get(task.identifier) ?? []),
      task,
    ]);
  }
  const giveWay = [...sharing.values()]
    .flatMap((group) => [...group].sort(earlier).slice(1))
    .sort(earlier);
  const renamed = new Map<string, string>();
  for (const task of giveWay) {
    const [, letters, digits] = numbered.exec(task.identifier)!;
    const next = highest.get(letters)! + 1;
    highest.set(letters, next);
    renamed.set(task.id, letters + String(next).padStart(digits.length, "0"));
  }
  return renamed;
}
