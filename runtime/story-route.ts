import type {
  Evidence,
  HarnessRuntime,
  AppState,
  WorkItem,
} from "../src/shared";
import { planRoute } from "./router";
import { connectedRuntimes } from "./worker-connections";

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
) {
  return planRoute(
    task,
    evidence,
    connectedRuntimes(state, runtimes),
    state.settings,
  );
}
