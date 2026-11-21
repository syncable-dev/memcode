import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import { registerCardComments } from "../runtime/card-comments";
import { reviewContext } from "../runtime/review-context";
import type { StoryAuthor } from "../src/story-comments";
function fixture() {
  const state = initialState(),
    routes = new Map<string, { schema: any; run: (input: any) => unknown }>();
  let identity: StoryAuthor | undefined = {
      id: "memtrace-a",
      name: "Alex",
      source: "memtrace",
    },
    saves = 0;
  registerCardComments(
    (name, schema, run) => routes.set(name, { schema, run }),
    () => state,
    async () => {
      saves++;
    },
    () => identity,
  );
  return {
    state,
    setIdentity: (value: StoryAuthor | undefined) => (identity = value),
    saves: () => saves,
    call: async (name: string, input?: unknown) => {
      const route = routes.get(name)!;
      return route.run(route.schema.parse(input));
    },
  };
}
test("story discussion persists with account author and remains outside worker prompts", async () => {
  const h = fixture(),
    task = h.state.tasks[0],
    before = structuredClone(task.messages),
    prompt = reviewContext(task.messages);
  const comment: any = await h.call("story-comment:add", {
    taskId: task.id,
    text: "**Decision:** Keep this as story discussion.",
  });
  assert.equal(comment.author.id, "memtrace-a");
  assert.equal(comment.author.source, "memtrace");
  assert.deepEqual(task.messages, before);
  assert.deepEqual(reviewContext(task.messages), prompt);
  assert.equal(h.state.storyComments?.[0].id, comment.id);
  assert.equal(h.saves(), 1);
  await h.call("story-comment:edit", {
    taskId: task.id,
    id: comment.id,
    text: "Updated discussion",
  });
  assert.equal(comment.text, "Updated discussion");
  const reply: any = await h.call("story-comment:add", {
    taskId: task.id,
    parentId: comment.id,
    text: "Agreed",
  });
  assert.equal(reply.parentId, comment.id);
  await h.call("story-comment:delete", { taskId: task.id, id: comment.id });
  assert.ok(comment.deletedAt);
  assert.equal(comment.text, "");
  assert.equal(
    h.state.storyComments?.find((c) => c.id === reply.id)?.text,
    "Agreed",
  );
});
test("comment edits and replies enforce author and card identity without trusting a client author", async () => {
  const h = fixture(),
    task = h.state.tasks[0],
    other = h.state.tasks[1],
    comment: any = await h.call("story-comment:add", {
      taskId: task.id,
      text: "Owned note",
    });
  await assert.rejects(
    h.call("story-comment:add", {
      taskId: other.id,
      parentId: comment.id,
      text: "Wrong story",
    }),
    /this task/,
  );
  h.setIdentity({ id: "memtrace-b", name: "Other", source: "memtrace" });
  await assert.rejects(
    h.call("story-comment:edit", {
      taskId: task.id,
      id: comment.id,
      text: "Tamper",
    }),
    /author/,
  );
  await assert.rejects(
    h.call("story-comment:delete", { taskId: task.id, id: comment.id }),
    /author/,
  );
  await assert.rejects(
    h.call("story-comment:add", {
      taskId: task.id,
      text: "Forged",
      author: { id: "memtrace-a" },
    }),
    /Unrecognized/,
  );
  h.setIdentity(undefined);
  assert.deepEqual(await h.call("story-comment:identity"), {
    id: "local-owner",
    name: "You",
    source: "local",
  });
});
