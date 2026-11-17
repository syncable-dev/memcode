import { z } from "zod";
import type { AppState, WorkflowState } from "../../src/shared";
import type { ReviewWorkflowBinding } from "../../src/code-review";
import { localTeamId, remoteTeamId, type TeamIdentityBinding } from "./identity";

const id = z.string().min(1).max(200);
export const workflowRoleBindingSchema = z.object({
  version: z.literal(1),
  codeReviewStatusId: id,
  acceptanceStatusId: id,
}).strict().refine((value) => value.codeReviewStatusId !== value.acceptanceStatusId, "Code review and acceptance must use different workflow states.");
export const workflowRolesSchema = z.object({
  version: z.literal(1), workspaceId: id,
  revision: z.number().int().nonnegative(),
  through: z.number().int().nonnegative(),
  binding: workflowRoleBindingSchema.nullable(),
  planningHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export type TeamWorkflowRoles = z.infer<typeof workflowRolesSchema>;
export const workflowRolesUpdateSchema = z.object({
  version: z.literal(1), workspaceId: id, opId: id,
  expectedRevision: z.number().int().nonnegative(),
  expectedPlanningHash: z.string().regex(/^[a-f0-9]{64}$/),
  binding: workflowRoleBindingSchema,
}).strict();
export type PendingWorkflowRoles = Omit<z.infer<typeof workflowRolesUpdateSchema>, "version" | "workspaceId">;

export function validateWorkflowRoles(binding: ReviewWorkflowBinding, states: Array<Pick<WorkflowState, "id" | "stage">>): void {
  workflowRoleBindingSchema.parse(binding);
  for (const role of [binding.codeReviewStatusId, binding.acceptanceStatusId]) {
    if (!states.some((state) => state.id === role && state.stage === "review"))
      throw Error("Review role bindings must refer to distinct review-category states in this project's accepted workflow.");
  }
}
export function emptyWorkflowRoles(workspaceId: string): TeamWorkflowRoles {
  return { version: 1, workspaceId, revision: 0, through: 0, binding: null, planningHash: null };
}
export function remoteWorkflowRoles(binding: TeamIdentityBinding, roles: ReviewWorkflowBinding): ReviewWorkflowBinding {
  return { version: 1, codeReviewStatusId: remoteTeamId(binding, "workflow", roles.codeReviewStatusId), acceptanceStatusId: remoteTeamId(binding, "workflow", roles.acceptanceStatusId) };
}
export function applyWorkflowRoles(state: AppState, projectId: string, connection: TeamIdentityBinding, accepted: TeamWorkflowRoles): void {
  if (accepted.workspaceId !== connection.credential.workspaceId) throw Error("The Team service returned workflow roles for a different project.");
  if (!accepted.binding) return;
  const binding = { version: 1 as const, codeReviewStatusId: localTeamId(connection, "workflow", accepted.binding.codeReviewStatusId), acceptanceStatusId: localTeamId(connection, "workflow", accepted.binding.acceptanceStatusId) };
  validateWorkflowRoles(binding, state.workflowStates.filter((item) => item.projectId === projectId));
  (state.reviewWorkflows ??= {})[projectId] = binding;
}
