import type { AppState, WorkItem, Stage, Harness } from "./shared";

const at = "2026-11-13T12:00:00.000Z";
const exampleTasks: Array<[string, string, Stage, Harness, string, string]> = [
  [
    "01",
    "Bring project context into every conversation",
    "planned",
    "codex",
    "Intelligence",
    "Connect the selected repository to Memtrace. Give every worker the definitions, relationships and source context relevant to its work.",
  ],
  [
    "02",
    "Turn a spoken idea into a clear runbook",
    "planned",
    "claude",
    "Experience",
    "Capture an idea with local dictation, refine it into a brief, and make the next steps easy to act on.",
  ],
  [
    "03",
    "Shape the worker workspace",
    "working",
    "codex",
    "Design",
    "Create a calm, precise workspace for the fleet. Carry the Memtrace benchmark design language into the board, conversations and review experience.",
  ],
  [
    "04",
    "Connect local harness sessions",
    "working",
    "cursor",
    "Runtime",
    "Run installed coding tools as story workers on a shared epic branch. Memtrace Fleet coordinates their scope and raises unresolved conflicts for a human decision.",
  ],
  [
    "05",
    "Keep the fleet in step",
    "working",
    "codex",
    "Coordination",
    "Use Memtrace Fleet to publish intent and check overlap. Keep coordination visible without making developers manage every detail.",
  ],
  [
    "06",
    "Preview what the worker built",
    "review",
    "claude",
    "Artifacts",
    "Bring local browser previews, reports and screenshots into the work item, without leaving the workspace.",
  ],
  [
    "07",
    "Make every action feel considered",
    "review",
    "codex",
    "Experience",
    "Refine keyboard navigation, empty states and interaction feedback. Keep the first prototype enjoyable to use.",
  ],
  [
    "08",
    "Define the MemCode foundation",
    "done",
    "codex",
    "Architecture",
    "Keep MemCode independent from the Memtrace repository. Establish a lean Electron foundation and an explicit engine boundary.",
  ],
];

function task(row: (typeof exampleTasks)[number]): WorkItem {
  const [n, title, stage, harness, category, description] = row;
  const finished =
    stage === "done" ? 3 : stage === "review" ? 2 : stage === "working" ? 1 : 0;
  return {
    id: `example-${n}`,
    identifier: `MC-${String(Number(n) + 10).padStart(3, "0")}`,
    projectId: "example",
    title,
    description,
    stage,
    harness,
    category,
    priority: ["01", "03", "05"].includes(n) ? "high" : "medium",
    createdAt: at,
    updatedAt: at,
    checklist: [
      "Understand the existing context",
      "Build a focused first iteration",
      "Review the result in the workspace",
    ].map((text, i) => ({ id: `${n}-${i}`, text, done: i < finished })),
    messages: [
      { id: `${n}-brief`, role: "user", text: description, at },
      {
        id: `${n}-context`,
        role: "tool",
        text: "Example context · Memtrace\nRepository scope, relevant symbols and recorded decisions belong here. Connect a local project to gather real code context.",
        at,
      },
      {
        id: `${n}-response`,
        role: "assistant",
        text:
          n === "03"
            ? "I’ll start with the way the workspace feels.\n\nThe board should make the next step obvious. Each work item will carry its conversation, runbook and output, so moving between planning and implementation feels natural.\n\nFor the first iteration:\n• A quiet paper surface, precise typography and restrained mint accents.\n• Work grouped by progress, with a compact list when you need the whole picture.\n• One focused conversation with browser and artifact context close by.\n\nThis is an example session. No agent is running."
            : "The brief is ready to explore. I would first read the relevant source, define a small implementation slice, and return a reviewable result.\n\nThis is an example conversation. Connect a project and start a worker to run real work.",
        at,
      },
    ],
    run: { state: "idle" },
    example: true,
  };
}

export function initialState(): AppState {
  return {
    version: 1,
    projects: [
      {
        id: "example",
        name: "Design preview",
        description:
          "A local workspace for ideas, agents, and the work between them.",
        path: null,
        branch: "main",
        analysis: "idle",
        example: true,
        createdAt: at,
      },
    ],
    tasks: exampleTasks.map((value) => {
      const example = task(value);
      if (example.stage === "review") example.statusId = "example:review";
      return example;
    }),
    epics: [],
    qualitySnapshots: [],
    cycles: [],
    savedViews: [],
    workflowStates: [],
    customFields: [],
    planning: {
      startedAt: new Date().toISOString(),
      events: [],
      observations: {},
    },
    fleetConflicts: [],
    artifacts: [],
    activeProjectId: "example",
    settings: {
      memtracePath: "",
      speechEndpoint: "http://127.0.0.1:8080/inference",
      defaultHarness: "codex",
      model: "",
      localModel: false,
      maxWorkers: 2,
    },
  };
}
