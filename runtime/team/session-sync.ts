import { createHash, randomUUID } from "node:crypto";
import type { AppState, WorkItem, Message } from "../../src/shared";
import type { StoryReviewRun } from "../../src/code-review";
import type { TeamCredential, TeamSnapshot, TeamClaim } from "../../src/team";
import type {
  SessionCommand,
  TeamSession,
  TeamSessions,
} from "../../src/team-session";
import {
  emptySessions,
  latestSession,
  sessionActor,
  sessionPayload,
} from "./session-protocol";

export interface SessionConnection {
  projectId: string;
  endpoint: string;
  credential: TeamCredential;
  snapshot: TeamSnapshot;
  leases: Map<string, TeamClaim>;
  sessions?: TeamSessions;
  sessionOutbox?: Array<{ path: string; input: Record<string, unknown> }>;
  sessionsError?: string;
  sessionsUnsupported?: boolean;
}
interface Options {
  state(): AppState;
  request<T>(
    connection: SessionConnection,
    path: string,
    input?: unknown,
  ): Promise<T>;
  persist(): Promise<void>;
  changed(): Promise<void>;
  localId(connection: SessionConnection, id: string): string;
  remoteId(connection: SessionConnection, id: string): string;
  deliver?(task: WorkItem, command: SessionCommand): Promise<void>;
  loadReview?(taskId: string): Promise<StoryReviewRun | null>;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
const safeText = (value: string) =>
  value
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "<redacted-token>",
    )
    .replace(
      /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s]+|\/Users\/[^/\s]+|\/home\/[^/\s]+)/g,
      "<local-home>",
    );
