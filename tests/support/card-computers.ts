import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../../src/seed";
import type { AppState, Message, WorkItem } from "../../src/shared";
import type { StoryReviewRun } from "../../src/code-review";
import { CardActivity } from "../../runtime/sharing/cards/activity";
import type { CardsApi } from "../../runtime/sharing/memsync/cards-api";
import { SharingUnavailable } from "../../runtime/sharing/problems";
import { task } from "./board-computers";
import type { StandInPerson } from "./memsync-stand-in";
import { signedInTo, type SharingWorld } from "./projects-api-scenarios";

export const at = (minute: number) =>
  `2026-11-22T10:${String(minute).padStart(2, "0")}:00.000Z`;
export const turn = (
  id: string,
  text: string,
  role: Message["role"] = "assistant",
  minute = 1,
): Message => ({ id, role, text, at: at(minute) });

/**
 * One computer of a shared project as card activity sees it: a workspace with
 * the project's tasks, and the activity of its cards.
 */
export async function cardComputer(
  world: SharingWorld,
  person: StandInPerson,
  sharedProjectId: string,
  options: { device?: "Mac" | "Windows"; names?: StandInPerson[] } = {},
) {
  const folder = await mkdtemp(join(tmpdir(), "memcode-cards-"));
  const signedIn = signedInTo(world, person);
  const state: AppState = initialState();
  const projectId = "local-project";
  state.projects.push({
    id: projectId,
    name: "website",
    description: "",
    path: "/work/website",
    branch: "main",
    analysis: "idle",
    createdAt: at(0),
  });
  const reviews = new Map<string, StoryReviewRun>();
  const self = {
    state,
    projectId,
    folder,
    isOffline: false,
    appends: 0,
    shown: 0,
    reviews,
    device: { id: randomUUID(), name: options.device ?? "Mac" } as const,
    activity: undefined as unknown as CardActivity,
    /** The same task on this computer, as the shared board would have made it. */
    addTask(id: string, changes: Partial<WorkItem> = {}): WorkItem {
      const made = task(projectId, id, {
        messages: [],
        run: { state: "idle" },
        ...changes,
      });
      state.tasks.push(made);
      return made;
    },
    find(id: string): WorkItem {
      return state.tasks.find((item) => item.id === id)!;
    },
    start() {
      const cards: CardsApi = {
        append: async (...args) => {
          if (self.isOffline)
            throw new SharingUnavailable(
              "The sharing service could not be reached.",
            );
          self.appends++;
          return signedIn.cards.append(...args);
        },
        readAfter: async (...args) => {
          if (self.isOffline)
            throw new SharingUnavailable(
              "The sharing service could not be reached.",
            );
          return signedIn.cards.readAfter(...args);
        },
        watchAfter: (...args) => signedIn.cards.watchAfter(...args),
        upload: (...args) => signedIn.cards.upload(...args),
        download: (...args) => signedIn.cards.download(...args),
      };
      const names = new Map(
        (options.names ?? [person]).map((one) => [one.accountId, one.name]),
      );
      self.activity = new CardActivity({
        projectId,
        sharedProjectId,
        device: self.device,
        folder,
        state: () => state,
        cards,
        reviewOf: async (taskId) => reviews.get(taskId) ?? null,
        nameOf: (account) => names.get(account),
        shown: () => void self.shown++,
        waitBeforeRetry: () => 15,
      });
    },
    async restart() {
      await self.activity.stop();
      self.start();
    },
    async close() {
      await self.activity.stop();
      signedIn.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
  self.start();
  return self;
}
export type CardComputer = Awaited<ReturnType<typeof cardComputer>>;
