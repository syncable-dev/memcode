import { shortcutLabel } from "./platform";

export type GuideDestination =
  | "project"
  | "workers"
  | "roadmap"
  | "board"
  | "cycles"
  | "insights"
  | "improve"
  | "fleet"
  | "conversations"
  | "artifacts"
  | "activity"
  | "team"
  | "settings"
  | "account";
export interface GuideArticle {
  id: string;
  group: string;
  title: string;
  summary: string;
  image: string;
  caption: string;
  steps: string[];
  note?: string;
  destination?: GuideDestination;
  related?: string[];
}
export const guideArticles: GuideArticle[] = [
  {
    id: "start",
    group: "Start here",
    title: "Your first project",
    summary:
      "Start with a project, connect its code context and approve a worker. Add your first piece of work when you are ready.",
    image: "workspace",
    caption: "The workspace keeps each story and its progress in view.",
    steps: [
      "Choose Add a project from the project selector. Start from an idea or select an existing folder.",
      "The project’s setup guide confirms its purpose and local source. Connect Memtrace, then let its local code analysis finish.",
      "Choose an installed worker. Review what MemCode may use and explicitly approve the connection. Setup does not start it.",
      "Optionally write an epic or story in your own words, or finish setup and leave the board empty. Start a story’s worker only when you choose.",
    ],
    note: "Each project remembers setup progress. Skip for now closes only that project’s guide. The separate preference controls automatic guides for future projects. Reopen either from Docs → Guide me through.",
    destination: "project",
    related: ["projects", "workers", "epics", "stories"],
  },
  {
    id: "projects",
    group: "Start here",
    title: "Create or open a project",
    summary: "A project is the local folder and the idea you are working on.",
    image: "project",
    caption: "Start a new idea or connect an existing local repository.",
    steps: [
      "Use the project selector at the top left, then Add a project.",
      "For a new project, choose a parent folder, give it a name and describe its purpose. MemCode creates a Git repository and an empty board; the project-specific guide helps with the next steps.",
      "For existing work, choose its folder. Memtrace analyzes that repository so later tasks can use its code context.",
      "Switch projects from the same selector. Your stories, epics and outputs remain with their project.",
    ],
    note: "An empty folder gets a Git baseline automatically. For a folder containing existing files, initialize Git first or choose its repository root. Existing source changes are preserved.",
    destination: "project",
  },
  {
    id: "workers",
    group: "Start here",
    title: "Connect your first worker",
    summary:
      "An installed CLI becomes a connected worker only after your approval.",
    image: "workers",
    caption:
      "Connect an installed harness with your approval, then set its default permissions in Workers.",
    steps: [
      "Install and sign in to Codex, Claude Code or Cursor using its own official CLI setup.",
      "Open Workers and choose Connect. Read the local execution and configured-model access explanation.",
      "Approve the connection. MemCode checks the existing CLI sign-in without starting a coding session.",
      "Create a story and send work when you are ready. Disconnect an adapter from Workers when its sessions are stopped.",
    ],
    note: "Cloud models follow your coding tool’s configuration. Local execution does not mean cloud inference is disabled; Codex local-model mode is available in Settings.",
    destination: "workers",
    related: ["account", "routing", "privacy"],
  },
  {
    id: "epics",
    group: "Start here",
    title: "Write your first epic",
    summary:
      "An epic names a useful outcome and groups the stories that move it forward.",
    image: "roadmap",
    caption:
      "Now, Next and Later give the work a direction without requiring a schedule.",
    steps: [
      "Open Roadmap and choose New epic.",
      "Use an outcome as the title: “Launch the first version”, “Improve sign-in” or “Make reports exportable”. Add a short description of why it matters.",
      "Choose Now, Next or Later. Add small stories inside the epic.",
      "Workers on one epic share its Git branch. With the current parallel-capable engine, other epics use separate checkouts with shared Git storage. Keep prerequisite stories explicit so missing code handoffs are caught before a worker starts.",
    ],
    destination: "roadmap",
    related: ["stories", "fleet"],
  },
  {
    id: "stories",
    group: "Start here",
    title: "Write a story a worker can act on",
    summary: "A story is a focused request with a clear result to review.",
    image: "story",
    caption: "The brief, runbook and worker output stay inside the same card.",
    steps: [
      "Choose New story, or add a story inside an epic. Give it a concrete title, such as “Show a useful empty state on the dashboard”. You can also start with the brief; its first line becomes a suggested title.",
      "Describe the current behavior, the change you want, constraints worth preserving and a check that would demonstrate success.",
      "Use the runbook for useful steps. Add source scope when you know it; Memtrace can help qualify the relevant code.",
      "Review the proposed harness/model and start the worker. Read its output and actual changes before marking the story Done.",
    ],
    note: "A useful first prompt: “When [situation], [user] should be able to [action]. Preserve [constraint]. Check it by [verification].”",
    destination: "board",
    related: ["prompts", "routing", "review"],
  },
  {
    id: "prompts",
    group: "Working with agents",
    title: "Prompting and follow-ups",
    summary:
      "Give the worker a result to achieve, enough context to act, and a way to check its work.",
    image: "story",
    caption:
      "The conversation keeps the brief, responses and follow-up composer together. Questions and approvals appear beside the composer.",
    steps: [
      "Start with the outcome. Include relevant file links or examples, and explain the behavior that should remain.",
      "Ask for a focused implementation and appropriate checks. The worker can retrieve code context through MemCode’s Memtrace-backed tools.",
      "Send a follow-up from the composer. If the worker is busy, it queues an automatic next pass after cleanup.",
      "Use the card’s Queue tab to review, edit or cancel requests before they are picked up.",
      "When a worker asks a question or requests approval, answer the request directly above the conversation input. This replies to the same agent; it is separate from a queued follow-up.",
      "Set standard permissions once per connected harness in Workers → Default permissions. Cards inherit that default across projects; use the card’s Permissions selector only for an override, or choose Worker default to reset it. Changes apply on the next worker pass. Questions and Fleet decisions still need your answer.",
    ],
    note: "Saving an annotation and adding it to the composer do not send it. Send is the action that authorizes a worker pass.",
    related: ["queue", "annotations", "comments", "dictation"],
  },
  {
    id: "workspace",
    group: "Your workspace",
    title: "Workspace and board",
    summary: "See what is planned, running, in review and done.",
    image: "workspace",
    caption: "Each board lane scrolls independently.",
    steps: [
      "Open a card to see its complete brief and worker workspace.",
      "Use Board or List for a different view of the same stories. Planning views can also show dates on a calendar or timeline.",
      "Search and filter the visible work. Group it by the field that is useful to you, then save a view.",
      "Customize workflow states and advisory work-in-progress limits when the default flow needs to change.",
    ],
    destination: "board",
    related: ["planning-fields", "review"],
  },
  {
    id: "roadmap",
    group: "Your workspace",
    title: "Roadmap and dependencies",
    summary:
      "Keep the next useful outcome visible while banking ideas for later.",
    image: "roadmap",
    caption: "Expand an epic to work with its stories and prerequisites.",
    steps: [
      "Use Now, Next and Later to organize epics.",
      "Expand an epic to add stories and see its progress.",
      "Add prerequisites when one story genuinely needs another to finish first. Active workers wait for required stories to be accepted.",
      "Use child stories to break a large request into focused work. Related and duplicate links help preserve context.",
    ],
    destination: "roadmap",
    related: ["epics", "stories", "cycles"],
  },
  {
    id: "conversations",
    group: "Your workspace",
    title: "Conversations",
    summary: "Find a thread and pick up the work where it left off.",
    image: "conversations",
    caption: "Cards and a table provide two ways to browse conversations.",
    steps: [
      "Open Conversations to browse the project’s stories as cards or a table.",
      "Open a thread to read rendered agent responses, file links, tool details and user follow-ups.",
      "File links open readable project files or saved artifacts. Web links open that card’s browser.",
      "Keep discussion in Comments when you do not want to instruct a worker.",
    ],
    destination: "conversations",
    related: ["comments", "queue", "files"],
  },
  {
    id: "team",
    group: "Your workspace",
    title: "Work with your team",
    summary:
      "Create a team, share a project and invite your people. Each developer runs their own workers locally.",
    image: "team",
    caption:
      "Open the team’s existing work first. Connect a local checkout and approve a worker when you are ready to code.",
    steps: [
      "Open your project → Team → Create a team. Name it, approve your Memtrace account in the browser, then share the project’s current board.",
      "Choose Invite teammate, optionally restrict the invitation to their verified email, and send the link privately.",
      "Your teammate chooses Join with invitation, checks the team and project, then accepts with their Memtrace account. Current work opens immediately: no empty project or second MemCode installation. Personal projects stay separate.",
      "Plan and comment now. To code, choose Work on this computer: reuse a matching checkout or choose a destination to clone. Existing local changes are preserved; Git repository access is a separate connection.",
      "After local Memtrace analysis, approve your own coding tool in Workers and start a focused story. MemCode confirms its story claim before starting; team updates never start a worker automatically.",
      "Review the result, then publish selected reports or artifacts, up to 5 MiB each. Use Git to exchange code. Browser sessions, terminals, credentials and full agent conversations stay local.",
    ],
    note: "MemCode discovers the official Team service when it is enabled; normal members do not configure a server or receive a setup secret. If Team creation is not available yet, keep working locally and retry after activation. Planning can queue offline; new shared workers need an online claim. The board does not sync your checkout, and Fleet coordination remains local to each computer. Removing Team access blocks future requests; it cannot erase downloaded files or revoke Git access.",
    destination: "team",
    related: ["projects", "comments", "artifacts", "fleet"],
  },
  {
    id: "queue",
    group: "Working with agents",
    title: "Manage queued follow-ups",
    summary:
      "See what the worker will pick up next, and change it before pickup.",
    image: "queue",
    caption:
      "Queue shows what is waiting. Edit or cancel a follow-up before the next worker pass picks it up.",
    steps: [
      "Send a follow-up while the worker is busy. It appears in the conversation and Queue.",
      "Open Queue to edit the instruction and attached comment wording, or cancel it. Original selected source references stay attached.",
      "After the current pass and Fleet cleanup finish, MemCode starts the next pass automatically. Requests available together are handled in that pass.",
      "Once a request is picked into a brief, editing locks. Send a new follow-up to change direction. Stop cancels pending automatic delivery; failures and unresolved conflicts pause it.",
    ],
    note: "A Queued label means waiting. Picked up means the brief has claimed it; included does not mean the requested change has passed review.",
    related: ["annotations", "review", "fleet"],
  },
  {
    id: "comments",
    group: "Working with agents",
    title: "Story comments and replies",
    summary:
      "Discuss a story without starting a worker or adding instructions to its prompt.",
    image: "comments",
    caption:
      "Comments are story discussion. Use Conversation to send an instruction to the worker.",
    steps: [
      "Open Comments in a story to leave a note or reply.",
      "Use Markdown for clear lists, links and code. Edit or remove your own comments.",
      "A comment is discussion. To ask a worker to act on it, explicitly send the relevant instruction through the conversation.",
      "Comments stay local unless you share this project through Team. In a shared project, authored story comments and replies sync with the team; full agent conversations stay local.",
    ],
    related: ["team", "account", "prompts"],
  },
  {
    id: "runbook",
    group: "Working with agents",
    title: "Runbooks and story details",
    summary:
      "Keep the next steps, acceptance checks and planning details close to the work.",
    image: "story",
    caption: "The runbook is a checklist attached to the story.",
    steps: [
      "Use Runbook for a short checklist of implementation and verification steps.",
      "Keep the brief focused on the result. A checklist can describe the sequence without replacing the brief.",
      "Use priority, labels, dates, estimates and relationships to organize the story.",
      "Check the worker’s actual evidence and tests before accepting a result; a checked runbook alone does not prove correctness.",
    ],
    related: ["planning-fields", "review"],
  },
  {
    id: "routing",
    group: "Working with agents",
    title: "How model routing works",
    summary:
      "Memtrace measurements help qualify the work and choose a model and effort.",
    image: "routing",
    caption:
      "The route explains the source measurements and model choice. Unknown source measurements stay blank until the scope is measured.",
    steps: [
      "A defined story is measured on its own. The route names a harness and model without starting the worker.",
      "Inspect cognitive and cyclomatic complexity, nesting, observed impact and the coverage explanation.",
      "Automatic assignment chooses among installed adapters. Connect the named worker before starting. You can choose a harness or model manually when that makes sense.",
      "Read unknown and partial-scope warnings. A short prompt can describe a hard change; task length is not a complexity measurement.",
    ],
    note: "Routing thresholds are provisional capability rules, not calibrated probabilities. Measurements describe the observed source scope, not a guarantee about the whole change.",
    destination: "workers",
    related: ["insights", "fleet"],
  },
  {
    id: "review",
    group: "Working with agents",
    title: "Review changes and accept work",
    summary:
      "Code review brings the story’s findings, measured quality, impact and checks together before your final acceptance.",
    image: "changes",
    caption:
      "Each card shows its worker’s recorded checkpoints and additions/deletions.",
    steps: [
      "Open Changes and choose a file. Syntax colors, line numbers and addition/deletion backgrounds make the edit readable.",
      "Scroll horizontally for long lines. Compare the worker’s checkpoint scope with what you requested.",
      "In Code review, follow the analysis phases. Expand findings, inspect measured complexity and affected code, and check the coverage notes. Ask the separate read-only reviewer about the evidence.",
      "Request fixes to send selected findings to the story’s worker. After a complete review, move to Ready for acceptance, inspect outputs and mark Done when you accept them. MemCode does not automatically push or deploy the change.",
    ],
    related: ["annotations", "artifacts", "browser"],
  },
  {
    id: "annotations",
    group: "Working with agents",
    title: "Highlight and comment on output",
    summary:
      "Attach feedback to the exact text, line, cell, element or moment you mean.",
    image: "annotations",
    caption:
      "Save a comment beside its selected reference. Add chosen comments to a follow-up, then send when ready.",
    steps: [
      "Select text in a document or source file, choose lines in a diff, or select a spreadsheet range. HTML artifacts also support element and area selection.",
      "Choose Comment and save your note. The highlight and pin remain; no message is sent.",
      "Open Review comments, choose the notes to include and Add to follow-up. Review the staged attachments, then Send.",
      "Videos and audio can attach a playback timestamp. Terminal selections can be copied or attached as feedback.",
    ],
    note: "References retain their source version. Removed or ambiguous text is not assigned a guessed highlight after it changes.",
    related: ["files", "queue", "terminal"],
  },
  {
    id: "browser",
    group: "Working with agents",
    title: "The live browser",
    summary: "See and interact with the page the worker is using in that card.",
    image: "browser",
    caption:
      "The card’s live browser shares page state with its worker. Saved HTML artifacts are viewed separately.",
    steps: [
      "Open Browser inside a story, or follow a web link from its conversation.",
      "Use tabs, navigation, selection, scrolling and native page controls. The worker uses MemCode’s browser tools to operate the same page.",
      "Take control while interacting, and return it when the worker should continue.",
      "A local app needs a running server. If a development link reports connection refused, check its Terminal session.",
    ],
    note: "Saved HTML artifacts are separate from live browser tabs. Their saved state can be viewed without joining the running app.",
    related: ["terminal", "artifacts"],
  },
  {
    id: "terminal",
    group: "Working with agents",
    title: "Terminals and running processes",
    summary:
      "Use an interactive terminal in the project and see persistent processes the worker starts.",
    image: "terminal",
    caption:
      "A managed dev server shares the same process and output with the worker.",
    steps: [
      "Open Terminal and choose an available local shell. Add a session when you need another process.",
      "Development servers, watchers and REPLs use persistent managed terminals. Short shell tool calls remain in the conversation’s tool history.",
      "Select output to copy it or add a comment. Resize the card to give the terminal more space.",
      "Close a terminal tab to end its process. Application restarts end these sessions; they are not a restored shell history.",
    ],
    related: ["browser", "annotations"],
  },
  {
    id: "artifacts",
    group: "Your workspace",
    title: "Artifacts and saved output",
    summary: "Open what the worker produced directly, apart from the live app.",
    image: "artifacts",
    caption:
      "Preview saved output in the card or project library: readable documents, images, spreadsheets, presentations, PDFs and media.",
    steps: [
      "Open Artifacts in a story, or use the project-wide Artifacts tab.",
      "Preview Markdown, HTML, images, Word documents, Excel workbooks, presentations, PDFs, video, audio and source text.",
      "Use document pages, spreadsheet tabs, presentation controls, PDF zoom and native media playback as appropriate.",
      "Select useful content to leave precise feedback. A preview is a saved output; it does not prove the underlying task is complete.",
    ],
    note: "Office readers show saved content; they are not full Office editors. Spreadsheet values are not recalculated, and media codecs depend on the system browser.",
    destination: "artifacts",
    related: ["annotations", "files", "browser"],
  },
  {
    id: "files",
    group: "Your workspace",
    title: "File links and readable previews",
    summary: "Follow a reference without leaving the story’s context.",
    image: "annotations",
    caption:
      "Project files and saved artifacts share readable, scoped previews.",
    steps: [
      "Click a file reference in an agent response. Project-relative and saved-artifact links open the appropriate viewer.",
      "Source links can include a line number. Markdown renders as a document; source files retain line numbers and syntax.",
      "Annotate the exact passage or line and send it as a follow-up when ready.",
      "A web address goes to the card’s live browser instead of the file viewer.",
    ],
    related: ["conversations", "artifacts"],
  },
  {
    id: "dictation",
    group: "Start here",
    title: "Speak an idea into a draft",
    summary: "Local speech recognition turns your voice into editable text.",
    image: "dictation",
    caption:
      "Set up the small local model once, then dictate from the composer.",
    steps: [
      "Open Settings → Local dictation. Choose Set up local dictation and approve the runtime/model download.",
      "After setup, use the microphone in a project brief or story composer. Allow microphone access when the system asks.",
      "Speak, then stop the recording. MemCode transcribes locally and adds the result to the draft.",
      "Read and edit the text before sending. Recording never sends a worker prompt by itself.",
    ],
    note: "The default small model supports multiple languages. Advanced settings can use an existing local Whisper server. The microphone and downloads start only after your action.",
    destination: "settings",
  },
  {
    id: "account",
    group: "Your workspace",
    title: "Your Memtrace connection",
    summary:
      "Approve your Memtrace beta account and prepare the local engine. Coding-tool access stays separate.",
    image: "account",
    caption: "Connect Memtrace separately from approving a coding worker.",
    steps: [
      "Open Settings or the account control in the top bar, then choose Connect Memtrace beta.",
      "Approve the intended account in the official browser flow. The Mac and Windows installers include Memtrace and Node.js; MemCode verifies and prepares its private local engine after approval.",
      "Choose Change account to approve a different account. Cancel stops a pending sign-in. Finish active workers before changing their engine access.",
      "Sign out of Memtrace beta pauses analysis until you reconnect or explicitly choose Use existing CLI setup. Local projects and coding-provider sign-ins stay saved; MemCode never silently falls back to a paid CLI plan.",
      "Approve coding adapters separately in Workers. Memtrace access and a coding provider’s authentication serve different roles.",
      "App updates keep your approved account and projects. Choose Download update in the header or Settings → MemCode updates, then Restart to update when ready.",
    ],
    note: "Existing Memtrace CLI setup is an advanced, explicit choice with its own account and plan. Normal beta use needs no separate CLI or global Node installation. Verified Team membership uses its own Memtrace browser approval; CLI license status alone does not identify a person.",
    destination: "account",
    related: ["workers", "team", "privacy"],
  },
  {
    id: "cycles",
    group: "When you need more structure",
    title: "Start your first cycle",
    summary: "A cycle is an optional time window for a focused set of stories.",
    image: "cycles",
    caption: "Cycle scope and recorded progress help make the work manageable.",
    steps: [
      "Open Cycles and create a cycle with start and end dates.",
      "Choose stories to include. Add manual estimates if they help; estimates are separate from measured code complexity.",
      "Start the cycle when its initial scope is ready. Review work and record progress as it happens.",
      "Finish the cycle and explicitly carry unfinished work into another cycle or return it to backlog.",
    ],
    note: "Learn this after your first stories. MemCode records history from when it starts observing; it does not invent earlier delivery dates.",
    destination: "cycles",
    related: ["delivery", "planning-fields"],
  },
  {
    id: "delivery",
    group: "When you need more structure",
    title: "Burndown, burnup and delivery",
    summary:
      "Read recorded progress while keeping scope changes and unknown estimates visible.",
    image: "delivery",
    caption:
      "Charts show captured history and distinguish baseline work from later delivery.",
    steps: [
      "Use Insights → Delivery to see throughput and cycle progress.",
      "Read burndown as remaining recorded scope and burnup as completed work against scope. Check whether the chart uses stories or manual points.",
      "Treat unestimated work and changes in cycle scope explicitly. A chart cannot reconstruct a past it did not observe.",
      "Use projections only when enough compatible evidence exists. They are an aid to planning, not a completion guarantee.",
    ],
    destination: "insights",
    related: ["cycles", "improve"],
  },
  {
    id: "insights",
    group: "When you need more structure",
    title: "Code intelligence",
    summary:
      "Understand the structure and quality of the code before choosing the next change.",
    image: "insights",
    caption:
      "Code intelligence presents source measurements, coverage and detailed views.",
    steps: [
      "Open Insights → Code intelligence and refresh analysis for the selected project.",
      "Explore quality, architecture, execution flows, API surface, changes, styles and rules.",
      "Inspect complexity or impact for a source symbol. Plan a focused story from the relevant finding.",
      "Read the source/index alignment and coverage notes before acting. Missing measurements remain unknown.",
    ],
    destination: "insights",
    related: ["routing", "improve", "fleet"],
  },
  {
    id: "improve",
    group: "When you need more structure",
    title: "Measure improvement",
    summary:
      "Compare compatible code measurements before and after useful work.",
    image: "improve",
    caption:
      "Checkpoints preserve observations so later changes can be compared fairly.",
    steps: [
      "Open Improve and capture a checkpoint from current analysis.",
      "Choose a focused issue and implement a story against it.",
      "Refresh analysis and capture another checkpoint.",
      "Compare compatible revisions and metrics. A hotspot disappearing from a bounded list does not alone prove it was repaired.",
    ],
    destination: "improve",
    related: ["insights", "review"],
  },
  {
    id: "fleet",
    group: "When you need more structure",
    title: "Fleet coordination and decisions",
    summary:
      "Workers share an epic branch and coordinate before editing shared source.",
    image: "decisions",
    caption: "Decisions brings unresolved semantic disagreements to a human.",
    steps: [
      "Keep related stories in the same epic so workers use its shared branch.",
      "A worker publishes a plan and checks other workers before editing. Later workers follow the earlier plan, wait for a handoff and reread the source.",
      "A different proposed solution can be accepted or reconciled by the workers. Ordinary shared-file overlap is not a human conflict by itself.",
      "Use Decisions when an unresolved semantic disagreement needs your choice. Read the plans and evidence before resolving it.",
    ],
    note: "Fleet coordination is cooperative. It is not an operating-system fence that prevents arbitrary filesystem writes.",
    destination: "fleet",
    related: ["epics", "routing", "review"],
  },
  {
    id: "planning-fields",
    group: "When you need more structure",
    title: "Labels, estimates and workflow",
    summary: "Add structure only when it helps you decide what to do next.",
    image: "workspace",
    caption:
      "The same story data supports filters, list views and planning views.",
    steps: [
      "Use priority and labels to find related work. Add start/due dates for calendar and timeline planning.",
      "Use manual story-point estimates for planning, not as substitutes for Memtrace complexity measurements.",
      "Customize workflow states and custom fields for the project’s needs.",
      "Use bulk selection to update related stories together, and save useful filtered/grouped views.",
    ],
    destination: "board",
    related: ["cycles", "workspace"],
  },
  {
    id: "activity",
    group: "Your workspace",
    title: "Activity and finding work",
    summary: "Follow updates without reading every conversation in full.",
    image: "activity",
    caption: "Activity links updates back to the story that produced them.",
    steps: [
      "Open Activity to see recent brief, worker, tool and session updates.",
      "Click an event to return to its story.",
      `Use Search anything or ${shortcutLabel("K")} to find work. C opens a new work item outside text fields.`,
      "Use the project selector to change context; search and work views stay focused on the selected project.",
    ],
    destination: "activity",
  },
  {
    id: "privacy",
    group: "When you need more structure",
    title: "Local execution and model access",
    summary:
      "Understand what stays local and what a connected coding tool may send to its provider.",
    image: "workers",
    caption:
      "Worker connection approval explains the execution and model boundary.",
    steps: [
      "Project files, worker execution, local Fleet coordination and saved outputs live on this computer. Team Sync shares selected planning fields, comments and explicitly published results when you opt in.",
      "A coding tool may send relevant context to its configured model provider when you run a worker. Provider authentication remains with that tool.",
      "Use local-model mode where supported and local speech recognition for dictation.",
      "Account connection, worker approval and starting a coding task are separate actions. Nothing starts coding just because a tool is installed.",
    ],
    related: ["workers", "account", "dictation", "team"],
  },
];
