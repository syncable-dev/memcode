import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectEpicReceipt,
  composeEpicHandoff,
  type EpicReceipt,
  type StoryReceipt,
} from "../runtime/handoff.ts";
import { createRuntime } from "../runtime/app.ts";
import type { NativeHost } from "../runtime/host.ts";
import type {
  Epic,
  FleetConflict,
  Message,
  Project,
  WorkItem,
} from "../src/shared.ts";
import type { WorkerChanges } from "../src/changes.ts";

const withoutAttribution = {};
const withAttribution = { orchestratedBy: "MemCode 0.3.0" };

function storyReceipt(overrides: Partial<StoryReceipt> = {}): StoryReceipt {
  return {
    identifier: "MC-41",
    title: "Rotate session tokens",
    harness: "claude",
    files: 2,
    additions: 188,
    deletions: 74,
    paths: ["auth/session.ts", "auth/token.ts"],
    report:
      "Replaced the session cookie with a rotating token pair.\n\n- `npm test` passed for the auth suite.",
    ...overrides,
  };
}

function receipt(overrides: Partial<EpicReceipt> = {}): EpicReceipt {
  return {
    identifier: "MC-12",
    title: "Replace cookie sessions with rotating tokens",
    summary: "Sessions should survive restarts and rotate safely.",
    generic: false,
    branch: "epic/session-auth",
    stories: [
      storyReceipt(),
      storyReceipt({
        identifier: "MC-42",
        title: "Add refresh endpoint",
        harness: "codex",
        files: 1,
        additions: 96,
        deletions: 12,
        paths: ["api/refresh.ts"],
        report: undefined,
        brief: "Expose POST /auth/refresh for the new tokens.",
      }),
    ],
    decisions: [],
    openConflicts: 0,
    activeStories: 0,
    ...overrides,
  };
}

function sections(markdown: string): string[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
}

test("the PR reads like a reviewer's PR: summary, changes, test plan, receipt last", () => {
  const { pullRequest } = composeEpicHandoff(receipt(), withoutAttribution);
  assert.deepEqual(sections(pullRequest), ["Summary", "Changes", "Test plan"]);
  assert.match(
    pullRequest,
    /^## Summary\n\nSessions should survive restarts and rotate safely\.\n\n- Rotate session tokens \(MC-41\)\n- Add refresh endpoint \(MC-42\)$/m,
  );
  assert.ok(
    pullRequest.trimEnd().endsWith("</details>"),
    "the fleet receipt closes the description",
  );
  assert.ok(
    pullRequest.indexOf("<details>") > pullRequest.indexOf("## Test plan"),
  );
});

test("each story explains its change with the agent's report, or its brief", () => {
  const { pullRequest } = composeEpicHandoff(receipt(), withoutAttribution);
  assert.match(
    pullRequest,
    /^### MC-41 · Rotate session tokens\n_Claude Code · 2 files · \+188 −74_\n\nReplaced the session cookie with a rotating token pair\.\n\n- `npm test` passed for the auth suite\.\n\nFiles: `auth\/session\.ts`, `auth\/token\.ts`$/m,
  );
  assert.match(
    pullRequest,
    /^### MC-42 · Add refresh endpoint\n_Codex · 1 file · \+96 −12_\n\nExpose POST \/auth\/refresh for the new tokens\.\n\nFiles: `api\/refresh\.ts`$/m,
  );
});

test("long file lists and long reports stay readable", () => {
  const paths = Array.from({ length: 9 }, (_, i) => `src/file${i}.ts`);
  const report = Array.from(
    { length: 12 },
    (_, i) => `Paragraph ${i} ${"word ".repeat(30)}`,
  ).join("\n\n");
  const { pullRequest } = composeEpicHandoff(
    receipt({ stories: [storyReceipt({ paths, files: 9, report })] }),
    withoutAttribution,
  );
  assert.match(
    pullRequest,
    /^Files: `src\/file0\.ts`, .*`src\/file5\.ts` and 3 more$/m,
  );
  assert.match(pullRequest, /^Paragraph 0 /m);
  assert.doesNotMatch(pullRequest, /^Paragraph 11 /m);
  assert.match(pullRequest, /^…$/m);
});

