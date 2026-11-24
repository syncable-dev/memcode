import type { Attachment } from "../src/attachments";
import { attachmentsSchema, type AttachmentStore } from "./attachments";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppState, WorkItem } from "../src/shared";
import { editableFollowup } from "./followup-queue";
import {
  formatReviewMessage,
  reviewReferenceSchema,
  type ReviewComment,
} from "../src/review";
type Register = (
  method: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
function followupBody(text: string, notes: ReviewComment[]) {
  return notes.length
    ? text +
        "\n\n" +
        notes
          .map(
            (comment, index) =>
              `Comment ${index + 1}: ${comment.text}\n` +
              formatReviewMessage("", [comment.reference]),
          )
          .join("\n\n")
    : text;
}
export function migrateReviewComments(state: AppState) {
  state.reviewComments ??= [];
  for (const task of state.tasks)
    for (const message of task.messages) {
      if (!message.references?.length || message.commentIds?.length) continue;
      message.commentIds = message.references.map((reference, index) => {
        const id = `legacy-${message.id}-${index}`;
        if (!state.reviewComments!.some((comment) => comment.id === id))
          state.reviewComments!.push({
            id,
            taskId: task.id,
            reference,
            text: message.text.split("\n\nReference 1:")[0],
            createdAt: message.at,
            updatedAt: message.at,
            status: "shared",
            messageId: message.id,
          });
        return id;
      });
    }
}
export function registerReview(
  register: Register,
  state: () => AppState,
  changed: () => Promise<void>,
  publish: () => void,
  queue?: {
    enqueue: (task: WorkItem, messageId: string) => void;
    dispatchQueued: () => void;
  },
  sharing?: {
    remoteSend(task: WorkItem, body: string): Promise<string | undefined>;
    actor(task: WorkItem): import("../src/team-session").SessionActor | undefined;
    edit(task: WorkItem, messageId: string, text?: string, cancel?: boolean): Promise<boolean>;
    /** The task's worker runs on another computer. */
    isElsewhere?(task: WorkItem): boolean;
  },
  attachments?: AttachmentStore,
) {
  const id = z.string().min(1).max(250),
    task = (taskId: string) => {
      const task = state().tasks.find((t) => t.id === taskId);
      if (!task) throw Error("Work item not found.");
      return task;
    };
  register(
    "review:save",
    z
      .object({
        id: id.optional(),
        taskId: id,
        reference: reviewReferenceSchema,
        text: z.string().trim().min(1).max(10000),
      })
      .strict(),
    async (input) => {
      task(input.taskId);
      if (input.reference.taskId !== input.taskId)
        throw Error("The selection belongs to another work item.");
      const comments = (state().reviewComments ??= []),
        existing = input.id
          ? comments.find((c) => c.id === input.id && c.taskId === input.taskId)
          : undefined;
      if (input.id && !existing) throw Error("Comment not found.");
      if (existing?.status === "shared")
        throw Error(
          "This comment is already in the conversation. Add a new comment to follow up.",
        );
      if (
        comments.filter((c) => c.taskId === input.taskId).length >= 500 &&
        !existing
      )
        throw Error("This card has reached its saved-comment limit.");
      const now = new Date().toISOString(),
        comment: ReviewComment = existing ?? {
          id: randomUUID(),
          taskId: input.taskId,
          reference: input.reference,
          text: input.text,
          createdAt: now,
          updatedAt: now,
          status: "saved",
        };
      Object.assign(comment, {
        reference: input.reference,
        text: input.text,
        updatedAt: now,
      });
      if (!existing) comments.push(comment);
      state().reviewComments = comments;
      await changed();
      publish();
      return comment;
    },
  );
  register(
    "review:delete",
    z.object({ taskId: id, id }).strict(),
    async (input) => {
      task(input.taskId);
      const comment = state().reviewComments?.find(
        (c) => c.id === input.id && c.taskId === input.taskId,
      );
      if (!comment) throw Error("Comment not found.");
      if (comment.status === "shared")
        throw Error(
          "A comment already added to the conversation remains part of its review history.",
        );
      state().reviewComments = state().reviewComments!.filter(
        (c) => c.id !== comment.id,
      );
      await changed();
      publish();
    },
  );
  const send = async (
    input: {
      taskId: string;
      ids?: string[];
      text: string;
      attachments?: Attachment[];
    },
    dispatch = false,
  ) => {
    const item = task(input.taskId),
      ids = [...new Set(input.ids ?? [])],
      comments = ids.map((id) =>
        state().reviewComments?.find(
          (c) => c.id === id && c.taskId === item.id,
        ),
      );
    if (comments.some((c) => !c || c.status !== "saved"))
      throw Error(
        "Choose saved comments that have not yet been added to the conversation.",
      );
    const notes = comments as ReviewComment[],
      references = notes.map((c) => c.reference),
      body = followupBody(input.text, notes);
    if (body.length > 100000)
      throw Error("Select fewer comments for this follow-up.");
    if (dispatch && !item.example && !queue)
      throw Error("Worker dispatch is unavailable.");
    if (input.attachments?.length && sharing?.isElsewhere?.(item))
      throw Error(
        "Files can't be sent to a worker on another computer yet. Remove them, or send them from the computer it runs on.",
      );
    await attachments?.assertKept(input.attachments);
    const messageId = randomUUID(),
      at = new Date().toISOString();
    const remoteId = dispatch ? await sharing?.remoteSend(item, body) : undefined;
    if (remoteId) {
      for (const comment of notes) Object.assign(comment, {status: "shared", messageId: remoteId, updatedAt: at});
      await changed(); publish(); return remoteId;
    }
    item.messages.push({
      id: messageId,
      role: "user",
      actor: sharing?.actor(item),
      text: body,
      at,
      references: notes.length ? references : undefined,
      commentIds: notes.length ? ids : undefined,
      reviewText: notes.length ? input.text : undefined,
      ...(input.attachments?.length
        ? { attachments: input.attachments }
        : {}),
    });
    item.updatedAt = at;
    for (const comment of notes)
      Object.assign(comment, { status: "shared", messageId, updatedAt: at });
    // The Send authorization and its message are saved in the same snapshot.
    if (dispatch && !item.example) queue!.enqueue(item, messageId);
    await changed();
    publish();
    if (dispatch && !item.example) queue!.dispatchQueued();
    return messageId;
  };
  register(
    "review:share",
    z
      .object({
        taskId: id,
        ids: z.array(id).min(1).max(30),
        text: z.string().trim().min(1).max(20000),
        attachments: attachmentsSchema.optional(),
      })
      .strict(),
    (input) => send(input),
  );
  register(
    "review:send",
    z
      .object({
        taskId: id,
        ids: z.array(id).min(1).max(30).optional(),
        text: z.string().trim().min(1).max(20000),
        attachments: attachmentsSchema.optional(),
      })
      .strict(),
    async (input) => ({ messageId: await send(input, true) }),
  );
  register(
    "review:queue-update",
    z
      .object({
        taskId: id,
        messageId: id,
        text: z.string().trim().min(1).max(20000),
        commentEdits: z
          .array(
            z
              .object({ id, text: z.string().trim().min(1).max(10000) })
              .strict(),
          )
          .max(30)
          .optional(),
      })
      .strict(),
    async (input) => {
      if (await sharing?.edit(task(input.taskId), input.messageId, input.text)) return;
      const item = task(input.taskId),
        message = editableFollowup(item, input.messageId),
        edits = new Map<string, string>(
          (input.commentEdits ?? []).map(
            (edit: { id: string; text: string }) => [edit.id, edit.text],
          ),
        );
      if (edits.size !== (input.commentEdits ?? []).length)
        throw Error("Choose each attached comment only once.");
      const notes = (message.commentIds ?? []).map((commentId) => {
        const note = state().reviewComments?.find(
          (comment) =>
            comment.id === commentId &&
            comment.taskId === item.id &&
            comment.messageId === message.id,
        );
        if (!note) throw Error("An attached review comment is unavailable.");
        return { ...note, text: edits.get(commentId) ?? note.text };
      });
      if (
        [...edits.keys()].some(
          (commentId) => !notes.some((note) => note.id === commentId),
        )
      )
        throw Error("Only comments attached to this follow-up can be edited.");
      const body = followupBody(input.text, notes);
      if (body.length > 100000) throw Error("This follow-up is too long.");
      const at = new Date().toISOString();
      for (const note of notes) {
        const stored = state().reviewComments!.find(
          (comment) => comment.id === note.id,
        )!;
        stored.text = note.text;
        stored.updatedAt = at;
      }
      message.text = body;
      if (notes.length) message.reviewText = input.text;
      item.updatedAt = at;
      await changed();
      publish();
    },
  );
  register(
    "review:queue-cancel",
    z.object({ taskId: id, messageId: id }).strict(),
    async (input) => {
      if (await sharing?.edit(task(input.taskId), input.messageId, undefined, true)) return;
      const item = task(input.taskId),
        message = editableFollowup(item, input.messageId);
      message.followupState = "cancelled";
      item.updatedAt = new Date().toISOString();
      await changed();
      publish();
    },
  );
}
