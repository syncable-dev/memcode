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
  | "retrieval"
  | "account"
  | "integrations"
  | "inbox";
/** The tools the Integrations group has pages about, each under its own name and logo. */
export const guideIntegrations = [
  { id: "slack", name: "Slack" },
  { id: "linear", name: "Linear" },
] as const;
export type GuideIntegration = (typeof guideIntegrations)[number]["id"];
export interface GuideArticle {
  id: string;
  group: string;
  /** The tool it is about. Its pages sit together under the tool's name. */
  integration?: GuideIntegration;
  title: string;
  summary: string;
  image: string;
  caption: string;
  steps: string[];
  note?: string;
  /** How it works underneath, shown last under its own heading so the basics stay short. */
  details?: string[];
  destination?: GuideDestination;
  related?: string[];
}
export const guideArticles: GuideArticle[] = [
  {
    id: "start",
    group: "Start here",
    title: "Your first project",
    summary:
      "MemCode is one place to plan work and hand it to the coding tools you already use. Add a project, connect a worker, then say what you want.",
    image: "workspace",
    caption: "The board keeps every task and its progress in view.",
    steps: [
      "Add a project. Pick the folder with your code, or start from a new idea.",
      "Connect a worker: Codex, Claude Code, Cursor, GitHub Copilot or DeepSeek Harness. MemCode asks before it uses one.",
      "Say what you want. Choose New work, or press C, and describe it in your own words. Your worker plans it, and you decide when it starts.",
      "When a task is done, review what changed. When a goal’s work is reviewed, ship it.",
    ],
    note: "Skip for now saves your place. To come back, open Docs and choose Guide me through. Watch product tour gives you a quick look around.",
    details: [
      "Setup also connects Memtrace, which reads your code on this computer so workers and reviews have context. Let its first analysis finish before you start.",
      "Each worker has default permissions. Smart auto handles routine approvals where the tool supports it. Standard follows the tool’s normal rules. Full access skips tool approvals and supported sandboxes. A task can override the default.",
      "Two local tools are optional: Whisper dictation for speaking instead of typing, and Qwen 2.5 Coder for planning code searches. Setup downloads only what you pick. Find them later in Settings → Dictation and Local retrieval.",
    ],
    destination: "project",
    related: ["projects", "workers", "epics", "stories", "review", "ship"],
  },
  {
    id: "projects",
    group: "Start here",
    title: "Add a project",
    summary:
      "A project is a folder on your computer and the idea you’re working on.",
    image: "project",
    caption: "Start a new idea or open code you already have.",
    steps: [
      "Open the project selector at the top left and choose Add a project.",
      "For a new idea, pick where it should live, give it a name and say what it’s for. MemCode sets up the folder and an empty board.",
      "For existing code, pick its folder. Memtrace reads the code so later work has context.",
      "Switch projects from the same selector. Each project keeps its own goals, tasks and results.",
      "To remove a project you no longer need, point at it in the selector and choose the bin. Its folder stays on your computer.",
      "Under each project's name, the selector shows its GitHub repository, or its folder when it has none.",
    ],
    note: "Adding or deleting a project never changes your files. Work you haven’t saved to Git stays as it is.",
    details: [
      "A new or empty folder gets a Git repository automatically. For a folder that already has files, initialize Git first or choose the repository’s root folder.",
    ],
    destination: "project",
    related: ["start", "workers", "account"],
  },
  {
    id: "workers",
    group: "Start here",
    title: "Connect a worker",
    summary:
      "Workers are the coding tools you already use. MemCode runs them on your computer, and only after you approve.",
    image: "workers",
    caption:
      "Connect an installed tool, then set its default permissions in Workers.",
    steps: [
      "Install and sign in to a coding tool: Codex, Claude Code, Cursor, GitHub Copilot or DeepSeek Harness.",
      "Open Workers and choose Connect. Read what the connection allows, then approve it.",
      "Set Default permissions on the worker’s card. Every task uses them unless you change them for that task.",
    ],
    note: "Connecting doesn’t start any work. A worker only starts when you start a task.",
    details: [
      "MemCode checks the tool’s existing sign-in without starting a coding session. Model access follows that tool’s own settings, so it may use cloud models. Codex local-model mode is in Settings.",
      "Smart auto handles routine approvals where the tool supports it. Standard follows the tool’s normal rules. Full access skips tool approvals and supported sandboxes.",
      "Change connections and defaults in Workers or Settings → Workers. Changes apply across projects on the next worker pass. Disconnect a worker once its sessions have stopped.",
    ],
    destination: "workers",
    related: ["routing", "privacy", "account"],
  },
  {
    id: "epics",
    group: "Start here",
    title: "Say what you want",
    summary:
      "Describe what you want in plain words. Your worker plans it, and you check the plan before anything starts.",
    image: "story",
    caption: "New work shows the plan and where it goes before you add it.",
    steps: [
      "Choose New work, or press C anywhere outside a text field.",
      "Write what you want, as briefly or fully as you like: “Customers can export reports as CSV.” Your connected worker reads the code and plans it. Nothing changes yet.",
      "Check the plan. A small fix becomes a quick change. Bigger work becomes a goal with its tasks, and a task that needs another says which one it waits for. Separate outcomes become separate goals. If a goal is already changing the same code, the new work joins it. Each task comes with a short runbook of steps; open it to see them.",
      "Change the tasks or where they go if you like, and say when you want each new goal: Now, Next or Later. Then add them, or add them and start the Now work right away. Next and Later goals wait on the Roadmap.",
    ],
    note: "A goal is an outcome you want. A task is one piece of work for a worker. Quick changes are small tasks that ship together. No worker connected yet? Your request becomes one task you can edit.",
    details: [
      "To spot a goal that’s already changing the same code, MemCode compares the files your plan touches with each open goal’s files. The plan names the shared file when it suggests joining a goal.",
      "More options opens the full form, if you’d rather write a task yourself.",
    ],
    destination: "roadmap",
    related: ["roadmap", "stories", "ship", "how-goals-work"],
  },
  {
    id: "stories",
    group: "Start here",
    title: "Work on a task",
    summary:
      "A task is one piece of work. Its card keeps the brief, the worker’s conversation and the results together.",
    image: "story",
    caption:
      "The brief, the conversation and the results stay inside the same card.",
    steps: [
      "Open a task from the board or the Roadmap. Task guide on the card walks you through its tabs.",
      "Read the brief: what should change, and how you’ll know it worked.",
      "Check the worker and model. MemCode picks one for you by default; you can choose your own.",
      "Start the worker and follow along in Conversation. When it’s done, look at Changes, then move the task to Code review.",
    ],
    note: "A good brief: “When [situation], [person] should be able to [action]. Keep [what must not change]. Check it by [how to verify].”",
    details: [
      "The card’s tabs: Conversation for instructions, Queue for follow-ups waiting to be picked up, Comments for discussion, Runbook for the steps and how far along they are, Changes for the edits, Code review, Artifacts for saved output, and Browser and Terminal for the running app.",
      "The Runbook is the task’s steps. A planned task comes with its own; a task you make by hand starts with three standard steps you can replace. The worker ticks each step as it finishes it, so the card’s count moves while it works. A tick is the worker’s own progress report, not proof, so look at its evidence before you accept the work.",
      "If a task truly needs another one to finish first, add it as a prerequisite. The worker waits until the required task is accepted.",
    ],
    destination: "board",
    related: ["prompts", "routing", "changes", "review"],
  },
  {
    id: "review",
    group: "Start here",
    title: "Review the work",
    summary:
      "Code review checks what a task changed, so you can decide what needs a fix and what’s ready.",
    image: "review-overview",
    caption: "Explore a captured example of a change to a sign-in flow.",
    steps: [
      "Move the finished task to Code review. Open its card, choose the Code review tab, then Run code review.",
      "Read the findings. Open one to see the line it’s about, or choose Discuss finding to ask the reviewer a question.",
      "Select the findings that need work and choose Request fixes. The worker picks them up. When it’s done, choose Review again.",
      "When it’s ready, choose Ready for acceptance. Check the result yourself, then mark it Done.",
    ],
    note: "Moving a card doesn’t start a review on its own. If some checks are missing, the review says so. You can continue with a note, and the review stays marked incomplete.",
    details: [
      "Quality of the change compares the changed functions before and after: maintainability, complexity and nesting. A score describes the code’s structure, not whether the change is correct.",
      "Impact & verification shows the code the change could affect and the checks that ran. Evidence & coverage shows what the reviewer could verify.",
      "Dismiss with reason sets a finding aside with your explanation. Reopen it any time under Dismissed findings. A new review checks everything again.",
      "The reviewer reads the saved evidence. It doesn’t edit files or run commands.",
    ],
    destination: "board",
    related: ["changes", "ship", "annotations", "insights"],
  },
  {
    id: "ship",
    group: "Start here",
    title: "Ship a goal",
    summary:
      "When the tasks you worked on are reviewed, ship them together. The goal stays open until nothing is left.",
    image: "roadmap",
    caption:
      "MemCode lists every step before it runs. Nothing happens until you click.",
    steps: [
      "Open Roadmap. When every task you worked on in a goal is reviewed, its card offers to ship them. The others stay in the goal.",
      "Read the steps MemCode will take and the description it wrote for reviewers. Edit anything you like.",
      "Confirm. When your team approves the work, finish it from the same place.",
      "Quick changes ship the same way, all together.",
    ],
    note: "After a goal ships, other open goals that use the same files show Needs update. One click on that goal brings it up to date.",
    details: [
      "Shipping a goal commits its work, pushes its branch and opens a pull request. The button reads Create pull request for a goal and Ship quick changes for quick changes.",
      "The description is written for reviewers: a summary, each task’s change in the worker’s own words, decisions a person made, and a test plan. Add a MemCode line adds a short credit.",
      "With the GitHub CLI installed, MemCode creates the pull request and shows its reviews and checks. Merge pull request appears when GitHub would allow the merge. Without the CLI, GitHub opens in your browser with the title and description filled in.",
      "A goal can ship as many pull requests as it needs. Its card lists the ones that merged and how many tasks are left.",
      "Merge here or on GitHub. MemCode notices when you come back, and finishes the tasks that were in it. Newer work ships in the next one.",
      "A task whose worker failed or was stopped holds the pull request. Finish it, or tick the box that ships what it left.",
      "On a team, each person’s work on a goal ships in their own pull request.",
      "Merging moves the reviewed tasks to Done and closes the goal when nothing is left. On a goal marked Needs update, Update from dev saves its work, brings in the newer code and refreshes its code context.",
    ],
    destination: "roadmap",
    related: ["roadmap", "review", "how-goals-work"],
  },
  {
    id: "workspace",
    group: "Your workspace",
    title: "The board",
    summary: "The board shows every task by stage, from planned to done.",
    image: "workspace",
    caption: "Each lane scrolls on its own. Open a card to continue the work.",
    steps: [
      "Open Workspace. Tasks move from Planned to In progress, Code review, Ready for acceptance and Done.",
      "Open a card to see its brief and its worker.",
      "Switch between Board and List, or see dates on a calendar or timeline. Search, filter and group the work, then save a view you like.",
    ],
    details: [
      "You can rename lanes, add your own and set soft work-in-progress limits when the default flow doesn’t fit.",
    ],
    destination: "board",
    related: ["stories", "roadmap", "planning-fields"],
  },
  {
    id: "roadmap",
    group: "Your workspace",
    title: "Goals and the Roadmap",
    summary:
      "The Roadmap shows your goals: the outcomes you’re working toward, and the tasks inside each one.",
    image: "roadmap",
    caption: "Expand a goal to see its tasks and progress.",
    steps: [
      "Open Roadmap. Each goal sits in Now (you’re working on it), Next (up once the goals you’re on now are done) or Later (it should get done, but you haven’t decided when).",
      "Expand a goal to see its tasks. Add more with New work, or from the goal itself.",
      "Tasks in a goal run side by side and stay coordinated, so they don’t step on each other.",
      "When the tasks you worked on are reviewed, ship them from the goal’s card. The goal stays open for the rest.",
    ],
    note: "Name a goal by its outcome, like “Customers can export reports” or “Sign-in feels instant”. Add a line on why it matters.",
    details: [
      "New goal on the Roadmap creates an empty goal you fill in yourself.",
      "The branch beside the project's name at the top shows where new goals start, on every page. MemCode works it out from your repository and says why when you open it. Pick a branch to always use it instead.",
      "Each goal card shows its branch. Before its work starts, you can pick another branch for that goal alone. A goal that names a branch no one here has worked on, such as one copied from another project, offers Start fresh.",
      "Quick changes have their own card. They ship together.",
      "Link tasks when one really needs another to finish first. Child tasks split a big request; related and duplicate links keep context.",
    ],
    destination: "roadmap",
    related: ["epics", "ship", "cycles", "how-goals-work"],
  },
  {
    id: "conversations",
    group: "Your workspace",
    title: "Conversations",
    summary: "Find any worker conversation and pick up where it left off.",
    image: "conversations",
    caption: "Browse conversations as cards or as a table.",
    steps: [
      "Open Conversations to browse your tasks’ threads as cards or a table.",
      "Open a thread to read the worker’s replies, file links, tool details and your follow-ups.",
      "Keep talk that isn’t an instruction in Comments.",
    ],
    destination: "conversations",
    related: ["prompts", "comments", "queue"],
  },
  {
    id: "artifacts",
    group: "Your workspace",
    title: "Artifacts and file previews",
    summary:
      "Open what a worker made, and follow its file links, without leaving the task.",
    image: "artifacts",
    caption:
      "Preview saved output in the task or the project library: documents, images, spreadsheets, slides, PDFs and media.",
    steps: [
      "Open Artifacts on a task, or the Artifacts tab for the whole project.",
      "Preview documents, images, spreadsheets, slides, PDFs, video, audio and code.",
      "Click a file link in a worker’s reply to open a readable preview. Web links open the task’s browser instead.",
      "Select any part to leave precise feedback.",
    ],
    note: "A preview shows saved output. It doesn’t prove the task is finished.",
    details: [
      "Source links can include a line number. Markdown shows as a document; code keeps its line numbers and highlighting.",
      "Office previews show saved content; they aren’t full editors. Spreadsheet values aren’t recalculated, and media playback depends on the system browser.",
    ],
    destination: "artifacts",
    related: ["annotations", "browser", "conversations"],
  },
  {
    id: "activity",
    group: "Your workspace",
    title: "Activity and search",
    summary: "Catch up on what happened without reading every conversation.",
    image: "activity",
    caption: "Activity links each update back to its task.",
    steps: [
      "Open Activity for recent updates from your tasks and workers.",
      "Click an update to jump to its task.",
      `Use Search anything or ${shortcutLabel("K")} to find work. Press C outside a text field to start new work.`,
    ],
    note: "Search and views stay focused on the project you’ve selected.",
    destination: "activity",
  },
  {
    id: "team",
    group: "Your workspace",
    title: "Share a project",
    summary:
      "Share a project with up to two people. Everyone plans on the same board, and each person runs their own workers on their own computer.",
    image: "team",
    caption:
      "Share starts a shared project from the one you have open, with its current board.",
    steps: [
      "Open your project and choose Share at the top right. The shared project takes the project’s name and its current board.",
      "Invite people by email. A project has you and two guests, and an open invitation holds a place.",
      "They find the project in the project switcher and choose Join. On your own other computers, choose Open: signing in is enough.",
      "Plan and comment together right away. To build, each person connects their own copy of the code and approves their own coding tool in Workers.",
      "A worker runs only on the computer that started it. Its conversation stays yours; everyone else sees the request, how it stands, a summary of each round of work, its changes and its review.",
      "Documents and images a worker makes are shared by themselves when it finishes, up to 5 MB each. Share other files from a card’s Artifacts tab. Use Git to exchange code.",
    ],
    note: "Only you can continue your workers, from any of your own computers. Others comment on the card.",
    details: [
      "Renaming or deleting a shared project happens at memtrace.io.",
      "The board doesn’t sync your code, and coordination between workers happens on each computer.",
    ],
    destination: "board",
    related: ["projects", "comments", "artifacts", "account"],
  },
  {
    id: "slack",
    group: "Integrations",
    integration: "slack",
    title: "Connect Slack",
    summary:
      "The people who find problems rarely open your board. They write in Slack. Connect it, and what they report waits in your project’s Inbox.",
    image: "slack",
    caption: "Integrations belong to the project you have open.",
    steps: [
      "Open the project the reports are about. It doesn’t have to be shared.",
      "Open Settings → Integrations and choose Slack.",
      "Choose Add to Slack. In your browser, pick the workspace and choose Allow.",
      "Come back to MemCode. The page turns to Connected within a few seconds.",
      "Tell your team: mention @MemCode in any message to report a problem.",
    ],
    note: "Nothing starts by itself. No AI reads a report on its way to you, and no worker runs until you plan the work.",
    details: [
      "Reports have to wait somewhere while MemCode is closed, so they and their files wait on Memtrace’s sharing service. You need to be signed in. On a project that isn’t shared, only you can see them.",
      "MemCode isn’t in the Slack Marketplace yet, so Slack may say so. Some workspaces let only admins add apps: ask yours to approve MemCode, then choose Add to Slack again.",
      "Disconnect, on the same page, stops the workspace and every channel in it. Reports you already have stay.",
      "Slack’s permissions would let MemCode read messages in channels it was added to. It reads the message someone sends it and, in a thread, the thread’s first message.",
    ],
    destination: "integrations",
    related: ["slack-report", "inbox", "slack-projects"],
  },
  {
    id: "slack-report",
    group: "Integrations",
    integration: "slack",
    title: "Report a problem",
    summary:
      "Mention @MemCode in a message. It goes to the Inbox as written, with its screenshots, files and links, and MemCode answers in the thread.",
    image: "slack",
    caption:
      "Dana answers customers and has never opened MemCode. Sam adds what they found to the same report.",
    steps: [
      "Start with one sentence that says what is wrong. It becomes the report’s title: “The docs search goes blank on iPhone.”",
      "Attach what shows it: pictures, recordings, PDF, Word, Excel, PowerPoint, logs or links.",
      "Mention @MemCode and send. The first time in a channel, Slack offers to add MemCode to it: choose Add.",
      "MemCode answers in the thread: “Added to Lumen › Inbox with 3 files”. Now you know it arrived, and where.",
      "Found out more? Mention @MemCode again in the same thread. What you write, and its files, become a comment on the report.",
    ],
    note: "Anyone in the Slack workspace can report, even if they don’t use MemCode. People from other companies, in a channel you share with them, can’t.",
    details: [
      "Mentioning MemCode in a thread that isn’t a report yet sends the thread’s first message, with what you wrote as its first comment.",
      "Files up to 5 MB are copied, 50 MB for a whole project. Bigger ones stay in Slack and the report links to them. A report is never turned down for its files.",
      "No answer? Type /invite @MemCode in the channel. Private channels always need it.",
      "Replies that don’t mention @MemCode stay in Slack.",
    ],
    related: ["slack-form", "inbox", "slack"],
  },
  {
    id: "slack-form",
    group: "Integrations",
    integration: "slack",
    title: "Add the details",
    summary:
      "Somebody already wrote about the problem in Slack? Send that message to MemCode, and add what’s missing in a short form.",
    image: "slack",
    caption: "The form starts with the message. Only the first question is required.",
    steps: [
      "Point at any message, yours or somebody else’s, and open its ⋯ menu.",
      "Under Connect to apps, choose Send to MemCode.",
      "Say what you expected, where it happens and how bad it is: Someone is blocked, Annoying or An idea.",
      "Add more files if you have them. The message’s own files are sent too.",
      "Choose Send. In the Inbox, each answer has its own line.",
    ],
    note: "The report names who wrote the message, and who sent it in.",
    related: ["slack-report", "inbox"],
  },
  {
    id: "inbox",
    group: "Integrations",
    integration: "slack",
    title: "Read reports in the Inbox",
    summary:
      "Each report keeps its words, its evidence and its thread together, so you see the whole story before you decide anything.",
    image: "slack",
    caption: "Example reports. The one written about last is at the top, and new comments are marked.",
    steps: [
      "Open Inbox. New, Picked up and Declined keep the reports apart.",
      "Read what happened. Names, links and emoji look the way people wrote them.",
      "Click a file to open it inside MemCode: pictures, recordings, PDF, Word, Excel, PowerPoint and text.",
      "Read the thread. Later comments sit under the report with their own files.",
      "Choose Define a goal to work on it, or Decline and say why. Reopen puts a declined report back.",
    ],
    note: "Files that can run, such as programs and web pages, open in Slack only. On Windows, files from a report are marked as downloaded.",
    details: [
      "The Inbox looks for new reports every 15 seconds while it’s open.",
      "On a shared project, everyone on it sees the same Inbox.",
      "A report stays when its Slack message is deleted. Deleting the project deletes its Inbox.",
      "Nobody in Slack is told when a report is picked up or declined, so tell them if they’re waiting.",
    ],
    destination: "inbox",
    related: ["inbox-goal", "slack-report"],
  },
  {
    id: "inbox-goal",
    group: "Integrations",
    integration: "slack",
    title: "Turn a report into a goal",
    summary:
      "Define a goal opens New work with the report, its comments and every file already in it. You add the rest.",
    image: "slack",
    caption: "What the report brings, and the one line the person who picks it up adds.",
    steps: [
      "Open the report and choose Define a goal.",
      "Read all of the request, and take out anything that isn’t about the problem. Workers act on what is here.",
      "Say what each file shows: “What customers see”, “Which devices we tried”.",
      "Add how you want it solved: “Fix it for iPhone and iPad, and add a check so it can’t come back.”",
      "Choose Plan it. Your worker plans the work, and you check the plan as usual.",
    ],
    note: "Anyone in the workspace can write a report. MemCode leaves out characters people can’t see and tells workers a report isn’t instructions, but you are the one who decides what starts.",
    details: [
      "Workers get the files themselves, your notes, and the words of Word, Excel, PowerPoint and PDF files as plain text. Claude and Codex are shown the pictures.",
      "The whole report is attached as slack-report.md. The report is marked picked up and linked to the goal.",
    ],
    destination: "inbox",
    related: ["epics", "inbox", "ship"],
  },
  {
    id: "slack-projects",
    group: "Integrations",
    integration: "slack",
    title: "Several projects",
    summary:
      "Connect the same Slack workspace to more than one project. MemCode asks once per channel which one a report is for.",
    image: "slack",
    caption: "MemCode asks in the thread. The channel remembers the answer.",
    steps: [
      "Open each project and add the same workspace in Settings → Integrations → Slack.",
      "When a message doesn’t say which project it’s about, MemCode asks in the thread, with a button for each.",
      "Choose one. “This channel now sends reports to Checkout.” Later reports from that channel go there without asking.",
      "Name the project in the first message and MemCode doesn’t have to ask: “@MemCode Lumen: the install page still shows last year’s screenshots”.",
      "Wrong project? Type /memcode unlink in the channel. The next report there asks again.",
    ],
    note: "A channel keeps its project. One that already sent reports stays with the project it has when you connect another.",
    destination: "integrations",
    related: ["slack", "slack-report", "projects"],
  },
  {
    id: "linear",
    group: "Integrations",
    integration: "linear",
    title: "Connect Linear",
    summary:
      "Your team plans in Linear and the work is done here. Connect a project to a team, and its issues are cards on your board, in step both ways.",
    image: "linear",
    caption: "Integrations belong to the project you have open.",
    steps: [
      "Open the project the team’s code is in.",
      "Open Settings → Integrations and choose Linear.",
      "Choose Connect Linear. In your browser, choose Authorize.",
      "Or choose Use an API key instead: make one in Linear under Settings › Security & access, with Read and Write.",
      "Choose what to bring in. Nothing changes until you choose Import.",
    ],
    note: "Nothing in Linear starts a worker. An issue is a card until you start it.",
    details: [
      "MemCode on this computer talks to Linear directly. Your sign-in is kept in this computer’s credential store, never in the workspace.",
      "Linear is looked at every 30 seconds while MemCode is open. While it is closed nothing goes back and forth, and the next start catches up.",
      "What MemCode does in Linear is done as you.",
      "On a shared project one person connects, and everyone has the cards. Linear’s page says who it is. Somebody else who has connected can choose Do it from here.",
      "Disconnect keeps the cards, leaves Linear as it is and ends the sign-in there too. Connecting again goes on from there and makes no doubles.",
    ],
    destination: "integrations",
    related: ["linear-import", "linear-steps", "linear-apart"],
  },
  {
    id: "linear-import",
    group: "Integrations",
    integration: "linear",
    title: "Bring issues in",
    summary:
      "Pick a team and how much of it to bring. Each issue becomes one task, with its words, people, dates, labels and comments.",
    image: "linear",
    caption: "An issue keeps its Linear key on the card.",
    steps: [
      "Choose the team, and Open work, The current cycle or Everything.",
      "Choose what becomes a goal: milestones, parent issues, or nothing.",
      "Look through Check the statuses if your team has its own. MemCode has filled them in.",
      "Choose Import. Your cards are on the board in a few seconds.",
      "Start a worker on one when you want it built. It reads the issue as its brief.",
    ],
    note: "An import can be undone for seven days. Cards somebody worked on stay, and Linear is not changed.",
    details: [
      "A milestone is a goal. A project without milestones is one goal. A Linear cycle is a cycle here: Linear starts and ends it, and MemCode follows.",
      "An issue without a project is a task without a goal until it starts.",
      "Issues made in Linear later come in by themselves when they fit what you chose.",
      "Open work leaves out what is done or canceled. Issues in triage are never brought in.",
      "A description longer than a task can hold is shown in part, says so, and is never sent back.",
    ],
    destination: "integrations",
    related: ["linear", "linear-steps", "epics"],
  },
  {
    id: "linear-steps",
    group: "Integrations",
    integration: "linear",
    title: "What Linear hears",
    summary:
      "Work as you always do. The people who only look at Linear see how far it is.",
    image: "linear",
    caption: "The statuses are your team’s own. You can choose others under Check the statuses.",
    steps: [
      "Start a worker: the issue moves to In Progress.",
      "The worker finishes: the issue moves to In Review.",
      "Open the pull request: it is linked on every issue that is in it.",
      "Merge it: those issues are Done. Issues still open in the goal stay as they are.",
      "Change a title, priority, person, label, date, cycle or goal on either side, and the other follows. Comments go both ways too.",
    ],
    note: "A new task here becomes an issue. Tick Keep in MemCode when you make it if it should not.",
    details: [
      "A change here is sent within a few seconds. A change there arrives within half a minute.",
      "While a worker runs, a change in Linear that would move its card waits until the worker ends.",
      "Cancel task and its issue, at the bottom of a task’s details, cancels both. Archive task hides the card here only.",
      "To only follow Linear, turn off Send changes from here to Linear.",
    ],
    destination: "board",
    related: ["linear-apart", "ship", "comments"],
  },
  {
    id: "linear-apart",
    group: "Integrations",
    integration: "linear",
    title: "When the two differ",
    summary:
      "Two people can change the same thing in both places at once. The newest change stays, and nothing is thrown away.",
    image: "linear",
    caption: "Only the field both sides changed is affected.",
    steps: [
      "Open the task. Its LINEAR section says how the two stand.",
      "In step: both sides say the same. Sending and Waiting finish by themselves.",
      "A value that gave way is listed there. Choose Put it back to use it after all.",
      "Needs you: Linear refused something, and the reason is there. The rest of the card went through. Change it, or choose Try again.",
      "Unlink lets a card and its issue go their own ways.",
    ],
    note: "Linear never cancels, takes away or moves to another goal what has not shipped. The card says what Linear wanted instead.",
    details: [
      "An issue canceled in Linear while its worker runs stays canceled there. Ship the work, move the card or cancel it here to settle it.",
      "An issue deleted in Linear archives its card, unless there is work on it that has not shipped. Put back in Linear, the card is back too.",
      "A card deleted here leaves its issue alone, and is not brought in again.",
      "An issue moved to another team stops following, and the card says so.",
      "Without a network, changes wait here and go out when it is back.",
    ],
    destination: "board",
    related: ["linear-steps", "linear"],
  },
  {
    id: "prompts",
    group: "Working with workers",
    title: "Prompts and follow-ups",
    summary:
      "Tell the worker the result you want, give it enough context, and say how to check it.",
    image: "story",
    caption:
      "The conversation keeps your brief, the replies and your follow-ups together. Questions and approvals appear beside the message box.",
    steps: [
      "Start with the outcome. Add file links or examples, and say what should stay the same.",
      "Send a follow-up to steer. If the worker is busy, it waits in Queue and goes out after the current pass.",
      "When a worker asks a question or wants approval, answer right above the message box. That reply goes straight to the worker.",
    ],
    note: "Saving a comment or adding it to the message box doesn’t send it. Send is what puts the worker to work.",
    details: [
      "Workers can look up code context through MemCode’s Memtrace tools.",
      "Permissions come from Workers → Default permissions. Use a task’s Permissions selector only to override them, or choose Worker default to reset. Changes apply on the next pass. Questions and Decisions still wait for your answer.",
    ],
    related: ["queue", "annotations", "comments", "dictation"],
  },
  {
    id: "queue",
    group: "Working with workers",
    title: "Queued follow-ups",
    summary:
      "See what the worker will pick up next, and change it before it does.",
    image: "queue",
    caption:
      "Queue shows what’s waiting. Edit or cancel a follow-up before the worker picks it up.",
    steps: [
      "Send a follow-up while the worker is busy. It shows up in the conversation and in Queue.",
      "Open Queue to edit or cancel it before pickup.",
      "When the current pass finishes, the worker picks up everything that’s waiting, together.",
    ],
    note: "Queued means waiting. Picked up means the worker has it; it doesn’t mean the change passed review.",
    details: [
      "Once a follow-up is picked up, it can’t be edited. Send a new one to change direction.",
      "Stop cancels pending delivery. A failure or an unresolved conflict pauses the queue until you take a look.",
      "When you edit a follow-up’s wording, the source references you selected stay attached.",
    ],
    related: ["prompts", "annotations", "review"],
  },
  {
    id: "comments",
    group: "Working with workers",
    title: "Comments and replies",
    summary:
      "Talk about a task without starting a worker or adding to its instructions.",
    image: "comments",
    caption:
      "Comments are for discussion. Use Conversation to tell the worker what to do.",
    steps: [
      "Open Comments on a task to leave a note or reply. Markdown works for lists, links and code.",
      "Edit or remove your own comments.",
      "A comment is discussion. To have a worker act on it, send an instruction in Conversation.",
    ],
    note: "Comments stay on your computer unless you share the project with a team. In a shared project, comments, replies and worker conversations sync with members.",
    related: ["team", "prompts", "account"],
  },
  {
    id: "changes",
    group: "Working with workers",
    title: "Read a task’s changes",
    summary:
      "See exactly what the worker edited, and leave feedback on a specific line.",
    image: "changes",
    caption: "Line numbers and plus and minus signs show exactly what changed.",
    steps: [
      "Open Changes on a task and choose a file. Green lines were added, red lines removed. Scroll sideways for long lines.",
      "Select the lines you want to talk about and save a comment. Add it to a follow-up when you want the worker to act.",
    ],
    related: ["review", "annotations"],
  },
  {
    id: "annotations",
    group: "Working with workers",
    title: "Highlight and comment",
    summary: "Point at the exact text, line, cell, element or moment you mean.",
    image: "annotations",
    caption:
      "Save a comment next to what you selected. Add the ones you want to a follow-up, then send.",
    steps: [
      "Select text in a document or file, lines in Changes, or a range in a spreadsheet. In HTML output you can also pick an element or an area.",
      "Choose Comment and save your note. Nothing is sent yet.",
      "Open Review comments, pick the notes to include and choose Add to follow-up. Check them, then Send.",
    ],
    note: "Videos and audio can attach a timestamp. Terminal output can be copied or attached as feedback too.",
    details: [
      "Comments remember the version they were made on. If the text changes or disappears, MemCode won’t guess a new highlight.",
    ],
    related: ["artifacts", "queue", "terminal"],
  },
  {
    id: "browser",
    group: "Working with workers",
    title: "The live browser",
    summary: "See and use the same page the worker is using.",
    image: "browser",
    caption:
      "The task’s browser shares the page with its worker. Saved HTML artifacts open separately.",
    steps: [
      "Open Browser on a task, or follow a web link from its conversation.",
      "Click, type, scroll and select as usual. The worker uses the same page.",
      "Take control while you work on the page, then hand it back so the worker can continue.",
    ],
    note: "A local app needs its server running. If a link says connection refused, check the task’s Terminal.",
    details: [
      "Saved HTML artifacts open apart from the live browser, so you can view them without the running app.",
    ],
    related: ["terminal", "artifacts"],
  },
  {
    id: "terminal",
    group: "Working with workers",
    title: "Terminals",
    summary:
      "Use a terminal in your project, and see the long-running processes a worker starts.",
    image: "terminal",
    caption: "A dev server shares the same process and output with the worker.",
    steps: [
      "Open Terminal and pick a shell. Add another session when you need one.",
      "Dev servers, watchers and REPLs run in terminals you share with the worker. Short commands stay in the conversation’s tool history.",
      "Select output to copy it or comment on it. Close a tab to end its process.",
    ],
    note: "Restarting the app ends terminal sessions. They aren’t restored.",
    related: ["browser", "annotations"],
  },
  {
    id: "routing",
    group: "Working with workers",
    title: "How MemCode picks a worker",
    summary:
      "By default, each task gets a worker and model that fit how complex its code is. You can always choose your own.",
    image: "routing",
    caption:
      "The route shows what was measured and why this model was picked. Anything not measured yet stays blank.",
    steps: [
      "Open a task. Under Assignment, Automatic means MemCode picks the worker, and Match task complexity picks the model.",
      "Open Why this model? to see what was measured.",
      "Pick a different worker or model for this task whenever you like, before it starts.",
    ],
    note: "A short request can still be hard work. MemCode measures the code, not the length of what you wrote.",
    details: [
      "Memtrace measures the code a task touches: cognitive and cyclomatic complexity, nesting, and what else the change could affect. Simple changes can use lighter models; complex ones get stronger reasoning.",
      "Only connected workers are considered. Unknown or partial measurements are labelled, never filled in.",
      "Routing thresholds are working rules, not calibrated probabilities. Measurements describe the code that was looked at, not a promise about the whole change.",
    ],
    destination: "workers",
    related: ["workers", "insights", "stories"],
  },
  {
    id: "cycles",
    group: "When you need more structure",
    title: "Plan a cycle",
    summary:
      "A cycle is an optional timebox for a focused stretch of work. One cycle can hold work from many goals.",
    image: "cycles",
    caption: "A cycle keeps its scope and progress in one place.",
    steps: [
      "Open Cycles and create a cycle with a start and end date. Give it a short Focus line, like “Reports people can share”.",
      "Add the tasks you plan to finish. Estimates are optional.",
      "Start the cycle when its scope is ready. When it ends, finish it and choose where unfinished work goes: another cycle or back to the backlog.",
    ],
    note: "Try cycles after your first few tasks. MemCode records history from when it starts watching; it doesn’t invent earlier dates.",
    details: [
      "Starting a cycle saves its starting scope. Finishing it saves a final snapshot before anything moves.",
      "Manual estimates are separate from Memtrace’s code measurements.",
    ],
    destination: "cycles",
    related: ["delivery", "roadmap", "planning-fields"],
  },
  {
    id: "delivery",
    group: "When you need more structure",
    title: "Burndown and burnup",
    summary: "See how a cycle is going from the progress MemCode recorded.",
    image: "delivery",
    caption:
      "Charts show recorded history, keeping starting scope apart from work added later.",
    steps: [
      "Open Insights → Delivery for throughput and cycle progress.",
      "Burndown shows the work that’s left. Burnup shows work done against the total.",
      "Check whether a chart counts tasks or estimated points.",
    ],
    note: "Charts only show what MemCode recorded. Projections appear once there’s enough history, and they’re a planning aid, not a promise.",
    details: [
      "Unestimated work and scope changes stay visible instead of disappearing into the line.",
    ],
    destination: "insights",
    related: ["cycles", "improve"],
  },
  {
    id: "planning-fields",
    group: "When you need more structure",
    title: "Labels, estimates and fields",
    summary: "Add structure only when it helps you decide what to do next.",
    image: "workspace",
    caption: "The same task details power filters, lists and planning views.",
    steps: [
      "Use priority and labels to find related work. Add start and due dates for calendar and timeline views.",
      "Add estimates for planning. They’re separate from Memtrace’s code measurements.",
      "Select several tasks to update them together, and save the filtered views you use often.",
    ],
    details: [
      "Workflow lanes and custom fields can be changed to fit the project.",
    ],
    destination: "board",
    related: ["cycles", "workspace"],
  },
  {
    id: "insights",
    group: "When you need more structure",
    title: "Code intelligence",
    summary:
      "Understand your code’s structure and quality before you pick the next change.",
    image: "insights",
    caption:
      "Code intelligence shows measurements, coverage and detailed views of your code.",
    steps: [
      "Open Insights → Code intelligence and refresh the analysis.",
      "Explore quality, architecture, flows, API surface, recent changes, style and rules.",
      "Found something worth fixing? Turn it into new work.",
    ],
    note: "Missing measurements stay unknown. Read the coverage notes before you act.",
    destination: "insights",
    related: ["routing", "improve", "review"],
  },
  {
    id: "improve",
    group: "When you need more structure",
    title: "Measure improvement",
    summary: "Compare your code before and after a change.",
    image: "improve",
    caption:
      "Checkpoints save measurements so later changes can be compared fairly.",
    steps: [
      "Open Improve and capture a checkpoint.",
      "Pick something to fix and do the work.",
      "Refresh the analysis, capture another checkpoint and compare the two.",
    ],
    note: "A hotspot dropping off a short list doesn’t prove it was fixed. Compare the measurements.",
    destination: "improve",
    related: ["insights", "review"],
  },
  {
    id: "account",
    group: "Setup and privacy",
    title: "Your Memtrace connection",
    summary:
      "Memtrace reads your code on this computer. Sign in once; your coding tools connect separately.",
    image: "account",
    caption: "Memtrace and your coding workers are separate connections.",
    steps: [
      "If you’re signed out, MemCode offers sign-in when it opens. Choose Sign in or create account. New users create a free Memtrace account in the same browser flow.",
      "Or open Settings, or the account button in the top bar, and choose Connect Memtrace beta.",
      "Approve the account in your browser. MemCode then prepares its local engine; the installer already includes what it needs.",
      "App updates keep your account and projects. Choose Download update, then Restart to update when you’re ready.",
    ],
    note: "Signing out pauses analysis until you reconnect. MemCode never quietly moves you onto a paid plan.",
    details: [
      "Change account approves a different account. Cancel stops a pending sign-in. Finish active workers before changing accounts.",
      "Use existing CLI setup is an advanced choice with its own account and plan. Normal beta use needs no separate CLI or Node.js.",
      "Joining a team uses its own Memtrace browser approval.",
    ],
    destination: "account",
    related: ["workers", "team", "privacy"],
  },
  {
    id: "dictation",
    group: "Setup and privacy",
    title: "Speak instead of typing",
    summary:
      "Speech recognition on your computer turns your voice into text you can edit.",
    image: "dictation",
    caption:
      "Set up the small local model once, then speak into any message box.",
    steps: [
      "Open Settings → Dictation and choose Set up local dictation. Approve the download.",
      "Use the microphone in a project brief or a task’s message box. Allow microphone access when asked.",
      "Speak, then stop. Read and edit the text before you send it.",
    ],
    note: "Recording never sends anything to a worker by itself. The small default model understands many languages.",
    details: [
      "Advanced settings can use a Whisper server you already run. The microphone and downloads start only when you act.",
    ],
    destination: "settings",
    related: ["prompts", "retrieval"],
  },
  {
    id: "retrieval",
    group: "Setup and privacy",
    title: "Add a local search assistant",
    summary:
      "An optional small model, Qwen 2.5 Coder, helps plan code searches on your computer.",
    image: "dictation",
    caption:
      "The search assistant is separate from the worker that does the task.",
    steps: [
      "Open Settings → Local retrieval and turn on Use a local retrieval assistant.",
      "Choose Set up local retrieval. MemCode downloads and checks the model once.",
      "That’s it. It helps find the right code; your chosen worker still does the work.",
    ],
    note: "Turn it off any time. Memtrace search works without it, and your downloads stay through app updates.",
    destination: "retrieval",
    related: ["routing", "dictation", "workers"],
  },
  {
    id: "privacy",
    group: "Setup and privacy",
    title: "What stays on your computer",
    summary:
      "What stays local, and what a coding tool may send to its provider.",
    image: "workers",
    caption:
      "Approving a worker explains what runs locally and where its model runs.",
    steps: [
      "Your project files, workers, their coordination and saved output live on this computer.",
      "When a worker runs, its coding tool may send relevant context to its model provider. Sign-in stays with that tool.",
      "Team sharing is opt-in. It shares planning, comments and the results you publish.",
      "Connecting an account, approving a worker and starting a task are separate steps. Nothing starts coding just because a tool is installed.",
    ],
    details: [
      "Use local-model mode where your tool supports it, and local speech recognition for dictation.",
    ],
    related: ["workers", "account", "dictation", "team"],
  },
  {
    id: "how-goals-work",
    group: "Behind the scenes",
    title: "How goals work behind the scenes",
    summary:
      "You never need this to use MemCode. It’s what happens with Git when you plan, run and ship goals.",
    image: "roadmap",
    caption:
      "Each goal works in its own space. Nothing is committed, pushed or merged until you click.",
    steps: [
      "Each goal gets its own branch and its own isolated workspace. Your own checkout, and any changes you haven’t committed, stay exactly where they are.",
      "A new goal starts from your team’s integration branch: where your merged pull requests usually go, such as dev, staging or main, read from the project’s history. With no history yet, MemCode uses dev when it exists, otherwise your default branch. You can pick another on the Roadmap. Branch names follow your team’s style.",
      "Tasks in a goal share its branch and workspace, and their workers edit at the same time. Nothing is locked. Each worker says what it is about to change and why, and the others hear about it as it lands. Memtrace Fleet classes every edit: most are independent, some ask a worker to re-read first, and when two changes can’t both stand, the workers involved judge it. Only what they can’t settle comes to you in Decisions.",
      "Quick changes share one short-lived batch per project, with one branch and one pull request. The batch closes when it ships. If the integration branch moves underneath it, the next quick change starts a fresh batch.",
      "Shipping a goal commits its work, pushes its branch and opens a pull request with a description written for reviewers. With the GitHub CLI, you can merge from MemCode when GitHub allows it.",
      "After a goal merges, open goals that touched the same files are flagged Needs update, and an open Quick changes batch always is. Update from dev saves the goal’s work as a commit, merges in the newer integration branch and refreshes its code context. If that would conflict, the update is undone in full and MemCode names the files.",
    ],
    note: "Nothing is committed, pushed or merged without an explicit action that lists each step first. MemCode never deploys.",
    details: [
      "Before a task starts, MemCode checks that any prerequisite from another goal is actually in this goal’s workspace. If its files are missing, the task waits and MemCode names what’s missing.",
      "Each goal has its own code index, so quality, impact and search describe that goal’s code. An idle goal’s index stops once its workers and reviews finish; its files stay on disk for next time.",
      "Workers and reviews share the worker limit in Settings. A goal’s review waits until its edits settle.",
      "On a team, each person runs workers on their own copy of the code. The shared board doesn’t move code between computers; Git does.",
    ],
    destination: "roadmap",
    related: ["fleet", "ship", "roadmap"],
  },
  {
    id: "fleet",
    group: "Behind the scenes",
    title: "Decisions and coordination",
    summary:
      "Workers in the same goal coordinate before they edit. When they truly disagree, Decisions asks you.",
    image: "decisions",
    caption: "Decisions brings a real disagreement to you.",
    steps: [
      "Keep related tasks in the same goal, so their workers coordinate.",
      "Each worker shares its plan and checks the others before editing. Later workers follow the earlier plan, wait for a handoff and reread the code.",
      "When workers pause for you, open Decisions. Read both plans and the evidence, record your choice, then resume the work.",
    ],
    note: "Coordination is cooperative. It isn’t a lock that blocks every file write.",
    details: [
      "Working on the same file is fine on its own. Only a real disagreement about the solution needs you.",
      "Recording a decision doesn’t reset files or restart workers. You choose when to resume.",
    ],
    destination: "fleet",
    related: ["how-goals-work", "roadmap", "review"],
  },
];
