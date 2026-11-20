import type { AgentSessionOptions } from "./types";

export function assertCalibratedConfiguration(
  options: Pick<AgentSessionOptions, "calibratedModel" | "effort">,
  model: unknown,
  effort: unknown,
): void {
  if (options.calibratedModel && (model !== options.calibratedModel || effort !== options.effort))
    throw Error("The worker could not confirm the calibrated model and effort. Refresh the worker catalog and plan the story again.");
}
