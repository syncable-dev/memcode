import type { Harness, Message, RunState } from "./shared";
import type { StoryReviewRun } from "./code-review";

/** Public session identities never contain a provider's private resume token. */
export interface SessionActor {
  memberId: string;
  name: string;
  deviceId: string;
  device: string;
}
export interface TeamSession {
  id: string;
  storyId: string;
  epoch: number;
  revision: number;
  sequence: number;
  owner: SessionActor;
  updatedAt: string;
  harness: Harness;
  requestedModel?: string;
  actualModel?: string;
  route?: import("./shared").RouteDecision;
  state: RunState;
  startedAt?: string;
  finishedAt?: string;
  activity?: { phase: string; label: string; updatedAt: string };
  error?: string;
  messages: Message[];
  review?: StoryReviewRun;
  /**
   * On a shared project, the summary of each round of work on the card, oldest first:
   * what everyone reads in place of the conversation.
   */
  summaries?: SharedSummary[];
}
/** What a round of work says it did, as its worker wrote it for the project. */
export interface RunSummary {
  text: string;
  at: string;
}
/** A summary as a card shows it: who ran the worker, and on which computer. */
export interface SharedSummary extends RunSummary {
  by: string;
  device: string;
}
export interface SessionCommand {
  id: string;
  sessionId: string;
  storyId: string;
  epoch: number;
  kind: "followup" | "review-question" | "review-start";
  text: string;
  reviewRunId?: string;
  author: SessionActor;
  createdAt: string;
  updatedAt: string;
  revision: number;
  sequence: number;
  state: "queued" | "received" | "picked-up" | "cancelled" | "failed";
  receivedAt?: string;
  pickedUpAt?: string;
  error?: string;
}
export interface TeamSessions {
  version: 1;
  cursor: number;
  sessions: TeamSession[];
  commands: SessionCommand[];
}
