import { childEnv, findCommand } from "./commands";
import { appVersion } from "../src/version";
export { childEnv, findCommand, exists } from "./commands";
export type { Command } from "./commands";
import { discoverHarnesses } from "./catalog";
import {
  access,
  mkdir,
  readFile,
  writeFile,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import {
  dirname,
  delimiter,
  join,
  resolve,
  relative,
  isAbsolute,
} from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppState, Harness, RuntimeInfo } from "../src/shared";
import { initialState } from "../src/seed";
import { restartSafeState } from "../src/domain";
import { initializePlanning, observePlanning } from "../src/planning/history";
import { migrateReviewComments } from "./review";
import { replaceWorkspace } from "./persistence";

export const exec = promisify(execFile);
export const now = () => new Date().toISOString();

export function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return (
    rel === "" ||
    (!rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
      rel !== ".." &&
      !isAbsolute(rel))
  );
}

export class LocalStore {
  state: AppState = initialState();
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly dir: string) {}
  async load(): Promise<AppState> {
    await mkdir(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(
        await readFile(join(this.dir, "workspace.json"), "utf8"),
      ) as AppState;
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.projects) ||
        !Array.isArray(saved.tasks)
      )
        throw new Error("Unsupported workspace data");
      this.state = {
        ...restartSafeState(saved),
        epics: saved.epics ?? [],
        qualitySnapshots: saved.qualitySnapshots ?? [],
        fleetConflicts: saved.fleetConflicts ?? [],
        settings: { ...initialState().settings, ...saved.settings },
      };
      const example = this.state.projects.find((project) => project.example);
      migrateReviewComments(this.state);
      if (String(this.state.settings.defaultHarness) === "amp")
        this.state.settings.defaultHarness = "cursor";
      if (example) example.name = "Design preview";
      for (const task of this.state.tasks)
        if (String(task.harness) === "amp") {
          task.harness = "cursor";
          task.route = undefined;
          task.modelOverride = null;
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "The local workspace could not be read. Your saved data has been preserved.",
          { cause: error },
        );
    }
    initializePlanning(this.state);
    return this.state;
  }
  /**
   * Saves the workspace as it is at the moment of the call. `first` runs before
   * the file is written: something that must be on disk before the workspace
   * that goes with it.
   */
  save(first?: () => Promise<void>): Promise<void> {
    observePlanning(this.state);
    const serialized = JSON.stringify(this.state, null, 2);
    const pending = this.writes
      .catch(() => {})
      .then(async () => {
        await first?.();
        const path = join(this.dir, "workspace.json");
        const temp = join(this.dir, "workspace.json.next");
        await writeFile(temp, serialized, "utf8");
        await replaceWorkspace(temp, path);
      });
    this.writes = pending;
    return pending;
  }
  async runtime(): Promise<RuntimeInfo> {
    const harnesses = await discoverHarnesses();
    return {
      appVersion,
      harnesses,
      memtraceAvailable: !!(await findCommand(
        "memtrace",
        this.state.settings.memtracePath,
      )),
      dataPath: this.dir,
    };
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: childEnv(),
  });
  return stdout.trim();
}
