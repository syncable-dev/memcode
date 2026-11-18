import { useSyncExternalStore } from "react";
import { errorMessage } from "../errors";
import type { AppState, Project } from "../shared";
import type { QualitySnapshot } from "../intelligence";

function matchesCheckout(snapshot: QualitySnapshot, project: Project) {
  return (
    snapshot.projectId === project.id &&
    snapshot.branch === project.branch &&
    (!project.repoId || snapshot.repoId === project.repoId)
  );
}

export function scopedCheckpoints(
  state: AppState,
  project: Project,
  captured?: QualitySnapshot,
) {
  const history = (state.qualitySnapshots ?? []).filter((item) =>
    matchesCheckout(item, project),
  );
  if (
    captured &&
    matchesCheckout(captured, project) &&
    !history.some((item) => item.id === captured.id)
  )
    history.push(captured);
  return history.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

interface CaptureState {
  busy: boolean;
  latest?: QualitySnapshot;
  error?: string;
}

// Insights and Improve share an in-flight read even when the user switches
// screens before the desktop state event delivers the saved checkpoint.
class CheckoutCapture {
  state: CaptureState = { busy: false };
  pending?: Promise<void>;
  listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  read = () => this.state;
  update(state: CaptureState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}
const captures = new Map<string, CheckoutCapture>();

export function useCapture(
  project: Project,
  notify: (message: string) => void,
) {
  const key = JSON.stringify([project.id, project.path, project.branch]);
  let entry = captures.get(key);
  if (!entry) {
    // Keep recent results for navigation; persisted checkpoints remain in AppState.
    if (captures.size >= 16) {
      const idle = [...captures].find(
        ([, item]) => !item.pending && !item.listeners.size,
      );
      if (idle) captures.delete(idle[0]);
    }
    entry = new CheckoutCapture();
    captures.set(key, entry);
  }
  const checkout = entry;
  const state = useSyncExternalStore(checkout.subscribe, checkout.read);
  function start(refreshIndex: boolean, announce: boolean): Promise<void> {
    if (checkout.pending) return checkout.pending;
    const pending = Promise.resolve().then(async () => {
      try {
        const result = await window.memcode.refreshIntelligence(
          project.id,
          refreshIndex,
        );
        if (!matchesCheckout(result, project))
          throw new Error(
            "The checkout changed while reading the report. Retry on the selected branch.",
          );
        checkout.update({ busy: false, latest: result });
        if (announce && checkout.listeners.size)
          notify(
            result.status === "current"
              ? "Measured checkpoint recorded."
              : `Checkpoint recorded with ${result.status} coverage. Review its evidence notes.`,
          );
      } catch (reason) {
        checkout.update({
          ...checkout.state,
          busy: false,
          error: errorMessage(reason),
        });
      } finally {
        checkout.pending = undefined;
      }
    });
    checkout.pending = pending;
    checkout.update({ ...checkout.state, busy: true, error: undefined });
    return pending;
  }
  return {
    ...state,
    latest:
      state.latest && matchesCheckout(state.latest, project)
        ? state.latest
        : undefined,
    capture: (refreshIndex = false) => start(refreshIndex, true),
    load: () => {
      if (
        !project.path ||
        project.example ||
        !project.repoId ||
        project.analysis !== "ready" ||
        checkout.state.error
      )
        return Promise.resolve();
      return start(false, false);
    },
  };
}
