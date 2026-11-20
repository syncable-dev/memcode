import { open } from "node:fs/promises";
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

export async function readRoutingCalibration(dataDir: string) {
  try {
    const file = await open(join(dataDir, "routing-calibration.json"), "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || !info.size || info.size > 1_000_000) return;
      const buffer = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(buffer);
      if (bytesRead === info.size)
        return loadRoutingCalibration(
          JSON.parse(buffer.toString("utf8", 0, bytesRead)),
        );
    } finally {
      await file.close();
    }
  } catch {
    // An optional local calibration snapshot must never block a story.
  }
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
) {
  return planRoute(
    task,
    evidence,
    connectedRuntimes(state, runtimes),
    state.settings,
    calibration,
  );
}