const progressLabels: Record<string, string> = {
  preparing: "Preparing the worker",
  joining: "Joining the epic Fleet",
  starting: "Starting the harness",
  responding: "Worker is responding",
  reading: "Reading project context",
  editing: "Editing project files",
  testing: "Running checks",
  working: "Working on the story",
  waiting: "Waiting for input or a handoff",
  waiting_for_user: "Waiting for an answer on the worker's device",
  finishing: "Finishing the worker turn",
  stopping: "Stopping the worker",
};
function publicMessage(message: Message): Message {
  const {
    id,
    role,
    at,
    streamId,
    promptedAt,
    pickedUpAt,
    queuedAt,
    queueOrder,
    followupState,
    sourceCommandId,
    actor,
  } = message;
  return {
    id,
    role,
    at,
    text: safeText(message.text),
    streamId,
    promptedAt,
    pickedUpAt,
    queuedAt,
    queueOrder,
    followupState,
    sourceCommandId,
    actor,
  };
}
function stateRevision(connection: SessionConnection, id: string) {
  const revision = connection.sessions?.commands.find(
    (c) => c.id === id,
  )?.revision;
  if (!revision) throw Error("The shared input has not been acknowledged yet.");
  return revision;
}
export class TeamSessionSync {
  private syncing = new Map<SessionConnection, Promise<void>>();
  private published = new Map<string, { hash: string; at: number }>();
  private reviews = new Map<string, StoryReviewRun>();
  private executing = new Set<string>();
  private stopped = false;
  private posting = new Set<string>();
  constructor(private options: Options) {}
  reviewSaved(run: StoryReviewRun) {
    this.reviews.set(run.taskId, structuredClone(run));
  }
  private accept(
    connection: SessionConnection,
    value: TeamSession | SessionCommand,
  ) {
    const state = (connection.sessions ??= emptySessions());
    if ("harness" in value) {
      const prior = state.sessions.find((s) => s.id === value.id);
      if (!prior || prior.revision < value.revision)
        state.sessions = [
          ...state.sessions.filter((s) => s.id !== value.id),
          value,
        ];
    } else {
      const prior = state.commands.find((s) => s.id === value.id);
      if (!prior || prior.revision < value.revision)
        state.commands = [
          ...state.commands.filter((s) => s.id !== value.id),
          value,
        ];
    }
    // POST acknowledgements must NOT advance the read cursor past unseen events.
  }
  remote(connection: SessionConnection, taskId: string) {
    const storyId = this.options.remoteId(connection, taskId);
    const claim = connection.snapshot.claims.find((c) => c.storyId === storyId);
    if (
      claim?.deviceId === connection.credential.deviceId &&
      claim.memberId === connection.credential.memberId
    )
      return undefined;
    const session = latestSession(
      connection.sessions ?? emptySessions(),
      storyId,
    );
    return session &&
      (session.owner.deviceId !== connection.credential.deviceId ||
        session.owner.memberId !== connection.credential.memberId)
      ? session
      : undefined;
  }
  apply(connection: SessionConnection) {
    for (const task of this.options
      .state()
      .tasks.filter((t) => t.projectId === connection.projectId)) {
      const remote = this.remote(connection, task.id);
      if (!remote) {
        delete task.sharedSession;
        continue;
      }
      const value = structuredClone(remote);
      value.storyId = task.id;
      if (value.review) value.review.taskId = task.id;
      const commands =
        connection.sessions?.commands.filter(
          (c) =>
            c.kind === "followup" &&
            c.storyId === remote.storyId &&
            (c.sessionId === remote.id ||
              remote.messages.some((m) => m.sourceCommandId === c.id)),
        ) ?? [];
      for (const command of commands) {
        const message = value.messages.find(
          (m) => m.sourceCommandId === command.id || m.id === command.id,
        );
        const projection: Message = {
          id: command.id,
          sourceCommandId: command.id,
          role: "user",
          text: command.text,
          at: command.createdAt,
          actor: command.author,
          queuedAt: command.createdAt,
          pickedUpAt: command.pickedUpAt,
          deliveryState: command.state,
          deliveryError: command.error,
          followupState:
            command.state === "cancelled"
              ? "cancelled"
              : command.state === "failed"
                ? "paused"
                : command.state === "picked-up"
                  ? "included"
                  : "queued",
        };
        if (message) {
          message.actor = command.author;
          if (!message.promptedAt) Object.assign(message, projection);
        } else value.messages.push(projection);
      }
      if (value.review) {
        for (const command of connection.sessions?.commands.filter(
          (c) =>
            c.kind === "review-question" &&
            c.storyId === remote.storyId &&
            c.reviewRunId === value.review!.id &&
            c.state !== "cancelled",
        ) ?? []) {
          const existing = value.review.messages.find(
            (m) => m.id === command.id,
          );
          if (!existing)
            value.review.messages.push({
              id: command.id,
              sourceCommandId: command.id,
              role: "user",
              text: command.text,
              at: command.createdAt,
              actor: command.author,
              pickedUpAt: command.pickedUpAt,
              followupState: command.state === "failed" ? "paused" : "queued",
            });
          else existing.actor = command.author;
          if (command.updatedAt > value.review.updatedAt)
            value.review.updatedAt = command.updatedAt;
        }
      }
      task.sharedSession = value;
    }
  }
  async enqueue(
    connection: SessionConnection,
    taskId: string,
    kind: SessionCommand["kind"],
    text: string,
    reviewRunId?: string,
  ) {
    const session = this.remote(connection, taskId);
    if (!session)
      throw Error("This story has no shared remote worker session.");
    if (connection.sessionsUnsupported)
      throw Error(
        "Update the Team service to enable shared worker conversations.",
      );
    const id = randomUUID(),
      now = new Date().toISOString();
    const input = {
      workspaceId: connection.credential.workspaceId,
      id,
      sessionId: session.id,
      kind,
      text,
      ...(reviewRunId ? { reviewRunId } : {}),
    };
    (connection.sessionOutbox ??= []).push({
      path: "/v1/session-commands",
      input,
    });
    this.accept(connection, {
      id,
      sessionId: session.id,
      storyId: session.storyId,
      epoch: session.epoch,
      kind,
      text,
      reviewRunId,
      author: sessionActor(connection.snapshot, connection.credential),
      createdAt: now,
      updatedAt: now,
      revision: 0,
      sequence: 0,
      state: "queued",
    });
    this.apply(connection);
    await this.options.persist();
    await this.options.changed();
    void this.sync(connection);
    return id;
  }
  async edit(
    connection: SessionConnection,
    id: string,
    text?: string,
    cancel = false,
  ) {
    const command = connection.sessions?.commands.find((c) => c.id === id);
    if (!command) throw Error("Shared follow-up not found.");
    if (command.author.memberId !== connection.credential.memberId)
      throw Error("Only the author may change this follow-up.");
    if (!["queued", "received"].includes(command.state))
      throw Error(
        "The worker already picked up this follow-up. Send a new one instead.",
      );
    const pending = connection.sessionOutbox?.find(
      (o) => o.path === "/v1/session-commands" && o.input.id === id,
    );
    if (pending && !this.posting.has(id)) {
      if (cancel)
        connection.sessionOutbox = connection.sessionOutbox!.filter(
          (o) => o !== pending,
        );
      else pending.input.text = text;
      Object.assign(command, {
        text: text ?? command.text,
        state: cancel ? "cancelled" : command.state,
      });
    } else if (pending) {
      (connection.sessionOutbox ??= []).push({
        path: "/v1/session-commands/edit",
        input: {
          workspaceId: connection.credential.workspaceId,
          id,
          ...(text ? { text } : {}),
          cancel,
        },
      });
      Object.assign(command, {
        text: text ?? command.text,
        state: cancel ? "cancelled" : command.state,
      });
    } else {
      // Edits are confirmed by the relay: an offline screen cannot promise that
      // a change beat a simultaneous pickup on the host.
      const result = await this.options.request<SessionCommand>(
        connection,
        "/v1/session-commands/edit",
        {
          workspaceId: connection.credential.workspaceId,
          id,
          expectedRevision: command.revision,
          ...(text ? { text } : {}),
          cancel,
        },
      );
      this.accept(connection, result);
    }
    this.apply(connection);
    await this.options.persist();
    await this.options.changed();
  }
  /** Seal the latest server version immediately before the host snapshots its prompt. */
  async pickup(connection: SessionConnection, task: WorkItem) {
    for (const message of task.messages.filter(
      (m) => m.sourceCommandId && m.followupState === "queued" && !m.promptedAt,
    )) {
      const result = await this.options.request<SessionCommand>(
        connection,
        "/v1/session-commands/receipt",
        {
          workspaceId: connection.credential.workspaceId,
          id: message.sourceCommandId,
          state: "picked-up",
        },
      );
      this.accept(connection, result);
      message.text = result.text;
      message.actor = result.author;
      message.pickedUpAt = result.pickedUpAt;
      if (result.state === "cancelled" || result.state === "failed")
        message.followupState =
          result.state === "cancelled" ? "cancelled" : "paused";
    }
    await this.options.persist();
  }
  sync(connection: SessionConnection): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.syncing.get(connection);
    if (existing) return existing;
    const work = this.exchange(connection)
      .catch(async (error) => {
        const previous = connection.sessionsError;
        if ([404, 405, 501].includes((error as any).status))
          connection.sessionsUnsupported = true;
        connection.sessionsError = connection.sessionsUnsupported
          ? "Update the Team service to enable shared worker conversations."
          : error instanceof Error
            ? error.message
            : String(error);
        if (connection.sessionsError !== previous && !this.stopped)
          await this.options.changed();
      })
      .finally(() => this.syncing.delete(connection));
    this.syncing.set(connection, work);
    return work;
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled([...this.syncing.values()]);
  }
  private async exchange(connection: SessionConnection) {
    if (connection.sessionsUnsupported) return;
    let changed = false;
    while (connection.sessionOutbox?.length) {
      const operation = connection.sessionOutbox[0];
      try {
        const id = String(operation.input.id);
        if (operation.path.endsWith("/edit"))
          operation.input.expectedRevision = stateRevision(connection, id);
        this.posting.add(id);
        this.accept(
          connection,
          await this.options.request<SessionCommand>(
            connection,
            operation.path,
            operation.input,
          ),
        );
        connection.sessionOutbox = connection.sessionOutbox.filter(
          (o) => o !== operation,
        );
        changed = true;
        await this.options.persist();
      } catch (error) {
        if (
          (error as any).status >= 400 &&
          (error as any).status < 500 &&
          ![401, 408, 429].includes((error as any).status)
        ) {
          const command = connection.sessions?.commands.find(
            (c) => c.id === operation.input.id,
          );
          if (command) {
            command.state = "failed";
            command.error = (error as Error).message;
          }
          connection.sessionOutbox.shift();
          await this.options.persist();
        }
        throw error;
      } finally {
        this.posting.delete(String(operation.input.id));
      }
    }
    const state = (connection.sessions ??= emptySessions());
    const reply = await this.options.request<TeamSessions>(
      connection,
      "/v1/worker-sessions?workspaceId=" +
        encodeURIComponent(connection.credential.workspaceId) +
        "&after=" +
        state.cursor,
    );
    if (
      reply.version !== 1 ||
      !Array.isArray(reply.sessions) ||
      !Array.isArray(reply.commands) ||
      !Number.isSafeInteger(reply.cursor)
    )
      throw Error("The Team service returned an invalid session update.");
    for (const value of [...reply.sessions, ...reply.commands])
      this.accept(connection, value);
    changed ||= state.cursor !== reply.cursor;
    state.cursor = reply.cursor;
    for (const task of this.options
      .state()
      .tasks.filter(
        (t) => t.projectId === connection.projectId && !t.sharedSession,
      )) {
      const claim = connection.leases.get(task.id);
      const prior = latestSession(
        state,
        this.options.remoteId(connection, task.id),
      );
      const own =
        prior?.owner.deviceId === connection.credential.deviceId &&
        prior.owner.memberId === connection.credential.memberId;
      if (!claim && !own) continue;
      if (!task.run.startedAt) continue;
      const review =
        this.reviews.get(task.id) ??
        (task.codeReview
          ? await this.options.loadReview?.(task.id)
          : undefined) ??
        undefined;
      if (review) this.reviews.set(task.id, review);
      const payload = sessionPayload.parse({
        id: claim?.attemptId ?? prior!.id,
        epoch: claim?.epoch ?? prior!.epoch,
        storyId: this.options.remoteId(connection, task.id),
        harness: task.harness,
        requestedModel: task.route?.model,
        actualModel: task.run.measurements?.modelId,
        route: task.route ? { ...task.route, reasons: [] } : undefined,
        state: task.run.state,
        startedAt: task.run.startedAt,
        finishedAt: task.run.finishedAt,
        error: task.run.error ? safeText(task.run.error) : undefined,
        activity: task.run.activity
          ? {
              phase: task.run.activity.phase,
              label:
                progressLabels[task.run.activity.phase] ??
                "Working on the story",
              updatedAt: task.run.activity.at,
            }
          : undefined,
        messages: task.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map(publicMessage),
        review: review
          ? JSON.parse(
              JSON.stringify(
                {
                  ...review,
                  taskId: this.options.remoteId(connection, task.id),
                },
                (_key, value) =>
                  typeof value === "string" ? safeText(value) : value,
              ),
            )
          : undefined,
      });
      const key = connection.credential.workspaceId + ":" + payload.id,
        stamp = hash(payload),
        sent = this.published.get(key);
      if (sent?.hash === stamp && Date.now() - sent.at < 15000) continue;
      const current = state.sessions.find((s) => s.id === payload.id);
      const patch = current
        ? {
            ...payload,
            messages: payload.messages.filter(
              (m) =>
                hash({ ...publicMessage(m), actor: undefined }) !==
                  hash({
                    ...publicMessage(
                      current.messages.find((p) => p.id === m.id) ?? m,
                    ),
                    actor: undefined,
                  }) || !current.messages.some((p) => p.id === m.id),
            ),
            review:
              hash(payload.review) === hash(current.review)
                ? undefined
                : payload.review,
          }
        : payload;
      const published = await this.options.request<TeamSession>(
        connection,
        "/v1/worker-sessions",
        {
          workspaceId: connection.credential.workspaceId,
          expectedRevision: current?.revision ?? 0,
          delta: !!current,
          session: patch,
        },
      );
      this.accept(connection, published);
      this.published.set(key, { hash: stamp, at: Date.now() });
      changed = true;
    }
    for (const command of state.commands.filter((c) =>
      ["queued", "received"].includes(c.state),
    )) {
      const session = latestSession(state, command.storyId);
      const original = state.sessions.find((s) => s.id === command.sessionId);
      if (
        session?.owner.deviceId !== connection.credential.deviceId ||
        session.owner.memberId !== connection.credential.memberId ||
        original?.owner.deviceId !== session.owner.deviceId ||
        original.owner.memberId !== session.owner.memberId
      )
        continue;
      const task = this.options
        .state()
        .tasks.find(
          (t) =>
            t.id === this.options.localId(connection, command.storyId) &&
            t.projectId === connection.projectId,
        );
      if (!task || !this.options.deliver) continue;
      if (command.kind !== "followup") {
        if (this.executing.has(command.id)) continue;
        const report = this.reviews.get(task.id);
        if (
          command.kind === "review-question" &&
          (!report ||
            !["completed", "failed", "stale", "cancelled"].includes(
              report.state,
            ) ||
            report.reviewer?.state === "running")
        )
          continue;
        const picked = await this.options.request<SessionCommand>(
          connection,
          "/v1/session-commands/receipt",
          {
            workspaceId: connection.credential.workspaceId,
            id: command.id,
            state: "picked-up",
          },
        );
        this.accept(connection, picked);
        changed = true;
        if (picked.state !== "picked-up") continue;
        this.executing.add(command.id);
        void this.options
          .deliver(task, picked)
          .catch(async (error) => {
            this.accept(
              connection,
              await this.options.request<SessionCommand>(
                connection,
                "/v1/session-commands/receipt",
                {
                  workspaceId: connection.credential.workspaceId,
                  id: command.id,
                  state: "failed",
                  error: String(error.message ?? error).slice(0, 2000),
                },
              ),
            );
            await this.options.persist();
            await this.options.changed();
          })
          .catch(() => {})
          .finally(() => this.executing.delete(command.id));
        continue;
      }
      await this.options.deliver(task, command);
      if (command.state === "queued") {
        this.accept(
          connection,
          await this.options.request<SessionCommand>(
            connection,
            "/v1/session-commands/receipt",
            {
              workspaceId: connection.credential.workspaceId,
              id: command.id,
              state: "received",
            },
          ),
        );
        changed = true;
      }
    }
    connection.sessionsError = undefined;
    this.apply(connection);
    if (changed) {
      await this.options.persist();
      await this.options.changed();
    }
  }
}
