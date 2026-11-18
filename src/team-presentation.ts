import type { TeamWorkspaceState } from "./shared";

export function teamClaimForStory(
  team: TeamWorkspaceState | undefined,
  storyId: string,
) {
  if (!team) return undefined;
  const claim = team.workspace.claims.find((item) => item.storyId === storyId);
  if (!claim) return undefined;
  const member = team.workspace.members.find(
    (item) => item.id === claim.memberId,
  );
  const device = member?.devices.find((item) => item.id === claim.deviceId);
  return {
    claim,
    activity: team.workerActivity?.find((row) => row.storyId === storyId && row.attemptId === claim.attemptId && row.epoch === claim.epoch),
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
    return "Reconnect Team Sync before starting a shared story. MemCode must confirm its claim first.";
  const owner = teamClaimForStory(team, storyId);
  if (owner && !owner.local)
    return `${owner.name} holds this story on ${owner.device}. Wait for that claim to be released before starting here.`;
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