test("decisions a person made are surfaced for reviewers; the section disappears when empty", () => {
  const quiet = composeEpicHandoff(receipt(), withoutAttribution);
  assert.ok(!sections(quiet.pullRequest).includes("Decisions for reviewers"));
  const { pullRequest } = composeEpicHandoff(
    receipt({
      decisions: [
        {
          kind: "human",
          summary: "MC-41 and MC-43 disagree on where refresh lives",
          resolution: "Keep token refresh in middleware",
          winner: "MC-41",
        },
        {
          kind: "coordination",
          summary: "MC-41 and MC-42 both edit auth/session.ts",
        },
      ],
      openConflicts: 1,
    }),
    withoutAttribution,
  );
  assert.deepEqual(sections(pullRequest), [
    "Summary",
    "Changes",
    "Decisions for reviewers",
    "Test plan",
  ]);
  assert.match(
    pullRequest,
    /^- \*\*Keep token refresh in middleware\*\* \(MC-41\)\. The agents disagreed: MC-41 and MC-43 disagree on where refresh lives$/m,
  );
  assert.match(
    pullRequest,
    /^- \*\*Still open:\*\* 1 Fleet conflict\. Resolve it in Decisions before merging\.$/m,
  );
  const decisions = pullRequest.slice(
    pullRequest.indexOf("## Decisions for reviewers"),
    pullRequest.indexOf("## Test plan"),
  );
  assert.doesNotMatch(
    decisions,
    /auth\/session\.ts/,
    "routine coordination stays in the receipt, out of the reviewer's way",
  );
  assert.match(
    pullRequest,
    /^- \*\*Handled by coordination:\*\* MC-41 and MC-42 both edit auth\/session\.ts$/m,
  );
});

test("the test plan never claims the fleet's results were verified", () => {
  for (const options of [withoutAttribution, withAttribution]) {
    const { pullRequest } = composeEpicHandoff(receipt(), options);
    assert.match(
      pullRequest,
      /^## Test plan\n\n- \[ \] I verified these changes\. Test results above are the agents' own reports\.$/m,
    );
  }
});

test("the fleet receipt is folded away at the end with the measured table", () => {
  const story = storyReceipt({ title: "Split a|b parser" });
  const { pullRequest } = composeEpicHandoff(
    receipt({ stories: [story] }),
    withoutAttribution,
  );
  assert.match(
    pullRequest,
    /<details>\n<summary>Fleet receipt · 1 task · 1 agent · epic\/session-auth<\/summary>\n\n\| Task \| Agent \| Files \| Lines \|/,
  );
  assert.match(
    pullRequest,
    /^\| \*\*MC-41\*\* Split a\\\|b parser \| Claude Code \| 2 \| \+188 −74 \|$/m,
  );
  assert.match(pullRequest, /^- No overlaps were recorded\.$/m);
});

test("leaving attribution out removes every MemCode mention", () => {
  const { pullRequest, commitMessage } = composeEpicHandoff(
    receipt(),
    withoutAttribution,
  );
  assert.doesNotMatch(pullRequest + commitMessage, /MemCode/);
});

test("attribution adds one quiet line inside the receipt and an Orchestrated-by trailer", () => {
  const { pullRequest, commitMessage } = composeEpicHandoff(
    receipt(),
    withAttribution,
  );
  assert.match(
    pullRequest,
    /\n_Coordinated by MemCode 0\.3\.0 through Memtrace Fleet\._\n\n<\/details>\n$/,
  );
  assert.match(commitMessage, /\n\nOrchestrated-by: MemCode 0\.3\.0\n$/);
});

