import { isActive, pendingPrerequisites } from "../domain";
import type { WorkItem } from "../shared";
import type { WorkflowState } from "./types";
import { taskStatus } from "./workflow";

export type StoryReadiness = {
  label: string;
  detail: string;
} & (
  | { state: "ready" | "handoff" }
  | { state: "blocked"; blockers: ReturnType<typeof pendingPrerequisites> }
);

export function storyReadiness(
  task: WorkItem,
  projectTasks: readonly WorkItem[],
  workflow: WorkflowState[],
): StoryReadiness | undefined {
  if (task.stage !== "planned" || task.archivedAt || isActive(task)) return;
  const blockers = pendingPrerequisites(task, projectTasks);
  if (blockers.length) {
    return {
      state: "blocked",
      blockers,
      label:
        "Blocked by " +
        blockers.map(({ story, id }) => story?.identifier ?? id).join(", "),
      detail: blockers
        .map(({ story, id }) =>
          story
            ? `${story.identifier} · ${story.title} · ${taskStatus(story, workflow).name}`
            : `${id} · Prerequisite unavailable`,
        )
        .join("\n"),
    };
  }
  const handoffs = (task.dependsOn ?? []).flatMap((id) => {
    const source = projectTasks.find(
      (story) => story.id === id && story.projectId === task.projectId,
    );
    return source && source.epicId !== task.epicId && source.kind !== "research"
      ? [source]
      : [];
  });
  if (handoffs.length) {
    return {
      state: "handoff",
      label: "Needs work from another goal",
      detail:
        "When it starts, MemCode checks that this goal already has the changes from " +
        handoffs
          .map((source) => `${source.identifier} · ${source.title}`)
          .join(", ") +
        ".",
    };
  }
  return {
    state: "ready",
    label: "Ready to start",
    detail:
      "Task prerequisites are clear. The worker and code are checked when it starts.",
  };
}
