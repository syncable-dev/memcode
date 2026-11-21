import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppState } from "../src/shared";
import type { StoryAuthor, StoryComment } from "../src/story-comments";
type Register = (
  method: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
const localAuthor: StoryAuthor = {
  id: "local-owner",
  name: "You",
  source: "local",
};
/** Story discussion is deliberately stored outside worker conversation messages. */
export function registerCardComments(
  register: Register,
  state: () => AppState,
  changed: () => Promise<void>,
  author: (taskId?: string) => StoryAuthor | undefined = () => undefined,
) {
  const id = z.string().min(1).max(250),
    text = z.string().trim().min(1).max(20000),
    current = (taskId?: string) => author(taskId) ?? localAuthor,
    task = (taskId: string) => {
      if (!state().tasks.some((t) => t.id === taskId))
        throw Error("Work item not found.");
    },
    owned = (taskId: string, commentId: string) => {
      task(taskId);
      const comment = state().storyComments?.find(
        (c) => c.id === commentId && c.taskId === taskId,
      );
      if (!comment || comment.deletedAt) throw Error("Comment not found.");
      if (
        comment.author.id !== current(taskId).id ||
        comment.author.source !== current(taskId).source
      )
        throw Error("Only the author can change this comment.");
      return comment;
    };
  register("story-comment:identity", z.undefined(), () => ({ ...current() }));
  register(
    "story-comment:add",
    z.object({ taskId: id, text, parentId: id.optional() }).strict(),
    async (input) => {
      task(input.taskId);
      const comments = (state().storyComments ??= []);
      if (comments.filter((c) => c.taskId === input.taskId).length >= 1000)
        throw Error("This task has reached its comment limit.");
      if (
        input.parentId &&
        !comments.some(
          (c) =>
            c.id === input.parentId && c.taskId === input.taskId && !c.parentId,
        )
      )
        throw Error("Reply to a comment in this task.");
      const at = new Date().toISOString(),
        comment: StoryComment = {
          id: randomUUID(),
          taskId: input.taskId,
          text: input.text,
          parentId: input.parentId,
          author: { ...current(input.taskId) },
          createdAt: at,
          updatedAt: at,
        };
      comments.push(comment);
      state().storyComments = comments;
      await changed();
      return comment;
    },
  );
  register(
    "story-comment:edit",
    z.object({ taskId: id, id, text }).strict(),
    async (input) => {
      const comment = owned(input.taskId, input.id);
      comment.text = input.text;
      comment.updatedAt = new Date().toISOString();
      await changed();
    },
  );
  register(
    "story-comment:delete",
    z.object({ taskId: id, id }).strict(),
    async (input) => {
      const comment = owned(input.taskId, input.id);
      comment.text = "";
      comment.deletedAt = comment.updatedAt = new Date().toISOString();
      await changed();
    },
  );
}
