import type { Artifact, WorkItem } from "./shared";
import type { teamClaimForStory } from "./team-presentation";

/** Who runs a worker elsewhere, in the shape the card's views for that take. */
type RunOwner = NonNullable<ReturnType<typeof teamClaimForStory>>;

/**
 * The worker run a card shows from another computer, read from the card's log
 * at the sharing service. Nothing on the card can be sent to it.
 */
export function cardRunElsewhere(task: WorkItem): RunOwner | undefined {
  const session = task.sharedFromLog ? task.sharedSession : undefined;
  if (!session) return undefined;
  return {
    claim: {
      storyId: task.id,
      attemptId: session.id,
      epoch: session.epoch,
      memberId: session.owner.memberId,
      deviceId: session.owner.deviceId,
      acquiredAt: session.startedAt ?? session.updatedAt,
    },
    session,
    activity: undefined,
    name: session.owner.name,
    device: session.owner.device,
    local: false,
  };
}

/** What the message box says on a card whose worker runs on another computer. */
export const runElsewhereNote = (owner: { name: string; device: string }) =>
  `This worker runs on ${owner.name}'s ${owner.device}. Comment on the card to reach them.`;

/** An id the card's file list uses for a shared file this computer has not fetched yet. */
export const sharedFileId = (resultId: string) => `shared:${resultId}`;

/**
 * Files shared from a card by someone else, listed with the card's own until
 * opened. Opening one fetches it, and it is then a file of the card like any.
 */
export function sharedFilesToFetch(
  task: WorkItem,
  artifacts: Artifact[],
): Artifact[] {
  const fetched = new Set(artifacts.map((artifact) => artifact.id));
  return (task.sharedResults ?? [])
    .filter(
      (result) =>
        result.kind !== "patch" &&
        !result.sharedHere &&
        !fetched.has(sharedFileId(result.id)),
    )
    .map((result) => ({
      id: sharedFileId(result.id),
      projectId: task.projectId,
      taskId: task.id,
      name: result.name,
      kind: result.mime.startsWith("image/")
        ? "image"
        : /html/.test(result.mime)
          ? "html"
          : "text",
      path: "",
      createdAt: result.sharedAt,
      source: result.sharedBy,
      purpose: result.kind === "report" ? "report" : "deliverable",
      revision: result.sha256,
    }));
}

/** Whether a listed file is one shared from elsewhere that still has to be fetched. */
export const isUnfetchedSharedFile = (artifact: Artifact) =>
  artifact.path === "" && artifact.id.startsWith("shared:");