test("a generic project epic takes its title from the work, not from 'Project work'", () => {
  const one = composeEpicHandoff(
    receipt({
      title: "Project work",
      summary: undefined,
      generic: true,
      stories: [storyReceipt()],
    }),
    withoutAttribution,
  );
  assert.equal(one.title, "Rotate session tokens");
  assert.match(
    one.pullRequest,
    /^## Summary\n\n- Rotate session tokens \(MC-41\)$/m,
  );
  const two = composeEpicHandoff(
    receipt({ title: "Project work", summary: undefined, generic: true }),
    withoutAttribution,
  );
  assert.equal(two.title, "Rotate session tokens and 1 more change");
});

test("the commit message keeps a short subject and lists what changed", () => {
  const { commitMessage, title } = composeEpicHandoff(
    receipt({
      title: "A very long epic title ".repeat(6),
      decisions: [{ kind: "human", summary: "s", resolution: "r" }],
      openConflicts: 2,
    }),
    withoutAttribution,
  );
  const [subject, blank] = commitMessage.split("\n");
  assert.ok(subject.length <= 72, `subject is ${subject.length} chars`);
  assert.ok(subject.endsWith("…"));
  assert.ok(title.length > 72, "the PR title keeps the full epic title");
  assert.equal(blank, "");
  assert.match(
    commitMessage,
    /^- MC-41 Rotate session tokens \(Claude Code\)\n- MC-42 Add refresh endpoint \(Codex\)$/m,
  );
  assert.match(commitMessage, /^Decisions by a person: 1\.$/m);
  assert.match(commitMessage, /^Open Fleet conflicts: 2\.$/m);
});

function story(
  id: string,
  epicId: string,
  harness: WorkItem["harness"],
  runState: WorkItem["run"]["state"] = "finished",
  messages: Message[] = [],
): WorkItem {
  return {
    id,
    identifier: id.toUpperCase(),
    projectId: "p1",
    title: `Story ${id}`,
    description: `Brief for ${id}`,
    harness,
    epicId,
    messages,
    run: { state: runState, workspace: "/work/checkout" },
  } as unknown as WorkItem;
}

function changes(taskId: string, files: number): WorkerChanges {
  return {
    taskId,
    checkpoints: files
      ? [
          {
            files: Array.from({ length: files }, (_, i) => ({
              path: `src/${taskId}-${i}.ts`,
            })),
          } as unknown as WorkerChanges["checkpoints"][number],
        ]
      : [],
    files,
    additions: files * 10,
    deletions: files,
  };
}

const project = { id: "p1", path: "/work/checkout" } as Project;
const epic = {
  id: "e1",
  projectId: "p1",
  identifier: "MC-12",
  title: "Session tokens",
  description: "Sessions survive restarts.",
  branch: "epic/session-auth",
} as Epic;

function conflict(overrides: Partial<FleetConflict>): FleetConflict {
  return {
    id: "c",
    projectId: "p1",
    branch: "epic/other",
    taskIds: [],
    agentIds: [],
    scope: [],
    severity: "B",
    source: "publish",
    summary: "overlap",
    status: "resolved",
    createdAt: "2026-11-20T10:00:00.000Z",
    ...overrides,
  };
}

const message = (role: Message["role"], text: string) =>
  ({ id: text, role, text, at: "2026-11-20T10:00:00.000Z" }) as Message;

