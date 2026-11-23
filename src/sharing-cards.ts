import type { Artifact, WorkItem } from "./shared";
import type { SharedCardResult } from "./sharing";
import type { teamClaimForStory } from "./team-presentation";
import type { TeamSession } from "./team-session";

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

type Owner = { name: string; device: string };

/**
 * What the message box says on a card whose worker runs under the person's own
 * account, on another of their computers. Only they continue it.
 */
export const runElsewhereNote = (owner: Owner) =>
  `Continue the worker on your ${owner.device}…`;

/** Where the send button sends to, on such a card. */
export const sendElsewhereLabel = (owner: Owner) =>
  `Send to your ${owner.device}`;

/** What stands in for the message box on a card whose worker is someone else's. */
export const onlyItsOwnerContinues = (owner: Owner) =>
  `Only ${owner.name} can continue this worker. Comment on the card to reach them.`;

/**
 * How someone else's worker stands, said under the card's summaries in place of its
 * conversation, which only its owner reads (MemSync ADR-0019). Nothing once a round
 * finished with its summary: the summary says it.
 */
export function runElsewhereStanding(
  owner: Owner,
  session: Pick<TeamSession, "state" | "summaries">,
): string | undefined {
  const summarized = !!session.summaries?.length;
  if (["preparing", "running", "stopping", "blocked"].includes(session.state))
    return summarized
      ? `${owner.name} is working on this again on their ${owner.device}. A new summary shows here when it's ready for review.`
      : `${owner.name} is working on this on their ${owner.device}. A summary of the work shows here when it's ready for review.`;
  if (session.state === "finished")
    return summarized
      ? undefined
      : `${owner.name}'s worker finished on their ${owner.device} without a summary. What it changed and made is in the Changes and Artifacts tabs.`;
  return `${owner.name}'s worker on their ${owner.device} stopped before it finished.`;
}

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
  return newestSharedFiles(task)
    .filter((result) => !fetched.has(sharedFileId(result.id)))
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
/**
 * The files a card lists: its own, and of each file someone shared from another
 * computer only the newest version, opened here or not. A worker that writes a file
 * again in a later round shares it again; the earlier version is not listed.
 */
export function cardFileList(task: WorkItem, own: Artifact[]): Artifact[] {
  const newest = new Set(
    newestSharedFiles(task).map((result) => sharedFileId(result.id)),
  );
  const older = new Set(
    (task.sharedResults ?? [])
      .map((result) => sharedFileId(result.id))
      .filter((id) => !newest.has(id)),
  );
  const listed = own.filter((artifact) => !older.has(artifact.id));
  return [...listed, ...sharedFilesToFetch(task, listed)];
}

/** Of each file shared to a card from another computer, by its name and who shared it, the newest. */
function newestSharedFiles(task: WorkItem) {
  const newest = new Map<string, SharedCardResult>();
  for (const result of task.sharedResults ?? []) {
    if (result.kind === "patch" || result.sharedHere) continue;
    const key = `${result.sharedBy}\n${result.name}`;
    const known = newest.get(key);
    if (!known || known.sharedAt <= result.sharedAt) newest.set(key, result);
  }
  return [...newest.values()];
}

export const isUnfetchedSharedFile = (artifact: Artifact) =>
  artifact.path === "" && artifact.id.startsWith("shared:");
