import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Base } from "./merge";

/** What a connection remembers between two looks at Linear. Holds no secret. */
export interface Memory {
  version: 1;
  /** The newest change of an issue that was taken in. */
  issuesUntil?: string;
  commentsUntil?: string;
  /** By task id here. */
  items: Record<string, Base>;
  /** By comment id here: its text on both sides when they last agreed. */
  comments: Record<string, { here: string; there: string }>;
  /** By goal id here: its name and description there when they last agreed. */
  goals: Record<string, { title: string; description: string; shown: string }>;
  /** The names labels had when they were last read: a label is known here by its name. */
  labels?: Record<string, string>;
  /** Pull requests a task's issue already links, by task id. */
  linked: Record<string, string[]>;
  /** What a person took out of the project: not brought in again. */
  left: string[];
  /** What an undone import took out: back only when a person brings work in again. */
  undone?: string[];
  /** The id an issue is being made with, for a task whose own cannot be one. */
  making?: Record<string, string>;
  /** When everything was last compared, also what is gone there. */
  comparedAt?: string;
}
export const emptyMemory = (): Memory => ({
  version: 1,
  items: {},
  comments: {},
  goals: {},
  linked: {},
  left: [],
});

/**
 * Saved after the workspace, never before: if the two are ever apart, a value from Linear
 * is on the task and not yet remembered, which the next look finds equal. The other way
 * round an old value here would look like a person's change and go back to Linear.
 */
export class MemoryFile {
  private saving: Promise<unknown> = Promise.resolve();
  constructor(
    private folder: string,
    private id: string,
  ) {}
  private get path() {
    return join(this.folder, this.id + ".json");
  }
  async read(): Promise<Memory> {
    try {
      const saved = JSON.parse(await readFile(this.path, "utf8")) as Memory;
      if (saved?.version !== 1) return emptyMemory();
      return { ...emptyMemory(), ...saved };
    } catch {
      return emptyMemory();
    }
  }
  save(memory: Memory): Promise<void> {
    const text = JSON.stringify(memory);
    const next = this.saving
      .catch(() => {})
      .then(async () => {
        await mkdir(this.folder, { recursive: true });
        const temporary = `${this.path}.${process.pid}.next`;
        await writeFile(temporary, text);
        await rename(temporary, this.path);
      });
    this.saving = next;
    return next;
  }
  async settled(): Promise<void> {
    await this.saving.catch(() => {});
  }
  async forget(): Promise<void> {
    await this.saving.catch(() => {});
    await rm(this.path, { force: true });
  }
}
