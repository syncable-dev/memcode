import { z } from "zod";
import {
  activateProjectGuide,
  guideSteps,
  projectGuide,
  type OnboardingProgress,
} from "../src/onboarding";
import type { AppState } from "../src/shared";
type Register = (
  method: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
export function registerOnboarding(
  register: Register,
  state: () => AppState,
  changed: () => Promise<void>,
) {
  activateProjectGuide(state(), state().activeProjectId);
  register(
    "onboarding:update",
    z
      .object({
        step: z.enum(guideSteps).optional(),
        dismissed: z.boolean().optional(),
        projectId: z.string().min(1).max(250).optional(),
        epicId: z.string().min(1).max(250).optional(),
        storyId: z.string().min(1).max(250).optional(),
        complete: z.boolean().optional(),
        restart: z.boolean().optional(),
        showForNewProjects: z.boolean().optional(),
      })
      .strict(),
    async (input) => {
      const { complete, restart, showForNewProjects, ...patch } = input;
      const projectId =
        patch.projectId ??
        (restart ? undefined : state().onboarding?.projectId);
      const previous = projectId
        ? projectGuide(state(), projectId)
        : state().onboarding;
      const next: OnboardingProgress = {
        version: 1,
        step: projectId ? "context" : "welcome",
        ...(restart ? {} : previous),
        ...(projectId ? { projectId } : {}),
        ...patch,
      };
      if (
        next.projectId &&
        !state().projects.some((p) => p.id === next.projectId && !p.example)
      )
        throw Error("Choose a local project for guided setup.");
      // The story may have moved or been deleted while the guide was paused.
      if (next.storyId && !patch.storyId && !patch.epicId) {
        const story = state().tasks.find(
          (task) =>
            task.id === next.storyId && task.projectId === next.projectId,
        );
        if (story && !story.archivedAt) next.epicId = story.epicId ?? undefined;
        else delete next.storyId;
      }
      if (
        next.epicId &&
        !state().epics.some(
          (e) => e.id === next.epicId && e.projectId === next.projectId,
        )
      ) {
        if (patch.epicId || patch.storyId)
          throw Error("Choose a goal in this project.");
        delete next.epicId;
      }
      if (
        next.storyId &&
        !state().tasks.some(
          (t) =>
            t.id === next.storyId &&
            t.projectId === next.projectId &&
            (t.epicId ?? undefined) === next.epicId,
        )
      )
        throw Error("Choose a task in this goal.");
      if (complete) {
        next.completedAt = new Date().toISOString();
        next.dismissed = true;
      }
      if (showForNewProjects !== undefined)
        state().onboardingPreferences = {
          ...state().onboardingPreferences,
          showForNewProjects,
        };
      if (next.projectId)
        (state().projectOnboarding ??= {})[next.projectId] = next;
      state().onboarding = next;
      await changed();
      return next;
    },
  );
}
