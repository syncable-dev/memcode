import type { AppState, Project } from "./shared";
import type { MemCodeBetaStatus } from "./beta";
import type { MemtraceAccount } from "./connections";

/** Unknown/offline credentials are not proof of sign-out. No update reapproval. */
export function needsAccountSetup(
  beta?: MemCodeBetaStatus,
  account?: MemtraceAccount,
) {
  if (!beta || !["disconnected", "expired"].includes(beta.state)) return false;
  if (beta.accessMode === "installed-cli")
    return (
      !!account &&
      !account.loginPending &&
      !account.sessionVerified &&
      account.status !== "connected"
    );
  return true;
}

export const guideSteps = [
  "welcome",
  "project",
  "context",
  "memtrace",
  "worker",
  "local-tools",
  "epic",
  "story",
  "ready",
  "code-review",
] as const;
export type GuideStep = (typeof guideSteps)[number];
export interface OnboardingProgress {
  version: 1;
  step: GuideStep;
  dismissed?: boolean;
  completedAt?: string;
  projectId?: string;
  epicId?: string;
  storyId?: string;
}
export type OnboardingPatch = Partial<
  Pick<
    OnboardingProgress,
    "step" | "dismissed" | "projectId" | "epicId" | "storyId"
  >
> & { complete?: boolean; restart?: boolean; showForNewProjects?: boolean };
export type GuideAction =
  | "project"
  | "worker"
  | "epic"
  | "story"
  | "open-story"
  | "view-review"
  | "review-docs"
  | "account"
  | "dictation"
  | "retrieval"
  | "analyze"
  | "team";

export function previousGuideStep(step: GuideStep): GuideStep | undefined {
  const index = guideSteps.indexOf(step);
  return index > 0 ? guideSteps[index - 1] : undefined;
}

/** Device-local progress; Team projection never shares setup/preferences. */
export function projectGuide(
  state: Pick<AppState, "onboarding" | "projectOnboarding" | "projects">,
  projectId: string,
) {
  const project = state.projects.find((item) => item.id === projectId);
  if (project?.example)
    return state.onboarding?.projectId ? undefined : state.onboarding;
  return (
    state.projectOnboarding?.[projectId] ??
    (state.onboarding?.projectId === projectId ? state.onboarding : undefined)
  );
}

export function activateProjectGuide(state: AppState, projectId: string) {
  const current = state.onboarding;
  if (current?.projectId && !state.projectOnboarding?.[current.projectId])
    (state.projectOnboarding ??= {})[current.projectId] = current;
  state.onboarding = projectGuide(state, projectId);
}

/** Deliberate local project creation/opening only, never a Team board import. */
export function beginProjectGuide(state: AppState, project: Project) {
  if (project.example) return;
  const guides = (state.projectOnboarding ??= {});
  guides[project.id] ??= {
    version: 1,
    step: "context",
    projectId: project.id,
    dismissed: state.onboardingPreferences?.showForNewProjects === false,
  };
  state.onboarding = guides[project.id];
}
export function firstRunGuide(state: {
  onboarding?: OnboardingProgress;
  onboardingPreferences?: { showForNewProjects?: boolean };
  projects: Array<{ id?: string; example?: boolean }>;
}) {
  return (
    !state.onboarding &&
    state.onboardingPreferences?.showForNewProjects !== false &&
    !state.projects.some((project) => !project.example)
  );
}
