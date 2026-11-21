import { z } from "zod";
import type { WorkItem } from "../../src/shared";
import { teamWorkerPhases, type TeamClaim, type TeamWorkerActivity, type TeamWorkerPhase } from "../../src/team";
import { teamId } from "./protocol";

const modelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,127}$/);
function activityModel(harness: WorkItem["harness"], value: unknown) {
  if (harness === "dsh" && typeof value === "string") {
    try {
      const route = JSON.parse(value);
      if (Array.isArray(route) && route.length === 2 && route.every(part => typeof part === "string"))
        value = route[1];
    } catch { /* Plain IDs remain subject to the same allowlist. */ }
  }
  if (harness === "cursor" && typeof value === "string") value = value.split("[", 1)[0];
  return modelId.safeParse(value).data;
}
const report = z.object({
  storyId: teamId, attemptId: teamId, epoch: z.number().int().positive(),
  startedAt: z.string().datetime(), phase: z.enum(teamWorkerPhases),
  harness: z.enum(["claude", "codex", "cursor", "copilot", "dsh"]).optional(),
  requestedModel: modelId.optional(), actualModel: modelId.optional(),
});
export const workerReport = report.extend({ workspaceId: teamId }).strict();
export const workerReports = z.object({ workers: z.array(report.extend({
  updatedAt: z.string().datetime(),
  recent: z.array(z.object({ phase: z.enum(teamWorkerPhases), at: z.string().datetime() })).max(8),
}).strict()) }).strict();

function phaseFor(run: WorkItem["run"]): TeamWorkerPhase {
  const activity = run.activity;
  if (run.state === "stopping") return "stopping";
  if (run.state === "preparing") {
    if (activity?.label === "Coordinating with the goal’s other tasks") return "joining";
    if (activity?.label.startsWith("Starting ") || activity?.label === "Preparing the worker brief") return "starting";
    return "preparing";
  }
  if (activity?.phase.startsWith("waiting_")) return "waiting";
  if (activity?.phase === "finishing") return "finishing";
  if (activity?.phase === "tool") {
    if (/\b(test|tests|testing|check|verification)\b/i.test(activity.label)) return "testing";
    if (/\b(edit|editing|write|patch|apply_patch)\b/i.test(activity.label)) return "editing";
    if (/\b(read|reading|search|explore|inspect)\b/i.test(activity.label)) return "reading";
  }
  return activity?.label === "Worker is responding" ? "responding" : "working";
}
/** A fresh allowlisted projection for the owning device's current attempt. */
export function reportWorker(task: WorkItem, claim: TeamClaim, workspaceId: string) {
  const run = task.run;
  if (!run.startedAt || !["preparing", "running", "stopping"].includes(run.state)) return;
  const phase = phaseFor(run);
  const routed = phase !== "preparing" && (run.state !== "stopping" || !!run.sessionId);
  const actual = run.measurements?.modelSource && run.measurements.modelId;
  return {
    workspaceId, storyId: claim.storyId, attemptId: claim.attemptId, epoch: claim.epoch,
    startedAt: run.startedAt, phase,
    ...(routed ? { harness: task.harness, requestedModel: activityModel(task.harness, task.route?.model) } : {}),
    actualModel: modelId.safeParse(actual).data,
  };
}

export function acceptWorkerReport(input: z.infer<typeof workerReport>, previous: TeamWorkerActivity | undefined, now: string): TeamWorkerActivity {
  const { workspaceId: _, ...current } = input;
  const prior = previous?.attemptId === current.attemptId && previous.epoch === current.epoch ? previous : undefined;
  const recent = prior?.recent ?? [];
  return {
    ...current, updatedAt: now, startedAt: prior?.startedAt ?? current.startedAt,
    recent: prior?.phase === current.phase ? recent : [...recent, { phase: current.phase, at: now }].slice(-8),
  };
}
