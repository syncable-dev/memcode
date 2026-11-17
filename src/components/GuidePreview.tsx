import { memo, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  Code2,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Layers,
  Link2,
  MessageSquare,
  Mic,
  Monitor,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { HarnessMark, StageIcon } from "./UI";
import { CodeReviewGuidePreview } from "./CodeReviewGuidePreview";
import "../styles-guide-preview.css";

function Row({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`guide-preview-row ${className}`}>{children}</div>;
}
function Label({ children }: { children: ReactNode }) {
  return <span className="guide-preview-label">{children}</span>;
}
function Action({
  children,
  quiet = false,
}: {
  children: ReactNode;
  quiet?: boolean;
}) {
  return (
    <span className={`guide-preview-action ${quiet ? "quiet" : ""}`}>
      {children}
    </span>
  );
}
function Tabs({ active, items }: { active: string; items: string[] }) {
  return (
    <div className="guide-preview-tabs">
      {items.map((item) => (
        <span key={item} className={item === active ? "active" : ""}>
          {item}
        </span>
      ))}
    </div>
  );
}
function StoryCard({
  title,
  stage = "planned",
}: {
  title: string;
  stage?: "planned" | "working" | "review";
}) {
  return (
    <div className="guide-preview-story">
      <Row>
        <StageIcon stage={stage} />
        <Label>Example story</Label>
      </Row>
      <strong>{title}</strong>
      <p>One focused change. A result you can check.</p>
    </div>
  );
}

function ProjectPreview() {
  return (
    <div className="guide-preview-project">
      <div className="guide-preview-project-menu">
        <Label>Project selector</Label>
        <Row>
          <Layers size={18} />
          <strong>Your project</strong>
          <ChevronDown size={14} />
        </Row>
        <div className="guide-preview-divider" />
        <Row>
          <Plus size={14} />
          Add a project
        </Row>
      </div>
      <ArrowRight className="guide-preview-connector" size={22} />
      <div className="guide-preview-panel">
        <Label>A local place for your work</Label>
        <h4>
          Start with an idea.
          <br />
          Or bring your code.
        </h4>
        <Row>
          <FolderOpen size={15} />
          New project <span className="guide-preview-or">or</span> Existing
          folder
        </Row>
        <p>Memtrace connects code context to the project you select.</p>
      </div>
    </div>
  );
}
function WorkerPreview({ privacy = false }: { privacy?: boolean }) {
  return (
    <>
      <div className="guide-preview-adapters">
        {(["codex", "claude", "cursor"] as const).map((id, index) => (
          <div key={id}>
            <Row>
              <HarnessMark id={id} />
              <Label>Installed</Label>
            </Row>
            <strong>{["Codex", "Claude Code", "Cursor"][index]}</strong>
            <p>Your CLI. Your sign-in.</p>
            <Action quiet>
              <Link2 size={12} />
              Connect
            </Action>
          </div>
        ))}
      </div>
      <div className="guide-preview-callout">
        <ShieldCheck size={18} />
        <div>
          <strong>
            {privacy
              ? "Execution stays on your computer"
              : "Connection begins with your approval"}
          </strong>
          <p>
            {privacy
              ? "Model access follows the selected harness configuration. Review the boundary before connecting."
              : "Review access, approve the connection, then set Default permissions once per harness."}
          </p>
        </div>
      </div>
      <Row className="guide-preview-footnote">
        <span>Worker default</span>
        <ArrowRight size={12} />
        <span>Inherited by stories</span>
        <ArrowRight size={12} />
        <span>Optional card override</span>
      </Row>
    </>
  );
}
function BoardPreview({ roadmap = false }: { roadmap?: boolean }) {
  return (
    <>
      <Row className="guide-preview-section-heading">
        <div>
          <Label>
            {roadmap ? "Epic · one useful outcome" : "Your workspace"}
          </Label>
          <h4>Launch the first version</h4>
        </div>
        <Action quiet>
          <Plus size={12} />
          {roadmap ? "New epic" : "New work item"}
        </Action>
      </Row>
      <div className="guide-preview-board">
        {(roadmap
          ? ["Now", "Next", "Later"]
          : ["Planned", "In progress", "Code review"]
        ).map((lane, index) => (
          <div key={lane}>
            <Row>
              <span className="guide-preview-dot" />
              <strong>{lane}</strong>
            </Row>
            <StoryCard
              title={
                [
                  "Make the first screen useful",
                  "Connect the core experience",
                  "Polish and review",
                ][index]
              }
              stage={
                roadmap
                  ? "planned"
                  : (["planned", "working", "review"][index] as
                      "planned" | "working" | "review")
              }
            />
          </div>
        ))}
      </div>
      <Row className="guide-preview-footnote">
        <GitBranch size={13} />
        {roadmap
          ? "Stories in an epic coordinate on its shared branch."
          : "Open a card to continue the work. Each lane scrolls independently."}
      </Row>
    </>
  );
}
function Composer({ dictation = false }: { dictation?: boolean }) {
  return (
    <div className="guide-preview-composer">
      <p>
        {dictation
          ? "Speak your idea, then review the draft…"
          : "Describe the next change, or add a follow-up…"}
      </p>
      <Row>
        <HarnessMark id="codex" small />
        <span>{dictation ? "Editable draft" : "Your selected worker"}</span>
        <span className="guide-preview-spacer" />
        <Mic size={15} />
        <span className="guide-preview-send">
          <ArrowRight size={13} />
        </span>
      </Row>
    </div>
  );
}
function ConversationPreview({ topic }: { topic: string }) {
  const queue = topic === "queue",
    comments = topic === "comments",
    runbook = topic === "runbook",
    dictation = topic === "dictation";
  const active = queue
    ? "Queue"
    : comments
      ? "Comments"
      : runbook
        ? "Runbook"
        : "Conversation";
  return (
    <>
      <Row>
        <Label>Example story</Label>
        <span className="guide-preview-spacer" />
        <StageIcon stage="working" />
        <span>In progress</span>
      </Row>
      <h4>A useful empty state</h4>
      <Tabs
        active={active}
        items={["Conversation", "Queue", "Comments", "Runbook"]}
      />
      <div className="guide-preview-conversation">
        {queue ? (
          <>
            <Row className="guide-preview-section-heading">
              <strong>Waiting for the next pass</strong>
              <Label>Queued</Label>
            </Row>
            <div className="guide-preview-message">
              <p>Keep the existing navigation and add a clear first action.</p>
              <Row>
                <span className="guide-preview-link">Edit</span>
                <span className="guide-preview-link">Cancel</span>
              </Row>
            </div>
            <p className="guide-preview-muted">
              Edit or cancel before pickup. Ready follow-ups continue
              automatically after the current pass.
            </p>
          </>
        ) : comments ? (
          <>
            <Row>
              <MessageSquare size={16} />
              <strong>Discuss the story</strong>
            </Row>
            <div className="guide-preview-message">
              <p>Could we keep the first version focused on new users?</p>
              <span className="guide-preview-link">Reply</span>
            </div>
            <p className="guide-preview-muted">
              Discussion stays here. Send an instruction from Conversation when
              you want a worker to act.
            </p>
          </>
        ) : runbook ? (
          <div className="guide-preview-checklist">
            {[
              "Preserve the existing navigation",
              "Add one clear first action",
              "Check keyboard navigation",
            ].map((text, index) => (
              <Row key={text}>
                <span
                  className={`guide-preview-checkbox ${index === 0 ? "checked" : ""}`}
                >
                  {index === 0 && <Check size={11} />}
                </span>
                {text}
              </Row>
            ))}
          </div>
        ) : (
          <>
            <div className="guide-preview-message">
              <Label>Your brief</Label>
              <p>
                When the workspace is empty, help a new user create their first
                story. Preserve keyboard navigation.
              </p>
            </div>
            {dictation ? (
              <Row className="guide-preview-dictation">
                <Mic size={17} />
                <span className="guide-preview-wave" aria-hidden="true">
                  ▂ ▅ ▃ ▇ ▄ ▆ ▂ ▅ ▃
                </span>
                <span>Local transcription → editable text</span>
              </Row>
            ) : (
              <Row className="guide-preview-worker-message">
                <HarnessMark id="claude" small />
                <span>
                  Worker responses render as readable text, code and links.
                </span>
              </Row>
            )}
            <Composer dictation={dictation} />
          </>
        )}
      </div>
      {!queue && !comments && !runbook && !dictation && (
        <div className="guide-preview-inline-request">
          <ShieldCheck size={14} />
          <span>Questions and approvals appear beside the composer.</span>
        </div>
      )}
    </>
  );
}
function ReviewPreview({ topic }: { topic: string }) {
  const annotations = topic === "annotations",
    files = topic === "files";
  return (
    <>
      <Row className="guide-preview-section-heading">
        <Row>
          {files || annotations ? <FileText size={17} /> : <Code2 size={17} />}
          <strong>
            {files || annotations ? "project-notes.md" : "empty-state.tsx"}
          </strong>
        </Row>
        <Label>
          {files
            ? "File preview"
            : annotations
              ? "Review comments"
              : "Worker changes"}
        </Label>
      </Row>
      {files || annotations ? (
        <div className="guide-preview-document">
          <Label>Example document</Label>
          <h4>Help users find their next step.</h4>
          <p>
            Keep the opening screen focused on{" "}
            <mark>
              one clear first action<span className="guide-preview-pin">1</span>
            </mark>{" "}
            and make it easy to get started.
          </p>
          <div className="guide-preview-comment">
            <Row>
              <span className="guide-preview-pin">1</span>
              <strong>Saved comment</strong>
              <Label>Draft</Label>
            </Row>
            <p>Could this say “Create your first story”?</p>
            <span className="guide-preview-link">
              Add to follow-up <ArrowRight size={11} />
            </span>
          </div>
        </div>
      ) : (
        <div className="guide-preview-diff">
          <div className="removed">
            <span>−</span>
            <code>&lt;p&gt;No results&lt;/p&gt;</code>
          </div>
          <div className="added">
            <span>+</span>
            <code>&lt;h2&gt;Give your next idea a place.&lt;/h2&gt;</code>
          </div>
          <div className="added">
            <span>+</span>
            <code>&lt;button&gt;Create your first story&lt;/button&gt;</code>
          </div>
          <div className="context">
            <span> </span>
            <code>return &lt;Workspace /&gt;;</code>
          </div>
        </div>
      )}
      <Row className="guide-preview-review-flow">
        <span>Select</span>
        <ArrowRight size={12} />
        <span>Save comment</span>
        <ArrowRight size={12} />
        <span>Add to follow-up</span>
        <ArrowRight size={12} />
        <strong>Send when ready</strong>
      </Row>
    </>
  );
}
function BrowserPreview() {
  return (
    <>
      <Row className="guide-preview-browser-tab">
        <Globe size={13} />
        Your project preview
        <X size={12} />
        <Plus size={12} />
      </Row>
      <Row className="guide-preview-address">
        <ArrowRight size={13} />
        <span>http://localhost:…</span>
        <ShieldCheck size={13} />
      </Row>
      <div className="guide-preview-site">
        <Label>Your running app</Label>
        <h4>
          The same page.
          <br />
          <span>A shared point of view.</span>
        </h4>
        <p>Use the page’s real controls, text selection and scrolling.</p>
        <div className="guide-preview-site-button">
          Explore the work <ArrowRight size={12} />
        </div>
      </div>
      <Row className="guide-preview-footnote">
        <Monitor size={13} />
        You <span className="guide-preview-two-way">↔</span> Card’s browser{" "}
        <span className="guide-preview-two-way">↔</span> Worker
      </Row>
    </>
  );
}
function TerminalPreview() {
  return (
    <>
      <Row className="guide-preview-section-heading">
        <Row>
          <Terminal size={15} />
          <strong>Project terminal</strong>
        </Row>
        <Row>
          <Label>Your available shell</Label>
          <Plus size={13} />
          <X size={13} />
        </Row>
      </Row>
      <div className="guide-preview-terminal">
        <span>~/your-project</span>
        <div>
          <b>❯</b> npm run dev
        </div>
        <div className="guide-preview-terminal-output">
          Your development server’s output appears here.
        </div>
        <div className="guide-preview-terminal-output">
          Select text to copy or attach feedback.
        </div>
        <div className="guide-preview-terminal-caret">▌</div>
      </div>
      <Row className="guide-preview-footnote">
        <Terminal size={13} />
        Persistent sessions live here. Short tool commands stay in the
        conversation.
      </Row>
    </>
  );
}
function ArtifactsPreview() {
  return (
    <div className="guide-preview-artifacts">
      {[
        {
          name: "Project brief.md",
          kind: "Readable documents",
          type: "document",
        },
        {
          name: "Interface concept.svg",
          kind: "Images & saved HTML",
          type: "image",
        },
        {
          name: "Delivery plan.xlsx",
          kind: "Sheets, slides, PDF & media",
          type: "sheet",
        },
      ].map((file) => (
        <div key={file.name}>
          <div className={`guide-preview-artifact-cover ${file.type}`}>
            {file.type === "document" ? (
              <>
                <Label>PROJECT BRIEF</Label>
                <strong>A clear next step.</strong>
                <i />
                <i />
                <i />
              </>
            ) : file.type === "image" ? (
              <div className="guide-preview-orbit">
                <span />
                <span />
                <span />
              </div>
            ) : (
              <div className="guide-preview-sheet">
                {Array.from({ length: 16 }, (_, i) => (
                  <span key={i}>{i === 0 ? "Plan" : ""}</span>
                ))}
              </div>
            )}
          </div>
          <strong>{file.name}</strong>
          <p>{file.kind}</p>
        </div>
      ))}
    </div>
  );
}
function IntelligencePreview({
  routing = false,
  improve = false,
}: {
  routing?: boolean;
  improve?: boolean;
}) {
  return (
    <>
      <div className="guide-preview-intelligence">
        <Label>
          {routing
            ? "Measured source → model route"
            : improve
              ? "Compare compatible observations"
              : "Memtrace · source intelligence"}
        </Label>
        <h4>
          {routing
            ? "Match the model to the work."
            : improve
              ? "Before. Change. After."
              : "Understand the code in context."}
        </h4>
        <p>
          {routing
            ? "Source complexity, nesting, observed impact and coverage inform the route."
            : improve
              ? "Capture checkpoints around a focused change and compare the evidence."
              : "Explore quality, architecture, flows, API surface, changes, styles and rules."}
        </p>
      </div>
      <div className="guide-preview-measures">
        {(improve
          ? ["Before checkpoint", "Observed change", "After checkpoint"]
          : ["Cognitive", "Cyclomatic", "Observed impact"]
        ).map((text) => (
          <div key={text}>
            <span>{text}</span>
            <strong>{improve ? <GitBranch size={18} /> : "—"}</strong>
            <small>
              {improve ? "Recorded revision" : "Until source is measured"}
            </small>
          </div>
        ))}
      </div>
      <Row className="guide-preview-footnote">
        <ShieldCheck size={13} />
        {routing
          ? "Review Why this model? and scope coverage before starting."
          : "Read alignment and coverage. Missing measurements stay unknown."}
      </Row>
    </>
  );
}
function CyclePreview({ delivery = false }: { delivery?: boolean }) {
  return (
    <>
      <Row className="guide-preview-section-heading">
        <div>
          <Label>
            {delivery
              ? "Delivery · recorded progress"
              : "Cycles · optional time window"}
          </Label>
          <h4>A focused window for the work.</h4>
        </div>
        <CalendarDays size={24} />
      </Row>
      <Row className="guide-preview-cycle-flow">
        <span>Choose scope</span>
        <ArrowRight size={13} />
        <span>Start cycle</span>
        <ArrowRight size={13} />
        <span>Review & finish</span>
      </Row>
      <div className="guide-preview-charts">
        {["Burndown", "Burnup"].map((text, i) => (
          <div key={text}>
            <strong>{text}</strong>
            <svg
              viewBox="0 0 260 90"
              role="img"
              aria-label={`${text} illustration, not project data`}
            >
              <path d="M10 10 V75 H250" fill="none" stroke="#dce7dd" />
              <path
                d={i ? "M10 75 L250 10" : "M10 10 L250 75"}
                stroke="#b4c4b2"
                strokeDasharray="4 4"
                fill="none"
              />
              <path
                d={
                  i
                    ? "M10 73 H65 V62 H115 V41 H176 V29 H235 V14"
                    : "M10 12 H65 V26 H115 V38 H176 V59 H235 V70"
                }
                fill="none"
                stroke="#2c9d84"
                strokeWidth="2.5"
              />
            </svg>
            <p>
              {i ? "Completed work against scope" : "Remaining recorded scope"}
            </p>
          </div>
        ))}
      </div>
      <Row className="guide-preview-footnote">
        Illustrative chart shapes. Your charts use captured project history.
      </Row>
    </>
  );
}
function FleetPreview() {
  return (
    <>
      <Row className="guide-preview-section-heading">
        <Row>
          <GitBranch size={17} />
          <strong>One shared epic branch</strong>
        </Row>
        <Label>Cooperative coordination</Label>
      </Row>
      <div className="guide-preview-fleet">
        {(["codex", "claude", "cursor"] as const).map((id) => (
          <div key={id}>
            <HarnessMark id={id} />
            <span>Publish intent</span>
            <ArrowDown size={13} />
            <span>Inspect peers</span>
          </div>
        ))}
      </div>
      <div className="guide-preview-callout">
        <Layers size={17} />
        <div>
          <strong>Adhere, coordinate and hand off</strong>
          <p>
            Sharing a file is allowed. Reread the source and follow the agreed
            plan.
          </p>
        </div>
      </div>
      <Row className="guide-preview-footnote">
        <MessageSquare size={13} />
        Unresolved semantic disagreement <ArrowRight size={12} /> Decisions{" "}
        <ArrowRight size={12} /> Your choice
      </Row>
    </>
  );
}
function AccountPreview() {
  return (
    <div className="guide-preview-account">
      <div>
        <ShieldCheck size={28} />
        <Label>Settings · Your Memtrace account</Label>
        <h4>Your existing Memtrace session.</h4>
        <p>Use the official sign-in flow. Credentials stay with Memtrace.</p>
        <Row>
          <Action>Switch account</Action>
          <Action quiet>Sign out</Action>
        </Row>
      </div>
      <div className="guide-preview-panel">
        <Row>
          <Link2 size={16} />
          <strong>Two separate connections</strong>
        </Row>
        <p>Memtrace provides source intelligence and coordination.</p>
        <p>Approve Codex, Claude Code or Cursor separately in Workers.</p>
        <p>
          Confirm your Memtrace browser account to join a team. Account changes
          require reconnecting its membership.
        </p>
      </div>
    </div>
  );
}
function ActivityPreview() {
  return (
    <>
      <Row className="guide-preview-section-heading">
        <Row>
          <Search size={15} />
          <strong>Find the work and its context</strong>
        </Row>
        <Label>Activity</Label>
      </Row>
      <div className="guide-preview-activity">
        {[
          {
            icon: <MessageSquare size={15} />,
            title: "Follow-up added",
            sub: "Conversation → the story it belongs to",
          },
          {
            icon: <GitBranch size={15} />,
            title: "Worker checkpoint recorded",
            sub: "Changes → the recorded edit",
          },
          {
            icon: <FileText size={15} />,
            title: "Output saved",
            sub: "Artifacts → the saved result",
          },
        ].map((item) => (
          <Row key={item.title}>
            {item.icon}
            <div>
              <strong>{item.title}</strong>
              <p>{item.sub}</p>
            </div>
            <ArrowRight size={13} />
          </Row>
        ))}
      </div>
    </>
  );
}

function TeamPreview() {
  return (
    <>
      <Row className="guide-preview-section-heading">
        <Row>
          <Users size={17} />
          <strong>Studio team · MemCode project</strong>
        </Row>
        <Label>Memtrace members</Label>
      </Row>
      <div className="guide-preview-team">
        <div className="guide-preview-team-plan">
          <Row>
            <span className="guide-preview-dot" />
            <strong>The shared plan</strong>
          </Row>
          <div className="guide-preview-divider" />
          <Row>
            <StageIcon stage="working" />
            <span>Improve the first-run experience</span>
          </Row>
          <div className="guide-preview-team-claim">
            <ShieldCheck size={13} />
            <span>Claim held by a teammate’s device</span>
          </div>
          <div className="guide-preview-team-update">
            <MessageSquare size={13} />
            <span>Story comments & activity</span>
          </div>
          <div className="guide-preview-team-update">
            <FileText size={13} />
            <span>Published report.pdf</span>
            <Label>Saved result</Label>
          </div>
        </div>
        <div className="guide-preview-team-local">
          <div>
            <Monitor size={19} />
            <strong>Your local clone</strong>
            <span>Your workers · your approvals</span>
          </div>
          <div>
            <Monitor size={19} />
            <strong>Their local clone</strong>
            <span>Their workers · their approvals</span>
          </div>
          <Row>
            <GitBranch size={13} />
            <span>Exchange source through Git</span>
          </Row>
        </div>
      </div>
      <Row className="guide-preview-footnote">
        <Link2 size={12} />
        <span>
          Join the current shared plan first. Connect local code when you’re
          ready.
        </span>
      </Row>
    </>
  );
}

/** Guide illustrations and captured examples are independent of live workspace state. */
export const GuidePreview = memo(function GuidePreview({
  topic,
  title,
  caption,
}: {
  topic: string;
  title: string;
  caption: string;
}) {
  if (topic === "review") return <CodeReviewGuidePreview />;
  let scene: ReactNode;
  if (topic === "projects") scene = <ProjectPreview />;
  else if (topic === "workers" || topic === "privacy")
    scene = <WorkerPreview privacy={topic === "privacy"} />;
  else if (["epics", "roadmap", "workspace", "planning-fields"].includes(topic))
    scene = <BoardPreview roadmap={topic === "epics" || topic === "roadmap"} />;
  else if (
    [
      "stories",
      "prompts",
      "conversations",
      "queue",
      "comments",
      "runbook",
      "dictation",
    ].includes(topic)
  )
    scene = <ConversationPreview topic={topic} />;
  else if (["changes", "annotations", "files"].includes(topic))
    scene = <ReviewPreview topic={topic} />;
  else if (topic === "browser") scene = <BrowserPreview />;
  else if (topic === "terminal") scene = <TerminalPreview />;
  else if (topic === "artifacts") scene = <ArtifactsPreview />;
  else if (["routing", "insights", "improve"].includes(topic))
    scene = (
      <IntelligencePreview
        routing={topic === "routing"}
        improve={topic === "improve"}
      />
    );
  else if (topic === "cycles" || topic === "delivery")
    scene = <CyclePreview delivery={topic === "delivery"} />;
  else if (topic === "fleet") scene = <FleetPreview />;
  else if (topic === "account") scene = <AccountPreview />;
  else if (topic === "team") scene = <TeamPreview />;
  else scene = <ActivityPreview />;
  return (
    <figure className="guide-preview" aria-label={`${title} — guide example`}>
      <div className="guide-preview-topline">
        <span>
          <Sparkles size={12} />
          Guide example
        </span>
        <span>Illustration · not a live session</span>
      </div>
      <div className="guide-preview-scene">{scene}</div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
});
