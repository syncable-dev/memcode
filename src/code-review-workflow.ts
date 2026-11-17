import type { AppState, WorkItem, WorkflowState } from "./shared";
import type { ReviewWorkflowBinding } from "./code-review";

type ReviewState = Pick<AppState, "projects" | "tasks" | "workflowStates"> & {
  reviewWorkflows?: Record<string, ReviewWorkflowBinding>;
};

/** Execution categories stay portable; workflow IDs identify the two review lanes. */
export function reviewWorkflowStates(projectId: string): WorkflowState[] {
  return [
    {
      id: `${projectId}:planned`,
      projectId,
      name: "Planned",
      stage: "planned",
      color: "#9aa991",
      order: 0,
    },
    {
      id: `${projectId}:working`,
      projectId,
      name: "In progress",
      stage: "working",
      color: "#21ad89",
      order: 1,
    },
    {
      id: `${projectId}:code-review`,
      projectId,
      name: "Code review",
      stage: "review",
      color: "#699a91",
      order: 2,
    },
    {
      id: `${projectId}:review`,
      projectId,
      name: "Ready for acceptance",
      stage: "review",
      color: "#c19c51",
      order: 3,
    },
    {
      id: `${projectId}:done`,
      projectId,
      name: "Done",
      stage: "done",
      color: "#7fa890",
      order: 4,
    },
  ];
}

/** Idempotent, local migration. Existing review work is never represented as reviewed. */
export function initializeCodeReviewWorkflow(
  state: ReviewState,
  projectId?: string,
  options: { assignLegacyTasks?: boolean } = {},
): void {
  state.reviewWorkflows ??= {};
  for (const project of state.projects.filter(
    (item) => !projectId || item.id === projectId,
  )) {
    let states = state.workflowStates.filter(
      (item) => item.projectId === project.id,
    );
    if (!states.length) {
      states = reviewWorkflowStates(project.id);
      state.workflowStates.push(...states);
    }
    const saved = state.reviewWorkflows[project.id];
    if (
      saved &&
      saved.version === 1 &&
      saved.codeReviewStatusId !== saved.acceptanceStatusId &&
      states.some(
        (item) =>
          item.id === saved.codeReviewStatusId && item.stage === "review",
      ) &&
      states.some(
        (item) =>
          item.id === saved.acceptanceStatusId && item.stage === "review",
      )
    )
      continue;
    // An imported/custom workflow may already have several review states. Wait
    // for explicit role bindings instead of guessing from names or remapped IDs.
    if (
      !saved &&
      states.filter((item) => item.stage === "review").length > 1 &&
      !states.some((item) => item.id === `${project.id}:code-review`)
    )
      continue;

    const defaults = reviewWorkflowStates(project.id);
    const acceptance =
      states.find(
        (item) => item.id === `${project.id}:review` && item.stage === "review",
      ) ?? states.find((item) => item.stage === "review");
    if (!acceptance) continue;
    // Only our built-in label is renamed; user-defined workflow names remain intact.
    if (
      acceptance.id === `${project.id}:review` &&
      acceptance.name === "In review"
    )
      acceptance.name = "Ready for acceptance";
    let codeReview = states.find(
      (item) =>
        item.id === `${project.id}:code-review` && item.stage === "review",
    );
    if (!codeReview) {
      const order = acceptance.order;
      for (const item of states) if (item.order >= order) item.order++;
      codeReview = { ...defaults[2], order };
      state.workflowStates.push(codeReview);
      states = [...states, codeReview];
    }
    state.reviewWorkflows[project.id] = {
      version: 1,
      codeReviewStatusId: codeReview.id,
      acceptanceStatusId: acceptance.id,
    };
    if (options.assignLegacyTasks === false) continue;
    for (const task of state.tasks.filter(
      (item) => item.projectId === project.id && item.stage === "review",
    )) {
      if (!task.statusId || !states.some((item) => item.id === task.statusId))
        task.statusId = acceptance.id;
    }
  }
}

export function isCodeReviewTask(
  state: Pick<ReviewState, "reviewWorkflows">,
  task: WorkItem,
): boolean {
  return (
    task.stage === "review" &&
    task.statusId ===
      state.reviewWorkflows?.[task.projectId]?.codeReviewStatusId
  );
}
