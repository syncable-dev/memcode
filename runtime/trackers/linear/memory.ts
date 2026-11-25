import { createHash } from "node:crypto";
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
  goals: Record<string, { title: string; description: string; shown: string; ref?: string }>;
  /** Goals a person deleted here, by what they are there: not made again. */
  leftGoals?: string[];
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
  /** Kept while the project is disconnected, for connecting again. */
  rested?: { teamId: string; direction: "both" | "in"; goals: string };
  /** What a goal was for the MemCode that kept the project in step before this one. */
  formerGoals?: string;
  /** The stage of every lane that has been here: a lane that is deleted has no other record. */
  lanes?: Record<string, string>;
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
  /** What the file holds. */
  private held = "";
  constructor(
    private folder: string,
    private id: string,
  ) {}
  private get path() {
    return join(this.folder, this.id + ".json");
  }
  /** Nothing, when there is no file or it is damaged. A file that cannot be read now is no such thing. */
  async read(): Promise<Memory> {
    return (await this.readAt(this.path)) ?? emptyMemory();
  }
  private async readAt(path: string): Promise<Memory | undefined> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (problem) {
      if ((problem as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw problem;
    }
    try {
      const saved = JSON.parse(text) as Memory;
      if (saved?.version === 1) return { ...emptyMemory(), ...saved };
    } catch {
      // A damaged file says nothing.
    }
    return undefined;
  }
  /** Written only when it says something new. */
  save(memory: Memory): Promise<void> {
    const text = JSON.stringify(memory);
    if (text === this.held) return this.saving.then(() => {});
    this.held = text;
    const next = this.saving
      .catch(() => {})
      .then(() => this.write(this.path, text))
      .catch((problem) => {
        this.held = "";
        throw problem;
      });
    this.saving = next;
    return next;
  }
  private async write(path: string, text: string): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    const temporary = `${path}.${process.pid}.next`;
    await writeFile(temporary, text);
    await rename(temporary, path);
  }
  /** The project is disconnected: what was agreed on is kept for when it is connected again. */
  async rest(memory: Memory, place: string): Promise<void> {
    await this.settled();
    await this.write(this.resting(place), JSON.stringify(memory));
    await rm(this.path, { force: true });
    this.held = "";
  }
  /** What was kept of the project when it was disconnected. */
  wake(place: string): Promise<Memory | undefined> {
    return this.readAt(this.resting(place)).catch(() => undefined);
  }
  async forgetResting(place: string): Promise<void> {
    await rm(this.resting(place), { force: true });
  }
  private resting(place: string): string {
    const name = createHash("sha256").update(place).digest("hex").slice(0, 32);
    return join(this.folder, `rest-${name}.json`);
  }
  async settled(): Promise<void> {
    await this.saving.catch(() => {});
  }
  async forget(): Promise<void> {
    await this.saving.catch(() => {});
    await rm(this.path, { force: true });
    this.held = "";
  }
}
