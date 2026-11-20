import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import type { TeamSnapshot } from "../src/team";
import { applySharedSnapshot, emptySharedProjection, projectSharedState, sharedCommands } from "../runtime/team/projection";
import { teamCommandSchema } from "../runtime/team/protocol";

test("directory scopes produce portable bootstrap commands", () => {
  const { state, task } = fixture();
  task.scope = ["src/components/", "src\\hooks\\", "src/work.ts", "C:/PRIVATE/secret.ts", "src/../secret.ts", "src//invalid.ts", "src/\u0000invalid.ts"];
  const projection = projectSharedState(state, task.projectId);
  assert.deepEqual(projection.stories[0].scope, ["src/components", "src/hooks", "src/work.ts"]);
  for (const command of sharedCommands(emptySharedProjection(), projection))
    assert.equal(teamCommandSchema.safeParse(command).success, true);
  assert.equal(task.scope[0], "src/components/", "local source scope is preserved");
});

function fixture() {
  const state = initialState();
  const task = { ...state.tasks[0], id: "shared-story", projectId: "local-project", example: false, scope: ["src/work.ts", "C:/PRIVATE/secret.ts"], run: { state: "idle" as const, workspace: "C:/PRIVATE/repo", sessionId: "PRIVATE-SESSION" } };
  state.tasks = [task]; state.epics = []; state.cycles = [];
  state.storyComments = []; state.reviewComments = [];
  return { state, task };
}
function snapshot(): TeamSnapshot {
  return { workspaceId: "room", name: "Team", head: 0, stories: [], epics: [], cycles: [], comments: [], claims: [], results: [], activity: [], members: [], readCursors: [] };
}
test("the sharing projection excludes device capabilities, conversations, routes and local paths", () => {
  const { state, task } = fixture();
  task.messages.push({ id: "private", role: "tool", text: "PRIVATE-CREDENTIAL", at: "2026-11-15" });
  state.settings.model = "PRIVATE-MODEL";
  const projection = projectSharedState(state, "local-project");
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /PRIVATE|sessionId|harness|permission|run|messages|evidence|route/);
  assert.deepEqual(projection.stories[0].scope, ["src/work.ts"]);
  const before = structuredClone(projection);
  task.messages.push({ id: "stream", role: "assistant", text: "token token", at: "2026-11-15" });
  task.run.sessionId = "another-local-session";
  assert.deepEqual(sharedCommands(before, projectSharedState(state, "local-project")), []);
  task.title = "A meaningful board change";
  assert.deepEqual(sharedCommands(before, projectSharedState(state, "local-project")), [{ type: "story.patch", storyId: task.id, patch: { title: task.title } }]);
});
test("remote planning updates preserve local worker state and never impersonate a local user", () => {
  const { state, task } = fixture();
  const before = projectSharedState(state, task.projectId);
  const shared = snapshot();
  shared.stories = [{ ...before.stories[0], title: "Renamed by teammate" }, { ...before.stories[0], id: "new-story", title: "A shared brief" }];
  const run = task.run, messages = task.messages;
  applySharedSnapshot(state, task.projectId, shared, before);
  assert.equal(task.title, "Renamed by teammate");
  assert.equal(task.run, run); assert.equal(task.messages, messages);
  assert.equal(task.run.workspace, "C:/PRIVATE/repo");
  assert.equal(state.tasks[1].messages[0].role, "system");
  assert.match(state.tasks[1].messages[0].text, /Shared team brief/);
  const privateCard = { ...task, id: "private-card" }; state.tasks.push(privateCard);
  applySharedSnapshot(state, task.projectId, snapshot(), before);
  assert.ok(state.tasks.includes(privateCard), "Only entities already managed by this team are removed");
});
test("review drafts stay local and explicitly shared review selections use portable references", () => {
  const { state, task } = fixture();
  state.projects.push({ id: task.projectId, name: "Local", description: "", path: "C:/PRIVATE/repo", branch: "main", analysis: "ready", createdAt: "2026-11-15" });
  const reference = { kind: "file" as const, taskId: task.id, name: "work.ts", path: "C:/PRIVATE/repo/src/work.ts", quote: "the exact selected text", lineStart: 12, sessionId: "PRIVATE-SESSION" };
  state.reviewComments = [
    { id: "draft", taskId: task.id, reference, text: "PRIVATE-DRAFT", status: "saved", createdAt: "2026-11-15", updatedAt: "2026-11-15" },
    { id: "sent", taskId: task.id, reference, text: "Please revise", status: "shared", createdAt: "2026-11-15", updatedAt: "2026-11-15" },
  ];
  const projected = projectSharedState(state, task.projectId);
  assert.equal(projected.comments.length, 1);
  assert.equal(projected.comments[0].reference?.path, "src/work.ts");
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
  const command = sharedCommands(emptySharedProjection(), projected).find((command) => command.type === "comment.add");
  assert.equal(command?.type === "comment.add" && command.reference?.line, 12);
});
test("bootstrap creates parent stories before children even when their UUID order is reversed", () => {
  const { state, task } = fixture();
  task.id = "a-child"; task.parentId = "z-parent";
  state.tasks.push({ ...task, id: "z-parent", parentId: null });
  const commands = sharedCommands(emptySharedProjection(), projectSharedState(state, task.projectId));
  assert.deepEqual(commands.filter((command) => command.type === "story.put").map((command) => command.story.id), ["z-parent", "a-child"]);
});
test("bootstrap creates discussion parents before replies regardless of UUID order", () => {
  const { state, task } = fixture();
  const comment = { taskId: task.id, text: "A comment", author: { id: "local", name: "You", source: "local" as const }, createdAt: "2026-11-15", updatedAt: "2026-11-15" };
  state.storyComments = [{ ...comment, id: "a-reply", parentId: "z-parent" }, { ...comment, id: "z-parent" }];
  const commands = sharedCommands(emptySharedProjection(), projectSharedState(state, task.projectId));
  assert.deepEqual(commands.filter((command) => command.type === "comment.add").map((command) => command.commentId), ["z-parent", "a-reply"]);
});
