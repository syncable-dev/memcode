import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  Evidence,
  HarnessRuntime,
  AppState,
  WorkItem,
} from "../src/shared";
import { planRoute } from "./router";
import { connectedRuntimes } from "./worker-connections";
import {
  loadRoutingCalibration,
  type RoutingCalibration,
} from "./routing-calibration";
import {
  MAX_ROUTING_LANGUAGE_SNAPSHOT_BYTES,
  loadRoutingLanguageModel,
  type RoutingLanguageModel,
} from "./routing-language-model";

async function readSnapshot<T>(
  path: string,
  byteLimit: number,
  load: (value: unknown) => T | undefined,
): Promise<T | undefined> {
  try {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || !info.size || info.size > byteLimit) return;
      const buffer = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(buffer);
      if (bytesRead === info.size)
        return load(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
    } finally {
      await file.close();
    }
  } catch {
    // A missing or invalid optional snapshot must never block a story.
  }
}

export function readRoutingCalibration(dataDir: string) {
  return readSnapshot(
    join(dataDir, "routing-calibration.json"),
    1_000_000,
    loadRoutingCalibration,
  );
}

const languageByteLimit = MAX_ROUTING_LANGUAGE_SNAPSHOT_BYTES;
let languageCache:
  | {
      path: string;
      stamp: string;
      loading: Promise<RoutingLanguageModel | undefined>;
    }
  | undefined;

export async function readRoutingLanguage(dataDir: string) {
  const path = join(dataDir, "routing-language.json");
  const info = await stat(path, { bigint: true }).catch(() => undefined);
  if (!info?.isFile() || info.size < 1n || info.size > languageByteLimit) {
    if (languageCache?.path === path) languageCache = undefined;
    return;
  }
  const stamp = `${info.ino}:${info.size}:${info.ctimeNs}:${info.mtimeNs}`;
  if (languageCache?.path !== path || languageCache.stamp !== stamp)
    languageCache = {
      path,
      stamp,
      loading: readSnapshot(path, languageByteLimit, loadRoutingLanguageModel),
    };
  return languageCache.loading;
}

/**
 * Name the harness and model for a story that is already defined.
 * Planning and execution share the same path-bound connection requirement.
 * Installing a tool is not permission to assign work to it.
 */
export function planDefinedStory(
  task: WorkItem,
  evidence: Evidence | undefined,
  runtimes: HarnessRuntime[],
  state: AppState,
  calibration?: RoutingCalibration,
  languageModel?: RoutingLanguageModel,
) {
  return planRoute(
    task,
    evidence,
    connectedRuntimes(state, runtimes),
    state.settings,
    calibration,
    languageModel,
  );
}
