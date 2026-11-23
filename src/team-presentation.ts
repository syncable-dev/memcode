import type { AppState, TeamWorkspaceState, WorkItem } from "./shared";

/** Display a shared session without turning it into a locally running worker. */
export function presentedTask(local: WorkItem): WorkItem {
  const shared = local.sharedSession;
  return shared
    ? {
        ...local,
        harness: shared.harness,
        route: shared.route,
        modelOverride: shared.actualModel ?? shared.requestedModel,
        messages: shared.messages,
        run: {
          state: shared.state,
          startedAt: shared.startedAt,
          finishedAt: shared.finishedAt,
          error: shared.error,
        },
        codeReview: shared.review
          ? {
              runId: shared.review.id,
              state: shared.review.state,
              outcome: shared.review.outcome,
              updatedAt: shared.review.updatedAt,
              findingCount: shared.review.findings.length,
            }
          : undefined,
      }
    : local;
}

export function teamClaimForStory(
  team: TeamWorkspaceState | undefined,
  storyId: string,
) {
  if (!team) return undefined;
  const session = team.sessions
    ?.filter((s) => s.storyId === storyId)
    .sort((a, b) => b.epoch - a.epoch)[0];
  const claim =
    team.workspace.claims.find((item) => item.storyId === storyId) ??
    (session
      ? {
          storyId,
          attemptId: session.id,
          epoch: session.epoch,
          memberId: session.owner.memberId,
          deviceId: session.owner.deviceId,
          acquiredAt: session.startedAt ?? session.updatedAt,
        }
      : undefined);
  if (!claim) return undefined;
  const member = team.workspace.members.find(
    (item) => item.id === claim.memberId,
  );
  const device = member?.devices.find((item) => item.id === claim.deviceId);
  return {
    claim,
    session: session?.id === claim.attemptId ? session : undefined,
    activity: team.workerActivity?.find(
      (row) =>
        row.storyId === storyId &&
        row.attemptId === claim.attemptId &&
        row.epoch === claim.epoch,
    ),
    name: member?.name ?? "Workspace member",
    device: device?.name ?? "Another device",
    local: claim.memberId === team.memberId && claim.deviceId === team.deviceId,
  };
}

/** UI affordance only: the runtime still acquires the authoritative claim before starting. */
export function teamStartBlocked(
  team: TeamWorkspaceState | undefined,
  storyId: string,
): string | undefined {
  if (!team) return undefined;
  if (team.connection === "offline" || team.connection === "connecting")
    return "Reconnect Team Sync before starting a shared task. MemCode must confirm its claim first.";
  const owner = teamClaimForStory(team, storyId);
  if (
    owner &&
    !owner.local &&
    team.workspace.claims.some((c) => c.storyId === storyId)
  )
    return `${owner.name} holds this task on ${owner.device}. Wait for that claim to be released before starting here.`;
  return undefined;
}

export function teamSyncLabel(team: TeamWorkspaceState): string {
  if (team.connection === "offline") return "Offline";
  if (team.connection === "connecting") return "Connecting";
  if (team.pendingCount > 0)
    return `${team.pendingCount} change${team.pendingCount === 1 ? "" : "s"} waiting`;
  if (team.connection === "syncing") return "Syncing";
  return "Up to date";
}

export function teamErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /unknown (?:rpc )?method|not a function|unsupported.*team|handler not found/i.test(
    message,
  )
    ? "Team Sync needs the updated local runtime. Restart MemCode after the update is ready."
    : message;
}

/**
 * Sharing a project replaces Team Sync, so the Team page is only for a project still
 * in a Team Sync team: there it can be managed and left.
 */
export function hasTeamPage(
  state: Pick<AppState, "team">,
  projectId: string,
): boolean {
  return !!state.team?.some((room) => room.projectId === projectId);
}