test("the receipt covers this epic's stories that recorded changes", async () => {
  const tasks = [
    story("t1", "e1", "claude", "finished", [
      message("assistant", "Working on it."),
      message(
        "assistant",
        "Done. See [the module](/work/checkout/src/a.ts:12).",
      ),
      message("user", "Thanks"),
    ]),
    story("t2", "e1", "codex"),
    story("t3", "e2", "cursor"),
    story("t4", "e1", "cursor", "running"),
  ];
  const recorded: Record<string, number> = { t1: 2, t2: 0, t3: 5, t4: 1 };
  const result = await collectEpicReceipt(
    { tasks, epics: [epic], fleetConflicts: [], projects: [project] },
    "e1",
    async (task) => changes(task.id, recorded[task.id]),
  );
  assert.deepEqual(
    result.stories.map((s) => [s.identifier, s.harness, s.files, s.paths]),
    [
      ["T1", "claude", 2, ["src/t1-0.ts", "src/t1-1.ts"]],
      ["T4", "cursor", 1, ["src/t4-0.ts"]],
    ],
  );
  assert.equal(result.stories[0].report, "Done. See the module (`src/a.ts`).");
  assert.equal(result.stories[0].brief, "Brief for t1");
  assert.equal(result.stories[1].report, undefined);
  assert.equal(result.activeStories, 1);
  assert.equal(result.summary, "Sessions survive restarts.");
  assert.equal(result.generic, false);
});

test("the default project epic is generic and its boilerplate is not a summary", async () => {
  const generic = {
    ...epic,
    title: "Project work",
    description: "Focused stories for this project.",
    sourceKey: "project-work",
  } as Epic;
  const result = await collectEpicReceipt(
    {
      tasks: [story("t1", "e1", "claude")],
      epics: [generic],
      fleetConflicts: [],
      projects: [project],
    },
    "e1",
    async (task) => changes(task.id, 1),
  );
  assert.equal(result.generic, true);
  assert.equal(result.summary, undefined);
});

test("conflicts belong to the epic by id or by its branch in the same project", async () => {
  const tasks = [story("t1", "e1", "claude")];
  const fleetConflicts = [
    conflict({
      id: "by-id",
      epicId: "e1",
      resolutionKind: "human",
      summary: "refresh placement",
      resolution: "Keep it in middleware",
      winnerTaskId: "t1",
    }),
    conflict({
      id: "by-branch",
      branch: "epic/session-auth",
      resolutionKind: "coordination",
      summary: "shared session file",
      resolution: "Reclassified as coordination.",
    }),
    conflict({ id: "other-epic", epicId: "e2", summary: "elsewhere" }),
    conflict({
      id: "other-project",
      projectId: "p2",
      branch: "epic/session-auth",
      summary: "elsewhere",
    }),
    conflict({ id: "open", epicId: "e1", status: "open" }),
  ];
  const result = await collectEpicReceipt(
    { tasks, epics: [epic], fleetConflicts, projects: [project] },
    "e1",
    async (task) => changes(task.id, 1),
  );
  assert.deepEqual(result.decisions, [
    {
      kind: "human",
      summary: "refresh placement",
      resolution: "Keep it in middleware",
      winner: "T1",
    },
    { kind: "coordination", summary: "shared session file" },
  ]);
  assert.equal(result.openConflicts, 1);
});

test("an unknown epic is refused", async () => {
  await assert.rejects(
    collectEpicReceipt(
      { tasks: [], epics: [], fleetConflicts: [], projects: [] },
      "missing",
      async (task) => changes(task.id, 0),
    ),
    /Goal not found/,
  );
});

test("the attribution choice persists through its own route and survives a stale settings draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-handoff-test-"));
  const host: NativeHost = {
    async call<T>() {
      return undefined as T;
    },
  };
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    runtime = await createRuntime(root, root, host, () => {});
    const state = runtime.store.state;
    const staleSettingsDraft = structuredClone(state.settings);
    await runtime.request("settings:handoff-attribution", {
      attribution: "include",
    });
    assert.equal(state.settings.handoffAttribution, "include");
    await assert.rejects(
      runtime.request("settings:handoff-attribution", { attribution: "always" }),
    );
    await runtime.request("settings:save", staleSettingsDraft);
    assert.equal(
      state.settings.handoffAttribution,
      "include",
      "A settings dialog opened before the choice must not erase it",
    );
    await runtime.request("settings:save", { ...state.settings });

    await runtime.close();
    runtime = undefined;
    const saved = JSON.parse(
      await readFile(join(root, "workspace.json"), "utf8"),
    );
    assert.equal(saved.settings.handoffAttribution, "include");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
